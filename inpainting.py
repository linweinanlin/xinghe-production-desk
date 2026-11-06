"""局部重绘：选区遮罩 → 模型重绘该区域 → 融合回原图。

竞品（即梦 / 小云雀）都有「局部重绘」：用户框一块区域、写一句描述，模型只改这块，
其余画面保持不变。这里按同样的产品形态实现，但走的是**可解释的两步**：

1. `prepare_inpaint()`：从原图裁出选区（带上下文边距），算出遮罩与选区的对应关系，
   把裁切小图交给前端去送模型重绘。
2. `merge_inpaint()`：把模型返回的新图按遮罩羽化融合回原图，未选中的像素一个不动。

为什么不做成「一次请求直接改图」：
- 图片模型（Seedream / 万相 / 智谱）都不接受蒙版参数，只接受参考图 + 提示词；
- 所以必须本地裁切 + 本地融合，这也是行业里 inpainting 的常规做法。

融合用 PIL 的 mask paste + 高斯羽化，接缝不会硬。
"""
from __future__ import annotations

import io

__all__ = [
    "decode_image", "decode_mask", "mask_bbox", "prepare_inpaint", "merge_inpaint",
    "MASK_MIN_AREA", "CONTEXT_RATIO",
]

# 选区小于这个像素数就当误触，直接拒绝：否则会生成一张几乎等于原图的废片。
MASK_MIN_AREA = 64
# 上下文边距比例：只把选区本身喂给模型，模型看不到周围是什么，
# 重绘出来的内容会与原画风脱节。35% 的边距让模型有参照物。
CONTEXT_RATIO = 0.35


def decode_image(payload: bytes):
    """字节 → PIL 图像（RGBA）。"""
    from PIL import Image

    image = Image.open(io.BytesIO(payload))
    image.load()
    return image.convert("RGBA")


def decode_mask(payload: bytes, size: tuple[int, int] | None = None):
    """字节 → 单通道遮罩（ImageMode "L"）。

    白色 = 要重绘的区域。PNG 带 alpha 时优先用 alpha 通道（前端画笔输出就是这种），
    但如果 alpha 几乎全满（说明是普通图片而不是遮罩），退回灰度。
    """
    from PIL import Image

    image = Image.open(io.BytesIO(payload))
    image.load()
    target = tuple(size) if size else None
    if image.mode in ("RGBA", "LA", "PA"):
        channel = image.getchannel("A")
        extrema = channel.getextrema()
        if extrema and extrema[1] == 0:
            # 全透明 = 什么都没涂。前端画笔的空遮罩就是这种。
            # 以前这里会退回灰度，而透明底 + 白色 RGB 转出来的灰度是全白，
            # 结果「没选区」被当成「整张都要重绘」。
            mask = Image.new("L", image.size, 0)
        elif extrema and extrema[1] - extrema[0] > 8:
            mask = channel
        else:
            mask = image.convert("L")
    else:
        mask = image.convert("L")
    if target and mask.size != target:
        mask = mask.resize(target, Image.LANCZOS)
    return mask


def mask_bbox(mask, threshold: int = 24):
    """遮罩里被选中的区域的外接矩形；没选中返回 None。

    用 getbbox 而不是逐像素扫描：图片动辄百万像素，逐像素 Python 循环太慢。
    """
    bright = mask.histogram()[threshold:]
    if sum(bright) < MASK_MIN_AREA:
        return None
    box = mask.point(lambda value: 255 if value > threshold else 0).getbbox()
    if not box:
        return None
    left, top, right, bottom = box
    if (right - left) * (bottom - top) < MASK_MIN_AREA:
        return None
    return (left, top, right, bottom)


def _crop_box(base, box):
    left, top, right, bottom = box
    pad_x = int((right - left) * CONTEXT_RATIO)
    pad_y = int((bottom - top) * CONTEXT_RATIO)
    return (
        max(0, left - pad_x),
        max(0, top - pad_y),
        min(base.width, right + pad_x),
        min(base.height, bottom + pad_y),
    )


def prepare_inpaint(base_payload: bytes, mask_payload: bytes):
    """第一步：裁出选区。

    返回 dict：
      crop        裁切图（PNG 字节），这张送去模型重绘
      inner       选区在 crop 内的矩形 (left, top, right, bottom)
      cropBox     裁切框在原图中的位置 (left, top, right, bottom)
      bbox        选区在原图中的外接矩形
      size        [宽, 高] 裁切图尺寸
    """
    base = decode_image(base_payload)
    mask = decode_mask(mask_payload, base.size)
    box = mask_bbox(mask)
    if not box:
        raise ValueError("还没有圈选要重绘的区域。")
    crop_box = _crop_box(base, box)
    cropped = base.crop(crop_box)
    inner = (box[0] - crop_box[0], box[1] - crop_box[1], box[2] - crop_box[0], box[3] - crop_box[1])
    buffer = io.BytesIO()
    cropped.save(buffer, "PNG")
    return {
        "crop": buffer.getvalue(),
        "inner": list(inner),
        "cropBox": list(crop_box),
        "bbox": list(box),
        "size": [cropped.width, cropped.height],
    }


def merge_inpaint(base_payload: bytes, mask_payload: bytes, new_crop_payload: bytes,
                  *, feather: int = 12) -> bytes:
    """第二步：把模型重绘的裁切图融合回原图，返回整图 PNG 字节。"""
    from PIL import Image, ImageFilter

    base = decode_image(base_payload)
    mask = decode_mask(mask_payload, base.size)
    box = mask_bbox(mask)
    if not box:
        raise ValueError("还没有圈选要重绘的区域。")
    crop_box = _crop_box(base, box)
    inner = (box[0] - crop_box[0], box[1] - crop_box[1], box[2] - crop_box[0], box[3] - crop_box[1])

    mask_crop = mask.crop(crop_box)
    crop = decode_image(new_crop_payload)
    if crop.size != mask_crop.size:
        crop = crop.resize(mask_crop.size, Image.LANCZOS)

    radius = max(0, int(feather))
    if radius > 0:
        # 高斯羽化让选区边界从硬边变成几像素的过渡带，接缝不会看出来。
        blurred = mask_crop.filter(ImageFilter.GaussianBlur(radius))
        # 但高斯模糊会把整个选区一起拉暗（选区越小越明显，选区中心的强度
        # 也会掉到 200 以下），合成出来像蒙了一层半透明纱。这里把内部重新
        # 压实成完全不透明，只在边界保留过渡带。
        mask_crop = blurred.point(lambda value: 255 if value >= 200 else value)

    # 先把新裁切图贴到整幅画布上，再用遮罩做选择性合成。
    canvas = base.copy()
    canvas.paste(crop, crop_box[:2])
    canvas_mask = Image.new("L", base.size, 0)
    canvas_mask.paste(mask_crop, crop_box[:2])

    merged = base.copy()
    merged.paste(canvas, (0, 0), canvas_mask)
    buffer = io.BytesIO()
    merged.save(buffer, "PNG")
    return buffer.getvalue()

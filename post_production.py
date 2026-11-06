"""后期包装能力：配音 / 字幕 / BGM / 转场变速调色 / 封面 / 剪映草稿。

这一层是**纯函数**：不依赖 HTTP、不启动界面、不碰全局状态。
director_server 只负责把它们暴露成接口，方便单独测试与复用。

- 配音：`synthesize_speech()` 走 Edge 神经语音（免费、多音色、无需 Key）
- 字幕：`subtitle_cues()` / `cues_to_srt()` / `subtitle_force_style()`
- 合片：`build_master_graph()` 生成 ffmpeg filter_complex（归一化 + 变速 + 转场 + 调色 + 烧字幕 + 混音）
- 封面：`render_cover()`（PIL，取首帧压暗 + 标题排版）
- 草稿：`build_draft_document()` 产出剪映明文草稿（素材 + 轨道 + 微秒时间范围）

之所以拆出来：ffmpeg 滤镜串、字幕切分、时间轴偏移这些逻辑最容易错，做成纯函数才能
逐条断言，不必每次都起服务看画面。
"""
from __future__ import annotations

import asyncio
import json
import re
import subprocess
import uuid
from pathlib import Path

__all__ = [
    "VOICES", "GRADE_PRESETS", "TRANSITIONS", "FIT_MODES", "SUBTITLE_TEMPLATES",
    "strip_speaker", "split_dialogue", "subtitle_cues", "cues_to_srt", "cues_to_ass",
    "resolve_subtitle_style", "resolve_subtitle_template", "subtitle_force_style",
    "find_highlight_spans", "layout_timeline", "timeline_plan",
    "build_master_graph", "render_cover", "build_draft_document", "draft_meta",
    "synthesize_speech", "tts_available", "probe_duration",
    "voice_ids", "auto_voice_map", "resolve_voice_map", "detect_gender",
    "VOICE_STYLES", "resolve_voice_style",
]

# 中文音色：Edge 神经语音自带的 zh-CN 集合，音色差异比系统 SAPI 明显。
# gender 用于自动分配：多人短剧里男女角色用同一个声音最出戏。
# 情绪靠 rate/pitch 微调，不做「多情绪」的过度承诺。
VOICES = [
    {"id": "zh-CN-XiaoxiaoNeural", "label": "晓晓 · 女声 · 温柔（女主）", "gender": "female"},
    {"id": "zh-CN-XiaoyiNeural", "label": "晓伊 · 女声 · 活泼（女配）", "gender": "female"},
    {"id": "zh-CN-liaoning-XiaobeiNeural", "label": "晓蓓 · 女声 · 东北话（喜剧/配角）", "gender": "female"},
    {"id": "zh-CN-shaanxi-XiaoniNeural", "label": "晓妮 · 女声 · 陕西话（乡土）", "gender": "female"},
    {"id": "zh-CN-YunxiNeural", "label": "云希 · 男声 · 阳光青年（男主）", "gender": "male"},
    {"id": "zh-CN-YunjianNeural", "label": "云健 · 男声 · 低沉（反派/旁白）", "gender": "male"},
    {"id": "zh-CN-YunyangNeural", "label": "云扬 · 男声 · 播音腔（解说）", "gender": "male"},
    {"id": "zh-CN-YunxiaNeural", "label": "云夏 · 男声 · 少年", "gender": "male"},
]


def voice_ids() -> list[str]:
    """全部合法音色 id，顺序即界面下拉的顺序。"""
    return [item["id"] for item in VOICES]


# 角色描述里常见的性别词。判不出性别时返回空串，让自动分配退回通用顺序。
_FEMALE_WORDS = ("女", "母", "姐", "妹", "娘", "妻", "姑娘", "女儿", "少女")
_MALE_WORDS = ("男", "父", "哥", "弟", "爷", "夫", "小子", "儿子", "少年")
# 英文必须按词边界匹配：woman 里含 man、the 里含 he，纯子串会把性别判反。
_FEMALE_EN = re.compile(r"\b(woman|women|female|lady|ladies|girl|girls|she|her)\b")
_MALE_EN = re.compile(r"\b(man|men|male|boy|boys|guy|guys|he|his|him)\b")


def detect_gender(text) -> str:
    """从角色描述粗判性别："female" / "male" / ""。

    中文短剧的角色说明通常会写「女，28岁」；英文提示词里常写 woman / man。
    判不准就返回空串——宁可让用户手动指定，也不要配错性别。
    """
    content = str(text or "").lower()
    female = any(word in content for word in _FEMALE_WORDS) or bool(_FEMALE_EN.search(content))
    male = any(word in content for word in _MALE_WORDS) or bool(_MALE_EN.search(content))
    if female and not male:
        return "female"
    if male and not female:
        return "male"
    return ""


def auto_voice_map(speakers, *, gender_hints=None) -> dict:
    """给每个说话人分配一个音色，尽量不重样。

    gender_hints: 角色名 → "female"/"male"。判得出性别就按性别取音色，
    这才是「女主是女声、男主是男声」的真正对齐；判不出就按男女使用次数少的那个补，
    免得两个人物都是男声。
    """
    names: list[str] = []
    for name in speakers or []:
        key = str(name or "").strip()
        if key and key not in names:
            names.append(key)
    if not names:
        return {}
    hints = gender_hints if isinstance(gender_hints, dict) else {}
    female = [item["id"] for item in VOICES if item.get("gender") == "female"]
    male = [item["id"] for item in VOICES if item.get("gender") == "male"]
    other = [item["id"] for item in VOICES if item.get("gender") not in ("female", "male")]
    assigned: dict = {}
    used: set = set()
    counters = {"female": 0, "male": 0}

    def take(pool, fallback):
        for voice in pool:
            if voice not in used:
                used.add(voice)
                return voice
        # 该性别的音色用完了（女声只有 4 个），就复用同性别第一个。
        for voice in pool:
            return voice
        return fallback

    for name in names:
        hint = str(hints.get(name) or "").strip().lower()
        if hint not in ("female", "male"):
            # 判不出性别：谁用得少就用谁，都没用过时先给女声（短剧女主戏份通常更多）。
            hint = "female" if counters["female"] <= counters["male"] else "male"
        pool = female if hint == "female" else male
        assigned[name] = take(pool, pool[0] if pool else (other[0] if other else VOICES[0]["id"]))
        counters[hint] += 1
    return assigned


def resolve_voice_map(voice_map, speakers, *, default: str = "") -> dict:
    """把「角色 → 音色」的映射补全成所有说话人都有音色。

    角色名大小写/空格差异按同一人处理；映射里指向已下架音色的条目会被丢弃并回落默认音色，
    避免旧工作区里保存的音色 id 让整批配音失败。
    """
    legal = set(voice_ids())
    base = default if default in legal else (VOICES[0]["id"] if VOICES else "")
    source = voice_map if isinstance(voice_map, dict) else {}
    cleaned: dict = {}
    for key, value in source.items():
        name = str(key or "").strip()
        if not name:
            continue
        voice = str(value or "").strip()
        if voice in legal:
            cleaned[name] = voice
    resolved: dict = {}
    for name in speakers or []:
        key = str(name or "").strip()
        if not key:
            continue
        if key in cleaned:
            resolved[key] = cleaned[key]
            continue
        # 「沈寂」与「沈寂 」应视为同一角色。
        for known, voice in cleaned.items():
            if known.replace(" ", "") == key.replace(" ", ""):
                resolved[key] = voice
                break
        else:
            resolved[key] = base
    return resolved

# ffmpeg eq/colorbalance 预设。参数都落在小幅度区间，避免短剧人物肤色被拉炸。
GRADE_PRESETS = {
    "none": {"label": "不做调色", "filter": ""},
    "cinema": {"label": "电影感（低饱和）", "filter": "eq=contrast=1.08:saturation=0.9:brightness=-0.015"},
    "warm": {"label": "暖调（回忆/室内）", "filter": "eq=contrast=1.03:saturation=1.06,colorbalance=rs=0.06:bs=-0.05"},
    "cold": {"label": "冷调（悬疑/夜戏）", "filter": "eq=contrast=1.06:saturation=0.92,colorbalance=rs=-0.06:bs=0.07"},
    "vivid": {"label": "高饱和（爽感）", "filter": "eq=contrast=1.05:saturation=1.2"},
    "noir": {"label": "黑白", "filter": "eq=contrast=1.14:saturation=0"},
}

# xfade 的 transition 名；"none" 表示硬切。
# 漫剧常用的闪黑/闪白/开幕转场都在这里：只有"淡入淡出"一种转场，成片会像 PPT 拼接。
TRANSITIONS = {
    "none": {"label": "硬切（默认）", "xfade": ""},
    "fade": {"label": "淡入淡出", "xfade": "fade"},
    "dissolve": {"label": "叠化", "xfade": "dissolve"},
    "fadeblack": {"label": "闪黑（段落切换）", "xfade": "fadeblack"},
    "fadewhite": {"label": "闪白（高光/回忆）", "xfade": "fadewhite"},
    "wipeleft": {"label": "左滑", "xfade": "wipeleft"},
    "slideup": {"label": "上滑", "xfade": "slideup"},
    "distance": {"label": "推近（景深切换）", "xfade": "distance"},
    "circleopen": {"label": "圆形开幕", "xfade": "circleopen"},
    "pixelize": {"label": "像素化（故障感）", "xfade": "pixelize"},
}

# 画幅适配方式：素材比例与成片比例不一致时怎么补。
FIT_MODES = {
    "blur": {"label": "模糊背景填充（推荐）"},
    "crop": {"label": "居中裁切铺满"},
    "letterbox": {"label": "黑边（保留完整画面）"},
}

# ---------------------------------------------------------------- 字幕花字
#
# 竞品（即梦 / 小云雀）的字幕面板不只有「颜色 + 字号」，还有一排花字模板：
# 逐字高亮、弹入放大、渐变、霓虹描边、综艺粗描边。本模块用 ASS 的原生能力实现：
#   · 逐字高亮  → \kf 卡拉OK标签（PrimaryColour 为高亮色，SecondaryColour 为底色）
#   · 弹入动画  → \t 变换标签（缩放/淡入），libass 会真的动起来
#   · 渐变花字  → 逐字 \c 颜色覆盖
#   · 霓虹/综艺 → 多层描边 + 阴影 + 粗体
# 不做的是「AI 生成花字图」：那是图片模型的事，不该由本机 ASS 假装。
SUBTITLE_TEMPLATES = {
    "plain": {
        "label": "白字描边（默认）",
        "primary": "#FFFFFF", "secondary": "#FFFFFF", "outlineColor": "#000000",
        # 描边色带透明度：纯黑描边在亮画面上像描了笔，不像字幕。
        "outlineAlpha": 0x96,
        "outlineWidth": None, "shadow": 0, "scaleX": 100, "scaleY": 100, "spacing": 0,
        "karaoke": False, "gradient": False, "animation": "none", "highlightColor": "#FFD400",
    },
    "karaoke": {
        "label": "逐字高亮（卡拉OK）",
        "primary": "#FFD400", "secondary": "#FFFFFF", "outlineColor": "#101010",
        "outlineAlpha": 0x96,
        "outlineWidth": None, "shadow": 1, "scaleX": 100, "scaleY": 100, "spacing": 0,
        "karaoke": True, "gradient": False, "animation": "none", "highlightColor": "#FFD400",
    },
    "pop": {
        "label": "弹入放大（综艺感）",
        "primary": "#FFFFFF", "secondary": "#FFFFFF", "outlineColor": "#000000",
        "outlineAlpha": 0x96,
        "outlineWidth": None, "shadow": 2, "scaleX": 100, "scaleY": 100, "spacing": 0,
        "karaoke": False, "gradient": False, "animation": "pop", "highlightColor": "#FFD400",
    },
    "gradient": {
        "label": "渐变花字",
        "primary": "#FF5FA2", "secondary": "#5FA8FF", "outlineColor": "#101010",
        "outlineAlpha": 0xB0,
        "outlineWidth": None, "shadow": 1, "scaleX": 100, "scaleY": 100, "spacing": 2,
        "karaoke": False, "gradient": True, "animation": "none", "highlightColor": "#FFFFFF",
    },
    "neon": {
        "label": "霓虹描边",
        "primary": "#FFFFFF", "secondary": "#FFFFFF", "outlineColor": "#FF3D8B",
        "outlineAlpha": 0x00,
        "outlineWidth": 3, "shadow": 2, "scaleX": 100, "scaleY": 100, "spacing": 0,
        "karaoke": False, "gradient": False, "animation": "none", "highlightColor": "#7DF9FF",
    },
    "comic": {
        "label": "综艺粗描边",
        "primary": "#FFE24D", "secondary": "#FFE24D", "outlineColor": "#101010",
        "outlineAlpha": 0x00,
        "outlineWidth": 4, "shadow": 3, "scaleX": 100, "scaleY": 106, "spacing": 1,
        "karaoke": False, "gradient": False, "animation": "none", "highlightColor": "#FF3D8B",
    },
}

# 关键词高亮：台词里被引号包住的词（常见于剧本强调）值得换色。
# 支持中文引号、书名号、中文方括号与英文双引号。
_HIGHLIGHT_PAIRS = (("「", "」"), ("『", "』"), ("《", "》"), ("【", "】"), ("“", "”"), ("\"", "\""))
_HIGHLIGHT_RE = re.compile(r"[「『《【“\"]([^」』》】”\"]{1,12})[」』》】”\"]")


def find_highlight_spans(text: str) -> list[tuple[int, int]]:
    """找出文本里应当被高亮的关键词区间（半开区间）。

    台词中「」等引号里的内容通常是剧本刻意强调的词；竞品的字幕面板同样
    提供「重点词变色」，这里用同样的规则自动判定，不用用户逐字标记。
    """
    content = str(text or "")
    spans: list[tuple[int, int]] = []
    for match in _HIGHLIGHT_RE.finditer(content):
        start, end = match.span(1)
        if end > start:
            spans.append((start, end))
    # 「"」成对时上面的正则已覆盖；再补一次中文单引号包裹的短词。
    for match in re.finditer(r"'([^']{1,12})'", content):
        start, end = match.span(1)
        if end > start and not any(start >= s and end <= e for s, e in spans):
            spans.append((start, end))
    return sorted(spans)


def _ass_color(value: str, alpha: int = 0) -> str:
    """#RRGGBB → ASS 的 &HAABBGGRR（ASS 是 BGR 且首字节是透明度）。"""
    text = str(value or "#FFFFFF").strip().lstrip("#")
    if len(text) != 6:
        text = "FFFFFF"
    try:
        red = int(text[0:2], 16)
        green = int(text[2:4], 16)
        blue = int(text[4:6], 16)
    except ValueError:
        red = green = blue = 255
    return f"&H{alpha:02X}{blue:02X}{green:02X}{red:02X}"


def _hex_to_rgb(value: str) -> tuple[int, int, int]:
    text = str(value or "#FFFFFF").strip().lstrip("#")
    if len(text) != 6:
        text = "FFFFFF"
    try:
        return int(text[0:2], 16), int(text[2:4], 16), int(text[4:6], 16)
    except ValueError:
        return 255, 255, 255


def _lerp_color(start: tuple, end: tuple, progress: float) -> str:
    progress = max(0.0, min(1.0, progress))
    channels = [int(round(start[index] + (end[index] - start[index]) * progress)) for index in range(3)]
    return "#%02X%02X%02X" % tuple(channels)


def resolve_subtitle_template(template_id: str | None, style: dict | None = None) -> dict:
    """模板 id → 实际参数。未知 id 退回 plain；用户手动设的字号/位置仍然优先。"""
    style = style if isinstance(style, dict) else {}
    key = str(template_id or style.get("template") or "plain").strip() or "plain"
    preset = SUBTITLE_TEMPLATES.get(key)
    if not preset:
        preset = SUBTITLE_TEMPLATES["plain"]
        key = "plain"
    resolved = dict(preset)
    resolved["id"] = key
    # 允许用户在模板之上微调颜色：填了 color 就用它做主色。
    if style.get("color") == "yellow" and not style.get("primaryColor"):
        resolved["primary"] = "#FFE24D"
    if style.get("primaryColor"):
        resolved["primary"] = str(style["primaryColor"])
    return resolved


def _split_syllables(text: str) -> list[str]:
    """切分卡拉OK用的音节单元：中文逐字，英文按词。"""
    content = str(text or "").strip()
    if not content:
        return []
    units: list[str] = []
    buffer = ""
    for char in content:
        if "一" <= char <= "鿿" or char in "，。！？、；：":
            if buffer:
                units.append(buffer)
                buffer = ""
            units.append(char)
        elif char.isalnum():
            buffer += char
        else:
            if buffer:
                units.append(buffer)
                buffer = ""
            units.append(char)
    if buffer:
        units.append(buffer)
    return units


def _highlight_overrides(text: str, spans: list[tuple[int, int]], color: str,
                         restore: str = "#FFFFFF") -> list[str]:
    """把关键词区间包成 ASS 的 \\c 颜色覆盖片段。"""
    if not spans:
        return [_ass_text(text)]
    pieces: list[str] = []
    cursor = 0
    primary = _ass_color(color)
    back = _ass_color(restore)
    for start, end in spans:
        if start > cursor:
            pieces.append(_ass_text(text[cursor:start]))
        pieces.append(f"{{\\c{primary}}}{_ass_text(text[start:end])}{{\\c{back}}}")
        cursor = end
    if cursor < len(text):
        pieces.append(_ass_text(text[cursor:]))
    return pieces


def _animation_prefix(animation: str) -> str:
    """弹入动画：\\t 变换标签让字幕真的放大进场。"""
    if animation == "pop":
        return "{\\fscx45\\fscy45\\t(0,180,\\fscx100\\fscy100)\\fad(80,80)}"
    if animation == "fade":
        return "{\\fad(160,120)}"
    return ""


def _karaoke_text(text: str, duration: float, primary: str) -> str:
    """逐字高亮：给每个音节加 \\kf 卡拉OK标签。

    \\kf 的单位是厘秒，libass 会把 PrimaryColour 逐步扫到该字上——
    这就是竞品字幕面板里的「逐字高亮」，不是模拟。
    """
    units = _split_syllables(text)
    if not units:
        return _ass_text(text)
    weights = [max(1, len(unit)) for unit in units]
    total = sum(weights) or 1
    span = max(0.2, float(duration or 0))
    pieces = []
    for unit, weight in zip(units, weights):
        centiseconds = max(1, int(round(span * 100 * weight / total)))
        pieces.append(f"{{\\kf{centiseconds}}}{_ass_text(unit)}")
    return "".join(pieces)


def _gradient_text(text: str, start: str, end: str, restore: str = "#FFFFFF") -> str:
    """渐变花字：逐字覆盖颜色，从首色过渡到尾色。"""
    content = str(text or "")
    if not content:
        return ""
    units = _split_syllables(content)
    if not units:
        return _ass_text(content)
    from_rgb = _hex_to_rgb(start)
    to_rgb = _hex_to_rgb(end)
    pieces = []
    for index, unit in enumerate(units):
        progress = index / max(1, len(units) - 1)
        color = _lerp_color(from_rgb, to_rgb, progress)
        pieces.append(f"{{\\c{_ass_color(color)}}}{_ass_text(unit)}")
    pieces.append(f"{{\\c{_ass_color(restore)}}}")
    return "".join(pieces)

SENTENCE_END = "。！？!?…；;"
PAUSE_CHARS = "，,、：:—"
SPEAKER_RE = re.compile(r"^\s*([\u4e00-\u9fa5A-Za-z0-9_·]{1,8})\s*[：:]\s*")


def strip_speaker(text: str) -> str:
    """去掉「沈寂：」这类说话人前缀——字幕里再带名字会重复。"""
    return SPEAKER_RE.sub("", str(text or "")).strip()


def _split_long(chunk: str, limit: int) -> list[str]:
    """按逗号/顿号断开超长句；仍然超长就硬切。"""
    if len(chunk) <= limit:
        return [chunk]
    pieces, buffer = [], ""
    for char in chunk:
        buffer += char
        if char in PAUSE_CHARS and len(buffer) >= limit * 0.5:
            pieces.append(buffer)
            buffer = ""
        elif len(buffer) >= limit:
            pieces.append(buffer)
            buffer = ""
    if buffer.strip():
        pieces.append(buffer)
    result = []
    for piece in pieces:
        piece = piece.strip()
        while len(piece) > limit:
            result.append(piece[:limit])
            piece = piece[limit:]
        if piece:
            result.append(piece)
    return result


def split_dialogue(text: str, *, max_chars: int = 18) -> list[str]:
    """把一句台词切成适合一屏读完的字幕块。"""
    clean = re.sub(r"\s+", "", strip_speaker(text))
    if not clean:
        return []
    sentences, buffer = [], ""
    for char in clean:
        buffer += char
        if char in SENTENCE_END:
            sentences.append(buffer)
            buffer = ""
    if buffer:
        sentences.append(buffer)
    chunks: list[str] = []
    for sentence in sentences:
        chunks.extend(_split_long(sentence, max_chars))
    # 太碎的块（比如单独一个「。」）并回前一块，避免一闪而过。
    merged: list[str] = []
    for chunk in chunks:
        if merged and len(chunk) <= 3 and len(merged[-1]) + len(chunk) <= max_chars + 4:
            merged[-1] += chunk
        else:
            merged.append(chunk)
    return [chunk for chunk in merged if chunk.strip(SENTENCE_END + PAUSE_CHARS + " ") or len(chunk) > 1]


def subtitle_cues(shots, *, max_chars: int = 18, min_duration: float = 0.7,
                  timeline: list[float] | None = None) -> list[dict]:
    """按镜头台词与时长生成字幕条。

    shots 只需要 `id` / `dialogue` / `duration`；`timeline` 可显式给每个镜头的起点
    （合片带转场时镜头起点会重叠，直接累加时长会算错）。返回的 cue 时间均为**成片轴**。
    """
    cues: list[dict] = []
    cursor = 0.0
    for index, shot in enumerate(shots):
        duration = float(shot.get("duration") or 0)
        start = float(timeline[index]) if timeline and index < len(timeline) else cursor
        cursor = start + duration
        chunks = split_dialogue(shot.get("dialogue", ""), max_chars=max_chars)
        if not chunks or duration <= 0.2:
            continue
        total_chars = sum(max(1, len(chunk)) for chunk in chunks)
        weights = [max(1, len(chunk)) / total_chars for chunk in chunks]
        spans = [duration * weight for weight in weights]
        # 单条字幕至少 min_duration；时长不够时按比例压缩底线，宁可短也不能越过下一镜。
        floor = min(min_duration, duration / max(1, len(chunks)))
        deficit = sum(max(0.0, floor - span) for span in spans)
        if deficit > 0:
            flex = [max(0.0, span - floor) for span in spans]
            total_flex = sum(flex)
            spans = [span + (deficit * (f / total_flex) if total_flex > 0 else 0) for span, f in zip(spans, flex)]
        offset = start
        for chunk, span in zip(chunks, spans):
            end = min(start + duration, offset + span)
            if end - offset >= 0.2:
                cues.append({
                    "shotId": shot.get("id", ""),
                    "index": len(cues) + 1,
                    "start": round(offset, 3),
                    "end": round(end, 3),
                    "text": chunk,
                })
            offset = end
    return cues


def _srt_time(value: float) -> str:
    value = max(0.0, float(value))
    hours, rest = divmod(value, 3600)
    minutes, seconds = divmod(rest, 60)
    millis = int(round((seconds - int(seconds)) * 1000))
    if millis == 1000:
        millis = 999
    return f"{int(hours):02d}:{int(minutes):02d}:{int(seconds):02d},{millis:03d}"


def cues_to_srt(cues) -> str:
    lines = []
    for order, cue in enumerate(cues, 1):
        lines.append(str(order))
        lines.append(f"{_srt_time(cue['start'])} --> {_srt_time(cue['end'])}")
        lines.append(str(cue.get("text", "")).strip())
        lines.append("")
    return "\n".join(lines).strip() + "\n" if lines else ""


def subtitle_force_style(style: dict | None, *, height: int = 1280) -> str:
    """旧入口：libass 的 force_style 串（SRT 用）。

    注意：SRT 没有分辨率信息，libass 会按 4:3 的脚本空间等比塞进竖屏画面，
    结果 9:16 成片里字幕会「浮」到 71% 高度。合片一律改用 `cues_to_ass()`，
    这里只保留给外部工具/回归测试。
    """
    style = style or {}
    font = str(style.get("font") or "Microsoft YaHei")
    size_px = float(style.get("size") or 44)
    scale = 288.0 / max(1, height)
    ass_size = max(6, round(size_px * scale, 1))
    margin_px = float(style.get("marginV") if style.get("marginV") is not None else round(height * 0.07))
    margin_v = max(4, round(margin_px * scale))
    alignment = {"bottom": 2, "center": 5, "top": 8}.get(str(style.get("position") or "bottom"), 2)
    outline = float(style.get("outline") if style.get("outline") is not None else 2.0)
    parts = [
        f"FontName={font}",
        f"FontSize={ass_size}",
        "PrimaryColour=&H00FFFFFF" if style.get("color", "white") != "yellow" else "PrimaryColour=&H0000E5FF",
        "OutlineColour=&H96000000",
        "BorderStyle=1",
        f"Outline={outline}",
        "Shadow=0",
        f"Alignment={alignment}",
        f"MarginV={margin_v}",
        "MarginL=60", "MarginR=60",
    ]
    return ",".join(parts)


def resolve_subtitle_style(style: dict | None, width: int = 720, height: int = 1280) -> dict:
    """界面参数 → 实际像素。合片用的 ASS 直接按输出分辨率写，不做任何换算。"""
    style = style or {}
    size = int(style.get("size") or max(26, round(height * 0.036)))
    # 竖屏平台（抖音/红果）底部约 12% 高度被交互按钮占住，字幕压到 7% 会被挡住。
    # 用户显式给了 marginV 就以用户为准；没给则至少留出安全区。
    default_margin = max(round(height * 0.07), round(height * 0.12))
    margin = int(style.get("marginV") if style.get("marginV") is not None else default_margin)
    template = resolve_subtitle_template(style.get("template"), style)
    outline = float(style.get("outline") or 0) or max(1.5, size / 22)
    if template["outlineWidth"]:
        outline = float(template["outlineWidth"])
    return {
        # 字体名带逗号会把 ASS 的 Style 行拆错列，直接去掉。
        "font": re.sub(r"[,\r\n]", "", str(style.get("font") or "Microsoft YaHei")).strip() or "Microsoft YaHei",
        "size": max(12, size),
        # 描边填 0 视为「自动」：亮画面上的字幕没有描边会糊成一团。
        "outline": max(0.5, outline),
        "shadow": float(style.get("shadow") or 0) or float(template["shadow"] or 0),
        "align": {"bottom": 2, "center": 5, "top": 8}.get(str(style.get("position") or "bottom"), 2),
        "marginV": max(0, margin),
        "marginL": int(style.get("marginL") or round(width * 0.08)),
        "marginR": int(style.get("marginR") or round(width * 0.08)),
        "boxed": bool(style.get("boxed")),
        "color": "&H0000FFFF" if str(style.get("color") or "white") == "yellow" else "&H00FFFFFF",
        "bold": bool(style.get("bold", True)),
        "template": template["id"],
        "primary": template["primary"],
        "secondary": template["secondary"],
        "outlineColor": template["outlineColor"],
        "outlineAlpha": int(template.get("outlineAlpha", 0x96)),
        "scaleX": int(template["scaleX"]),
        "scaleY": int(template["scaleY"]),
        "spacing": float(template["spacing"]),
        "karaoke": bool(template["karaoke"]),
        "gradient": bool(template["gradient"]),
        "animation": template["animation"],
        "highlightColor": template["highlightColor"],
    }


def _ass_time(value: float) -> str:
    value = max(0.0, float(value))
    hours, rest = divmod(value, 3600)
    minutes, seconds = divmod(rest, 60)
    centis = int(round((seconds - int(seconds)) * 100))
    if centis == 100:
        centis = 99
    return f"{int(hours)}:{int(minutes):02d}:{int(seconds):02d}.{centis:02d}"


def _ass_text(text: str) -> str:
    # 花括号在 ASS 里是样式覆盖块，必须去掉，否则字幕会被吃掉半句。
    return str(text or "").replace("{", "（").replace("}", "）").replace("\n", "\\N")


def cues_to_ass(cues, *, width: int = 720, height: int = 1280, style: dict | None = None) -> str:
    """生成与成片分辨率同尺寸的 ASS：PlayResX/Y 对齐视频，字幕才会真的贴底。

    style.template 决定花字模板：逐字高亮（\\kf）、弹入动画（\\t）、渐变（\\c）、
    多层描边（霓虹/综艺）。模板没配就退回原来的白字描边，行为与之前一致。
    """
    resolved = resolve_subtitle_style(style, width, height)
    border_style = 3 if resolved["boxed"] else 1
    back_colour = "&H80000000" if resolved["boxed"] else "&H00000000"
    primary = _ass_color(resolved["primary"])
    secondary = _ass_color(resolved["secondary"])
    outline_colour = _ass_color(resolved["outlineColor"], resolved["outlineAlpha"])
    header = [
        "[Script Info]",
        "; 由星河制片台后期包装生成",
        "ScriptType: v4.00+",
        f"PlayResX: {int(width)}",
        f"PlayResY: {int(height)}",
        "WrapStyle: 2",
        "ScaledBorderAndShadow: yes",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, "
        "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
        "Alignment, MarginL, MarginR, MarginV, Encoding",
        "Style: Default,{font},{size},{primary},{secondary},{outline},{back},{bold},0,0,0,{scaleX},{scaleY},"
        "{spacing},0,{border},{outlineWidth},{shadow},{align},{marginL},{marginR},{marginV},1".format(
            font=resolved["font"], size=resolved["size"], primary=primary, secondary=secondary,
            outline=outline_colour, back=back_colour, bold=-1 if resolved["bold"] else 0,
            scaleX=resolved["scaleX"], scaleY=resolved["scaleY"], spacing=resolved["spacing"],
            border=border_style, outlineWidth=resolved["outline"], shadow=resolved["shadow"],
            align=resolved["align"], marginL=resolved["marginL"], marginR=resolved["marginR"],
            marginV=resolved["marginV"],
        ),
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    events: list[str] = []
    for cue in cues:
        raw = str(cue.get("text", ""))
        duration = max(0.2, float(cue.get("end", 0)) - float(cue.get("start", 0)))
        if resolved["karaoke"]:
            body = _karaoke_text(raw, duration, resolved["primary"])
        elif resolved["gradient"]:
            body = _gradient_text(raw, resolved["primary"], resolved["secondary"], resolved["primary"])
        else:
            spans = find_highlight_spans(raw)
            if spans:
                body = "".join(_highlight_overrides(raw, spans, resolved["highlightColor"], resolved["primary"]))
            else:
                body = _ass_text(raw)
        prefix = _animation_prefix(resolved["animation"])
        events.append(
            "Dialogue: 0,{start},{end},Default,,0,0,0,,{text}".format(
                start=_ass_time(cue["start"]), end=_ass_time(cue["end"]), text=f"{prefix}{body}",
            )
        )
    return "\n".join(header + events).strip() + "\n"


def layout_timeline(durations, *, transition: str = "none", overlap: float = 0.0) -> tuple[list[float], float]:
    """算出每个镜头在成片轴上的起点与总时长（转场会让相邻镜头重叠）。"""
    durations = [max(0.0, float(item)) for item in durations]
    if not durations:
        return [], 0.0
    use_overlap = 0.0 if transition in ("", "none") else max(0.0, float(overlap))
    starts = [0.0]
    end = durations[0]
    for duration in durations[1:]:
        start = max(0.0, end - use_overlap)
        starts.append(start)
        end = start + duration
    return starts, end


def timeline_plan(clips, *, transition: str = "none", transition_duration: float = 0.4) -> dict:
    """合片时间轴：变速后的有效时长、每个镜头起点、转场重叠量。

    配音起点、字幕时间、xfade offset 都从这一份结果取，避免三处各算一遍算出三种时间。
    """
    speeds = [max(0.25, min(4.0, float(clip.get("speed") or 1.0))) for clip in clips]
    effective = [float(clip.get("duration") or 0) / speed for clip, speed in zip(clips, speeds)]
    if effective and min(effective) <= 0.05:
        raise ValueError("存在时长无效的镜头，无法合片。")
    overlap = 0.0
    if len(effective) > 1 and transition not in ("", "none"):
        overlap = max(0.0, min(float(transition_duration), min(effective) * 0.6))
    starts, total = layout_timeline(effective, transition=transition, overlap=overlap)
    return {
        "speeds": speeds,
        "effective": [round(value, 3) for value in effective],
        "starts": [round(value, 3) for value in starts],
        "total": round(total, 3),
        "overlap": round(overlap, 3),
    }


def build_master_graph(clips, *, width: int, height: int, fps: int = 30,
                       transition: str = "none", transition_duration: float = 0.4,
                       grade: str = "none", subtitle_file: str = "",
                       tts=None, keep_source_audio: bool = True, source_volume: float = 1.0,
                       bgm: dict | None = None, fit: str = "blur", sizes=None,
                       sfx=None) -> dict:
    """生成合片用的 filter_complex；调用方只需按 inputs 顺序接 -i 并 map 两个输出标签。

    clips: [{"duration": float, "hasAudio": bool, "speed": float}]
    sizes: 可选，每个镜头的 [宽, 高]；用于判断是否需要补背景。
    fit:   画幅适配方式——"blur" 模糊背景填充（默认，对标主流）、"crop" 居中裁切铺满、
           "letterbox" 纯黑边。素材本身就是目标比例时三者结果一致。
    sfx:   音效轨 [{"input": int, "start": float, "volume": float}]，在镜头起点延迟混入。
    约定：先按顺序输入镜头 0..n-1，再输入 tts 音轨（`input` 字段给索引），
    然后是音效轨，最后输入 BGM。
    """
    if not clips:
        raise ValueError("至少需要一个镜头才能合片。")
    width, height, fps = int(width), int(height), int(fps)
    if width <= 0 or height <= 0:
        raise ValueError("输出分辨率无效。")
    fit = str(fit or "blur")
    if fit not in FIT_MODES:
        raise ValueError(f"不支持的画幅适配方式：{fit}")

    plan = timeline_plan(clips, transition=transition, transition_duration=transition_duration)
    speeds, starts, total, overlap = plan["speeds"], plan["starts"], plan["total"], plan["overlap"]

    filters: list[str] = []
    for index, (clip, speed) in enumerate(zip(clips, speeds)):
        # 素材已经是目标比例（竖屏片合成竖屏片）时不需要补背景，直接铺满即可。
        source = sizes[index] if sizes and index < len(sizes) else None
        needs_fill = True
        if source and source[0] and source[1]:
            try:
                source_ratio = float(source[0]) / float(source[1])
                target_ratio = width / height
                needs_fill = abs(source_ratio - target_ratio) / target_ratio > 0.02
            except (TypeError, ValueError, ZeroDivisionError):
                needs_fill = True

        trim_duration = max(0.05, float(clip.get("duration") or 0))
        pre_parts = [f"trim=duration={trim_duration:.4f}", "setpts=PTS-STARTPTS"]
        if abs(speed - 1.0) > 1e-6:
            pre_parts.append(f"setpts=PTS/{speed:.4f}")
        pre = ",".join(pre_parts) + ","

        if not needs_fill or fit == "crop":
            if fit == "crop" and needs_fill:
                # 居中裁切铺满：会切掉画面上下（或左右）边缘，短剧平台常用。
                chain = [
                    f"scale={width}:{height}:force_original_aspect_ratio=increase",
                    f"crop={width}:{height}",
                    "setsar=1",
                ]
            else:
                chain = [
                    f"scale={width}:{height}:force_original_aspect_ratio=decrease",
                    f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black",
                    "setsar=1",
                ]
            chain = [pre.rstrip(",")] + chain + [f"fps={fps}"]
            filters.append(f"[{index}:v]" + ",".join(chain) + f"[v{index}]")
            continue

        if fit == "letterbox":
            chain = [
                f"scale={width}:{height}:force_original_aspect_ratio=decrease",
                f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black",
                "setsar=1",
            ]
            chain = [pre.rstrip(",")] + chain + [f"fps={fps}"]
            filters.append(f"[{index}:v]" + ",".join(chain) + f"[v{index}]")
            continue

        # blur：背景用放大模糊的同一素材铺满，前景保持原比例居中叠上去。
        # 横屏素材转竖屏时不再出现大片黑边——这是与主流平台观感差距最大的一处。
        filters.append(
            f"[{index}:v]{pre}split=2[bg{index}][fg{index}]"
        )
        filters.append(
            f"[bg{index}]scale={width}:{height}:force_original_aspect_ratio=increase,"
            f"crop={width}:{height},gblur=sigma=26,eq=brightness=-0.07:saturation=0.85[bgx{index}]"
        )
        filters.append(
            f"[fg{index}]scale={width}:{height}:force_original_aspect_ratio=decrease[fgx{index}]"
        )
        filters.append(
            f"[bgx{index}][fgx{index}]overlay=(W-w)/2:(H-h)/2,setsar=1,fps={fps}[v{index}]"
        )

    if len(clips) == 1:
        video_label = "v0"
    elif overlap > 0:
        previous = "v0"
        for index in range(1, len(clips)):
            out = f"x{index}"
            filters.append(
                f"[{previous}][v{index}]xfade=transition={TRANSITIONS.get(transition, TRANSITIONS['fade'])['xfade']}"
                f":duration={overlap:.3f}:offset={starts[index]:.3f}[{out}]"
            )
            previous = out
        video_label = previous
    else:
        filters.append("".join(f"[v{index}]" for index in range(len(clips))) + f"concat=n={len(clips)}:v=1:a=0[vcat]")
        video_label = "vcat"

    post = []
    # 未知预设不能静默退化成「不调色」：那样用户选了电影感却拿到原色，很难自查。
    grade_key = str(grade or "none")
    if grade_key not in GRADE_PRESETS:
        raise ValueError(f"不支持的调色预设：{grade_key}（可选：{', '.join(GRADE_PRESETS)}）")
    grade_filter = GRADE_PRESETS[grade_key]["filter"]
    if grade_filter:
        post.append(grade_filter)
    if subtitle_file:
        # 只接受纯文件名的相对路径：滤镜串里出现盘符冒号或引号会被 ffmpeg 拆错参数。
        safe_file = re.sub(r"[^A-Za-z0-9._/-]+", "_", str(subtitle_file))
        if safe_file != str(subtitle_file):
            raise ValueError(f"字幕文件名不合法：{subtitle_file}")
        post.append(f"subtitles=filename={safe_file}")
    if post:
        filters.append(f"[{video_label}]" + ",".join(post) + "[vout]")
        video_label = "vout"

    audio_parts: list[str] = []
    if keep_source_audio:
        for index, (clip, speed) in enumerate(zip(clips, speeds)):
            if not clip.get("hasAudio"):
                continue
            chain = [f"atrim=duration={max(0.05, float(clip.get('duration') or 0)):.4f}", "asetpts=PTS-STARTPTS", "aresample=48000"]
            if abs(speed - 1.0) > 1e-6:
                # atempo 单次只接受 0.5–2.0，超范围要串联。
                tempo = speed
                while tempo > 2.0:
                    chain.insert(0, "atempo=2.0")
                    tempo /= 2.0
                while tempo < 0.5:
                    chain.insert(0, "atempo=0.5")
                    tempo /= 0.5
                chain.insert(0, f"atempo={tempo:.4f}")
            chain.append(f"volume={max(0.0, float(source_volume)):.3f}")
            chain.append(f"adelay={int(round(starts[index] * 1000))}:all=1")
            filters.append(f"[{index}:a]" + ",".join(chain) + f"[sa{index}]")
            audio_parts.append(f"[sa{index}]")

    for order, line in enumerate(tts or []):
        try:
            input_index = int(line["input"])
        except (KeyError, TypeError, ValueError):
            continue
        delay = int(round(max(0.0, float(line.get("start") or 0.0)) * 1000))
        volume = max(0.0, float(line.get("volume", 1.0)))
        filters.append(
            f"[{input_index}:a]aresample=48000,volume={volume:.3f},adelay={delay}:all=1[tts{order}]"
        )
        audio_parts.append(f"[tts{order}]")

    # 音效轨：按镜头起点延迟混入，短音效不会被后一个镜头的转场吃掉。
    for order, line in enumerate(sfx or []):
        try:
            input_index = int(line["input"])
        except (KeyError, TypeError, ValueError):
            continue
        delay = int(round(max(0.0, float(line.get("start") or 0.0)) * 1000))
        volume = max(0.0, float(line.get("volume", 0.6)))
        filters.append(
            f"[{input_index}:a]aresample=48000,volume={volume:.3f},adelay={delay}:all=1[sfx{order}]"
        )
        audio_parts.append(f"[sfx{order}]")

    if bgm:
        input_index = int(bgm.get("input", 0))
        volume = max(0.0, float(bgm.get("volume", 0.25)))
        fade_in = max(0.0, min(float(bgm.get("fadeIn", 1.5)), total / 2))
        fade_out = max(0.0, min(float(bgm.get("fadeOut", 2.0)), total / 2))
        chain = ["aresample=48000", f"volume={volume:.3f}", f"atrim=0:{total:.3f}"]
        if fade_in > 0:
            chain.append(f"afade=t=in:st=0:d={fade_in:.2f}")
        if fade_out > 0:
            chain.append(f"afade=t=out:st={max(0.0, total - fade_out):.2f}:d={fade_out:.2f}")
        filters.append(f"[{input_index}:a]" + ",".join(chain) + "[bgm0]")
        audio_parts.append("[bgm0]")

    audio_label = ""
    if audio_parts:
        filters.append(
            "".join(audio_parts)
            + f"amix=inputs={len(audio_parts)}:normalize=0:duration=longest,"
            # 配音是单声道 mp3，直接 amix 会把整条音轨降成单声道；交付要立体声。
            + "aformat=channel_layouts=stereo,"
            + f"atrim=0:{total:.3f},alimiter=limit=0.95[aout]"
        )
        audio_label = "aout"

    return {
        "filter": ";".join(filters),
        "video": f"[{video_label}]",
        "audio": f"[{audio_label}]" if audio_label else "",
        "duration": round(total, 3),
        "offsets": [round(value, 3) for value in starts],
        "effective": plan["effective"],
        "overlap": round(overlap, 3),
    }


def _cover_crop(image, width: int, height: int):
    from PIL import Image

    ratio = width / height
    src_ratio = image.width / max(1, image.height)
    if src_ratio > ratio:
        new_width = int(round(image.height * ratio))
        left = (image.width - new_width) // 2
        image = image.crop((left, 0, left + new_width, image.height))
    else:
        new_height = int(round(image.width / ratio))
        top = (image.height - new_height) // 2
        image = image.crop((0, top, image.width, top + new_height))
    return image.resize((width, height), Image.LANCZOS)


def _font(size: int, bold: bool = False):
    from PIL import ImageFont

    candidates = (
        [r"C:\Windows\Fonts\msyhbd.ttc", r"C:\Windows\Fonts\simhei.ttf"] if bold
        else [r"C:\Windows\Fonts\msyh.ttc", r"C:\Windows\Fonts\simhei.ttf"]
    )
    for path in candidates:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


def _wrap_text(text: str, font, max_width: int) -> list[str]:
    lines, current = [], ""
    for char in text:
        if char == "\n":
            lines.append(current)
            current = ""
            continue
        trial = current + char
        if font.getlength(trial) > max_width and current:
            lines.append(current)
            current = char
        else:
            current = trial
    if current:
        lines.append(current)
    return lines


def render_cover(frame: bytes | None, title: str, subtitle: str = "", *,
                 width: int = 1080, height: int = 1920, accent: str = "#E23B2E",
                 watermark: str = "") -> bytes:
    """取首帧 → 压暗 → 排标题；没有首帧时用深色渐变兜底，保证封面永远出得来。"""
    from io import BytesIO

    from PIL import Image, ImageDraw

    if frame:
        try:
            base = _cover_crop(Image.open(BytesIO(frame)).convert("RGB"), width, height)
        except Exception:
            base = Image.new("RGB", (width, height), (12, 14, 20))
    else:
        base = Image.new("RGB", (width, height), (12, 14, 20))

    draw = ImageDraw.Draw(base, "RGBA")
    # 自下而上的渐变蒙版：下部 55% 压到接近黑，保证白字可读。
    scrim_top = int(height * 0.42)
    for offset in range(scrim_top, height):
        progress = (offset - scrim_top) / max(1, height - scrim_top)
        alpha = int(215 * (progress ** 0.85))
        draw.line([(0, offset), (width, offset)], fill=(6, 8, 12, alpha))

    margin = int(width * 0.09)
    title_text = (title or "未命名剧集").strip()
    size = int(width * 0.115)
    font = _font(size, bold=True)
    lines = _wrap_text(title_text, font, width - margin * 2)
    while len(lines) > 3 and size > int(width * 0.06):
        size -= max(2, int(width * 0.006))
        font = _font(size, bold=True)
        lines = _wrap_text(title_text, font, width - margin * 2)

    line_height = int(size * 1.28)
    block_height = line_height * len(lines)
    subtitle_font = _font(int(width * 0.042))
    subtitle_lines = _wrap_text(subtitle, subtitle_font, width - margin * 2) if subtitle else []
    subtitle_height = int(width * 0.042 * 1.5) * len(subtitle_lines)
    bottom = height - int(height * 0.11)
    bar_height = max(6, int(width * 0.012))
    top_of_block = bottom - subtitle_height - block_height - int(width * 0.03)

    draw.rectangle([margin, top_of_block - int(width * 0.05), margin + int(width * 0.12), top_of_block - int(width * 0.05) + bar_height], fill=accent)

    cursor = top_of_block
    for line in lines:
        draw.text((margin, cursor), line, font=font, fill=(255, 255, 255))
        cursor += line_height
    cursor += int(width * 0.015)
    for line in subtitle_lines:
        draw.text((margin, cursor), line, font=subtitle_font, fill=(226, 230, 238))
        cursor += int(width * 0.042 * 1.5)

    if watermark:
        small = _font(int(width * 0.03))
        draw.text((margin, int(height * 0.07)), watermark, font=small, fill=(255, 255, 255, 190))

    buffer = BytesIO()
    base.save(buffer, "PNG")
    return buffer.getvalue()


# ---------------------------------------------------------------- 配音

# 情绪预设：edge-tts 不接受 SSML 情绪标签（7.x 会把标签当正文念出来），
# 所以用语速/音高/音量三件套模拟情绪。效果不如 SeedAudio 的情感模型，
# 但胜在稳定可控、零额外依赖。
VOICE_STYLES = [
    {"id": "drama", "label": "剧情（中性）", "rate": 0, "pitch": 0, "volume": 0},
    {"id": "calm", "label": "平静（克制）", "rate": -8, "pitch": -2, "volume": -5},
    {"id": "warm", "label": "温柔（亲密）", "rate": -6, "pitch": -1, "volume": -3},
    {"id": "tense", "label": "紧张（压低）", "rate": 6, "pitch": -3, "volume": 2},
    {"id": "angry", "label": "愤怒（爆发）", "rate": 14, "pitch": 8, "volume": 12},
    {"id": "sad", "label": "悲伤（低落）", "rate": -10, "pitch": -6, "volume": -8},
    {"id": "excited", "label": "激动（上扬）", "rate": 12, "pitch": 6, "volume": 8},
    {"id": "narrate", "label": "叙述（旁白）", "rate": -4, "pitch": 2, "volume": 0},
]


def resolve_voice_style(style_id, *, rate: int = 0, pitch: int = 0, volume: int = 0) -> dict:
    """把情绪预设叠加到用户设定的语速/音高上，返回最终参数。"""
    preset = next((item for item in VOICE_STYLES if item["id"] == str(style_id or "")), None)
    if not preset:
        preset = VOICE_STYLES[0]
    return {
        "style": preset["id"],
        "rate": max(-50, min(80, int(rate) + int(preset["rate"]))),
        "pitch": max(-50, min(50, int(pitch) + int(preset["pitch"]))),
        "volume": max(-50, min(50, int(volume) + int(preset["volume"]))),
    }


def tts_available() -> bool:
    try:
        import edge_tts  # noqa: F401
        return True
    except Exception:
        return False


def _run_async(coro_factory):
    """Windows + Python 3.9 上 Proactor 循环会在退出时报 Event loop is closed，换 Selector。"""
    policy = getattr(asyncio, "WindowsSelectorEventLoopPolicy", None)
    if policy is not None:
        try:
            asyncio.set_event_loop_policy(policy())
        except Exception:
            pass
    loop = asyncio.new_event_loop()
    try:
        asyncio.set_event_loop(loop)
        return loop.run_until_complete(coro_factory())
    finally:
        try:
            loop.run_until_complete(loop.shutdown_asyncgens())
        finally:
            loop.close()
            asyncio.set_event_loop(None)


def synthesize_speech(text: str, voice: str, out_path: Path, *, rate: int = 0, pitch: int = 0, volume: int = 0) -> Path:
    """把一句台词合成 mp3。rate/pitch/volume 是相对百分比，界面上的「语速」直接透传。"""
    spoken = strip_speaker(text)
    if not spoken:
        raise ValueError("这句台词是空的，跳过配音。")
    try:
        import edge_tts
    except ImportError as error:  # pragma: no cover - 安装后不会走到
        raise ValueError("本机缺少 edge-tts，配音不可用：pip install edge-tts") from error

    voice = str(voice or VOICES[0]["id"])
    rate_text = f"{int(rate):+d}%"
    pitch_text = f"{int(pitch):+d}Hz"
    volume_text = f"{int(volume):+d}%"

    async def run() -> None:
        communicate = edge_tts.Communicate(spoken, voice, rate=rate_text, pitch=pitch_text, volume=volume_text)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        with out_path.open("wb") as handle:
            async for chunk in communicate.stream():
                if chunk["type"] == "audio":
                    handle.write(chunk["data"])

    _run_async(run)
    if not out_path.is_file() or out_path.stat().st_size < 512:
        raise ValueError("配音合成没有返回音频，检查网络或换一个音色。")
    return out_path


# ---------------------------------------------------------------- 剪映草稿

def _draft_config(width: int, height: int, fps: int, *, font_size: int, font_family: str,
                  border: int, bgm_path: str, bgm_enabled: bool) -> dict:
    """draft_export 那套辅助函数吃的配置字典；字段名保持和旧模块一致。"""
    return {
        "output_resolution": f"{width}x{height}",
        "crop_mode": "fit",
        "pip_layout": "none",
        "fps": fps,
        "font_family": font_family,
        "subtitle": {"font_size": font_size, "color": "FFFFFF", "border_color": "000000"},
        "subtitle_border": border,
        "bgm_path": bgm_path,
        "bgm": {"enable": bgm_enabled, "volume": 1.0, "fade_in": 1.5, "fade_out": 2.0},
        "motion_effect": {"enable": False},
        "beat_sync": {"impact_effect": "none", "impact_duration": 0.0},
        "smart_beat_sync": False,
        "ffmpeg": "ffmpeg",
        "ffprobe": "ffprobe",
        "probe_timeout": 120,
    }


def build_draft_document(*, template: dict, name: str, width: int, height: int, fps: int,
                         clips, cues, tts=None, bgm=None, font_size: int = 44,
                         font_family: str = "微软雅黑") -> dict:
    """生成剪映 draft_content.json。

    clips: [{"path","duration","speed","width","height"}]
    cues:  subtitle_cues() 的结果
    tts:   [{"path","start","duration"}]
    bgm:   {"path","volume","duration"} | None
    """
    import copy

    from draft_export import align_to_jianying, segment, text_material, track, us, validate_draft, visual_material

    content = copy.deepcopy(template)
    config = _draft_config(width, height, fps, font_size=font_size, font_family=font_family,
                           border=3, bgm_path=(bgm or {}).get("path", ""), bgm_enabled=bool(bgm))
    ident = uuid.uuid4().hex.upper()
    starts, total = layout_timeline([float(clip["duration"]) / max(0.25, float(clip.get("speed") or 1.0)) for clip in clips])
    content.update(id=ident, name=name, duration=us(total), fps=float(fps), create_time=int(__import__("time").time() * 1_000_000))
    content["canvas_config"] = {"width": width, "height": height, "ratio": "original"}

    material_map: dict[str, str] = {}
    for clip in clips:
        material = visual_material(clip["path"], {
            "width": int(clip.get("width") or width),
            "height": int(clip.get("height") or height),
            "duration": float(clip["duration"]),
        }, config)
        content["materials"]["videos"].append(material)
        material_map[clip["path"]] = material["id"]

    video_segments = []
    for index, clip in enumerate(clips):
        speed = max(0.25, float(clip.get("speed") or 1.0))
        duration = float(clip["duration"])
        video_segments.append(segment(
            material_map[clip["path"]], starts[index], duration / speed, 0.0, duration,
        ))
    content["tracks"] = [track("主视频", "video", video_segments, 0)]

    text_segments = []
    for cue in cues:
        material = text_material(cue["text"], config)
        content["materials"]["texts"].append(material)
        item = segment(material["id"], cue["start"], max(0.2, cue["end"] - cue["start"]))
        item["source_timerange"] = None
        text_segments.append(item)
    if text_segments:
        content["tracks"].append(track("字幕（可编辑）", "text", text_segments, 1))

    audio_segments = []
    for line in tts or []:
        length = float(line.get("duration") or 0)
        if length <= 0:
            continue
        material_id = uuid.uuid4().hex.upper()
        content["materials"]["audios"].append({
            "id": material_id, "local_material_id": material_id, "music_id": material_id,
            "name": Path(line["path"]).name, "path": str(Path(line["path"]).resolve()),
            "duration": us(length), "type": "extract_music", "category_id": "",
            "category_name": "local", "app_id": 0, "check_flag": 3,
            "copyright_limit_type": "none", "effect_id": "", "formula_id": "",
            "source_platform": 0, "wave_points": [],
        })
        audio_segments.append(segment(material_id, float(line["start"]), length, volume=float(line.get("volume", 1.0))))
    if audio_segments:
        content["tracks"].append(track("配音", "audio", audio_segments, 0))

    if bgm and bgm.get("path"):
        track_length = float(bgm.get("duration") or 0)
        if track_length > 0:
            music_id = uuid.uuid4().hex.upper()
            content["materials"]["audios"].append({
                "id": music_id, "local_material_id": music_id, "music_id": music_id,
                "name": Path(bgm["path"]).name, "path": str(Path(bgm["path"]).resolve()),
                "duration": us(track_length), "type": "extract_music", "category_id": "",
                "category_name": "local", "app_id": 0, "check_flag": 3,
                "copyright_limit_type": "none", "effect_id": "", "formula_id": "",
                "source_platform": 0, "wave_points": [],
            })
            music_segments = []
            cursor = 0.0
            while cursor < total - 1e-6:
                length = min(track_length, total - cursor)
                item = segment(music_id, cursor, length, volume=float(bgm.get("volume", 0.25)))
                item["clip"] = None
                item["hdr_settings"] = None
                music_segments.append(item)
                cursor += length
            content["tracks"].append(track("BGM", "audio", music_segments, 1))

    align_to_jianying(content)
    validate_draft(content)
    return content


def draft_meta(draft_id: str, folder: str, total: float) -> dict:
    import time

    return {
        "draft_id": draft_id,
        "draft_name": Path(folder).name,
        "draft_fold_path": str(folder),
        "draft_root_path": str(Path(folder).parent),
        "draft_cover": "",
        "draft_materials": [],
        "draft_is_invisible": False,
        "draft_version": "5.9.0",
        "tm_draft_create": int(time.time() * 1_000_000),
        "tm_draft_modified": int(time.time() * 1_000_000),
        "tm_duration": round(total * 1_000_000),
    }


def probe_duration(path: Path, *, ffprobe: str = "ffprobe") -> float:
    try:
        result = subprocess.run(
            [ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "json", str(path)],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60,
        )
        if result.returncode == 0:
            return float(json.loads(result.stdout)["format"]["duration"])
    except Exception:
        return 0.0
    return 0.0


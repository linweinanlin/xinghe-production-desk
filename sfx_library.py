"""音效库：本地程序化合成短剧常用音效，并按镜头内容自动匹配。

竞品（即梦 / 小云雀）在「音效」面板里提供一整套拟音库，用户可以逐镜挑音效，
也可以让系统按画面内容自动贴。这一层以前只有 BGM 一条循环音，是能力缺口之一。

这里不引入任何外部音频素材（版权与体积都不可控），而是用 numpy 现场合成：
每种音效是一个纯函数，输入采样率与时长，输出 float 波形。合成规则贴近真实拟音：

- 脚步：两次低频冲击 + 高频「哒哒」摩擦声
- 开门：低频吱呀（频率缓慢下滑）+ 末端咔哒
- 撞击：宽带噪声爆裂 + 快速衰减
- 风声：带通噪声 + 缓慢起伏
- 心跳：两段正弦鼓点
- 快门：两段极短噪声脉冲
- 刀剑：高频金属碰撞 + 长尾
- 爆炸：低频轰鸣 + 噪声
- 水滴：单次正弦下滑 + 短混响尾

音频统一编码成 16bit PCM WAV（标准库 wave 就能写），通过 /api/sfx-library 暴露，
合片时按镜头起点用 adelay 混入主音轨。
"""
from __future__ import annotations

import io
import math
import struct
import wave

__all__ = [
    "SFX_LIBRARY", "SFX_CATEGORIES", "sfx_ids", "sfx_by_id",
    "render_sfx", "render_sfx_wav", "match_sfx_for_shot", "match_sfx_for_shots",
    "SAMPLE_RATE",
]

SAMPLE_RATE = 44100


def _noise(rng, count: int) -> list:
    return [rng.uniform(-1.0, 1.0) for _ in range(count)]


def _envelope(count: int, attack: float, decay: float) -> list:
    """指数衰减包络；attack 是起音秒数，decay 是衰减到几乎无声所需秒数。"""
    envelope = []
    attack_samples = max(1, int(attack * SAMPLE_RATE))
    for index in range(count):
        if index < attack_samples:
            envelope.append(index / attack_samples)
        else:
            tail = (index - attack_samples) / max(1.0, decay * SAMPLE_RATE)
            envelope.append(math.exp(-4.0 * tail))
    return envelope


def _lowpass(samples: list, cutoff: float) -> list:
    """一阶低通：把白噪声变成有质感的底噪。"""
    alpha = min(0.99, max(0.001, 2.0 * math.pi * cutoff / SAMPLE_RATE))
    previous = 0.0
    output = []
    for value in samples:
        previous += alpha * (value - previous)
        output.append(previous)
    return output


def _highpass(samples: list, cutoff: float) -> list:
    """一阶高通：去掉低频隆隆声，只留清脆部分。"""
    low = _lowpass(samples, cutoff)
    return [value - low[index] for index, value in enumerate(samples)]


def _normalize(samples: list, peak: float = 0.85) -> list:
    highest = max((abs(value) for value in samples), default=0.0)
    if highest <= 1e-6:
        return samples
    scale = peak / highest
    return [value * scale for value in samples]


def _mix(base: list, extra: list, offset: int, gain: float = 1.0) -> list:
    for index, value in enumerate(extra):
        target = offset + index
        if 0 <= target < len(base):
            base[target] += value * gain
    return base


def _tone(frequency: float, duration: float, *, sweep_to: float = 0.0,
          amplitude: float = 1.0) -> list:
    """正弦音；sweep_to 不为 0 时频率线性滑到目标值（用于吱呀声与水滴）。"""
    count = max(1, int(duration * SAMPLE_RATE))
    samples = []
    phase = 0.0
    for index in range(count):
        progress = index / count
        current = frequency + (sweep_to - frequency) * progress
        phase += 2.0 * math.pi * current / SAMPLE_RATE
        samples.append(math.sin(phase) * amplitude)
    return samples


def _seed_rng(seed: int):
    """确定性伪随机：同一个音效每次合成波形一致，便于回归测试比对。"""
    state = seed & 0xFFFFFFFF or 1

    def random() -> float:
        nonlocal state
        state = (1103515245 * state + 12345) & 0x7FFFFFFF
        return (state / 0x7FFFFFFF) * 2.0 - 1.0

    return random


def _footstep() -> list:
    duration = 0.46
    count = int(duration * SAMPLE_RATE)
    random = _seed_rng(11)
    base = [0.0] * count
    for step, offset in enumerate((0.0, 0.19)):
        # 低频「咚」：落脚冲击。
        thump = _tone(96.0, 0.16, sweep_to=58.0)
        thump_env = _envelope(len(thump), 0.002, 0.12)
        thump = [value * env for value, env in zip(thump, thump_env)]
        base = _mix(base, thump, int(offset * SAMPLE_RATE), 0.9)
        # 高频「沙」：鞋底摩擦地面。
        grain = _highpass([random() for _ in range(int(0.07 * SAMPLE_RATE))], 2600.0)
        grain_env = _envelope(len(grain), 0.001, 0.05)
        grain = [value * env for value, env in zip(grain, grain_env)]
        base = _mix(base, grain, int(offset * SAMPLE_RATE), 0.45 + step * 0.05)
    return _normalize(base, 0.8)


def _door_open() -> list:
    duration = 1.1
    count = int(duration * SAMPLE_RATE)
    random = _seed_rng(23)
    base = [0.0] * count
    # 门轴吱呀：频率从 480Hz 缓慢滑到 220Hz，带颤动。
    creak_count = int(0.78 * SAMPLE_RATE)
    phase = 0.0
    creak = []
    for index in range(creak_count):
        progress = index / creak_count
        current = 480.0 - 260.0 * progress
        phase += 2.0 * math.pi * current / SAMPLE_RATE
        wobble = 1.0 + 0.22 * math.sin(2.0 * math.pi * 17.0 * index / SAMPLE_RATE)
        creak.append(math.sin(phase) * wobble * (0.5 + 0.5 * progress))
    creak_env = _envelope(len(creak), 0.06, 0.75)
    creak = [value * env for value, env in zip(creak, creak_env)]
    base = _mix(base, creak, 0, 0.55)
    # 末端「咔哒」：门锁/门框到位。
    click = _highpass([random() for _ in range(int(0.05 * SAMPLE_RATE))], 1800.0)
    click_env = _envelope(len(click), 0.001, 0.035)
    click = [value * env for value, env in zip(click, click_env)]
    base = _mix(base, click, int(0.82 * SAMPLE_RATE), 0.7)
    return _normalize(base, 0.7)


def _impact() -> list:
    duration = 0.7
    count = int(duration * SAMPLE_RATE)
    random = _seed_rng(37)
    burst = _lowpass([random() for _ in range(count)], 1800.0)
    env = _envelope(count, 0.001, 0.16)
    burst = [value * env_value for value, env_value in zip(burst, env)]
    body = _tone(120.0, 0.42, sweep_to=44.0)
    body_env = _envelope(len(body), 0.002, 0.28)
    body = [value * env_value for value, env_value in zip(body, body_env)]
    mixed = [burst[index] * 0.75 + body[index] if index < len(body) else burst[index] * 0.75
             for index in range(count)]
    return _normalize(mixed, 0.9)


def _wind() -> list:
    duration = 2.6
    count = int(duration * SAMPLE_RATE)
    random = _seed_rng(53)
    noise = _lowpass([random() for _ in range(count)], 900.0)
    mixed = []
    for index, value in enumerate(noise):
        swell = 0.45 + 0.55 * (0.5 + 0.5 * math.sin(2.0 * math.pi * 0.42 * index / SAMPLE_RATE))
        mixed.append(value * swell)
    return _normalize(mixed, 0.45)


def _heartbeat() -> list:
    duration = 1.1
    count = int(duration * SAMPLE_RATE)
    base = [0.0] * count
    for offset, gain in ((0.0, 1.0), (0.26, 0.72)):
        beat = _tone(58.0, 0.22, sweep_to=40.0)
        env = _envelope(len(beat), 0.004, 0.13)
        beat = [value * env_value * gain for value, env_value in zip(beat, env)]
        base = _mix(base, beat, int(offset * SAMPLE_RATE), 1.0)
    return _normalize(base, 0.8)


def _shutter() -> list:
    duration = 0.42
    count = int(duration * SAMPLE_RATE)
    random = _seed_rng(67)
    base = [0.0] * count
    for offset, gain in ((0.0, 1.0), (0.14, 0.9)):
        snap = _highpass([random() for _ in range(int(0.03 * SAMPLE_RATE))], 3200.0)
        env = _envelope(len(snap), 0.0005, 0.018)
        snap = [value * env_value * gain for value, env_value in zip(snap, env)]
        base = _mix(base, snap, int(offset * SAMPLE_RATE), 0.9)
    return _normalize(base, 0.75)


def _sword() -> list:
    duration = 1.3
    count = int(duration * SAMPLE_RATE)
    base = [0.0] * count
    for frequency, gain in ((1870.0, 0.6), (2640.0, 0.42), (3910.0, 0.26)):
        tone = _tone(frequency, duration)
        env = _envelope(len(tone), 0.001, 0.42)
        base = _mix(base, [value * env_value * gain for value, env_value in zip(tone, env)], 0, 1.0)
    return _normalize(base, 0.72)


def _explosion() -> list:
    duration = 1.8
    count = int(duration * SAMPLE_RATE)
    random = _seed_rng(83)
    rumble = _lowpass([random() for _ in range(count)], 420.0)
    env = _envelope(count, 0.004, 0.62)
    rumble = [value * env_value for value, env_value in zip(rumble, env)]
    sub = _tone(70.0, 1.2, sweep_to=32.0)
    sub_env = _envelope(len(sub), 0.006, 0.7)
    sub = [value * env_value for value, env_value in zip(sub, sub_env)]
    mixed = [rumble[index] * 0.9 + (sub[index] if index < len(sub) else 0.0) for index in range(count)]
    return _normalize(mixed, 0.95)


def _water_drop() -> list:
    duration = 0.85
    count = int(duration * SAMPLE_RATE)
    drop = _tone(1500.0, 0.16, sweep_to=520.0)
    env = _envelope(len(drop), 0.001, 0.1)
    drop = [value * env_value for value, env_value in zip(drop, env)]
    tail = _tone(520.0, 0.6, sweep_to=498.0)
    tail_env = _envelope(len(tail), 0.004, 0.32)
    tail = [value * env_value * 0.32 for value, env_value in zip(tail, tail_env)]
    mixed = [0.0] * count
    mixed = _mix(mixed, drop, 0, 1.0)
    mixed = _mix(mixed, tail, int(0.1 * SAMPLE_RATE), 1.0)
    return _normalize(mixed, 0.72)


def _gunshot() -> list:
    """枪声：极短的高频爆裂 + 快速衰减的低频冲击 + 一段空间回声。"""
    duration = 1.05
    count = int(duration * SAMPLE_RATE)
    random = _seed_rng(113)
    base = [0.0] * count
    # 爆音：极短的高通噪声。
    crack = _highpass([random() for _ in range(int(0.035 * SAMPLE_RATE))], 2200.0)
    crack_env = _envelope(len(crack), 0.0004, 0.022)
    base = _mix(base, [value * env for value, env in zip(crack, crack_env)], 0, 1.0)
    # 冲击：中低频迅速下坠。
    boom = _tone(180.0, 0.28, sweep_to=48.0)
    boom_env = _envelope(len(boom), 0.001, 0.15)
    base = _mix(base, [value * env for value, env in zip(boom, boom_env)], 0, 0.85)
    # 空间回声：把爆音复制两遍并衰减，做出空旷场地的纵深。
    echo = _lowpass([random() for _ in range(int(0.22 * SAMPLE_RATE))], 2400.0)
    echo_env = _envelope(len(echo), 0.01, 0.16)
    echo = [value * env for value, env in zip(echo, echo_env)]
    base = _mix(base, echo, int(0.11 * SAMPLE_RATE), 0.34)
    base = _mix(base, echo, int(0.27 * SAMPLE_RATE), 0.16)
    return _normalize(base, 0.95)


def _whoosh() -> list:
    duration = 0.62
    count = int(duration * SAMPLE_RATE)
    random = _seed_rng(97)
    noise = _highpass([random() for _ in range(count)], 900.0)
    mixed = []
    for index, value in enumerate(noise):
        progress = index / count
        swell = math.sin(math.pi * progress) ** 1.6
        mixed.append(value * swell)
    return _normalize(mixed, 0.55)


# 音效库清单。keywords 用于按镜头文本自动匹配；duration 是合成时长（秒）。
SFX_LIBRARY = [
    {"id": "footstep", "label": "脚步声", "category": "拟音", "duration": 0.46, "keywords": ["走", "跑", "脚步", "进入", "离开", "走过", "walk", "run", "step"],
     "renderer": _footstep},
    {"id": "door", "label": "开门声", "category": "拟音", "duration": 1.1, "keywords": ["门", "推门", "开门", "关上", "door"],
     "renderer": _door_open},
    {"id": "impact", "label": "撞击/摔物", "category": "冲击", "duration": 0.7, "keywords": ["撞", "摔", "砸", "跌", "倒", "打", "击", "重击", "impact", "hit"],
     "renderer": _impact},
    {"id": "wind", "label": "风声", "category": "环境", "duration": 2.6, "keywords": ["风", "吹", "空旷", "荒野", "风衣", "wind"],
     "renderer": _wind},
    {"id": "heartbeat", "label": "心跳声", "category": "情绪", "duration": 1.1, "keywords": ["心跳", "紧张", "恐惧", "惊慌", "喘", "heartbeat"],
     "renderer": _heartbeat},
    {"id": "shutter", "label": "相机快门", "category": "拟音", "duration": 0.42, "keywords": ["拍照", "相机", "快门", "闪光灯", "相机", "camera", "shutter"],
     "renderer": _shutter},
    {"id": "sword", "label": "刀剑碰撞", "category": "冲击", "duration": 1.3, "keywords": ["刀", "剑", "砍", "斩", "兵器", "sword"],
     "renderer": _sword},
    {"id": "explosion", "label": "爆炸", "category": "冲击", "duration": 1.8, "keywords": ["爆炸", "轰", "炸", "爆", "explosion"],
     "renderer": _explosion},
    {"id": "water", "label": "水滴", "category": "环境", "duration": 0.85, "keywords": ["水", "雨", "滴", "泼", "雨滴", "water", "rain"],
     "renderer": _water_drop},
    {"id": "gunshot", "label": "枪声", "category": "冲击", "duration": 1.05, "keywords": ["枪", "开枪", "射击", "枪声", "扣动扳机", "gun", "shot"],
     "renderer": _gunshot},
    {"id": "whoosh", "label": "呼啸掠过", "category": "转场", "duration": 0.62, "keywords": ["掠过", "划过", "闪过", "疾驰", "冲出", "闪过", "whoosh"],
     "renderer": _whoosh},
]

SFX_CATEGORIES = ["拟音", "冲击", "环境", "情绪", "转场"]


def sfx_ids() -> list[str]:
    return [item["id"] for item in SFX_LIBRARY]


def sfx_by_id(sfx_id: str) -> dict | None:
    for item in SFX_LIBRARY:
        if item["id"] == str(sfx_id or "").strip():
            return item
    return None


def render_sfx(sfx_id: str, *, sample_rate: int = SAMPLE_RATE) -> list:
    """合成单个音效，返回 [-1, 1] 的浮点采样。"""
    item = sfx_by_id(sfx_id)
    if not item:
        raise ValueError(f"未知音效：{sfx_id}")
    samples = item["renderer"]()
    if sample_rate != SAMPLE_RATE:
        ratio = sample_rate / float(SAMPLE_RATE)
        count = max(1, int(len(samples) * ratio))
        scaled = []
        for index in range(count):
            position = index / ratio
            left = int(position)
            right = min(len(samples) - 1, left + 1)
            weight = position - left
            scaled.append(samples[left] * (1 - weight) + samples[right] * weight)
        samples = scaled
    return samples


def render_sfx_wav(sfx_id: str, *, sample_rate: int = SAMPLE_RATE) -> bytes:
    """合成并编码成 16bit PCM WAV（浏览器与 ffmpeg 都能直接吃）。"""
    samples = render_sfx(sfx_id, sample_rate=sample_rate)
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        payload = bytearray()
        for value in samples:
            clipped = max(-1.0, min(1.0, value))
            payload += struct.pack("<h", int(clipped * 32767))
        handle.writeframes(bytes(payload))
    return buffer.getvalue()


def _shot_text(shot: dict) -> str:
    parts = [shot.get("title"), shot.get("action"), shot.get("dialogue"), shot.get("camera"), shot.get("prompt")]
    return " ".join(str(part) for part in parts if part).lower()


def match_sfx_for_shot(shot: dict) -> list[str]:
    """按镜头文本匹配音效 id；命中多个时按关键词密度排序，最多返回 3 个。

    只在明确命中时返回——泛化匹配会让每个镜头都挂上音效，喧宾夺主反而更差。
    """
    text = _shot_text(shot)
    if not text.strip():
        return []
    scored: list[tuple[int, str]] = []
    for item in SFX_LIBRARY:
        score = 0
        for keyword in item["keywords"]:
            keyword = keyword.lower()
            if not keyword:
                continue
            if keyword in text:
                # 长关键词更可信：命中「爆炸」比命中「水」更能说明该配爆炸声。
                score += 1 + len(keyword) / 10.0
        if score > 0:
            scored.append((score, item["id"]))
    scored.sort(key=lambda pair: (-pair[0], pair[1]))
    return [sfx_id for _score, sfx_id in scored[:3]]


def match_sfx_for_shots(shots) -> dict:
    """整集匹配：{shotId: [sfxId, ...]}。"""
    result: dict[str, list[str]] = {}
    for shot in shots or []:
        if not isinstance(shot, dict):
            continue
        shot_id = str(shot.get("id") or "").strip()
        if not shot_id:
            continue
        matched = match_sfx_for_shot(shot)
        if matched:
            result[shot_id] = matched
    return result

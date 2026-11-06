"""星河制片台 · 本机 HTTP 服务。

只监听 127.0.0.1，负责三件事：
1. 托管 web/ 静态前端；
2. 代理模型调用（密钥留在本机，从不返回给浏览器）；
3. 本机媒体处理：抽帧、质检、合片、配音、字幕、封面、草稿导出。

API Key 的解析顺序：`.env.models.local` > 系统环境变量。前端永远只拿到
「有没有配」和指纹，拿不到密钥本身。

溯源标记 XHPD-2026-7f3c91a4d0e5b28c · Copyright (c) 2026 【你的名字】
源码可见，复制需授权，详见仓库根目录 LICENSE。
"""
from __future__ import annotations

import argparse
import base64
import difflib
import hashlib
import hmac
import ipaddress
import json
import mimetypes
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import uuid
import zipfile
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, unquote, urlparse
from urllib.request import Request, urlopen

import cv2
import numpy as np
import requests

import post_production as post
import inpainting as inpaint
import sfx_library as sfx

ROOT = Path(__file__).resolve().parent
# 星河制片台 · 独立版：前端静态站放在 web/，与后端同仓库同层，不再挂在
# 别的产品目录下。改这一行就够，其余落盘路径（.cache / deliveries）仍以 ROOT 为基准。
DEFAULT_WEB_ROOT = ROOT / "web"
PRODUCT_NAME = "星河制片台"
PRODUCT_VERSION = "2.0.0"
HEALTH_PATH = "/__workflow_health__"
MODEL_CONFIG_PATH = "/api/model-config"
WORKSPACE_SNAPSHOT_PATH = "/api/workspace-snapshot"
LOCAL_MEDIA_UPLOAD_PATH = "/api/local-media"
LOCAL_MEDIA_PREFIX = "/api/local-media/"
# 桌面壳内嵌的 QtWebEngine 是开源构建，不含 H.264/AAC 专有解码器：
# 模型产出的 mp4 在页面里会直接报 DEMUXER_ERROR_NO_SUPPORTED_STREAMS（黑屏、时长 0:00）。
# 因此为「界面预览」单独提供 VP9/Opus 的 WebM 缓存，交付与合片仍然使用原始 mp4。
LOCAL_PREVIEW_PREFIX = "/api/preview-media/"
DOWNLOAD_MEDIA_PREFIX = "/api/download-media/"
OPEN_MEDIA_PATH = "/api/open-media"
PREVIEW_MEDIA_SUFFIX = ".webm"
PREVIEW_SOURCE_SUFFIXES = {".mp4", ".mov", ".m4v"}
PREVIEW_TRANSCODE_TIMEOUT = 900
QC_MEDIA_PATH = "/api/qc-media"
QC_TURNAROUND_PATH = "/api/qc-turnaround"
SPLIT_GRID_PATH = "/api/split-grid"
RENDER_MASTER_PATH = "/api/render-master"
MODEL_TASK_PATH = "/api/model-task"
MODEL_TEST_PATH = "/api/model-test"
DASHSCOPE_UPLOAD_PATH = "/api/dashscope-upload"
# 后期包装（缺陷清单第三节的能力缺口）：配音 / 字幕 / 封面 / 剪映草稿。
# 合片仍走 /api/render-master，但带上 packaging 参数后会把声、字、转场、调色一起做掉。
TTS_PACKAGE_PATH = "/api/tts"
SUBTITLE_PACKAGE_PATH = "/api/subtitles"
COVER_PACKAGE_PATH = "/api/cover"
DRAFT_EXPORT_PATH = "/api/draft-export"
# 局部重绘：先裁选区（前端送去模型重绘），再把结果融合回原图。
INPAINT_PREPARE_PATH = "/api/inpaint/prepare"
INPAINT_MERGE_PATH = "/api/inpaint/merge"
# 音效库：列出可用的本地合成音效，并给出试听地址。
SFX_LIBRARY_PATH = "/api/sfx-library"
BUILTIN_BGM_NAME = "bgm.mp3"
MAX_TTS_LINES = 60
PROXY_PATHS = {"/api/media-proxy", "/__bb_proxy_media"}
MODEL_PROXY_PATH = "/api/model-proxy"
MAX_PROXY_URL = 4096
MAX_PROXY_BYTES = 256 * 1024 * 1024
# 万相图片接口允许 9 张参考图；每张 864×1536 PNG 转 base64 后可达 4–6MB，
# 9 张就会超过 16MB，表现为请求刚发出就被本机代理按 413/502 拒绝。
# 这是本机回环接口，不对外暴露，放宽到 96MB 足够覆盖 9 张全尺寸参考图。
MAX_MODEL_REQUEST_BYTES = 96 * 1024 * 1024
MAX_MODEL_RESPONSE_BYTES = 64 * 1024 * 1024
MAX_LOCAL_MEDIA_BYTES = 256 * 1024 * 1024

# 后台诊断日志：以前所有异常只打到 stdout，桌面端 pythonw 一旦没有控制台就彻底看不见，
# 用户只能看到「生成失败」却不知道错在哪。现在统一落盘，并可通过 /api/server-log 读取。
SERVER_LOG_PATH = "/api/server-log"
LOG_DIR = ROOT / ".cache" / "logs"
LOG_PATH = LOG_DIR / "director-server.log"
MAX_LOG_BYTES = 2 * 1024 * 1024
_LOG_LOCK = threading.Lock()
_WORKSPACE_SNAPSHOT_LOCK = threading.Lock()
# 客户端主动断开（刷新、热重载、切页面）不是后端错误，这类异常要静默。
DISCONNECT_ERRORS = (ConnectionAbortedError, ConnectionResetError, BrokenPipeError)


def _log_line(level: str, message: str) -> None:
    """Append one line to the backend log; never raise into a request."""
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        try:
            if LOG_PATH.stat().st_size > MAX_LOG_BYTES:
                LOG_PATH.replace(LOG_PATH.with_name(LOG_PATH.name + ".1"))
        except OSError:
            pass
        stamp = time.strftime("%Y-%m-%d %H:%M:%S")
        with _LOG_LOCK, LOG_PATH.open("a", encoding="utf-8") as handle:
            handle.write(f"{stamp} {level:<5} {message}\n")
    except OSError:
        pass


def _tail_log(limit: int) -> list[str]:
    try:
        with LOG_PATH.open("r", encoding="utf-8", errors="replace") as handle:
            return [line.rstrip("\n") for line in handle.readlines()[-limit:]]
    except OSError:
        return []

LOCAL_MEDIA_DIR = ROOT / ".cache" / "commercial-director-media"
_PREVIEW_LOCK = threading.Lock()
_ASR_MODEL = None
_ASR_LOCK = threading.Lock()
AGENT_PLAN_BASE_URL = "https://ark.cn-beijing.volces.com/api/plan/v3"
AGENT_PLAN_VIDEO_ENDPOINT = "/contents/generations/tasks"
AGENT_PLAN_VIDEO_MODELS = {
    "doubao-seedance-2.5",
    "doubao-seedance-2.0",
    "doubao-seedance-2.0-fast",
    "doubao-seedance-2.0-mini",
}
ZHIPU_VIDEO_BASE_URL = "https://open.bigmodel.cn/api/paas/v4"
ZHIPU_VIDEO_BASE_PATH = "/api/paas/v4"
ZHIPU_VIDEO_ENDPOINT = "/videos/generations"
ZHIPU_ASYNC_RESULT_URL = "https://open.bigmodel.cn/api/paas/v4/async-result/{task_id}"
ZHIPU_VIDEO_MODELS = {
    "cogvideox-flash",  # 官方定价页标注免费
    "cogvideox-2",
    "cogvideox-3",
}
ZHIPU_IMAGE_ENDPOINT = "/images/generations"
ZHIPU_IMAGE_MODELS = {
    "cogview-3-flash",  # 官方定价页标注免费
    "cogview-4-250304",
}
# 阿里百炼 · 万相：唯一支持「参考图锁角色」的图片通道，出图默认无水印。
DASHSCOPE_IMAGE_ENDPOINT = "/api/v1/services/aigc/multimodal-generation/generation"
DASHSCOPE_IMAGE_MODELS = {
    "wan2.7-image",
    "wan2.7-image-pro",
    "qwen-image-2.1-pro",
}
TENCENT_VIDEO_BASE_URL = "https://vclm.tencentcloudapi.com"
TENCENT_VIDEO_HOST = "vclm.tencentcloudapi.com"
TENCENT_VIDEO_ENDPOINT = "/"
TENCENT_VIDEO_ACTIONS = {"SubmitHunyuanToVideoJob", "DescribeHunyuanToVideoJob"}
TENCENT_VIDEO_VERSION = "2024-05-23"
TENCENT_VIDEO_REGION = "ap-guangzhou"
# 腾讯混元生图（3.0）：官方免费额度 50 次，支持最多 3 张参考图，可出 9:16 竖幅首帧。
TENCENT_IMAGE_BASE_URL = "https://aiart.tencentcloudapi.com"
TENCENT_IMAGE_HOST = "aiart.tencentcloudapi.com"
TENCENT_IMAGE_ACTIONS = {"SubmitTextToImageJob", "DescribeTextToImageJob"}
TENCENT_IMAGE_VERSION = "2022-12-29"
TENCENT_IMAGE_REGION = "ap-guangzhou"
OFFICIAL_MODEL_HOSTS = {
    "api.deepseek.com", "ark.cn-beijing.volces.com", "open.bigmodel.cn",
    "dashscope.aliyuncs.com", TENCENT_VIDEO_HOST, TENCENT_IMAGE_HOST,
}

MODEL_PROVIDER_DEFAULTS = {
    "chat": {
        "label": "对话模型",
        "baseUrl": "https://api.deepseek.com",
        "endpoint": "/chat/completions",
        "model": "deepseek-v4-flash",
    },
    "image": {
        "label": "图片模型",
        "baseUrl": "https://ark.cn-beijing.volces.com/api/v3",
        "endpoint": "/images/generations",
        "model": "doubao-seedream-5-0-flash-260915",
    },
    "video": {
        "label": "视频模型（火山 Agent Plan）",
        "baseUrl": AGENT_PLAN_BASE_URL,
        "endpoint": AGENT_PLAN_VIDEO_ENDPOINT,
        "model": "doubao-seedance-2.0",
        "imageToVideoModel": "doubao-seedance-2.0",
    },
}


def _read_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.is_file():
        return values
    for raw in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


_CREDENTIAL_INVISIBLE = str.maketrans("", "", "\u200b\u200c\u200d\ufeff\u00a0")
_KEY_ASCII_RE = re.compile(r"[!-~]{1,4096}")


def _clean_credential(value, label: str = "API Key") -> str:
    """Normalize a pasted credential and reject non-ASCII before it reaches a header.

    ``http.client`` encodes header values as latin-1; a key pasted with Chinese or
    full-width characters therefore dies deep inside urlopen with a latin-1 codec
    error. Fail early with an actionable message instead.
    """
    cleaned = str(value or "").translate(_CREDENTIAL_INVISIBLE)
    cleaned = cleaned.replace("\u3000", " ").strip()
    cleaned = cleaned.strip('"').strip("'").strip()
    if not cleaned:
        return ""
    if not _KEY_ASCII_RE.fullmatch(cleaned):
        raise ValueError(
            f"{label} 里混入了中文或全角字符（只接受英文字母、数字和符号，例如 sk-xxx）。"
            "请到控制台重新复制密钥，粘贴时不要带「Key：」之类的中文前缀或空格。"
        )
    return cleaned


def _user_environment_value(name: str) -> str:
    """Read one current-user environment variable when a GUI launch missed it."""
    value = os.environ.get(name, "").strip()
    if value or os.name != "nt":
        return value
    try:
        import winreg

        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as key:
            return str(winreg.QueryValueEx(key, name)[0]).strip()
    except OSError:
        return ""


def _persist_model_secrets(deepseek_key: str, ark_key: str, existing: dict[str, str]) -> None:
    if not deepseek_key and not ark_key:
        return
    desired = dict(existing)
    if deepseek_key:
        desired["DEEPSEEK_API_KEY"] = deepseek_key
    if ark_key:
        desired["ARK_API_KEY"] = ark_key
    if desired == existing:
        return
    path = ROOT / ".env.models.local"
    temporary = path.with_suffix(path.suffix + ".tmp")
    lines = [
        "# Local-only model credentials for Xinghe Commercial Director.",
        "# This file is ignored by source control and is never returned to the browser.",
        *(f"{key}={value}" for key, value in desired.items()),
        "",
    ]
    temporary.write_text("\n".join(lines), encoding="utf-8")
    temporary.replace(path)


def _load_model_secrets() -> dict[str, str]:
    """Load local credentials without exposing them to the browser.

    只认两个来源：项目内被 git 忽略的 ``.env.models.local``，以及系统环境变量。
    密钥从不返回给前端，前端只拿到「有没有配」和指纹。
    """
    local_values = _read_env_file(ROOT / ".env.models.local")

    # 优先级：本机 .env.models.local > 系统环境变量。
    # 之前是环境变量优先，结果这台机器上残留着一个更早的 DASHSCOPE_API_KEY（115 位），
    # 压过了用户刚写进文件里的那把（117 位）——文件里明明是有效的 Key，
    # 走服务端代理却一直返回 Arrearage/401，看起来像「额度没了」，实际是用了另一把 Key。
    # 用户显式写进项目文件的值，应当比机器上任何历史环境变量更可信。
    def _secret(name: str) -> str:
        return local_values.get(name, "").strip() or _user_environment_value(name)

    deepseek_key = _secret("DEEPSEEK_API_KEY")
    ark_key = _secret("ARK_API_KEY")

    # 独立版：不再去别的工程目录里翻历史密钥。旧版会顺着本机其它项目的
    # config/ai_config.json 与 .env.volcengine.local 兜底，那是开发者本机路径，
    # 对使用者毫无意义，还容易把「为什么没配 Key 也能出片」变成难查的隐式行为。
    # 现在只有两个来源：本仓库的 .env.models.local，或系统环境变量。
    try:
        _persist_model_secrets(deepseek_key, ark_key, local_values)
    except OSError:
        pass
    dashscope_key = _secret("DASHSCOPE_API_KEY")
    agent_plan_key = (
        local_values.get("AGENT_API_KEY", "").strip()
        or local_values.get("ARK_AGENT_API_KEY", "").strip()
        or _user_environment_value("AGENT_API_KEY")
        or _user_environment_value("ARK_AGENT_API_KEY")
    )
    zhipu_key = _secret("ZHIPU_API_KEY")
    tencent_secret_id = _secret("TENCENTCLOUD_SECRET_ID")
    tencent_secret_key = _secret("TENCENTCLOUD_SECRET_KEY")
    return {
        "chat": deepseek_key,
        "image": ark_key,
        "imageZhipu": zhipu_key,
        "imageDashscope": dashscope_key,
        "video": agent_plan_key,
        "videoAgentPlan": agent_plan_key,
        "videoDashscope": dashscope_key,
        "videoZhipu": zhipu_key,
        "videoTencentId": tencent_secret_id,
        "videoTencentKey": tencent_secret_key,
    }


def _secret_fingerprint(value: str) -> str:
    """Short stable digest so the page can tell "same key" from "stale key" without seeing it."""
    if not value:
        return ""
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:10]


def _server_secret_allowed(provider: str, base, endpoint: str) -> bool:
    if provider == "chat":
        return base.hostname == "api.deepseek.com" and endpoint in {"/chat/completions", "/v1/chat/completions"}
    if provider == "image":
        return (
            (base.hostname == "ark.cn-beijing.volces.com" and endpoint == "/images/generations")
            or (
                base.hostname == "open.bigmodel.cn"
                and base.path.rstrip("/") == ZHIPU_VIDEO_BASE_PATH
                and endpoint == ZHIPU_IMAGE_ENDPOINT
            )
            or (
                # 阿里百炼万相：唯一支持参考图锁角色的图片通道。
                (base.hostname == "dashscope.aliyuncs.com" or (base.hostname or "").endswith(".maas.aliyuncs.com"))
                and endpoint == DASHSCOPE_IMAGE_ENDPOINT
            )
        )
    if provider == "video":
        return (
            (base.hostname == "dashscope.aliyuncs.com" or (base.hostname or "").endswith(".maas.aliyuncs.com"))
            and endpoint == "/api/v1/services/aigc/video-generation/video-synthesis"
        ) or (
            base.hostname == "ark.cn-beijing.volces.com"
            and base.path.rstrip("/") == "/api/plan/v3"
            and endpoint == AGENT_PLAN_VIDEO_ENDPOINT
        ) or (
            # 智谱视频：图片与视频共用同一把本机 ZHIPU_API_KEY。
            base.hostname == "open.bigmodel.cn"
            and base.path.rstrip("/") == ZHIPU_VIDEO_BASE_PATH
            and endpoint == ZHIPU_VIDEO_ENDPOINT
        )
    return False


def _server_secret_for(provider: str, base) -> str:
    secrets = _load_model_secrets()
    if provider == "video" and base.hostname == "ark.cn-beijing.volces.com":
        return secrets.get("videoAgentPlan", "")
    if provider == "video" and (base.hostname == "dashscope.aliyuncs.com" or (base.hostname or "").endswith(".maas.aliyuncs.com")):
        return secrets.get("videoDashscope", "")
    if provider == "video" and base.hostname == "open.bigmodel.cn":
        return secrets.get("videoZhipu", "") or secrets.get("imageZhipu", "")
    if provider == "image" and base.hostname == "open.bigmodel.cn":
        return secrets.get("imageZhipu", "") or secrets.get("videoZhipu", "")
    if provider == "image" and (base.hostname == "dashscope.aliyuncs.com" or (base.hostname or "").endswith(".maas.aliyuncs.com")):
        return secrets.get("imageDashscope", "") or secrets.get("videoDashscope", "")
    return secrets.get(provider, "")


def _tencent_cloud_credentials(request: dict) -> tuple[str, str]:
    """Resolve Tencent Cloud's credential pair without ever returning it to the browser."""
    local = _load_model_secrets()
    secret_id = _clean_credential(request.get("credentialId"), "腾讯云 SecretId") or _clean_credential(
        local.get("videoTencentId"), "本机腾讯云 SecretId"
    )
    secret_key = _clean_credential(request.get("credentialKey"), "腾讯云 SecretKey") or _clean_credential(
        local.get("videoTencentKey"), "本机腾讯云 SecretKey"
    )
    if not secret_id or not secret_key:
        raise ValueError("腾讯云 SecretId 与 SecretKey 必须成对配置。")
    _reject_non_cam_tencent_credentials(secret_id, secret_key)
    return secret_id, secret_key


def _reject_non_cam_tencent_credentials(secret_id: str, secret_key: str) -> None:
    """Fail fast when the pair is a TokenHub key instead of a CAM key.

    混元生视频走 VCLM 云 API（vclm.tencentcloudapi.com），只认访问管理 CAM 的
    SecretId/SecretKey。TokenHub（大模型服务平台）的 API Key 形如 ak-xxx / sk-xxx，
    送进 VCLM 只会得到腾讯云一句「SecretId不存在」，用户完全无从判断哪里错了。
    在本地就把话说清楚，比等云端回一句废话有用得多。
    """
    if secret_id.lower().startswith("ak-") or secret_key.lower().startswith("sk-"):
        raise ValueError(
            "这看起来是 TokenHub（大模型服务平台）的 API Key（ak-/sk- 开头），不是腾讯云 CAM 密钥。"
            "混元生视频调用的是 VCLM 云 API，只认访问管理 CAM 的 SecretId/SecretKey。"
            "请到 https://console.cloud.tencent.com/cam/capi 新建密钥，"
            "复制那对 AKID 开头共 36 位的 SecretId 与 32 位 SecretKey。"
        )
    if not re.fullmatch(r"AKID[0-9A-Za-z]{32}", secret_id):
        raise ValueError(
            f"腾讯云 SecretId 格式不对：应为 AKID 开头共 36 位，当前 {len(secret_id)} 位。"
            "请到 https://console.cloud.tencent.com/cam/capi 重新复制，"
            "不要把 TokenHub 的 Key ID 或别的平台的密钥填进来。"
        )
    if not re.fullmatch(r"[0-9A-Za-z]{32}", secret_key):
        raise ValueError(
            f"腾讯云 SecretKey 格式不对：应为 32 位英文字母数字，当前 {len(secret_key)} 位。"
            "请到 https://console.cloud.tencent.com/cam/capi 重新复制完整密钥。"
        )


def _tencent_cloud_request(
    action: str,
    params: dict,
    secret_id: str,
    secret_key: str,
    *,
    host: str = TENCENT_VIDEO_HOST,
    service: str = "vclm",
    version: str = TENCENT_VIDEO_VERSION,
    region: str = TENCENT_VIDEO_REGION,
):
    """Call one allowlisted Tencent Cloud API 3.0 action using TC3-HMAC-SHA256."""
    if action not in (TENCENT_VIDEO_ACTIONS | TENCENT_IMAGE_ACTIONS):
        raise ValueError("Unsupported Tencent action.")
    if not isinstance(params, dict):
        raise ValueError("Tencent params must be a JSON object.")
    timestamp = int(time.time())
    date = datetime.fromtimestamp(timestamp, timezone.utc).strftime("%Y-%m-%d")
    content_type = "application/json; charset=utf-8"
    body = json.dumps(params, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    # 注意：只签 content-type 与 host 两个头，与腾讯官方 SDK 保持一致。
    # 曾把 x-tc-action 也签进去（TC3 文档示例的写法），但 vclm 端点会因此返回
    # AuthFailure.SignatureFailure——同样的密钥，官方 SDK 只签前两个头就能通过。
    canonical_headers = f"content-type:{content_type}\nhost:{host}\n"
    signed_headers = "content-type;host"
    canonical_request = "\n".join((
        "POST", "/", "", canonical_headers, signed_headers, hashlib.sha256(body).hexdigest()
    ))
    algorithm = "TC3-HMAC-SHA256"
    scope = f"{date}/{service}/tc3_request"
    string_to_sign = "\n".join((algorithm, str(timestamp), scope, hashlib.sha256(canonical_request.encode("utf-8")).hexdigest()))

    def sign(key: bytes, message: str) -> bytes:
        return hmac.new(key, message.encode("utf-8"), hashlib.sha256).digest()

    secret_date = sign(("TC3" + secret_key).encode("utf-8"), date)
    secret_service = sign(secret_date, service)
    secret_signing = sign(secret_service, "tc3_request")
    signature = hmac.new(secret_signing, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()
    authorization = (
        f"{algorithm} Credential={secret_id}/{scope}, "
        f"SignedHeaders={signed_headers}, Signature={signature}"
    )
    request = Request(
        f"https://{host}/",
        data=body,
        method="POST",
        headers={
            "Authorization": authorization,
            "Content-Type": content_type,
            "Host": host,
            "X-TC-Action": action,
            "X-TC-Timestamp": str(timestamp),
            "X-TC-Version": version,
            "X-TC-Region": region,
            "X-TC-Language": "zh-CN",
            "User-Agent": "XingheCommercialDirector/1.0",
        },
    )
    return urlopen(request, timeout=240)


def _is_public_host(hostname: str) -> bool:
    """Reject local/private targets so the browser proxy cannot become an SSRF hop."""
    if not hostname:
        return False
    if os.environ.get("DIRECTOR_ALLOW_PRIVATE_MEDIA") == "1":
        return True
    # Windows 上的 DNS 客户端偶尔会在网络切换或缓存刷新时短暂返回
    # WSAHOST_NOT_FOUND。以前这里一次失败就把正常的公网模型域名判成私网，
    # 前端只能看到误导性的 403。保留严格的 IP 检查，但给解析三个短重试。
    addresses = set()
    for attempt in range(3):
        try:
            addresses = {item[4][0] for item in socket.getaddrinfo(hostname, None)}
            break
        except OSError:
            if attempt == 2:
                return False
            time.sleep(0.05 * (attempt + 1))
    if not addresses:
        return False
    for value in addresses:
        try:
            address = ipaddress.ip_address(value)
        except ValueError:
            return False
        if not address.is_global:
            return False
    return True


# 模型服务返回的成片/成图地址都在自家对象存储上（万相在 *.oss-accelerate.aliyuncs.com，
# 火山在 *.tos-*.volces.com / *.byteimg.com，智谱在 *.bigmodel.cn）。
# 这些域名的 DNS 偶尔会返回多条记录，只要有一条落在保留段，_is_public_host 就整体判否，
# 表现为「刚出片就落盘失败，重试又好了」。对这几个官方后缀直接放行：
# 请求目标是模型自己给的地址，不是用户任意输入，放行它们不扩大 SSRF 面。
OFFICIAL_MEDIA_SUFFIXES = (
    ".aliyuncs.com",
    ".volces.com",
    ".volcvideo.com",
    ".bigmodel.cn",
    ".byteimg.com",
    ".myqcloud.com",
    # 腾讯混元/云点播返回的签名地址常见 *.tencentcos.cn、*.cos.*.myqcloud.com；
    # 旧白名单只认 myqcloud.com，导致“刚出片就落盘失败”。
    ".tencentcos.cn",
)


def _is_official_media_host(hostname: str) -> bool:
    host = (hostname or "").lower()
    return any(host == suffix.lstrip(".") or host.endswith(suffix) for suffix in OFFICIAL_MEDIA_SUFFIXES)


def _safe_media_name(name: str) -> str:
    candidate = Path(unquote(name)).name
    return candidate if re.fullmatch(r"[A-Za-z0-9._-]{1,180}", candidate or "") else ""


def _parse_byte_range(header: str, size: int) -> tuple[int, int] | None:
    """解析单区间 Range 头，返回闭区间 (start, end)。

    返回 None 表示按整文件回 200：多区间、越界或格式不认识都不该让播放器卡死。
    """
    if not header or size <= 0:
        return None
    match = re.fullmatch(r"bytes=\s*(\d*)\s*-\s*(\d*)", str(header).strip())
    if not match:
        return None
    start_text, end_text = match.groups()
    if not start_text and not end_text:
        return None
    if not start_text:
        length = int(end_text)
        if length <= 0:
            return None
        return max(0, size - length), size - 1
    start = int(start_text)
    if start >= size:
        return None
    end = int(end_text) if end_text else size - 1
    if end < start:
        return None
    return start, min(end, size - 1)


def _preview_target_name(source_name: str) -> str:
    """原始媒体名 → 预览缓存名（压平在 media 目录的 preview 子目录里）。"""
    stem = Path(source_name).stem
    return re.sub(r"[^A-Za-z0-9_-]+", "-", stem)[:80] + PREVIEW_MEDIA_SUFFIX


def _media_extension(content_type: str, payload: bytes) -> str:
    mime = (content_type or "").split(";", 1)[0].strip().lower()
    known = {
        "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp",
        "video/mp4": ".mp4", "video/webm": ".webm", "audio/wav": ".wav",
        "audio/mpeg": ".mp3", "audio/mp3": ".mp3", "audio/aac": ".m4a",
    }
    if mime in known:
        return known[mime]
    if payload.startswith(b"\x89PNG"):
        return ".png"
    if payload.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if payload[4:12] in {b"ftypisom", b"ftypmp42", b"ftypM4V "}:
        return ".mp4"
    if payload[:4] == b"PK\x03\x04":
        return ".zip"
    return ".bin"


def _probe_media(path: Path) -> dict:
    """合片与草稿都要真实时长/画幅：分镜里记的 duration 可能和成片对不上。"""
    ffprobe = shutil.which("ffprobe") or "ffprobe"
    result = subprocess.run(
        [ffprobe, "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=180,
    )
    if result.returncode != 0:
        raise ValueError(f"无法读取媒体信息：{path.name}")
    data = json.loads(result.stdout or "{}")
    streams = data.get("streams") or []
    video = next((item for item in streams if item.get("codec_type") == "video"
                  and not (item.get("disposition") or {}).get("attached_pic")), None)
    duration = 0.0
    if video and video.get("duration"):
        duration = float(video["duration"])
    if duration <= 0:
        duration = float((data.get("format") or {}).get("duration") or 0)
    return {
        "duration": round(duration, 3),
        "width": int(video.get("width") or 0) if video else 0,
        "height": int(video.get("height") or 0) if video else 0,
        "hasAudio": any(item.get("codec_type") == "audio" for item in streams),
    }


def _packaging_of(request: dict) -> dict:
    packaging = request.get("packaging")
    return packaging if isinstance(packaging, dict) else {}


def _packaging_number(packaging: dict, key: str, default: float, low: float, high: float) -> float:
    try:
        value = float(packaging.get(key, default))
    except (TypeError, ValueError):
        return default
    return max(low, min(high, value))


QC_CANONICAL_WIDTH = 960
# 电影暗调、浅景深和 720p 上采样的竖屏短剧，归一化拉普拉斯方差天然偏低；
# 25 会把大量正常画面判成“糊片”。18 才是真正需要拦截的失焦/糊片下限。
QC_SHARPNESS_MIN = 18.0
QC_SHARPNESS_WARN = 40.0
_FACE_DETECTOR: dict[str, object] = {}


def _canonical_frame(frame: np.ndarray) -> np.ndarray:
    """Normalise width so sharpness and texture metrics do not depend on resolution."""
    height, width = frame.shape[:2]
    if width <= QC_CANONICAL_WIDTH:
        return frame
    scale = QC_CANONICAL_WIDTH / float(width)
    return cv2.resize(frame, (QC_CANONICAL_WIDTH, max(1, int(round(height * scale)))), interpolation=cv2.INTER_AREA)


def _yunet_model_path() -> Path | None:
    for candidate in (
        ROOT / "vendor" / "models" / "face_detection_yunet_2023mar.onnx",
        ROOT / "assets" / "models" / "face_detection_yunet_2023mar.onnx",
        ROOT / ".cache" / "models" / "face_detection_yunet_2023mar.onnx",
    ):
        if candidate.is_file():
            return candidate
    return None


def _skin_tone_faces(frame: np.ndarray) -> list[tuple[int, int, int, int]]:
    """Last-resort face approximation used only when no detector is available.

    This is a colour-region heuristic, not a detector.  It never raises and the
    caller marks the result as low confidence so it cannot silently gate delivery.
    """
    ycrcb = cv2.cvtColor(frame, cv2.COLOR_BGR2YCrCb)
    luma, cr, cb = cv2.split(ycrcb)
    mask = (((cr >= 133) & (cr <= 173) & (cb >= 77) & (cb <= 127) & (luma >= 50)) * 255).astype(np.uint8)
    kernel_open = np.ones((3, 3), np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel_open)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
    total, _, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
    height, width = frame.shape[:2]
    boxes: list[tuple[int, int, int, int]] = []
    for index in range(1, total):
        x, y, box_w, box_h, area = (int(value) for value in stats[index])
        if area < width * height * .004 or box_h < height * .06:
            continue
        if not .5 <= box_w / max(1, box_h) <= 1.9:
            continue
        if area / max(1, box_w * box_h) < .45:
            continue
        boxes.append((x, y, box_w, box_h))
    return sorted(boxes, key=lambda item: item[2] * item[3], reverse=True)[:6]


def _face_detector() -> tuple[object, str, bool]:
    """Return ``(detect, name, reliable)`` for the strongest detector available.

    OpenCV 5 removed ``cv2.CascadeClassifier`` and the DNN detector needs an
    optional ONNX model, so detection degrades in layers instead of raising and
    callers always learn how much to trust the result.
    """
    cached = _FACE_DETECTOR.get("value")
    if cached is not None:
        return cached  # type: ignore[return-value]

    resolved: tuple[object, str, bool] = (_skin_tone_faces, "skin-tone heuristic (low confidence)", False)
    model_path = _yunet_model_path()
    factory = getattr(cv2, "FaceDetectorYN_create", None) or getattr(cv2, "FaceDetectorYN", None)
    if model_path is not None and callable(factory):
        def detect_yunet(frame: np.ndarray) -> list[tuple[int, int, int, int]]:
            height, width = frame.shape[:2]
            net = factory(str(model_path), "", (width, height), 0.6, 0.3, 5000)
            _, faces = net.detect(frame)
            boxes: list[tuple[int, int, int, int]] = []
            for face in (faces if faces is not None else []):
                x, y, box_w, box_h = (int(round(float(value))) for value in face[:4])
                if box_w >= 24 and box_h >= 24:
                    boxes.append((x, y, box_w, box_h))
            return boxes

        resolved = (detect_yunet, "YuNet DNN (OpenCV FaceDetectorYN)", True)
    elif hasattr(cv2, "CascadeClassifier"):
        cascades = Path(getattr(getattr(cv2, "data", None), "haarcascades", "") or "")
        model_file = cascades / "haarcascade_frontalface_default.xml"
        if model_file.is_file():
            cascade = cv2.CascadeClassifier(str(model_file))
            if not cascade.empty():
                def detect_haar(frame: np.ndarray) -> list[tuple[int, int, int, int]]:
                    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
                    faces = cascade.detectMultiScale(gray, scaleFactor=1.08, minNeighbors=4, minSize=(38, 38))
                    return [tuple(map(int, face)) for face in faces]

                resolved = (detect_haar, "Haar cascade (OpenCV CascadeClassifier)", True)
    _FACE_DETECTOR["value"] = resolved
    return resolved


def _detect_faces(frame: np.ndarray) -> list[tuple[int, int, int, int]]:
    detect, _, _ = _face_detector()
    try:
        return detect(frame)  # type: ignore[operator]
    except (cv2.error, ValueError, AttributeError):
        return []


def _face_crop(frame: np.ndarray, face: tuple[int, int, int, int]) -> np.ndarray:
    x, y, width, height = face
    pad_x, pad_y = int(width * .18), int(height * .18)
    return frame[max(0, y - pad_y):min(frame.shape[0], y + height + pad_y), max(0, x - pad_x):min(frame.shape[1], x + width + pad_x)]


def _visual_identity_score(reference: np.ndarray, candidate: np.ndarray) -> float:
    """Low-cost visual heuristic, not biometric face recognition."""
    if reference.size == 0 or candidate.size == 0:
        return 0.0
    reference = cv2.resize(reference, (128, 128), interpolation=cv2.INTER_AREA)
    candidate = cv2.resize(candidate, (128, 128), interpolation=cv2.INTER_AREA)
    ref_hsv = cv2.cvtColor(reference, cv2.COLOR_BGR2HSV)
    cand_hsv = cv2.cvtColor(candidate, cv2.COLOR_BGR2HSV)
    ref_hist = cv2.calcHist([ref_hsv], [0, 1], None, [32, 32], [0, 180, 0, 256])
    cand_hist = cv2.calcHist([cand_hsv], [0, 1], None, [32, 32], [0, 180, 0, 256])
    cv2.normalize(ref_hist, ref_hist)
    cv2.normalize(cand_hist, cand_hist)
    hist_score = max(0.0, 1.0 - float(cv2.compareHist(ref_hist, cand_hist, cv2.HISTCMP_BHATTACHARYYA)))
    ref_gray = cv2.cvtColor(reference, cv2.COLOR_BGR2GRAY)
    cand_gray = cv2.cvtColor(candidate, cv2.COLOR_BGR2GRAY)
    ref_gray = cv2.equalizeHist(ref_gray)
    cand_gray = cv2.equalizeHist(cand_gray)
    correlation = float(np.corrcoef(ref_gray.flatten(), cand_gray.flatten())[0, 1])
    if not np.isfinite(correlation):
        correlation = 0.0
    structure_score = max(0.0, min(1.0, (correlation + 1.0) / 2.0))
    return round(hist_score * .62 + structure_score * .38, 4)


def _in_subtitle_band(center_y: float, height: int) -> bool:
    """字幕带的先验位置：底部（多数短剧）或居中下三分之一（部分平台样式）。"""
    if height <= 0:
        return False
    ratio = float(center_y) / float(height)
    return (0.60 <= ratio <= 0.96) or (0.26 <= ratio <= 0.44)


def _text_artifact_score(frame: np.ndarray) -> dict:
    """Detect hardcoded subtitle-like text lines instead of generic texture.

    The previous implementation counted every elongated edge blob, so ordinary
    cinematic footage always scored 1.0 and the gate rejected every real clip.
    Baked-in subtitles instead form rows of uniform-height glyph boxes with
    tight, regular gaps, so only such rows count as evidence.
    """
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    gradient = cv2.morphologyEx(gray, cv2.MORPH_GRADIENT, cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3)))
    _, binary = cv2.threshold(gradient, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)
    joined = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (9, 3)))
    contours, _ = cv2.findContours(joined, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    height, width = gray.shape
    boxes: list[tuple[int, int, int, int]] = []
    for contour in contours:
        x, y, box_w, box_h = cv2.boundingRect(contour)
        area = box_w * box_h
        if not 1.2 <= box_w / max(1, box_h) <= 20:
            continue
        if not 8 <= box_h <= max(24, height * .14):
            continue
        if not 40 <= area <= width * height * .05:
            continue
        boxes.append((x, y, box_w, box_h))

    rows: list[dict] = []
    for box in sorted(boxes, key=lambda item: item[1]):
        x, y, box_w, box_h = box
        center = y + box_h / 2
        for row in rows:
            if abs(row["center"] - center) <= max(6, .5 * max(box_h, row["height"])):
                row["boxes"].append(box)
                row["height"] = (row["height"] + box_h) / 2
                row["center"] = (row["center"] + center) / 2
                break
        else:
            rows.append({"center": center, "height": box_h, "boxes": [box]})

    strong_rows = 0
    weak_rows = 0
    for row in rows:
        members = row["boxes"]
        heights = [item[3] for item in members]
        consistency = max(heights) / max(1, min(heights))
        left = min(item[0] for item in members)
        right = max(item[0] + item[2] for item in members)
        span = right - left
        fill = sum(item[2] for item in members) / max(1, span)
        # 硬字幕只在底部字幕带（或居中下三分之一）出现；沙发缝、桌沿、血迹、发丝
        # 这些横向纹理则散布全屏。之前不判位置，「1 行强证据 + 9 行弱证据」把一条
        # 干净的成片判成带字幕，现在只认字幕带内的行，弱行还要求横跨足够宽度。
        if not _in_subtitle_band(row["center"], height):
            continue
        if len(members) >= 3 and consistency <= 1.4 and span >= .22 * width and .3 <= fill <= .92:
            strong_rows += 1
        elif len(members) >= 2 and span >= .12 * width:
            weak_rows += 1
    score = min(1.0, strong_rows * .62 + min(weak_rows, 3) * .1)
    return {
        "score": round(score, 4), "strongRows": strong_rows, "weakRows": weak_rows,
        "candidateBoxes": len(boxes), "rowCount": len(rows),
        "subtitleLike": _is_text_artifact(strong_rows, weak_rows),
    }


def _is_text_artifact(strong_rows: int, weak_rows: int) -> bool:
    """Two-line subtitle evidence in either segmentation shape.

    单行证据一律只算警告：字幕带上也会出现桌沿、踢脚线、沙发缝这类横线；
    要判成「画面里烧了字幕」，要么两行整齐的强证据，要么一行强证据加上
    至少两行弱证据（把一整句字幕拆成多段的情形）。
    """
    return strong_rows >= 2 or (strong_rows >= 1 and weak_rows >= 2)


def _frame_quality(frame: np.ndarray, analysis: np.ndarray | None = None) -> dict:
    """Scene metrics on a resolution-normalised copy; native size is reported separately."""
    analysis = _canonical_frame(frame) if analysis is None else analysis
    gray = cv2.cvtColor(analysis, cv2.COLOR_BGR2GRAY)
    text = _text_artifact_score(analysis)
    return {
        "width": int(frame.shape[1]), "height": int(frame.shape[0]),
        "analysisWidth": int(analysis.shape[1]), "analysisHeight": int(analysis.shape[0]),
        "blur": round(float(cv2.Laplacian(gray, cv2.CV_64F).var()), 2),
        "blackRatio": round(float(np.mean(gray < 12)), 4),
        "faces": _detect_faces(analysis),
        "textLikeScore": text["score"], "strongTextRows": text["strongRows"],
        "weakTextRows": text["weakRows"], "textArtifact": text["subtitleLike"],
    }


def _probe_audio(path: Path) -> bool:
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_type", "-of", "csv=p=0", str(path)],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=20, check=False,
        )
        return result.returncode == 0 and "audio" in result.stdout.lower()
    except (OSError, subprocess.TimeoutExpired):
        return False


def _normalize_dialogue(text: str) -> str:
    return re.sub(r"[^\w\u4e00-\u9fff]+", "", str(text or "").lower(), flags=re.UNICODE)


def _dialogue_similarity(expected: str, actual: str) -> float:
    expected_clean, actual_clean = _normalize_dialogue(expected), _normalize_dialogue(actual)
    if not expected_clean:
        return 1.0
    if not actual_clean:
        return 0.0
    if expected_clean in actual_clean:
        return round(min(1.0, len(expected_clean) / max(len(expected_clean), len(actual_clean)) + .25), 4)
    return round(difflib.SequenceMatcher(None, expected_clean, actual_clean).ratio(), 4)


def _transcribe_local(path: Path) -> tuple[str, str]:
    """Transcribe locally when the bundled faster-whisper model is available."""
    global _ASR_MODEL
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        return "", "faster-whisper unavailable"
    model_path = ROOT / "vendor" / "models" / "faster-whisper-small"
    if not model_path.is_dir():
        return "", "local ASR model unavailable"
    try:
        with _ASR_LOCK:
            if _ASR_MODEL is None:
                _ASR_MODEL = WhisperModel(str(model_path), device="cpu", compute_type="int8", local_files_only=True)
            segments, _ = _ASR_MODEL.transcribe(str(path), language="zh", vad_filter=True, beam_size=3)
            text = "".join(segment.text for segment in segments).strip()
        return text, "faster-whisper-small local int8"
    except Exception as error:  # model/runtime failures are reported as QC evidence
        return "", f"ASR failed: {error}"


class DirectorHandler(SimpleHTTPRequestHandler):
    server_version = "AutomationWorkflowDirector/1.0"
    _last_status = 0

    def __init__(self, *args, directory=None, **kwargs):
        self._cache_control_sent = False
        super().__init__(*args, directory=directory, **kwargs)

    def send_response(self, code, message=None):
        # 静态文件走 SimpleHTTPRequestHandler 自己发状态行，这里统一记下来，
        # 否则访问日志会把每个成功的静态请求误写成「连接已断开」。
        self._last_status = int(code)
        return super().send_response(code, message)

    def send_header(self, keyword, value):
        if keyword.lower() == "cache-control":
            self._cache_control_sent = True
        super().send_header(keyword, value)

    def end_headers(self):
        # 本地静态资源不缓存，避免更新后 WebEngine 仍显示旧页面
        if not self._cache_control_sent:
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        # ``pythonw`` can expose a missing or already-closed stdout stream.  A
        # request must never fail merely because the desktop shell cannot show
        # the access log.
        try:
            if sys.stdout is not None:
                sys.stdout.write("[director] " + (fmt % args) + "\n")
                sys.stdout.flush()
        except (AttributeError, OSError, ValueError):
            pass

    def _json(self, status: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._last_status = status
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
        except DISCONNECT_ERRORS:
            # 浏览器刷新、页面重载或切换视图都会中途掐断连接；这既不是 bug，
            # 也会让质检/生成结果莫名丢失。静默收尾，交给客户端自己重试。
            self.close_connection = True

    def _raw_bytes(self, status: int, body: bytes, content_type: str = ""):
        """Forward an upstream response verbatim, tolerating client disconnects."""
        self._last_status = status
        try:
            self.send_response(status)
            self.send_header("Content-Type", content_type or "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)
        except DISCONNECT_ERRORS:
            self.close_connection = True

    def do_OPTIONS(self):
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Range, Content-Type")
        self.end_headers()

    def do_GET(self):
        self._dispatch("GET", self._handle_get)

    def do_POST(self):
        self._dispatch("POST", self._handle_post)

    def _dispatch(self, method: str, runner):
        """Run one request, turning any unexpected failure into a logged 500 instead of a dropped socket."""
        started = time.time()
        self._last_status = 0
        try:
            runner()
        except DISCONNECT_ERRORS:
            _log_line("INFO", f"{method} {self.path} 客户端提前断开（刷新/重载），已忽略")
            self.close_connection = True
        except Exception as error:  # 兜底：绝不让连接被无声吞掉
            _log_line("ERROR", f"{method} {self.path} 未捕获异常：{type(error).__name__}: {error}\n{traceback.format_exc()}")
            try:
                self._json(HTTPStatus.INTERNAL_SERVER_ERROR, {
                    "error": "Backend exception.",
                    "detail": f"{type(error).__name__}: {error}",
                    "log": str(LOG_PATH),
                })
            except Exception:
                self.close_connection = True
        finally:
            elapsed = int((time.time() - started) * 1000)
            if self._last_status >= 400 or self._last_status == 0 or elapsed >= 1500:
                _log_line("INFO", f"{method} {self.path} → {self._last_status or '连接已断开'} ({elapsed} ms)")

    def _handle_post(self):
        parsed = urlparse(self.path)
        if parsed.path == WORKSPACE_SNAPSHOT_PATH:
            self._save_workspace_snapshot()
            return
        if parsed.path == MODEL_PROXY_PATH:
            self._proxy_model_request()
            return
        if parsed.path == LOCAL_MEDIA_UPLOAD_PATH:
            self._save_local_media()
            return
        if parsed.path == OPEN_MEDIA_PATH:
            self._open_local_media()
            return
        if parsed.path == QC_MEDIA_PATH:
            self._quality_control_media()
            return
        if parsed.path == QC_TURNAROUND_PATH:
            self._quality_control_turnaround()
            return
        if parsed.path == SPLIT_GRID_PATH:
            self._split_storyboard_grid()
            return
        if parsed.path == RENDER_MASTER_PATH:
            self._render_master_video()
            return
        if parsed.path == MODEL_TASK_PATH:
            self._query_model_task()
            return
        if parsed.path == MODEL_TEST_PATH:
            self._test_model_provider()
            return
        if parsed.path == DASHSCOPE_UPLOAD_PATH:
            self._upload_dashscope_media()
            return
        if parsed.path == TTS_PACKAGE_PATH:
            self._package_tts()
            return
        if parsed.path == SUBTITLE_PACKAGE_PATH:
            self._package_subtitles()
            return
        if parsed.path == COVER_PACKAGE_PATH:
            self._package_cover()
            return
        if parsed.path == DRAFT_EXPORT_PATH:
            self._export_draft()
            return
        if parsed.path == INPAINT_PREPARE_PATH:
            self._inpaint_prepare()
            return
        if parsed.path == INPAINT_MERGE_PATH:
            self._inpaint_merge()
            return
        self._json(HTTPStatus.NOT_FOUND, {"error": "Unknown endpoint."})

    def _save_workspace_snapshot(self):
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            content_length = 0
        if content_length <= 0 or content_length > 8 * 1024 * 1024:
            self._json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "Invalid workspace snapshot size."})
            return
        try:
            payload = json.loads(self.rfile.read(content_length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._json(HTTPStatus.BAD_REQUEST, {"error": "Invalid workspace snapshot JSON."})
            return
        state = payload.get("state") if isinstance(payload, dict) else None
        if not isinstance(state, dict) or not isinstance(state.get("projects"), list):
            self._json(HTTPStatus.BAD_REQUEST, {"error": "Invalid workspace state."})
            return
        snapshot = ROOT / ".cache" / "commercial-director-workspace.json"
        snapshot.parent.mkdir(parents=True, exist_ok=True)
        with _WORKSPACE_SNAPSHOT_LOCK:
            try:
                current = json.loads(snapshot.read_text(encoding="utf-8"))
                current_revision = int(current.get("externalRevision") or 0)
            except (OSError, UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError):
                current_revision = 0
            try:
                incoming_revision = int(state.get("externalRevision") or 0)
            except (TypeError, ValueError):
                incoming_revision = 0
            # 多个桌面/浏览器窗口可能同时打开。旧窗口不能用过期快照覆盖正在生成的
            # 任务 ID 和媒体地址，否则会造成“台账消失”并诱发重复提交计费。
            if incoming_revision < current_revision:
                self._json(HTTPStatus.CONFLICT, {
                    "error": "Workspace snapshot is stale.",
                    "currentRevision": current_revision,
                })
                return
            revision = current_revision + 1
            state["externalRevision"] = revision
            temporary = snapshot.with_suffix(snapshot.suffix + ".tmp")
            temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            temporary.replace(snapshot)
        self._json(HTTPStatus.OK, {"saved": True, "projects": len(state["projects"]), "revision": revision})

    def _handle_get(self):
        parsed = urlparse(self.path)
        if parsed.path == HEALTH_PATH:
            self._json(HTTPStatus.OK, {
                "service": "xinghe-production-desk",
                "status": "ok",
                # 本仓库新增部分为「源码可见、复制需授权」；同时包含上游 MIT 代码，
                # 上游部分仍按 MIT 授权，见 LICENSES/AI-Drama-Pipeline-MIT.txt。
                "license": "Source-Available (additions) / MIT (upstream)",
                "upstream_license": "MIT",
                "version": PRODUCT_VERSION,
            })
            return
        if parsed.path == SERVER_LOG_PATH:
            query = parse_qs(parsed.query)
            try:
                tail = int((query.get("tail") or ["200"])[0])
            except ValueError:
                tail = 200
            tail = max(1, min(2000, tail))
            self._json(HTTPStatus.OK, {
                "path": str(LOG_PATH),
                "python": sys.executable,
                "lines": _tail_log(tail),
            })
            return
        if parsed.path == MODEL_CONFIG_PATH:
            secrets = _load_model_secrets()
            self._json(HTTPStatus.OK, {
                "providers": MODEL_PROVIDER_DEFAULTS,
                "localSecrets": {
                    name: bool(secrets.get(name))
                    for name in ("chat", "image", "imageZhipu", "imageDashscope", "video", "videoZhipu", "videoDashscope", "videoTencentId", "videoTencentKey")
                },
                # 只给出指纹，页面据此判断浏览器里存的是不是同一把 Key；密钥本身从不出站到前端。
                "localSecretFingerprints": {
                    name: _secret_fingerprint(secrets.get(name, ""))
                    for name in ("chat", "image", "imageZhipu", "imageDashscope", "video", "videoZhipu", "videoDashscope", "videoTencentId", "videoTencentKey")
                },
            })
            return
        if parsed.path == WORKSPACE_SNAPSHOT_PATH:
            snapshot = ROOT / ".cache" / "commercial-director-workspace.json"
            try:
                state = json.loads(snapshot.read_text(encoding="utf-8"))
            except (OSError, UnicodeDecodeError, json.JSONDecodeError):
                self._json(HTTPStatus.NOT_FOUND, {"error": "No workspace snapshot."})
                return
            self._json(HTTPStatus.OK, {"state": state})
            return
        if parsed.path == SFX_LIBRARY_PATH:
            self._list_sfx_library()
            return
        if parsed.path in PROXY_PATHS:
            self._proxy_media(parsed.query)
            return
        if parsed.path.startswith(DOWNLOAD_MEDIA_PREFIX):
            self._serve_media_download(parsed.path, head_only=False)
            return
        if parsed.path.startswith(LOCAL_MEDIA_PREFIX):
            self._serve_local_media(parsed.path, head_only=False)
            return
        if parsed.path.startswith(LOCAL_PREVIEW_PREFIX):
            self._serve_preview_media(parsed.path, head_only=False)
            return
        self._serve_static(parsed.path)

    def do_HEAD(self):
        parsed = urlparse(self.path)
        if parsed.path == HEALTH_PATH:
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            return
        if parsed.path.startswith(DOWNLOAD_MEDIA_PREFIX):
            self._serve_media_download(parsed.path, head_only=True)
            return
        if parsed.path.startswith(LOCAL_MEDIA_PREFIX):
            self._serve_local_media(parsed.path, head_only=True)
            return
        if parsed.path.startswith(LOCAL_PREVIEW_PREFIX):
            self._serve_preview_media(parsed.path, head_only=True)
            return
        self._serve_static(parsed.path, head_only=True)

    def end_headers(self):
        # 前端资源每次都必须回源校验：QtWebEngine 的磁盘缓存没有 Cache-Control 时会
        # 按「启发式新鲜度」长期复用旧 app.js/styles.css，导致界面看起来没更新。
        if getattr(self, "_force_revalidate", False):
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")
        super().end_headers()

    def _serve_static(self, request_path: str, head_only: bool = False):
        decoded = unquote(request_path)
        candidate = Path(self.translate_path(decoded))
        if decoded != "/" and not candidate.exists() and "." not in Path(decoded).name:
            self.path = "/index.html"
        else:
            self.path = request_path
        self._force_revalidate = True
        if head_only:
            handle = self.send_head()
            if handle:
                handle.close()
        else:
            super().do_GET()

    def _proxy_media(self, query: str):
        raw_url = parse_qs(query).get("url", [""])[0].strip()
        if not raw_url or len(raw_url) > MAX_PROXY_URL:
            self._json(HTTPStatus.BAD_REQUEST, {"error": "Invalid media URL."})
            return
        target = urlparse(raw_url)
        if target.scheme not in {"http", "https"} or not _is_public_host(target.hostname or ""):
            self._json(HTTPStatus.FORBIDDEN, {"error": "Only public http/https media URLs are allowed."})
            return
        headers = {"User-Agent": "AutomationWorkflowDirector/1.0"}
        if self.headers.get("Range"):
            headers["Range"] = self.headers["Range"]
        try:
            with urlopen(Request(raw_url, headers=headers), timeout=120) as upstream:
                length = upstream.headers.get("Content-Length")
                if length and int(length) > MAX_PROXY_BYTES:
                    self._json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "Remote media is too large."})
                    return
                self.send_response(getattr(upstream, "status", HTTPStatus.OK))
                for key in ("Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "Cache-Control", "ETag", "Last-Modified"):
                    value = upstream.headers.get(key)
                    if value:
                        self.send_header(key, value)
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                total = 0
                while True:
                    chunk = upstream.read(64 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > MAX_PROXY_BYTES:
                        break
                    self.wfile.write(chunk)
        except HTTPError as error:
            self._json(error.code, {"error": "Remote media request failed.", "detail": str(error.reason)})
        except (URLError, TimeoutError, OSError) as error:
            self._json(HTTPStatus.BAD_GATEWAY, {"error": "Media proxy failed.", "detail": str(error)})

    def _read_json_body(self, maximum: int = MAX_MODEL_REQUEST_BYTES):
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            content_length = 0
        if content_length <= 0 or content_length > maximum:
            raise ValueError("Invalid request size.")
        try:
            return json.loads(self.rfile.read(content_length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ValueError("Invalid JSON request.") from error

    def _source_bytes(self, source: str) -> tuple[bytes, str]:
        value = str(source or "").strip()
        # 字段名传错时（例如把 mediaUrl 写成 imageUrl）以前会落到「只支持本地缓存或公网 HTTPS」，
        # 让人误以为是网络或存储问题。这里先把「根本没给地址」单独区分开。
        if not value:
            raise ValueError("缺少媒体地址：请在请求体里用 mediaUrl 传本地缓存图（field name is mediaUrl, not imageUrl/url）。")
        if value.startswith("data:"):
            header, separator, encoded = value.partition(",")
            if not separator or ";base64" not in header:
                raise ValueError("Only base64 data URLs are supported.")
            payload = base64.b64decode(encoded, validate=True)
            return payload, header[5:].split(";", 1)[0]
        parsed = urlparse(value)
        if parsed.path.startswith(LOCAL_MEDIA_PREFIX):
            name = _safe_media_name(parsed.path[len(LOCAL_MEDIA_PREFIX):])
            path = LOCAL_MEDIA_DIR / name
            if not name or not path.is_file():
                raise ValueError("Local media was not found.")
            return path.read_bytes(), mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        if parsed.scheme not in {"http", "https"}:
            raise ValueError(f"媒体地址协议不支持（{parsed.scheme or '空'}）：只接受本地缓存、base64 或 https。")
        hostname = parsed.hostname or ""
        if not (_is_official_media_host(hostname) or _is_public_host(hostname)):
            raise ValueError(
                f"媒体地址不可用：{hostname or '(无域名)'} 既不是本地缓存，也不是模型官方 CDN 或公网 HTTPS 地址。"
            )
        with urlopen(Request(value, headers={"User-Agent": "XingheCommercialDirector/1.0"}), timeout=180) as upstream:
            content_type = upstream.headers.get("Content-Type", "application/octet-stream")
            payload = upstream.read(MAX_LOCAL_MEDIA_BYTES + 1)
        if len(payload) > MAX_LOCAL_MEDIA_BYTES:
            raise ValueError("Remote media is too large.")
        return payload, content_type

    def _store_media_bytes(self, payload: bytes, content_type: str, stem: str = "media") -> tuple[Path, str]:
        if not payload or len(payload) > MAX_LOCAL_MEDIA_BYTES:
            raise ValueError("Invalid media payload.")
        extension = _media_extension(content_type, payload)
        if extension == ".bin":
            raise ValueError("Unsupported media type.")
        LOCAL_MEDIA_DIR.mkdir(parents=True, exist_ok=True)
        name = f"{re.sub(r'[^A-Za-z0-9_-]+', '-', stem)[:48]}-{uuid.uuid4().hex[:12]}{extension}"
        path = LOCAL_MEDIA_DIR / name
        temporary = path.with_suffix(path.suffix + ".tmp")
        temporary.write_bytes(payload)
        temporary.replace(path)
        return path, LOCAL_MEDIA_PREFIX + name

    def _serve_local_media(self, request_path: str, head_only: bool = False):
        name = _safe_media_name(request_path[len(LOCAL_MEDIA_PREFIX):])
        path = LOCAL_MEDIA_DIR / name
        if not name or not path.is_file():
            self._json(HTTPStatus.NOT_FOUND, {"error": "Local media was not found."})
            return
        self._serve_media_file(path, head_only=head_only)

    def _serve_media_download(self, request_path: str, head_only: bool = False):
        """下载通道：回原始 mp4（不是预览转码），带 attachment 头让浏览器直接落盘。"""
        name = _safe_media_name(request_path[len(DOWNLOAD_MEDIA_PREFIX):])
        path = LOCAL_MEDIA_DIR / name
        if not name or not path.is_file():
            self._json(HTTPStatus.NOT_FOUND, {"error": "Local media was not found."})
            return
        self._serve_media_file(path, head_only=head_only, disposition="attachment")

    def _serve_media_file(self, path: Path, head_only: bool = False, content_type: str = "",
                          disposition: str = ""):
        size = path.stat().st_size
        mime = content_type or mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        if path.suffix.lower() == ".webm":
            mime = "video/webm"
        byte_range = _parse_byte_range(self.headers.get("Range", ""), size)
        partial = byte_range is not None
        start, end = byte_range if partial else (0, max(0, size - 1))
        length = (end - start + 1) if size else 0
        self.send_response(HTTPStatus.PARTIAL_CONTENT if partial else HTTPStatus.OK)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        if partial:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        if disposition:
            # 文件名由 _safe_media_name 过滤为 A-Za-z0-9._-，可直接放进 quoted-string。
            self.send_header("Content-Disposition", f'{disposition}; filename="{path.name}"')
            self.send_header("Cache-Control", "no-store")
        else:
            self.send_header("Cache-Control", "private, max-age=31536000, immutable")
        self.end_headers()
        if head_only or length <= 0:
            return
        with path.open("rb") as handle:
            handle.seek(start)
            remaining = length
            while remaining > 0:
                chunk = handle.read(min(256 * 1024, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    def _serve_preview_media(self, request_path: str, head_only: bool = False):
        """界面预览通道：把 mp4 按需转成 WebM(VP9/Opus) 并缓存，供不支持的播放器使用。"""
        source_name = _safe_media_name(request_path[len(LOCAL_PREVIEW_PREFIX):])
        source = LOCAL_MEDIA_DIR / source_name
        if not source_name or not source.is_file():
            self._json(HTTPStatus.NOT_FOUND, {"error": "Preview source was not found."})
            return
        if source.suffix.lower() == ".webm":
            self._serve_media_file(source, head_only=head_only, content_type="video/webm")
            return
        if source.suffix.lower() not in PREVIEW_SOURCE_SUFFIXES:
            self._json(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, {"error": "Preview supports mp4/mov/m4v only."})
            return
        target = LOCAL_MEDIA_DIR / "preview" / _preview_target_name(source_name)
        if not target.is_file() or target.stat().st_size == 0:
            try:
                self._transcode_preview(source, target)
            except (OSError, subprocess.SubprocessError, ValueError) as error:
                self._json(HTTPStatus.SERVICE_UNAVAILABLE, {
                    "error": "Preview transcoding failed.",
                    "detail": str(error)[:400],
                })
                return
        self._serve_media_file(target, head_only=head_only, content_type="video/webm")

    def _transcode_preview(self, source: Path, target: Path):
        """同一文件只转一次；并发请求在锁内二次确认缓存。"""
        with _PREVIEW_LOCK:
            if target.is_file() and target.stat().st_size > 0:
                return
            ffmpeg = shutil.which("ffmpeg")
            if not ffmpeg:
                raise ValueError("ffmpeg is unavailable.")
            target.parent.mkdir(parents=True, exist_ok=True)
            temporary = target.with_suffix(".tmp.webm")
            command = [
                ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
                "-i", str(source),
                "-c:v", "libvpx-vp9", "-crf", "34", "-b:v", "0",
                "-row-mt", "1", "-deadline", "realtime", "-cpu-used", "5",
                "-pix_fmt", "yuv420p",
                "-c:a", "libopus", "-b:a", "96k", "-ac", "2",
                "-f", "webm", str(temporary),
            ]
            completed = subprocess.run(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=PREVIEW_TRANSCODE_TIMEOUT,
            )
            if completed.returncode != 0 or not temporary.is_file():
                detail = completed.stderr.decode("utf-8", "replace").strip()[-400:]
                temporary.unlink(missing_ok=True)
                raise ValueError(detail or "ffmpeg exited with a non-zero code.")
            temporary.replace(target)

    def _open_local_media(self):
        """兜底通道：内嵌浏览器解不了时，交给系统默认播放器打开同一份本地文件。"""
        try:
            request = self._read_json_body()
            name = _safe_media_name(urlparse(str(request.get("url") or "")).path.split("/")[-1])
            path = (LOCAL_MEDIA_DIR / name).resolve()
            if not name or LOCAL_MEDIA_DIR.resolve() not in path.parents or not path.is_file():
                raise ValueError("Only local media files inside the cache directory can be opened.")
            if sys.platform.startswith("win"):
                os.startfile(str(path))  # noqa: S606 - 用户显式点击，打开自己的本地素材
            elif sys.platform == "darwin":
                subprocess.Popen(["open", str(path)])
            else:
                subprocess.Popen(["xdg-open", str(path)])
            self._json(HTTPStatus.OK, {"opened": path.name})
        except (ValueError, OSError) as error:
            self._json(HTTPStatus.BAD_REQUEST, {"error": "Open media failed.", "detail": str(error)})

    def _save_local_media(self):
        try:
            request = self._read_json_body(MAX_LOCAL_MEDIA_BYTES * 2)
            source = request.get("dataUrl") or request.get("sourceUrl")
            payload, content_type = self._source_bytes(source)
            path, url = self._store_media_bytes(payload, content_type, str(request.get("name") or "reference"))
            self._json(HTTPStatus.OK, {"url": url, "name": path.name, "bytes": path.stat().st_size})
        except (ValueError, HTTPError, URLError, TimeoutError, OSError) as error:
            self._json(HTTPStatus.BAD_REQUEST, {"error": "Local media save failed.", "detail": str(error)})

    def _quality_control_media(self):
        try:
            request = self._read_json_body()
            payload, content_type = self._source_bytes(request.get("mediaUrl"))
            media_path, cached_url = self._store_media_bytes(payload, content_type, "qc-source")
            extension = media_path.suffix.lower()
            frames: list[np.ndarray] = []
            if extension in {".png", ".jpg", ".jpeg", ".webp"}:
                frame = cv2.imdecode(np.frombuffer(payload, np.uint8), cv2.IMREAD_COLOR)
                if frame is None:
                    raise ValueError("Image decoding failed.")
                frames = [frame]
            else:
                capture = cv2.VideoCapture(str(media_path))
                if not capture.isOpened():
                    raise ValueError("Video decoding failed.")
                frame_count = max(1, int(capture.get(cv2.CAP_PROP_FRAME_COUNT)))
                # 尾帧必须取到片尾（98.5%），旧版 92% 取的是动作中途帧，
                # 接到下一镜时会出现“上一镜还没走完就跳帧”的不连贯。
                for ratio in (.02, .5, .985):
                    capture.set(cv2.CAP_PROP_POS_FRAMES, int((frame_count - 1) * ratio))
                    ok, frame = capture.read()
                    if ok and frame is not None:
                        frames.append(frame)
                capture.release()
                if not frames:
                    raise ValueError("No video frames could be decoded.")

            frame_urls = []
            for label, frame in zip(("first", "middle", "last"), frames if len(frames) > 1 else [frames[0]]):
                ok, encoded = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 92])
                if ok:
                    _, frame_url = self._store_media_bytes(encoded.tobytes(), "image/jpeg", f"qc-{label}")
                    frame_urls.append(frame_url)

            analysis_frames = [_canonical_frame(frame) for frame in frames]
            metrics = [_frame_quality(frame, analysis) for frame, analysis in zip(frames, analysis_frames)]
            _, detector_name, detector_reliable = _face_detector()
            expected_people = max(0, min(12, int(request.get("expectedPeople") or 0)))
            max_faces = max((len(item["faces"]) for item in metrics), default=0)
            reference_frames = []
            for reference_url in list(request.get("referenceUrls") or [])[:8]:
                ref_payload, _ = self._source_bytes(reference_url)
                ref_frame = cv2.imdecode(np.frombuffer(ref_payload, np.uint8), cv2.IMREAD_COLOR)
                if ref_frame is not None:
                    ref_frame = _canonical_frame(ref_frame)
                    ref_faces = _detect_faces(ref_frame)
                    reference_frames.append(_face_crop(ref_frame, max(ref_faces, key=lambda face: face[2] * face[3])) if ref_faces else ref_frame)

            candidate_faces = []
            for frame, item in zip(analysis_frames, metrics):
                candidate_faces.extend(_face_crop(frame, face) for face in item["faces"])
            identity_scores = []
            for reference in reference_frames:
                identity_scores.append(max((_visual_identity_score(reference, candidate) for candidate in candidate_faces), default=0.0))
            identity_score = round(float(np.mean(identity_scores)), 4) if identity_scores else None
            text_score = max((item["textLikeScore"] for item in metrics), default=0.0)
            strong_text_rows = max((item["strongTextRows"] for item in metrics), default=0)
            weak_text_rows = max((item["weakTextRows"] for item in metrics), default=0)
            text_artifact = any(item["textArtifact"] for item in metrics)
            blurs = sorted(item["blur"] for item in metrics)
            median_blur = blurs[len(blurs) // 2] if blurs else 0.0
            min_blur = blurs[0] if blurs else 0.0
            max_black = max((item["blackRatio"] for item in metrics), default=1.0)
            min_width = min((item["width"] for item in metrics), default=0)
            min_height = min((item["height"] for item in metrics), default=0)
            expected_dialogue = str(request.get("expectedDialogue") or "").strip()
            # 免费视频通道（cogvideox-flash）根本没有音轨，若按「有台词就必须有音轨」判定，
            # 这类镜头 100% 会被判 qc_failed——生成明明是成功的。这里由调用方声明通道能力，
            # 不具备音频能力时把音频项标为「不适用」，而不是判失败。
            audio_capability = request.get("audioCapability")
            audio_expected = audio_capability is not False
            require_audio = (bool(request.get("requireAudio")) or bool(expected_dialogue)) and audio_expected
            allow_watermark = bool(request.get("allowWatermark"))
            transcribe_dialogue = bool(request.get("transcribeDialogue"))
            has_audio = extension in {".mp4", ".webm"} and _probe_audio(media_path)
            transcript, asr_method = ("", "not requested")
            dialogue_score = None
            if expected_dialogue and has_audio and transcribe_dialogue:
                transcript, asr_method = _transcribe_local(media_path)
                dialogue_score = _dialogue_similarity(expected_dialogue, transcript)

            # 人脸级联对风格化/AI 渲染画面经常漏检侧脸、背影、低头和远景小人，
            # 这属于检测器局限而非画面错误。默认把“人数不足”降级为人工复核提示，
            # 只有调用方显式要求 strictPersonCount 时才作为交付门禁。
            strict_person = bool(request.get("strictPersonCount"))
            person_gate = detector_reliable and expected_people > 0 and max_faces > 0 and max_faces < expected_people
            person_warn_only = detector_reliable and expected_people > 0 and max_faces == 0
            # 免费通道默认带官方水印；单行文字证据按水印放行，两行及以上才当作硬字幕。
            watermark_tolerated = allow_watermark and strong_text_rows <= 1
            # 身份相似度只在“画面里确实检出了足够人脸”时才作为硬门禁；
            # 侧脸/背影导致的人脸少检、或人脸没检出的情况只提示人工复核。
            identity_gate = detector_reliable and identity_score is not None and max_faces >= max(1, expected_people) and identity_score < .24
            text_gate = (strong_text_rows >= 2 or text_artifact) and not watermark_tolerated
            checks = {
                "mediaIntegrity": min_width >= 320 and min_height >= 320 and max_black < .85,
                "sharpness": median_blur >= QC_SHARPNESS_MIN,
                "personCount": (not person_gate) if strict_person else True,
                "identitySimilarity": not identity_gate,
                "noTextArtifacts": not text_gate,
                "audioPresent": not require_audio or has_audio,
                "dialogueMatch": not expected_dialogue or (has_audio and (not transcribe_dialogue or (dialogue_score is not None and dialogue_score >= .55))),
            }
            not_applicable: list[str] = []
            if not audio_expected:
                checks["audioPresent"] = True
                checks["dialogueMatch"] = True
                not_applicable.extend(["audioPresent", "dialogueMatch"])
            if person_warn_only or (person_gate and not strict_person):
                not_applicable.append("personCount")
            warnings = []
            if not detector_reliable:
                warnings.append(f"本机未安装可用的人脸检测模型（当前回退为{detector_name}），人数与身份相似度已降级为提示项，不作为交付门禁。")
            elif person_warn_only:
                warnings.append(f"画面里没有检出人脸（绑定 {expected_people} 个角色）。侧脸、背影或风格化渲染常导致漏检，人数项已降级为提示，请人工确认是否有人物出镜。")
            elif person_gate:
                warnings.append(f"检测到的人脸数 {max_faces} 少于绑定角色数 {expected_people}；侧脸、背影或远景小人常被漏检，人数项已降级为人工复核提示。")
            if detector_reliable and expected_people and max_faces > expected_people + 1:
                warnings.append(f"检测到 {max_faces} 张人脸，多于绑定角色数 {expected_people}；群演或构图包含多人，请确认是否为预期画面。")
            if identity_score is not None and identity_score < .38:
                warnings.append("角色视觉相似度偏低；这是启发式检查，建议人工复核。")
            if not audio_expected:
                warnings.append("当前视频通道不输出音轨（如 cogvideox-flash），音频与对白项按「不适用」处理，不计入交付门禁。")
            if watermark_tolerated:
                warnings.append("画面检出单行文字状区域，按免费通道的官方水印放行；如需严格无水印校验，可在智谱签署去水印声明或改用付费模型。")
            elif text_artifact:
                warnings.append(f"画面检出疑似硬字幕（{strong_text_rows} 行强证据 / {weak_text_rows} 行弱证据），可能被模型写进了画面。")
            elif strong_text_rows:
                warnings.append("画面存在一行文字状结构，也可能是景物直线边缘，未计入门禁，仅供参考。")
            elif text_score >= .3:
                warnings.append("画面存在文字状纹理，已判定为场景纹理而非字幕，仅供参考。")
            if require_audio and not has_audio:
                warnings.append("镜头需要台词/配音，但没有检测到音轨。")
            elif median_blur < QC_SHARPNESS_WARN:
                warnings.append(f"成片清晰度偏低（归一化拉普拉斯方差 {median_blur:.1f}），暗调或浅景深镜头属正常范围，可人工复核。")
            if expected_dialogue and has_audio and not transcribe_dialogue:
                warnings.append("已检测到音轨；为避免界面长时间超时，本轮未执行深度台词转写。")
            elif expected_dialogue and has_audio and dialogue_score is None:
                warnings.append(f"台词未能完成本地转写：{asr_method}")
            elif expected_dialogue and dialogue_score is not None and dialogue_score < .7:
                warnings.append("本地转写与剧本原句相似度偏低，可能被改写成旁白或出现错词。")
            response = {
                "passed": all(value for key, value in checks.items() if key not in not_applicable),
                "checks": checks, "notApplicable": not_applicable,
                "metrics": {
                    "framesChecked": len(frames), "facesDetectedMax": max_faces,
                    "expectedPeople": expected_people, "identitySimilarity": identity_score,
                    "strictPersonCount": strict_person, "identityGate": identity_gate,
                    "textLikeScore": text_score, "strongTextRows": strong_text_rows,
                    "weakTextRows": weak_text_rows,
                    "medianSharpness": round(median_blur, 2), "minimumSharpness": min_blur,
                    "sharpnessScale": QC_CANONICAL_WIDTH,
                    "maximumBlackRatio": max_black, "width": min_width, "height": min_height,
                    "hasAudio": has_audio, "audioCapability": audio_expected,
                    "allowWatermark": allow_watermark, "expectedDialogue": expected_dialogue,
                    "transcript": transcript, "dialogueSimilarity": dialogue_score,
                    "faceDetector": detector_name, "faceDetectorReliable": detector_reliable,
                },
                "warnings": warnings, "cachedMediaUrl": cached_url,
                "firstFrameUrl": frame_urls[0] if frame_urls else "",
                "lastFrameUrl": frame_urls[-1] if frame_urls else "",
                "method": f"OpenCV {detector_name}, visual-histogram similarity, row-based subtitle detection and normalised sharpness; local ASR={asr_method}; not biometric identification.",
            }
            self._json(HTTPStatus.OK, response)
        except Exception as error:
            if isinstance(error, DISCONNECT_ERRORS):
                # 客户端已断开，结果没人接收；不写诊断文件，避免把「刷新页面」误报成后端故障。
                return
            # Keep unexpected desktop-only failures diagnosable instead of
            # silently terminating the HTTP response in a worker thread.
            _log_line("ERROR", f"质检失败：{type(error).__name__}: {error}\n{traceback.format_exc()}")
            try:
                LOCAL_MEDIA_DIR.mkdir(parents=True, exist_ok=True)
                diagnostics = {
                    "traceback": traceback.format_exc(),
                    "python": sys.executable,
                    "cv2File": getattr(cv2, "__file__", ""),
                    "cv2Version": getattr(cv2, "__version__", ""),
                    "cv2HasCascadeClassifier": hasattr(cv2, "CascadeClassifier"),
                    "sysPath": sys.path,
                    "path": os.environ.get("PATH", ""),
                }
                (LOCAL_MEDIA_DIR / "qc-error.log").write_text(json.dumps(diagnostics, ensure_ascii=False, indent=2), encoding="utf-8")
            except OSError:
                pass
            self._json(HTTPStatus.BAD_REQUEST, {"error": "Quality control failed.", "detail": str(error)})

    def _quality_control_turnaround(self):
        """Validate and split a 3x3 turnaround sheet without biometric identification."""
        try:
            request = self._read_json_body()
            payload, _ = self._source_bytes(request.get("mediaUrl"))
            sheet = cv2.imdecode(np.frombuffer(payload, np.uint8), cv2.IMREAD_COLOR)
            if sheet is None:
                raise ValueError("Turnaround image decoding failed.")
            height, width = sheet.shape[:2]
            cell_height, cell_width = height // 3, width // 3
            if cell_height < 1 or cell_width < 1:
                raise ValueError("Turnaround image is too small.")
            panels: list[np.ndarray] = []
            panel_urls: list[str] = []
            for row in range(3):
                for column in range(3):
                    panel = sheet[row * cell_height:(row + 1) * cell_height, column * cell_width:(column + 1) * cell_width]
                    panels.append(panel)
                    ok, encoded = cv2.imencode(".jpg", panel, [int(cv2.IMWRITE_JPEG_QUALITY), 94])
                    if not ok:
                        raise ValueError("Turnaround panel encoding failed.")
                    _, panel_url = self._store_media_bytes(encoded.tobytes(), "image/jpeg", f"turnaround-{row}-{column}")
                    panel_urls.append(panel_url)

            analysis_panels = [_canonical_frame(panel) for panel in panels]
            qualities = [_frame_quality(panel, analysis) for panel, analysis in zip(panels, analysis_panels)]
            normalized = [cv2.resize(cv2.cvtColor(panel, cv2.COLOR_BGR2GRAY), (96, 96), interpolation=cv2.INTER_AREA) for panel in panels]
            diversity_values = [float(np.mean(cv2.absdiff(normalized[index], normalized[index + 1]))) / 255.0 for index in range(8)]
            view_diversity = round(float(np.mean(diversity_values)), 4)
            face_required = bool(request.get("faceRequired", True))
            _, detector_name, detector_reliable = _face_detector()
            face_panels = sum(1 for item in qualities if item["faces"])
            identity_score = None
            if face_required:
                reference_payload, _ = self._source_bytes(request.get("referenceUrl"))
                reference = cv2.imdecode(np.frombuffer(reference_payload, np.uint8), cv2.IMREAD_COLOR)
                if reference is None:
                    raise ValueError("Base character reference decoding failed.")
                reference = _canonical_frame(reference)
                reference_faces = _detect_faces(reference)
                reference_crop = _face_crop(reference, max(reference_faces, key=lambda face: face[2] * face[3])) if reference_faces else reference
                scores = []
                for analysis, quality in zip(analysis_panels, qualities):
                    if not quality["faces"]:
                        continue
                    face = max(quality["faces"], key=lambda item: item[2] * item[3])
                    scores.append(_visual_identity_score(reference_crop, _face_crop(analysis, face)))
                identity_score = round(float(np.mean(scores)), 4) if scores else 0.0

            max_text_score = max((item["textLikeScore"] for item in qualities), default=1.0)
            strong_text_rows = max((item["strongTextRows"] for item in qualities), default=0)
            weak_text_rows = max((item["weakTextRows"] for item in qualities), default=0)
            text_artifact = any(item["textArtifact"] for item in qualities)
            checks = {
                "threeByThreeLayout": .82 <= width / max(1, height) <= 1.22,
                "panelResolution": cell_width >= 240 and cell_height >= 240,
                "viewDiversity": view_diversity >= .025,
                "faceCoverage": not face_required or not detector_reliable or face_panels >= 2,
                "identitySimilarity": not face_required or not detector_reliable or (identity_score is not None and identity_score >= .24),
                "noTextArtifacts": not text_artifact,
            }
            warnings = []
            if not checks["threeByThreeLayout"]:
                warnings.append("九宫格画布不是接近 1:1 的方形布局。")
            if not checks["panelResolution"]:
                warnings.append("单格分辨率不足 240×240，视频参考容易失真。")
            if not checks["viewDiversity"]:
                warnings.append("九格画面差异过小，可能只是重复同一视角。")
            if not detector_reliable:
                warnings.append(f"本机未安装可用的人脸检测模型（当前回退为{detector_name}），人脸覆盖与身份相似度已降级为提示项。")
            elif face_required and not checks["faceCoverage"]:
                warnings.append("可检测人脸的格数不足，正面/侧面身份锚点可能不完整。")
            if face_required and detector_reliable and not checks["identitySimilarity"]:
                warnings.append("九宫格人物与定妆图的启发式相似度偏低。")
            if not checks["noTextArtifacts"]:
                warnings.append(f"九宫格检出疑似文字（{strong_text_rows} 行强证据 / {weak_text_rows} 行弱证据），可能含标签或伪文字。")
            self._json(HTTPStatus.OK, {
                "passed": all(checks.values()), "checks": checks, "warnings": warnings,
                "panelUrls": panel_urls,
                "metrics": {
                    "width": width, "height": height, "panelWidth": cell_width, "panelHeight": cell_height,
                    "facePanels": face_panels, "identitySimilarity": identity_score,
                    "viewDiversity": view_diversity, "maximumTextLikeScore": max_text_score,
                    "strongTextRows": strong_text_rows,
                    "faceDetector": detector_name, "faceDetectorReliable": detector_reliable,
                },
                "method": f"OpenCV 3x3 split, panel diversity, row-based text detection and visual-histogram similarity ({detector_name}); not biometric identification.",
            })
        except (ValueError, HTTPError, URLError, TimeoutError, OSError, cv2.error) as error:
            self._json(HTTPStatus.BAD_REQUEST, {"error": "Turnaround quality control failed.", "detail": str(error)})

    def _split_storyboard_grid(self):
        """Split a 2x2, 3x2, or 3x3 storyboard sheet into locally stored panels."""
        try:
            request = self._read_json_body()
            panel_count = int(request.get("panelCount") or 9)
            layouts = {4: (2, 2), 6: (2, 3), 9: (3, 3)}
            if panel_count not in layouts:
                raise ValueError("Panel count must be 4, 6, or 9.")
            payload, _ = self._source_bytes(request.get("imageUrl"))
            sheet = cv2.imdecode(np.frombuffer(payload, np.uint8), cv2.IMREAD_COLOR)
            if sheet is None:
                raise ValueError("Storyboard grid image decoding failed.")
            rows, columns = layouts[panel_count]
            height, width = sheet.shape[:2]
            cell_height, cell_width = height // rows, width // columns
            if cell_width < 160 or cell_height < 160:
                raise ValueError("Storyboard grid panels are smaller than 160x160.")
            panel_urls = []
            stem = re.sub(r"[^A-Za-z0-9_-]+", "-", str(request.get("name") or "storyboard"))[:48]
            for row in range(rows):
                for column in range(columns):
                    panel = sheet[row * cell_height:(row + 1) * cell_height, column * cell_width:(column + 1) * cell_width]
                    ok, encoded = cv2.imencode(".jpg", panel, [int(cv2.IMWRITE_JPEG_QUALITY), 94])
                    if not ok:
                        raise ValueError("Storyboard panel encoding failed.")
                    _, panel_url = self._store_media_bytes(encoded.tobytes(), "image/jpeg", f"{stem}-{row}-{column}")
                    panel_urls.append(panel_url)
            self._json(HTTPStatus.OK, {
                "imageUrl": str(request.get("imageUrl") or ""), "panelUrls": panel_urls,
                "panelCount": panel_count, "rows": rows, "columns": columns,
                "panelWidth": cell_width, "panelHeight": cell_height,
            })
        except (ValueError, HTTPError, URLError, TimeoutError, OSError, cv2.error) as error:
            self._json(HTTPStatus.BAD_REQUEST, {"error": "Storyboard grid split failed.", "detail": str(error)})

    def _render_master_video(self):
        """合片：默认只拼接；带 packaging 时顺带做归一化、变速、转场、调色、烧字幕与混音。"""
        try:
            request = self._read_json_body()
            raw_clips = request.get("clips")
            if not isinstance(raw_clips, list) or not raw_clips or len(raw_clips) > 200:
                raise ValueError("Provide between 1 and 200 shot clips.")
            ffmpeg = shutil.which("ffmpeg")
            if not ffmpeg:
                raise ValueError("ffmpeg is unavailable.")

            packaging = _packaging_of(request)
            speed = _packaging_number(packaging, "speed", 1.0, 0.25, 4.0)
            transition = str(packaging.get("transition") or "none")
            if transition not in post.TRANSITIONS:
                raise ValueError(f"不支持的转场：{transition}")
            transition_duration = _packaging_number(packaging, "transitionDuration", 0.4, 0.0, 2.0)
            grade = str(packaging.get("grade") or "none")
            if grade not in post.GRADE_PRESETS:
                raise ValueError(f"不支持的调色预设：{grade}")
            subtitle_conf = packaging.get("subtitles") if isinstance(packaging.get("subtitles"), dict) else {}
            tts_conf = packaging.get("tts") if isinstance(packaging.get("tts"), dict) else {}
            bgm_conf = packaging.get("bgm") if isinstance(packaging.get("bgm"), dict) else {}
            audio_conf = packaging.get("audio") if isinstance(packaging.get("audio"), dict) else {}
            subtitles_on = bool(subtitle_conf.get("enabled"))

            with tempfile.TemporaryDirectory(prefix="xinghe-master-") as directory:
                folder = Path(directory)
                clip_paths, clip_meta, shot_ids, dialogues = [], [], [], []
                for index, item in enumerate(raw_clips):
                    source = item.get("url") if isinstance(item, dict) else item
                    payload, content_type = self._source_bytes(source)
                    if not str(content_type).startswith("video/") and not payload[4:12].startswith(b"ftyp"):
                        raise ValueError(f"Clip {index + 1} is not a supported video.")
                    path = folder / f"clip-{index:04d}.mp4"
                    path.write_bytes(payload)
                    clip_paths.append(path)
                    clip_meta.append(_probe_media(path))
                    shot_ids.append(str((item or {}).get("shotId") or "") if isinstance(item, dict) else "")
                    dialogues.append(str((item or {}).get("dialogue") or "") if isinstance(item, dict) else "")

                width = int(packaging.get("width") or clip_meta[0]["width"] or 720)
                height = int(packaging.get("height") or clip_meta[0]["height"] or 1280)
                width -= width % 2
                height -= height % 2
                fps = int(packaging.get("fps") or 30)

                tts_paths: list[tuple[int, str, Path, float]] = []
                tts_lines = tts_conf.get("lines") if isinstance(tts_conf.get("lines"), dict) else {}
                # 必须尊重前端的配音开关：旧版只认 lines，用户关掉「混入配音」后仍然会混进去。
                if not tts_conf.get("enabled"):
                    tts_lines = {}
                if tts_lines:
                    for index, shot_id in enumerate(shot_ids):
                        url = tts_lines.get(shot_id)
                        if not url:
                            continue
                        payload, _content_type = self._source_bytes(url)
                        path = folder / f"tts-{index:04d}.mp3"
                        path.write_bytes(payload)
                        tts_paths.append((index, shot_id, path, _probe_media(path)["duration"]))

                bgm_path = None
                if bgm_conf.get("enabled"):
                    if bgm_conf.get("url"):
                        payload, _content_type = self._source_bytes(str(bgm_conf["url"]))
                        bgm_path = folder / "bgm-source.mp3"
                        bgm_path.write_bytes(payload)
                    else:
                        builtin = ROOT / BUILTIN_BGM_NAME
                        if builtin.is_file():
                            bgm_path = builtin

                graph_inputs = []
                for index, meta in enumerate(clip_meta):
                    requested = raw_clips[index].get("duration") if isinstance(raw_clips[index], dict) else None
                    try:
                        target_duration = float(requested or 0)
                    except (TypeError, ValueError):
                        target_duration = 0.0
                    source_duration = float(meta["duration"] or 0)
                    # 云模型常在标称时长外多输出 0.1～1.2 秒；合片必须以分镜台账为准，
                    # 否则 60 秒项目会悄悄变成 61 秒以上。目标不能超过真实素材长度。
                    duration = min(source_duration, target_duration) if target_duration > 0 else source_duration
                    graph_inputs.append({"duration": duration, "hasAudio": meta["hasAudio"], "speed": speed})
                plan = post.timeline_plan(graph_inputs, transition=transition, transition_duration=transition_duration)
                # 配音起点跟着镜头走：镜头被转场压缩后，配音必须跟着提前，否则整段错位。
                tts_inputs = [
                    {"input": len(clip_paths) + order, "start": plan["starts"][min(shot_index, len(plan["starts"]) - 1)],
                     "volume": float(tts_conf.get("volume", 1.0) or 1.0)}
                    for order, (shot_index, _shot_id, _path, _length) in enumerate(tts_paths)
                ]
                # 音效：按镜头指定音效 id，在镜头起点延迟混入。
                sfx_conf = packaging.get("sfx") if isinstance(packaging.get("sfx"), dict) else {}
                sfx_paths: list[tuple[int, Path]] = []
                if sfx_conf.get("enabled"):
                    sfx_map = sfx_conf.get("map") if isinstance(sfx_conf.get("map"), dict) else {}
                    for shot_index, shot_id in enumerate(shot_ids):
                        wanted = sfx_map.get(shot_id)
                        if isinstance(wanted, str):
                            wanted = [wanted]
                        if not isinstance(wanted, list):
                            continue
                        for sfx_id in wanted:
                            entry = sfx.sfx_by_id(str(sfx_id or ""))
                            if not entry:
                                continue
                            path = folder / f"sfx-{shot_index:04d}-{entry['id']}.wav"
                            path.write_bytes(sfx.render_sfx_wav(entry["id"]))
                            sfx_paths.append((shot_index, path))
                sfx_inputs = [
                    {"input": len(clip_paths) + len(tts_paths) + order,
                     "start": plan["starts"][min(shot_index, len(plan["starts"]) - 1)],
                     "volume": _packaging_number(sfx_conf, "volume", 0.6, 0.0, 1.5)}
                    for order, (shot_index, _path) in enumerate(sfx_paths)
                ]

                bgm_conf_for_graph = None
                if bgm_path is not None:
                    bgm_conf_for_graph = {
                        "input": len(clip_paths) + len(tts_paths) + len(sfx_paths),
                        "volume": _packaging_number(bgm_conf, "volume", 0.22, 0.0, 1.5),
                        "fadeIn": _packaging_number(bgm_conf, "fadeIn", 1.5, 0.0, 10.0),
                        "fadeOut": _packaging_number(bgm_conf, "fadeOut", 2.0, 0.0, 10.0),
                    }

                keep_source_audio = bool(audio_conf.get("keepSource", True))
                fit_mode = str(packaging.get("fit") or "blur")
                if fit_mode not in post.FIT_MODES:
                    raise ValueError(f"不支持的画幅适配方式：{fit_mode}")
                graph = post.build_master_graph(
                    graph_inputs, width=width, height=height, fps=fps,
                    transition=transition, transition_duration=transition_duration,
                    grade=grade, subtitle_file="subs.ass" if subtitles_on else "",
                    tts=tts_inputs, bgm=bgm_conf_for_graph, sfx=sfx_inputs,
                    keep_source_audio=keep_source_audio,
                    source_volume=_packaging_number(audio_conf, "sourceVolume", 1.0, 0.0, 2.0),
                    fit=fit_mode,
                    sizes=[(meta["width"], meta["height"]) for meta in clip_meta],
                )
                # 模型视频通常自带人声（提示词里写了台词），再叠配音就会同一句说两遍。
                warnings: list[str] = []
                # 通道只出 720p 时，成片按 1080p 合成等于 1.5 倍上采样，画面会变糊。
                # 旧版静默放大，用户以为是“模型画质差”，所以要显式提示。
                max_w = max((int(meta["width"] or 0) for meta in clip_meta), default=0)
                max_h = max((int(meta["height"] or 0) for meta in clip_meta), default=0)
                if max_w and width > max_w * 1.05:
                    warnings.append(
                        f"素材最高只有 {max_w}×{max_h}，成片按 {width}×{height} 合成，画面被放大约 "
                        f"{width / max_w:.1f} 倍；要拿到真 1080p 请换用支持 1080p 的视频通道。"
                    )
                if tts_paths and keep_source_audio:
                    warnings.append("同时保留了模型自带人声与本地配音，同一句台词可能出现两遍；把「镜头原声」设为「丢弃」可消除。")

                # TTS 起点已按镜头偏移喂进滤镜图，这里只处理字幕与后续命令拼装。
                cue_count = 0
                if subtitles_on:
                    starts = graph["offsets"]
                    timeline_shots = [
                        {"id": shot_ids[index] or f"shot-{index}", "dialogue": dialogues[index],
                         "duration": graph["effective"][index]}
                        for index in range(len(clip_paths))
                    ]
                    style_conf = dict(subtitle_conf.get("style") or {})
                    cues = post.subtitle_cues(
                        timeline_shots, timeline=starts,
                        max_chars=int(subtitle_conf.get("maxChars") or 18),
                    )
                    cue_count = len(cues)
                    (folder / "subs.ass").write_text(
                        post.cues_to_ass(cues, width=width, height=height, style=style_conf),
                        encoding="utf-8",
                    )

                command = [ffmpeg, "-y", "-v", "error"]
                for path in clip_paths:
                    command += ["-i", str(path)]
                for _shot_index, _shot_id, path, _length in tts_paths:
                    command += ["-i", str(path)]
                for _shot_index, path in sfx_paths:
                    command += ["-i", str(path)]
                if bgm_path is not None:
                    command += ["-stream_loop", "-1", "-i", str(bgm_path)]
                command += ["-filter_complex", graph["filter"], "-map", graph["video"]]
                if graph["audio"]:
                    command += ["-map", graph["audio"], "-c:a", "aac", "-b:a", "192k"]
                else:
                    command += ["-an"]
                output = folder / "master.mp4"
                command += [
                    # 竖屏 1080×1920@30 需要 level 4.2；Main profile + faststart 兼容手机与
                    # 微信/腾讯视频等播放器（High profile 常报 5104 格式不支持）。
                    "-c:v", "libx264", "-preset", "medium", "-crf", "20",
                    "-profile:v", "main", "-level", "4.2", "-pix_fmt", "yuv420p",
                    "-maxrate", "5M", "-bufsize", "10M",
                    "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
                    "-t", f"{graph['duration']:.3f}", "-movflags", "+faststart", str(output),
                ]
                result = subprocess.run(command, capture_output=True, timeout=1800, check=False, cwd=str(folder))
                if result.returncode != 0 or not output.is_file() or output.stat().st_size < 1024:
                    detail = result.stderr.decode("utf-8", errors="replace")[-2000:]
                    raise ValueError(f"Master render failed: {detail}")
                _, url = self._store_media_bytes(output.read_bytes(), "video/mp4", str(request.get("name") or "master"))

            self._json(HTTPStatus.OK, {
                "url": url,
                "clipCount": len(clip_paths),
                "duration": graph["duration"],
                "packaging": {
                    "size": f"{width}x{height}", "fps": fps, "speed": speed,
                    "transition": transition, "transitionDuration": graph["overlap"],
                    "grade": grade, "subtitles": cue_count,
                    "tts": len(tts_paths), "bgm": bgm_path is not None,
                    "sfx": len(sfx_paths),
                    "keepSource": keep_source_audio, "fit": fit_mode,
                },
                "warnings": warnings,
                "method": "local ffmpeg; no model request",
            })
        except (ValueError, HTTPError, URLError, TimeoutError, OSError, subprocess.TimeoutExpired) as error:
            _log_line("ERROR", f"合片失败：{type(error).__name__}: {error}")
            self._json(HTTPStatus.BAD_REQUEST, {"error": "Master render failed.", "detail": str(error)})

    # ------------------------------------------------------------ 后期包装接口

    def _package_tts(self):
        """按镜头台词合成配音；不绑定模型 Key，走免费的 Edge 神经语音。"""
        try:
            request = self._read_json_body()
            lines = request.get("lines")
            if not isinstance(lines, list) or not lines:
                raise ValueError("没有需要配音的台词。")
            if len(lines) > MAX_TTS_LINES:
                raise ValueError(f"一次最多合成 {MAX_TTS_LINES} 句台词，请分批处理。")
            if not post.tts_available():
                raise ValueError("本机缺少 edge-tts，配音不可用：pip install edge-tts")
            voice = str(request.get("voice") or post.VOICES[0]["id"])
            valid = {item["id"] for item in post.VOICES}
            if voice not in valid:
                raise ValueError(f"未知音色：{voice}")
            rate = int(_packaging_number(request, "rate", 0, -50, 80))
            pitch = int(_packaging_number(request, "pitch", 0, -50, 50))
            # 情绪预设叠加在用户设定的语速/音高之上。
            voice_style = post.resolve_voice_style(request.get("style"), rate=rate, pitch=pitch)
            rate, pitch = voice_style["rate"], voice_style["pitch"]
            volume = voice_style["volume"]
            # 多角色配音：角色名 → 音色。缺失的角色回落默认音色，映射里写错的音色会被丢弃而不是让整批失败。
            speakers = []
            for line in lines:
                name = str(line.get("speaker") or "").strip()
                if name and name not in speakers:
                    speakers.append(name)
            voice_map = post.resolve_voice_map(request.get("voiceMap"), speakers, default=voice)

            produced, failed = [], []
            with tempfile.TemporaryDirectory(prefix="xinghe-tts-") as directory:
                folder = Path(directory)
                for index, line in enumerate(lines):
                    shot_id = str(line.get("id") or line.get("shotId") or f"line-{index}")
                    text = str(line.get("text") or "")
                    speaker = str(line.get("speaker") or "").strip()
                    if not post.strip_speaker(text):
                        continue
                    # 优先级：这一行显式指定的音色 > 角色映射 > 全局默认。
                    line_voice = str(line.get("voice") or "").strip()
                    if line_voice not in valid:
                        line_voice = voice_map.get(speaker, voice)
                    try:
                        path = post.synthesize_speech(text, line_voice, folder / f"{index:04d}.mp3", rate=rate, pitch=pitch, volume=volume)
                        payload = path.read_bytes()
                        _path, url = self._store_media_bytes(payload, "audio/mpeg", f"tts-{shot_id}")
                        length = post.probe_duration(path)
                        target = float(line.get("duration") or 0)
                        produced.append({
                            "id": shot_id, "url": url, "duration": round(length, 3),
                            "voice": line_voice, "speaker": speaker,
                            "overrun": round(max(0.0, length - target), 3) if target > 0 else 0.0,
                        })
                    except Exception as error:  # 单句失败不拖垮整批
                        _log_line("WARN", f"配音失败（{shot_id}）：{type(error).__name__}: {error}")
                        failed.append({"id": shot_id, "error": str(error)})
            if not produced:
                detail = failed[0]["error"] if failed else "所有台词都是空的。"
                raise ValueError(f"配音没有成功任何一句：{detail}")
            warnings = [f"{item['id']} 配音比镜头长 {item['overrun']}s" for item in produced if item["overrun"] > 0.25]
            used_voices = sorted({item["voice"] for item in produced})
            self._json(HTTPStatus.OK, {
                "channel": "edge-tts", "voice": voice, "rate": rate, "pitch": pitch,
                "style": voice_style["style"], "volume": volume,
                "voiceMap": {item["speaker"]: item["voice"] for item in produced if item["speaker"]},
                "usedVoices": used_voices,
                "lines": produced, "failed": failed, "warnings": warnings,
            })
        except (ValueError, OSError) as error:
            _log_line("ERROR", f"配音失败：{type(error).__name__}: {error}")
            self._json(HTTPStatus.BAD_REQUEST, {"error": "配音失败。", "detail": str(error)})

    def _package_subtitles(self):
        """按台词与镜头时长切字幕，返回 cue 列表与 SRT 文本（前端可预览/下载）。"""
        try:
            request = self._read_json_body()
            shots = request.get("shots")
            if not isinstance(shots, list) or not shots:
                raise ValueError("没有镜头，无法生成字幕。")
            speed = _packaging_number(request, "speed", 1.0, 0.25, 4.0)
            transition = str(request.get("transition") or "none")
            transition_duration = _packaging_number(request, "transitionDuration", 0.4, 0.0, 2.0)
            durations = [max(0.05, float(shot.get("duration") or 0) / speed) for shot in shots]
            overlap = 0.0
            if transition not in ("", "none") and len(durations) > 1:
                overlap = min(transition_duration, min(durations) * 0.6)
            starts, total = post.layout_timeline(durations, transition=transition, overlap=overlap)
            timeline_shots = [
                {"id": shot.get("id") or f"shot-{index}", "dialogue": shot.get("dialogue", ""), "duration": durations[index]}
                for index, shot in enumerate(shots)
            ]
            cues = post.subtitle_cues(
                timeline_shots, timeline=starts,
                max_chars=int(_packaging_number(request, "maxChars", 18, 6, 40)),
            )
            style = request.get("style") if isinstance(request.get("style"), dict) else {}
            resolved = post.resolve_subtitle_style(style, int(request.get("width") or 720), int(request.get("height") or 1280))
            self._json(HTTPStatus.OK, {
                "cues": cues,
                "srt": post.cues_to_srt(cues),
                "count": len(cues),
                "duration": round(total, 3),
                "offsets": [round(value, 3) for value in starts],
                "style": resolved,
                "template": resolved.get("template", "plain"),
                "templates": [{"id": key, "label": value["label"]} for key, value in post.SUBTITLE_TEMPLATES.items()],
            })
        except (ValueError, OSError) as error:
            _log_line("ERROR", f"字幕生成失败：{type(error).__name__}: {error}")
            self._json(HTTPStatus.BAD_REQUEST, {"error": "字幕生成失败。", "detail": str(error)})

    def _package_cover(self):
        """取首帧做封面：压暗 + 标题排版，输出可直接发布的 PNG。"""
        try:
            request = self._read_json_body()
            frame_url = str(request.get("frame") or "").strip()
            frame = None
            if frame_url:
                try:
                    frame, _content_type = self._source_bytes(frame_url)
                except ValueError as error:
                    _log_line("WARN", f"封面底图不可用，改用纯色底：{error}")
            width = int(_packaging_number(request, "width", 1080, 240, 4096))
            height = int(_packaging_number(request, "height", 1920, 240, 4096))
            payload = post.render_cover(
                frame, str(request.get("title") or ""), str(request.get("subtitle") or ""),
                width=width, height=height,
                accent=str(request.get("accent") or "#E23B2E"),
                watermark=str(request.get("watermark") or ""),
            )
            _path, url = self._store_media_bytes(payload, "image/png", "cover")
            self._json(HTTPStatus.OK, {"url": url, "size": f"{width}x{height}", "usedFrame": bool(frame)})
        except (ValueError, OSError) as error:
            _log_line("ERROR", f"封面生成失败：{type(error).__name__}: {error}")
            self._json(HTTPStatus.BAD_REQUEST, {"error": "封面生成失败。", "detail": str(error)})

    def _local_media_file(self, source: str) -> Path:
        """草稿要写绝对路径，所以远端素材先落到本地缓存再引用。"""
        value = str(source or "").strip()
        parsed = urlparse(value)
        if parsed.path.startswith(LOCAL_MEDIA_PREFIX):
            name = _safe_media_name(parsed.path[len(LOCAL_MEDIA_PREFIX):])
            path = LOCAL_MEDIA_DIR / name
            if name and path.is_file():
                return path
        payload, content_type = self._source_bytes(value)
        path, _url = self._store_media_bytes(payload, content_type, "draft-source")
        return path

    def _export_draft(self):
        """导出剪映明文草稿（zip：draft_content.json + 元信息 + SRT + 导入说明）。"""
        try:
            request = self._read_json_body()
            shots = request.get("shots")
            if not isinstance(shots, list) or not shots or len(shots) > 200:
                raise ValueError("Provide between 1 and 200 shots.")
            width = int(_packaging_number(request, "width", 720, 240, 4096))
            height = int(_packaging_number(request, "height", 1280, 240, 4096))
            fps = int(_packaging_number(request, "fps", 30, 12, 60))
            speed = _packaging_number(request, "speed", 1.0, 0.25, 4.0)
            subtitle_conf = request.get("subtitles") if isinstance(request.get("subtitles"), dict) else {}
            tts_conf = request.get("tts") if isinstance(request.get("tts"), dict) else {}
            bgm_conf = request.get("bgm") if isinstance(request.get("bgm"), dict) else {}

            clips, timeline_shots = [], []
            for index, shot in enumerate(shots):
                source = shot.get("url") or shot.get("mediaUrl")
                path = self._local_media_file(source)
                meta = _probe_media(path)
                duration = float(meta["duration"] or shot.get("duration") or 0)
                if duration <= 0:
                    raise ValueError(f"第 {index + 1} 个镜头时长无效。")
                clips.append({
                    "path": str(path), "duration": duration, "speed": speed,
                    "width": meta["width"] or width, "height": meta["height"] or height,
                })
                timeline_shots.append({
                    "id": str(shot.get("id") or f"shot-{index}"),
                    "dialogue": str(shot.get("dialogue") or ""),
                    "duration": duration / speed,
                })

            durations = [clip["duration"] / speed for clip in clips]
            starts, total = post.layout_timeline(durations)
            cues = post.subtitle_cues(
                timeline_shots, timeline=starts,
                max_chars=int(subtitle_conf.get("maxChars") or 18),
            ) if subtitle_conf.get("enabled") else []

            tts_lines = []
            tts_map = tts_conf.get("lines") if isinstance(tts_conf.get("lines"), dict) else {}
            for index, shot in enumerate(timeline_shots):
                url = tts_map.get(shot["id"])
                if not url:
                    continue
                path = self._local_media_file(url)
                length = post.probe_duration(path)
                if length <= 0:
                    continue
                tts_lines.append({"path": str(path), "start": starts[index], "duration": length, "volume": 1.0})

            bgm = None
            if bgm_conf.get("enabled"):
                if bgm_conf.get("url"):
                    path = self._local_media_file(str(bgm_conf["url"]))
                else:
                    path = ROOT / BUILTIN_BGM_NAME
                if path.is_file():
                    bgm = {"path": str(path), "volume": float(bgm_conf.get("volume", 0.25) or 0.25),
                           "duration": post.probe_duration(path)}

            template = json.loads((ROOT / "vendor" / "jianying" / "draft_content_template.json").read_text(encoding="utf-8"))
            name = str(request.get("name") or "星河制片台草稿")
            document = post.build_draft_document(
                template=template, name=name, width=width, height=height, fps=fps,
                clips=clips, cues=cues, tts=tts_lines, bgm=bgm,
                font_size=int((subtitle_conf.get("style") or {}).get("size") or 44),
            )

            notes = [
                "本目录为明文剪映草稿结构：主视频轨 = 各镜头原片（保留原速/变速），字幕轨可编辑，配音与 BGM 各一轨。",
                "素材以绝对路径引用，导入前请保留原素材位置；不要覆盖现有草稿。",
                "转场与调色不写进草稿（剪映的转场/调节材料结构随版本变化），需在剪映内重新添加。",
                f"成片轴总时长 {total:.2f}s，字幕 {len(cues)} 条，配音 {len(tts_lines)} 条。",
            ]
            LOCAL_MEDIA_DIR.mkdir(parents=True, exist_ok=True)
            safe_name = re.sub(r"[^A-Za-z0-9_-]+", "-", name)[:32] or "draft"
            zip_path = LOCAL_MEDIA_DIR / f"jianying-draft-{safe_name}-{uuid.uuid4().hex[:8]}.zip"
            with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as archive:
                archive.writestr("draft_content.json", json.dumps(document, ensure_ascii=False, indent=2))
                archive.writestr("draft_meta_info.json", json.dumps(
                    post.draft_meta(document["id"], zip_path.stem, total), ensure_ascii=False, indent=2))
                archive.writestr("subtitles.srt", post.cues_to_srt(cues))
                archive.writestr("导入说明.txt", "\n".join(notes) + "\n")
            self._json(HTTPStatus.OK, {
                "url": DOWNLOAD_MEDIA_PREFIX + zip_path.name,
                "shots": len(clips), "subtitles": len(cues), "tts": len(tts_lines),
                "bgm": bgm is not None, "duration": round(total, 3),
            })
        except (ValueError, OSError) as error:
            _log_line("ERROR", f"草稿导出失败：{type(error).__name__}: {error}")
            self._json(HTTPStatus.BAD_REQUEST, {"error": "草稿导出失败。", "detail": str(error)})

    # ------------------------------------------------------------ 局部重绘

    def _inpaint_prepare(self):
        """局部重绘第一步：把选区（含上下文）裁出来，交给前端送去模型重绘。"""
        try:
            request = self._read_json_body(MAX_LOCAL_MEDIA_BYTES)
            base_payload, _content_type = self._source_bytes(request.get("image"))
            mask_payload, _mask_type = self._source_bytes(request.get("mask"))
            prepared = inpaint.prepare_inpaint(base_payload, mask_payload)
            _path, crop_url = self._store_media_bytes(prepared["crop"], "image/png", "inpaint-crop")
            self._json(HTTPStatus.OK, {
                "cropUrl": crop_url,
                "inner": prepared["inner"],
                "cropBox": prepared["cropBox"],
                "bbox": prepared["bbox"],
                "size": prepared["size"],
            })
        except (ValueError, OSError) as error:
            _log_line("ERROR", f"局部重绘取景失败：{type(error).__name__}: {error}")
            self._json(HTTPStatus.BAD_REQUEST, {"error": "局部重绘取景失败。", "detail": str(error)})

    def _inpaint_merge(self):
        """局部重绘第二步：把模型重绘的选区按遮罩羽化融合回原图。"""
        try:
            request = self._read_json_body(MAX_LOCAL_MEDIA_BYTES)
            base_payload, _content_type = self._source_bytes(request.get("image"))
            mask_payload, _mask_type = self._source_bytes(request.get("mask"))
            new_payload, _new_type = self._source_bytes(request.get("result"))
            feather = int(_packaging_number(request, "feather", 12, 0, 80))
            merged = inpaint.merge_inpaint(base_payload, mask_payload, new_payload, feather=feather)
            _path, url = self._store_media_bytes(merged, "image/png", "inpaint-result")
            self._json(HTTPStatus.OK, {"url": url, "feather": feather})
        except (ValueError, OSError) as error:
            _log_line("ERROR", f"局部重绘合成失败：{type(error).__name__}: {error}")
            self._json(HTTPStatus.BAD_REQUEST, {"error": "局部重绘合成失败。", "detail": str(error)})

    # ------------------------------------------------------------ 音效库

    def _list_sfx_library(self):
        """列出本地合成的音效，并给出试听地址（音效本身即时合成并缓存到固定文件名）。"""
        try:
            LOCAL_MEDIA_DIR.mkdir(parents=True, exist_ok=True)
            items = []
            for entry in sfx.SFX_LIBRARY:
                # 固定文件名：每次请求都重新生成会让媒体目录堆满重复文件。
                name = f"sfx-{entry['id']}.wav"
                path = LOCAL_MEDIA_DIR / name
                if not path.is_file() or path.stat().st_size < 512:
                    path.write_bytes(sfx.render_sfx_wav(entry["id"]))
                items.append({
                    "id": entry["id"], "label": entry["label"], "category": entry["category"],
                    "duration": entry["duration"], "url": LOCAL_MEDIA_PREFIX + name,
                    "keywords": entry["keywords"],
                })
            self._json(HTTPStatus.OK, {"items": items, "categories": sfx.SFX_CATEGORIES})
        except (ValueError, OSError) as error:
            _log_line("ERROR", f"音效库读取失败：{type(error).__name__}: {error}")
            self._json(HTTPStatus.BAD_REQUEST, {"error": "音效库读取失败。", "detail": str(error)})


    def _query_model_task(self):
        try:
            request = self._read_json_body()
            task_id = str(request.get("taskId") or "").strip()
            if not re.fullmatch(r"[A-Za-z0-9-]{8,80}", task_id):
                raise ValueError("Invalid task ID.")
            base_url = str(request.get("baseUrl") or "https://dashscope.aliyuncs.com").rstrip("/")
            base = urlparse(base_url)
            is_dashscope = base.hostname == "dashscope.aliyuncs.com" or (base.hostname or "").endswith(".maas.aliyuncs.com")
            is_agent_plan = base.hostname == "ark.cn-beijing.volces.com" and base.path.rstrip("/") == "/api/plan/v3"
            is_zhipu = base.hostname == "open.bigmodel.cn" and base.path.rstrip("/") == ZHIPU_VIDEO_BASE_PATH
            if base.scheme != "https" or not (is_dashscope or is_agent_plan or is_zhipu):
                raise ValueError("Unsupported task provider.")
            api_key = _clean_credential(request.get("apiKey")) or _clean_credential(_server_secret_for("video", base), "本机保存的密钥")
            if not api_key:
                raise ValueError("No video API key is configured.")
            if is_agent_plan:
                target_url = base_url + f"{AGENT_PLAN_VIDEO_ENDPOINT}/{task_id}"
            elif is_zhipu:
                target_url = ZHIPU_ASYNC_RESULT_URL.format(task_id=task_id)
            else:
                target_url = base_url + f"/api/v1/tasks/{task_id}"
            upstream_request = Request(
                target_url,
                headers={"Authorization": f"Bearer {api_key}", "Accept": "application/json", "User-Agent": "XingheCommercialDirector/1.0"},
            )
            with urlopen(upstream_request, timeout=60) as upstream:
                data = json.loads(upstream.read(MAX_MODEL_RESPONSE_BYTES).decode("utf-8"))
            self._json(HTTPStatus.OK, data)
        except HTTPError as error:
            body = error.read(MAX_MODEL_RESPONSE_BYTES)
            try:
                detail = json.loads(body.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                detail = {"detail": str(error.reason)}
            self._json(error.code, detail)
        except (ValueError, URLError, TimeoutError, OSError, json.JSONDecodeError) as error:
            self._json(HTTPStatus.BAD_REQUEST, {"error": "Task query failed.", "detail": str(error)})

    def _test_model_provider(self):
        """Perform a read-only task query; never starts a billable generation."""
        try:
            request = self._read_json_body()
            provider_name = str(request.get("provider") or "")
            if provider_name not in ("video", "image"):
                raise ValueError("Only the video and image connection tests are supported.")
            base_url = str(request.get("baseUrl") or "").rstrip("/")
            endpoint = str(request.get("endpoint") or "")
            base = urlparse(base_url)
            is_dashscope = base.scheme == "https" and (
                base.hostname == "dashscope.aliyuncs.com" or (base.hostname or "").endswith(".maas.aliyuncs.com")
            )
            is_zhipu = (
                base.scheme == "https"
                and base.hostname == "open.bigmodel.cn"
                and base.path.rstrip("/") == ZHIPU_VIDEO_BASE_PATH
                and endpoint == (ZHIPU_IMAGE_ENDPOINT if provider_name == "image" else ZHIPU_VIDEO_ENDPOINT)
            )
            is_tencent = (
                provider_name == "video"
                and base.scheme == "https"
                and base.hostname == TENCENT_VIDEO_HOST
                and base.path.rstrip("/") == ""
                and endpoint == TENCENT_VIDEO_ENDPOINT
            )
            if is_tencent:
                secret_id, secret_key = _tencent_cloud_credentials(request)
                probe_data = {}
                try:
                    with _tencent_cloud_request(
                        "DescribeHunyuanToVideoJob", {"JobId": "0000000000000000000"}, secret_id, secret_key
                    ) as upstream:
                        probe_data = json.loads(upstream.read(MAX_MODEL_RESPONSE_BYTES).decode("utf-8"))
                except HTTPError as error:
                    body = error.read(MAX_MODEL_RESPONSE_BYTES)
                    try:
                        probe_data = json.loads(body.decode("utf-8"))
                    except (UnicodeDecodeError, json.JSONDecodeError):
                        probe_data = {"Response": {"Error": {"Code": str(error.code), "Message": str(error.reason)}}}
                cloud_error = probe_data.get("Response", {}).get("Error", {}) if isinstance(probe_data, dict) else {}
                if re.search(r"AuthFailure|Unauthorized|InvalidCredential|SignatureFailure", str(cloud_error.get("Code") or ""), re.I):
                    raise ValueError(cloud_error.get("Message") or cloud_error.get("Code") or "腾讯云凭据无效。")
                self._json(HTTPStatus.OK, {
                    "ok": True, "provider": "tencent-hunyuan-video", "billableGeneration": False,
                    "detail": "腾讯云签名已被接受；本次只查询不存在的任务，未消耗积分。",
                })
                return
            if is_dashscope:
                # 百炼：图片与视频共用同一把 sk- Key，本机 .env 里有就直接用，浏览器不必再传。
                api_key = _clean_credential(request.get("apiKey")) or _clean_credential(
                    _server_secret_for(provider_name, base), "本机保存的密钥"
                )
                if not api_key:
                    raise ValueError("No DashScope API key is configured.")
                if provider_name == "image":
                    # 只读探针：空提示词必然被拒（400/422 = Key 有效），不会真的出图。
                    probe_url = base_url + endpoint
                    probe_data = json.dumps({"model": "wan2.7-image", "input": {"messages": []}}).encode("utf-8")
                    probe = Request(
                        probe_url, data=probe_data, method="POST",
                        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json",
                                 "Accept": "application/json", "User-Agent": "XingheCommercialDirector/1.0"},
                    )
                else:
                    probe = Request(
                        base_url + f"/api/v1/tasks/{uuid.uuid4().hex}",
                        headers={"Authorization": f"Bearer {api_key}", "Accept": "application/json",
                                 "User-Agent": "XingheCommercialDirector/1.0"},
                    )
                try:
                    with urlopen(probe, timeout=30) as upstream:
                        upstream.read(MAX_MODEL_RESPONSE_BYTES)
                except HTTPError as error:
                    if error.code not in (400, 404, 422):
                        raise
                self._json(HTTPStatus.OK, {
                    "ok": True, "provider": "dashscope-wan", "billableGeneration": False,
                    "detail": "Key 有效；本次为只读探测，未消耗额度。",
                })
                return
            if provider_name == "image":
                if not is_zhipu:
                    raise ValueError("图片连接测试目前只支持智谱与阿里百炼两个官方端点。")
                api_key = _clean_credential(request.get("apiKey")) or _clean_credential(
                    _server_secret_for("image", base), "本机保存的密钥"
                )
                if not api_key:
                    raise ValueError("No Zhipu API key is configured.")
                # 用空提示词做探测：400 表示 Key 已被接受（只是参数不合法），401 表示 Key 无效。
                # 不会真正出图，不消耗额度。
                probe_request = Request(
                    base_url + endpoint,
                    data=json.dumps({"model": "cogview-3-flash", "prompt": ""}).encode("utf-8"),
                    method="POST",
                    headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json", "Accept": "application/json", "User-Agent": "XingheCommercialDirector/1.0"},
                )
                try:
                    with urlopen(probe_request, timeout=30) as upstream:
                        upstream.read(MAX_MODEL_RESPONSE_BYTES)
                except HTTPError as error:
                    if error.code not in (400, 422):
                        raise
                self._json(HTTPStatus.OK, {"ok": True, "provider": "zhipu-cogview", "billableGeneration": False})
                return
            if is_zhipu:
                # 智谱图片和视频共用同一把本机 ZHIPU_API_KEY。前端在服务端托管
                # 密钥时会故意传空，连接测试必须和真实生成代理使用同一套回退逻辑，
                # 否则会出现“图片能生成、视频检查却说未配置”的假故障。
                api_key = _clean_credential(request.get("apiKey")) or _clean_credential(
                    _server_secret_for("video", base), "本机保存的密钥"
                )
                if not api_key:
                    raise ValueError("No Zhipu API key is configured.")
                # 用一个不存在的任务 ID 做只读探测：401 表示 Key 无效，404/400 表示 Key 已被接受。
                probe_url = ZHIPU_ASYNC_RESULT_URL.format(task_id=uuid.uuid4().hex)
                probe = Request(
                    probe_url,
                    headers={"Authorization": f"Bearer {api_key}", "Accept": "application/json", "User-Agent": "XingheCommercialDirector/1.0"},
                )
                try:
                    with urlopen(probe, timeout=30) as upstream:
                        upstream.read(MAX_MODEL_RESPONSE_BYTES)
                except HTTPError as error:
                    if error.code not in (400, 404):
                        raise
                self._json(HTTPStatus.OK, {"ok": True, "provider": "zhipu-cogvideox", "billableGeneration": False})
                return
            if not (
                base.scheme == "https"
                and base.hostname == "ark.cn-beijing.volces.com"
                and base.path.rstrip("/") == "/api/plan/v3"
                and endpoint == AGENT_PLAN_VIDEO_ENDPOINT
            ):
                raise ValueError("Agent Plan must use the dedicated /api/plan/v3 video endpoint.")
            api_key = _clean_credential(request.get("apiKey")) or _clean_credential(_server_secret_for("video", base), "本机保存的密钥")
            if not api_key:
                raise ValueError("No Agent Plan API key is configured.")
            upstream_request = Request(
                base_url + endpoint + "?page_size=1",
                headers={"Authorization": f"Bearer {api_key}", "Accept": "application/json", "User-Agent": "XingheCommercialDirector/1.0"},
            )
            with urlopen(upstream_request, timeout=60) as upstream:
                upstream.read(MAX_MODEL_RESPONSE_BYTES)
            self._json(HTTPStatus.OK, {"ok": True, "provider": "volcengine-agent-plan", "billableGeneration": False})
        except HTTPError as error:
            body = error.read(MAX_MODEL_RESPONSE_BYTES)
            try:
                detail = json.loads(body.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                detail = {"detail": str(error.reason)}
            self._json(error.code, detail)
        except (ValueError, URLError, TimeoutError, OSError, json.JSONDecodeError) as error:
            self._json(HTTPStatus.BAD_REQUEST, {"error": "Model connection test failed.", "detail": str(error)})

    def _upload_dashscope_media(self):
        try:
            request = self._read_json_body()
            model = str(request.get("model") or "").strip()
            if not re.fullmatch(r"[A-Za-z0-9._-]{2,100}", model):
                raise ValueError("Invalid model name.")
            payload, content_type = self._source_bytes(request.get("mediaUrl"))
            extension = _media_extension(content_type, payload)
            if extension not in {".png", ".jpg", ".webp"}:
                raise ValueError("Only reference images can be uploaded.")
            key = _server_secret_for("video", urlparse("https://dashscope.aliyuncs.com"))
            if not key:
                raise ValueError("No DashScope API key is configured.")
            policy_response = requests.get(
                "https://dashscope.aliyuncs.com/api/v1/uploads",
                headers={"Authorization": f"Bearer {key}"}, params={"action": "getPolicy", "model": model}, timeout=30,
            )
            policy_response.raise_for_status()
            policy = policy_response.json()["data"]
            filename = f"xinghe-{uuid.uuid4().hex[:12]}{extension}"
            object_key = f"{policy['upload_dir']}/{filename}"
            upload = requests.post(policy["upload_host"], files={
                "OSSAccessKeyId": (None, policy["oss_access_key_id"]), "Signature": (None, policy["signature"]),
                "policy": (None, policy["policy"]), "x-oss-object-acl": (None, policy["x_oss_object_acl"]),
                "x-oss-forbid-overwrite": (None, policy["x_oss_forbid_overwrite"]), "key": (None, object_key),
                "success_action_status": (None, "200"), "file": (filename, payload, content_type),
            }, timeout=120)
            upload.raise_for_status()
            self._json(HTTPStatus.OK, {"url": f"oss://{object_key}", "model": model})
        except (ValueError, KeyError, requests.RequestException, json.JSONDecodeError) as error:
            self._json(HTTPStatus.BAD_REQUEST, {"error": "DashScope media upload failed.", "detail": str(error)})

    def _proxy_model_request(self):
        """Forward one user-configured HTTPS model request without persisting secrets."""
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            content_length = 0
        if content_length <= 0 or content_length > MAX_MODEL_REQUEST_BYTES:
            self._json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "Invalid model request size."})
            return
        try:
            envelope = json.loads(self.rfile.read(content_length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._json(HTTPStatus.BAD_REQUEST, {"error": "Invalid JSON request."})
            return

        base_url = str(envelope.get("baseUrl", "")).strip().rstrip("/")
        endpoint = str(envelope.get("endpoint", "")).strip()
        try:
            api_key = _clean_credential(envelope.get("apiKey", ""))
        except ValueError as error:
            self._json(HTTPStatus.BAD_REQUEST, {"error": "Invalid API key.", "detail": str(error)})
            return
        provider = str(envelope.get("provider", "")).strip()
        payload = envelope.get("payload")
        base = urlparse(base_url)
        if (
            base.scheme != "https"
            or not base.hostname
            or base.username
            or base.password
            or (base.hostname not in OFFICIAL_MODEL_HOSTS and not _is_public_host(base.hostname))
        ):
            self._json(HTTPStatus.FORBIDDEN, {"error": "Only public HTTPS model providers are allowed."})
            return
        if not endpoint.startswith("/") or endpoint.startswith("//") or len(endpoint) > 2048:
            self._json(HTTPStatus.BAD_REQUEST, {"error": "Invalid model endpoint."})
            return
        if not isinstance(payload, (dict, list)):
            self._json(HTTPStatus.BAD_REQUEST, {"error": "JSON payload is required."})
            return

        if provider == "video" and base.hostname == TENCENT_VIDEO_HOST:
            if base.path.rstrip("/") != "" or endpoint != TENCENT_VIDEO_ENDPOINT:
                self._json(HTTPStatus.FORBIDDEN, {"error": "Tencent video is restricted to the official VCLM Cloud API endpoint."})
                return
            if not isinstance(payload, dict):
                self._json(HTTPStatus.BAD_REQUEST, {"error": "Tencent video request must be an object."})
                return
            action = str(payload.get("action") or "")
            params = payload.get("params")
            if action not in TENCENT_VIDEO_ACTIONS or not isinstance(params, dict):
                self._json(HTTPStatus.BAD_REQUEST, {"error": "Unsupported Tencent video action or params."})
                return
            if action == "SubmitHunyuanToVideoJob":
                prompt = str(params.get("Prompt") or "")
                if not prompt or len(prompt) > 200:
                    self._json(HTTPStatus.BAD_REQUEST, {"error": "Tencent Hunyuan prompt must contain 1-200 characters."})
                    return
                if params.get("Resolution") not in (None, "720p"):
                    self._json(HTTPStatus.BAD_REQUEST, {"error": "Tencent Hunyuan currently supports 720p only."})
                    return
            try:
                secret_id, secret_key = _tencent_cloud_credentials(envelope)
                with _tencent_cloud_request(action, params, secret_id, secret_key) as upstream:
                    response_body = upstream.read(MAX_MODEL_RESPONSE_BYTES + 1)
                    if len(response_body) > MAX_MODEL_RESPONSE_BYTES:
                        self._json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "Model response is too large."})
                        return
                    self._raw_bytes(getattr(upstream, "status", HTTPStatus.OK), response_body, upstream.headers.get("Content-Type", "application/json"))
            except HTTPError as error:
                response_body = error.read(MAX_MODEL_RESPONSE_BYTES)
                self._raw_bytes(error.code, response_body, error.headers.get("Content-Type", "application/json"))
            except (ValueError, URLError, TimeoutError, OSError) as error:
                self._json(HTTPStatus.BAD_GATEWAY, {"error": "Tencent video request failed.", "detail": str(error)})
            return

        if provider == "image" and base.hostname == TENCENT_IMAGE_HOST:
            # 混元生图 3.0：官方免费额度 50 次，最多 3 张参考图，可指定 9:16 竖幅。
            if base.path.rstrip("/") != "" or endpoint != TENCENT_VIDEO_ENDPOINT:
                self._json(HTTPStatus.FORBIDDEN, {"error": "Tencent image is restricted to the official AIArt Cloud API endpoint."})
                return
            if not isinstance(payload, dict):
                self._json(HTTPStatus.BAD_REQUEST, {"error": "Tencent image request must be an object."})
                return
            action = str(payload.get("action") or "")
            params = payload.get("params")
            if action not in TENCENT_IMAGE_ACTIONS or not isinstance(params, dict):
                self._json(HTTPStatus.BAD_REQUEST, {"error": "Unsupported Tencent image action or params."})
                return
            if action == "SubmitTextToImageJob":
                prompt = str(params.get("Prompt") or "").strip()
                if not prompt or len(prompt) > 8192:
                    self._json(HTTPStatus.BAD_REQUEST, {"error": "Tencent Hunyuan image prompt must contain 1-8192 characters."})
                    return
                images = params.get("Images")
                if images is not None:
                    if not isinstance(images, list) or not (1 <= len(images) <= 3):
                        self._json(HTTPStatus.BAD_REQUEST, {"error": "Tencent Hunyuan image accepts 1-3 reference images."})
                        return
                    if any(not isinstance(item, str) or len(item) > 8 * 1024 * 1024 for item in images):
                        self._json(HTTPStatus.BAD_REQUEST, {"error": "Tencent Hunyuan reference image is invalid or too large."})
                        return
                resolution = str(params.get("Resolution") or "")
                if resolution and not re.fullmatch(r"\d{3,4}:\d{3,4}", resolution):
                    self._json(HTTPStatus.BAD_REQUEST, {"error": "Tencent Hunyuan image resolution must look like 720:1280."})
                    return
            try:
                secret_id, secret_key = _tencent_cloud_credentials(envelope)
                with _tencent_cloud_request(
                    action, params, secret_id, secret_key,
                    host=TENCENT_IMAGE_HOST, service="aiart",
                    version=TENCENT_IMAGE_VERSION, region=TENCENT_IMAGE_REGION,
                ) as upstream:
                    response_body = upstream.read(MAX_MODEL_RESPONSE_BYTES + 1)
                    if len(response_body) > MAX_MODEL_RESPONSE_BYTES:
                        self._json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "Model response is too large."})
                        return
                    self._raw_bytes(getattr(upstream, "status", HTTPStatus.OK), response_body, upstream.headers.get("Content-Type", "application/json"))
            except HTTPError as error:
                response_body = error.read(MAX_MODEL_RESPONSE_BYTES)
                self._raw_bytes(error.code, response_body, error.headers.get("Content-Type", "application/json"))
            except (ValueError, URLError, TimeoutError, OSError) as error:
                self._json(HTTPStatus.BAD_GATEWAY, {"error": "Tencent image request failed.", "detail": str(error)})
            return

        if provider == "video" and base.hostname == "ark.cn-beijing.volces.com":
            if base.path.rstrip("/") != "/api/plan/v3" or endpoint != AGENT_PLAN_VIDEO_ENDPOINT:
                self._json(HTTPStatus.FORBIDDEN, {"error": "Video generation is restricted to the Agent Plan /api/plan/v3 endpoint."})
                return
            if not isinstance(payload, dict) or payload.get("model") not in AGENT_PLAN_VIDEO_MODELS:
                self._json(HTTPStatus.BAD_REQUEST, {"error": "Unsupported Agent Plan video model."})
                return

        if provider == "video" and base.hostname == "open.bigmodel.cn":
            if base.path.rstrip("/") != ZHIPU_VIDEO_BASE_PATH or endpoint != ZHIPU_VIDEO_ENDPOINT:
                self._json(HTTPStatus.FORBIDDEN, {"error": "Zhipu video generation is restricted to /api/paas/v4/videos/generations."})
                return
            if not isinstance(payload, dict) or str(payload.get("model") or "") not in ZHIPU_VIDEO_MODELS:
                self._json(HTTPStatus.BAD_REQUEST, {"error": "Unsupported Zhipu video model."})
                return

        if provider == "image" and base.hostname == "open.bigmodel.cn":
            if base.path.rstrip("/") != ZHIPU_VIDEO_BASE_PATH or endpoint != ZHIPU_IMAGE_ENDPOINT:
                self._json(HTTPStatus.FORBIDDEN, {"error": "Zhipu image generation is restricted to /api/paas/v4/images/generations."})
                return
            if not isinstance(payload, dict) or str(payload.get("model") or "") not in ZHIPU_IMAGE_MODELS:
                self._json(HTTPStatus.BAD_REQUEST, {"error": "Unsupported Zhipu image model."})
                return


        if not api_key:
            # 浏览器没传 Key：只有在「本机密钥 + 白名单地址」双匹配时才允许代填，
            # 否则本机密钥就成了任意目标的开放凭据。
            if not _server_secret_allowed(provider, base, endpoint):
                self._json(HTTPStatus.FORBIDDEN, {
                    "error": "Local credentials are restricted to their configured provider.",
                    "detail": "本机保存的密钥只能用于它对应的官方地址；当前地址不在白名单内，请在前端填入该通道的 API Key。",
                })
                return
            try:
                api_key = _clean_credential(_server_secret_for(provider, base), "本机保存的密钥")
            except ValueError as error:
                self._json(HTTPStatus.BAD_REQUEST, {"error": "Invalid local API key.", "detail": str(error)})
                return
        if not api_key:
            self._json(HTTPStatus.BAD_REQUEST, {
                "error": "No local API key is configured for this provider.",
                "detail": f"本机没有为 {provider} 通道保存可用密钥。可在设置页粘贴 Key，或把 ZHIPU_API_KEY 写进 .env.models.local 后重启服务。",
            })
            return

        target_url = base_url + endpoint
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        upstream_headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "XingheCommercialDirector/1.0",
        }
        if provider == "video" and (base.hostname == "dashscope.aliyuncs.com" or (base.hostname or "").endswith(".maas.aliyuncs.com")):
            upstream_headers["X-DashScope-Async"] = "enable"
            upstream_headers["X-DashScope-OssResourceResolve"] = "enable"
        request = Request(
            target_url,
            data=body,
            method="POST",
            headers=upstream_headers,
        )
        try:
            # 万相出一张 2K 参考图偶尔要 2 分钟以上，120 秒会把「慢」误判成失败。
            provider_timeout = 420 if provider == "image" else (240 if provider == "video" else 120)
            with urlopen(request, timeout=provider_timeout) as upstream:
                response_body = upstream.read(MAX_MODEL_RESPONSE_BYTES + 1)
                if len(response_body) > MAX_MODEL_RESPONSE_BYTES:
                    self._json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "Model response is too large."})
                    return
                self._raw_bytes(getattr(upstream, "status", HTTPStatus.OK), response_body,
                                upstream.headers.get("Content-Type", ""))
        except HTTPError as error:
            response_body = error.read(MAX_MODEL_RESPONSE_BYTES)
            self._raw_bytes(error.code, response_body, error.headers.get("Content-Type", ""))
        except (URLError, TimeoutError, OSError) as error:
            reason = error.reason if isinstance(error, URLError) else error
            _log_line("WARN", f"上游模型请求失败：{reason}")
            self._json(HTTPStatus.BAD_GATEWAY, {"error": "Model provider request failed.", "detail": str(reason)})


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=3005)
    parser.add_argument("--root", type=Path, default=DEFAULT_WEB_ROOT)
    return parser.parse_args()


def main():
    args = parse_args()
    web_root = args.root.resolve()
    if not (web_root / "index.html").is_file():
        print(json.dumps({"type": "error", "message": f"Missing web build: {web_root}"}, ensure_ascii=False), flush=True)
        return 2
    mimetypes.add_type("application/javascript", ".js")
    mimetypes.add_type("text/css", ".css")

    def handler(*handler_args, **handler_kwargs):
        return DirectorHandler(*handler_args, directory=str(web_root), **handler_kwargs)

    try:
        server = ThreadingHTTPServer((args.host, args.port), handler)
    except OSError:
        server = ThreadingHTTPServer((args.host, 0), handler)
    host, port = server.server_address[:2]
    _log_line("INFO", f"服务启动 http://{host}:{port}/ · python={sys.executable} · web_root={web_root}")
    print("@@DIRECTOR " + json.dumps({"type": "ready", "url": f"http://{host}:{port}/", "port": port}, ensure_ascii=False), flush=True)
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

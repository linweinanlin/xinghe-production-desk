"""星河制片台 · 出处校验与完整性检查。

先把话说明白，免得后面误会：

本仓库是「源码可见」而不是编译分发。任何人拿到源码，都能把下面这几段检查
直接删掉——所以这里的目标从来不是「让人无法改动」，那是 DRM，做不到也不该做。
这里真正干三件事：

1. **给出处**：``provenance/manifest.json`` 记录每个文件的 SHA-256，并用作者的
   私钥签名。任何人在没有私钥的情况下改了文件再重新签名，签名都对不上，
   于是「这份是不是官方构建」可以被第三方独立验证，不需要相信任何一方的话。
2. **留痕迹**：被改过的文件在启动时会被点名列出来，且界面上的署名与指纹随之变成
   「非官方构建」。删掉署名可以继续跑，但那就成了明确的违约证据（LICENSE 里写了）。
3. **可取证**：``author.CANARY`` 这串随机标记散落在前后端注释里。别人抄走代码时
   通常只删看得见的署名，看不见的标记会一起带走——它是「同源」的物证。

校验失败时的产品行为，见 ``app.py``：默认拦住并说明原因，同时给合法修改者留了
``XINGHE_DEV=1`` 这个开发开关。**不静默、不假装没问题**，是这里唯一的设计原则。
"""

from __future__ import annotations

import hashlib
import hmac
import json
from pathlib import Path
from typing import Any, Dict, List, Optional

try:  # 允许以包导入，也允许 tools/ 里直接按文件路径加进来
    from . import author
except ImportError:  # pragma: no cover - 脚本方式加载时的兜底
    import author  # type: ignore

ROOT = Path(__file__).resolve().parent.parent
MANIFEST_PATH = ROOT / "provenance" / "manifest.json"
PUBLIC_KEY_PATH = ROOT / "provenance" / "public-key.json"

# 只校验这些目录下的产物：前端资源、后端源码、外壳、上游许可文本。
# LICENSES/ 必须进清单：MIT 的唯一条件就是保留它，删了要能被指出来。
SEALED_DIRS = ("web", "provenance", "tools", "LICENSES")
SEALED_FILES = (
    "app.py",
    "launch.py",
    "director_server.py",
    "post_production.py",
    "inpainting.py",
    "sfx_library.py",
    "styles.qss",
    "requirements.txt",
    # 许可与署名文件也进清单：把 LICENSE / NOTICE 换掉或删掉，同样会被点出来。
    "LICENSE",
    "NOTICE",
    "THIRD_PARTY_NOTICES.md",
    "assets/app-icon.png",
    "assets/app-icon.ico",
    "启动星河制片台.bat",
)
# 这些路径即使出现在目录里也不进清单：用户产物、缓存、密钥、虚拟环境。
SKIP_PARTS = {
    ".git", ".cache", "__pycache__", "generated", "deliveries", "node_modules",
    "venv", ".venv", ".idea", "storage", "cache",
}
SKIP_SUFFIXES = {".pyc", ".pyo", ".log", ".tmp", ".local"}
# 清单自己不能被自己覆盖：这两个文件在签名之后才写出，进清单就会永远对不上。
SELF_SKIP = ("provenance/manifest.json", "provenance/public-key.json")

STATUS_OFFICIAL = "official"
STATUS_MODIFIED = "modified"
STATUS_UNSIGNED = "unsigned"

_DIGEST_INFO_SHA256 = bytes.fromhex("3031300d060960864801650304020105000420")


class Report:
    """一次校验的结果。字段名直白，界面直接读，不做二次解释。"""

    def __init__(self) -> None:
        self.status: str = STATUS_UNSIGNED
        self.signature_ok: bool = False
        self.checked: int = 0
        self.mismatched: List[str] = []
        self.missing: List[str] = []
        self.extra: List[str] = []
        self.notes: List[str] = []
        self.fingerprint: str = ""
        self.sealed_at: str = ""
        self.version: str = author.VERSION

    @property
    def ok(self) -> bool:
        return self.status == STATUS_OFFICIAL

    @property
    def headline(self) -> str:
        if self.status == STATUS_OFFICIAL:
            return f"官方构建 · 指纹 {self.fingerprint or '—'}"
        if self.status == STATUS_MODIFIED:
            return "已修改构建 · 非官方发布版本"
        return "未签名构建 · 开发版本"

    def details(self, limit: int = 8) -> str:
        lines: List[str] = []
        if self.mismatched:
            shown = self.mismatched[:limit]
            lines.append("以下文件的内容与签名清单不一致：")
            lines.extend(f"  · {name}" for name in shown)
            if len(self.mismatched) > limit:
                lines.append(f"  · 其余 {len(self.mismatched) - limit} 个文件相同情况")
        if self.missing:
            shown = self.missing[:limit]
            lines.append("以下文件在清单里，但磁盘上找不到：")
            lines.extend(f"  · {name}" for name in shown)
            if len(self.missing) > limit:
                lines.append(f"  · 其余 {len(self.missing) - limit} 个文件相同情况")
        if not self.signature_ok and self.status != STATUS_UNSIGNED:
            lines.append("清单签名无法用仓库内公钥验证：这份清单不是原作者签发的。")
        lines.extend(self.notes)
        return "\n".join(lines)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 256), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical(payload: Any) -> bytes:
    """签名与验签共用的序列化方式：键排序、无空格、UTF-8。"""
    return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def iter_sealed_files(root: Optional[Path] = None):
    """产出 (相对路径 posix 风格, 绝对路径)，跳过缓存与用户产物。"""
    base = Path(root or ROOT)
    for directory in SEALED_DIRS:
        folder = base / directory
        if not folder.is_dir():
            continue
        for path in sorted(folder.rglob("*")):
            if not path.is_file():
                continue
            relative = path.relative_to(base).as_posix()
            if relative in SELF_SKIP:
                continue
            relative_parts = set(path.relative_to(base).parts)
            if relative_parts & SKIP_PARTS:
                continue
            if path.suffix.lower() in SKIP_SUFFIXES:
                continue
            yield relative, path
    for name in SEALED_FILES:
        path = base / name
        if path.is_file():
            yield name, path


def build_manifest(root: Optional[Path] = None) -> Dict[str, Any]:
    """扫描磁盘，生成待签名的清单（不含 signature 字段）。"""
    files: Dict[str, Dict[str, Any]] = {}
    for relative, path in iter_sealed_files(root):
        files[relative] = {"sha256": sha256_file(path), "size": path.stat().st_size}
    return {
        "meta": {
            "product": author.PRODUCT,
            "product_en": author.PRODUCT_EN,
            "version": author.VERSION,
            "author": author.AUTHOR,
            "homepage": author.HOMEPAGE,
            "license": author.LICENSE_NAME,
            "canary": author.CANARY,
            "algorithm": "RSASSA-PKCS1-v1_5 / SHA-256",
            "note": "清单覆盖 web/ 与后端源码；改任何字节都会让签名对不上。",
        },
        "files": files,
    }


def fingerprint_of(payload: Dict[str, Any]) -> str:
    """整个清单的指纹：12 位十六进制，显示在界面与关于对话框里。"""
    digest = hashlib.sha256(canonical(payload)).hexdigest()
    return digest[:12]


def _emsa_pkcs1_v15(digest: bytes, key_bytes: int) -> bytes:
    body = _DIGEST_INFO_SHA256 + digest
    if key_bytes < len(body) + 11:
        raise ValueError("RSA 模长不足")
    return b"\x00\x01" + b"\xff" * (key_bytes - len(body) - 3) + b"\x00" + body


def verify_signature(payload: Dict[str, Any], signature_hex: str, public_key: Dict[str, str]) -> bool:
    """纯标准库的 RSA 验签：只用到 pow()，不引入任何加密依赖。"""
    try:
        modulus = int(public_key["n"], 16)
        exponent = int(public_key["e"], 16)
        signature = int(signature_hex, 16)
        key_bytes = (modulus.bit_length() + 7) // 8
        if signature >= modulus:
            return False
        recovered = pow(signature, exponent, modulus).to_bytes(key_bytes, "big")
        expected = _emsa_pkcs1_v15(hashlib.sha256(canonical(payload)).digest(), key_bytes)
        return hmac.compare_digest(recovered, expected)
    except (KeyError, ValueError, TypeError):
        return False


def verify(root: Optional[Path] = None) -> Report:
    """校验当前磁盘上的构建是否与签名清单一致。"""
    base = Path(root or ROOT)
    report = Report()
    manifest_file = base / "provenance" / "manifest.json"
    if not manifest_file.is_file():
        report.notes.append("仓库里没有签名清单（provenance/manifest.json），按开发构建处理。")
        return report

    try:
        manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        report.status = STATUS_MODIFIED
        report.notes.append(f"签名清单无法解析：{error}")
        return report

    files = manifest.get("files") or {}
    meta = manifest.get("meta") or {}
    report.sealed_at = str(meta.get("sealed_at") or "")
    report.version = str(meta.get("version") or author.VERSION)
    payload = {key: value for key, value in manifest.items() if key != "signature"}
    report.fingerprint = str(meta.get("fingerprint") or fingerprint_of(payload))

    public_key_file = base / "provenance" / "public-key.json"
    try:
        public_key = json.loads(public_key_file.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        report.notes.append("缺少 provenance/public-key.json，无法验证签名。")
        report.status = STATUS_MODIFIED
        return report

    report.signature_ok = verify_signature(payload, str(manifest.get("signature") or ""), public_key)

    for relative, entry in sorted(files.items()):
        report.checked += 1
        target = base / relative
        if not target.is_file():
            report.missing.append(relative)
            continue
        expected = str((entry or {}).get("sha256") or "")
        if not expected:
            report.notes.append(f"清单里 {relative} 没有哈希值。")
            report.mismatched.append(relative)
            continue
        if sha256_file(target) != expected:
            report.mismatched.append(relative)

    sealed_names = set(files)
    for relative, _path in iter_sealed_files(base):
        if relative not in sealed_names:
            report.extra.append(relative)

    report.status = STATUS_OFFICIAL if (report.signature_ok and not report.mismatched and not report.missing) else STATUS_MODIFIED
    return report


def brief_stamp() -> str:
    """给日志用的一行摘要。"""
    item = verify()
    return f"{author.PRODUCT} v{author.VERSION} · {item.headline}"

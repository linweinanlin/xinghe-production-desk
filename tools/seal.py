"""给当前磁盘内容重新盖一次章：生成 SHA-256 清单并用作者私钥签名。

    python tools/seal.py                 # 正常盖章
    python tools/seal.py --key D:/k.json # 指定私钥位置

什么时候要跑：改了任何 web/ 或后端源码之后。**发布前必须跑一次**，
否则别人拿到的仓库在启动时会提示「已修改构建」。

盖章之后 `provenance/manifest.json` 会变化，记得一起提交。
"""

from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from provenance import author, guard  # noqa: E402


def sign(payload: dict, private_key: dict) -> str:
    modulus = int(private_key["n"], 16)
    exponent = int(private_key["d"], 16)
    key_bytes = (modulus.bit_length() + 7) // 8
    digest = hashlib.sha256(guard.canonical(payload)).digest()
    encoded = guard._emsa_pkcs1_v15(digest, key_bytes)
    signature = pow(int.from_bytes(encoded, "big"), exponent, modulus)
    return format(signature, "x")


def main() -> int:
    parser = argparse.ArgumentParser(description="生成并签名 provenance/manifest.json")
    parser.add_argument("--key", default=str(Path.home() / ".xinghe" / "seal-key.json"),
                        help="私钥文件路径（默认 ~/.xinghe/seal-key.json）")
    args = parser.parse_args()

    key_path = Path(args.key)
    if not key_path.is_file():
        print(f"找不到私钥：{key_path}")
        print("先运行 python tools/keygen.py（只在作者自己的机器上跑一次）")
        return 2
    private_key = json.loads(key_path.read_text(encoding="utf-8"))

    manifest = guard.build_manifest(ROOT)
    manifest["meta"]["sealed_at"] = datetime.datetime.now(datetime.timezone.utc).astimezone().isoformat(timespec="seconds")
    manifest["meta"]["fingerprint"] = guard.fingerprint_of(manifest)
    signature = sign(manifest, private_key)
    manifest["signature"] = signature

    target = ROOT / "provenance" / "manifest.json"
    target.write_text(json.dumps(manifest, ensure_ascii=False, indent=1, sort_keys=True) + "\n", encoding="utf-8")

    # 顺手把公钥同步到仓库，避免私钥文件丢了以后无法验证旧清单
    public_path = ROOT / "provenance" / "public-key.json"
    if not public_path.is_file():
        public_path.write_text(json.dumps({
            "n": private_key["n"], "e": private_key["e"],
            "algorithm": "RSASSA-PKCS1-v1_5 / SHA-256",
        }, indent=2) + "\n", encoding="utf-8")

    report = guard.verify(ROOT)
    print(f"已盖章：{len(manifest['files'])} 个文件 · 指纹 {manifest['meta']['fingerprint']}")
    print(f"自检结果：{report.headline}")
    if report.mismatched or report.missing:
        print(report.details())
        return 1
    print(f"作者：{author.AUTHOR} · 版本 {author.VERSION}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""生成签名用的 RSA-2048 密钥对（只跑一次，作者本人跑）。

    python tools/keygen.py

私钥写到 ``~/.xinghe/seal-key.json``（**在仓库之外**，永远不要提交），
公钥写到 ``provenance/public-key.json``（随仓库发布，供任何人验签）。

为什么用非对称签名而不是 HMAC：HMAC 需要把密钥一起发出去才能校验，
发出去就等于公开，谁都能重新签名。只有「私钥离线、公钥公开」时，
「这份清单是不是作者签的」才能被第三方独立验证。

依赖只有标准库：素数用 Miller-Rabin 判，签名用 pow()。
"""

from __future__ import annotations

import json
import os
import secrets
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PRIVATE_PATH = Path.home() / ".xinghe" / "seal-key.json"
PUBLIC_PATH = ROOT / "provenance" / "public-key.json"

SMALL_PRIMES = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71,
                73, 79, 83, 89, 97, 101, 103, 107, 109, 113, 127, 131, 137, 139, 149, 151]


def is_probable_prime(number: int, rounds: int = 40) -> bool:
    if number < 2:
        return False
    for prime in SMALL_PRIMES:
        if number % prime == 0:
            return number == prime
    # number - 1 = d * 2**s
    odd = number - 1
    shift = 0
    while odd % 2 == 0:
        odd //= 2
        shift += 1
    for _ in range(rounds):
        witness = secrets.randbelow(number - 3) + 2
        value = pow(witness, odd, number)
        if value in (1, number - 1):
            continue
        for _ in range(shift - 1):
            value = pow(value, 2, number)
            if value == number - 1:
                break
        else:
            return False
    return True


def random_prime(bits: int, exponent: int) -> int:
    while True:
        candidate = secrets.randbits(bits)
        # 最高两位置 1：保证 p*q 恰好是 2*bits 位，避免模长不足
        candidate |= (1 << (bits - 1)) | (1 << (bits - 2)) | 1
        if (candidate - 1) % exponent == 0:
            continue
        if is_probable_prime(candidate):
            return candidate


def main() -> int:
    if PRIVATE_PATH.exists():
        print(f"私钥已存在，不覆盖：{PRIVATE_PATH}")
        print("确需更换（会让历史清单全部失效）请先手动删除它。")
        return 1

    bits = 2048
    exponent = 65537
    print("正在生成 2048 位密钥对，通常几秒钟…")
    p = random_prime(bits // 2, exponent)
    q = random_prime(bits // 2, exponent)
    while q == p:
        q = random_prime(bits // 2, exponent)
    modulus = p * q
    phi = (p - 1) * (q - 1)
    private_exponent = pow(exponent, -1, phi)

    PRIVATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    PRIVATE_PATH.write_text(json.dumps({
        "n": format(modulus, "x"),
        "e": format(exponent, "x"),
        "d": format(private_exponent, "x"),
        "p": format(p, "x"),
        "q": format(q, "x"),
        "note": "私钥：只在签清单时用，绝不提交、绝不外发。",
    }, indent=2), encoding="utf-8")
    try:
        os.chmod(PRIVATE_PATH, 0o600)
    except OSError:
        pass

    PUBLIC_PATH.write_text(json.dumps({
        "n": format(modulus, "x"),
        "e": format(exponent, "x"),
        "author": "见 provenance/author.py",
        "algorithm": "RSASSA-PKCS1-v1_5 / SHA-256",
        "note": "公钥：随仓库发布，任何人可用它验证 provenance/manifest.json 是不是作者签的。",
    }, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    print(f"私钥：{PRIVATE_PATH}")
    print(f"公钥：{PUBLIC_PATH}")
    print("下一步：python tools/seal.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())

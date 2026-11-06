"""一次性替换作者占位符，省得在 LICENSE / NOTICE / README / 前端里四处改漏。

    python tools/set-author.py                      # 交互式
    python tools/set-author.py --name 张三 --github zhangsan --email a@b.com

会改写：
    provenance/author.py（AUTHOR / GITHUB_USER / CONTACT_EMAIL）
    LICENSE、NOTICE、README.md、THIRD_PARTY_NOTICES.md
    web/index.html、web/assets/app.js（页脚署名）

改完记得 python tools/seal.py 重新盖章。
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NAME_TOKEN = "【你的名字】"
GITHUB_TOKEN = "【你的 GitHub 用户名】"

TEXT_FILES = (
    "LICENSE", "NOTICE", "README.md", "THIRD_PARTY_NOTICES.md",
    "web/index.html", "web/assets/app.js", "web/assets/provider-schema.js",
    "web/assets/storyboard-core.js", "web/assets/styles.css", "web/assets/refresh.css",
    "web/assets/model-config.css",
)


def replace_in_file(path: Path, name: str, github: str) -> bool:
    if not path.is_file():
        return False
    text = path.read_text(encoding="utf-8")
    updated = text.replace(NAME_TOKEN, name).replace(GITHUB_TOKEN, github)
    if updated == text:
        return False
    path.write_text(updated, encoding="utf-8")
    return True


def patch_author_py(name: str, github: str, email: str) -> bool:
    path = ROOT / "provenance" / "author.py"
    text = path.read_text(encoding="utf-8")
    updated = text
    updated = re.sub(r'^AUTHOR = .*$', f'AUTHOR = {name!r}', updated, flags=re.M)
    updated = re.sub(r'^GITHUB_USER = .*$', f'GITHUB_USER = {github!r}', updated, flags=re.M)
    updated = re.sub(r'^CONTACT_EMAIL = .*$', f'CONTACT_EMAIL = {email!r}', updated, flags=re.M)
    if updated == text:
        return False
    path.write_text(updated, encoding="utf-8")
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description="替换作者署名占位符")
    parser.add_argument("--name", help="你的名字或昵称，会出现在界面页脚与每个源文件头")
    parser.add_argument("--github", help="GitHub 用户名，用于生成仓库地址")
    parser.add_argument("--email", default="", help="接收授权申请的邮箱（可留空，走 GitHub Issues）")
    args = parser.parse_args()

    name = (args.name or input(f"署名（当前占位符 {NAME_TOKEN}）：").strip()).strip()
    github = (args.github or input(f"GitHub 用户名（当前占位符 {GITHUB_TOKEN}）：").strip()).strip()
    if not name or not github:
        print("署名与 GitHub 用户名都不能为空。")
        return 2
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", github):
        print("GitHub 用户名只能包含字母、数字、下划线、点和连字符。")
        return 2

    if not patch_author_py(name, github, args.email.strip()):
        print("provenance/author.py 看起来已经被改过了，跳过。")
    changed = [relative for relative in TEXT_FILES if replace_in_file(ROOT / relative, name, github)]

    print(f"署名：{name}")
    print(f"仓库：https://github.com/{github}/xinghe-production-desk")
    print("改写文件：" + ("、".join(changed) if changed else "无（可能已经替换过）"))
    print("下一步：python tools/seal.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())

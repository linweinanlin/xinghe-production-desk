"""星河制片台 · 出处信息（唯一需要你改的地方）。

发布到 GitHub 之前，只改这一个文件里的四个值，然后运行：

    python tools/set-author.py

它会把 LICENSE / NOTICE / README 里的占位符一起替换掉，避免四处改漏。

改完之后再运行一次 `python tools/seal.py` 重新签名清单。
"""

from __future__ import annotations

# 你的署名：出现在界面页脚、关于对话框、LICENSE 与每一个源文件头。
AUTHOR = 'linweinanlin'

# GitHub 用户名与仓库名：决定 README 徽章、克隆地址、授权申请入口。
GITHUB_USER = 'linweinanlin'
REPO_NAME = "xinghe-production-desk"

# 接受授权申请的邮箱。留空则指向 GitHub Issues。
CONTACT_EMAIL = '155627020+linweinanlin@users.noreply.github.com'

# 版权起始年份。
YEAR = "2026"

# 产品信息
PRODUCT = "星河制片台"
PRODUCT_EN = "Xinghe Production Desk"
VERSION = "2.0.0"
TAGLINE = "从文字到镜头，把创作变成可控生产"

# 许可模式：源码可见，复制需授权。详见 LICENSE。
LICENSE_NAME = "Xinghe Source-Available License 1.0"
LICENSE_SUMMARY = (
    "源码公开可读、可学习、可自行使用；复制代码另行发布、改名分发、"
    "商用或提供在线服务，需取得作者书面许可。"
)

# 溯源标记：随机串，散落在前端与后端注释里。
# 别人抄走并删掉署名时，这些串通常会被一起带走——它们是「同源」的物证。
# 不要修改已发布的标记，否则会与历史版本对不上。
CANARY = "XHPD-2026-7f3c91a4d0e5b28c"
CANARY_SHORT = "7f3c91a4"

HOMEPAGE = f"https://github.com/{GITHUB_USER}/{REPO_NAME}"

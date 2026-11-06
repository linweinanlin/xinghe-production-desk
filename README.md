# 星河制片台 · Xinghe Production Desk

> 从文字到镜头，把创作变成可控生产。

一个**跑在本机**的 AI 漫剧/短剧生产台：项目 → 剧本 → 角色资产 → 分镜 → 生成 → 质检 → 交付，
一条链路走完。前端是原生 HTML/CSS/JS，后端是你自己电脑上的一个 Python 进程，
模型调用走你自己的 API Key。

- 不需要登录，没有云端账号，项目数据存在本机
- 界面与后端分离：`web/` 是静态站，`director_server.py` 只做本机 HTTP 服务
- 模型通道可插拔：对话 / 图片 / 视频三大模块，每家服务商一个子模块，参数在界面里配

> **来源**：本仓库是上游项目「Automation Workflow / commercial_director」的衍生作品，
> 上游代码以 **MIT** 发布（`Copyright (c) 2026 AI Drama Pipeline contributors`），
> 全文见 [LICENSES/AI-Drama-Pipeline-MIT.txt](LICENSES/AI-Drama-Pipeline-MIT.txt)。
>
> **许可**：新增部分源码可见，但**不是开源软件**，复制、改名分发、商用需取得维护者书面许可；
> 上游 MIT 部分不受此限制（MIT 允许商用与再分发，只要求保留原版权声明）。
> 边界见 [LICENSE](LICENSE) 第十条，申请授权看[这里](#申请授权)。

---

## 1. 它能做什么

| 模块 | 能力 |
|---|---|
| 项目与剧本 | 多项目 / 多集管理，剧本拆解为节拍，全局设定与画风约束 |
| 角色与场景资产 | 参考图上传、九宫格切分、角色锁定（同一角色跨镜头一致性） |
| 分镜导演 | 自动分镜、镜头参数（景别/运动/时长）、首帧与尾帧、镜头链继承 |
| 生成执行 | 图生视频 / 文生视频，逐镜头重试，任务台账与失败原因留痕 |
| 质检 | 黑帧、模糊、时长、音轨、人脸一致性检查，可补做不重跑 |
| 交付 | FFmpeg 合片、配音、字幕、封面、剪映草稿导出 |
| 模型与设置 | 四级配置树：模块 → 服务商 → 模型 → 参数，改完即刻生效 |

支持的服务商（按模块）：DeepSeek、OpenAI、火山方舟 / 阿里云百炼、智谱、腾讯云混元、
MiniMax 海螺。**没配 Key 也能打开界面**，只是不能生成。

## 2. 快速开始

环境要求：Windows 10/11（主要开发平台），Python 3.9–3.12，FFmpeg 在 PATH 里。

> **Python 版本坑**：3.14 上 PySide6 目前只装得到 Essentials，缺 `QWebEngineCore`
> （QtWebEngine 在 Addons 包里），启动会报 `ModuleNotFoundError: PySide6.QtWebEngineCore`。
> 遇到就把虚拟环境换成 3.9 / 3.11 / 3.12，或手动 `pip install PySide6-Addons==6.10.3`。

```bash
git clone https://github.com/linweinanlin/xinghe-production-desk.git
cd xinghe-production-desk

python -m venv .venv
.venv\Scripts\activate          # macOS/Linux: source .venv/bin/activate

pip install -r requirements.txt
python launch.py                # 或双击 启动星河制片台.bat
```

首次启动会自动拉起本机服务并打开窗口。窗口标题栏右侧的「启动 / 重载」可以
在后端改动后一键重启；改前端不用手动刷新（会自动检测并刷新页面）。

### 配置模型密钥

复制模板，把你自己的 Key 填进去：

```bash
copy .env.models.example .env.models.local
```

```ini
DEEPSEEK_API_KEY=          # 对话（剧本拆解、分镜）
ARK_API_KEY=               # 火山方舟（Seedream 出图）
DASHSCOPE_API_KEY=         # 阿里云百炼（万相：出图 + 出片）
ZHIPU_API_KEY=             # 智谱（CogView / CogVideoX）
TENCENTCLOUD_SECRET_ID=    # 腾讯云混元生视频
TENCENTCLOUD_SECRET_KEY=
```

也可以只在界面「模型与设置」里粘贴——那样密钥只存在当前 WebEngine 会话里，
关掉就没了。**`.env.models.local` 已被 .gitignore 忽略，不会被提交。**

## 3. 目录结构

```
星河制片台/
├── launch.py               双击入口（异常写 startup.log）
├── app.py                  PySide6 外壳：拉起服务 + 嵌 WebEngine
├── director_server.py      本机 HTTP 服务：所有 /api/* 与静态资源
├── post_production.py      合片、配音、字幕、封面、草稿导出
├── inpainting.py           局部重绘（补背景、去水印痕迹）
├── sfx_library.py          音效库合成
├── styles.qss              外壳样式
├── web/                    前端静态站（index.html + assets/）
│   └── assets/             app.js、样式、模型层级表、图标
├── provenance/             出处与完整性校验
│   ├── author.py           作者信息（唯一需要改的地方）
│   ├── guard.py            校验逻辑（SHA-256 + RSA 验签）
│   ├── manifest.json       签名清单
│   └── public-key.json     公钥
├── tools/
│   ├── keygen.py           生成签名密钥对（只跑一次）
│   ├── seal.py             重新盖章
│   ├── set-author.py       一次性替换作者占位符
│   ├── import-workspace.py 从另一个安装导入项目、配置与媒体
│   └── ui_settings_probe.js 「模型与设置」界面回归探针
├── LICENSE / NOTICE / THIRD_PARTY_NOTICES.md
└── requirements.txt
```

## 4. 架构要点

**外壳不碰业务。** `app.py` 只负责三件事：挑一个装了 OpenCV 的解释器、把
`director_server.py` 拉起来、把 `http://127.0.0.1:端口/` 塞进 `QWebEngineView`。
业务逻辑全在前端与 `director_server.py`，想换外壳（比如做成 Electron 或纯浏览器版）
不用动业务。

**服务只监听本机。** 默认 `127.0.0.1`，端口被占用时自动换一个，通过 stdout 的
`@@DIRECTOR {"type":"ready",...}` 把真实地址回传给外壳。

**状态落在本机。** 项目与配置写在 `.cache/commercial-director-workspace.json`，
接口是 `/api/workspace-snapshot`。前端 `localStorage` 只是镜像——桌面壳启动时
以快照为准，手改 localStorage 会被覆盖。

**模型通道是数据不是代码。** `web/assets/provider-schema.js` 是界面唯一数据源
（模块 → 服务商 → 模型 → 参数）。加一家服务商只需要在 schema 里加一条，
设置页的树、表单、校验会自动长出来。

## 5. 防抄袭与出处

先说清楚边界：**这是源码可见的项目，任何技术手段都挡不住有心人改代码。**
能做的只有三件事——给出处、留痕迹、能取证。本项目做了：

| 机制 | 在哪 | 作用 |
|---|---|---|
| 许可证 | `LICENSE` | 法律依据。复制、改名、商用、再分发需书面许可 |
| 文件头署名 | 每个源码文件 | 删掉即违约，且是明显痕迹 |
| 界面署名 | 页脚 + 「关于」 | 常驻可见，含作者、版本、构建指纹 |
| 签名清单 | `provenance/manifest.json` | 每个文件的 SHA-256，用作者私钥签名 |
| 启动校验 | `app.py` → `guard.py` | 文件被改动会点名列出来，默认拦截启动 |
| 溯源标记 | `author.CANARY` | 随机串散落在注释里，抄走时通常一起带走，是「同源」物证 |

**为什么用非对称签名**：HMAC 要把密钥发给所有人才能验证，等于公开；只有
「私钥离线、公钥随仓库」时，第三方才能独立验证「这份清单是不是作者签的」。
验签只用标准库（`pow()` + PKCS#1 v1.5），不引入加密依赖。

被改动后仍想运行的合法场景（自己改着玩、二次开发），两种方式：

```bash
set XINGHE_DEV=1 && python launch.py     # 本次会话跳过校验
```

或在拦截弹窗里选「以开发模式继续」。此时页脚会一直显示「已修改构建」。

## 6. 申请授权

- 提 Issue：<https://github.com/linweinanlin/xinghe-production-desk/issues>（标题注明「授权申请」）
- 说明：使用场景、分发范围、是否商用

许可范围以作者书面回复为准。个人学习、跑通流程、自己出片，不需要申请。

## 7. 发布前清单（作者自己看）

1. 改 `provenance/author.py` 里的 `AUTHOR` / `GITHUB_USER` / `CONTACT_EMAIL` / `YEAR`
2. 跑 `python tools/set-author.py` 同步替换 LICENSE / NOTICE / README 里的占位符
3. 跑 `python tools/seal.py` 重新盖章（改了任何前端或后端文件都要重跑）
4. 确认 `.env.models.local`、`.cache/`、`web/generated/` 没被提交
5. 私钥 `~/.xinghe/seal-key.json` **永远不要提交**，丢了就再也签不出可验证的新清单

想改成真正的开源许可（允许自由使用与分发，只要求保留署名）：

> 把 `LICENSE` 换成 AGPL-3.0，删掉 README 第 1 节的「不是开源软件」表述，
> 其余机制（签名清单、署名、溯源标记）都可以原样保留——它们与开源并不冲突。

## 8. 常见问题

**双击没反应？** 看 `startup.log`。多半是依赖没装（`pip install -r requirements.txt`）。

**窗口显示「构建校验未通过」？** 你改过 `web/` 或后端文件。自用选「以开发模式继续」，
要发布就重新 `python tools/seal.py`。

**生成失败但界面没报错？** 打开「设置 → 模型与设置」看配置校验区，再点窗口的
「启动 / 重载」重启服务，日志在 `.cache/` 下。

**项目列表里少了好几个项目？** 本软件把数据存在**自己目录下**的
`.cache/commercial-director-workspace.json`，不写系统全局目录。所以换一个安装目录打开，
看到的是那套安装自己的数据；如果那里还是空的，界面会生成一个示例项目顶上，看上去就像
「项目丢了」。数据一直在原地，搬过来即可（先退出软件）：

```bash
python tools/import-workspace.py --from "旧安装目录" --replace --with-media
# 只想补几个、不动现有项目：      --merge
# 连接正在运行的实例写入：        --port 3015
# 先看看会发生什么：              --dry-run
```

`--with-media` 会把项目引用到的 `/api/local-media/*` 与 `/generated/*` 一起复制
（只复制被引用的文件；媒体目录常有几个 GB，不会整目录搬）。写入前会自动备份到
`.cache/*.before-import-<时间戳>`。

**能不能不用桌面外壳，直接用浏览器？**

```bash
python director_server.py --port 3015
# 然后浏览器打开 http://127.0.0.1:3015/
```

前端功能完整，只有「保存文件」这类动作会走浏览器自己的下载逻辑。

## 9. 许可

本仓库的权利状态是**两层**的，不要混为一谈：

| 部分 | 许可 | 能做什么 |
|---|---|---|
| 上游代码（`web/`、`director_server.py`、`post_production.py` 等源自 Automation Workflow / commercial_director 的文件） | **MIT**，`Copyright (c) 2026 AI Drama Pipeline contributors`，全文见 [LICENSES/](LICENSES/AI-Drama-Pipeline-MIT.txt) | 可自由使用、修改、分发、商用，**唯一条件**是保留原版权声明与 MIT 全文 |
| 本仓库新增与修改的部分（桌面外壳、`provenance/`、`tools/`、模型配置层与样式等） | [星河制片台源码许可协议 1.0](LICENSE)：源码可见，复制与再分发需授权 | 可读、可自用、可自己改；对外复制、改名分发、商用需书面许可 |

冲突时以上游 MIT 为准，详见 [LICENSE](LICENSE) 第十条。
第三方组件与设计参考见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

**如果你要商用**：上游部分本来就允许商用，但必须保留 MIT 声明与全文；同时注意
PySide6/Qt 是 LGPL-3.0、FFmpeg 视构建可能是 GPL、各模型服务商的商用条款不同，
以及在国内向公众提供生成式 AI 服务涉及备案与内容标识义务。这几项比代码许可更容易卡住产品。

模型生成内容、用户上传素材的权利与合规责任由使用者自行承担。

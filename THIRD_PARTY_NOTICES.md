# 第三方组件与设计参考

本仓库**包含上游 MIT 代码**，并依赖若干第三方运行库。下列内容均已注明来源与许可；
本仓库新增的部分见 LICENSE 与 NOTICE。

## 上游代码（本仓库的衍生来源）

| 来源 | 覆盖范围 | 许可 |
|---|---|---|
| Automation Workflow / commercial_director<br>`Copyright (c) 2026 AI Drama Pipeline contributors` | `web/`（前端静态站）、`director_server.py`、`post_production.py`、`inpainting.py`、`sfx_library.py` 等 | MIT（全文见 [LICENSES/AI-Drama-Pipeline-MIT.txt](LICENSES/AI-Drama-Pipeline-MIT.txt)） |

按 MIT 的要求，分发本软件时必须保留上述版权声明与许可全文，不得删除或替换。
MIT 不授予商标权；「星河制片台」等名称若来自上游，商用前应改用自有名称。

## 运行库

| 组件 | 用途 | 许可 |
|---|---|---|
| [PySide6 / Qt 6](https://www.qt.io/qt-for-python) | 桌面外壳（窗口、WebEngine） | LGPL-3.0（动态链接；商用分发需遵守 LGPL 条款） |
| [opencv-python](https://github.com/opencv/opencv-python) | 抽帧、画质检测、人脸检测 | Apache-2.0 |
| [NumPy](https://numpy.org/) | 数值计算 | BSD-3-Clause |
| [requests](https://requests.readthedocs.io/) | 与模型服务通信 | Apache-2.0 |
| [faster-whisper](https://github.com/SYSTRAN/faster-whisper)（可选） | 本地语音转写 | MIT |
| [FFmpeg](https://ffmpeg.org/)（外部可执行文件） | 合片、转码、抽音轨 | LGPL/GPL（取决于构建；由用户自行安装） |

## 设计参考（未复制代码）

- [ai-montage-agent](https://github.com/search?q=ai-montage-agent&type=repositories)：分析、时间线决策与渲染分层的设计思路。
- [videoWater](https://github.com/suifengqjn/videoWater)：批量处理、布局、字幕与图文合成的模块划分思路。
- [pyJianYingDraft](https://github.com/GuanYixuan/pyJianYingDraft)：草稿轨道、微秒时间范围与关键帧结构。
- [librosa](https://librosa.org/doc/main/api/generated/librosa.beat.beat_track.html)：BPM / 节拍 / RMS 能量分析接口。
- [PySceneDetect](https://www.scenedetect.com/docs/api.html)：ContentDetector / ThresholdDetector 镜头检测接口。

## AI 模型服务

对话、图片、视频能力通过用户自己的 API Key 调用第三方服务（DeepSeek、火山方舟、
阿里云百炼、智谱开放平台、腾讯云混元、OpenAI、MiniMax 等）。
生成内容与调用行为受各服务商条款约束，本项目不代持密钥、不转售额度。

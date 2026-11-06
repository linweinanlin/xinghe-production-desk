"""星河制片台 · 独立桌面外壳（PySide6）。

这个文件只做一件事：把一个本机 HTTP 服务（director_server.py）和一个前端静态站
（web/）装进一个窗口，并负责它们的生命周期。业务逻辑一律不在这里。

三层关系：

    app.py（本文件，Qt 外壳）  →  拉起 director_server.py（本机服务，随机端口）
                              →  用 QWebEngineView 打开 http://127.0.0.1:port/

刻意保留的几处「不优雅」都是有原因的，改动前请先读括号里的说明：
· 解释器要挑（不同 Python 装的 OpenCV 能力不同，缺人脸检测会静默降级）；
· 前端一改就自动刷新、后端一改就自动重启（否则「代码换了窗口还是旧的」）；
· 启动时校验签名清单（见 provenance/guard.py，这是出处声明的一部分）。

Copyright (c) 2026 星河制片台作者。源码可见，复制需授权，详见 LICENSE。
"""

from __future__ import annotations

import codecs
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

from PySide6.QtCore import QProcess, QProcessEnvironment, QStandardPaths, Qt, QTimer, QUrl, Signal
from PySide6.QtGui import QDesktopServices, QFont, QIcon, QKeySequence, QShortcut
from PySide6.QtWebEngineCore import QWebEnginePage, QWebEngineProfile, QWebEngineSettings
from PySide6.QtWebEngineWidgets import QWebEngineView
from PySide6.QtWidgets import (QApplication, QDialog, QFileDialog, QFrame, QHBoxLayout,
                               QInputDialog, QLabel, QMainWindow, QMessageBox, QPlainTextEdit,
                               QPushButton, QStackedWidget, QVBoxLayout, QWidget)

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from provenance import author, guard  # noqa: E402

SERVICE_ENTRY = ROOT / "director_server.py"


# ──────────────────────────────────────────────────────────────────────
# 通用小工具
# ──────────────────────────────────────────────────────────────────────
def label(text, name=None):
    result = QLabel(text)
    if name:
        result.setObjectName(name)
    return result


def button(text, callback=None, name=None):
    result = QPushButton(text)
    if callback:
        result.clicked.connect(callback)
    if name:
        result.setObjectName(name)
    result.setCursor(Qt.CursorShape.PointingHandCursor)
    return result


def configure_process(process):
    env = QProcessEnvironment.systemEnvironment()
    env.insert("PYTHONIOENCODING", "utf-8")
    env.insert("PYTHONUNBUFFERED", "1")
    process.setProcessEnvironment(env)
    process.setWorkingDirectory(str(ROOT))
    process.setProcessChannelMode(QProcess.ProcessChannelMode.MergedChannels)


def _interpreter_candidates():
    """可能用来跑本机服务的解释器，按可信度排序。"""
    seen = []
    executable = Path(sys.executable)
    base_executable = Path(getattr(sys, "_base_executable", executable))
    for candidate in (executable.with_name("python.exe"), base_executable.with_name("python.exe"),
                      executable, base_executable):
        if candidate.is_file() and candidate not in seen:
            seen.append(candidate)
    for name in ("python.exe", "python3.exe"):
        resolved = shutil.which(name)
        if resolved:
            path = Path(resolved)
            if path.is_file() and path not in seen:
                seen.append(path)
    return seen


def _interpreter_score(executable: Path) -> int:
    """2 = 这份 OpenCV 能跑真的人脸检测；1 = 只能跑基础功能；-1 = 跑不起来。"""
    model = ROOT / "assets" / "models" / "face_detection_yunet_2023mar.onnx"
    probe = (
        "from pathlib import Path\n"
        "import cv2, numpy\n"
        f"model = Path(r'{model}')\n"
        "cascades = Path(getattr(getattr(cv2, 'data', None), 'haarcascades', '') or '')\n"
        "haar = hasattr(cv2, 'CascadeClassifier') and (cascades / 'haarcascade_frontalface_default.xml').is_file()\n"
        "yunet = model.is_file() and hasattr(cv2, 'FaceDetectorYN_create')\n"
        "print('CAPABLE' if (haar or yunet) else 'LIMITED')\n"
    )
    try:
        result = subprocess.run([str(executable), "-c", probe], capture_output=True, text=True,
                                encoding="utf-8", errors="replace", timeout=25, check=False)
    except (OSError, subprocess.SubprocessError):
        return -1
    if result.returncode != 0:
        return -1
    return 2 if "CAPABLE" in result.stdout else 1


def service_python_executable() -> str:
    """挑一个能力最强的解释器跑服务，并缓存结论（每次启动都探测会拖慢开窗）。"""
    cache_file = ROOT / ".cache" / "service-python.json"
    candidates = _interpreter_candidates()
    try:
        cached = json.loads(cache_file.read_text(encoding="utf-8"))
        chosen = Path(str(cached.get("path") or ""))
        probed = [Path(item) for item in cached.get("probed", [])]
        if chosen.is_file() and all(
            chosen.stat().st_mtime >= item.stat().st_mtime for item in probed if item.is_file()
        ):
            return str(chosen)
    except (OSError, ValueError, KeyError):
        pass

    best, best_score = None, -2
    for candidate in candidates:
        score = _interpreter_score(candidate)
        if score > best_score:
            best, best_score = candidate, score
        if score == 2:
            break
    if best is None:
        fallback = Path(sys.executable).with_name("python.exe")
        best = fallback if fallback.is_file() else Path(sys.executable)
    try:
        cache_file.parent.mkdir(parents=True, exist_ok=True)
        cache_file.write_text(json.dumps(
            {"path": str(best), "score": best_score, "probed": [str(item) for item in candidates]},
            ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError:
        pass
    return str(best)


DIALOG_STYLE = """
QDialog, QMessageBox { background: #0b1220; }
QLabel { color: #e6edfb; font-size: 13px; }
QTextBrowser, QPlainTextEdit { background: #0f1728; color: #dce6f8; border: 1px solid rgba(120, 165, 220, 0.28);
            border-radius: 8px; padding: 10px; }
QLineEdit { background: #0f1728; color: #f2f6ff; border: 1px solid rgba(120, 165, 220, 0.28);
            border-radius: 8px; padding: 8px 10px;
            selection-background-color: #45e3d1; selection-color: #06121a; }
QPushButton { background: rgba(255, 255, 255, 0.06); color: #e6edfb;
              border: 1px solid rgba(120, 165, 220, 0.28); border-radius: 8px;
              padding: 7px 18px; min-width: 76px; }
QPushButton:hover { background: rgba(69, 227, 209, 0.16); border-color: rgba(69, 227, 209, 0.55); }
QPushButton:default { background: #45e3d1; color: #06121a; border-color: #45e3d1; font-weight: 700; }
"""


def apply_dark_titlebar(widget):
    """Windows 原生标题栏默认浅色，深色弹窗会顶着一根白条。"""
    if sys.platform != "win32":
        return
    try:
        import ctypes
        enabled = ctypes.c_int(1)
        hwnd = int(widget.winId())
        for attribute in (20, 19):
            if ctypes.windll.dwmapi.DwmSetWindowAttribute(
                hwnd, attribute, ctypes.byref(enabled), ctypes.sizeof(enabled)) == 0:
                break
    except Exception:
        pass


# ──────────────────────────────────────────────────────────────────────
# JS 原生对话框汉化（QtWebEngine 默认弹的是带 URL 的浅色系统框）
# ──────────────────────────────────────────────────────────────────────
class DirectorWebPage(QWebEnginePage):
    def _dialog_parent(self):
        parent = self.parent()
        return parent.window() if isinstance(parent, QWidget) else None

    def javaScriptAlert(self, security_origin, msg):  # noqa: N802
        box = QMessageBox(self._dialog_parent())
        box.setWindowTitle(author.PRODUCT)
        box.setIcon(QMessageBox.Icon.Information)
        box.setText(msg)
        box.setStandardButtons(QMessageBox.StandardButton.Ok)
        box.button(QMessageBox.StandardButton.Ok).setText("知道了")
        box.setStyleSheet(DIALOG_STYLE)
        box.setMinimumWidth(420)
        apply_dark_titlebar(box)
        box.exec()

    def javaScriptConfirm(self, security_origin, msg):  # noqa: N802
        box = QMessageBox(self._dialog_parent())
        box.setWindowTitle("请确认")
        box.setIcon(QMessageBox.Icon.Question)
        box.setText(msg)
        box.setStandardButtons(QMessageBox.StandardButton.Ok | QMessageBox.StandardButton.Cancel)
        box.button(QMessageBox.StandardButton.Ok).setText("继续")
        box.button(QMessageBox.StandardButton.Cancel).setText("取消")
        box.setDefaultButton(QMessageBox.StandardButton.Ok)
        box.setStyleSheet(DIALOG_STYLE)
        box.setMinimumWidth(440)
        apply_dark_titlebar(box)
        return box.exec() == QMessageBox.StandardButton.Ok

    def javaScriptPrompt(self, security_origin, msg, default_value):  # noqa: N802
        dialog = QInputDialog(self._dialog_parent())
        dialog.setWindowTitle(author.PRODUCT)
        dialog.setLabelText(msg)
        dialog.setInputMode(QInputDialog.InputMode.TextInput)
        dialog.setTextValue(default_value or "")
        dialog.setOkButtonText("确定")
        dialog.setCancelButtonText("取消")
        dialog.setStyleSheet(DIALOG_STYLE)
        dialog.setMinimumWidth(480)
        apply_dark_titlebar(dialog)
        accepted = dialog.exec() == QDialog.DialogCode.Accepted
        return accepted, dialog.textValue() if accepted else ""


# ──────────────────────────────────────────────────────────────────────
# 主窗口
# ──────────────────────────────────────────────────────────────────────
class MainWindow(QMainWindow):
    fullScreenChanged = Signal(bool)

    def __init__(self, report: guard.Report):
        super().__init__()
        self.report = report
        self.url = QUrl()
        self.buffer = ""
        self.video_fullscreen = False
        self.decoder = codecs.getincrementaldecoder("utf-8")("replace")

        self.setWindowTitle(f"{author.PRODUCT} · {author.TAGLINE}")
        self.resize(1440, 920)
        self.setMinimumSize(1080, 700)
        icon_file = ROOT / "assets" / "app-icon.ico"
        if icon_file.is_file():
            self.setWindowIcon(QIcon(str(icon_file)))

        self.process = QProcess(self)
        configure_process(self.process)
        self.process.readyReadStandardOutput.connect(self.read_output)
        self.process.finished.connect(self.finished)
        self.process.errorOccurred.connect(self.process_error)

        central = QWidget()
        self.setCentralWidget(central)
        layout = QVBoxLayout(central)
        layout.setContentsMargins(18, 14, 18, 8)
        layout.setSpacing(10)

        # 顶栏：品牌 + 状态 + 常用动作
        header = QFrame()
        header.setObjectName("pathbar")
        self.header = header
        row = QHBoxLayout(header)
        row.setContentsMargins(18, 12, 14, 12)
        titles = QVBoxLayout()
        titles.setSpacing(3)
        titles.addWidget(label(f"{author.PRODUCT} · 商业工作台", "pageTitle"))
        titles.addWidget(label(f"{author.TAGLINE} · 项目 → 剧本 → 资产 → 分镜 → 生成 → 交付", "muted"))
        row.addLayout(titles, 1)
        self.status = label("尚未启动", "badge")
        row.addWidget(self.status)
        row.addWidget(button("启动 / 重载", self.restart, "ghost"))
        row.addWidget(button("刷新页面 ⟳", self.reload_page, "ghost"))
        row.addWidget(button("浏览器打开 ↗", self.open_browser, "ghost"))
        row.addWidget(button("源码目录", self.open_source, "ghost"))
        row.addWidget(button("使用许可", self.show_license, "ghost"))
        row.addWidget(button("关于", self.show_about, "ghost"))
        layout.addWidget(header)

        notice = label(
            "外部模型由你自行配置，密钥只保存在本机（.env.models.local 或当前会话），不会上传。"
            "本项目源码可见，复制与再分发需取得作者书面许可，详见「使用许可」。",
            "previewHint")
        notice.setWordWrap(True)
        self.notice = notice
        layout.addWidget(notice)

        # 加载页 / 浏览器
        self.pages = QStackedWidget()
        loading = QFrame()
        loading.setObjectName("previewArea")
        loading_box = QVBoxLayout(loading)
        loading_box.addStretch()
        self.loading_text = label("正在启动本机服务…", "muted")
        self.loading_text.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.loading_text.setWordWrap(True)
        loading_box.addWidget(self.loading_text)
        loading_box.addStretch()
        self.pages.addWidget(loading)

        profile = QWebEngineProfile("xinghe-production-desk", self)
        profile_root = ROOT / ".cache" / "web-profile"
        profile_root.mkdir(parents=True, exist_ok=True)
        profile.setPersistentStoragePath(str(profile_root / "storage"))
        profile.setCachePath(str(profile_root / "cache"))
        self.browser = QWebEngineView()
        page = DirectorWebPage(profile, self.browser)
        # 开源 QtWebEngine 默认关掉全屏支持，<video> 的全屏键会是死的
        page.settings().setAttribute(QWebEngineSettings.WebAttribute.FullScreenSupportEnabled, True)
        page.fullScreenRequested.connect(self.handle_full_screen_request)
        self.browser.setPage(page)
        self.browser.loadFinished.connect(self.load_finished)
        profile.downloadRequested.connect(self.handle_download)
        self.pages.addWidget(self.browser)
        layout.addWidget(self.pages, 1)

        # 页脚：署名与构建指纹常驻可见（删掉它就构成违约，LICENSE 里已写明）
        footer = QHBoxLayout()
        footer.setContentsMargins(6, 0, 6, 4)
        self.footer_left = label(
            f"© {author.YEAR} {author.AUTHOR} · {author.PRODUCT} v{author.VERSION} · "
            f"构建 {report.fingerprint or '未签名'} · {author.LICENSE_NAME}", "muted")
        footer.addWidget(self.footer_left, 1)
        self.footer_right = label(report.headline, "muted")
        footer.addWidget(self.footer_right)
        layout.addLayout(footer)

        # F5 / Ctrl+R 真的刷新内嵌页面
        for sequence in ("F5", "Ctrl+R"):
            shortcut = QShortcut(QKeySequence(sequence), self)
            shortcut.setContext(Qt.ShortcutContext.WindowShortcut)
            shortcut.activated.connect(self.reload_page)

        # 前端一改自动刷新、后端一改自动重启
        self.web_stamp = self.web_signature()
        self.server_stamp = self.server_signature()
        self.watcher = QTimer(self)
        self.watcher.setInterval(2500)
        self.watcher.timeout.connect(self.watch_build)
        self.watcher.start()

        self.start()

    # ── 变更检测 ──────────────────────────────────────────────
    @staticmethod
    def web_signature():
        """前端目录的最大 mtime + 文件数：新增文件也会被算进去。"""
        latest, count = 0.0, 0
        web = ROOT / "web"
        for path in web.rglob("*"):
            if path.suffix.lower() not in {".html", ".js", ".css", ".json"}:
                continue
            try:
                stat = path.stat()
            except OSError:
                continue
            count += 1
            latest = max(latest, stat.st_mtime)
        return f"{count}:{int(latest * 1000)}"

    @staticmethod
    def server_signature():
        parts = []
        for name in ("director_server.py", "post_production.py", "inpainting.py", "sfx_library.py"):
            try:
                stat = (ROOT / name).stat()
            except OSError:
                parts.append(f"{name}:0")
            else:
                parts.append(f"{name}:{int(stat.st_mtime)}:{stat.st_size}")
        return "|".join(parts)

    def watch_build(self):
        server = self.server_signature()
        if server != self.server_stamp:
            self.server_stamp = server
            self.web_stamp = self.web_signature()
            self.status.setText("后端已更新，正在重启")
            self.restart()
            return
        current = self.web_signature()
        if current != self.web_stamp:
            self.web_stamp = current
            if self.url.isValid() and self.process.state() == QProcess.ProcessState.Running:
                self.reload_page()

    # ── 服务进程 ──────────────────────────────────────────────
    def start(self):
        if self.process.state() != QProcess.ProcessState.NotRunning:
            if self.url.isValid():
                self.pages.setCurrentWidget(self.browser)
            return
        if not SERVICE_ENTRY.is_file():
            self.loading_text.setText(f"缺少 {SERVICE_ENTRY.name}，无法启动本机服务。")
            return
        self.buffer = ""
        self.decoder = codecs.getincrementaldecoder("utf-8")("replace")
        self.status.setText("正在启动")
        self.loading_text.setText("正在启动本机服务…")
        self.pages.setCurrentIndex(0)
        # 端口交给操作系统分配（--port 0）：
        # Windows 的 SO_REUSEADDR 允许两个进程同时绑同一个端口，用固定端口时
        # 若本机还开着别的版本，请求可能落到另一个进程上——界面看着对、数据不是这套。
        # 真实端口由服务端通过 @@DIRECTOR 回传，外壳不猜。
        self.process.start(service_python_executable(),
                           ["-u", str(SERVICE_ENTRY), "--port", "0"])

    def restart(self):
        if self.process.state() != QProcess.ProcessState.NotRunning:
            self.process.terminate()
            if not self.process.waitForFinished(1200):
                self.process.kill()
                self.process.waitForFinished(1200)
        self.url = QUrl()
        self.start()

    def read_output(self):
        self.buffer += self.decoder.decode(bytes(self.process.readAllStandardOutput()))
        while "\n" in self.buffer:
            line, self.buffer = self.buffer.split("\n", 1)
            if line.startswith("@@DIRECTOR "):
                try:
                    payload = json.loads(line[11:])
                except ValueError:
                    continue
                if payload.get("type") == "ready":
                    self.url = QUrl(payload["url"])
                    self.status.setText(f"本地运行 · {payload['port']}")
                    self.browser.setUrl(self.url)
                    self.pages.setCurrentWidget(self.browser)
            elif line.strip() and "Traceback" in line:
                self.loading_text.setText(line.strip()[-500:])

    def load_finished(self, ok):
        if ok:
            self.status.setText("本地运行")
        else:
            self.status.setText("页面加载失败")
            self.loading_text.setText("页面没有成功加载，请点击「启动 / 重载」。")

    def process_error(self, _error):
        self.status.setText("启动失败")
        self.loading_text.setText("本机服务启动失败：" + self.process.errorString())
        self.pages.setCurrentIndex(0)

    def finished(self, code, _status):
        if code != 0 and not self.url.isValid():
            self.status.setText("服务已退出")
            self.loading_text.setText("本机服务已退出，请点击「启动 / 重载」。")
            self.pages.setCurrentIndex(0)

    def reload_page(self):
        if not self.url.isValid():
            self.start()
            return
        page = self.browser.page()
        profile = page.profile() if page else None
        if profile is not None:
            profile.clearHttpCache()
        self.pages.setCurrentWidget(self.browser)
        self.status.setText("正在刷新界面")
        self.browser.reload()

    # ── 窗口行为 ──────────────────────────────────────────────
    def handle_full_screen_request(self, request):
        request.accept()
        self.apply_video_fullscreen(request.toggleOn())

    def apply_video_fullscreen(self, enabled):
        if enabled == self.video_fullscreen:
            return
        self.video_fullscreen = enabled
        self.header.setVisible(not enabled)
        self.notice.setVisible(not enabled)
        self.footer_left.setVisible(not enabled)
        self.footer_right.setVisible(not enabled)
        self.fullScreenChanged.emit(enabled)

    def handle_download(self, item):
        suggested = item.suggestedFileName() or "download.bin"
        downloads = QStandardPaths.writableLocation(QStandardPaths.StandardLocation.DownloadLocation)
        start_at = Path(downloads) / suggested if downloads else Path.home() / suggested
        target, _ = QFileDialog.getSaveFileName(self, "保存文件", str(start_at))
        if not target:
            item.cancel()
            self.status.setText("已取消下载")
            return
        path = Path(target)
        item.setDownloadDirectory(str(path.parent))
        item.setDownloadFileName(path.name)
        item.accept()
        self.status.setText(f"正在下载 {path.name}")

    def open_browser(self):
        if self.url.isValid():
            QDesktopServices.openUrl(self.url)
        else:
            self.start()

    def open_source(self):
        QDesktopServices.openUrl(QUrl.fromLocalFile(str(ROOT / "web")))

    # ── 许可与关于 ────────────────────────────────────────────
    def show_license(self):
        dialog = QDialog(self)
        dialog.setWindowTitle("使用许可")
        dialog.setMinimumSize(720, 560)
        dialog.setStyleSheet(DIALOG_STYLE)
        box = QVBoxLayout(dialog)
        box.setContentsMargins(20, 18, 20, 16)
        box.setSpacing(12)
        box.addWidget(label(f"{author.LICENSE_NAME} · {author.PRODUCT} v{author.VERSION}", "pageTitle"))
        summary = label(f"{author.LICENSE_SUMMARY}\n\n"
                        f"署名：{author.AUTHOR}　仓库：{author.HOMEPAGE}\n"
                        f"申请授权：{author.CONTACT_EMAIL or author.HOMEPAGE + '/issues'}", "muted")
        summary.setWordWrap(True)
        box.addWidget(summary)
        viewer = QPlainTextEdit()
        viewer.setReadOnly(True)
        license_file = ROOT / "LICENSE"
        viewer.setPlainText(license_file.read_text(encoding="utf-8") if license_file.is_file()
                            else "仓库里缺少 LICENSE 文件。")
        box.addWidget(viewer, 1)
        actions = QHBoxLayout()
        actions.addStretch()
        actions.addWidget(button("关闭", dialog.accept))
        box.addLayout(actions)
        apply_dark_titlebar(dialog)
        dialog.exec()

    def show_about(self):
        report = self.report
        lines = [
            f"{author.PRODUCT}（{author.PRODUCT_EN}）v{author.VERSION}",
            "",
            f"作者：{author.AUTHOR}",
            f"仓库：{author.HOMEPAGE}",
            f"许可：{author.LICENSE_NAME}",
            "",
            f"构建状态：{report.headline}",
            f"校验文件：{report.checked} 个",
        ]
        if report.sealed_at:
            lines.append(f"签章时间：{report.sealed_at}")
        detail = report.details()
        if detail:
            lines.extend(["", detail])
        lines.extend(["", f"溯源标记：{author.CANARY}"])
        box = QMessageBox(self)
        box.setWindowTitle("关于")
        box.setIcon(QMessageBox.Icon.Information)
        box.setText("\n".join(lines))
        box.setStandardButtons(QMessageBox.StandardButton.Ok)
        box.button(QMessageBox.StandardButton.Ok).setText("关闭")
        box.setStyleSheet(DIALOG_STYLE)
        box.setMinimumWidth(560)
        apply_dark_titlebar(box)
        box.exec()

    def request_close(self):
        self.browser.setUrl(QUrl("about:blank"))
        if self.process.state() != QProcess.ProcessState.NotRunning:
            self.process.terminate()
            if not self.process.waitForFinished(1200):
                self.process.kill()
                self.process.waitForFinished(1200)

    def closeEvent(self, event):  # noqa: N802
        self.request_close()
        super().closeEvent(event)


# ──────────────────────────────────────────────────────────────────────
# 启动
# ──────────────────────────────────────────────────────────────────────
def _set_windows_app_id():
    """任务栏图标默认跟着 pythonw.exe 走，得先声明应用身份。"""
    if sys.platform != "win32":
        return
    try:
        import ctypes
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("XingheStudio.ProductionDesk")
    except (AttributeError, OSError):
        pass


def enforce_provenance(report: guard.Report) -> bool:
    """返回 True 表示可以继续启动。

    只拦「有清单但内容对不上」这一种情况。没有清单是开发版本（clone 下来还没盖章），
    不属于篡改，不该拦启动——页脚会一直显示「未签名构建」，够清楚了。
    合法修改者（包括作者自己调前端）用 XINGHE_DEV=1 跳过，或在弹窗里当场选择继续。
    """
    if report.status != guard.STATUS_MODIFIED:
        return True
    if os.environ.get("XINGHE_DEV") == "1":
        return True
    box = QMessageBox()
    box.setWindowTitle("构建校验未通过")
    box.setIcon(QMessageBox.Icon.Warning)
    box.setText(f"{author.PRODUCT} 检测到当前文件与作者的签名清单不一致。\n\n{report.headline}")
    box.setInformativeText(
        (report.details() or "签名清单无法验证。") +
        "\n\n如果你只是自己修改使用，可以继续；如果把这份改动发给别人，"
        "请遵守 LICENSE：署名不可删除，再分发需要作者书面许可。")
    exit_button = box.addButton("退出", QMessageBox.ButtonRole.RejectRole)
    dev_button = box.addButton("以开发模式继续", QMessageBox.ButtonRole.AcceptRole)
    box.setDefaultButton(exit_button)
    box.setStyleSheet(DIALOG_STYLE)
    box.setMinimumWidth(620)
    apply_dark_titlebar(box)
    box.exec()
    if box.clickedButton() is dev_button:
        os.environ["XINGHE_DEV"] = "1"
        return True
    return False


def main() -> int:
    _set_windows_app_id()
    app = QApplication(sys.argv)
    app.setApplicationName(author.PRODUCT)
    app.setApplicationDisplayName(author.PRODUCT)
    app.setOrganizationName(author.PRODUCT_EN)
    icon_file = ROOT / "assets" / "app-icon.ico"
    if icon_file.is_file():
        app.setWindowIcon(QIcon(str(icon_file)))
    app.setStyle("Fusion")
    app.setFont(QFont("Microsoft YaHei UI", 10))
    style_file = ROOT / "styles.qss"
    if style_file.is_file():
        app.setStyleSheet(style_file.read_text(encoding="utf-8"))

    report = guard.verify()
    if not enforce_provenance(report):
        return 3

    window = MainWindow(report)
    window.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())

"""双击启动入口：异常写进 startup.log，pythonw 失败时也能看见原因。

用 pythonw 启动时没有控制台，任何 import 错误都会表现为「双击没反应」。
所以这里把 stdout/stderr 全量重定向到 startup.log，出错再弹一个消息框指路。
"""

from __future__ import annotations

import ctypes
import datetime
import os
import sys
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def main():
    os.chdir(str(ROOT))
    with (ROOT / "startup.log").open("a", encoding="utf-8", buffering=1) as log:
        old_stdout, old_stderr = sys.stdout, sys.stderr
        sys.stdout = sys.stderr = log
        print("\nSTART", datetime.datetime.now().isoformat(), sys.executable, flush=True)
        try:
            from app import main as run_app
            return run_app()
        except Exception:
            traceback.print_exc(file=log)
            log.flush()
            if os.name == "nt":
                ctypes.windll.user32.MessageBoxW(
                    None,
                    f"启动失败，错误详情已保存到：\n{ROOT / 'startup.log'}\n\n"
                    "常见原因：没有安装依赖（pip install -r requirements.txt）。",
                    "星河制片台", 0x10)
            return 1
        finally:
            sys.stdout, sys.stderr = old_stdout, old_stderr


if __name__ == "__main__":
    raise SystemExit(main())

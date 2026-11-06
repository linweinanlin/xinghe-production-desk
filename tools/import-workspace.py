"""从另一个安装导入工作区（项目 + 模型配置 + 媒体）。

## 为什么需要它

本软件把用户数据放在**安装目录自己的** `.cache/` 里，而不是系统全局目录——这样
复制一份工程就是一份独立的数据，不会互相踩。代价是：从旧安装（例如原「自动化工作流」
里的商业工作台）搬过来时，新安装看到的是一张白纸，于是会生成一个示例项目，
看起来就像「项目丢了」。

这个脚本负责把旧安装的项目搬过来，并顺手把项目引用的本地媒体一起搬走，
否则列表里有项目、点进去全是裂图。

## 用法

```bash
# 先关掉软件，再执行
python tools/import-workspace.py --from "D:/old/automation_workflow" --replace
python tools/import-workspace.py --from ".cache/backup.json" --merge --with-media
python tools/import-workspace.py --from "D:/old/install" --dry-run
```

- `--from`：旧安装目录（脚本自己去读 `.cache/commercial-director-workspace.json`），
  或直接给一个快照 json 文件。
- `--merge`（默认）：只补目标里没有的项目，保留现有项目与配置。
- `--replace`：用旧快照的项目与模型配置整体覆盖（示例项目会被丢掉），适合同一台
  机器搬家——本项目自带的示例项目没有保留价值。
- `--with-media`：把项目里引用到的 `/api/local-media/...` 与 `/generated/...`
  文件一并复制过来。只复制被引用的，不整目录搬（媒体目录常有几个 GB）。
- `--port`：软件正在运行时，通过 `POST /api/workspace-snapshot` 写入，避免被
  运行中的进程覆盖。不传则直接改文件。
- `--dry-run`：只报告将要发生的改动。

脚本在写入前一定会把目标快照备份到 `.cache/` 下，文件名带时间戳。
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import re
import shutil
import sys
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Set, Tuple

ROOT = Path(__file__).resolve().parent.parent
SNAPSHOT_RELATIVE = Path(".cache") / "commercial-director-workspace.json"
MEDIA_RELATIVE = Path(".cache") / "commercial-director-media"
GENERATED_CANDIDATES = (
    Path("web") / "generated",
    Path("commercial_director") / "dist" / "generated",
)
LOCAL_MEDIA_RE = re.compile(r"/api/local-media/([A-Za-z0-9._-]+)")
GENERATED_RE = re.compile(r"/generated/([A-Za-z0-9._\-/]+)")


def _load_snapshot(path: Path) -> Dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except OSError as exc:
        raise SystemExit(f"读不到快照：{path}（{exc}）")
    except json.JSONDecodeError as exc:
        raise SystemExit(f"快照不是合法 JSON：{path}（{exc}）")
    if not isinstance(data, dict) or "projects" not in data:
        raise SystemExit(f"这不像工作区快照（没有 projects 字段）：{path}")
    return data


def _resolve_source(raw: str) -> Tuple[Path, Path]:
    """返回 (快照路径, 旧安装根目录)。"""
    path = Path(raw).expanduser().resolve()
    if path.is_file():
        # 给了 json：安装根按 .cache/xxx.json 的层级往上推两层，推不出来就用它所在目录
        root = path.parent.parent if path.parent.name == ".cache" else path.parent
        return path, root
    snapshot = path / SNAPSHOT_RELATIVE
    if not snapshot.is_file():
        raise SystemExit(f"{path} 里没有 {SNAPSHOT_RELATIVE.as_posix()}")
    return snapshot, path


def _media_dir(root: Path) -> Optional[Path]:
    candidate = root / MEDIA_RELATIVE
    return candidate if candidate.is_dir() else None


def _generated_dir(root: Path) -> Optional[Path]:
    for relative in GENERATED_CANDIDATES:
        candidate = root / relative
        if candidate.is_dir():
            return candidate
    return None


def _referenced(blob: str) -> Tuple[Set[str], Set[str]]:
    return set(LOCAL_MEDIA_RE.findall(blob)), set(GENERATED_RE.findall(blob))


def _copy_media(source_root: Path, target_root: Path, blob: str, dry_run: bool) -> Tuple[int, int, List[str]]:
    media_names, generated_names = _referenced(blob)
    copied = 0
    total_bytes = 0
    missing: List[str] = []

    source_media = _media_dir(source_root)
    target_media = target_root / MEDIA_RELATIVE
    if media_names and source_media:
        target_media.mkdir(parents=True, exist_ok=True)
        for name in sorted(media_names):
            src = source_media / name
            dst = target_media / name
            if not src.is_file():
                missing.append(f"local-media/{name}")
                continue
            if dst.is_file() and dst.stat().st_size == src.stat().st_size:
                continue
            total_bytes += src.stat().st_size
            copied += 1
            if not dry_run:
                shutil.copy2(src, dst)
    elif media_names:
        missing.extend(f"local-media/{name}" for name in sorted(media_names))

    source_generated = _generated_dir(source_root)
    if generated_names and source_generated:
        for relative in sorted(generated_names):
            src = source_generated / relative
            dst = target_root / "web" / "generated" / relative
            if not src.is_file():
                missing.append(f"generated/{relative}")
                continue
            if dst.is_file() and dst.stat().st_size == src.stat().st_size:
                continue
            total_bytes += src.stat().st_size
            copied += 1
            if not dry_run:
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dst)
    elif generated_names:
        missing.extend(f"generated/{name}" for name in sorted(generated_names))

    if copied and not dry_run:
        print(f"  媒体：复制 {copied} 个文件（{total_bytes / 1048576:.1f} MB）")
    elif copied:
        print(f"  媒体：将复制 {copied} 个文件（{total_bytes / 1048576:.1f} MB）")
    else:
        print("  媒体：无需复制")
    if missing:
        print(f"  媒体：{len(missing)} 个文件在旧安装里找不到（不影响项目结构）")
    return copied, total_bytes, missing


def _post_snapshot(port: int, state: Dict[str, Any]) -> None:
    payload = json.dumps({"state": state}, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/api/workspace-snapshot",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=15) as response:
        if response.status >= 300:
            raise SystemExit(f"写入失败：HTTP {response.status}")
        response.read()


def main() -> int:
    parser = argparse.ArgumentParser(description="从另一个安装导入星河制片台工作区")
    parser.add_argument("--from", dest="source", required=True, help="旧安装目录或快照 json")
    parser.add_argument("--to", dest="target", default=str(ROOT), help="目标安装目录（默认当前工程）")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--merge", action="store_true", help="只补目标里没有的项目（默认）")
    mode.add_argument("--replace", action="store_true", help="用旧快照整体覆盖项目与模型配置")
    parser.add_argument("--with-media", action="store_true", help="同时复制项目引用的媒体文件")
    parser.add_argument("--port", type=int, default=0, help="软件正在运行的端口，走接口写入")
    parser.add_argument("--dry-run", action="store_true", help="只报告，不落盘")
    args = parser.parse_args()

    target_root = Path(args.target).expanduser().resolve()
    target_path = target_root / SNAPSHOT_RELATIVE
    source_path, source_root = _resolve_source(args.source)
    if source_path == target_path:
        raise SystemExit("源和目标指向同一个快照，没什么可导入的。")

    source = _load_snapshot(source_path)
    target = _load_snapshot(target_path) if target_path.is_file() else {
        "version": source.get("version"), "projects": [], "settings": {},
    }

    source_projects: List[Dict[str, Any]] = [p for p in source.get("projects", []) if isinstance(p, dict)]
    target_projects: List[Dict[str, Any]] = [p for p in target.get("projects", []) if isinstance(p, dict)]

    print(f"源快照：{source_path}")
    print(f"  项目 {len(source_projects)} 个：" + "、".join(str(p.get("name")) for p in source_projects))

    if args.replace:
        merged_projects = list(source_projects)
        merged_settings = source.get("settings") or target.get("settings") or {}
        print(f"目标快照：{target_path}（整体覆盖，现有 {len(target_projects)} 个项目将被丢弃）")
    else:
        known = {str(p.get("id")) for p in target_projects}
        added = [p for p in source_projects if str(p.get("id")) not in known]
        merged_projects = target_projects + added
        merged_settings = target.get("settings") or source.get("settings") or {}
        print(f"目标快照：{target_path}（现有 {len(target_projects)} 个项目）")
        print("  新增 " + (("、".join(str(p.get("name")) for p in added)) or "0 个"))

    merged: Dict[str, Any] = dict(target)
    merged["projects"] = merged_projects
    merged["settings"] = merged_settings
    if args.replace or not merged.get("currentProjectId"):
        merged["currentProjectId"] = source.get("currentProjectId")
        merged["currentEpisodeId"] = source.get("currentEpisodeId")
    merged.setdefault("version", source.get("version") or 1)
    # 让界面知道外部数据变过（服务端/前端都靠这个字段决定是否重载）
    merged["externalRevision"] = int(target.get("externalRevision") or source.get("externalRevision") or 0) + 1

    if args.with_media and (args.replace or merged_projects):
        blob = json.dumps(merged_projects, ensure_ascii=False)
        _copy_media(source_root, target_root, blob, args.dry_run)

    if args.dry_run:
        print("干跑结束，未写入。")
        return 0

    target_path.parent.mkdir(parents=True, exist_ok=True)
    if target_path.is_file():
        stamp = _dt.datetime.now().strftime("%Y%m%d-%H%M%S")
        backup = target_path.with_name(f"{target_path.name}.before-import-{stamp}")
        shutil.copy2(target_path, backup)
        print(f"  已备份：{backup.name}")

    if args.port:
        _post_snapshot(args.port, merged)
        print(f"  已通过 127.0.0.1:{args.port} 写入运行中的实例")
    else:
        target_path.write_text(json.dumps(merged, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"  已写入：{target_path}")

    print(f"完成：项目 {len(merged_projects)} 个 → " + "、".join(str(p.get("name")) for p in merged_projects))
    if not args.port:
        print("提示：软件如果开着，请先退出再导入，否则运行中的进程可能用内存里的旧状态覆盖这次写入。")
    return 0


if __name__ == "__main__":
    sys.exit(main())

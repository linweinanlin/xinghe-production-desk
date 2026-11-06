"""核心不变量测试：出处校验、层级表结构、配置取值规则。

跑法（工程根目录）：

    python -m unittest discover -s tests -v

这些测试不启动界面、不联网，只校验纯逻辑与产物一致性。
"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from provenance import author, guard  # noqa: E402


class ProvenanceTest(unittest.TestCase):
    """出处校验：清单、签名、篡改可被发现。"""

    def test_official_build_verifies(self) -> None:
        report = guard.verify()
        self.assertTrue(report.signature_ok, "仓库公钥验签失败，说明清单不是用作者私钥签的")
        self.assertTrue(report.ok, f"官方构建校验未通过：{report.headline}")
        self.assertGreaterEqual(report.checked, 20, "清单覆盖文件过少，疑似漏签")

    def test_manifest_covers_source_files(self) -> None:
        manifest = json.loads((ROOT / "provenance" / "manifest.json").read_text(encoding="utf-8"))
        files = set(manifest.get("files", {}))
        for required in ("app.py", "director_server.py", "web/assets/app.js",
                         "web/assets/provider-schema.js", "LICENSE"):
            self.assertIn(required, files, f"{required} 未纳入清单")

    def test_forged_signature_is_rejected(self) -> None:
        """换一把私钥重签同一份清单，仓库公钥必须验不过。"""
        manifest = json.loads((ROOT / "provenance" / "manifest.json").read_text(encoding="utf-8"))
        public = json.loads((ROOT / "provenance" / "public-key.json").read_text(encoding="utf-8"))
        payload = {k: v for k, v in manifest.items() if k != "signature"}
        forged = "00" * len(manifest["signature"])
        self.assertFalse(guard.verify_signature(payload, forged, public))

    def test_author_has_no_placeholders(self) -> None:
        for value in (author.AUTHOR, author.GITHUB_USER):
            self.assertNotIn("【", value, "作者信息仍是占位符，发布前必须替换")
        self.assertTrue(author.CONTACT_EMAIL, "缺少授权联系邮箱")


class SchemaTest(unittest.TestCase):
    """层级表：结构完整，且与预期规模一致。"""

    @classmethod
    def setUpClass(cls) -> None:
        node = shutil.which("node")
        if not node:
            raise unittest.SkipTest("未安装 Node，跳过层级表测试")
        script = (
            "const fs=require('fs'),vm=require('vm');"
            "const p='web/assets/provider-schema.js';"
            "const box={window:{}};"
            "vm.runInNewContext(fs.readFileSync(p,'utf8'),box);"
            "process.stdout.write(JSON.stringify(box.window.XH_MODEL_SCHEMA));"
        )
        result = subprocess.run([node, "-e", script], cwd=ROOT,
                                capture_output=True, text=True, encoding="utf-8")
        if result.returncode != 0:
            raise AssertionError(f"层级表求值失败：{result.stderr[:400]}")
        cls.schema = json.loads(result.stdout)

    def test_three_modules(self) -> None:
        kinds = [module["kind"] for module in self.schema["modules"]]
        self.assertEqual(sorted(kinds), ["chat", "image", "video"])

    def test_every_provider_has_models_and_params(self) -> None:
        for module in self.schema["modules"]:
            self.assertTrue(module["providers"], f"{module['kind']} 没有服务商")
            for provider in module["providers"]:
                self.assertTrue(provider["models"], f"{provider['id']} 没有模型")
                for model in provider["models"]:
                    self.assertIsInstance(model.get("params"), list, f"{model['id']} 缺参数描述符")

    def test_param_descriptors_are_well_formed(self) -> None:
        allowed = {"select", "number", "boolean", "text", "readonly"}
        for module in self.schema["modules"]:
            for provider in module["providers"]:
                for model in provider["models"]:
                    for spec in model["params"]:
                        where = f"{module['kind']}/{provider['id']}/{model['id']}/{spec.get('key')}"
                        self.assertIn(spec.get("type"), allowed, f"{where} 类型非法")
                        if spec["type"] == "select":
                            self.assertTrue(spec.get("options"), f"{where} 是枚举但没有选项")

    def test_scale_is_stable(self) -> None:
        providers = sum(len(m["providers"]) for m in self.schema["modules"])
        models = sum(len(p["models"]) for m in self.schema["modules"] for p in m["providers"])
        params = sum(len(md["params"]) for m in self.schema["modules"]
                     for p in m["providers"] for md in p["models"])
        self.assertEqual(providers, 12, f"服务商数量变了：{providers}")
        self.assertEqual(models, 32, f"模型数量变了：{models}")
        self.assertEqual(params, 99, f"参数项数量变了：{params}")


class ServerContractTest(unittest.TestCase):
    """服务端契约：静态根、许可字段、密钥文件不进仓库。"""

    def test_web_root_points_to_local_dir(self) -> None:
        text = (ROOT / "director_server.py").read_text(encoding="utf-8")
        self.assertIn('DEFAULT_WEB_ROOT = ROOT / "web"', text)

    def test_health_reports_upstream_license(self) -> None:
        text = (ROOT / "director_server.py").read_text(encoding="utf-8")
        self.assertIn("upstream_license", text)
        self.assertIn("MIT", text)

    def test_no_secrets_tracked(self) -> None:
        example = (ROOT / ".env.models.example").read_text(encoding="utf-8")
        for line in example.splitlines():
            if "=" in line and not line.strip().startswith("#"):
                key, _, value = line.partition("=")
                self.assertEqual(value.strip(), "", f"{key.strip()} 在模板里有值，禁止提交真实密钥")

    def test_gitignore_blocks_runtime_data(self) -> None:
        ignore = (ROOT / ".gitignore").read_text(encoding="utf-8")
        for pattern in (".cache/", ".env.models.local", "seal-key.json"):
            self.assertIn(pattern, ignore, f".gitignore 未排除 {pattern}")


if __name__ == "__main__":
    unittest.main(verbosity=2)

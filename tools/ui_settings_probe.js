/* 星河制片台 · 「模型与设置」界面探针
 *
 * 用 CDP 驱动真实 Chrome 打开真实页面，点真实按钮，验证四级层级视图
 * （模块 → 服务商 → 模型 → 参数）的查看 / 编辑 / 校验 / 切换 / 保存链路。
 *
 * 用法：先起一个本机服务（桌面壳会自动起，也可以手动），再
 *   python director_server.py --port 3015
 *   node tools/ui_settings_probe.js http://127.0.0.1:3015/index.html
 * 退出码 0 = 全部断言通过
 *
 * 注意：探针会写工作区快照（settings.vendors），在你自己正在用的工作区上跑之前，
 * 先备份 .cache/commercial-director-workspace.json。项目内容不会被改动。
 *
 * 溯源标记 XHPD-2026-7f3c91a4d0e5b28c · Copyright (c) 2026 【你的名字】
 */
"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const PAGE = process.argv[2] || "http://127.0.0.1:8765/index.html";
const ROOT = path.resolve(__dirname, "..");
const SHOT_DIR = path.join(ROOT, ".cache", "shots");
const PORT = 9334;
const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].find((candidate) => fs.existsSync(candidate));

if (!CHROME) {
  console.error("找不到 Chrome/Edge，无法执行界面探针");
  process.exit(2);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForTarget() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await response.json();
      const page = list.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
      if (page) return page;
    } catch (error) {
      /* 端口还没起来 */
    }
    await sleep(200);
  }
  throw new Error("CDP 目标未就绪");
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    let nextId = 1;

    socket.addEventListener("open", () => {
      resolve({
        send(method, params) {
          const id = nextId++;
          socket.send(JSON.stringify({ id, method, params: params || {} }));
          return new Promise((res, rej) => {
            pending.set(id, { res, rej });
            setTimeout(() => {
              if (pending.has(id)) {
                pending.delete(id);
                rej(new Error(`CDP 超时：${method}`));
              }
            }, 15000);
          });
        },
        close() {
          socket.close();
        },
      });
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !pending.has(message.id)) return;
      const { res, rej } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) rej(new Error(message.error.message));
      else res(message.result);
    });
    socket.addEventListener("error", () => reject(new Error("CDP 连接失败")));
  });
}

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "xinghe-settings-"));
  const child = spawn(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--hide-scrollbars",
      "--window-size=1600,1000",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      PAGE,
    ],
    { stdio: "ignore" },
  );

  const results = [];
  const check = (name, pass, detail) => {
    results.push({ name, pass, detail });
    console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  };

  try {
    const target = await waitForTarget();
    const cdp = await connect(target.webSocketDebuggerUrl);
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");

    const evaluate = async (expression) => {
      const result = await cdp.send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description || "页面脚本异常");
      }
      return result.result.value;
    };

    const shoot = async (name) => {
      await sleep(420);   // 等卡片入场动画结束，避免截到半透明的中间帧
      const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(SHOT_DIR, name), Buffer.from(shot.data, "base64"));
    };

    // ---- 0. 等页面起来并进入「模型与设置」 ----
    let booted = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      booted = await evaluate('Boolean(document.querySelector(\'button[data-action="nav"][data-view="settings"]\'))');
      if (booted) break;
      await sleep(250);
    }
    check("工作台页面启动", booted === true, PAGE);
    if (!booted) throw new Error("页面没有渲染出导航，无法继续");

    await evaluate('document.querySelector(\'button[data-action="nav"][data-view="settings"]\').click()');
    await sleep(250);

    // ---- 1. 四级层级是否齐全 ----
    const tree = await evaluate(`(() => ({
      modules: document.querySelectorAll('.cfg-module').length,
      branches: document.querySelectorAll('.cfg-branch').length,
      treeExists: Boolean(document.querySelector('.cfg-tree')),
      title: document.querySelector('.section-head h3')?.textContent || '',
    }))()`);
    check("设置页是新层级视图", tree.treeExists === true, tree.title);
    check("三大模块都在树上", tree.modules === 3, `模块 ${tree.modules}`);
    check("12 个服务商子模块都在树上", tree.branches === 12, `服务商 ${tree.branches}`);

    await shoot("app-settings-default.png");
    await evaluate('document.querySelector(\'[data-action="cfg-toggle-all"]\').click()');
    await sleep(200);
    const leaves = await evaluate("document.querySelectorAll('.cfg-leaf').length");
    check("展开后 32 个模型节点可见", leaves === 32, `模型节点 ${leaves}`);
    await shoot("app-settings-tree.png");

    // ---- 2. 模块总览：每家服务商都列出自己的模型 ----
    const moduleView = await evaluate(`(() => {
      document.querySelector('[data-action="cfg-pick"][data-kind="video"]').click();
      return {
        rows: document.querySelectorAll('.cfg-table tbody tr.cfg-active-row, .cfg-table tbody tr:not(.cfg-chip-row)').length,
        chips: document.querySelectorAll('.cfg-mini-chip').length,
        hasTencent: [...document.querySelectorAll('.cfg-provider-link')].some(n => n.textContent.includes('腾讯')),
        hasOpenAI: [...document.querySelectorAll('.cfg-provider-link')].some(n => n.textContent.includes('OpenAI')),
        hasMinimax: [...document.querySelectorAll('.cfg-provider-link')].some(n => n.textContent.includes('MiniMax')),
      };
    })()`);
    check("视频模块列出 6 家服务商", moduleView.rows === 6, `rows ${moduleView.rows}`);
    check("视频模块铺开 18 个模型", moduleView.chips === 18, `chips ${moduleView.chips}`);
    check("腾讯云 / OpenAI / MiniMax 都在列表里", moduleView.hasTencent && moduleView.hasOpenAI && moduleView.hasMinimax, "三家均出现");

    // ---- 3. 服务商层：连接字段 + 通道参数 ----
    const providerView = await evaluate(`(() => {
      document.querySelector('[data-action="cfg-pick"][data-kind="video"][data-provider="dashscope"]').click();
      return {
        base: document.querySelector('#video-base')?.value || '',
        endpoint: document.querySelector('#video-endpoint')?.value || '',
        modelOptions: document.querySelectorAll('#video-model option').length,
        keyInput: Boolean(document.querySelector('#video-key')),
        paramKeys: [...document.querySelectorAll('[data-cfg-param][data-cfg-scope="channel"]')].map(n => n.dataset.cfgParam),
        models: document.querySelectorAll('.cfg-model-chip').length,
        guard: Boolean(document.querySelector('#video-free-tier-only')),
      };
    })()`);
    check("服务商层能改 BASE URL", providerView.base === "https://dashscope.aliyuncs.com", providerView.base);
    check("服务商层能改 ENDPOINT", providerView.endpoint.includes("video-synthesis"), providerView.endpoint);
    check("模型下拉列出该服务商 4 个模型", providerView.modelOptions === 4, `options ${providerView.modelOptions}`);
    check("凭据输入框存在", providerView.keyInput === true, "#video-key");
    check("通道级参数渲染", providerView.paramKeys.length >= 3, providerView.paramKeys.join(","));
    check("视频额度保护仍在", providerView.guard === true, "#video-free-tier-only");
    await shoot("app-settings-provider.png");

    // ---- 4. 模型层：只读能力 + 可编辑参数 ----
    const modelView = await evaluate(`(() => {
      document.querySelector('[data-action="cfg-pick"][data-kind="video"][data-provider="dashscope"][data-model="wan3.0-video"]').click();
      return {
        crumb: document.querySelector('.cfg-crumb')?.textContent || '',
        caps: [...document.querySelectorAll('.cfg-cap-row span')].map(n => n.textContent),
        params: [...document.querySelectorAll('[data-cfg-param][data-cfg-scope="model"]')].map(n => n.dataset.cfgParam),
        wired: [...document.querySelectorAll('.cfg-flag.on')].map(n => n.textContent),
      };
    })()`);
    check(" crumbs 显示三层路径", modelView.crumb.includes("视频模型") && modelView.crumb.includes("wan3.0-video"), modelView.crumb);
    check("模型能力只读渲染", modelView.caps.length >= 4, modelView.caps.join(" / "));
    check("模型参数可编辑", modelView.params.includes("duration") && modelView.params.includes("resolution"), modelView.params.join(","));
    check("标注哪些参数真正生效", modelView.wired.includes("生效"), modelView.wired.join(","));
    await shoot("app-settings-model.png");

    // ---- 5. 改参数 → 落进 vendors 桶 ----
    const edited = await evaluate(`(() => {
      const input = document.querySelector('[data-cfg-param="duration"][data-cfg-scope="model"]');
      input.value = "9";
      input.dispatchEvent(new Event('change', { bubbles: true }));
      const state = JSON.parse(localStorage.getItem('xinghe_commercial_director_v1'));
      return {
        value: state.settings.vendors.video.dashscope.models['wan3.0-video'].duration,
        status: document.querySelectorAll('.cfg-flag.on').length,
      };
    })()`);
    check("模型参数写入配置", String(edited.value) === "9", `duration=${edited.value}`);
    check("写入后标记为已覆盖", edited.status >= 2, `flags ${edited.status}`);

    // ---- 6. 越界值要被校验拦住 ----
    const invalid = await evaluate(`(() => {
      const input = document.querySelector('[data-cfg-param="duration"][data-cfg-scope="model"]');
      input.value = "99";
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return document.querySelector('.cfg-issues').innerText;
    })()`);
    check("越界参数被校验拦下", invalid.includes("超出允许范围"), invalid.split("\n").slice(0, 2).join(" "));

    // ---- 7. 待接入通道不可启用 ----
    const pendingInfo = await evaluate(`(() => {
      document.querySelector('[data-action="cfg-pick"][data-kind="video"][data-provider="openai"]').click();
      const btn = document.querySelector('[data-action="cfg-activate"]');
      return {
        disabled: Boolean(btn && btn.disabled),
        note: document.querySelector('.cfg-note.warn')?.textContent || '',
      };
    })()`);
    check("未接入通道禁用切换", pendingInfo.disabled === true, pendingInfo.note.slice(0, 30));

    // ---- 8. 切通道：只换指针，地址跟着层级表走 ----
    // 先把指针挪到 dashscope 再切 tencent：默认通道可能就是 tencent，
    // 那时编辑器只有「已启用」状态、没有 activate 按钮，直接点会取到 null。
    const activated = await evaluate(`(() => {
      document.querySelector('[data-action="cfg-pick"][data-kind="video"][data-provider="dashscope"]').click();
      document.querySelector('[data-action="cfg-activate"]')?.click();
      document.querySelector('[data-action="cfg-pick"][data-kind="video"][data-provider="tencent"]').click();
      document.querySelector('[data-action="cfg-activate"]')?.click();
      const state = JSON.parse(localStorage.getItem('xinghe_commercial_director_v1'));
      return {
        vendor: state.settings.providers.video.vendor,
        base: state.settings.providers.video.baseUrl,
        model: state.settings.providers.video.model,
        resolution: state.settings.providers.video.resolution,
        secret: state.settings.providers.video.secretName,
      };
    })()`);
    check("切换通道改的是 vendor 指针", activated.vendor === "tencent", activated.vendor);
    check("地址由层级表推导", activated.base === "https://vclm.tencentcloudapi.com", activated.base);
    check("密钥槽位跟着通道走", activated.secret === "videoTencentId", activated.secret);
    check("混元锁定 720p", activated.resolution === "720p", activated.resolution);

    // ---- 9. 保存：配置落盘但不含密钥 ----
    const saved = await evaluate(`(() => {
      document.querySelector('[data-action="save-settings"]').click();
      const raw = localStorage.getItem('xinghe_commercial_director_v1');
      const state = JSON.parse(raw);
      return {
        vendors: Object.keys(state.settings.vendors).sort().join(","),
        videoProviders: Object.keys(state.settings.vendors.video).length,
        leaks: /apiKey|secretKey|"sk-|AKID/.test(raw),
      };
    })()`);
    check("保存后三家服务商配置都在盘上", saved.videoProviders === 6, `video buckets ${saved.videoProviders}`);
    check("配置里没有泄漏密钥", saved.leaks === false, "无 apiKey/secretKey/sk-/AKID");
    await shoot("app-settings-saved.png");

    // ---- 9.5 对话与图片模块同样能配（不是只做了视频） ----
    const chatModule = await evaluate(`(() => {
      document.querySelector('[data-action="cfg-pick"][data-kind="chat"]').click();
      const rows = document.querySelectorAll('.cfg-table tbody tr:not(.cfg-chip-row)').length;
      document.querySelector('[data-action="cfg-pick"][data-kind="chat"][data-provider="deepseek"][data-model="deepseek-v4-flash"]').click();
      const params = [...document.querySelectorAll('[data-cfg-param][data-cfg-scope="model"]')].map(n => n.dataset.cfgParam);
      const temp = document.querySelector('[data-cfg-param="temperature"][data-cfg-scope="model"]');
      temp.value = "0.2";
      temp.dispatchEvent(new Event('change', { bubbles: true }));
      const state = JSON.parse(localStorage.getItem('xinghe_commercial_director_v1'));
      return { rows, params, temperature: state.settings.vendors.chat.deepseek.models['deepseek-v4-flash'].temperature };
    })()`);
    check("对话模块 3 家服务商", chatModule.rows === 3, `rows ${chatModule.rows}`);
    check("对话模型参数可改", chatModule.params.includes("temperature") && chatModule.params.includes("maxTokens"), chatModule.params.join(","));
    check("对话参数落进配置", String(chatModule.temperature) === "0.2", `temperature=${chatModule.temperature}`);
    await shoot("app-settings-chat-model.png");

    const imageModule = await evaluate(`(() => {
      document.querySelector('[data-action="cfg-pick"][data-kind="image"]').click();
      const rows = document.querySelectorAll('.cfg-table tbody tr:not(.cfg-chip-row)').length;
      document.querySelector('[data-action="cfg-pick"][data-kind="image"][data-provider="zhipu"]').click();
      return {
        rows,
        base: document.querySelector('#image-base')?.value,
        modelOptions: document.querySelectorAll('#image-model option').length,
        params: [...document.querySelectorAll('[data-cfg-param][data-cfg-scope="channel"]')].map(n => n.dataset.cfgParam),
      };
    })()`);
    check("图片模块 3 家服务商", imageModule.rows === 3, `rows ${imageModule.rows}`);
    check("图片通道地址可改", imageModule.base === "https://open.bigmodel.cn/api/paas/v4", imageModule.base);
    check("图片模型下拉列出 2 个", imageModule.modelOptions === 2, `options ${imageModule.modelOptions}`);
    check("图片参数渲染（含尺寸/水印）", imageModule.params.includes("size"), imageModule.params.join(","));
    await shoot("app-settings-image-provider.png");

    // ---- 10. 老配置迁移：升级后不能把用户填过的地址/模型弄丢 ----
    // 桌面壳里状态的真源是本机工作区快照：bootstrap() 先读 /api/workspace-snapshot，
    // localStorage 只是镜像。只改 localStorage 会在刷新后被快照盖回去（表现为
    // 「迁移没生效」），所以有后端时要把老配置同时塞进快照接口。
    const seededViaServer = await evaluate(`(async () => {
      const raw = JSON.parse(localStorage.getItem('xinghe_commercial_director_v1'));
      delete raw.settings.vendors;
      delete raw.settings.vendorsSchemaVersion;
      // 真正的老配置既没有 vendors 桶，也没有「界面已接管」标记。
      // 只删桶、留着标记，等于造了一个现实中不存在的半新半旧状态。
      delete raw.settings.vendorsManaged;
      raw.settings.providers.video = {
        vendor: 'dashscope', label: '视频模型',
        baseUrl: 'https://dashscope.aliyuncs.com',
        endpoint: '/api/v1/services/aigc/video-generation/video-synthesis',
        model: 'wan3.0-video', imageToVideoModel: 'wan3.0-video', resolution: '720p',
      };
      raw.settings.providers.image = {
        vendor: 'zhipu', label: '图片模型',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4', endpoint: '/images/generations', model: 'cogview-3-flash',
      };
      localStorage.setItem('xinghe_commercial_director_v1', JSON.stringify(raw));
      let viaServer = false;
      try {
        const response = await fetch('/api/workspace-snapshot', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ state: raw }),
        });
        viaServer = response.ok;
      } catch (error) { viaServer = false; }
      location.reload();
      return viaServer;
    })()`);
    await sleep(1400);
    console.log(`INFO  老配置写入路径  — ${seededViaServer ? "本机快照接口（桌面壳模式）" : "仅 localStorage（静态托管模式）"}`);
    await evaluate('document.querySelector(\'button[data-action="nav"][data-view="settings"]\').click()');
    await sleep(250);
    const migrated = await evaluate(`(() => {
      document.querySelector('[data-action="cfg-pick"][data-kind="video"][data-provider="dashscope"]').click();
      const resolution = document.querySelector('[data-cfg-param="resolution"][data-cfg-scope="channel"]')?.value;
      const base = document.querySelector('#video-base')?.value;
      return {
        base,
        resolution,
        activeVendor: JSON.parse(localStorage.getItem('xinghe_commercial_director_v1')).settings.providers.video.vendor,
      };
    })()`);
    check("老配置的地址被搬进新结构", migrated.base === "https://dashscope.aliyuncs.com", migrated.base);
    check("老配置的分辨率被搬进新结构", migrated.resolution === "720p", String(migrated.resolution));
    check("升级不影响当前启用通道", migrated.activeVendor === "dashscope", migrated.activeVendor);

    // ---- 11. 自定义地址要能活过重启（老逻辑会把「与预设不一致」的地址重置掉） ----
    await evaluate(`(() => {
      document.querySelector('[data-action="cfg-pick"][data-kind="video"][data-provider="dashscope"]').click();
      const base = document.querySelector('#video-base');
      base.value = 'https://dashscope.aliyuncs.com';
      base.dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('[data-action="save-settings"]').click();
      return true;
    })()`);
    // 保存后写快照接口有 450ms 防抖：立刻 reload 会把它取消掉，
    // 于是「重开应用」读到的还是上一版快照，测出来的失败是假的。
    await sleep(900);
    await evaluate("location.reload()");
    await sleep(1200);
    const reopened = await evaluate(`(() => {
      const state = JSON.parse(localStorage.getItem('xinghe_commercial_director_v1'));
      return {
        vendor: state.settings.providers.video.vendor,
        base: state.settings.providers.video.baseUrl,
        managed: state.settings.vendorsManaged === true,
        buckets: Object.keys(state.settings.vendors.video).length,
      };
    })()`);
    check("界面配置标记为已接管", reopened.managed === true, "vendorsManaged");
    check("重开应用后通道不被重置", reopened.vendor === "dashscope", reopened.vendor);
    check("12 家服务商的配置桶都还在", reopened.buckets === 6, `video buckets ${reopened.buckets}`);

    const failed = results.filter((item) => !item.pass);
    console.log(`\n${results.length - failed.length}/${results.length} 通过`);
    if (failed.length) {
      console.log("失败项：" + failed.map((item) => item.name).join("、"));
      process.exitCode = 1;
    }
  } finally {
    child.kill();
  }
}

main().catch((error) => {
  console.error("探针执行失败：", error.message);
  process.exit(1);
});

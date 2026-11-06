/* 星河制片台 · 前端主逻辑（原生 JS，无框架、无构建步骤）
 * 溯源标记 XHPD-2026-7f3c91a4d0e5b28c
 * 本文件基于上游 MIT 代码（Copyright (c) 2026 AI Drama Pipeline contributors）修改，
 * 新增与改动部分 Copyright (c) 2026 linweinanlin；上游部分仍按 MIT 授权，
 * 全文见 LICENSES/AI-Drama-Pipeline-MIT.txt，许可边界见仓库根目录 LICENSE 第十条。
 */
(() => {
  "use strict";

  const STORAGE_KEY = "xinghe_commercial_director_v1";

  // 模型与配置的层级表：模块 → 服务商 → 模型 → 参数，唯一数据源是
  // assets/provider-schema.js。界面与迁移都只读这张表，服务商判断不再散落。
  const MODEL_SCHEMA = (window.XH_MODEL_SCHEMA && Array.isArray(window.XH_MODEL_SCHEMA.modules))
    ? window.XH_MODEL_SCHEMA
    : { version: 2, modules: [] };
  const schemaModule = kind => MODEL_SCHEMA.modules.find(item => item.kind === kind) || null;
  const schemaProviders = kind => (schemaModule(kind)?.providers) || [];
  const schemaProvider = (kind, id) => schemaProviders(kind).find(item => item.id === id) || null;
  const schemaModels = (kind, id) => schemaProvider(kind, id)?.models || [];
  const schemaModel = (kind, id, modelId) => schemaModels(kind, id).find(item => item.id === modelId) || null;
  // 旧配置里 kind → vendor 的默认值：迁移时用来判断用户原来用的哪一家。
  const SCHEMA_KIND_DEFAULT_VENDOR = { chat: "deepseek", image: "ark", video: "agentPlan" };

  const SESSION_SECRET_KEY = "xinghe_api_secrets_session";
  const LOCAL_SECRET_KEY = "xinghe_api_secrets_local";
  const SERVER_SECRET_SENTINEL = "__xinghe_local_server_secret__";
  const AGENT_PLAN_VIDEO_BASE = "https://ark.cn-beijing.volces.com/api/plan/v3";
  const AGENT_PLAN_VIDEO_ENDPOINT = "/contents/generations/tasks";
  const AGENT_PLAN_VIDEO_MODELS = ["doubao-seedance-2.0", "doubao-seedance-2.0-fast", "doubao-seedance-2.0-mini", "doubao-seedance-2.5"];
  // 智谱 CogVideoX-Flash：官方定价页标注“免费”，支持文生视频 + 单张首帧图生视频，约 5 秒、无声。
  const ZHIPU_VIDEO_BASE = "https://open.bigmodel.cn/api/paas/v4";
  const ZHIPU_VIDEO_ENDPOINT = "/videos/generations";
  const ZHIPU_VIDEO_MODELS = ["cogvideox-flash", "cogvideox-2", "cogvideox-3"];
  // 阿里百炼视频：异步任务制（提交拿 task_id，再轮询 /api/v1/tasks/{id}）。
  // 只列官方当前仍发新人免费额度的模型；旧 Wan 2.x 已从免费额度名单下架。
  const DASHSCOPE_VIDEO_BASE = "https://dashscope.aliyuncs.com";
  const DASHSCOPE_VIDEO_ENDPOINT = "/api/v1/services/aigc/video-generation/video-synthesis";
  const DASHSCOPE_VIDEO_MODELS = ["wan3.0-video", "happyhorse-1.1-i2v", "happyhorse-1.1-t2v", "happyhorse-1.1-r2v"];
  // 腾讯混元生视频：Cloud API 3.0（TC3-HMAC-SHA256），50 点免费包需在控制台手动领取。
  const TENCENT_VIDEO_BASE = "https://vclm.tencentcloudapi.com";
  const TENCENT_VIDEO_ENDPOINT = "/";
  const TENCENT_VIDEO_MODELS = ["hunyuan-video"];
  const ProviderCapabilities = window.XingheProviderCapabilities;
  // 智谱 CogView-3-Flash：官方定价页标注免费，文生图、同步出图；与视频通道共用同一个 bigmodel.cn Key。
  const ZHIPU_IMAGE_BASE = "https://open.bigmodel.cn/api/paas/v4";
  const ZHIPU_IMAGE_ENDPOINT = "/images/generations";
  const ZHIPU_IMAGE_MODELS = ["cogview-3-flash", "cogview-4-250304"];
  const app = document.querySelector("#app");
  const toastNode = document.querySelector("#toast");
  const importNode = document.querySelector("#import-file");
  const assetImageNode = document.querySelector("#asset-image-file");
  const runtimeMedia = new Map();
  // 桌面壳内嵌的 QtWebEngine 是开源构建，不带 H.264/AAC 解码器：
  // 直接播模型产出的 mp4 会停在 0:00 并报 DEMUXER_ERROR_NO_SUPPORTED_STREAMS。
  // 能力探测为假时，界面预览统一走服务端的 VP9/Opus WebM 缓存（交付与合片仍用原 mp4）。
  const nativeVideoSupport = (() => {
    try {
      const probe = document.createElement("video");
      return {
        h264: Boolean(probe.canPlayType('video/mp4; codecs="avc1.42E01E"')),
        aac: Boolean(probe.canPlayType('audio/mp4; codecs="mp4a.40.2"')),
      };
    } catch (error) {
      return { h264: true, aac: true };
    }
  })();
  const PREVIEW_NEEDED = !nativeVideoSupport.h264;
  const PREVIEW_SOURCE_PATTERN = /^\/api\/local-media\/([A-Za-z0-9._-]+\.(?:mp4|mov|m4v))$/i;
  const playbackSrc = (url) => {
    const value = String(url || "");
    if (!PREVIEW_NEEDED) return value;
    const matched = value.match(PREVIEW_SOURCE_PATTERN);
    return matched ? `/api/preview-media/${matched[1]}` : value;
  };
  let currentView = "dashboard";
  let studioOpen = false;
  let studioRun = null;
  let toastTimer = null;
  let pendingAssetImageId = "";
  // 镜头状态反馈：只在用户当前正看着的视图里，对“完成/失败”这一次状态变化播放一次动效
  const shotMotionState = new Map();
  const shotMotionClass = shot => {
    const prev = shotMotionState.get(shot.id);
    shotMotionState.set(shot.id, { status: shot.status, view: currentView });
    if (!prev || prev.view !== currentView || prev.status === shot.status) return "";
    if (shot.status === "completed") return " shot-flash-ok";
    if (shot.status === "failed" || shot.status === "qc_failed") return " shot-flash-err";
    return "";
  };
  let pendingAssetImageKind = "reference";
  let pendingVariationId = "";
  let pendingShotImageId = "";
  let snapshotSaveTimer = null;
  let videoProviderMigrated = false;
  const QUALITY_NEGATIVE = "禁止身份漂移、换脸、人物数量错误、多余人物、肢体畸形、伪文字、乱码、水印、字幕板、镜像反转、服装突变、场景跳变；保持绑定角色脸型、发型、服装、年龄与上一镜末帧连续。";  const TURNAROUND_PANELS = [
    ["正面", "全身"], ["正面", "半身"], ["正面", "面部特写"],
    ["左侧面", "全身"], ["右侧面", "全身"], ["3/4侧面", "半身"],
    ["背面", "全身"], ["仰视", "半身"], ["俯视", "半身"],
  ];
  const emptyTurnaround = () => ({
    status: "missing", imageUrl: "", panelUrls: [], qc: null,
    panels: TURNAROUND_PANELS.map(([viewAngle, shotSize], index) => ({ index, viewAngle, shotSize })),
  });
  const emptyArtDirection = () => ({
    palette: "主色、辅色、点缀色待设定", lighting: "统一电影光影", texture: "写实电影质感",
    characterRules: "角色头身比、五官画法、服装材质保持统一", moodKeywords: [], anchors: "",
  });
  const emptyStoryboardGrid = () => ({ status: "missing", panelCount: 9, panels: [], imageUrl: "", panelUrls: [] });
  const StudioCore = window.StoryboardCore || {
    defaultParams: () => ({ shotCount: "auto", shotDuration: 5, density: "auto", includeLens: true, dialogueMode: "verbatim", batchSize: 4, style: "", ratio: "9:16", lockedCharacterIds: [] }),
    planBatches: () => [], buildRequest: () => ({ system: "", user: "" }), normalizeDrafts: () => [],
    localDrafts: () => [], summarize: () => ({ segments: 0, shots: 0, selected: 0, duration: 0, failed: 0 }),
    SHOT_SIZES: ["大远景", "远景", "全景", "中景", "中近景", "近景", "特写", "大特写"],
    COMPOSITIONS: ["三分法构图", "中心构图", "对称构图", "框架构图", "前景遮挡", "对角线构图", "留白构图"],
    CAMERA_ANGLES: ["平视", "轻微俯拍", "俯拍", "低机位仰拍", "高机位", "侧拍", "过肩", "鸟瞰"],
    LENSES: ["24mm 广角", "35mm 人文", "50mm 标准", "85mm 中长焦", "135mm 长焦"],
    MOVEMENTS: ["固定镜头", "缓慢推近", "缓慢拉远", "横移跟拍", "手持跟随", "环绕", "升降", "摇镜"],
    DURATIONS: [2, 3, 4, 5, 6, 8, 10, 12, 15],
    DENSITY_LABEL: { auto: "自动配比", wide: "全景建立为主", medium: "中近景叙事为主", close: "特写情绪为主" },
  };
  const emptyStudio = () => ({ params: StudioCore.defaultParams(), segments: [], updatedAt: "" });
  // 后期包装：把第三节「能力缺口」里的配音/字幕/BGM/转场调色/封面接进工作台。
  // 配置跟着剧集走，导出项目 JSON 时一起带走，换机不丢。
  const PACKAGING_VOICES = [
    ["zh-CN-XiaoxiaoNeural", "晓晓 · 女声 · 温柔（女主）", "female"],
    ["zh-CN-XiaoyiNeural", "晓伊 · 女声 · 活泼（女配）", "female"],
    ["zh-CN-liaoning-XiaobeiNeural", "晓蓓 · 女声 · 东北话（喜剧/配角）", "female"],
    ["zh-CN-shaanxi-XiaoniNeural", "晓妮 · 女声 · 陕西话（乡土）", "female"],
    ["zh-CN-YunxiNeural", "云希 · 男声 · 阳光青年（男主）", "male"],
    ["zh-CN-YunjianNeural", "云健 · 男声 · 低沉（反派/旁白）", "male"],
    ["zh-CN-YunyangNeural", "云扬 · 男声 · 播音腔（解说）", "male"],
    ["zh-CN-YunxiaNeural", "云夏 · 男声 · 少年", "male"],
  ];
  const PACKAGING_VOICE_STYLES = [
    ["drama", "剧情（中性）"], ["calm", "平静（克制）"], ["warm", "温柔（亲密）"],
    ["tense", "紧张（压低）"], ["angry", "愤怒（爆发）"], ["sad", "悲伤（低落）"],
    ["excited", "激动（上扬）"], ["narrate", "叙述（旁白）"],
  ];
  const PACKAGING_GRADES = [
    ["none", "不做调色"], ["cinema", "电影感（低饱和）"], ["warm", "暖调（回忆/室内）"],
    ["cold", "冷调（悬疑/夜戏）"], ["vivid", "高饱和（爽感）"], ["noir", "黑白"],
  ];
  const PACKAGING_TRANSITIONS = [
    ["none", "硬切"], ["fade", "淡入淡出"], ["dissolve", "叠化"],
    ["fadeblack", "闪黑（段落切换）"], ["fadewhite", "闪白（高光/回忆）"],
    ["wipeleft", "左滑"], ["slideup", "上滑"],
    ["distance", "推近（景深切换）"], ["circleopen", "圆形开幕"], ["pixelize", "像素化（故障感）"],
  ];
  // 字幕花字模板：必须与后端 post_production.SUBTITLE_TEMPLATES 的 id 一一对应，
  // 否则前端能选、后端不认，字幕会静默退回白字。
  const PACKAGING_SUBTITLE_TEMPLATES = [
    ["plain", "白字描边（默认）"], ["karaoke", "逐字高亮（卡拉OK）"], ["pop", "弹入放大（综艺感）"],
    ["gradient", "渐变花字"], ["neon", "霓虹描边"], ["comic", "综艺粗描边"],
  ];
  // 模板说明：让用户知道每个模板具体带来什么，而不是只看到一排名字。
  const SUBTITLE_TEMPLATE_HINTS = {
    plain: "白字 + 黑色描边，最稳妥的通用字幕。",
    karaoke: "字随念白逐个点亮（金色扫过），适合口播与强调台词。",
    pop: "字幕从 45% 放大弹入并淡入，适合综艺感短剧。",
    gradient: "从粉到蓝逐字渐变，适合情绪与氛围向内容。",
    neon: "粉色霓虹描边 + 阴影，适合都市 / 悬疑风格。",
    comic: "黄色粗描边综艺字，适合搞笑与高能片段。",
  };
  // 音效库（本地程序化合成）。id 必须与后端 sfx_library.SFX_LIBRARY 一致，
  // 否则合片时会因为找不到音效 id 被跳过。
  const SFX_LIBRARY = [
    { id: "footstep", label: "脚步声", keywords: ["走", "跑", "脚步", "进入", "离开", "走过"] },
    { id: "door", label: "开门声", keywords: ["门", "推门", "开门", "关上"] },
    { id: "impact", label: "撞击/摔物", keywords: ["撞", "摔", "砸", "跌", "倒", "打", "击"] },
    { id: "wind", label: "风声", keywords: ["风", "吹", "空旷", "荒野"] },
    { id: "heartbeat", label: "心跳声", keywords: ["心跳", "紧张", "恐惧", "惊慌", "喘"] },
    { id: "shutter", label: "相机快门", keywords: ["拍照", "相机", "快门", "闪光灯"] },
    { id: "sword", label: "刀剑碰撞", keywords: ["刀", "剑", "砍", "斩", "兵器"] },
    { id: "gunshot", label: "枪声", keywords: ["枪", "开枪", "射击", "扣动扳机"] },
    { id: "explosion", label: "爆炸", keywords: ["爆炸", "轰", "炸", "爆"] },
    { id: "water", label: "水滴", keywords: ["水", "雨", "滴", "泼", "雨滴"] },
    { id: "whoosh", label: "呼啸掠过", keywords: ["掠过", "划过", "闪过", "疾驰", "冲出"] },
  ];
  // 音效自动匹配：按镜头标题/动作/台词里的关键词打分。
  const matchSfxForShot = shot => {
    const text = [shot.title, shot.action, shot.dialogue, shot.camera].filter(Boolean).join(" ").toLowerCase();
    if (!text.trim()) return [];
    const scored = SFX_LIBRARY.map(item => {
      let score = 0;
      item.keywords.forEach(keyword => { if (text.includes(keyword.toLowerCase())) score += 1 + keyword.length / 10; });
      return { id: item.id, score };
    }).filter(item => item.score > 0).sort((a, b) => b.score - a.score);
    return scored.slice(0, 3).map(item => item.id);
  };
  const emptyPackaging = () => ({
    voice: "zh-CN-YunxiNeural", rate: 6, pitch: 0,
    // voiceMap: 角色名 → 音色。多人短剧全都用同一个声音是最常见的观感硬伤。
    voiceMap: {},
    tts: { enabled: false, lines: {}, meta: {}, voices: {}, volume: 1.0, style: "drama", generatedAt: "" },
    subtitles: {
      enabled: true, maxChars: 14, cues: [], srt: "", generatedAt: "",
      // template: 花字模板（逐字高亮/弹入/渐变/霓虹/综艺），与后端 SUBTITLE_TEMPLATES 对齐。
      style: { size: 46, position: "bottom", color: "white", boxed: false, outline: 0, font: "Microsoft YaHei", marginV: 0, template: "plain" },
    },
    bgm: { enabled: false, track: "builtin", url: "", volume: 0.22, fadeIn: 1.5, fadeOut: 2.0 },
    // 音效：按镜头 id 指定音效（本地合成的拟音库），map = {shotId: [sfxId]}。
    sfx: { enabled: false, volume: 0.6, map: {}, auto: false },
    // sourceMode: keep=保留镜头原声（含模型自带人声）；mute=丢弃原声，只留配音与 BGM。
    // 模型视频常常自带人声（我们给它的提示词里写了台词），再叠一层配音就会出现两句重复台词。
    video: { transition: "fade", transitionDuration: 0.4, grade: "cinema", speed: 1.0, sourceMode: "auto", sourceVolume: 0.6, resolution: "1080", fit: "blur" },
    cover: { title: "", subtitle: "", url: "", generatedAt: "" },
  });
  const normalizePackaging = (value) => {
    const base = emptyPackaging();
    const source = value && typeof value === "object" ? value : {};
    const pack = { ...base, ...source };
    pack.tts = { ...base.tts, ...(source.tts || {}) };
    pack.tts.lines = { ...(pack.tts.lines || {}) };
    pack.tts.meta = { ...(pack.tts.meta || {}) };
    pack.tts.voices = { ...(pack.tts.voices || {}) };
    pack.voiceMap = { ...(pack.voiceMap || {}) };
    pack.subtitles = { ...base.subtitles, ...(source.subtitles || {}) };
    pack.subtitles.style = { ...base.subtitles.style, ...((source.subtitles || {}).style || {}) };
    pack.subtitles.cues = Array.isArray(pack.subtitles.cues) ? pack.subtitles.cues : [];
    pack.bgm = { ...base.bgm, ...(source.bgm || {}) };
    pack.sfx = { ...base.sfx, ...(source.sfx || {}) };
    pack.sfx.map = { ...(pack.sfx.map || {}) };
    pack.video = { ...base.video, ...(source.video || {}) };
    pack.cover = { ...base.cover, ...(source.cover || {}) };
    return pack;
  };
  const promptVersion = (prompt, source = "system", note = "") => ({ id: uid("prompt"), prompt: String(prompt || ""), source, note, createdAt: now() });

  const uid = (prefix = "id") => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const now = () => new Date().toISOString();
  const esc = (value = "") => String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
  const clamp = (number, min, max) => Math.max(min, Math.min(max, number));

  // 原生 <select> 的下拉弹层由 QtWebEngine 自己画：浅色白底、宽度不受页面控制，展开时还会拖着一条
  // 一直拉长的白边，并且经常越过窗口右缘被裁掉。这里统一拦掉原生弹层，改成自绘深色菜单；
  // <select> 元素本身保留 value 与 change 语义，所有既有的事件绑定与数据流都不用改。
  const selectMenu = { node: null, select: null, active: -1 };

  const selectMenuItems = () => (selectMenu.node ? Array.from(selectMenu.node.querySelectorAll(".cselect-option")) : []);

  const closeSelectMenu = () => {
    if (selectMenu.node) selectMenu.node.remove();
    if (selectMenu.select) selectMenu.select.removeAttribute("aria-expanded");
    selectMenu.node = null;
    selectMenu.select = null;
    selectMenu.active = -1;
  };

  const paintSelectActive = (index) => {
    const items = selectMenuItems();
    if (!items.length) return;
    selectMenu.active = Math.max(0, Math.min(items.length - 1, index));
    items.forEach((item, position) => item.classList.toggle("is-active", position === selectMenu.active));
    const active = items[selectMenu.active];
    if (!active || !selectMenu.node) return;
    const top = active.offsetTop;
    const bottom = top + active.offsetHeight;
    if (top < selectMenu.node.scrollTop) selectMenu.node.scrollTop = Math.max(0, top - 6);
    else if (bottom > selectMenu.node.scrollTop + selectMenu.node.clientHeight) {
      selectMenu.node.scrollTop = bottom - selectMenu.node.clientHeight + 6;
    }
  };

  const commitSelect = (option) => {
    const select = selectMenu.select;
    if (!select || !option || option.disabled) return;
    closeSelectMenu();
    select.value = option.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  };

  const openSelectMenu = (select) => {
    closeSelectMenu();
    const options = Array.from(select.options);
    if (!options.length) return;
    const node = document.createElement("div");
    node.className = "cselect-menu";
    node.setAttribute("role", "listbox");
    node.innerHTML = options.map((option, index) => `<button type="button" role="option" class="cselect-option" data-index="${index}" aria-selected="${option.selected}" ${option.disabled ? "disabled" : ""}><span class="cselect-text">${esc(option.text)}</span>${option.selected ? '<i class="cselect-tick" aria-hidden="true">✓</i>' : ""}</button>`).join("");
    document.body.appendChild(node);
    selectMenu.node = node;
    selectMenu.select = select;
    select.setAttribute("aria-expanded", "true");
    const rect = select.getBoundingClientRect();
    node.style.width = `${Math.max(Math.round(rect.width), 168)}px`;
    const box = node.getBoundingClientRect();
    const left = Math.max(10, Math.min(rect.left, window.innerWidth - box.width - 10));
    const below = rect.bottom + 6;
    const top = below + box.height <= window.innerHeight - 10 ? below : Math.max(10, rect.top - box.height - 6);
    node.style.left = `${Math.round(left)}px`;
    node.style.top = `${Math.round(top)}px`;
    paintSelectActive(Math.max(0, options.findIndex(option => option.selected)));
    node.addEventListener("click", event => {
      const item = event.target.closest(".cselect-option");
      if (!item || item.disabled) return;
      commitSelect(options[Number(item.dataset.index)]);
    });
    node.addEventListener("pointermove", event => {
      const item = event.target.closest(".cselect-option");
      if (item && !item.disabled) paintSelectActive(Number(item.dataset.index));
    });
  };

  document.addEventListener("pointerdown", event => {
    const target = event.target instanceof Element ? event.target : null;
    const select = target?.closest("select");
    if (selectMenu.node && !target?.closest(".cselect-menu")) closeSelectMenu();
    if (!select || select.multiple || select.disabled) return;
    event.preventDefault();
    if (selectMenu.select === select) { closeSelectMenu(); return; }
    try { select.focus({ preventScroll: true }); } catch (error) { select.focus(); }
    openSelectMenu(select);
  }, true);

  document.addEventListener("keydown", event => {
    if (!selectMenu.select) return;
    const inside = !(event.target instanceof Element) || event.target === selectMenu.select || event.target.closest(".cselect-menu");
    if (!inside) { closeSelectMenu(); return; }
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeSelectMenu(); selectMenu.select?.blur(); return; }
    if (event.key === "Tab") { closeSelectMenu(); return; }
    const steps = { ArrowDown: 1, ArrowUp: -1, PageDown: 5, PageUp: -5 };
    if (event.key in steps) { event.preventDefault(); event.stopPropagation(); paintSelectActive(selectMenu.active + steps[event.key]); return; }
    if (event.key === "Home" || event.key === "End") { event.preventDefault(); event.stopPropagation(); paintSelectActive(event.key === "Home" ? 0 : selectMenuItems().length - 1); return; }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      const item = selectMenuItems()[selectMenu.active];
      const select = selectMenu.select;
      if (item && select) commitSelect(select.options[Number(item.dataset.index)]);
    }
  }, true);

  window.addEventListener("resize", closeSelectMenu);
  document.addEventListener("scroll", event => {
    if (!selectMenu.node) return;
    if (selectMenu.node.contains(event.target)) return;
    closeSelectMenu();
  }, true);

  const sampleScript = `雨夜，顾岚在废弃广播站收到一盘写着自己名字的磁带。
磁带里传来七天后的新闻：跨江大桥将在午夜坍塌，而她是唯一失踪者。
她找到维修工程师程野，两人潜入大桥控制室，发现事故并非意外。
倒计时只剩二十分钟，顾岚必须在公开真相和救出被困弟弟之间做出选择。`;

  const makeDemoProject = () => ({
    id: uid("project"),
    name: "雾港回声",
    genre: "都市悬疑",
    format: "9:16",
    createdAt: now(),
    updatedAt: now(),
    episodes: [{
      id: uid("episode"),
      title: "EP01 · 失真的预告",
      script: sampleScript,
      beats: [
        { id: uid("beat"), title: "异常来信", text: "顾岚在废弃广播站收到写着自己名字的磁带。", location: "废弃广播站", mood: "潮湿、戒备" },
        { id: uid("beat"), title: "未来新闻", text: "磁带预告跨江大桥将在午夜坍塌，顾岚也将失踪。", location: "广播站监听室", mood: "压迫、疑云" },
        { id: uid("beat"), title: "潜入控制室", text: "顾岚与程野进入大桥控制室，确认事故是人为制造。", location: "大桥控制室", mood: "紧迫、冷峻" },
        { id: uid("beat"), title: "最后选择", text: "倒计时逼近，顾岚在公开真相和救人之间作出决定。", location: "跨江大桥", mood: "爆发、决绝" },
      ],
      assets: {
        characters: [
          { id: uid("asset"), name: "顾岚", note: "女，28岁调查记者，短发，冷静但执拗", prompt: "Chinese investigative journalist, 28, short black hair, dark raincoat, alert eyes, cinematic realism" },
          { id: uid("asset"), name: "程野", note: "男，32岁桥梁维修工程师，沉默可靠", prompt: "Chinese bridge engineer, 32, work jacket, restrained expression, practical equipment, cinematic realism" },
        ],
        scenes: [
          { id: uid("asset"), name: "废弃广播站", note: "雨夜、老式设备与闪烁指示灯", prompt: "abandoned radio station at rainy night, analog consoles, blinking lights, atmospheric suspense" },
          { id: uid("asset"), name: "跨江大桥", note: "午夜、雾气与警示灯", prompt: "river bridge at midnight, heavy fog, warning lights, wet steel, cinematic wide shot" },
        ],
        props: [{ id: uid("asset"), name: "预告磁带", note: "磨损磁带，标签写有顾岚名字", prompt: "worn cassette tape with handwritten label, macro cinematic prop shot" }],
      },
      shots: [],
      tasks: [],
      logs: [{ id: uid("log"), at: now(), text: "创建商业工作台示例项目；尚未提交任何外部模型请求。" }],
    }],
  });

  const videoPreset = vendor => {
    if (vendor === "zhipu") return { vendor: "zhipu", label: "视频模型", baseUrl: ZHIPU_VIDEO_BASE, endpoint: ZHIPU_VIDEO_ENDPOINT, model: "cogvideox-flash", imageToVideoModel: "cogvideox-flash" };
    if (vendor === "dashscope") return { vendor: "dashscope", label: "视频模型", baseUrl: DASHSCOPE_VIDEO_BASE, endpoint: DASHSCOPE_VIDEO_ENDPOINT, model: "wan3.0-video", imageToVideoModel: "wan3.0-video", freeTierOnlyConfirmed: false };
    if (vendor === "tencent") return { vendor: "tencent", label: "视频模型", baseUrl: TENCENT_VIDEO_BASE, endpoint: TENCENT_VIDEO_ENDPOINT, model: "hunyuan-video", imageToVideoModel: "hunyuan-video", freeTierOnlyConfirmed: false, resolution: "720p" };
    return { vendor: "agentPlan", label: "视频模型", baseUrl: AGENT_PLAN_VIDEO_BASE, endpoint: AGENT_PLAN_VIDEO_ENDPOINT, model: "doubao-seedance-2.0", imageToVideoModel: "doubao-seedance-2.0" };
  };

  // 智谱的图片与视频共用同一个 open.bigmodel.cn Key。用户通常只在一张卡片里粘贴过一次，
  // 另一个通道必须能自动借用——否则会误报「未配置视频模型 API Key（智谱开放平台）」，
  // 而实际上 Key 就躺在本机另一个通道里（这是视频整批失败的真实原因）。
  const ZHIPU_SECRET_SIBLING = { imageZhipu: "videoZhipu", videoZhipu: "imageZhipu" };
  const zhipuSiblingSecret = name => ZHIPU_SECRET_SIBLING[name] || "";

  const ARK_IMAGE_BASE = "https://ark.cn-beijing.volces.com/api/v3";
  const ARK_IMAGE_ENDPOINT = "/images/generations";
  const ARK_IMAGE_MODEL = "doubao-seedream-5-0-flash-260915";
  // 阿里百炼 · 万相：唯一能同时做到「参考图锁角色 + 不带水印 + 有免费额度」的通道。
  const DASHSCOPE_IMAGE_BASE = "https://dashscope.aliyuncs.com";
  const DASHSCOPE_IMAGE_ENDPOINT = "/api/v1/services/aigc/multimodal-generation/generation";
  const DASHSCOPE_IMAGE_MODELS = ["wan2.7-image", "wan2.7-image-pro", "qwen-image-2.1-pro"];
  const imagePreset = vendor => {
    if (vendor === "zhipu") return { vendor: "zhipu", label: "图片模型", baseUrl: ZHIPU_IMAGE_BASE, endpoint: ZHIPU_IMAGE_ENDPOINT, model: "cogview-3-flash" };
    if (vendor === "dashscope") return { vendor: "dashscope", label: "图片模型", baseUrl: DASHSCOPE_IMAGE_BASE, endpoint: DASHSCOPE_IMAGE_ENDPOINT, model: "wan2.7-image" };
    return { vendor: "ark", label: "图片模型", baseUrl: ARK_IMAGE_BASE, endpoint: ARK_IMAGE_ENDPOINT, model: ARK_IMAGE_MODEL };
  };
  // 三种通道的返回结构不同：方舟/智谱是 data[0].url，万相是 output.choices[0].message.content[].image。
  const imageResult = (data) => {
    const dashscopeUrl = data?.output?.choices?.[0]?.message?.content?.find?.(part => part && part.image)?.image;
    if (dashscopeUrl) return { source: dashscopeUrl, isData: false };
    const item = data?.data?.[0] || {};
    if (item.b64_json) return { source: `data:image/png;base64,${item.b64_json}`, isData: true };
    return { source: item.url || "", isData: false };
  };
  // 竖屏短剧的 9:16 是 0.5625，而 1024:1536 是 2:3（0.667）——差这一档，
  // 首帧会变成比 9:16 更宽的画面，后面的图生视频会原样继承这个比例，
  // 合成主片时要么加黑边要么被裁。此处按项目画幅出真正等比的尺寸。
  const imageSizeFor = ({ vendor, model, square = false } = {}) => {
    const portrait = getProject().format === "9:16";
    if (vendor === "zhipu") return square ? "1024x1024" : (model === "cogview-3-flash" ? "1024x1024" : (portrait ? "720x1440" : "1440x720"));
    if (vendor === "dashscope") return (square ? "1024*1024" : (portrait ? "864*1536" : "1536*864"));
    return square ? "1024x1024" : (portrait ? "1024x1536" : "1536x1024");
  };
  // 统一的图片请求构造：万相支持最多 9 张参考图。多人镜头不能固定截成 4 张，
  // 否则第三个角色会在请求前就被丢掉；其它通道仍保守限制为 4 张。
  const imageReferenceLimit = vendor => (vendor === "dashscope" ? 9 : vendor === "zhipu" ? 3 : 4);
  const imagePayloadOf = async (prompt, { refs = [], square = false } = {}) => {
    const cfg = state.settings.providers.image;
    const vendor = cfg.vendor || "ark";
    const model = cfg.model;
    const size = imageSizeFor({ vendor, model, square });
    const limit = imageReferenceLimit(vendor);
    const list = (refs || []).filter(Boolean).slice(0, limit);
    // 智谱同样支持最多 3 张参考图（image_url 数组）。旧版直接 return，参考图全被丢弃，
    // 定妆照/九宫格形同虚设，是“换脸、服装串戏”的主要来源；水印也要显式关掉。
    if (vendor === "zhipu") {
      const payload = { model, prompt, size, watermark_enabled: cfgImageWatermark() };
      const images = [];
      for (const ref of list) images.push(await mediaToDataUrl(ref));
      if (images.length) payload.image_url = images;
      return payload;
    }
    if (vendor === "dashscope") {
      const content = [];
      for (const ref of list) {
        const dataUrl = await shrinkImageDataUrl(await mediaToDataUrl(ref), 2_400_000);
        if (dataUrl) content.push({ image: dataUrl });
      }
      content.push({ text: prompt });
      return { model, input: { messages: [{ role: "user", content }] }, parameters: { size, n: 1, watermark: cfgImageWatermark() } };
    }
    const payload = { model, prompt, size, watermark: cfgImageWatermark(), n: 1 };
    const images = [];
    for (const ref of list) images.push(await mediaToDataUrl(ref));
    if (images.length) payload.image = images.length === 1 ? images[0] : images;
    return payload;
  };
  // 图片水印：默认关闭（智谱的水印由平台规则决定），只有用户在「模型与设置」里
  // 显式打开才带 true。三条图片通道的 payload 都读它，所以放在构造器前面。
  const cfgImageWatermark = () => {
    const provider = cfgActiveProvider("image");
    if (!provider) return false;
    const bucket = cfgBucket("image", provider.id);
    const model = state.settings.providers?.image?.model || bucket.model;
    const value = bucket.models?.[model]?.watermark ?? bucket.options?.watermark;
    return value === true || value === "true";
  };

  const imagePayloadFor = async (shot, vendor, model) => {
    // 旧版截到 1000 字，多角色镜头的“参考图对照/角色数量/禁重复”规则会被整段截掉，
    // 模型只看到前半段提示词，自然无法按图锁人。
    const limit = imageReferenceLimit(vendor);
    const prompt = `${buildProductionPrompt(shot, { forceReferences: true, includeDialogue: false, referenceLimit: limit })}\n首帧定帧图，单一画面，不要分镜网格，不得渲染任何文字。`.slice(0, 3500);
    const size = imageSizeFor({ vendor, model });
    const list = videoReferenceUrls(shot).filter(Boolean).slice(0, limit);
    if (vendor === "zhipu") {
      const payload = { model, prompt, size, watermark_enabled: cfgImageWatermark() };
      const images = [];
      for (const ref of list) images.push(await mediaToDataUrl(ref));
      if (images.length) payload.image_url = images;
      return payload;
    }
    if (vendor === "dashscope") {
      const content = [];
      for (const ref of list) {
        // 9 张参考图原样塞进请求会超过本机代理上限，且模型侧也吃不下；
        // 统一压到 2.4MB 以内的 JPEG，既保留身份细节又不丢参考图位次。
        const dataUrl = await shrinkImageDataUrl(await mediaToDataUrl(ref), 2_400_000);
        if (dataUrl) content.push({ image: dataUrl });
      }
      content.push({ text: prompt });
      return { model, input: { messages: [{ role: "user", content }] }, parameters: { size, n: 1, watermark: cfgImageWatermark() } };
    }
    const payload = { model, prompt, size, watermark: cfgImageWatermark(), n: 1 };
    const images = [];
    for (const ref of list) images.push(await mediaToDataUrl(ref));
    if (images.length) payload.image = images.length === 1 ? images[0] : images;
    return payload;
  };

  const defaultSettings = () => ({
    rememberSecrets: false,
    providers: {
      chat: { label: "对话模型", baseUrl: "https://api.deepseek.com", endpoint: "/chat/completions", model: "deepseek-v4-flash" },
      image: { vendor: "ark", label: "图片模型", baseUrl: ARK_IMAGE_BASE, endpoint: ARK_IMAGE_ENDPOINT, model: ARK_IMAGE_MODEL },
      video: { label: "视频模型", vendor: "agentPlan", baseUrl: AGENT_PLAN_VIDEO_BASE, endpoint: AGENT_PLAN_VIDEO_ENDPOINT, model: "doubao-seedance-2.0", imageToVideoModel: "doubao-seedance-2.0" },
    },
  });

  function shotCharacterContext(shot) {
    return [shot?.title, shot?.action, shot?.dialogue, shot?.prompt, shot?.speaker].filter(Boolean).join(" ").replace(/\s+/g, "");
  }

  // 结构化解析可能只绑定说话人，也可能保留已经被删除的旧角色 ID。每次载入和重建
  // 分镜时都清掉失效 ID，并把标题/动作/对白/提示词里明确出现的所有角色补齐。
  // 只修绑定，不改已有成片和质检状态，避免历史项目被迁移逻辑破坏。
  function repairShotCharacterBindings(episode, shot) {
    const characters = episode?.assets?.characters || [];
    const validIds = new Set(characters.map(item => item.id));
    const explicit = (Array.isArray(shot.characterIds) ? shot.characterIds : []).filter(id => validIds.has(id));
    const context = shotCharacterContext(shot);
    const mentioned = characters.filter(item => item.name && context.includes(String(item.name).replace(/\s+/g, ""))).map(item => item.id);
    shot.characterIds = [...new Set([...explicit, ...mentioned])];
    return shot.characterIds;
  }

  function sharedCharacterIds(first, second) {
    const right = new Set(second?.characterIds || []);
    return [...new Set(first?.characterIds || [])].filter(id => right.has(id));
  }

  function canChainShotFrame(source, target, { manual = false } = {}) {
    if (!source?.lastFrameUrl || !target || source.id === target.id) return false;
    if (sharedCharacterIds(source, target).length) return true;
    // 人工选择续帧来源时，允许“同一场景、不同角色”的镜头作为空间锚点；
    // 旧版强制要求共同角色，导致空镜/反打镜头根本无法自由选源。
    return Boolean(manual && source.sceneId && source.sceneId === target.sceneId);
  }

  function assignChainSource(target, source, { manual = false } = {}) {
    if (!canChainShotFrame(source, target, { manual })) return false;
    target.firstFrameUrl = source.lastFrameUrl;
    target.chainSourceShotId = source.id;
    target.chainSourceManual = Boolean(manual);
    target.firstFrameOrigin = "chain";
    target.qc = null;
    return true;
  }

  const defaultState = () => {
    const project = makeDemoProject();
    return { version: 1, currentProjectId: project.id, currentEpisodeId: project.episodes[0].id, projects: [project], settings: defaultSettings() };
  };

  /**
   * 把「一个模块一个配置对象」的老结构，铺成「每家服务商一个配置桶」：
   *   settings.vendors[chat|image|video][服务商 id] = { baseUrl, endpoint, model, options, models }
   * 老配置（state.settings.providers）里用户已经填过的地址/模型要搬进当前启用的那家，
   * 否则升级后界面会显示默认值，用户会以为配置丢了。
   * 只搬一次（vendorsSchemaVersion 标记），之后不再覆盖用户在界面里的改动。
   */
  const seedVendorSettings = (candidate) => {
    const settings = candidate.settings || (candidate.settings = {});
    if (!settings.vendors || typeof settings.vendors !== "object") settings.vendors = {};
    MODEL_SCHEMA.modules.forEach((mod) => {
      const table = settings.vendors[mod.kind] || (settings.vendors[mod.kind] = {});
      const legacy = settings.providers?.[mod.kind] || {};
      const legacyVendor = legacy.vendor || SCHEMA_KIND_DEFAULT_VENDOR[mod.kind];
      const matching = (mod.providers || []).find(item => item.vendor === legacyVendor);
      (mod.providers || []).forEach((provider) => {
        const bucket = table[provider.id] || (table[provider.id] = {});
        if (!bucket.baseUrl) bucket.baseUrl = provider.defaults.baseUrl;
        if (!bucket.endpoint) bucket.endpoint = provider.defaults.endpoint;
        if (!bucket.model) bucket.model = provider.defaults.model;
        if (!bucket.options || typeof bucket.options !== "object") bucket.options = {};
        if (!bucket.models || typeof bucket.models !== "object") bucket.models = {};
        // 老配置只可能落在当前启用的那一家上
        if (settings.vendorsSchemaVersion !== 2 && matching && provider.id === matching.id) {
          if (legacy.baseUrl) bucket.baseUrl = legacy.baseUrl;
          if (legacy.endpoint) bucket.endpoint = legacy.endpoint;
          if (legacy.model) bucket.model = legacy.model;
          if (legacy.resolution) bucket.options.resolution = legacy.resolution;
        }
      });
    });
    settings.vendorsSchemaVersion = 2;
    return settings.vendors;
  };

  const normalizeState = (candidate) => {
    const defaults = defaultSettings();
    candidate.settings ||= defaults;
    candidate.settings.providers = { ...defaults.providers, ...(candidate.settings.providers || {}) };
    ["chat", "image", "video"].forEach(type => {
      const provider = candidate.settings.providers[type] || {};
      if (type === "image") {
        const vendor = provider.vendor === "dashscope" || provider.baseUrl === DASHSCOPE_IMAGE_BASE
          ? "dashscope"
          : (provider.vendor === "zhipu" || provider.baseUrl === ZHIPU_IMAGE_BASE ? "zhipu" : "ark");
        const preset = imagePreset(vendor);
        const drifted = !provider.baseUrl
          || provider.baseUrl === "https://api.openai.com"
          || provider.baseUrl !== preset.baseUrl
          || provider.endpoint !== preset.endpoint
          || (vendor === "zhipu" && !ZHIPU_IMAGE_MODELS.includes(provider.model))
          || (vendor === "dashscope" && !DASHSCOPE_IMAGE_MODELS.includes(provider.model));
        if (drifted) {
          // 早期版本的图片配置没有 vendor 字段；火山 Key 在本机仍可用时保持火山通道。
          if (vendor === "ark" && provider.baseUrl === ARK_IMAGE_BASE && provider.endpoint === ARK_IMAGE_ENDPOINT) {
            provider.vendor = "ark";
            provider.label = "图片模型";
            candidate.settings.providers.image = provider;
            return;
          }
          candidate.settings.providers.image = { ...preset };
          return;
        }
        provider.vendor = vendor;
        provider.label = "图片模型";
        candidate.settings.providers.image = provider;
        return;
      }
      if (type === "chat") {
        if (!provider.baseUrl || provider.baseUrl === "https://api.openai.com") candidate.settings.providers[type] = defaults.providers[type];
        return;
      }
      // 以前这里只认 zhipu / 其它，其它一律当 agentPlan 并重置——用户切到万相后
      // 下次打开会被静默改回火山（欠费时表现为「明明配好了却不能生成」）。
      const vendor = provider.vendor === "zhipu" ? "zhipu" : (provider.vendor === "dashscope" ? "dashscope" : (provider.vendor === "tencent" ? "tencent" : "agentPlan"));
      const preset = videoPreset(vendor);
      const models = vendor === "zhipu" ? ZHIPU_VIDEO_MODELS : (vendor === "dashscope" ? DASHSCOPE_VIDEO_MODELS : (vendor === "tencent" ? TENCENT_VIDEO_MODELS : AGENT_PLAN_VIDEO_MODELS));
      const drifted = !provider.baseUrl
        || provider.baseUrl === "https://api.openai.com"
        || provider.baseUrl !== preset.baseUrl
        || provider.endpoint !== preset.endpoint
        || !models.includes(provider.model);
      if (drifted) {
        // 早期版本的视频配置（火山按量、DashScope 等）统一迁移到当前选定的通道。
        if (vendor === "agentPlan") videoProviderMigrated = true;
        candidate.settings.providers.video = { ...preset };
        return;
      }
      provider.vendor = vendor;
      provider.label = "视频模型";
      if (vendor === "zhipu" || vendor === "tencent") provider.imageToVideoModel = provider.model;
      else if (!models.includes(provider.imageToVideoModel)) provider.imageToVideoModel = preset.imageToVideoModel;
      candidate.settings.providers.video = provider;
    });
    seedVendorSettings(candidate);
    // 界面接管过配置后以 vendors 桶为准：上面那套「地址与预设不一致就重置成预设」的老逻辑
    // 会把用户在设置页里填的自定义地址直接抹掉（表现为改完保存、重开又变回去）。
    if (candidate.settings.vendorsManaged) {
      ["chat", "image", "video"].forEach((kind) => {
        const current = candidate.settings.providers[kind];
        const def = schemaProviders(kind).find(item => item.vendor === current?.vendor);
        const bucket = def && candidate.settings.vendors[kind]?.[def.id];
        if (!def || !bucket) return;
        const runtime = {
          ...current,
          vendor: def.vendor,
          baseUrl: bucket.baseUrl || def.defaults.baseUrl,
          endpoint: bucket.endpoint || def.defaults.endpoint,
          model: bucket.model || def.defaults.model,
          secretName: def.secret[0].slot,
        };
        if (kind === "video") runtime.imageToVideoModel = runtime.model;
        candidate.settings.providers[kind] = runtime;
      });
    }
    candidate.projects.forEach(project => {
      project.artDirection = { ...emptyArtDirection(), ...(project.artDirection || {}) };
      project.assetLibrary ||= { characters: [], scenes: [], props: [] };
      ["characters", "scenes", "props"].forEach(type => {
        if (!Array.isArray(project.assetLibrary[type])) project.assetLibrary[type] = [];
      });
      project.episodes?.forEach(episode => {
      episode.assets ||= { characters: [], scenes: [], props: [] };
      episode.scriptCheckpoint ||= { stage: episode.beats?.length ? "completed" : "idle", updatedAt: now(), error: "" };
      episode.scriptVersions ||= [];
      episode.targetDuration ||= "60";
      episode.language ||= "中文";
      episode.visualStyle ||= "电影写实";
      episode.packaging = normalizePackaging(episode.packaging);
      const studio = { ...emptyStudio(), ...(episode.storyboardStudio || {}) };
      studio.params = { ...StudioCore.defaultParams(), ...(studio.params || {}) };
      studio.segments = (Array.isArray(studio.segments) ? studio.segments : []).map((segment, segmentIndex) => ({
        ...segment,
        id: segment.id || uid("segment"),
        label: segment.label || `片段 ${segmentIndex + 1}`,
        status: ["idle", "queued", "generating", "done", "failed"].includes(segment.status) ? segment.status : "idle",
        error: segment.error || "",
        shots: (Array.isArray(segment.shots) ? segment.shots : []).map((shot, shotIndex) => ({
          ...shot,
          id: shot.id || uid("draft"),
          index: Number(shot.index) || shotIndex + 1,
          duration: Number(shot.duration) || 5,
          description: String(shot.description || ""),
          dialogue: String(shot.dialogue || ""),
          speaker: String(shot.speaker || ""),
          prompt: String(shot.prompt || ""),
          characterNames: Array.isArray(shot.characterNames) ? shot.characterNames : [],
          selected: shot.selected !== false,
          status: shot.status || "draft",
          method: shot.method || "ai",
        })),
      }));
      episode.storyboardStudio = studio;
      ["characters", "scenes", "props"].forEach(type => {
        if (!Array.isArray(episode.assets[type])) episode.assets[type] = [];
        episode.assets[type].forEach(asset => {
          asset.referenceImage ||= "";
          asset.referenceStatus ||= asset.referenceImage ? "ready" : "missing";
          asset.promptStatus ||= asset.prompt ? "ready" : "missing";
          asset.referenceOutdated = Boolean(asset.referenceOutdated);
          asset.negativePrompt ||= QUALITY_NEGATIVE;
          asset.promptVersions ||= [];
          asset.version = Math.max(1, Number(asset.version) || 1);
          asset.libraryId ||= "";
          if (type === "characters" && typeof asset.faceRequired !== "boolean") {
            asset.faceRequired = !/(系统|光球|界面|AI\b|robot|orb|holographic)/i.test(`${asset.name} ${asset.note} ${asset.prompt}`);
          }
          if (type === "characters") {
            asset.variations ||= [];
            asset.variations.forEach(variation => {
              variation.promptVersions ||= []; variation.referenceImage ||= ""; variation.status ||= variation.referenceImage ? "completed" : "pending";
            });
            asset.turnaround = { ...emptyTurnaround(), ...(asset.turnaround || {}) };
            if (!Array.isArray(asset.turnaround.panelUrls)) asset.turnaround.panelUrls = [];
            if (!Array.isArray(asset.turnaround.panels) || asset.turnaround.panels.length !== 9) asset.turnaround.panels = emptyTurnaround().panels;
            if (asset.turnaround.imageUrl && asset.turnaround.status === "missing") asset.turnaround.status = "uploaded";
          }
        });
      });
      episode.shots ||= [];
      episode.tasks ||= [];
      episode.logs ||= [];
      // 排队中的任务在刷新/重载前没有任务 ID 也绝不能判失败：它还没真正提交过、不可能计费。
      // 保留为 queued，启动后由 autoResumeQueue 自动续排，否则每次热重载都会把排队打断（这是「越等越失败」的真正原因之一）。
      episode.tasks.forEach(task=>{
        if(["submitted","generating"].includes(task.status)){
          if(task.taskId){task.status="submitted";task.message=`发现可恢复任务 ${task.taskId}，可在生成执行页续查`;}
          else if(task.queued || /限流|排队/.test(String(task.message||""))){task.status="queued";task.message="免费通道限流排队中，重载后自动继续（未提交、不会重复计费）";}
          else{task.status="failed";task.message="应用重载前请求未取得任务 ID，已安全标记失败，避免重复计费";}
        }
        if(task.status==="queued"){task.queued=true;task.queueNextAt=Number(task.queueNextAt)||0;}
      });
      episode.shots.forEach(shot => {
        shot.characterIds ||= [];
        shot.sceneId ||= "";
        shot.propIds ||= [];
        shot.firstFrameUrl ||= "";
        shot.lastFrameUrl ||= "";
        shot.negativePrompt ||= QUALITY_NEGATIVE;
        shot.promptVersions ||= [];
        shot.characterVariations ||= {};
        shot.storyboardGrid = { ...emptyStoryboardGrid(), ...(shot.storyboardGrid || {}) };
        shot.planQuality ||= null;
        shot.videoInputMode ||= "text";
        shot.motionStrength = Number.isFinite(Number(shot.motionStrength)) ? Number(shot.motionStrength) : .55;
        shot.chainSourceShotId ||= "";
        shot.firstFrameOrigin ||= shot.chainSourceShotId ? "chain" : (shot.firstFrameUrl ? "manual" : "");
        shot.qc ||= null;
        shot.selected = Boolean(shot.selected);
        if(shot.status==="generating"||shot.status==="queued"){const resumable=episode.tasks.find(task=>task.shotId===shot.id&&task.taskId&&["submitted","generating"].includes(task.status));const waiting=episode.tasks.find(task=>task.shotId===shot.id&&task.status==="queued");shot.status=(resumable||waiting)?"queued":"failed";}
        repairShotCharacterBindings(episode, shot);
        if (!shot.sceneId) {
          const context = `${shot.title || ""} ${shot.action || ""} ${shot.prompt || ""}`;
          shot.sceneId = episode.assets.scenes.find(scene => sceneMatchesContext(context, scene.name))?.id || "";
        }
      });
      // 旧版会把任意上一镜尾帧盲接到下一镜。载入时清理没有共同角色的旧帧链，
      // 但保留人工上传或模型生成的独立首帧。
      episode.shots.forEach(shot => {
        if (!shot.chainSourceShotId) return;
        const source = episode.shots.find(item => item.id === shot.chainSourceShotId);
        if (source && canChainShotFrame(source, shot)) return;
        shot.chainSourceShotId = "";
        if (shot.firstFrameOrigin === "chain") shot.firstFrameUrl = "";
        shot.firstFrameOrigin = shot.firstFrameUrl ? "manual" : "";
      });
    });
    });
    return candidate;
  };

  const loadState = () => {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (parsed?.version === 1 && Array.isArray(parsed.projects)) {
        return normalizeState(parsed);
      }
    } catch (error) {
      console.warn("项目数据读取失败，将创建新工作区。", error);
    }
    return normalizeState(defaultState());
  };

  let state = loadState();
  let snapshotRevision = Number(state.externalRevision || 0);
  let secrets = (() => {
    try {
      const session = JSON.parse(sessionStorage.getItem(SESSION_SECRET_KEY) || "{}");
      const local = state.settings.rememberSecrets ? JSON.parse(localStorage.getItem(LOCAL_SECRET_KEY) || "{}") : {};
      return { ...local, ...session };
    } catch { return {}; }
  })();
  // 本机（服务端）到底有哪些密钥可用，以及浏览器里存的 Key 与它是不是同一把。
  // 旧版本的 Key 被轮换后仍留在 localStorage，会盖住可用的本机密钥，最终表现为 401。
  let serverSecrets = { chat: false, image: false, imageZhipu: false, imageDashscope: false, video: false, videoZhipu: false, videoDashscope: false, videoTencentId: false, videoTencentKey: false };
  const staleSecrets = new Set();
  // 记录每把 Key 的来历：手填的尊重用户，自动写入的允许被本机密钥替换。
  const SECRET_ORIGIN_KEY = "xinghe_api_secret_origin";
  let secretOrigins = (() => { try { return JSON.parse(localStorage.getItem(SECRET_ORIGIN_KEY) || "{}"); } catch { return {}; } })();
  const saveSecretOrigins = () => { try { localStorage.setItem(SECRET_ORIGIN_KEY, JSON.stringify(secretOrigins)); } catch {} };
  const keyFingerprint = async (value) => {
    if (!value || value === SERVER_SECRET_SENTINEL) return "";
    try {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
      return Array.from(new Uint8Array(digest)).slice(0, 5).map(byte => byte.toString(16).padStart(2, "0")).join("");
    } catch { return ""; }
  };
  // 从控制台复制 Key 常混入零宽字符、全角空格或「Key：」这类中文前缀。请求头只能用 latin-1，
  // 非 ASCII 会在本地服务里抛编码错误并原样弹给用户，所以在入库前就清掉。
  const normalizeKey = (raw) => String(raw || "")
    .replace(/[\u200b-\u200d\ufeff\u00a0]/g, "")
    .replace(/\u3000/g, " ")
    .split("")
    .filter(char => char >= "!" && char <= "~")
    .join("");
  const keyWasAdjusted = (raw) => {
    const trimmed = String(raw || "").trim();
    return Boolean(trimmed) && normalizeKey(trimmed) !== trimmed;
  };

  // 腾讯云 CAM 密钥的形状是固定的：SecretId 以 AKID 开头共 36 位，SecretKey 共 32 位。
  // 混元视频走的是 VCLM 云 API（vclm.tencentcloudapi.com），只认 CAM 的 SecretId/SecretKey。
  // 而 TokenHub（大模型服务平台）的 API Key 是 ak-xxx / sk-xxx，对 VCLM 完全无效，
  // 腾讯云只会回一句没头没尾的「SecretId不存在」。这里提前拦下来，直接告诉用户去哪个控制台。
  const TENCENT_SECRET_ID_PATTERN = /^AKID[0-9A-Za-z]{32}$/;
  const TENCENT_SECRET_KEY_PATTERN = /^[0-9A-Za-z]{32}$/;
  const describeTencentCredentialProblem = (secretId, secretKey) => {
    const id = String(secretId || "").trim();
    const key = String(secretKey || "").trim();
    if (!id && !key) return "";
    if (id && !key) return "腾讯云 SecretId 与 SecretKey 必须成对填写，缺一个都无法签名。";
    if (id && /^ak[-_]/i.test(id)) {
      return "这看起来是 TokenHub（大模型服务平台）的 API Key（ak- 开头），不是腾讯云 CAM 密钥。"
        + "混元生视频调用的是 VCLM 云 API，只认 CAM 的 SecretId/SecretKey。"
        + "请到 https://console.cloud.tencent.com/cam/capi（访问管理 → API 密钥管理）新建密钥，"
        + "复制那对 AKID 开头的 SecretId 与 32 位 SecretKey。";
    }
    if (key && /^sk[-_]/i.test(key)) {
      return "这看起来是 TokenHub（大模型服务平台）的 API Key（sk- 开头），不是腾讯云 CAM 密钥。"
        + "混元生视频调用的是 VCLM 云 API，只认 CAM 的 SecretId/SecretKey。"
        + "请到 https://console.cloud.tencent.com/cam/capi（访问管理 → API 密钥管理）新建密钥。";
    }
    if (id && !TENCENT_SECRET_ID_PATTERN.test(id)) {
      return `腾讯云 SecretId 格式不对：应为 AKID 开头共 36 位，当前 ${id.length} 位。`
        + "请到 https://console.cloud.tencent.com/cam/capi 重新复制，别复制到 TokenHub 的 Key ID。";
    }
    if (key && !TENCENT_SECRET_KEY_PATTERN.test(key)) {
      return `腾讯云 SecretKey 格式不对：应为 32 位英文字母数字，当前 ${key.length} 位。`
        + "请到 https://console.cloud.tencent.com/cam/capi 重新复制完整密钥。";
    }
    return "";
  };

  if (videoProviderMigrated) {
    delete secrets.video;
    for (const storage of [sessionStorage, localStorage]) {
      try {
        const saved = JSON.parse(storage.getItem(storage === sessionStorage ? SESSION_SECRET_KEY : LOCAL_SECRET_KEY) || "{}");
        delete saved.video;
        storage.setItem(storage === sessionStorage ? SESSION_SECRET_KEY : LOCAL_SECRET_KEY, JSON.stringify(saved));
      } catch {}
    }
  }

  const persist = () => {
    const project = getProject();
    if (project) project.updatedAt = now();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    clearTimeout(snapshotSaveTimer);
    snapshotSaveTimer = setTimeout(() => {
      fetch("/api/workspace-snapshot", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state }),
      }).then(async response => {
        if (response.status === 409) {
          await syncExternalSnapshot();
          return;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const saved = await response.json();
        const revision = Number(saved?.revision || 0);
        if (revision > snapshotRevision) {
          snapshotRevision = revision;
          state.externalRevision = revision;
          localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        }
      }).catch(error => console.warn("工作区快照保存失败。", error));
    }, 450);
  };

  const saveSecrets = () => {
    const browserSecrets = Object.fromEntries(Object.entries(secrets).filter(([, value]) => value && value !== SERVER_SECRET_SENTINEL));
    sessionStorage.setItem(SESSION_SECRET_KEY, JSON.stringify(browserSecrets));
    if (state.settings.rememberSecrets) localStorage.setItem(LOCAL_SECRET_KEY, JSON.stringify(browserSecrets));
    else localStorage.removeItem(LOCAL_SECRET_KEY);
  };

  const getProject = () => state.projects.find(item => item.id === state.currentProjectId) || state.projects[0];
  const getEpisode = () => {
    const project = getProject();
    return project?.episodes.find(item => item.id === state.currentEpisodeId) || project?.episodes[0];
  };

  const showToast = (message, isError = false) => {
    clearTimeout(toastTimer);
    toastNode.textContent = message;
    toastNode.className = `toast show${isError ? " error" : ""}`;
    toastTimer = setTimeout(() => { toastNode.className = "toast"; }, 3600);
  };

  // 下载 / 系统播放器 / 单镜预览：时间轴和预览弹层共用，避免逻辑分叉。
  const downloadMedia = (url = "") => {
    const name = decodeURIComponent(String(url).split("/").pop() || "");
    if (!name) { showToast("没有可下载的文件。", true); return; }
    const link = document.createElement("a");
    link.href = `/api/download-media/${encodeURIComponent(name)}`;
    link.download = name;
    document.body.appendChild(link); link.click(); link.remove();
    showToast(`开始下载 ${name}，选好保存位置即可。`);
  };

  const openMedia = async (url = "") => {
    try {
      const response = await fetch("/api/open-media", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || data.error || "打开失败");
      showToast(`已用系统播放器打开 ${data.opened || "文件"}。`);
    } catch (error) { showToast(error.message, true); }
  };

  const closeClipPreview = () => document.querySelector(".clip-preview")?.remove();

  const openClipPreview = (data = {}) => {
    closeClipPreview();
    const wrap = document.createElement("div");
    wrap.className = "modal-backdrop clip-preview";
    wrap.innerHTML = `<section class="modal clip-player" role="dialog" aria-modal="true" aria-label="${esc(data.title || "镜头预览")}"><div class="panel-title"><div><span class="badge">镜头预览</span><h3>${esc(data.title || "镜头")}</h3></div><button class="btn ghost" data-clip-close>关闭</button></div><video controls autoplay playsinline src="${esc(playbackSrc(data.url || ""))}"${data.poster ? ` poster="${esc(data.poster)}"` : ""}></video><div class="modal-actions"><button class="btn ghost" data-clip-download>下载原片</button><button class="btn ghost" data-clip-open>系统播放器</button></div></section>`;
    document.body.appendChild(wrap);
    wrap.addEventListener("click", event => {
      if (event.target === wrap || event.target.closest("[data-clip-close]")) { closeClipPreview(); return; }
      if (event.target.closest("[data-clip-download]")) downloadMedia(data.url);
      if (event.target.closest("[data-clip-open]")) openMedia(data.url);
    });
    wrap.querySelector("video")?.play?.().catch(() => {});
  };

  const addLog = (text, details = {}) => {
    const episode = getEpisode();
    if (!episode) return;
    episode.logs.unshift({ id: uid("log"), at: now(), text, ...details });
    episode.logs = episode.logs.slice(0, 80);
    persist();
  };

  const navItems = [
    ["dashboard", "◈", "项目总览"],
    ["script", "✎", "剧本拆解"],
    ["assets", "◇", "角色与资产"],
    ["prompts", "Aa", "创作控制"],
    ["storyboard", "▦", "分镜导演"],
    ["generation", "▶", "生成执行"],
    ["delivery", "⇩", "交付中心"],
    ["settings", "⚙", "模型与设置"],
  ];

  // 环境类失败（欠费 / 额度用尽 / Key 失效 / 网络）跟镜头内容无关：
  // 一旦命中就记一条全局告警，只在顶部提示一次，不把每个镜头都标成「失败」。
  const ENV_ISSUE_PATTERN = /Arrearage|overdue|in good standing|欠费|余额不足|insufficient|配额|AuthenticationError|401|403|Failed to fetch|fetch failed|ECONN|ETIMEDOUT/i;
  const isEnvIssue = message => ENV_ISSUE_PATTERN.test(String(message || ""));
  const ENV_ALERT_KEY = "xinghe_env_alert_v1";
  const readEnvAlert = () => { try { return JSON.parse(localStorage.getItem(ENV_ALERT_KEY) || "null"); } catch { return null; } };
  const raiseEnvAlert = (message, channel) => {
    try { localStorage.setItem(ENV_ALERT_KEY, JSON.stringify({ message: String(message || ""), channel: channel || "", at: Date.now() })); } catch { /* 隐私模式忽略 */ }
  };
  const clearEnvAlert = () => { try { localStorage.removeItem(ENV_ALERT_KEY); } catch { /* ignore */ } };
  const envAlertBar = () => {
    const alert = readEnvAlert();
    if (!alert) return "";
    const episode = getEpisode();
    const pending = (episode?.shots || []).filter(shot => !shot.mediaUrl).length;
    return `<div class="env-alert">
      <div><strong>${esc(alert.channel || "模型")}通道被平台拦下了：账户额度不足 / 欠费 / Key 失效</strong>
      <p>${esc(providerHint(alert.message) || alert.message)}</p>
      <p class="hint">${pending
        ? `本集还有 ${pending} 个镜头未出片，会保持「未完成」而不是「失败」；充值后直接续跑，已完成的不会重复计费。`
        : "充值后重新提交即可；已完成的镜头不会重复生成。"}</p></div>
      <div class="env-alert-actions">
        <a class="btn ghost" href="https://bailian.console.aliyun.com" target="_blank" rel="noreferrer">打开百炼控制台</a>
        <button class="btn ghost" data-action="env-alert-free" data-vendor="zhipu">切到免费通道</button>
        <button class="btn tiny ghost" data-action="env-alert-dismiss">已处理，关闭</button>
      </div>
    </div>`;
  };

  const shell = (content) => {
    const project = getProject();
    const episode = getEpisode();
    const episodes = project?.episodes || [];
    return `<div class="shell">
      <div class="bg-art" aria-hidden="true"><i></i><i></i><i></i></div>
      <aside class="sidebar">
        <div class="brand"><div class="brand-mark"><img src="./assets/app-icon.png" alt="星河制片台"></div><div><h1>星河制片台</h1><p>AI DRAMA PIPELINE</p></div></div>
        <div class="nav-label">PRODUCTION DESK</div>
        <nav class="nav">${navItems.map(([id, icon, label]) => `<button data-action="nav" data-view="${id}" class="${currentView === id ? "active" : ""}"><span class="nav-ico">${icon}</span>${label}</button>`).join("")}</nav>
        <div class="sidebar-foot"><strong>星河制片台 · XINGHE DESK</strong><br>© 2026 linweinanlin新增部分 · 上游 MIT<br>v2.0.0 · 数据保存在本机<br><small class="foot-mark" title="溯源标记 XHPD-2026-7f3c91a4d0e5b28c">未经许可不得改名再分发</small></div>
      </aside>
      <section class="workspace">
        <header class="topbar">
          <div class="crumb"><small>${navItems.find(item => item[0] === currentView)?.[2] || "工作台"}</small><h2>${esc(project?.name || "未命名项目")}</h2></div>
          <div class="top-actions">
            <select class="episode-select" data-action="episode-select" aria-label="选择剧集">${episodes.map(item => `<option value="${item.id}" ${item.id === episode?.id ? "selected" : ""}>${esc(item.title)}</option>`).join("")}</select>
            <button class="btn ghost" data-action="new-episode">＋ 新剧集</button>
            <button class="btn ghost" data-action="rename-project" data-id="${project?.id || ""}" title="修改当前项目名称">✏️ 改名</button>
            <button class="btn primary" data-action="quick-export">导出项目</button>
          </div>
        </header>
        <main class="main"><div class="page">${envAlertBar()}${content}</div></main>
      </section>
    </div>`;
  };

  const completion = (episode) => {
    if (!episode) return 0;
    let score = 0;
    if (episode.script.trim()) score += 16;
    if (episode.beats.length) score += 18;
    if (Object.values(episode.assets).some(list => list.length)) score += 18;
    if (episode.shots.length) score += 24;
    const videoTasks = episode.tasks.filter(task => task.kind === "视频");
    if (videoTasks.length && videoTasks.every(task => task.status === "completed" && episode.shots.find(shot => shot.id === task.shotId)?.qc?.passed)) score += 24;
    return score;
  };

  const renderDashboard = () => {
    const project = getProject();
    const episode = getEpisode();
    const assets = episode ? Object.values(episode.assets).flat().length : 0;
    const doneTasks = episode?.tasks.filter(task => task.kind === "视频" && task.status === "completed" && episode.shots.find(shot => shot.id === task.shotId)?.qc?.passed).length || 0;
    const percent = completion(episode);
    return `<section class="hero">
      <div><span class="eyebrow">Original commercial production desk</span><h3>从文字到镜头，<br>把创作变成可控生产。</h3><p>项目、剧集、资产、分镜、模型与交付统一在本机工作区。所有外部模型都由你自行配置，系统不会伪装真实生成结果。</p><div class="actions" style="margin-top:20px"><button class="btn primary" data-action="nav" data-view="script">继续制作</button><button class="btn ghost" data-action="new-project">新建项目</button></div></div>
      <div class="hero-stats"><div class="mini-stat"><b>${percent}%</b><span>本集完成度</span></div><div class="mini-stat"><b>${episode?.shots.length || 0}</b><span>分镜数量</span></div><div class="mini-stat"><b>${assets}</b><span>资产条目</span></div><div class="mini-stat"><b>${doneTasks}</b><span>真实完成任务</span></div></div>
    </section>
    <div class="grid cols-4" style="margin-top:14px">
      ${[["✎", episode?.beats.length || 0, "剧情节拍"],["◇",assets,"角色/场景/道具"],["▦",episode?.shots.length || 0,"导演分镜"],["▶",episode?.tasks.length || 0,"生成任务"]].map(([icon,n,label])=>`<div class="card metric"><div class="metric-ico">${icon}</div><div><b>${n}</b><span>${label}</span></div></div>`).join("")}
    </div>
    <div class="section-head"><div><h3>项目空间</h3><p>本机保存，可导入导出；商业交付包不包含旧受限模块。</p></div><div class="actions"><button class="btn ghost" data-action="import-project">导入 JSON</button><button class="btn primary" data-action="new-project">＋ 新建项目</button></div></div>
    <div class="grid cols-3">${state.projects.map(item => {
      const first = item.episodes[0]; const p = completion(first);
      return `<article class="card project-card ${item.id === project?.id ? "active" : ""}" data-action="open-project" data-id="${item.id}"><div class="project-top"><span class="badge">${esc(item.genre || "漫剧")}</span><span style="display:flex;gap:8px;align-items:center"><button class="btn ghost" data-action="rename-project" data-id="${item.id}" style="padding:2px 10px;font-size:12px" title="修改项目名称">改名</button><span class="hint">${new Date(item.updatedAt).toLocaleDateString()}</span></span></div><h4 style="font-size:18px;margin-top:14px">${esc(item.name)}</h4><p>${item.episodes.length} 集 · ${esc(item.format || "9:16")} · ${first?.shots.length || 0} 镜头</p><div class="progress"><i style="width:${p}%"></i></div></article>`;
    }).join("")}</div>
    <div class="section-head"><div><h3>最近运行日志</h3><p>只记录任务状态，不记录 API Key。</p></div></div>${renderLogs(episode)}`;
  };

  const renderLogs = (episode) => episode?.logs.length ? `<div class="card"><div class="timeline">${episode.logs.slice(0, 30).map(log => `<div class="log"><time>${new Date(log.at).toLocaleString()}</time><p>${esc(log.text)}</p>${log.model||log.taskId||log.durationMs?`<div class="log-detail">${log.model?`<span>模型 ${esc(log.model)}</span>`:""}${log.taskId?`<span>任务 ${esc(log.taskId)}</span>`:""}${log.durationMs?`<span>${Math.round(log.durationMs/100)/10}s</span>`:""}</div>`:""}${log.prompt?`<details><summary>查看生产提示词</summary><pre>${esc(log.prompt)}</pre></details>`:""}</div>`).join("")}</div></div>` : `<div class="empty"><b>暂无日志</b>执行拆解、生成或导出后会记录在这里。</div>`;

  const renderScript = () => {
    const episode = getEpisode();
    const checkpoint = episode?.scriptCheckpoint || { stage: "idle" };
    return `<div class="section-head"><div><h3>剧本拆解</h3><p>先保存文本，再选择本地规则拆解或调用已配置的对话模型。</p></div><div class="actions"><button class="btn ghost" data-action="ai-continue-script">AI 续写</button><button class="btn ghost" data-action="ai-rewrite-script">AI 改写</button><button class="btn ghost" data-action="rollback-script" ${episode.scriptVersions?.length?"":"disabled"}>剧本回滚</button><button class="btn ghost" data-action="local-breakdown">本地拆解</button><button class="btn violet" data-action="ai-breakdown">AI 结构化解析</button><button class="btn primary" data-action="save-script">保存剧本</button></div></div>
      <div class="checkpoint-bar"><span class="badge ${checkpoint.stage==="completed"?"ok":checkpoint.stage==="failed"?"err":"warn"}">解析检查点：${esc(checkpoint.stage)}</span><span>${checkpoint.updatedAt?new Date(checkpoint.updatedAt).toLocaleString():"尚未建立"}</span>${checkpoint.error?`<small>${esc(checkpoint.error)}</small>`:""}</div>
      <div class="card script-config"><div class="form-row"><div class="form-group"><label>目标时长（秒）</label><input class="field" id="script-duration" type="number" min="10" max="3600" value="${esc(episode.targetDuration)}"></div><div class="form-group"><label>语言</label><select class="select" id="script-language">${["中文","英文","日文"].map(item=>`<option ${episode.language===item?"selected":""}>${item}</option>`).join("")}</select></div><div class="form-group"><label>视觉风格</label><input class="field" id="script-style" value="${esc(episode.visualStyle)}"></div><div class="form-group"><label>画幅</label><select class="select" id="script-format">${["9:16","16:9","1:1"].map(item=>`<option ${getProject().format===item?"selected":""}>${item}</option>`).join("")}</select></div></div></div>
      <div class="split"><section class="card"><div class="panel-title"><h3>原始剧本</h3><span class="badge">${episode?.script.length || 0} 字</span></div><textarea id="script-input" class="textarea" placeholder="粘贴故事、剧本或对白…">${esc(episode?.script || "")}</textarea><p class="hint" style="margin-top:9px">本地拆解不发送网络请求；AI 解析会明确调用“模型与设置”中的对话接口。</p></section>
      <section class="card"><div class="panel-title"><h3>剧情节拍</h3><span class="badge ${episode?.beats.length ? "ok" : "warn"}">${episode?.beats.length || 0} 段</span></div><div class="beat-list">${episode?.beats.length ? episode.beats.map((beat,index)=>`<article class="beat"><span class="beat-num">${String(index+1).padStart(2,"0")}</span><b>${esc(beat.title)}</b><p>${esc(beat.text)}</p><div class="shot-meta"><span>${esc(beat.location || "待定场景")}</span><span>${esc(beat.mood || "待定情绪")}</span></div></article>`).join("") : `<div class="empty"><b>还没有节拍</b>保存剧本后点击“本地拆解”或“AI 结构化解析”。</div>`}</div></section></div>`;
  };

  const assetLabels = { characters: ["角色", "人物身份、外观与表演锚点", "人物"], scenes: ["场景", "空间、时间、光线与氛围", "场"], props: ["道具", "叙事关键物与视觉细节", "物"] };
  const turnaroundReady = asset => asset.faceRequired === false || (asset.turnaround?.status === "completed" && asset.turnaround?.imageUrl && asset.turnaround?.panelUrls?.length === 9 && asset.turnaround?.qc?.passed);
  const archivePrompt = (owner, source = "manual-edit", note = "") => {
    owner.promptVersions ||= [];
    if (owner.prompt && owner.promptVersions.at(-1)?.prompt !== owner.prompt) owner.promptVersions.push(promptVersion(owner.prompt, source, note));
    owner.promptVersions = owner.promptVersions.slice(-20);
  };
  const assetTypeFor = id => Object.entries(getEpisode().assets).find(([,list])=>list.some(item=>item.id===id))?.[0] || "";
  const markAssetPromptChanged = asset => {
    asset.version=(Number(asset.version)||1)+1;asset.promptStatus="ready";asset.referenceOutdated=Boolean(asset.referenceImage);
    const episode=getEpisode();const type=assetTypeFor(asset.id);episode.shots.forEach(shot=>{const used=type==="characters"?shot.characterIds.includes(asset.id):type==="scenes"?shot.sceneId===asset.id:(shot.propIds||[]).includes(asset.id);if(used)shot.qc=null;});
  };
  const editAssetPrompt = (id,type=assetTypeFor(id)) => {
    const asset=findAsset(id);if(!asset)return;document.querySelector("#asset-prompt-modal")?.remove();
    const label=assetLabels[type]?.[0]||"资产";const wrapper=document.createElement("div");wrapper.id="asset-prompt-modal";wrapper.className="modal-backdrop";
    wrapper.innerHTML=`<section class="modal prompt-modal" role="dialog" aria-modal="true" aria-label="编辑${label}提示词"><div class="panel-title"><div><span class="badge">${label}</span><h3>编辑「${esc(asset.name)}」提示词</h3></div><button class="btn ghost" data-modal-close>关闭</button></div><div class="form-group"><label>资产说明</label><textarea id="asset-note-editor" class="textarea small-area">${esc(asset.note||"")}</textarea></div><div class="form-group"><label>正向提示词</label><textarea id="asset-positive-editor" class="textarea prompt-editor-area" placeholder="主体＋外观/空间/材质＋构图＋光影＋风格">${esc(asset.prompt||"")}</textarea><small class="hint">建议清楚写明主体、环境、构图、光影和风格；参考图只负责约束视觉，不替代文字说明。</small></div><div class="form-group"><label>负向提示词</label><textarea id="asset-negative-editor" class="textarea small-area">${esc(asset.negativePrompt||QUALITY_NEGATIVE)}</textarea></div><div class="modal-actions"><button class="btn ghost" data-modal-ai>AI 重新生成</button><button class="btn primary" data-modal-save>保存修改</button></div></section>`;
    document.body.appendChild(wrapper);const close=()=>wrapper.remove();wrapper.querySelector("[data-modal-close]").addEventListener("click",close);wrapper.addEventListener("click",event=>{if(event.target===wrapper)close();});
    wrapper.querySelector("[data-modal-save]").addEventListener("click",()=>{const next=wrapper.querySelector("#asset-positive-editor").value.trim();const negative=wrapper.querySelector("#asset-negative-editor").value.trim();const note=wrapper.querySelector("#asset-note-editor").value.trim();if(!next)return showToast("正向提示词不能为空。",true);if(next!==asset.prompt)archivePrompt(asset,"manual-edit","编辑前版本");asset.prompt=next;asset.negativePrompt=negative||QUALITY_NEGATIVE;asset.note=note;markAssetPromptChanged(asset);addLog(`${label}「${asset.name}」提示词已手动编辑。`);persist();close();render();showToast("提示词已保存。");});
    wrapper.querySelector("[data-modal-ai]").addEventListener("click",()=>{close();generateAssetPrompt(id,type);});
  };
  const generateAssetPrompt = async (id,type=assetTypeFor(id)) => {
    const asset=findAsset(id);if(!asset)return;const label=assetLabels[type]?.[0]||"资产";asset.promptStatus="generating";persist();render();showToast(`正在用对话模型生成${label}提示词…`);
    try{const cfg=state.settings.providers.chat;const art=getProject().artDirection||emptyArtDirection();const requirements={characters:"锁定单一角色身份：性别、年龄、脸型、五官、发型、体型、服装、配饰和气质；输出适合定妆参考图的单人中性姿态，不出现其他人物。",scenes:"描述空间结构、时代地域、时间天气、光线、色彩、材质、景深与镜头构图；作为纯场景概念图，不出现抢镜人物。",props:"描述单个道具的造型、结构、材质、颜色、磨损、比例、标志细节与产品级构图；不出现手持者。"}[type]||"描述主体、构图、光影、材质和风格。";
      const schema='只输出 JSON：{"prompt":"","negativePrompt":"","note":""}。prompt 用可直接生图的中文自然语言，信息完整但控制在 300 个汉字以内；negativePrompt 写禁止项；note 用一句中文概括资产视觉锚点。';
      const data=await proxyRequest("chat",{model:cfg.model,thinking:{type:"disabled"},temperature:.25,response_format:{type:"json_object"},messages:[{role:"system",content:"你是影视美术概念设计与 AI 生图提示词专家。不得输出 Markdown，只输出合法 JSON。"}, {role:"user",content:`${schema}\n资产类型：${label}\n名称：${asset.name}\n现有说明：${asset.note||"无"}\n现有提示词：${asset.prompt||"无"}\n要求：${requirements}\n全局美术指导：色彩=${art.palette}；光影=${art.lighting}；质感=${art.texture}；角色规则=${art.characterRules}；锚点=${art.anchors}`} ]});
      const parsed=parseJsonText(data?.choices?.[0]?.message?.content);const next=String(parsed.prompt||"").trim();if(!next)throw new Error("模型未返回有效提示词");archivePrompt(asset,"ai-generated","AI 生成前版本");asset.prompt=next;asset.negativePrompt=String(parsed.negativePrompt||QUALITY_NEGATIVE).trim();asset.note=String(parsed.note||asset.note||"").trim();markAssetPromptChanged(asset);addLog(`${label}「${asset.name}」提示词由 ${cfg.model} 生成。`,{model:cfg.model,prompt:next});showToast("AI 提示词已生成，可继续手动编辑。");
    }catch(error){asset.promptStatus="failed";addLog(`${label}「${asset.name}」AI 提示词生成失败：${error.message}`);showToast(error.message,true);}persist();render();
  };
  const rollbackAssetPrompt = id => {
    const asset = findAsset(id); const history = asset?.promptVersions || []; if (!history.length) return showToast("没有可回滚的提示词版本。", true);
    const latest = history.pop(); archivePrompt(asset, "rollback", "回滚前版本"); asset.prompt = latest.prompt; markAssetPromptChanged(asset);
    persist(); render(); showToast(`已回滚「${asset.name}」提示词。`);
  };
  const cloneForLibrary = (asset, type) => ({ ...structuredClone(asset), id: uid("library"), sourceAssetId: asset.id, type, version: Math.max(1, Number(asset.version) || 1), updatedAt: now() });
  const saveAssetToLibrary = (id, type) => {
    const asset = findAsset(id); const project = getProject(); if (!asset || !project) return;
    project.assetLibrary ||= { characters: [], scenes: [], props: [] };
    const list = project.assetLibrary[type]; const index = list.findIndex(item => item.sourceAssetId === asset.id || (asset.libraryId && item.id === asset.libraryId));
    const item = cloneForLibrary(asset, type);
    if (index >= 0) { item.id = list[index].id; item.version = (Number(list[index].version) || 1) + 1; list[index] = item; } else list.push(item);
    asset.libraryId = item.id; asset.libraryVersion = item.version; addLog(`资产「${asset.name}」已保存到项目资产库 v${item.version}。`); persist(); render();
  };
  const importLibraryAsset = (libraryId, type) => {
    const source = getProject().assetLibrary?.[type]?.find(item => item.id === libraryId); if (!source) return;
    const target = structuredClone(source); target.id = uid("asset"); target.libraryId = source.id; target.libraryVersion = source.version; delete target.sourceAssetId; delete target.type; delete target.updatedAt;
    getEpisode().assets[type].push(target); addLog(`从项目资产库导入「${target.name}」v${source.version}。`); persist(); render();
  };
  const syncLibraryAsset = (id, type) => {
    const asset = findAsset(id); const source = getProject().assetLibrary?.[type]?.find(item => item.id === asset?.libraryId); if (!asset || !source) return;
    const keepId = asset.id; const synced = structuredClone(source); Object.assign(asset, synced, { id: keepId, libraryId: source.id, libraryVersion: source.version });
    delete asset.sourceAssetId; delete asset.type; delete asset.updatedAt; addLog(`资产「${asset.name}」已同步到项目库 v${source.version}。`); persist(); render();
  };
  const renderVariations = asset => !asset.variations?.length ? "" : `<div class="variation-strip">${asset.variations.map(item => `<div class="variation-chip">${item.referenceImage ? `<img src="${esc(item.referenceImage)}" alt="${esc(item.name)}">` : `<span>衣</span>`}<b>${esc(item.name)}</b><small>${esc(item.status || "pending")}</small><button class="btn tiny ghost" data-action="upload-variation" data-id="${asset.id}" data-variation-id="${item.id}">上传</button><button class="btn tiny violet" data-action="generate-variation" data-id="${asset.id}" data-variation-id="${item.id}">生成</button><button class="btn tiny danger" data-action="delete-variation" data-id="${asset.id}" data-variation-id="${item.id}">×</button></div>`).join("")}</div>`;
  const renderAssets = () => {
    const episode = getEpisode();
    const card = (asset, type, symbol) => {
      const isCharacter = type === "characters";
      const referenceLabel = { characters: "定妆图", scenes: "场景参考图", props: "道具参考图" }[type] || "参考图";
      const gridReady = isCharacter && turnaroundReady(asset);
      const gridFailed = isCharacter && asset.turnaround?.status === "qc_failed";
      // 图已经生成、只是切分/质检没跑完：不能再说「缺少九宫格转面图」，否则用户会重复出图。
      const gridPending = isCharacter && Boolean(asset.turnaround?.imageUrl) && (asset.turnaround?.panelUrls || []).length !== 9 && !gridFailed;
      const visual = isCharacter && asset.turnaround?.imageUrl
        ? `<div class="asset-image-stack">${asset.referenceImage ? `<img class="asset-portrait" src="${esc(asset.referenceImage)}" alt="${esc(asset.name)}定妆图">` : ""}<img class="asset-reference turnaround" src="${esc(asset.turnaround.imageUrl)}" alt="${esc(asset.name)}九宫格转面图"></div>`
        : asset.referenceImage ? `<img class="asset-reference" src="${esc(asset.referenceImage)}" alt="${esc(asset.name)}定妆图">` : `<div class="asset-symbol">${symbol}</div>`;
      const library = asset.libraryId ? getProject().assetLibrary?.[type]?.find(item => item.id === asset.libraryId) : null;
      const outdated = library && Number(library.version || 1) > Number(asset.libraryVersion || 0);
      const promptState = { ready:["提示词已就绪","ok"], generating:["AI 正在生成",""], failed:["AI 生成失败","err"], missing:["缺少提示词","warn"] }[asset.promptStatus] || [asset.prompt ? "提示词已就绪" : "缺少提示词", asset.prompt ? "ok" : "warn"];
      return `<article class="card asset-card">${visual}<h4>${esc(asset.name)}</h4><p>${esc(asset.note)}</p>
        <div class="asset-prompt-box"><div class="prompt-status-row"><b>当前提示词</b><span class="badge ${promptState[1]}">${promptState[0]}</span></div><p>${esc(asset.prompt || "尚未生成，可点击“AI 生成提示词”或手动编辑。")}</p>${asset.negativePrompt ? `<small>负向：${esc(asset.negativePrompt)}</small>` : ""}</div>
        <div class="meta">
        <span class="badge ${asset.referenceImage ? "ok" : "warn"}">${asset.referenceImage ? `${referenceLabel}已锁定` : `缺少${referenceLabel}`}</span>
        ${asset.referenceOutdated ? `<span class="badge warn">参考图基于旧提示词，请重新生成或上传</span>` : ""}
        ${isCharacter ? `<span class="badge ${gridReady ? "ok" : gridFailed ? "err" : "warn"}">${asset.faceRequired === false ? "非人形·九宫格可选" : gridReady ? "九宫格已质检" : gridFailed ? "九宫格质检未过" : gridPending ? "九宫格待切分（图已生成）" : "缺少九宫格转面图"}</span>` : ""}
        <button class="btn small ghost" data-action="upload-asset-ref" data-id="${asset.id}">上传${referenceLabel}</button><button class="btn small violet" data-action="generate-asset-ref" data-id="${asset.id}">生成${referenceLabel}</button>
        ${isCharacter ? `<button class="btn small ghost" data-action="upload-turnaround" data-id="${asset.id}">上传九宫格</button><button class="btn small violet" data-action="generate-turnaround" data-id="${asset.id}" ${asset.referenceImage ? "" : "disabled"}>生成九宫格</button>` : ""}
        ${isCharacter && asset.turnaround?.imageUrl ? `<button class="btn small ${gridPending ? "violet" : "ghost"}" data-action="reprocess-turnaround" data-id="${asset.id}">${gridPending ? "补做切分/质检" : "重新切分/质检"}</button>` : ""}
        ${isCharacter ? `<button class="btn small ghost" data-action="add-variation" data-id="${asset.id}">＋ 衣橱造型</button>` : ""}
        <button class="btn small violet" data-action="generate-asset-prompt" data-type="${type}" data-id="${asset.id}">AI 生成提示词</button><button class="btn small ghost" data-action="edit-asset-prompt" data-type="${type}" data-id="${asset.id}">手动编辑提示词</button><button class="btn small ghost" data-action="rollback-asset-prompt" data-id="${asset.id}" ${asset.promptVersions?.length ? "" : "disabled"}>回滚</button>
        <button class="btn small ghost" data-action="save-library" data-type="${type}" data-id="${asset.id}">${asset.libraryId ? "更新项目库" : "存入项目库"}</button>${outdated ? `<button class="btn small violet" data-action="sync-library" data-type="${type}" data-id="${asset.id}">同步 v${library.version}</button>` : ""}
        <button class="btn small ghost" data-action="copy-prompt" data-id="${asset.id}">复制提示词</button><button class="btn small danger" data-action="delete-asset" data-type="${type}" data-id="${asset.id}">删除</button>
        ${asset.turnaround?.qc ? `<div class="turnaround-qc"><b>九宫格质检：${asset.turnaround.qc.passed ? "通过" : "未通过"}</b><span>身份相似度 ${asset.turnaround.qc.metrics?.identitySimilarity == null ? "未测" : Math.round(asset.turnaround.qc.metrics.identitySimilarity * 100) + "%"}</span><span>视角差异 ${Math.round((asset.turnaround.qc.metrics?.viewDiversity || 0) * 100)}%</span>${(asset.turnaround.qc.warnings || []).map(item => `<small>${esc(item)}</small>`).join("")}</div>` : ""}
      </div>${isCharacter ? renderVariations(asset) : ""}<p class="hint">提示词版本 ${asset.promptVersions?.length || 0} · 资产版本 v${asset.version || 1}${asset.libraryId ? ` · 项目库 v${asset.libraryVersion || 1}` : ""}</p></article>`;
    };
    const librarySections = Object.entries(assetLabels).map(([type,[label,,symbol]]) => {
      const list = getProject().assetLibrary?.[type] || [];
      return `<section><div class="section-head"><div><h3>项目${label}库</h3><p>跨剧集复用并按版本同步，当前 ${list.length} 项。</p></div></div><div class="grid cols-4">${list.length ? list.map(item => `<article class="card compact"><div class="asset-symbol">${symbol}</div><h4>${esc(item.name)}</h4><p>${esc(item.note || "")}</p><span class="badge">v${item.version || 1}</span><button class="btn small ghost" data-action="import-library" data-type="${type}" data-id="${item.id}">导入本集</button></article>`).join("") : `<div class="empty" style="grid-column:1/-1"><b>项目${label}库为空</b>在上方资产卡片点击“存入项目库”。</div>`}</div></section>`;
    }).join("");
    return `<div class="section-head"><div><h3>角色与资产</h3><p>人物采用“定妆图＋3×3 九宫格转面图”；缺少或质检未过时禁止生成视频。</p></div><div class="actions"><button class="btn ghost" data-action="seed-assets">从节拍建立基础资产</button><button class="btn primary" data-action="add-asset" data-type="characters">＋ 新增角色</button></div></div>
      ${Object.entries(assetLabels).map(([type,[label,desc,symbol]])=>`<section><div class="section-head"><div><h3>${label}</h3><p>${desc}${type === "characters" ? "；真人角色必须具备九宫格多视角锚点。" : ""}</p></div><button class="btn small ghost" data-action="add-asset" data-type="${type}">＋ 添加${label}</button></div><div class="grid cols-3">${episode.assets[type].length ? episode.assets[type].map(asset=>card(asset,type,symbol)).join("") : `<div class="empty" style="grid-column:1/-1"><b>暂无${label}</b>从节拍建立，或手动添加。</div>`}</div></section>`).join("")}${librarySections}`;
  };

  const lintPrompt = value => {const text=String(value||"").trim();let score=100;const warnings=[];if(text.length<20){score-=35;warnings.push("描述过短");}if(text.length>1800){score-=20;warnings.push("可能超长");}if(!/(光|lighting|色|color|cinematic|电影)/i.test(text)){score-=15;warnings.push("缺少光影/风格");}if(/文字|字幕|水印|text|watermark/i.test(text)&&!/(禁止|不要|no\s)/i.test(text)){score-=20;warnings.push("可能诱发文字");}return{score:Math.max(0,score),warnings};};
  const renderPrompts = () => {
    const project = getProject(); const episode = getEpisode(); const art = project.artDirection || emptyArtDirection();
    const rows = [...Object.values(episode.assets).flat().map(item => ({ kind: "资产", name: item.name, prompt: item.prompt, versions: item.promptVersions?.length || 0 })), ...episode.shots.map(item => ({ kind: "镜头", name: item.title, prompt: item.prompt, versions: item.promptVersions?.length || 0 }))].map(item=>({...item,lint:lintPrompt(item.prompt)}));
    return `<div class="section-head"><div><h3>创作控制</h3><p>统一美术方向、负面约束与提示词版本；所有修改可回滚。</p></div><button class="btn primary" data-action="save-art-direction">保存美术指导</button></div>
      <div class="grid cols-2"><article class="card"><h4>全局美术指导</h4><div class="form-group"><label>色彩方案</label><input class="field" id="art-palette" value="${esc(art.palette)}"></div><div class="form-group"><label>光影</label><input class="field" id="art-lighting" value="${esc(art.lighting)}"></div><div class="form-group"><label>材质与画面质感</label><input class="field" id="art-texture" value="${esc(art.texture)}"></div><div class="form-group"><label>角色统一规则</label><textarea class="textarea small-area" id="art-character-rules">${esc(art.characterRules)}</textarea></div><div class="form-group"><label>一致性锚点</label><textarea class="textarea small-area" id="art-anchors">${esc(art.anchors)}</textarea></div></article>
      <article class="card"><h4>项目约束状态</h4><p>美术指导会自动注入资产、关键帧与视频生产提示词。</p><div class="qc-summary"><span>角色 ${episode.assets.characters.length}</span><span>场景 ${episode.assets.scenes.length}</span><span>道具 ${episode.assets.props.length}</span><span>分镜 ${episode.shots.length}</span><span>提示词历史 ${rows.reduce((sum,item)=>sum+item.versions,0)} 个版本</span></div><button class="btn ghost" data-action="generate-art-direction">由剧本生成建议</button></article></div>
      <div class="section-head"><div><h3>提示词台账</h3><p>显示当前生产提示词、版本与本地规则检查。</p></div></div><div class="card prompt-ledger">${rows.length ? rows.map(item => `<div class="prompt-row"><span class="badge">${item.kind}</span><b>${esc(item.name)}</b><p>${esc(item.prompt || "未设置")}</p><small><span class="badge ${item.lint.score>=80?"ok":item.lint.score<60?"err":"warn"}">Lint ${item.lint.score}</span> · ${item.versions} 个版本${item.lint.warnings.length?` · ${esc(item.lint.warnings.join("、"))}`:""}</small></div>`).join("") : `<div class="empty"><b>暂无提示词</b>先建立资产或分镜。</div>`}</div>`;
  };

  const shotStatusBadge = (status) => ({ draft: ["草稿","warn"], queued:["已入队",""], generating:["生成中",""], completed:["已完成","ok"], qc_failed:["质检未过","err"], failed:["失败","err"] }[status] || [status,"warn"]);
  const qcBadge = (shot) => {
    if (!shot.qc) return ["未质检", "warn"];
    return shot.qc.passed ? ["质检通过", "ok"] : ["质检未过", "err"];
  };
  const assessShotPlan = shot => {
    const checks = []; const add = (label, score, weight, details) => checks.push({ label, score, weight, passed: score >= 60, details });
    add("镜头信息", shot.title && shot.action && shot.camera && shot.duration ? 100 : 35, 20, "标题、动作、机位、时长");
    const mentionsPeople = Boolean(shot.speaker || shot.dialogue || shot.characterIds.length);
    add("角色绑定", !mentionsPeople || shot.characterIds.length ? 100 : 0, 25, mentionsPeople ? "人物镜头必须绑定角色" : "无人镜头");
    const assets = shotReferenceAssets(shot); const locked = assets.every(item => item.referenceImage && (item.faceRequired === false || turnaroundReady(item)));
    add("资产一致性", !mentionsPeople || locked ? 100 : 30, 25, "定妆图、九宫格与造型版本");
    add("提示词完整度", String(shot.prompt || "").length >= 24 ? 100 : String(shot.prompt || "").length >= 8 ? 65 : 20, 15, "画面提示词细节");
    add("帧连续性", shot.firstFrameUrl || shot.chainSourceShotId || !mentionsPeople ? 100 : 55, 15, "首帧或上一镜末帧");
    const score = Math.round(checks.reduce((sum,item)=>sum+item.score*item.weight/100,0));
    return { version: 1, score, grade: score >= 80 ? "pass" : score >= 60 ? "warning" : "fail", generatedAt: now(), checks, summary: score >= 80 ? "可进入生成" : "请补齐标记项" };
  };
  const gridPanelCount = shot => [4,6,9].includes(Number(shot.storyboardGrid?.panelCount)) ? Number(shot.storyboardGrid.panelCount) : 9;
  const renderShotGrid = shot => {
    const grid = shot.storyboardGrid || emptyStoryboardGrid(); if (!grid.imageUrl && !grid.panels?.length) return "";
    return `<div class="shot-grid-preview">${grid.imageUrl ? `<img src="${esc(grid.imageUrl)}" alt="${esc(shot.title)}镜头网格">` : ""}<div class="grid-panel-list">${(grid.panelUrls || []).map((url,index)=>`<button class="grid-panel-button" data-action="use-grid-panel" data-id="${shot.id}" data-index="${index}"><img src="${esc(url)}" alt="面板${index+1}"><span>用作首帧 ${index+1}</span></button>`).join("")}</div>${grid.panels?.length ? `<ol>${grid.panels.map(item=>`<li><b>${esc(item.shotSize)} · ${esc(item.cameraAngle)}</b>${esc(item.description)}</li>`).join("")}</ol>` : ""}</div>`;
  };
  // 失败判定：只看该镜头「最新一条任务」，且成片已质检通过就不再算失败，避免历史失败记录一直干扰选择。
  const shotRetryTask = shot => {
    const latest = getEpisode().tasks.find(task => task.shotId === shot.id);
    if (!latest || !["failed", "qc_failed"].includes(latest.status)) return null;
    if (latest.kind === "视频" && shot.mediaUrl && shot.qc?.passed) return null;
    if (latest.kind === "图片" && shot.firstFrameUrl && shot.status !== "failed") return null;
    return latest;
  };
  const shotIsFailed = shot => shot.status === "failed" || Boolean(shotRetryTask(shot));
  const shotSelectStats = () => {
    const shots = getEpisode().shots;
    return {
      total: shots.length,
      selected: shots.filter(item => item.selected).length,
      failed: shots.filter(shotIsFailed).length,
      failedSelected: shots.filter(shot => shot.selected && shotIsFailed(shot)).length,
      missing: shots.filter(shot => !shot.mediaUrl).length,
      done: shots.filter(shot => Boolean(shot.mediaUrl)).length,
    };
  };
  // 选择模式：failed / missing / all / none / invert。failed 只留失败镜，正是「只选这 3 个」的场景。
  const selectShots = (mode) => {
    const shots = getEpisode().shots;
    if (!shots.length) return showToast("当前集还没有分镜。", true);
    shots.forEach(shot => {
      if (mode === "failed") shot.selected = shotIsFailed(shot);
      else if (mode === "missing") shot.selected = !shot.mediaUrl;
      else if (mode === "done") shot.selected = Boolean(shot.mediaUrl);
      else if (mode === "all") shot.selected = true;
      else if (mode === "none") shot.selected = false;
      else if (mode === "invert") shot.selected = !shot.selected;
    });
    persist(); render();
    const count = getEpisode().shots.filter(shot => shot.selected).length;
    const label = { failed: "失败/质检未过", missing: "未生成成片", done: "已有成片", all: "全部", none: "清空", invert: "反选" }[mode] || mode;
    showToast(count ? `已按「${label}」选中 ${count} 个镜头。` : `按「${label}」没有匹配到镜头。`, !count);
  };
  const renderShotSelectBar = () => {
    const stats = shotSelectStats();
    if (!stats.total) return "";
    return `<div class="shot-select-bar">
      <span class="ssb-count">已选 <b>${stats.selected}</b> / ${stats.total} 镜</span>
      <div class="ssb-actions">
        <button class="btn tiny ghost" data-action="shots-select" data-mode="failed" ${stats.failed ? "" : "disabled"}>只选失败（${stats.failed}）</button>
        <button class="btn tiny ghost" data-action="shots-select" data-mode="missing" ${stats.missing ? "" : "disabled"}>只选未生成（${stats.missing}）</button>
        <button class="btn tiny ghost" data-action="shots-select" data-mode="all">全选</button>
        <button class="btn tiny ghost" data-action="shots-select" data-mode="none" ${stats.selected ? "" : "disabled"}>清空</button>
        <button class="btn tiny ghost" data-action="shots-select" data-mode="invert">反选</button>
        <button class="btn tiny primary" data-action="retry-selected-videos" ${stats.failedSelected ? "" : "disabled"} title="只重试当前勾选的失败镜头，其余失败镜头不动">重试所选视频（${stats.failedSelected}）</button>
        <button class="btn tiny violet" data-action="retry-failed-videos" ${stats.failed ? "" : "disabled"}>重试失败视频（${stats.failed}）</button>
      </div>
    </div>`;
  };
  const renderStoryboard = () => {
    const episode = getEpisode();
    const characters = episode.assets.characters;
    const scenes = episode.assets.scenes;
    const props = episode.assets.props;
    const studioSegments = studioState().segments || [];
    const studioShots = studioDrafts().length;
    const queued = episode.tasks.filter(task => ["queued", "submitted", "generating"].includes(task.status)).length;
    const ready = episode.shots.filter(shot => shot.mediaUrl && shot.qc?.passed).length;
    const failed = episode.shots.filter(shotIsFailed).length;
    const imageCfg = state.settings.providers.image;
    const videoCfg = state.settings.providers.video;
    const guarded = sharedFreeLaneConfig("image", imageCfg, { model: imageCfg.model }, {}).enabled || sharedFreeLaneConfig("video", videoCfg, { model: videoCfg.model }, {}).enabled;
    return `<section class="director-console" data-entry="studio-entry">
        <div class="director-console-head"><div><span class="eyebrow">STORYBOARD CONTROL</span><h3>分镜导演</h3><p>脚本、选镜、生成与限流状态集中在一个工作区；镜头高级参数按需展开。</p></div><div class="director-primary-actions"><button class="btn ghost" data-action="open-studio">编辑分镜脚本</button><button class="btn primary" data-action="one-click">⚡ 一键生成${studioShots ? `（${studioShots} 镜）` : ""}</button></div></div>
        <div class="director-kpis">
          <div><b>${studioShots || episode.shots.length}</b><span>${studioShots ? `${studioSegments.length} 个片段的草稿` : "当前分镜"}</span></div>
          <div><b>${ready}/${episode.shots.length}</b><span>质检通过</span></div>
          <div><b>${queued}</b><span>排队 / 执行中</span></div>
          <div><b class="${failed ? "danger-text" : ""}">${failed}</b><span>需处理</span></div>
        </div>
        <div class="director-queue-note"><span class="queue-shield">${guarded ? "✓" : "↗"}</span><div><b>${guarded ? "共享免费通道保护已开启" : "当前模型使用普通提交通道"}</b><span>${guarded ? "同一平台只保留 1 个请求，图片间隔 15 秒、视频间隔 45 秒；429 会按 30 秒至 10 分钟退避，避免连续点击加重限流。" : `图片 ${esc(imageCfg.model)} · 视频 ${esc(videoCfg.model)}；仍会逐镜提交并阻止重复批次。`}</span></div><button class="btn tiny ghost" data-action="nav" data-view="generation">查看任务台账</button></div>
        <div class="director-tools"><div class="actions"><button class="btn ghost" data-action="add-shot">＋ 空白镜头</button><button class="btn ghost" data-action="build-shots">由节拍生成分镜</button><button class="btn ghost" data-action="queue-selected">所选镜头入队</button></div>${renderShotSelectBar()}</div>
      </section>
      <div class="story-grid">${episode.shots.length ? episode.shots.map((shot,index)=>{
        const [label,kind]=shotStatusBadge(shot.status);
        const [qualityLabel,qualityKind]=qcBadge(shot);
        const media=runtimeMedia.get(shot.id)||shot.mediaUrl||shot.firstFrameUrl;
        // 缩略图位置不能直接塞 mp4：<img src="xxx.mp4"> 会变成裂图，Chromium 还会把 alt 标题
        // 用 36px 字号画在画框里盖住整张卡。视频镜头优先用首帧静帧，没有静帧才退回静音视频。
        const mediaIsVideo=/\.(mp4|mov|m4v|webm)(?:[?#]|$)/i.test(String(media||""));
        const stillFrame=shot.qc?.firstFrameUrl || shot.firstFrameUrl || "";
        const frameSource=mediaIsVideo ? stillFrame : media;
        const frameHtml=frameSource
          ? `<img src="${esc(String(frameSource).startsWith("http")?`/api/media-proxy?url=${encodeURIComponent(frameSource)}`:frameSource)}" alt="${esc(shot.title)}">`
          : mediaIsVideo
            ? `<video class="shot-thumb" muted playsinline preload="metadata" src="${esc(playbackSrc(media))}"></video>`
            : `<span class="frame-empty">▱</span>`;
        const boundCharacters=characters.filter(item=>shot.characterIds.includes(item.id));
        const missingReferences=boundCharacters.filter(item=>!item.referenceImage);
        const missingTurnarounds=boundCharacters.filter(item=>item.faceRequired!==false&&!turnaroundReady(item));
        const chainSource=episode.shots.find(item=>item.id===shot.chainSourceShotId);
        // 自由选择帧链来源：所有已有尾帧的镜头都可选（不再限制“只能往前选/必须同角色”）；
        // 同角色优先排序，同场景次之，方便建立空间连续性。
        const chainCandidates=episode.shots.filter(item=>item.id!==shot.id&&canChainShotFrame(item,shot,{manual:true})).sort((a,b)=>{
          const sameA=sharedCharacterIds(a,shot).length, sameB=sharedCharacterIds(b,shot).length;
          return (sameB?1:0)-(sameA?1:0) || Math.abs(episode.shots.indexOf(a)-index)-Math.abs(episode.shots.indexOf(b)-index);
        });
        const warnings=shot.qc?.warnings || [];
        const plan=assessShotPlan(shot); shot.planQuality=plan;
        const activeVideoModel = shot.videoInputMode === "text" ? videoCfg.model : (videoCfg.imageToVideoModel || videoCfg.model);
        const supportsVideoMode = mode => ProviderCapabilities?.supports(videoCfg.vendor, activeVideoModel, mode) !== false;
        const currentModeSupported = supportsVideoMode(shot.videoInputMode || "text");
        return `<article class="card shot${shot.selected?" selected":""}${shotMotionClass(shot)}"><div class="shot-frame"><input class="shot-select" type="checkbox" data-shot-select="${shot.id}" aria-label="选择镜头 ${esc(shot.title)}" title="勾选该镜头" ${shot.selected?"checked":""}><span class="badge ${kind} shot-id">S${String(index+1).padStart(2,"0")} · ${label}</span>${frameHtml}${mediaIsVideo?`<span class="frame-play" aria-hidden="true">▶</span>`:""}</div><div class="shot-body"><div class="shot-title-row"><h4>${esc(shot.title)}</h4><div class="shot-badges"><span class="badge ${plan.grade==="pass"?"ok":plan.grade==="fail"?"err":"warn"}">方案 ${plan.score}</span><span class="badge ${qualityKind}">${qualityLabel}</span></div></div><p>${esc(shot.action)}</p>${shot.dialogue ? `<p class="dialogue"><b>${esc(shot.speaker || "角色")}：</b>${esc(shot.dialogue)}</p>` : `<p class="hint" style="margin-top:8px">无台词镜头</p>`}
          <div class="shot-summary"><span>${boundCharacters.length} 个角色</span><span>${shot.sceneId ? "场景已绑定" : "场景待绑定"}</span><span>${shot.videoInputMode === "text" ? "文生视频" : "参考图驱动"}</span></div>
          <details class="shot-advanced"><summary><span>生成设置与质检</span><small>${missingReferences.length || missingTurnarounds.length ? `有 ${missingReferences.length + missingTurnarounds.length} 项待补` : "绑定与参数"}</small></summary><div class="shot-advanced-body">
          <div class="binding-box"><b>角色绑定（${boundCharacters.length}）</b><div class="binding-list">${characters.length ? characters.map(character=>`<div class="binding-item ${character.referenceImage&&turnaroundReady(character)?"ready":"missing"}"><label><input type="checkbox" data-shot-character="${shot.id}" data-character-id="${character.id}" ${shot.characterIds.includes(character.id)?"checked":""}>${esc(character.name)}</label><small>${character.referenceImage?"定妆✓":"缺定妆"}${character.faceRequired===false?" · 非人脸锚点":turnaroundReady(character)?" · 九宫格✓":(character.turnaround?.imageUrl?" · 九宫格待切分":" · 缺九宫格")}</small>${shot.characterIds.includes(character.id)&&character.variations?.length?`<select class="select mini-select" data-shot-variation="${shot.id}" data-character-id="${character.id}"><option value="">基础造型</option>${character.variations.map(item=>`<option value="${item.id}" ${shot.characterVariations?.[character.id]===item.id?"selected":""}>${esc(item.name)}</option>`).join("")}</select>`:""}</div>`).join("") : `<span class="hint">请先建立角色资产</span>`}</div></div>
          <div class="form-group compact"><label>场景绑定</label><select class="select" data-shot-scene="${shot.id}"><option value="">未指定场景</option>${scenes.map(scene=>`<option value="${scene.id}" ${shot.sceneId===scene.id?"selected":""}>${esc(scene.name)}</option>`).join("")}</select></div>
          <div class="binding-box"><b>关键道具</b><div class="binding-list">${props.length?props.map(prop=>`<label class="binding-item ${prop.referenceImage?"ready":""}"><input type="checkbox" data-shot-prop="${shot.id}" data-prop-id="${prop.id}" ${shot.propIds?.includes(prop.id)?"checked":""}>${esc(prop.name)}<small>${prop.referenceImage?"参考图✓":"待参考图"}</small></label>`).join(""):`<span class="hint">本集没有关键道具</span>`}</div></div>
          <div class="keyframe-row"><div class="keyframe-card">${shot.firstFrameUrl?`<img src="${esc(shot.firstFrameUrl)}" alt="首帧">`:"<span>首帧</span>"}<div><button class="btn tiny ghost" data-action="upload-shot-frame" data-id="${shot.id}" data-frame="start">上传</button><button class="btn tiny violet" data-action="generate-shot-frame" data-id="${shot.id}" data-frame="start">生成</button>${shot.firstFrameUrl?`<button class="btn tiny ghost" data-action="inpaint-shot" data-id="${shot.id}" data-frame="start" title="只改画面里的一块，其余像素保持原样">局部重绘</button>`:""}${index?`<button class="btn tiny ghost" data-action="copy-previous-frame" data-id="${shot.id}">承接上镜</button>`:""}</div></div><div class="keyframe-card">${shot.lastFrameUrl?`<img src="${esc(shot.lastFrameUrl)}" alt="尾帧">`:"<span>尾帧</span>"}<div><button class="btn tiny ghost" data-action="upload-shot-frame" data-id="${shot.id}" data-frame="end">上传</button><button class="btn tiny violet" data-action="generate-shot-frame" data-id="${shot.id}" data-frame="end">生成</button>${shot.lastFrameUrl?`<button class="btn tiny ghost" data-action="inpaint-shot" data-id="${shot.id}" data-frame="end" title="只改画面里的一块，其余像素保持原样">局部重绘</button>`:""}</div></div></div>
          <div class="chain-row"><span class="badge ${shot.firstFrameUrl?"ok":"warn"}">${shot.firstFrameUrl?"首帧已锁定":"缺少首帧"}</span><span class="badge ${shot.lastFrameUrl?"ok":"warn"}">${shot.lastFrameUrl?"尾帧已锁定":"尾帧可选"}</span><span class="hint">${chainSource?`帧链来自：${esc(chainSource.title)}`:(shot.firstFrameUrl?"角色参考图/人工首帧":"先用角色定妆与九宫格生成首帧")}</span><label class="chain-picker">续帧来源<select class="select mini-select" data-shot-chain-source="${shot.id}"><option value="">不承接（使用角色定妆首帧）</option>${chainCandidates.map(item=>{const names=sharedCharacterIds(item,shot).map(id=>characters.find(character=>character.id===id)?.name).filter(Boolean).join("、");return `<option value="${item.id}" ${shot.chainSourceShotId===item.id?"selected":""}>${esc(item.title)} · ${names?`同角色 ${esc(names)}`:"同场景空间锚点"}</option>`;}).join("")}</select></label></div>
          <div class="grid-actions"><select class="select mini-select" data-grid-count="${shot.id}">${[4,6,9].map(n=>`<option value="${n}" ${gridPanelCount(shot)===n?"selected":""}>${n} 格</option>`).join("")}</select><button class="btn small ghost" data-action="prepare-shot-grid" data-id="${shot.id}">规划分镜网格</button><button class="btn small violet" data-action="generate-shot-grid" data-id="${shot.id}" ${shot.storyboardGrid?.panels?.length?"":"disabled"}>生成网格图</button></div>${renderShotGrid(shot)}
          <div class="video-mode-row"><div class="form-group compact"><label>视频输入模式</label><select class="select" data-video-mode="${shot.id}"><option value="text" ${shot.videoInputMode==="text"?"selected":""} ${supportsVideoMode("text")?"":"disabled"}>文生视频（仅限无人镜头）</option><option value="first" ${shot.videoInputMode==="first"?"selected":""} ${supportsVideoMode("first")?"":"disabled"}>首帧图生视频（${esc(state.settings.providers.video.imageToVideoModel || state.settings.providers.video.model)}）</option><option value="keyframes" ${shot.videoInputMode==="keyframes"?"selected":""} ${supportsVideoMode("keyframes")?"":"disabled"}>首尾帧插值（当前模型能力匹配）</option></select></div><div class="form-group compact"><label>运动强度</label><select class="select" data-motion-strength="${shot.id}">${[[.3,"克制"],[.55,"标准"],[.8,"强"]].map(([value,label])=>`<option value="${value}" ${Math.abs(Number(shot.motionStrength)-value)<.01?"selected":""}>${label}</option>`).join("")}</select></div></div>${!currentModeSupported?`<p class="warning-text">当前供应商/模型不支持这个输入模式，请切换上方可选模式后再提交。</p>`:""}${shot.videoInputMode==="text"&&boundCharacters.length?`<p class="warning-text">人物镜头已禁止纯文生视频：请完成定妆图、九宫格和首帧后切换为“首帧图生视频”。</p>`:""}
          ${missingReferences.length?`<p class="warning-text">缺少参考图：${missingReferences.map(item=>esc(item.name)).join("、")}</p>`:""}
          ${missingTurnarounds.length?`<p class="warning-text">缺少已质检九宫格：${missingTurnarounds.map(item=>esc(item.name)).join("、")}</p>`:""}
          ${shot.qc?`<div class="qc-summary"><b>启发式质检</b><span>人脸峰值 ${shot.qc.metrics?.facesDetectedMax ?? "-"} / 期望 ${shot.qc.metrics?.expectedPeople ?? "-"}</span><span>身份相似度 ${shot.qc.metrics?.identitySimilarity == null ? "未测" : Math.round(shot.qc.metrics.identitySimilarity*100)+"%"}</span><span>伪文字风险 ${Math.round((shot.qc.metrics?.textLikeScore||0)*100)}%</span><span>音轨 ${shot.qc.metrics?.hasAudio?"有":"无"}</span>${shot.dialogue?`<span>台词相似度 ${shot.qc.metrics?.dialogueSimilarity == null?"未测":Math.round(shot.qc.metrics.dialogueSimilarity*100)+"%"}</span>`:""}${warnings.map(item=>`<small>${esc(item)}</small>`).join("")}</div>`:""}
          <div class="qc-summary plan-qc"><b>分镜方案评分 ${plan.score}/100</b>${plan.checks.map(item=>`<span class="${item.passed?"":"warn-text"}">${esc(item.label)} ${item.score}</span>`).join("")}</div></div></details>
          <div class="shot-meta"><span>${esc(shot.camera)}</span><span>${shot.duration}s</span></div><div class="shot-actions"><button class="btn small ghost" data-action="edit-shot" data-id="${shot.id}">编辑</button><button class="btn small ghost" data-action="rollback-shot-prompt" data-id="${shot.id}" ${shot.promptVersions?.length?"":"disabled"}>提示词回滚</button>${shot.mediaUrl?`<button class="btn small violet" data-action="run-qc" data-id="${shot.id}">重新质检</button>`:""}${shot.mediaUrl&&shot.qc&&!shot.qc.passed?`<button class="btn small primary" data-action="approve-shot" data-id="${shot.id}">人工验收通过</button>`:""}<button class="btn small ghost" data-action="move-shot" data-id="${shot.id}" data-dir="-1">←</button><button class="btn small ghost" data-action="move-shot" data-id="${shot.id}" data-dir="1">→</button><button class="btn small danger" data-action="delete-shot" data-id="${shot.id}">删除</button></div></div></article>`;
      }).join("") : `<div class="empty" style="grid-column:1/-1"><b>还没有分镜</b>先完成剧情节拍，再点击“由节拍生成分镜”。</div>`}</div>`;
  };

  /* ------------------------------------------------------------------ *
   * AI 分镜工坊
   * 交互参照：即梦短剧工作室的「片段 → 分镜 N · 时长 · 景别+人物+动作」，
   * 以及小云雀短剧 Agent 的「分镜脚本表（景别/构图/机位/焦段/时长）+ 全选批量生成」。
   * 纯前端状态 + 本机代理，不引入任何外部工具或手工步骤。
   * ------------------------------------------------------------------ */
  const studioState = () => {
    const episode = getEpisode();
    if (!episode.storyboardStudio) episode.storyboardStudio = emptyStudio();
    const studio = episode.storyboardStudio;
    studio.params = { ...StudioCore.defaultParams(), ...(studio.params || {}) };
    if (!Array.isArray(studio.segments)) studio.segments = [];
    return studio;
  };
  const studioDrafts = () => studioState().segments.flatMap(segment => segment.shots || []);
  const studioDraftCount = () => studioDrafts().length;
  const studioSelectedDrafts = () => studioDrafts().filter(draft => draft.selected);
  const studioContext = () => {
    const episode = getEpisode(); const project = getProject();
    return {
      script: episode.script || "", style: episode.visualStyle || "", ratio: project.format || "9:16",
      projectName: project.name || "", genre: project.genre || "", language: episode.language || "中文",
      targetDuration: Number(episode.targetDuration) || 60, artDirection: project.artDirection || {},
      characters: (episode.assets.characters || []).map(item => ({ id: item.id, name: item.name, note: item.note, prompt: item.prompt })),
      scenes: (episode.assets.scenes || []).map(item => ({ id: item.id, name: item.name, note: item.note })),
      props: (episode.assets.props || []).map(item => ({ id: item.id, name: item.name, note: item.note })),
    };
  };
  const studioRenderStay = () => {
    const keep = [".studio-segments", ".studio-config"].map(selector => {
      const node = document.querySelector(selector);
      return [selector, node ? node.scrollTop : 0];
    });
    render();
    keep.forEach(([selector, top]) => {
      const node = document.querySelector(selector);
      if (node) node.scrollTop = top;
    });
  };
  const studioSetParam = (key, raw) => {
    const studio = studioState();
    const params = { ...studio.params };
    if (key === "shotDuration" || key === "batchSize") params[key] = Number(raw) || StudioCore.defaultParams()[key];
    else if (key === "includeLens") params.includeLens = Boolean(raw);
    else if (key === "shotCount") params.shotCount = raw === "auto" ? "auto" : (Number(raw) || "auto");
    else params[key] = raw;
    studio.params = StudioCore.normalizeParams(params);
    persist();
  };
  const studioUpdateDraft = (draftId, patch, recomputePrompt) => {
    const studio = studioState();
    for (const segment of studio.segments) {
      const draft = (segment.shots || []).find(item => item.id === draftId);
      if (!draft) continue;
      Object.assign(draft, patch);
      if (recomputePrompt) draft.prompt = StudioCore.composePrompt({ draft, params: studio.params, ctx: studioContext(), segment });
      studio.updatedAt = now();
      persist();
      return draft;
    }
    return null;
  };
  const studioRunOne = async (batch, ctx, params) => {
    const cfg = state.settings.providers.chat;
    const request = StudioCore.buildRequest({ batch, ctx, params });
    const data = await proxyRequest("chat", {
      model: cfg.model, thinking: { type: "disabled" }, temperature: .3,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: request.system }, { role: "user", content: request.user }],
    });
    const parsed = parseJsonText(data?.choices?.[0]?.message?.content);
    const drafts = StudioCore.normalizeDrafts(parsed, { ctx, params, segment: batch, segmentLabel: batch.segmentLabel });
    if (!drafts.length) throw new Error("模型未返回可用分镜，请重试或改用离线规则生成");
    return drafts;
  };
  const studioBatchFor = (segment, overrides = {}) => ({
    id: segment.id, label: segment.label, segmentLabel: segment.label,
    beatId: segment.beatId || "", scene: segment.scene || "", mood: segment.mood || "",
    text: segment.sourceText || (segment.shots || []).map(item => item.description).join("。") || getEpisode().script.slice(0, 600),
    shotCount: Math.max(1, (segment.shots || []).length || studioState().params.batchSize),
    chunkIndex: 0, chunkTotal: 1,
    ...overrides,
  });

  const studioGenerate = async () => {
    const episode = getEpisode(); const studio = studioState(); const params = studio.params;
    if (studioRun && studioRun.running) return showToast("正在生成中，请稍候。", true);
    if (!String(episode.script || "").trim() && !(episode.beats || []).length) return showToast("请先在剧本拆解页保存剧本或剧情节拍。", true);
    if (!secrets.chat) {
      if (window.confirm("还没有配置对话模型的 API Key，无法调用 AI 生成分镜。\n\n是否改用「离线规则生成」先产出可编辑的分镜草稿？")) return studioLocal();
      return;
    }
    const ctx = studioContext();
    params.style = params.style || episode.visualStyle || "";
    const batches = StudioCore.planBatches({ script: episode.script, beats: episode.beats, params, targetDuration: ctx.targetDuration });
    if (!batches.length) return showToast("没有可用于生成分镜的文本。", true);
    studio.segments = batches.map(batch => ({
      id: uid("segment"), label: batch.label, beatId: batch.beatId, scene: batch.scene, mood: batch.mood,
      sourceText: batch.text, status: "queued", error: "", shots: [],
    }));
    studioRun = { running: true, done: 0, total: batches.length, message: `准备生成 ${batches.length} 个片段…` };
    persist(); render();
    let failed = 0;
    for (let index = 0; index < batches.length; index += 1) {
      const segment = studio.segments[index];
      segment.status = "generating";
      studioRun.message = `${segment.label} · 生成 ${batches[index].shotCount} 个分镜…`;
      render();
      try {
        segment.shots = await studioRunOne(batches[index], ctx, params);
        segment.status = "done"; segment.error = "";
      } catch (error) {
        failed += 1; segment.status = "failed"; segment.error = error.message;
      }
      studioRun.done = index + 1; studio.updatedAt = now();
      persist(); render();
    }
    studioRun = { running: false, done: batches.length, total: batches.length, message: failed ? `完成：${batches.length - failed} 成功 / ${failed} 失败` : `完成：${batches.length} 个片段` };
    addLog(`AI 分镜脚本生成完成：${batches.length} 个片段，${failed} 个失败。`, { model: state.settings.providers.chat.model });
    persist(); render();
    showToast(failed ? `生成完成，${failed} 个片段失败，可单独重试。` : "分镜脚本已生成，勾选后可批量落地。", failed === batches.length && failed > 0);
  };

  const studioLocal = (options = {}) => {
    const episode = getEpisode(); const studio = studioState(); const params = studio.params;
    if (!String(episode.script || "").trim() && !(episode.beats || []).length) return showToast("请先在剧本拆解页保存剧本或剧情节拍。", true);
    const ctx = studioContext();
    const batches = StudioCore.planBatches({ script: episode.script, beats: episode.beats, params, targetDuration: ctx.targetDuration });
    if (!batches.length) return showToast("没有可用于生成分镜的文本。", true);
    studio.segments = batches.map(batch => ({
      id: uid("segment"), label: batch.label, beatId: batch.beatId, scene: batch.scene, mood: batch.mood,
      sourceText: batch.text, status: "done", error: "",
      shots: StudioCore.localDrafts({ batch, ctx, params }),
    }));
    studio.updatedAt = now();
    studioRun = { running: false, done: batches.length, total: batches.length, message: `离线生成：${batches.length} 个片段` };
    addLog(`使用离线规则生成 ${batches.length} 个片段的分镜草稿；未发送网络请求。`);
    persist(); render(); if (!options.quiet) showToast("已用离线规则生成分镜草稿，可逐条修改后批量落地。");
  };

  const studioRegenerateSegment = async segmentId => {
    const studio = studioState();
    const segment = studio.segments.find(item => item.id === segmentId);
    if (!segment) return;
    if (studioRun && studioRun.running) return showToast("正在生成中，请稍候。", true);
    const params = studio.params;
    const ctx = studioContext();
    const batch = studioBatchFor(segment);
    if (!secrets.chat) {
      segment.shots = StudioCore.localDrafts({ batch, ctx, params });
      segment.status = "done"; segment.error = "";
      persist(); render(); return showToast("未配置对话模型 Key，已改用离线规则重生成该片段。");
    }
    studioRun = { running: true, done: 0, total: 1, message: `${segment.label} 重新生成中…` };
    segment.status = "generating"; persist(); render();
    try {
      segment.shots = await studioRunOne(batch, ctx, params);
      segment.status = "done"; segment.error = "";
    } catch (error) {
      segment.status = "failed"; segment.error = error.message;
      showToast(error.message, true);
    }
    studioRun = { running: false, done: 1, total: 1, message: `${segment.label} 已重新生成` };
    persist(); render();
  };

  const studioRegenerateShot = async draftId => {
    const studio = studioState();
    let segment = null; let draft = null;
    for (const item of studio.segments) {
      const found = (item.shots || []).find(shot => shot.id === draftId);
      if (found) { segment = item; draft = found; break; }
    }
    if (!segment || !draft) return;
    if (studioRun && studioRun.running) return showToast("正在生成中，请稍候。", true);
    const params = studio.params;
    const ctx = studioContext();
    const batch = studioBatchFor(segment, { shotCount: 1, text: `${segment.sourceText || ""}\n只输出这一个分镜，重点表达：${draft.description}` });
    if (!secrets.chat) {
      const local = StudioCore.localDrafts({ batch, ctx, params })[0];
      if (local) {
        Object.assign(draft, { ...local, id: draft.id, index: draft.index, selected: draft.selected, shotId: draft.shotId || "" });
        persist(); render(); showToast("未配置对话模型 Key，已用离线规则替换该分镜。");
      }
      return;
    }
    studioRun = { running: true, done: 0, total: 1, message: "重新生成所选分镜…" }; render();
    try {
      const drafts = await studioRunOne(batch, ctx, params);
      const fresh = drafts[0];
      if (!fresh) throw new Error("模型未返回分镜");
      Object.assign(draft, { ...fresh, id: draft.id, index: draft.index, selected: draft.selected, shotId: draft.shotId || "" });
    } catch (error) { showToast(error.message, true); }
    studioRun = { running: false, done: 1, total: 1, message: "所选分镜已重新生成" };
    persist(); render();
  };

  const studioSelect = mode => {
    const studio = studioState();
    studio.segments.forEach(segment => (segment.shots || []).forEach(draft => {
      if (mode === "all") draft.selected = true;
      else if (mode === "none") draft.selected = false;
      else draft.selected = !draft.selected;
    }));
    persist(); studioRenderStay();
  };
  const studioDeleteShot = draftId => {
    const studio = studioState();
    studio.segments.forEach(segment => { segment.shots = (segment.shots || []).filter(item => item.id !== draftId); });
    persist(); studioRenderStay();
  };
  const studioDeleteSelected = () => {
    const studio = studioState();
    let removed = 0;
    studio.segments.forEach(segment => {
      const keep = [];
      (segment.shots || []).forEach(item => { if (item.selected) removed += 1; else keep.push(item); });
      segment.shots = keep;
    });
    persist(); studioRenderStay();
    if (removed) showToast(`已删除 ${removed} 条分镜草稿。`);
  };

  const studioApply = (mode = "append") => {
    const episode = getEpisode(); const studio = studioState();
    const picks = studio.segments.flatMap(segment => (segment.shots || []).filter(draft => draft.selected).map(draft => ({ draft, segment })));
    if (!picks.length) { showToast("请先勾选要加入分镜表的分镜。", true); return false; }
    if (mode === "replace" && episode.shots.length && !window.confirm(`将用 ${picks.length} 条 AI 分镜替换现有 ${episode.shots.length} 条分镜，确认继续？`)) return false;
    const shots = mode === "replace" ? [] : [...episode.shots];
    let created = 0; let updated = 0;
    picks.forEach(({ draft }) => {
      const existing = shots.find(shot => shot.studioDraftId === draft.id) || (draft.shotId ? shots.find(shot => shot.id === draft.shotId) : null);
      const boundIds = (draft.characterNames || [])
        .map(name => (episode.assets.characters || []).find(character => character.name === name)?.id)
        .filter(Boolean);
      const shot = autoBindShot(episode, {
        ...(existing || { id: uid("shot"), status: "draft", selected: true, mediaUrl: "", firstFrameUrl: "", lastFrameUrl: "", chainSourceShotId: "", qc: null }),
        studioDraftId: draft.id,
        title: draft.title || `分镜 ${draft.index}`,
        action: draft.description,
        camera: [draft.shotSize, draft.cameraAngle, draft.movement].filter(Boolean).join(" · "),
        duration: clamp(Number(draft.duration) || 5, 1, 60),
        speaker: draft.speaker || "",
        dialogue: draft.dialogue || "",
        prompt: draft.prompt || "",
        characterIds: [...new Set([...(boundIds || []), ...(existing?.characterIds || [])])],
        selected: true,
      });
      draft.shotId = shot.id;
      if (existing) { Object.assign(existing, shot); updated += 1; }
      else { shots.push(shot); created += 1; }
    });
    episode.shots = shots;
    addLog(`AI 分镜落地：新增 ${created} 条${updated ? `、更新 ${updated} 条` : ""}${mode === "replace" ? "（已替换原分镜表）" : ""}。`);
    persist(); render();
    showToast(`已加入分镜表：新增 ${created} 条${updated ? `，更新 ${updated} 条` : ""}。`);
    return true;
  };

  const studioGenerateSelectedFrames = async () => {
    const selected = studioSelectedDrafts();
    if (!selected.length) return showToast("请先勾选要生成首帧的分镜。", true);
    if (!studioApply("append")) return;
    const episode = getEpisode();
    const targets = selected.map(draft => episode.shots.find(shot => shot.studioDraftId === draft.id)).filter(Boolean);
    if (!targets.length) return showToast("分镜落地失败，请重试。", true);
    studioOpen = false; currentView = "storyboard"; persist(); render();
    addLog(`批量生成首帧：${targets.length} 个 AI 分镜进入首帧生成队列。`, { model: state.settings.providers.image.model });
    for (const shot of targets) await generateShotFrame(shot.id, "start");
    showToast(`已提交 ${targets.length} 个分镜的首帧生成，结果见分镜卡片。`);
  };

  const oneClickGenerate = async () => {
    const episode = getEpisode(); const studio = studioState();
    if (!studio.segments.length) {
      if (!String(episode.script || "").trim() && !(episode.beats || []).length) return showToast("先到「剧本拆解」保存剧本或剧情节拍，再来一键生成。", true);
      studio.seeded = true; studioLocal({ quiet: true });
    }
    const drafts = studio.segments.flatMap(segment => segment.shots || []);
    if (!drafts.length) return showToast("没有可用的分镜草稿。", true);
    const imageModel = state.settings.providers.image.model;
    const pending = drafts.filter(draft => {
      const shot = episode.shots.find(item => item.studioDraftId === draft.id || item.id === draft.shotId);
      return !shot?.firstFrameUrl;
    });
    if (!pending.length) {
      if (!window.confirm("所有分镜草稿都已有首帧。是否直接提交 Agent Plan 视频生成（异步、消耗套餐 AFP）？")) return;
      drafts.forEach(draft => { draft.selected = true; });
      studioApply("append");
      const readyIds = new Set(drafts.map(draft => draft.shotId).filter(Boolean));
      studioOpen = false; currentView = "generation";
      getEpisode().shots.forEach(shot => { shot.selected = readyIds.has(shot.id); });
      persist(); render();
      await submitVideos();
      return;
    }
    drafts.forEach(draft => { draft.selected = true; });
    if (!window.confirm(`一键生成 ${pending.length} 个分镜：\n① 草稿落地到分镜表\n② 先试跑第 1 镜\n③ 成功后其余 ${pending.length - 1} 镜进入单通道串行队列（${imageModel}）\n\n免费 Flash 通道会自动拉开请求间隔；遇到 429 将后台退避，不需要重复点击。\n首镜发生配置/余额等非限流错误会立即停止；已有首帧自动跳过。\n\n继续？`)) return;
    studioApply("append");
    const targetIds = new Set(drafts.map(draft => draft.shotId).filter(Boolean));
    const targets = getEpisode().shots.filter(shot => targetIds.has(shot.id) || drafts.some(draft => draft.id === shot.studioDraftId));
    if (!targets.length) return showToast("分镜落地失败，请重试。", true);
    studioOpen = false; studioRun = null; currentView = "generation";
    getEpisode().shots.forEach(shot => { shot.selected = targets.some(item => item.id === shot.id); });
    persist(); render();
    addLog(`一键生成：${targets.length} 个分镜进入首帧生成。`, { model: imageModel });
    await submitImages([targets[0]], { skipExisting: true });
    const first = getEpisode().shots.find(shot => shot.id === targets[0].id);
    if (!first?.firstFrameUrl) {
      const task = getEpisode().tasks.find(item => item.shotId === targets[0].id);
      addLog(`一键生成中止：首镜失败（${task?.message || "未知原因"}），其余 ${targets.length - 1} 个镜头未提交。`);
      return showToast(`首镜就失败了，已停止后续请求：${task?.message || "未知原因"}。修好后可再点一次一键生成。`, true);
    }
    await submitImages(targets.slice(1), { skipExisting: true });
    const done = getEpisode().shots.filter(shot => targets.some(item => item.id === shot.id) && shot.firstFrameUrl).length;
    if (done === targets.length) {
      if (window.confirm(`首帧 ${done}/${targets.length} 全部就绪。是否立刻提交 Agent Plan 视频生成？（异步任务，消耗套餐 AFP）`)) await submitVideos();
      else showToast(`一键生成完成：${done} 张首帧已就绪，可在分镜页逐镜提交视频。`);
    } else {
      showToast(`一键生成完成：${done}/${targets.length} 张首帧成功，失败原因见任务台账。`, done < targets.length);
    }
  };

  const studioQueueSelected = () => {
    const selected = studioSelectedDrafts();
    if (!selected.length) return showToast("请先勾选要入队的分镜。", true);
    if (!studioApply("append")) return;
    const episode = getEpisode();
    const ids = selected.map(draft => draft.shotId).filter(Boolean);
    episode.shots.forEach(shot => {
      const hit = ids.includes(shot.id);
      shot.selected = hit;
      if (hit && shot.status === "draft") shot.status = "queued";
    });
    studioOpen = false; currentView = "generation"; persist(); render();
    addLog(`${ids.length} 个 AI 分镜已加入生成队列；尚未提交外部请求。`);
    showToast("已加入生成队列，请在生成执行页确认后再提交。");
  };

  const studioDraftRow = (draft, params) => {
    const options = (values, current) => values
      .map(value => `<option value="${esc(value)}" ${String(value) === String(current) ? "selected" : ""}>${esc(value)}</option>`)
      .join("");
    return `<div class="shot-line ${draft.selected ? "selected" : ""}">
      <label class="sl-check"><input type="checkbox" data-studio-select="${draft.id}" ${draft.selected ? "checked" : ""} aria-label="选择该分镜"></label>
      <div class="sl-index"><b>S${String(draft.index).padStart(2, "0")}</b><select class="sl-duration" data-studio-duration="${draft.id}" aria-label="镜头时长">${StudioCore.DURATIONS.map(value => `<option value="${value}" ${Number(draft.duration) === value ? "selected" : ""}>${value}s</option>`).join("")}</select></div>
      <div class="sl-main">
        <div class="sl-tags">
          <select class="tag-select tag-size" data-studio-field="shotSize" data-id="${draft.id}" aria-label="景别">${options(StudioCore.SHOT_SIZES, draft.shotSize)}</select>
          <select class="tag-select" data-studio-field="composition" data-id="${draft.id}" aria-label="构图">${options(StudioCore.COMPOSITIONS, draft.composition)}</select>
          <select class="tag-select" data-studio-field="cameraAngle" data-id="${draft.id}" aria-label="机位">${options(StudioCore.CAMERA_ANGLES, draft.cameraAngle)}</select>
          ${params.includeLens ? `<select class="tag-select" data-studio-field="lens" data-id="${draft.id}" aria-label="焦段">${options(StudioCore.LENSES, draft.lens)}</select>` : ""}
          <select class="tag-select tag-move" data-studio-field="movement" data-id="${draft.id}" aria-label="运镜">${options(StudioCore.MOVEMENTS, draft.movement)}</select>
          ${(draft.characterNames || []).map(name => `<span class="tag char">@${esc(name)}</span>`).join("")}
        </div>
        <textarea class="sl-desc" rows="2" data-studio-desc="${draft.id}" placeholder="画面与动作描述（可直接喂给生图/生视频模型）">${esc(draft.description)}</textarea>
        <div class="sl-dialogue-row">
          <span class="tag ${draft.dialogue ? "ok" : ""}">${draft.dialogue ? "台词" : "无台词"}</span>
          <input class="sl-dialogue" data-studio-dialogue="${draft.id}" value="${esc(draft.dialogue)}" placeholder="台词原文保持不变，禁止改写成旁白">
          <input class="sl-speaker" data-studio-speaker="${draft.id}" value="${esc(draft.speaker)}" placeholder="说话角色">
        </div>
        <details class="sl-prompt"><summary>生成提示词</summary><pre>${esc(draft.prompt)}</pre></details>
      </div>
      <div class="sl-actions">
        <span class="badge ${draft.method === "local" ? "warn" : ""}">${draft.method === "local" ? "离线规则" : "AI"}</span>
        <button class="btn tiny ghost" data-action="studio-regen-shot" data-id="${draft.id}">重生成</button>
        <button class="btn tiny ghost" data-action="studio-copy-prompt" data-id="${draft.id}">复制</button>
        <button class="btn tiny danger" data-action="studio-delete-shot" data-id="${draft.id}">删除</button>
      </div>
    </div>`;
  };

  const studioSegmentBlock = (segment, params) => {
    const shots = segment.shots || [];
    const selectedCount = shots.filter(item => item.selected).length;
    const total = shots.reduce((sum, item) => sum + (Number(item.duration) || 0), 0);
    const statusMap = { idle: ["", "未生成"], queued: ["warn", "排队"], generating: ["warn", "生成中"], done: ["ok", "已完成"], failed: ["err", "失败"] };
    const [kind, label] = statusMap[segment.status] || statusMap.idle;
    return `<article class="segment">
      <div class="segment-head">
        <label class="seg-check"><input type="checkbox" data-studio-segment="${segment.id}" ${shots.length && selectedCount === shots.length ? "checked" : ""} ${shots.length ? "" : "disabled"} aria-label="选择该片段全部分镜"></label>
        <b>${esc(segment.label)}</b>
        <span class="badge">${shots.length} 镜 · ${Math.round(total)}s</span>
        ${segment.scene ? `<span class="hint">${esc(segment.scene)}</span>` : ""}
        <span class="badge ${kind}">${label}</span>
        <span class="seg-spacer"></span>
        <button class="btn tiny ghost" data-action="studio-regen-segment" data-id="${segment.id}">重新生成本片段</button>
      </div>
      ${segment.error ? `<p class="warning-text segment-error">${esc(segment.error)}</p>` : ""}
      <div class="segment-body">${shots.length
        ? shots.map(draft => studioDraftRow(draft, params)).join("")
        : `<p class="seg-empty">${segment.status === "generating" ? "AI 正在拆解本片段…" : "该片段还没有分镜，可重试本片段或改用离线规则。"}</p>`}</div>
    </article>`;
  };

  const studioConfig = (studio, ctx) => {
    const params = studio.params;
    const locked = new Set(params.lockedCharacterIds || []);
    const beats = getEpisode().beats || [];
    return `<div class="studio-panel-title"><b>生成设定</b><span class="hint">片段制 + 分镜表</span></div>
      <div class="form-group"><label>分镜来源</label><div class="studio-source">${beats.length ? `按剧情节拍切分 · ${beats.length} 段` : "按剧本整篇切分（每 2 句一个片段）"}</div></div>
      <div class="form-group"><label>镜头总数</label><select class="select" data-studio-param="shotCount">${[["auto", "自动（按目标时长推算）"], ["6", "6 镜"], ["9", "9 镜"], ["12", "12 镜"], ["16", "16 镜"], ["24", "24 镜"]].map(([value, label]) => `<option value="${value}" ${String(params.shotCount) === String(value) ? "selected" : ""}>${label}</option>`).join("")}</select></div>
      <div class="form-group"><label>单镜时长</label><select class="select" data-studio-param="shotDuration">${StudioCore.DURATIONS.map(value => `<option value="${value}" ${Number(params.shotDuration) === value ? "selected" : ""}>${value} 秒</option>`).join("")}</select></div>
      <div class="form-group"><label>景别配比</label><select class="select" data-studio-param="density">${Object.entries(StudioCore.DENSITY_LABEL).map(([value, label]) => `<option value="${value}" ${params.density === value ? "selected" : ""}>${label}</option>`).join("")}</select></div>
      <div class="form-group"><label>台词处理</label><select class="select" data-studio-param="dialogueMode"><option value="verbatim" ${params.dialogueMode === "verbatim" ? "selected" : ""}>逐字保留台词</option><option value="concise" ${params.dialogueMode === "concise" ? "selected" : ""}>允许精简台词</option></select></div>
      <div class="form-group"><label>每批镜数（单次请求）</label><select class="select" data-studio-param="batchSize">${[2, 4, 6, 8].map(value => `<option value="${value}" ${Number(params.batchSize) === value ? "selected" : ""}>${value} 镜 / 批</option>`).join("")}</select></div>
      <label class="toggle studio-toggle"><input type="checkbox" data-studio-param="includeLens" ${params.includeLens ? "checked" : ""}>输出焦段（24–135mm）</label>
      <div class="form-group"><label>视觉风格</label><input class="field" data-studio-param="style" value="${esc(params.style || getEpisode().visualStyle || "")}" placeholder="电影写实 / 2D 漫剧 / 3D 动画"></div>
      <div class="form-group"><label>画幅</label><select class="select" data-studio-param="ratio">${["9:16", "16:9", "1:1"].map(value => `<option value="${value}" ${params.ratio === value ? "selected" : ""}>${value}</option>`).join("")}</select></div>
      <div class="form-group"><label>角色 @ 锚点（每个分镜必须出场）</label><div class="studio-chips">${ctx.characters.length
        ? ctx.characters.map(character => `<label class="chip ${locked.has(character.id) ? "on" : ""}"><input type="checkbox" data-studio-character="${character.id}" ${locked.has(character.id) ? "checked" : ""}>${esc(character.name)}</label>`).join("")
        : `<span class="hint">尚未建立角色资产</span>`}</div></div>
      <details class="studio-help"><summary>生成逻辑说明</summary><p>① 剧本/节拍先切成「片段」，与即梦的片段制一致；② 每个片段按“景别 · 构图 · 机位 · 焦段 · 运镜 · 时长”输出分镜行，与小云雀的分镜脚本表一致；③ 勾选任意行即可批量落地为分镜、批量生成首帧或加入生成队列；④ 没有可用模型时用「离线规则生成」产出可编辑草稿。</p></details>`;
  };

  const renderStudio = () => {
    const studio = studioState();
    const params = studio.params;
    const ctx = studioContext();
    const stats = StudioCore.summarize(studio.segments);
    const running = Boolean(studioRun && studioRun.running);
    const progress = studioRun ? Math.round((studioRun.done / Math.max(1, studioRun.total)) * 100) : 0;
    const landed = getEpisode().shots.filter(shot => shot.studioDraftId).length;
    return `<div class="studio-backdrop">
      <section class="studio" role="dialog" aria-modal="true" aria-label="AI 生成分镜">
        <header class="studio-head">
          <div class="studio-title"><span class="studio-mark">✦</span><div><h3>AI 生成分镜</h3><p>剧本/节拍 → 分镜脚本（景别 · 构图 · 机位 · 焦段 · 时长）→ 勾选批量生成</p></div></div>
          <div class="studio-head-actions">
            <span class="badge ${secrets.chat ? "ok" : "warn"}">${esc(state.settings.providers.chat.model)}${secrets.chat ? "" : " · 无 Key"}</span>
            <button class="btn tiny ghost" data-action="close-studio">关闭</button>
          </div>
        </header>
        <div class="studio-body">
          <aside class="studio-config">${studioConfig(studio, ctx)}</aside>
          <div class="studio-script">
            <div class="studio-toolbar">
              <div class="studio-steps"><span class="step on">① 设定</span><span class="step ${studio.segments.length ? "on" : ""}">② 分镜脚本</span><span class="step ${landed ? "on" : ""}">③ 批量落地</span></div>
              <div class="actions">
                <span class="hint">已选 ${stats.selected}/${stats.shots} 镜 · 预计 ${stats.duration}s</span>
                <button class="btn tiny ghost" data-action="studio-select-all" ${stats.shots ? "" : "disabled"}>全选</button>
                <button class="btn tiny ghost" data-action="studio-select-none" ${stats.selected ? "" : "disabled"}>取消选择</button>
                <button class="btn tiny ghost" data-action="studio-select-invert" ${stats.shots ? "" : "disabled"}>反选</button>
                <button class="btn tiny danger" data-action="studio-delete-selected" ${stats.selected ? "" : "disabled"}>删除所选</button>
              </div>
            </div>
            <div class="studio-segments">${studio.segments.length
              ? studio.segments.map(segment => studioSegmentBlock(segment, params)).join("")
              : `<div class="empty"><b>还没有分镜草稿</b>先在左侧设定镜头数、时长与景别配比，再点右下角「生成分镜脚本」；没有可用模型时可先用「离线规则生成」。</div>`}</div>
          </div>
        </div>
        <footer class="studio-foot">
          <div class="studio-progress">${studioRun
            ? `<span class="badge ${running ? "warn" : "ok"}">${esc(studioRun.message)}</span><div class="progress studio-bar"><i style="width:${progress}%"></i></div>`
            : `<span class="hint">${studio.segments.length ? `${stats.segments} 个片段 · ${stats.shots} 镜 · 已选 ${stats.selected}` : "先设定参数，再生成分镜脚本"}</span>`}</div>
          <div class="studio-foot-actions">
            <button class="btn ghost" data-action="studio-local" ${running ? "disabled" : ""}>离线规则生成</button>
            <button class="btn violet" data-action="studio-generate" ${running ? "disabled" : ""}>${studio.segments.length ? "重新生成全部" : "生成分镜脚本"}</button>
            <button class="btn ghost" data-action="studio-frames" ${stats.selected && !running ? "" : "disabled"}>批量生成首帧（${stats.selected}）</button>
            <button class="btn ghost" data-action="studio-queue" ${stats.selected && !running ? "" : "disabled"}>加入生成队列</button>
            <button class="btn primary" data-action="studio-apply" ${stats.selected && !running ? "" : "disabled"}>批量加入分镜表（${stats.selected}）</button>
          </div>
        </footer>
      </section>
    </div>`;
  };

  const renderGeneration = () => {
    const episode = getEpisode();
    const selected = episode.shots.filter(item => item.selected);
    const resumable=episode.tasks.filter(task=>task.kind==="视频"&&(["submitted","generating","queued"].includes(task.status)||(task.status==="failed"&&task.taskId)));
    const failedShots = episode.shots.filter(shotIsFailed);
    // 提交前先给用户看这批要花多少钱：单价没填就不显示金额，而不是假装免费。
    // 质检已通过的镜头提交时会被跳过，不该算进费用里。
    const pendingSelected = selected.filter(shot => !shot.qc?.passed);
    const selectedBudget = estimateEpisodeCost(episode, pendingSelected);
    const selectedCostHint = selected.length && selectedBudget.amount !== null
      ? `<p class="hint" style="margin:0 0 12px">本次提交 ${pendingSelected.length} 个镜头 · ${selectedBudget.seconds.toFixed(1)} 秒 · 预计约 ¥${selectedBudget.amount.toFixed(2)}（${state.settings?.providers?.video?.pricePerSecond} 元/秒）。${selected.length > pendingSelected.length ? `另有 ${selected.length - pendingSelected.length} 个镜头质检已通过，提交时会自动跳过、不计费。` : ""}</p>`
      : selected.length ? `<p class="hint" style="margin:0 0 12px">未配置视频模型单价，无法预估本次提交的费用。到「设置 → 视频模型 → 每秒单价」填入即可看到估算金额。</p>` : "";
    return `<div class="section-head"><div><h3>生成执行</h3><p>这里提交真实外部请求；没有 Key 时不会伪造完成状态。</p></div><div class="actions"><button class="btn ghost" data-action="nav" data-view="settings">检查模型配置</button><button class="btn ghost" data-action="server-log">后台日志</button><button class="btn ghost" data-action="resume-tasks" ${resumable.length?"":"disabled"}>继续排队/续查 ${resumable.length} 个</button><button class="btn ghost" data-action="retry-failed-videos" ${failedShots.length?"":"disabled"}>重试失败镜头（${failedShots.length}）</button><button class="btn ghost" data-action="approve-selected-shots" ${selected.filter(s=>s.mediaUrl&&!s.qc?.passed).length?"":"disabled"}>批量人工验收误报（${selected.filter(s=>s.mediaUrl&&!s.qc?.passed).length}）</button><button class="btn ghost" data-action="unlock-video-model" ${episode.videoModelLock?"":"disabled"} title="${esc(episode.videoModelLock?.label||"")}">解除本集模型锁定</button><button class="btn violet" data-action="submit-image" ${selected.length?"":"disabled"}>生成所选首帧</button><button class="btn primary" data-action="submit-video" ${selected.length?"":"disabled"}>提交所选视频</button></div></div>
      ${selectedCostHint}
      ${renderShotSelectBar()}
      <div class="grid cols-4"><div class="card metric"><div class="metric-ico">✓</div><div><b>${selected.length}</b><span>当前选中</span></div></div><div class="card metric"><div class="metric-ico">↗</div><div><b>${episode.tasks.length}</b><span>累计任务</span></div></div><div class="card metric"><div class="metric-ico">…</div><div><b>${episode.tasks.filter(t=>t.status==="submitted").length}</b><span>已提交</span></div></div><div class="card metric"><div class="metric-ico">!</div><div><b>${episode.tasks.filter(t=>["failed","qc_failed"].includes(t.status)).length}</b><span>失败/质检未过</span></div></div></div>
      <div class="section-head"><div><h3>任务台账</h3><p>响应只保存必要的任务 ID、状态与媒体 URL。</p></div></div>
      <div class="task-list">${episode.tasks.length ? episode.tasks.map(task=>{
        const shot = episode.shots.find(item => item.id === task.shotId);
        const retryable = shot && ["failed","qc_failed","queued"].includes(task.status) && episode.tasks.find(item => item.shotId === task.shotId) === task;
        const isQueued = task.status === "queued";
        // 只要这个镜头已经有成片、但质检没通过，就优先给「重新质检」：片子是真的，重生成只会再撞一次限流。
        const canRequalify = Boolean(shot?.mediaUrl) && shot?.qc?.passed !== true;
        const countdown = isQueued && task.queueNextAt ? `<span class="queue-wait" data-queue-countdown="${task.queueNextAt}"></span>` : "";
        return `<article class="card"><div class="project-top"><div><span class="badge ${task.status==="completed"?"ok":["failed","qc_failed"].includes(task.status)?"err":isQueued?"warn":""}">${esc(task.kind)} · ${esc(task.status)}</span><h4 style="margin-top:10px">${esc(task.shotTitle)}</h4></div><span class="hint">${task.at ? new Date(task.at).toLocaleString() : "时间未记录"}</span></div><p>${esc(task.message || task.taskId || "请求已记录")}${countdown}</p><div class="log-detail">${task.model?`<span>模型 ${esc(task.model)}</span>`:""}${task.taskId?`<span>任务 ${esc(task.taskId)}</span>`:""}${task.durationMs?`<span>耗时 ${Math.round(task.durationMs/100)/10}s</span>`:""}</div>${retryable?`<div class="task-actions">${canRequalify?`<button class="btn tiny primary" data-action="requalify-task" data-id="${task.id}">重新质检（不重生成）</button>`:""}<button class="btn tiny violet" data-action="retry-task" data-id="${task.id}">${isQueued?"立即重试这一镜":canRequalify?"重新生成这一镜":"重试这一镜"}</button>${isQueued?`<button class="btn tiny ghost" data-action="cancel-queue" data-id="${task.id}">取消排队</button>`:""}<span class="hint">${isQueued?"排队中，会自动重试；不想等可取消":"只重提该镜头，不影响其它任务"}</span></div>`:""}${task.prompt?`<details><summary>完整提示词</summary><pre>${esc(task.prompt)}</pre></details>`:""}</article>`;
      }).join("") : `<div class="empty"><b>尚未提交任务</b>在分镜页勾选镜头，再从这里提交真实 API 请求。</div>`}</div>
      <div class="section-head"><div><h3>运行日志</h3></div></div>${renderLogs(episode)}`;
  };

  // 下拉必须显示中文标签：直接把英文枚举值当文案，用户看到的是 bottom / white。
  // selected 既可以是「要选中的值」，也可以直接是布尔值。
  // 音效这类需要多选的场景传布尔值，旧的调用方式传值，两种都认。
  const packagingOption = (value, label, selected) => {
    const isSelected = typeof selected === "boolean" ? selected : value === selected;
    return `<option value="${esc(value)}" ${isSelected ? "selected" : ""}>${esc(label)}</option>`;
  };
  const renderPackaging = () => {
    const episode = getEpisode();
    const pack = normalizePackaging(episode.packaging);
    const dialogueShots = episode.shots.filter(shot => String(shot.dialogue || "").trim());
    const ttsCount = Object.keys(pack.tts.lines || {}).length;
    const overrun = Object.entries(pack.tts.meta || {}).filter(([, meta]) => Number(meta?.overrun) > 0.25);
    const cueCount = pack.subtitles.cues.length;
    const voiceOptions = PACKAGING_VOICES.map(([id, label]) => `<option value="${id}" ${pack.voice === id ? "selected" : ""}>${esc(label)}</option>`).join("");
    const styleOptions = PACKAGING_VOICE_STYLES.map(([id, label]) => `<option value="${id}" ${(pack.tts.style || "drama") === id ? "selected" : ""}>${esc(label)}</option>`).join("");
    // 多角色配音：把本集有台词的角色列出来，逐个指定音色。
    const speakerList = [];
    episode.shots.forEach(shot => {
      const name = String(shot.speaker || "").trim();
      if (name && String(shot.dialogue || "").trim() && !speakerList.includes(name)) speakerList.push(name);
    });
    const voiceRows = speakerList.map(name => {
      const current = pack.voiceMap[name] || "";
      const options = [`<option value="" ${current ? "" : "selected"}>跟随默认音色（${esc((PACKAGING_VOICES.find(([id]) => id === pack.voice) || [])[1] || pack.voice)}）</option>`]
        .concat(PACKAGING_VOICES.map(([id, label]) => `<option value="${id}" ${current === id ? "selected" : ""}>${esc(label)}</option>`))
        .join("");
      const count = episode.shots.filter(shot => String(shot.speaker || "").trim() === name && String(shot.dialogue || "").trim()).length;
      return `<label class="pkg-field wide"><span>${esc(name)} · ${count} 句</span><select class="field" data-voice-speaker="${esc(name)}">${options}</select></label>`;
    }).join("");
    const gradeOptions = PACKAGING_GRADES.map(([id, label]) => `<option value="${id}" ${pack.video.grade === id ? "selected" : ""}>${esc(label)}</option>`).join("");
    const transitionOptions = PACKAGING_TRANSITIONS.map(([id, label]) => `<option value="${id}" ${pack.video.transition === id ? "selected" : ""}>${esc(label)}</option>`).join("");
    const style = pack.subtitles.style;
    const voiceCount = new Set(Object.values(pack.tts.voices || {}).filter(Boolean)).size;
    const cues = pack.subtitles.cues.slice(0, 3).map(cue => `${cue.start.toFixed(1)}–${cue.end.toFixed(1)}s ${esc(cue.text)}`).join(" ／ ");
    // 音效：按镜头列出已指定与待指定的行。
    const sfxAssignments = episode.shots
      .map(shot => ({ id: shot.id, title: shot.title, ids: (pack.sfx.map || {})[shot.id] || [] }))
      .filter(row => row.ids.length);
    const shotSfxRows = episode.shots
      .map(shot => ({ id: shot.id, title: shot.title }))
      .slice(0, 12);
    return `<div class="section-head"><div><h3>后期包装</h3><p>配音、字幕、BGM、转场与调色都在本机合成，不调用模型、不计费；成片可直接发。</p></div><div class="actions"><button class="btn ghost" data-action="post-subtitles" ${dialogueShots.length ? "" : "disabled"}>生成字幕</button><button class="btn ghost" data-action="post-tts" ${dialogueShots.length ? "" : "disabled"}>生成配音</button><button class="btn ghost" data-action="post-cover" ${episode.shots.length ? "" : "disabled"}>生成封面</button><button class="btn ghost" data-action="post-draft">导出剪映草稿</button></div></div>
      <div class="grid cols-2 packaging-grid">
        <article class="card">
          <div class="panel-title"><h3>配音 TTS</h3><span class="badge ${ttsCount ? "ok" : "warn"}">${ttsCount ? `${ttsCount}/${dialogueShots.length} 句已配${voiceCount > 1 ? ` · ${voiceCount} 音色` : ""}` : "未配音"}</span></div>
          <p class="hint">按分镜台词逐句合成，走本机 Edge 神经语音：不用 Key、不计额度。成片里会与镜头原声叠加，原声音量可单独压。</p>
          <div class="pkg-row">
            <label class="pkg-field wide"><span>音色</span><select class="field" id="pkg-voice">${voiceOptions}</select></label>
            <label class="pkg-field"><span>语速 %</span><input class="field" id="pkg-rate" type="number" min="-40" max="60" step="2" value="${esc(pack.rate)}"></label>
          </div>
          <div class="pkg-row">
            <label class="pkg-field wide"><span>情绪</span><select class="field" id="pkg-tts-style">${styleOptions}</select></label>
          </div>
          <div class="pkg-row">
            <label class="pkg-field"><span>配音音量</span><input class="field" id="pkg-tts-volume" type="number" min="0" max="1.5" step="0.05" value="${esc(pack.tts.volume)}"></label>
            <label class="pkg-field"><span>原声音量</span><input class="field" id="pkg-source-volume" type="number" min="0" max="2" step="0.05" value="${esc(pack.video.sourceVolume)}"></label>
          </div>
          ${speakerList.length ? `<div class="pkg-block"><div class="pkg-block-head"><span>角色音色</span><span class="pkg-block-actions"><button class="btn tiny ghost" data-action="post-tts-auto-voice">按性别自动分配</button></span></div><p class="hint">同一角色固定一个声音；不同角色用不同音色，避免「所有人一个声音」。点「按性别自动分配」会依据角色资产里的性别描述挑选音色，不指定则跟随上面的默认音色。</p><div class="pkg-row">${voiceRows}</div></div>` : ""}
          ${overrun.length ? `<p class="pkg-warn">${overrun.length} 句配音比镜头长（最长超 ${Math.max(...overrun.map(([, meta]) => Number(meta.overrun))).toFixed(2)}s）：提高语速或加长镜头，否则台词会被下一镜截断。</p>` : ""}
          <div class="pkg-actions">
            <label class="pkg-check"><input type="checkbox" id="pkg-tts-enabled" ${pack.tts.enabled ? "checked" : ""}> 合成时混入配音</label>
            <button class="btn tiny ghost" data-action="post-tts" ${dialogueShots.length ? "" : "disabled"}>${ttsCount ? "重新生成" : "生成配音"}</button>
            <button class="btn tiny ghost" data-action="post-tts-clear" ${ttsCount ? "" : "disabled"}>清空</button>
          </div>
        </article>
        <article class="card">
          <div class="panel-title"><h3>字幕</h3><span class="badge ${cueCount ? "ok" : "warn"}">${cueCount ? `${cueCount} 条` : "未生成"}</span></div>
          <p class="hint">按台词与镜头时长自动切句，与转场后的成片轴对齐；合片时直接烧进画面，另可下载 SRT 交给外部工具。台词里用「」包住的词会自动变色强调。</p>
          <div class="pkg-row">
            <label class="pkg-field wide"><span>花字模板</span><select class="field" id="pkg-sub-template">${PACKAGING_SUBTITLE_TEMPLATES.map(([id, label]) => packagingOption(id, label, style.template || "plain")).join("")}</select></label>
          </div>
          <p class="hint" id="pkg-sub-template-hint" style="margin-top:6px">${esc(SUBTITLE_TEMPLATE_HINTS[style.template || "plain"] || "")}</p>
          <div class="pkg-row">
            <label class="pkg-field"><span>单行字数</span><input class="field" id="pkg-sub-max" type="number" min="6" max="30" value="${esc(pack.subtitles.maxChars)}"></label>
            <label class="pkg-field"><span>字号 px</span><input class="field" id="pkg-sub-size" type="number" min="18" max="90" value="${esc(style.size)}"></label>
            <label class="pkg-field"><span>位置</span><select class="field" id="pkg-sub-position">${packagingOption("bottom", "底部", style.position)}${packagingOption("center", "居中", style.position)}${packagingOption("top", "顶部", style.position)}</select></label>
            <label class="pkg-field"><span>颜色</span><select class="field" id="pkg-sub-color">${packagingOption("white", "白色", style.color)}${packagingOption("yellow", "黄色", style.color)}</select></label>
          </div>
          ${cues ? `<p class="pkg-preview">${cues}${cueCount > 3 ? " …" : ""}</p>` : ""}
          <div class="pkg-row">
            <label class="pkg-field"><span>描边 px（0=自动）</span><input class="field" id="pkg-sub-outline" type="number" min="0" max="12" step="0.5" value="${esc(style.outline)}" placeholder="自动"></label>
            <label class="pkg-field"><span>底距 px（0=安全区）</span><input class="field" id="pkg-sub-margin" type="number" min="0" max="800" step="10" value="${esc(style.marginV)}"></label>
            <label class="pkg-field wide"><span>字体</span><input class="field" id="pkg-sub-font" value="${esc(style.font || "Microsoft YaHei")}" list="pkg-font-list"><datalist id="pkg-font-list"><option value="Microsoft YaHei"><option value="SimHei"><option value="Source Han Sans CN"><option value="KaiTi"><option value="FangSong"></datalist></label>
          </div>
          <div class="pkg-actions">
            <label class="pkg-check"><input type="checkbox" id="pkg-sub-enabled" ${pack.subtitles.enabled ? "checked" : ""}> 合成时烧录字幕</label>
            <label class="pkg-check"><input type="checkbox" id="pkg-sub-boxed" ${style.boxed ? "checked" : ""}> 半透明底条</label>
            <button class="btn tiny ghost" data-action="post-subtitles" ${dialogueShots.length ? "" : "disabled"}>生成/刷新</button>
            <button class="btn tiny ghost" data-action="download-srt" ${cueCount ? "" : "disabled"}>下载 SRT</button>
          </div>
          <p class="hint" style="margin-top:8px">底距留 0 时会自动避开竖屏平台底部约 12% 的交互按钮区；手动填值则以你填的为准。</p>
        </article>
        <article class="card">
          <div class="panel-title"><h3>背景音乐 BGM</h3><span class="badge ${pack.bgm.enabled ? "ok" : "warn"}">${pack.bgm.enabled ? "已接入" : "未接入"}</span></div>
          <p class="hint">内置曲库为仓库里的 <code>bgm.mp3</code>（4 秒素材，合片时循环铺满并自动淡入淡出）。成片没有氛围声的问题到这里结束。</p>
          <div class="pkg-row">
            <label class="pkg-field"><span>音量</span><input class="field" id="pkg-bgm-volume" type="number" min="0" max="1" step="0.02" value="${esc(pack.bgm.volume)}"></label>
            <label class="pkg-field"><span>淡入 s</span><input class="field" id="pkg-bgm-fadein" type="number" min="0" max="8" step="0.5" value="${esc(pack.bgm.fadeIn)}"></label>
            <label class="pkg-field"><span>淡出 s</span><input class="field" id="pkg-bgm-fadeout" type="number" min="0" max="8" step="0.5" value="${esc(pack.bgm.fadeOut)}"></label>
          </div>
          <div class="pkg-actions"><label class="pkg-check"><input type="checkbox" id="pkg-bgm-enabled" ${pack.bgm.enabled ? "checked" : ""}> 合成时混入 BGM</label></div>
        </article>
        <article class="card">
          <div class="panel-title"><h3>音效库</h3><span class="badge ${pack.sfx.enabled ? "ok" : "warn"}">${pack.sfx.enabled ? "已接入" : "未接入"}</span></div>
          <p class="hint">本机程序化合成 ${SFX_LIBRARY.length} 种拟音（脚步、开门、撞击、枪声、风声、心跳等），全部离线生成、不消耗模型额度。可逐镜指定，也可按画面内容自动匹配。</p>
          <div class="pkg-row">
            <label class="pkg-field"><span>音量</span><input class="field" id="pkg-sfx-volume" type="number" min="0" max="1.5" step="0.05" value="${esc(pack.sfx.volume)}"></label>
          </div>
          <div class="pkg-actions">
            <label class="pkg-check"><input type="checkbox" id="pkg-sfx-enabled" ${pack.sfx.enabled ? "checked" : ""}> 合成时混入音效</label>
            <button class="btn tiny ghost" data-action="post-sfx-auto">按画面自动匹配</button>
            <button class="btn tiny ghost" data-action="post-sfx-clear">清空</button>
          </div>
          <div class="sfx-library">${SFX_LIBRARY.map(item => `<button type="button" class="sfx-chip" data-action="post-sfx-preview" data-sfx="${esc(item.id)}" title="试听 ${esc(item.label)}">${esc(item.label)}</button>`).join("")}</div>
          ${sfxAssignments.length ? `<div class="pkg-block"><div class="pkg-block-head"><span>镜头音效</span></div><div class="sfx-assign-list">${sfxAssignments.map(row => `<div class="sfx-assign-row"><span class="hint">${esc(row.title)}</span><span class="sfx-assign-tags">${row.ids.map(id => { const meta = SFX_LIBRARY.find(item => item.id === id); return `<em>${esc(meta ? meta.label : id)}</em>`; }).join("")}</span><button type="button" class="btn tiny ghost" data-action="post-sfx-remove" data-shot="${esc(row.id)}">移除</button></div>`).join("")}</div></div>` : `<p class="hint" style="margin-top:8px">还没有给镜头指定音效：点「按画面自动匹配」自动挑，或在下方镜头列表里手动加。</p>`}
          ${shotSfxRows.length ? `<div class="pkg-block"><div class="pkg-block-head"><span>手动指定</span><span class="hint">按住 Ctrl / Shift 可多选</span></div>${shotSfxRows.map(row => { const picked = pack.sfx.map[row.id] || []; return `<div class="sfx-assign-row"><span class="hint">${esc(row.title)}</span><select class="field mini-select" multiple size="4" data-sfx-shot="${esc(row.id)}">${SFX_LIBRARY.map(item => packagingOption(item.id, item.label, picked.includes(item.id))).join("")}</select><button type="button" class="btn tiny ghost" data-action="post-sfx-remove" data-shot="${esc(row.id)}">清空</button></div>`; }).join("")}</div>` : ""}
        </article>
        <article class="card">
          <div class="panel-title"><h3>画面：转场 / 调色 / 变速</h3><span class="badge">${esc((PACKAGING_TRANSITIONS.find(([id]) => id === pack.video.transition) || ["", "硬切"])[1])}</span></div>
          <p class="hint">合片时统一归一化到同一画幅，混分辨率不会再被静默截断；转场是真正的交叉溶解，不再是硬切拼接。</p>
          <div class="pkg-row">
            <label class="pkg-field"><span>转场</span><select class="field" id="pkg-transition">${transitionOptions}</select></label>
            <label class="pkg-field"><span>转场时长 s</span><input class="field" id="pkg-transition-duration" type="number" min="0.1" max="2" step="0.1" value="${esc(pack.video.transitionDuration)}"></label>
          </div>
          <div class="pkg-row">
            <label class="pkg-field wide"><span>调色</span><select class="field" id="pkg-grade">${gradeOptions}</select></label>
            <label class="pkg-field"><span>倍速</span><input class="field" id="pkg-speed" type="number" min="0.5" max="2" step="0.1" value="${esc(pack.video.speed)}"></label>
          </div>
          <div class="pkg-row">
            <label class="pkg-field"><span>输出分辨率</span><select class="field" id="pkg-resolution"><option value="1080" ${pack.video.resolution !== "720" ? "selected" : ""}>1080p（发布用）</option><option value="720" ${pack.video.resolution === "720" ? "selected" : ""}>720p（快速预览）</option></select></label>
            <label class="pkg-field"><span>镜头原声</span><select class="field" id="pkg-source-mode"><option value="auto" ${(pack.video.sourceMode || "auto") === "auto" ? "selected" : ""}>自动（有配音就丢弃）</option><option value="keep" ${pack.video.sourceMode === "keep" ? "selected" : ""}>保留原声</option><option value="mute" ${pack.video.sourceMode === "mute" ? "selected" : ""}>丢弃原声</option></select></label>
          </div>
          <div class="pkg-row">
            <label class="pkg-field wide"><span>画幅适配</span><select class="field" id="pkg-fit"><option value="blur" ${(pack.video.fit || "blur") === "blur" ? "selected" : ""}>模糊背景填充（推荐）</option><option value="crop" ${pack.video.fit === "crop" ? "selected" : ""}>居中裁切铺满</option><option value="letterbox" ${pack.video.fit === "letterbox" ? "selected" : ""}>黑边（保留完整画面）</option></select></label>
          </div>
          <p class="hint">素材比例和成片比例不一致时（横屏片转竖屏），按上面的方式补背景；默认用模糊填充，不会出现大片黑边。</p>
          ${ttsCount && (pack.video.sourceMode === "keep") ? `<p class="pkg-warn">模型视频自带人声（提示词里写了台词），这里又保留原声，成片会出现同一句台词说两遍。建议改成「自动」或「丢弃原声」。</p>` : ""}
        </article>
        <article class="card">
          <div class="panel-title"><h3>封面</h3><span class="badge ${pack.cover.url ? "ok" : "warn"}">${pack.cover.url ? "已生成" : "未生成"}</span></div>
          <p class="hint">取第一镜首帧压暗排版，输出 1080×1920 PNG，可直接当发布物料。</p>
          <div class="pkg-row">
            <label class="pkg-field"><span>主标题</span><input class="field" id="pkg-cover-title" value="${esc(pack.cover.title || "")}" placeholder="${esc(`${getProject().name} · ${episode.title}`)}"></label>
            <label class="pkg-field"><span>副标题</span><input class="field" id="pkg-cover-subtitle" value="${esc(pack.cover.subtitle || "")}" placeholder="例如：沈寂 · 赵泽宇"></label>
          </div>
          <div class="pkg-actions"><button class="btn tiny ghost" data-action="post-cover" ${episode.shots.length ? "" : "disabled"}>生成封面</button>${pack.cover.url ? `<a class="btn tiny ghost" href="${esc(pack.cover.url)}" download>下载封面</a>` : ""}</div>
          ${pack.cover.url ? `<img class="pkg-cover" src="${esc(pack.cover.url)}" alt="本期封面预览">` : ""}
        </article>
      </div>`;
  };

  // 费用预估：单价由用户在设置里填（各家定价随版本变动，硬编码价格表很快过期）。
  // 未配置单价就返回空字符串，绝不显示「¥0」——那会让人以为生成是免费的。
  // shots 传空时，默认估算「本集还没出片的镜头」；生成页会显式传入本次要提交的镜头。
  const estimateEpisodeCost = (episode, shots) => {
    const provider = state.settings?.providers?.video || {};
    const price = Number(provider.pricePerSecond);
    const configured = provider.pricePerSecond !== null && provider.pricePerSecond !== undefined
      && Number.isFinite(price) && price >= 0;
    const pool = Array.isArray(shots) ? shots : ((episode?.shots || []).filter(shot => !shot.mediaUrl));
    const seconds = pool.reduce((sum, shot) => sum + Math.max(0, Number(shot.duration) || 0), 0);
    if (!configured) {
      return { amount: null, seconds, shots: pool.length, text: "" };
    }
    if (!pool.length) {
      return { amount: 0, seconds: 0, shots: 0, text: "没有需要生成的镜头，不产生模型调用费用。" };
    }
    const amount = seconds * price;
    return {
      amount, seconds, shots: pool.length,
      text: `预计消耗：${pool.length} 个镜头 · ${seconds.toFixed(1)} 秒 · 约 ¥${amount.toFixed(2)}（按 ${price} 元/秒估算，可在设置里改单价）。`,
    };
  };
  const renderDelivery = () => {
    const episode = getEpisode();
    const delivery = episode.delivery || {};
    const videoTasks = episode.tasks.filter(task => task.kind === "视频");
    const completedShots = episode.shots.filter(shot => shot.mediaUrl);
    const totalDuration = completedShots.reduce((sum,shot)=>sum+Number(shot.duration||0),0);
    // 成片只由“已勾选入片”的镜头组成。未选中的探索镜头不应阻塞交付，
    // 也不该被合成进正片（旧版这里直接 every 全部 23 镜，导致 12 镜的 60 秒片永远合成不了）。
    const selectedShots = episode.shots.filter(shot => shot.selected);
    const allShotsReady=selectedShots.length>0&&selectedShots.every(shot=>shot.mediaUrl&&shot.qc?.passed);
    const allVideoQcPassed = selectedShots.length > 0 && selectedShots.every(shot => shot.mediaUrl && shot.qc?.passed);
    const budget = estimateEpisodeCost(episode);
    const budgetHint = budget.text
      ? `<p class="hint" style="margin:0 0 12px">${esc(budget.text)}</p>`
      : `<p class="hint" style="margin:0 0 12px">未配置视频模型单价，无法预估本集费用。到「设置 → 视频模型 → 每秒单价」填入后这里会显示估算金额。</p>`;
    // 成片版本：所有已合成成片直接平铺成网格，不用点开历史记录就能看到全部结果。
    const deliveryVersions = (() => {
      const list = (Array.isArray(episode.deliveryHistory) ? episode.deliveryHistory : []).filter(item => item && item.mediaUrl);
      // 兼容旧数据：delivery 可能没进 history（历史上被直接覆盖过），补一条，避免“当前版本”缺席。
      if (delivery.mediaUrl && !list.some(item => item.mediaUrl === delivery.mediaUrl)) {
        list.unshift({ mediaUrl: delivery.mediaUrl, title: delivery.title || "本集成片", model: delivery.model, note: delivery.note, renderedAt: delivery.renderedAt, shotIds: delivery.shotIds });
      }
      return list;
    })();
    const versionCard = (item) => {
      const active = item.mediaUrl === delivery.mediaUrl;
      // 历史成片里可能还挂着已被删除/重建的旧镜头 ID；这种成片不能继续冒充“当前版本”。
      const stale = Boolean(item.shotIds?.length && item.shotIds.some(id => !episode.shots.find(shot => shot.id === id)));
      const when = item.renderedAt ? new Date(item.renderedAt).toLocaleString() : "时间未记录";
      return `<article class="version-card${active ? " active" : ""}"><div class="version-frame"><video controls preload="metadata" playsinline src="${esc(playbackSrc(item.mediaUrl))}"></video><span class="version-flag">${active ? "当前交付" : stale ? "过期 · 镜头已删除" : "历史版本"}</span></div><div class="version-meta"><b>${esc(when)}</b><span class="hint">${esc(item.note || item.model || "")}</span><div class="version-actions">${active ? "" : `<button class="btn tiny" data-action="use-delivery-version" data-url="${esc(item.mediaUrl)}">设为当前</button>`}<button class="btn tiny ghost" data-action="download-media" data-url="${esc(item.mediaUrl)}" title="下载原始 mp4（不转码）">下载</button><button class="btn tiny ghost" data-action="open-media" data-url="${esc(item.mediaUrl)}" title="交给系统默认播放器打开原始文件">播放器</button></div></div></article>`;
    };
    const deliveryGallery = deliveryVersions.length
      ? `<article class="card delivery-gallery" style="margin-bottom:14px"><div class="project-top"><div><h4>成片版本（${deliveryVersions.length}）</h4><span class="hint">所有合成结果直接排在下面，点播放即可对比；重新合片只新增版本，旧成片不会被覆盖（最多记录 20 条，文件都留在磁盘）。</span></div></div><div class="version-grid">${deliveryVersions.map(versionCard).join("")}</div></article>`
      : "";
    return `<div class="section-head"><div><h3>交付中心</h3><p>将项目结构、分镜表和提示词包交给后续生成、剪辑或归档环节。</p></div><button class="btn primary" data-action="render-master" ${allShotsReady?"":"disabled"}>按当前包装合成成片</button></div>
      ${PREVIEW_NEEDED ? `<div class="hint" style="margin:0 0 12px">当前内嵌浏览器不含 H.264 解码器，预览已自动转成 WebM 播放（首次播放需等几秒转码）；交付文件与本地合成仍是原始 mp4。</div>` : ""}
      ${budgetHint}
      ${delivery.mediaUrl ? `<p class="hint" style="margin:0 0 12px">${allVideoQcPassed ? "当前成片对应镜头已全部质检通过。" : "当前成片对应镜头尚未全部质检通过，重新合片前建议先补齐质检。"}</p>` : ""}
      ${deliveryGallery}
      ${renderPackaging()}
      <div class="section-head"><div><h3>镜头时间轴</h3><p>${completedShots.length} 个已生成片段 · 预计 ${totalDuration.toFixed(1)} 秒；按分镜顺序预览。</p></div></div><div class="delivery-timeline">${episode.shots.map((shot,index)=>{
        // 竖屏成片塞进 300×110 的横条里只剩中间一条 60px 的窄带，原生控件还压在画面上。
        // 这里改成 9:16 缩略图 + 点击开大窗预览，控件回到正常尺寸。
        const still=shot.qc?.firstFrameUrl?`<img src="${esc(shot.qc.firstFrameUrl)}" alt="">`:`<video muted playsinline preload="metadata" src="${esc(playbackSrc(shot.mediaUrl))}"></video>`;
        return `<article class="timeline-clip ${shot.mediaUrl?"ready":""}"><span>S${String(index+1).padStart(2,"0")}</span><b>${esc(shot.title)}</b><small>${shot.duration}s · ${shot.qc?.passed?"质检通过":shot.mediaUrl?"待质检":"未生成"}</small>${shot.mediaUrl?`<button class="clip-thumb" data-action="preview-clip" data-url="${esc(shot.mediaUrl)}" data-title="${esc(shot.title)}" data-poster="${esc(shot.qc?.firstFrameUrl||"")}" title="点开预览该镜头">${still}<i aria-hidden="true">▶</i></button><div class="clip-actions"><button class="btn tiny ghost" data-action="download-media" data-url="${esc(shot.mediaUrl)}" title="下载该镜原始 mp4">下载</button><button class="btn tiny ghost" data-action="open-media" data-url="${esc(shot.mediaUrl)}" title="用系统播放器打开">播放器</button></div>`:`<div class="clip-thumb empty">未生成</div>`}</article>`;
      }).join("")}</div>
      <div class="grid cols-3"><article class="card"><div class="asset-symbol">{ }</div><h4>完整项目 JSON</h4><p>包含项目、剧集、资产、分镜、任务摘要与配置，但不包含 API Key。</p><button class="btn primary" style="margin-top:16px" data-action="export-json">导出 JSON</button></article><article class="card"><div class="asset-symbol">▤</div><h4>分镜 CSV</h4><p>适合制片表、人工审核和其他工具导入。</p><button class="btn ghost" style="margin-top:16px" data-action="export-csv">导出 CSV</button></article><article class="card"><div class="asset-symbol">Aa</div><h4>提示词包</h4><p>按资产和镜头整理为纯文本，便于批量生成。</p><button class="btn ghost" style="margin-top:16px" data-action="export-prompts">导出 TXT</button></article><article class="card"><div class="asset-symbol">EDL</div><h4>剪辑决策表</h4><p>导出 CMX3600 风格的镜头顺序与时间码。</p><button class="btn ghost" style="margin-top:16px" data-action="export-edl">导出 EDL</button></article><article class="card"><div class="asset-symbol">XML</div><h4>FCPXML 时间轴</h4><p>供剪辑软件继续整理；导入前仍需人工核对媒体路径。</p><button class="btn ghost" style="margin-top:16px" data-action="export-xml">导出 XML</button></article><article class="card"><div class="asset-symbol">SRC</div><h4>源素材清单</h4><p>汇总定妆图、九宫格、造型、关键帧和视频地址。</p><button class="btn ghost" style="margin-top:16px" data-action="export-assets">导出清单</button></article></div>
      <div class="section-head"><div><h3>交付预检</h3><p>结构检查不等于外部模型、剪辑客户端或商业发行验证。</p></div></div>
      <div class="grid cols-4">${[
        [episode.script.trim().length>0,"剧本已保存"],[episode.beats.length>0,"剧情节拍已建立"],[episode.shots.length>0,"分镜表已建立"],[allVideoQcPassed,"全部视频任务完成且质检通过"]
      ].map(([ok,label])=>`<div class="card"><span class="badge ${ok?"ok":"warn"}">${ok?"通过":"待完成"}</span><h4 style="margin-top:10px">${label}</h4></div>`).join("")}</div>`;
  };

  // ================= 模型与设置：四级层级（模块 → 服务商 → 模型 → 参数） =================
  // 这一整段只读 window.XH_MODEL_SCHEMA（assets/provider-schema.js 生成）。
  // 新增一家服务商 / 一个模型 / 一个参数，不需要改这里的任何一行。
  const settingsNode = { kind: "chat", providerId: "", modelId: "" };
  // 默认只展开到服务商层：12 家服务商的模型一次性摊开是 47 行，先收着，
  // 需要总览时点「全部展开」；点某个服务商也会立刻展开它自己的模型。
  const settingsCollapsed = new Set();
  MODEL_SCHEMA.modules.forEach((mod) => {
    (mod.providers || []).forEach(provider => settingsCollapsed.add(mod.kind + "/" + provider.id));
  });

  const cfgModule = kind => schemaModule(kind) || MODEL_SCHEMA.modules[0] || { providers: [] };
  // 当前启用通道沿用 state.settings.providers[kind].vendor（生成链路认这个字段）
  const cfgActiveVendor = kind => (state.settings.providers?.[kind]?.vendor) || (kind === "chat" ? "deepseek" : kind === "image" ? "ark" : "agentPlan");
  const cfgActiveProvider = kind => {
    const list = cfgModule(kind).providers || [];
    return list.find(item => item.vendor === cfgActiveVendor(kind)) || list[0] || null;
  };
  const cfgModelCount = mod => (mod.providers || []).reduce((sum, provider) => sum + provider.models.length, 0);
  const cfgSecretReady = provider => provider.secret.every(field => Boolean(secrets[field.slot]) || Boolean(serverSecrets[field.slot]));

  // 每家服务商的配置桶：连接信息 + 通道级参数 + 模型级覆盖。只存用户改过的键。
  const cfgBucket = (kind, providerId) => {
    const vendors = state.settings.vendors || (state.settings.vendors = {});
    const table = vendors[kind] || (vendors[kind] = {});
    const def = schemaProvider(kind, providerId);
    const bucket = table[providerId] || (table[providerId] = {});
    if (!bucket.baseUrl) bucket.baseUrl = def?.defaults.baseUrl || "";
    if (!bucket.endpoint) bucket.endpoint = def?.defaults.endpoint || "";
    if (!bucket.model) bucket.model = def?.defaults.model || "";
    if (!bucket.options || typeof bucket.options !== "object") bucket.options = {};
    if (!bucket.models || typeof bucket.models !== "object") bucket.models = {};
    return bucket;
  };

  // 参数取值：模型级覆盖 → 通道级设置（须与该模型兼容）→ 模型默认值。
  // 第 2 步的兼容性判断不能省：通道级设了某模型不支持的值时，该模型要回落而不是带着非法值请求。
  const cfgParamCompatible = (spec, value) => {
    if (value === "" || value === undefined || value === null) return false;
    if (spec.type === "select" && Array.isArray(spec.options)) return spec.options.map(String).includes(String(value));
    if (spec.type === "number") {
      const num = Number(value);
      if (!Number.isFinite(num)) return false;
      if (spec.min !== undefined && num < spec.min) return false;
      if (spec.max !== undefined && num > spec.max) return false;
    }
    return true;
  };
  const cfgParamValue = (kind, providerId, modelId, spec) => {
    const bucket = cfgBucket(kind, providerId);
    const overridden = modelId ? bucket.models[modelId]?.[spec.key] : undefined;
    if (overridden !== undefined && overridden !== "") return overridden;
    const channel = bucket.options?.[spec.key];
    if (channel !== undefined && cfgParamCompatible(spec, channel)) return channel;
    return spec.default !== undefined ? spec.default : "";
  };
  const cfgParamOverridden = (kind, providerId, modelId, key) => {
    if (!modelId) return false;
    const value = cfgBucket(kind, providerId).models[modelId]?.[key];
    return value !== undefined && value !== "";
  };

  // 运行时真正读取的参数标「生效」，其余标「记录」——避免让人以为改了就会进请求。
  const cfgWiredBadge = spec => (spec.wired
    ? '<span class="cfg-flag on" title="当前版本请求构造会读取该值">生效</span>'
    : '<span class="cfg-flag" title="会保存到配置；当前版本请求构造不读取它，改了不会改变出片结果">仅存档</span>');

  const cfgControl = (spec, value, dataAttr) => {
    const help = spec.placeholder ? ` placeholder="${esc(spec.placeholder)}"` : "";
    if (spec.type === "select") {
      const list = Array.isArray(spec.options) ? spec.options : [];
      const options = list.map(opt => `<option value="${esc(opt)}"${String(value) === String(opt) ? " selected" : ""}>${esc(opt)}</option>`).join("");
      const inherit = value === "" ? '<option value="" selected>（未设置）</option>' : '<option value="">（未设置）</option>';
      return `<select class="field" ${dataAttr}>${inherit}${options}</select>`;
    }
    if (spec.type === "boolean") {
      return `<label class="cfg-boolean"><input type="checkbox" ${dataAttr} ${value ? "checked" : ""}><span>${value ? "开启" : "关闭"}</span></label>`;
    }
    if (spec.type === "number") {
      const min = spec.min !== undefined ? ` min="${spec.min}"` : "";
      const max = spec.max !== undefined ? ` max="${spec.max}"` : "";
      const step = spec.step !== undefined ? ` step="${spec.step}"` : "";
      return `<input class="field" type="number" ${dataAttr}${min}${max}${step} value="${value === "" ? "" : esc(value)}">`;
    }
    if (spec.type === "textarea") {
      return `<textarea class="field" rows="2" ${dataAttr}${help}>${esc(value)}</textarea>`;
    }
    if (spec.type === "readonly") {
      return `<div class="cfg-readonly">${esc(value === "" ? "—" : value)}</div>`;
    }
    return `<input class="field" type="${spec.type === "password" ? "password" : "text"}" ${dataAttr}${help} value="${esc(value)}">`;
  };

  const cfgParamRow = (kind, providerId, modelId, spec, scope) => {
    const value = cfgParamValue(kind, providerId, modelId, spec);
    const overridden = cfgParamOverridden(kind, providerId, modelId, spec.key);
    const dataAttr = `data-cfg-param="${esc(spec.key)}" data-cfg-scope="${scope}"`;
    return `<div class="cfg-row">
      <div class="cfg-row-label">
        <span>${esc(spec.label || spec.key)}</span>
        <code>${esc(spec.key)}</code>
        ${cfgWiredBadge(spec)}
        ${scope === "model" && overridden ? '<span class="cfg-flag on">已覆盖</span>' : ""}
      </div>
      <div class="cfg-row-control">${cfgControl(spec, value, dataAttr)}${
        scope === "model" && overridden && spec.type !== "readonly"
          ? `<button class="btn tiny ghost" data-action="cfg-reset-param" data-key="${esc(spec.key)}" title="清除本模型的覆盖，回到通道默认">继承</button>`
          : ""
      }</div>
      ${spec.help ? `<p class="cfg-row-help">${esc(spec.help)}</p>` : ""}
    </div>`;
  };

  const cfgParamSection = (kind, providerId, modelId, params, scope, title, sub) => {
    if (!params || !params.length) return "";
    return `<article class="card cfg-card">
      <div class="cfg-card-head"><h4>${esc(title)}</h4><span class="hint">${esc(sub)}</span></div>
      <div class="cfg-rows">${params.map(spec => cfgParamRow(kind, providerId, modelId, spec, scope)).join("")}</div>
      <p class="cfg-note" style="margin-top:10px">标「生效」的项会进请求；标「仅存档」的项只保存下来，当前版本不读取。</p>
    </article>`;
  };

  const cfgSecretFields = (kind, provider) => provider.secret.map(field => {
    const stored = secrets[field.slot] || "";
    const managed = serverSecrets[field.slot];
    const id = provider.secret.length > 1 ? `${kind}-${field.name === "secretId" ? "tencent-id" : "tencent-key"}` : `${kind}-key`;
    const origin = stored === SERVER_SECRET_SENTINEL ? "已由本机密钥安全提供（不回显、不出站）" : stored ? "" : managed ? "留空即使用本机密钥" : "仅在本机会话使用";
    return `<div class="form-group" style="margin-top:10px">
      <label>${esc(field.label)}${field.required ? "" : "（可选）"}</label>
      <div class="secret-row">
        <input class="field" type="password" id="${id}" value="${stored === SERVER_SECRET_SENTINEL ? "" : esc(stored)}" placeholder="${esc(origin)}">
        <button class="btn ghost" data-action="toggle-secret-id" data-target="${id}">显示</button>
      </div>
    </div>`;
  }).join("");

  const cfgConnectionCard = (kind, provider) => {
    const bucket = cfgBucket(kind, provider.id);
    const modelOptions = provider.models.map(model => `<option value="${esc(model.id)}"${bucket.model === model.id ? " selected" : ""}>${esc(model.id)}</option>`).join("");
    return `<article class="card cfg-card">
      <div class="cfg-card-head"><h4>通道连接</h4><span class="hint">改了立刻生效；请求经 127.0.0.1 本地代理转发</span></div>
      <div class="form-group"><label>API BASE URL</label><input class="field" id="${kind}-base" value="${esc(bucket.baseUrl)}" placeholder="https://api.example.com"></div>
      <div class="form-group" style="margin-top:10px"><label>ENDPOINT</label><input class="field" id="${kind}-endpoint" value="${esc(bucket.endpoint)}"></div>
      <div class="form-group" style="margin-top:10px"><label>MODEL</label><select class="field" id="${kind}-model">${modelOptions}</select></div>
      ${cfgSecretFields(kind, provider)}
      <div class="actions" style="margin-top:14px"><button class="btn ghost" data-action="test-provider" data-type="${kind}">连接测试</button></div>
    </article>`;
  };

  // 视频通道的额度保护：这两项是老版本就有的防超支开关，语义不变，位置跟着通道走。
  const cfgVideoGuardCard = (kind, provider) => {
    if (kind !== "video") return "";
    const config = state.settings.providers.video || {};
    const freeOnly = Boolean(config.freeTierOnlyConfirmed);
    const price = config.pricePerSecond === null || config.pricePerSecond === undefined ? "" : config.pricePerSecond;
    const freeHint = provider.billing?.free ? `该通道额度：${esc(provider.billing.free)}` : "该通道没有免费额度，提交即产生费用";
    return `<article class="card cfg-card">
      <div class="cfg-card-head"><h4>额度保护</h4><span class="hint">${freeHint}</span></div>
      <label class="toggle" style="display:flex;gap:8px;align-items:flex-start"><input type="checkbox" id="video-free-tier-only" ${freeOnly ? "checked" : ""}><span>只用免费额度：我已在控制台关闭后付费/自动续订，额度用完就停。</span></label>
      <div class="form-group" style="margin-top:12px"><label>单价（元/秒，留空则不估算费用）</label><input class="field" id="video-price-per-second" type="number" min="0" step="0.01" value="${price === "" ? "" : esc(price)}"></div>
    </article>`;
  };

  const cfgProviderView = (kind, providerId) => {
    const provider = schemaProvider(kind, providerId);
    if (!provider) return '<article class="card cfg-card"><h4>该服务商不在层级表中</h4></article>';
    const isActive = cfgActiveVendor(kind) === provider.vendor;
    const selectedModel = state.settings.providers?.[kind]?.model || "";
    const modelGrid = provider.models.map(model => `<button class="cfg-model-chip${isActive && model.id === selectedModel ? " on" : ""}" data-action="cfg-pick" data-kind="${kind}" data-provider="${provider.id}" data-model="${model.id}" title="${esc(model.capability.join(" · "))}">
        <b>${esc(model.id)}</b>
        <small>${esc(model.capability.join(" · "))}</small>
      </button>`).join("");
    return `<div class="cfg-head">
        <div>
          <div class="cfg-crumb">${esc(cfgModule(kind).label)} › ${esc(provider.label)}</div>
          <h4>${esc(provider.label)} <span class="badge">${esc(provider.id)}</span></h4>
          <p class="hint">${esc(provider.desc || "")}</p>
        </div>
        <div class="actions">
          ${isActive ? '<span class="badge ok">当前启用</span>' : provider.live
            ? `<button class="btn primary" data-action="cfg-activate" data-kind="${kind}" data-provider="${provider.id}">设为当前通道</button>`
            : `<button class="btn ghost" data-action="cfg-activate" data-kind="${kind}" data-provider="${provider.id}" disabled title="${esc(provider.unavailableReason)}">待接入</button>`}
        </div>
      </div>
      ${provider.live ? "" : `<p class="cfg-note warn">${esc(provider.unavailableReason)}</p>`}
      <div class="cfg-columns">
        ${cfgConnectionCard(kind, provider)}
        ${cfgParamSection(kind, provider.id, "", provider.params, "channel", "通道默认参数", "作用于该服务商下全部模型；模型可单独覆盖")}
      </div>
      ${cfgVideoGuardCard(kind, provider)}
      <article class="card cfg-card">
        <div class="cfg-card-head"><h4>模型（${provider.models.length}）</h4><span class="hint">点任意模型进入它的参数</span></div>
        <div class="cfg-models">${modelGrid}</div>
      </article>`;
  };

  const cfgModelView = (kind, providerId, modelId) => {
    const provider = schemaProvider(kind, providerId);
    const model = schemaModel(kind, providerId, modelId);
    if (!provider || !model) return '<article class="card cfg-card"><h4>该模型不在层级表中</h4></article>';
    const spec = model.spec || {};
    const isActive = cfgActiveVendor(kind) === provider.vendor && state.settings.providers?.[kind]?.model === model.id;
    const capabilityRows = [];
    capabilityRows.push(["生成模式 modes", (spec.modes || []).join(" / ") || "text"]);
    if (kind === "chat") {
      if (spec.contextTokens) capabilityRows.push(["上下文 contextTokens", `${Math.round(spec.contextTokens / 1000)}K`]);
      capabilityRows.push(["工具调用 tools", spec.tools ? "支持" : "不支持"]);
    } else {
      capabilityRows.push(["参考图上限 references", String(spec.references ?? 0)]);
      capabilityRows.push(["分辨率 resolutions", (spec.resolutions || []).join(" / ") || "—"]);
      if (kind === "video") capabilityRows.push(["音轨", spec.audio ? "支持" : "不支持"]);
      if (kind === "video" && spec.concurrency) capabilityRows.push(["并发上限", String(spec.concurrency)]);
      capabilityRows.push(["水印", spec.watermark ? "有" : "无"]);
    }
    if (spec.freeTier) capabilityRows.push(["免费额度", "可用"]);
    if (spec.note) capabilityRows.push(["备注", spec.note]);
    return `<div class="cfg-head">
        <div>
          <div class="cfg-crumb">${esc(cfgModule(kind).label)} › ${esc(provider.label)} › ${esc(model.id)}</div>
          <h4>${esc(model.id)}</h4>
          <p class="hint">${esc(model.capability.join(" · "))}</p>
        </div>
        <div class="actions">
          ${isActive ? '<span class="badge ok">当前在用</span>'
            : `<button class="btn primary" data-action="cfg-activate-model" data-kind="${kind}" data-provider="${provider.id}" data-model="${esc(model.id)}" ${provider.live ? "" : "disabled"}>设为当前模型</button>`}
        </div>
      </div>
      <div class="cfg-columns">
        <article class="card cfg-card">
          <div class="cfg-card-head"><h4>模型能力</h4><span class="hint">只读，来自能力表</span></div>
          <div class="cfg-capability">${capabilityRows.map(([label, value]) => `<div class="cfg-cap-row"><span>${esc(label)}</span><b>${esc(value)}</b></div>`).join("")}</div>
        </article>
        ${cfgParamSection(kind, provider.id, model.id, model.params, "model", "模型参数", "留空即继承通道默认；改过的项标「已覆盖」")}
      </div>
      <p class="cfg-note">通道连接走「${esc(provider.label)}」那张配置：<code>${esc(cfgBucket(kind, provider.id).baseUrl)}</code>${esc(cfgBucket(kind, provider.id).endpoint)}</p>`;
  };

  const cfgModuleView = (kind) => {
    const mod = cfgModule(kind);
    const activeVendor = cfgActiveVendor(kind);
    const activeModel = state.settings.providers?.[kind]?.model || "";
    const rows = (mod.providers || []).map(provider => {
      const active = provider.vendor === activeVendor;
      const ready = cfgSecretReady(provider);
      const chips = provider.models.map(model => `<button class="cfg-mini-chip${active && model.id === activeModel ? " on" : ""}" data-action="cfg-pick" data-kind="${kind}" data-provider="${provider.id}" data-model="${model.id}" title="${esc(model.capability.join(" · "))}">${esc(model.id)}</button>`).join("");
      return `<tr class="${active ? "cfg-active-row" : ""}">
        <td class="cfg-provider-cell">
          <button class="cfg-provider-link" data-action="cfg-pick" data-kind="${kind}" data-provider="${provider.id}">${esc(provider.label)}</button>
          <small>${esc(provider.id)}</small>
        </td>
        <td class="mono" title="${esc(provider.defaults.baseUrl)}">${esc(provider.defaults.baseUrl.replace(/^https:\/\//, ""))}</td>
        <td class="mono" title="${esc(provider.defaults.endpoint)}">${esc(provider.defaults.endpoint)}</td>
        <td>${ready ? '<span class="badge ok">已配凭据</span>' : '<span class="badge warn">待填凭据</span>'}</td>
        <td>${active ? '<span class="badge ok">当前启用</span>' : provider.live ? `<button class="btn tiny ghost" data-action="cfg-activate" data-kind="${kind}" data-provider="${provider.id}">设为当前</button>` : '<span class="badge">待接入</span>'}</td>
      </tr>
      <tr class="cfg-chip-row"><td colspan="5"><div class="cfg-mini-chips">${chips}</div></td></tr>`;
    }).join("");
    return `<div class="cfg-head">
        <div>
          <div class="cfg-crumb">${esc(mod.label)}</div>
          <h4>${esc(mod.label)} <span class="badge">${(mod.providers || []).length} 服务商 / ${cfgModelCount(mod)} 模型</span></h4>
          <p class="hint">${esc(mod.desc || "")}　当前启用：<b>${esc(cfgActiveProvider(kind)?.label || "—")}</b> · ${esc(activeModel || "—")}</p>
        </div>
        <div class="actions"><button class="btn ghost" data-action="cfg-expand" data-kind="${kind}">展开该模块模型</button></div>
      </div>
      <article class="card cfg-card">
        <table class="table cfg-table">
          <colgroup><col style="width:20%"><col style="width:26%"><col style="width:26%"><col style="width:14%"><col style="width:14%"></colgroup>
          <thead><tr><th>服务商</th><th>API BASE URL</th><th>ENDPOINT</th><th>凭据</th><th>状态</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </article>`;
  };

  const cfgTreeModule = (mod) => {
    const open = !settingsCollapsed.has(mod.kind);
    const activeVendor = cfgActiveVendor(mod.kind);
    const activeModel = state.settings.providers?.[mod.kind]?.model || "";
    const providers = (mod.providers || []).map(provider => {
      const pOpen = !settingsCollapsed.has(mod.kind + "/" + provider.id);
      const isActive = provider.vendor === activeVendor;
      const selected = settingsNode.kind === mod.kind && settingsNode.providerId === provider.id && !settingsNode.modelId;
      const models = pOpen ? provider.models.map(model => `<button class="cfg-leaf${selected && settingsNode.modelId === model.id ? " on" : ""}${isActive && model.id === activeModel ? " now" : ""}" data-action="cfg-pick" data-kind="${mod.kind}" data-provider="${provider.id}" data-model="${model.id}" title="${esc(model.capability.join(" · "))}">${esc(model.id)}</button>`).join("") : "";
      return `<button class="cfg-branch${selected ? " on" : ""}${isActive ? " active" : ""}" data-action="cfg-pick" data-kind="${mod.kind}" data-provider="${provider.id}">
          <span class="cfg-caret${pOpen ? "" : " closed"}">▾</span>
          <span class="cfg-dot ${cfgSecretReady(provider) ? "ok" : "warn"}"></span>
          <span class="cfg-branch-label">${esc(provider.label)}</span>
          ${provider.live ? "" : '<span class="cfg-tag">待接入</span>'}
          <span class="cfg-count">${provider.models.length}</span>
        </button>
        <div class="cfg-leaves"${pOpen ? "" : " hidden"}>${models}</div>`;
    }).join("");
    return `<div class="cfg-branch-group">
        <button class="cfg-module${settingsNode.kind === mod.kind ? " on" : ""}" data-action="cfg-pick" data-kind="${mod.kind}">
          <span class="cfg-caret${open ? "" : " closed"}">▾</span>
          <span>${esc(mod.label)}</span>
          <span class="cfg-count">${(mod.providers || []).length} / ${cfgModelCount(mod)}</span>
        </button>
        <div class="cfg-branches"${open ? "" : " hidden"}>${providers}</div>
      </div>`;
  };

  const cfgIssues = () => {
    const issues = [];
    const kind = settingsNode.kind;
    const providerId = settingsNode.providerId || cfgActiveProvider(kind)?.id;
    const provider = providerId ? schemaProvider(kind, providerId) : null;
    if (!provider) return issues;
    const bucket = cfgBucket(kind, provider.id);
    if (!/^https:\/\//i.test(bucket.baseUrl || "")) issues.push({ level: "err", text: `${provider.label}：API BASE URL 必须是 https 公网地址` });
    if (!bucket.endpoint) issues.push({ level: "warn", text: `${provider.label}：ENDPOINT 为空，请求会打到 BASE URL 根路径` });
    if (!provider.models.some(model => model.id === bucket.model)) issues.push({ level: "err", text: `${provider.label}：模型 ${bucket.model || "(未选)"} 不在该服务商的能力表里` });
    for (const field of provider.secret) {
      if (field.required && !secrets[field.slot] && !serverSecrets[field.slot]) issues.push({ level: "warn", text: `${provider.label}：${field.label} 未填写，调用会失败（保存配置不记录密钥）` });
    }
    const model = schemaModel(kind, provider.id, settingsNode.modelId || bucket.model);
    if (model) {
      for (const spec of model.params) {
        const value = cfgParamValue(kind, provider.id, model.id, spec);
        if (spec.type === "number" && value !== "" && !cfgParamCompatible(spec, value)) {
          issues.push({ level: "err", text: `${model.id} · ${spec.label || spec.key}：${value} 超出允许范围${spec.min !== undefined ? `（${spec.min}–${spec.max}）` : ""}` });
        }
        if (spec.type === "select" && value !== "" && !cfgParamCompatible(spec, value)) {
          issues.push({ level: "err", text: `${model.id} · ${spec.label || spec.key}：${value} 不在可选范围内` });
        }
      }
    }
    return issues;
  };

  const renderCfgIssues = () => cfgIssues().map(issue => `<div class="cfg-issue ${issue.level}"><span>${issue.level === "err" ? "阻断" : "提示"}</span>${esc(issue.text)}</div>`).join("") || '<div class="cfg-issue ok"><span>通过</span>配置未发现阻断项。</div>';

  // 切通道只改指针：地址、端点、模型、密钥槽位都由层级表重新推导，不再各处复制预设。
  const activateChannel = (kind, providerId, modelId = "", options = {}) => {
    const provider = schemaProvider(kind, providerId);
    if (!provider) { showToast("层级表里没有这个服务商。", true); return; }
    if (!provider.live) { showToast(provider.unavailableReason || "该通道尚未接入生成链路。", true); return; }
    const previousVendor = state.settings.providers[kind]?.vendor;
    const vendorChanged = previousVendor !== provider.vendor;
    state.settings.providers[kind] = { ...state.settings.providers[kind], vendor: provider.vendor };
    const bucket = cfgBucket(kind, provider.id);
    if (modelId) bucket.model = modelId;
    settingsNode.kind = kind;
    settingsNode.providerId = provider.id;
    settingsNode.modelId = modelId || "";
    settingsCollapsed.delete(kind);
    settingsCollapsed.delete(kind + "/" + provider.id);
    // 智谱的图片与视频、百炼的图片与视频都是同一把 Key：切过去时直接复用，免得再粘一次。
    const pairs = { videoZhipu: "imageZhipu", imageZhipu: "videoZhipu", videoDashscope: "imageDashscope", imageDashscope: "videoDashscope" };
    const slot = provider.secret[0].slot;
    if (pairs[slot] && !secrets[slot] && secrets[pairs[slot]]) {
      secrets[slot] = secrets[pairs[slot]];
      secretOrigins[slot] = secretOrigins[pairs[slot]] || "manual";
      saveSecrets(); saveSecretOrigins();
    }
    applyVendorsToProviders();
    if (vendorChanged) {
      // 换了一家通道，上一家的「免费额度已确认」不能顺延：新通道可能默认后付费。
      // 放在 applyVendorsToProviders 之后，否则会被旧界面上的勾选状态又读回去。
      state.settings.providers[kind].freeTierOnlyConfirmed = false;
      state.settings.providers[kind].pricePerSecond = null;
    }
    persist();
    render();
    if (!options.silent) {
      const ready = cfgSecretReady(provider);
      showToast(`已切换到 ${provider.label}（${bucket.model}）${ready ? "，凭据已就绪。" : "，请填写该通道的凭据后再提交生成。"}`);
    }
  };

  const renderSettings = () => {
    const kind = settingsNode.kind;
    const body = settingsNode.modelId
      ? cfgModelView(kind, settingsNode.providerId, settingsNode.modelId)
      : settingsNode.providerId
        ? cfgProviderView(kind, settingsNode.providerId)
        : cfgModuleView(kind);
    const totalProviders = MODEL_SCHEMA.modules.reduce((sum, mod) => sum + (mod.providers || []).length, 0);
    const totalModels = MODEL_SCHEMA.modules.reduce((sum, mod) => sum + cfgModelCount(mod), 0);
    return `<div class="section-head"><div><h3>模型与设置</h3><p>${MODEL_SCHEMA.modules.length} 个模块 · ${totalProviders} 家服务商 · ${totalModels} 个模型，逐层可配；Key 默认只保存在当前会话。</p></div>
      <div class="actions"><button class="btn ghost" data-action="cfg-reset">恢复出厂</button><button class="btn primary" data-action="save-settings">保存配置</button></div></div>
    <div class="cfg-wrap">
      <aside class="card cfg-tree">
        <div class="cfg-tree-head"><span>模块层级</span><button class="btn tiny ghost" data-action="cfg-toggle-all">${settingsCollapsed.size ? "全部展开" : "全部收起"}</button></div>
        <div class="cfg-tree-body">${MODEL_SCHEMA.modules.map(cfgTreeModule).join("")}</div>
      </aside>
      <section class="cfg-main">${body}
        <article class="card cfg-card"><div class="cfg-card-head"><h4>校验</h4><span class="hint">保存前拦截越界值</span></div><div class="cfg-issues">${renderCfgIssues()}</div></article>
      </section>
    </div>
    <div class="card" style="margin-top:14px"><label class="toggle"><input type="checkbox" id="remember-secrets" ${state.settings.rememberSecrets ? "checked" : ""}>在本机持久保存 API Key（仅建议个人受控电脑使用）</label><p class="hint" style="margin-top:8px">关闭时 Key 只写入 sessionStorage，关闭 WebEngine 会话后失效。所有请求经 127.0.0.1 本地代理转发；代理拒绝内网目标并且不记录请求正文。</p></div>
    <div class="section-head"><div><h3>层级约定</h3></div></div>
    <div class="grid cols-3">
      <div class="card"><h4>① 模块级</h4><p>决定该类能力调用哪家服务商、哪个模型。只写指针，不带地址与密钥。</p></div>
      <div class="card"><h4>② 服务商级</h4><p>地址、端点、凭据与通道默认参数，作用于该服务商下全部模型。切通道不会把旧 Key 写进新通道。</p></div>
      <div class="card"><h4>③ 模型级</h4><p>能力约束只读；参数可覆盖通道默认。通道设了该模型不支持的值时，模型自动回落到自己的默认。</p></div>
    </div>`;
  };

  const views = { dashboard: renderDashboard, script: renderScript, assets: renderAssets, prompts: renderPrompts, storyboard: renderStoryboard, generation: renderGeneration, delivery: renderDelivery, settings: renderSettings };
  const render = () => {
    app.innerHTML = shell((views[currentView] || renderDashboard)()) + (studioOpen ? renderStudio() : "");
    bind();
    startQueueTicker();
  };

  const saveScriptFromEditor = () => {
    const episode = getEpisode();
    const input = document.querySelector("#script-input");
    if (!episode || !input) return;
    const next=input.value.trim();if(next!==episode.script){if(episode.script){episode.scriptVersions||=[];episode.scriptVersions.push({id:uid("script"),text:episode.script,createdAt:now(),source:"manual-edit"});episode.scriptVersions=episode.scriptVersions.slice(-20);}episode.scriptCheckpoint={stage:"idle",updatedAt:now(),error:""};}episode.script = next;
    episode.targetDuration=document.querySelector("#script-duration")?.value||episode.targetDuration;episode.language=document.querySelector("#script-language")?.value||episode.language;episode.visualStyle=document.querySelector("#script-style")?.value||episode.visualStyle;getProject().format=document.querySelector("#script-format")?.value||getProject().format;
    addLog(`保存剧本，共 ${episode.script.length} 字。`);
    persist();
  };
  const aiEditScript = async mode => {
    saveScriptFromEditor();const episode=getEpisode();if(!episode.script)return showToast("请先输入剧本。",true);showToast(mode==="continue"?"正在续写剧本…":"正在改写剧本…");
    try{const cfg=state.settings.providers.chat;const targetSeconds=Math.max(10,Number(episode.targetDuration)||60);const targetChars=Math.round(targetSeconds*4.2);const needsCompression=episode.script.length>targetChars*1.25;const instruction=mode==="continue"?"在保持角色、时间线和写作风格的前提下续写，续写长度约为原文三分之一；返回原文加续写后的完整剧本。":needsCompression?`把剧本压缩成可在 ${targetSeconds} 秒内表演完成的短片，成稿约 ${targetChars} 个汉字。保留核心人物、冲突、因果和最关键的原句台词；允许删减重复台词与支线，但不得改变人物关系或凭空增加情节。明确标注说话人，动作要可视化；只返回完整压缩稿。`:"保留人物、情节事实和所有逐字台词，仅优化节奏、场景动作和可视化表达；返回完整改写剧本。";
      const data=await proxyRequest("chat",{model:cfg.model,thinking:{type:"disabled"},temperature:mode==="continue"?.7:.3,messages:[{role:"system",content:"你是短剧编剧，只返回完整剧本文本，不要解释。角色说话仍写为角色台词，禁止把台词改为旁白。"},{role:"user",content:`${instruction}\n目标时长：${episode.targetDuration}秒\n语言：${episode.language}\n剧本：\n${episode.script}`}]});
      const text=String(data?.choices?.[0]?.message?.content||"").trim();if(!text)throw new Error("模型未返回剧本");episode.scriptVersions||=[];episode.scriptVersions.push({id:uid("script"),text:episode.script,createdAt:now(),source:mode});episode.script=text;episode.scriptCheckpoint={stage:"idle",updatedAt:now(),error:""};addLog(`剧本 AI ${mode==="continue"?"续写":"改写"}完成。`,{model:cfg.model});persist();render();showToast("剧本已更新，请重新解析结构。");
    }catch(error){addLog(`剧本 AI 编辑失败：${error.message}`);persist();render();showToast(error.message,true);}
  };
  const rollbackScript = () => {const episode=getEpisode();const version=episode.scriptVersions?.pop();if(!version)return showToast("没有可回滚的剧本版本。",true);episode.scriptVersions.push({id:uid("script"),text:episode.script,createdAt:now(),source:"rollback"});episode.script=version.text;episode.scriptCheckpoint={stage:"idle",updatedAt:now(),error:""};persist();render();showToast("剧本已回滚。");};

  const localBreakdown = () => {
    saveScriptFromEditor();
    const episode = getEpisode();
    if (!episode.script) return showToast("请先输入剧本。", true);
    const sentences = episode.script.split(/(?<=[。！？!?\n])/).map(item => item.trim()).filter(Boolean);
    const beats = [];
    for (let index = 0; index < sentences.length; index += 2) {
      const text = sentences.slice(index, index + 2).join("");
      beats.push({ id: uid("beat"), title: `节拍 ${beats.length + 1}`, text, location: "待确认", mood: beats.length % 2 ? "推进" : "建立" });
    }
    episode.beats = beats;
    episode.scriptCheckpoint={stage:"completed",updatedAt:now(),error:"",mode:"local"};
    addLog(`使用本地规则拆解为 ${beats.length} 个剧情节拍；未发送网络请求。`);
    persist(); render(); showToast("本地拆解完成。");
  };

  // fetch 在「本地服务没启动/正在重启」时会直接 reject（Failed to fetch），翻译成能行动的提示。
  const safeFetch = async (url, options) => {
    try {
      return await fetch(url, options);
    } catch (error) {
      if (error instanceof TypeError) {
        throw new Error("本地服务没有响应：请点窗口顶部的「启动 / 重载」重启本地服务，再重试。若反复出现，点「后台日志」查看后端记录。");
      }
      throw error;
    }
  };

  const modelProxyCall = async (provider, body, credential) => {
    const config = state.settings.providers[provider];
    const envelope = { provider, baseUrl: config.baseUrl, endpoint: config.endpoint, payload: body };
    if (config.vendor === "tencent") {
      envelope.credentialId = credential?.id === SERVER_SECRET_SENTINEL ? "" : normalizeKey(credential?.id || "");
      envelope.credentialKey = credential?.key === SERVER_SECRET_SENTINEL ? "" : normalizeKey(credential?.key || "");
    } else {
      envelope.apiKey = credential || "";
    }
    const response = await safeFetch("/api/model-proxy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(envelope),
    });
    const contentType = response.headers.get("content-type") || "";
    const data = contentType.includes("application/json") ? await response.json() : { raw: await response.text() };
    return { response, data };
  };

  const providerHint = (text) => {
    const raw = String(text || "");
    if (/Only public HTTPS model providers are allowed/i.test(raw)) {
      return "模型地址安全检查未通过。若地址本来就是 https:// 开头的公网官方接口，通常是临时 DNS 解析失败，稍等几秒后重试即可；若持续出现，请到“模型与设置”检查 BASE URL，不能填写 localhost、127.0.0.1、局域网 IP 或 http:// 地址。";
    }
    // 阿里百炼：欠费与「免费额度用尽」走同一个英文错误码 Arrearage / overdue-payment。
    // 图像、视频、文本是分开的额度池，常见现象是文本还能用、出图和出片全挂。
    if (/Arrearage|overdue|in good standing|overdue-payment/i.test(raw)) {
      return "阿里百炼账户欠费，或该模型的免费额度已用尽（图像/视频与文本是分开的额度池，文本还能用不代表出图有额度）。到 https://bailian.console.aliyun.com 充值或领取额度后重试。这是账户问题，不是提示词或镜头内容出错，程序不会把这些镜头标记成失败。";
    }
    // 智谱（bigmodel.cn）的报错是中文 + 数字错误码，先单独翻译。
    if (/身份验证失败|API\s?key.{0,8}(无效|过期|不合法|错误)|1002|1003/i.test(raw)) {
      return "智谱 Key 无效或已过期：到 bigmodel.cn「个人中心 - API Keys」重新复制；注意别把项目 ID 当成 Key。";
    }
    if (/欠费|余额不足|资源包|insufficient|1113/i.test(raw)) {
      return "智谱账户余额或免费资源包不足，充值 / 领取额度后再试。";
    }
    if (/内容审核|敏感|1301|content.?policy|sensitive/i.test(raw)) {
      return "提示词或首帧被内容审核拦下：换一版画面描述，避免暴力、真实人物肖像等敏感内容。";
    }
    if (/访问量过大|1305/i.test(raw)) {
      return "这是智谱免费模型（cogvideox-flash / cogview-3-flash）的平台级共享配额限制，错误码 1305，跟你一次提交几个镜头无关——单个视频同样会被拒。它不是 Key 问题、也不扣费。程序会自动后台排队重试（30/60/120/180/300/600 秒，累计约 21 分钟），排不上就保留为「queued」等下一轮。想立刻稳定出片，可在设置里把视频模型换成 cogvideox-3（付费通道，不共享免费配额）。";
    }
    if (/并发|频率|限流|QPS|429|1302|1303|rate.?limit|too many requests/i.test(raw)) {
      return "免费通道限流（HTTP 429）：程序会自动后台排队重试（30/60/120/180/300/600 秒，累计约 21 分钟）。等待期间不要重复点击，任务台账会显示倒计时。若仍失败，说明配额已用满，建议隔几小时或改天再跑。";
    }
    if (/UnsupportedModel|does not support the agent plan/i.test(raw)) {
      return "这个模型不在当前套餐档位里：视频生成只有 Large / Max 套餐支持，Small / Medium 只能跑文本和图片。也可以把「视频模型」卡片的接口切到「智谱 CogVideoX（cogvideox-flash 免费）」，填一个 bigmodel.cn 的 Key 即可直接出片。";
    }
    if (/ModelNotOpen/i.test(raw)) {
      return "这个账号还没开通该模型：去方舟控制台「开通管理」启用它，或换一个已开通的模型 ID（后付费接口要求带日期，如 doubao-seedance-2-0-260128）。";
    }
    if (/AuthenticationError|API key or AK\/SK/i.test(raw)) {
      return "这把 Key 对它访问的接口无效：Agent Plan 的 Key 只能打 /api/plan/v3，后付费接口要用普通 ARK Key。";
    }
    if (/overdue|balance/i.test(raw)) return "账户欠费停服，充值后重试。图片可切到「智谱 CogView（cogview-3-flash 免费）」，视频可切到「智谱 CogVideoX（cogvideox-flash 免费）」，同一个 bigmodel.cn Key 就能免费出片。";
    return "";
  };
  const proxyError = (response, data) => {
    const detail = String(data?.detail || "");
    const message = [data?.error?.message, typeof data?.error === "string" ? data.error : "", data?.message, data?.code].filter(Boolean)[0];
    // 本地服务给出的中文 detail 往往才是「下一步该做什么」，别被泛化的英文 error 盖住。
    const localizedDetail = /[\u4e00-\u9fa5]/.test(detail) && !/[\u4e00-\u9fa5]/.test(String(message || "")) ? detail : "";
    const base = localizedDetail || (message ? `${message}（HTTP ${response.status}）` : (data?.raw || `HTTP ${response.status}`));
    const hint = providerHint(`${message || ""} ${data?.error?.code || ""} ${detail}`);
    return new Error(hint ? `${base}\n提示：${hint}` : base);
  };

  // 各通道独立凭据：火山图片用 secrets.image，智谱图片用 secrets.imageZhipu；视频同理。
  // 除了 vendor，也认 baseUrl——老快照里可能只有 baseUrl 改了、vendor 还没跟上。
  const isZhipuChannel = (provider) => {
    const cfg = state.settings.providers[provider] || {};
    return cfg.vendor === "zhipu" || String(cfg.baseUrl || "").includes("open.bigmodel.cn");
  };
  const secretNameFor = (provider) => {
    // 层级表在保存配置时已经写明了该通道用哪个密钥槽位，优先照做；
    // 只有老数据（没有 secretName 字段）才回落到按 vendor 判断。
    const explicit = state.settings.providers?.[provider]?.secretName;
    if (explicit) return explicit;
    if (provider === "video" && isZhipuChannel("video")) return "videoZhipu";
    if (provider === "image" && isZhipuChannel("image")) return "imageZhipu";
    if (provider === "image" && state.settings.providers.image?.vendor === "dashscope") return "imageDashscope";
    if (provider === "video" && state.settings.providers.video?.vendor === "dashscope") return "videoDashscope";
    return provider;
  };

  // 取 Key 时的三层兜底：本通道 → 另一智谱通道（同一把 bigmodel Key）→ 本机保存的密钥。
  // 第三层用哨兵值交给 127.0.0.1 服务端注入，浏览器始终不接触明文。
  const resolveSecret = (provider, forcedName = "") => {
    const name = forcedName || secretNameFor(provider);
    if (secrets[name]) return { name, value: secrets[name], borrowed: false };
    const sibling = zhipuSiblingSecret(name);
    if (sibling && secrets[sibling]) return { name, value: secrets[sibling], borrowed: true, sibling };
    if (serverSecrets[name] || (sibling && serverSecrets[sibling])) return { name, value: SERVER_SECRET_SENTINEL, borrowed: false };
    return { name, value: "", borrowed: false };
  };

  // 智谱通道是否至少有一处可用 Key（浏览器两通道任一处，或本机密钥）。
  const zhipuKeyAvailable = () => Boolean(secrets.imageZhipu || secrets.videoZhipu || serverSecrets.imageZhipu || serverSecrets.videoZhipu);

  // 对话参数只在用户「显式设过」时才进请求：没设过就用各调用点自己的温度
  //（剧本拆解 0.3、续写 0.7），升级适配器也不会因为多了个默认值把行为改掉。
  const cfgChatOverrides = (modelId) => {
    const provider = cfgActiveProvider("chat");
    if (!provider) return {};
    const bucket = cfgBucket("chat", provider.id);
    const specs = schemaModel("chat", provider.id, modelId)?.params || [];
    const explicit = (key) => {
      const fromModel = bucket.models?.[modelId]?.[key];
      if (fromModel !== undefined && fromModel !== "") return fromModel;
      const fromChannel = bucket.options?.[key];
      if (fromChannel !== undefined && fromChannel !== "") return fromChannel;
      return undefined;
    };
    const bag = {};
    const temperature = explicit("temperature");
    if (temperature !== undefined && Number.isFinite(Number(temperature))) bag.temperature = Number(temperature);
    const maxTokens = explicit("maxTokens");
    if (maxTokens !== undefined && Number.isFinite(Number(maxTokens))) bag.max_tokens = Number(maxTokens);
    const jsonMode = explicit("jsonMode");
    if (jsonMode === true || jsonMode === "true") bag.response_format = { type: "json_object" };
    // 只给真正声明过的参数兜底，避免表里没写的键悄悄进请求
    for (const key of Object.keys(bag)) {
      if (key !== "response_format" && !specs.some(spec => spec.key === (key === "max_tokens" ? "maxTokens" : key))) delete bag[key];
    }
    return bag;
  };

  const proxyRequest = async (provider, body, options = {}) => {
    const config = state.settings.providers[provider];
    if (provider === "video" && config.vendor === "tencent") {
      const id = secrets.videoTencentId || (serverSecrets.videoTencentId ? SERVER_SECRET_SENTINEL : "");
      const key = secrets.videoTencentKey || (serverSecrets.videoTencentKey ? SERVER_SECRET_SENTINEL : "");
      if (!id || !key) throw new Error("未配置腾讯云 SecretId 与 SecretKey（必须成对填写）");
      const releaseLane = await acquireProviderLane(provider, config, body, options);
      try {
        const { response, data } = await modelProxyCall(provider, body, { id, key });
        if (!response.ok) throw proxyError(response, data);
        if (readEnvAlert()) clearEnvAlert();
        return data;
      } finally {
        releaseLane();
      }
    }
    // 对话参数来自「模型与设置」：调用点显式传了就不覆盖，保持各自的温度策略。
    if (provider === "chat" && body && typeof body === "object" && !Array.isArray(body)) {
      const overrides = cfgChatOverrides(body.model || config.model);
      for (const [key, value] of Object.entries(overrides)) {
        if (body[key] === undefined) body[key] = value;
      }
    }
    const { name: secretName, value: key, borrowed, sibling } = resolveSecret(provider, options.secretName);
    if (!key) {
      const zhipuTip = secretName === "videoZhipu" || secretName === "imageZhipu"
        ? "（智谱开放平台；图片与视频共用同一个 Key，在任意一张智谱卡片里填一次并保存即可）"
        : "";
      throw new Error(`未配置${config.label} API Key${zhipuTip}`);
    }
    const releaseLane = await acquireProviderLane(provider, config, body, options);
    try {
    // 借用另一通道的智谱 Key 时提示一次，让用户知道该填哪儿；不打断本次请求。
    if (borrowed) addLog(`${config.label}：已自动复用${sibling === "imageZhipu" ? "图片" : "视频"}通道里保存的智谱 Key（同一把 bigmodel.cn 密钥）。`);
    // 数据库里那把 Key 可能已经在控制台被轮换/吊销，而 localStorage 还留着旧值：
    // 401 时自动回退到本机密钥，成功就永久换掉过期的那份，不再让用户撞同一堵墙。
    const browserKey = key === SERVER_SECRET_SENTINEL ? "" : normalizeKey(key);
    let { response, data } = await modelProxyCall(provider, body, browserKey);
    const serverCanInject = Boolean(serverSecrets[secretName] || (sibling && serverSecrets[sibling]));
    if (!response.ok && browserKey && serverCanInject) {
      const text = JSON.stringify(data || {});
      const retryable = response.status === 401 || (response.status === 403 && /overdue|balance|permission|denied/i.test(text));
      if (retryable) {
        const retry = await modelProxyCall(provider, body, "");
        if (retry.response.ok) {
          secrets[secretName] = SERVER_SECRET_SENTINEL;
          staleSecrets.delete(secretName);
          delete secretOrigins[secretName];
          saveSecrets();
          saveSecretOrigins();
          addLog(`${config.label}：浏览器里的 Key 已失效（HTTP ${response.status}），已自动改用本机密钥。`, { model: config.model });
          showToast(`${config.label} 浏览器里保存的 Key 已失效，已自动改用本机密钥。`);
          return retry.data;
        }
        ({ response, data } = retry);
      }
    }
    if (!response.ok) throw proxyError(response, data);
    // 请求真的成功了，说明账户/Key 已经恢复：撤掉顶部那条账户告警，别一直挂着吓人。
    if (readEnvAlert()) { clearEnvAlert(); addLog(`${config.label} 通道已恢复正常，账户提示自动收起。`, { model: config.model }); }
    return data;
    } finally {
      releaseLane();
    }
  };

  const parseJsonText = (text) => {
    const cleaned = String(text || "").replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    return JSON.parse(cleaned);
  };

  function sceneMatchesContext(context, name) {
    const source = String(context || "").replace(/\s+/g, "");
    const full = String(name || "").replace(/\s+/g, "");
    const stem = full.replace(/(?:内部|室内|内景|外景|场景|房间|包厢内|走廊内|内|外)$/u, "");
    return Boolean(full && (source.includes(full) || (stem.length >= 2 && source.includes(stem))));
  }

  const autoBindShot = (episode, shot) => {
    repairShotCharacterBindings(episode, shot);
    if (!shot.sceneId) {
      const text = `${shot.title} ${shot.action} ${shot.prompt}`;
      const scene = episode.assets.scenes.find(item => sceneMatchesContext(text, item.name));
      if (scene) shot.sceneId = scene.id;
    }
    shot.propIds ||= [];
    shot.firstFrameUrl ||= "";
    shot.lastFrameUrl ||= "";
    shot.chainSourceShotId ||= "";
    shot.qc ||= null;
    return shot;
  };
  const mergeParsedAsset = (type, item, previousAssets) => {
    const name=String(item.name||`未命名${assetLabels[type]?.[0]||"资产"}`);const existing=(previousAssets[type]||[]).find(value=>value.name===name);const library=(getProject().assetLibrary?.[type]||[]).find(value=>value.name===name);const source=existing||library;
    let asset=source?structuredClone(source):{id:uid("asset"),name,note:"",prompt:"",negativePrompt:QUALITY_NEGATIVE,promptVersions:[],promptStatus:"missing",version:1,libraryId:"",referenceImage:"",referenceStatus:"missing",referenceOutdated:false};
    if(!existing){asset.id=uid("asset");if(library){asset.libraryId=library.id;asset.libraryVersion=library.version;delete asset.sourceAssetId;delete asset.type;delete asset.updatedAt;}}
    asset.name=name;asset.note=asset.note||String(item.note||"");asset.prompt=asset.prompt||String(item.prompt||"");asset.promptStatus=asset.prompt?"ready":"missing";
    if(type==="characters"){asset.variations||=[];asset.turnaround={...emptyTurnaround(),...(asset.turnaround||{})};asset.faceRequired=!/(系统|光球|界面|AI\b|robot|orb|holographic)/i.test(`${asset.name} ${asset.note} ${asset.prompt}`);}
    return asset;
  };

  const aiBreakdown = async () => {
    saveScriptFromEditor();
    const episode = getEpisode();
    if (!episode.script) return showToast("请先输入剧本。", true);
    episode.scriptCheckpoint = { stage: "parsing", updatedAt: now(), error: "", scriptHash: String(episode.script.length) }; persist();
    showToast("正在调用对话模型进行结构化解析…");
    try {
      const cfg = state.settings.providers.chat;
      const schema = `返回 JSON：{"beats":[{"title":"","text":"","location":"","mood":""}],"assets":{"characters":[{"name":"","note":"","prompt":""}],"scenes":[{"name":"","note":"","prompt":""}],"props":[{"name":"","note":"","prompt":""}]},"shots":[{"title":"","action":"","camera":"","duration":3,"speaker":"","dialogue":"","prompt":""}]}。要求：保留剧本原有角色名和逐字台词；旁白仅在原文确实是叙述时使用；角色、场景、关键道具不得留空；分镜总时长约 ${episode.targetDuration} 秒；视觉风格 ${episode.visualStyle}；语言 ${episode.language}。`;
      const data = await proxyRequest("chat", { model: cfg.model, thinking: { type: "disabled" }, temperature: .1, response_format: { type: "json_object" }, messages: [{ role: "system", content: "你是短剧制片编辑。严格区分角色台词、系统播报和旁白，只输出 JSON。" }, { role: "user", content: `${schema}\n剧本：\n${episode.script}` }] });
      const parsed = parseJsonText(data?.choices?.[0]?.message?.content);
      if (!Array.isArray(parsed.beats) || !parsed.beats.length) throw new Error("模型未返回有效 beats 数组");
      episode.beats = parsed.beats.map(item => ({ id: uid("beat"), title: String(item.title || "未命名节拍"), text: String(item.text || ""), location: String(item.location || "待确认"), mood: String(item.mood || "待确认") }));
      const assets = parsed.assets || {};
      const previousAssets=episode.assets;const previousShots=episode.shots;
      episode.assets = {
        characters: (Array.isArray(assets.characters) ? assets.characters : []).map(item=>mergeParsedAsset("characters",item,previousAssets)),
        scenes: (Array.isArray(assets.scenes) ? assets.scenes : []).map(item=>mergeParsedAsset("scenes",item,previousAssets)),
        props: (Array.isArray(assets.props) ? assets.props : []).map(item=>mergeParsedAsset("props",item,previousAssets)),
      };
      episode.shots = (Array.isArray(parsed.shots) ? parsed.shots : []).map(item => { const title=String(item.title||"未命名镜头");const old=previousShots.find(value=>value.title===title);return autoBindShot(episode, {
        ...(old||{}),id:old?.id||uid("shot"), title, action: String(item.action || ""), camera: String(item.camera || "中景"),
        duration: clamp(Number(item.duration) || 3, 1, 30), speaker: String(item.speaker || ""), dialogue: String(item.dialogue || ""),
        prompt: old?.prompt||String(item.prompt || `${item.action || ""}, cinematic shot`), status: old?.status||"draft", selected: false, mediaUrl: old?.mediaUrl||"",
      });});
      episode.scriptCheckpoint = { stage: "completed", updatedAt: now(), error: "", scriptHash: String(episode.script.length) };
      addLog(`对话模型真实解析完成：${episode.beats.length} 个节拍、${episode.assets.characters.length} 个角色、${episode.shots.length} 个含台词分镜。`);
      const parsedSeconds=episode.shots.reduce((sum,shot)=>sum+Number(shot.duration||0),0);const targetSeconds=Math.max(10,Number(episode.targetDuration)||60);if(parsedSeconds>targetSeconds*1.2)addLog(`解析结果预计 ${parsedSeconds} 秒，超过目标 ${targetSeconds} 秒；建议先点“AI 改写”压缩剧本，再重新解析，避免超额生成。`);
      persist(); render(); showToast("AI 解析完成。");
    } catch (error) { episode.scriptCheckpoint = { stage: "failed", updatedAt: now(), error: error.message, scriptHash: String(episode.script.length) }; addLog(`对话模型解析失败，检查点已保留：${error.message}`); persist(); render(); showToast(error.message, true); }
  };

  const buildShots = () => {
    const episode = getEpisode();
    if (!episode.beats.length) return showToast("请先完成剧本拆解。", true);
    episode.shots = episode.beats.flatMap((beat, index) => {
      const base = { status: "draft", selected: false, duration: 6, mediaUrl: "", speaker: "", dialogue: "", characterIds: [], sceneId: "", propIds: [], firstFrameUrl: "", lastFrameUrl: "", chainSourceShotId: "", qc: null };
      return [
        autoBindShot(episode, { ...base, id: uid("shot"), title: `${beat.title} · 建立`, action: beat.text, camera: index % 2 ? "中景推进" : "全景建立", prompt: `${beat.location}, ${beat.mood}, ${beat.text}, cinematic composition, consistent characters` }),
        ...(beat.text.length > 42 ? [autoBindShot(episode, { ...base, id: uid("shot"), title: `${beat.title} · 强调`, action: beat.text.slice(0, 48), camera: "近景反应", duration: 4, prompt: `${beat.mood}, close-up reaction, ${beat.text}, cinematic lighting` })] : []),
      ];
    });
    addLog(`由 ${episode.beats.length} 个节拍建立 ${episode.shots.length} 个原创分镜。`);
    persist(); render(); showToast("分镜表已建立。");
  };

  const seedAssets = () => {
    const episode = getEpisode();
    if (!episode.beats.length) return showToast("请先完成剧情节拍。", true);
    if (!episode.assets.scenes.length) {
      const locations = [...new Set(episode.beats.map(item => item.location).filter(item => item && item !== "待确认"))];
      episode.assets.scenes = locations.map(name => ({ id: uid("asset"), name, note: "由剧情节拍建立，待补充空间与光线设定", prompt: `${name}, cinematic environment, production design, coherent lighting` }));
    }
    if (!episode.assets.props.length) episode.assets.props.push({ id: uid("asset"), name: "关键叙事物", note: "请按剧情修改名称与特征", prompt: "story-critical prop, cinematic product detail, consistent design" });
    addLog("由剧情节拍建立基础场景与道具资产；未调用外部模型。"); persist(); render(); showToast("基础资产已建立。");
  };

  const addAsset = (type) => {
    const [label] = assetLabels[type] || assetLabels.characters;
    const name = window.prompt(`${label}名称`);
    if (!name?.trim()) return;
    const note = window.prompt(`${label}说明`, "外观、身份、材质或氛围") || "";
    const promptText = window.prompt("生成提示词", `${name}, ${note}, cinematic, consistent design`) || "";
    const asset = { id: uid("asset"), name: name.trim(), note: note.trim(), prompt: promptText.trim(), negativePrompt: QUALITY_NEGATIVE, promptVersions: [], promptStatus: promptText.trim() ? "ready" : "missing", version: 1, libraryId: "", referenceImage: "", referenceStatus: "missing", referenceOutdated: false };
    if(type==="characters"){
      asset.faceRequired=!/(系统|光球|界面|AI\b|robot|orb|holographic)/i.test(`${asset.name} ${asset.note} ${asset.prompt}`);
      asset.turnaround=emptyTurnaround();
      asset.variations=[];
    }
    getEpisode().assets[type].push(asset);
    addLog(`新增${label}资产：${name.trim()}。`); persist(); render();
  };

  const addShot = () => {
    const title = window.prompt("镜头标题", "新镜头"); if (!title?.trim()) return;
    const action = window.prompt("动作描述", "") || "";
    getEpisode().shots.push(autoBindShot(getEpisode(), { id: uid("shot"), title: title.trim(), action, camera: "中景", duration: 6, prompt: `${action}, cinematic shot`, status: "draft", selected: false, mediaUrl: "", speaker: "", dialogue: "" }));
    addLog(`新增空白镜头：${title.trim()}。`); persist(); render();
  };

  const editShot = (id) => {
    const shot = getEpisode().shots.find(item => item.id === id); if (!shot) return;
    shot.title = window.prompt("镜头标题", shot.title)?.trim() || shot.title;
    shot.action = window.prompt("动作描述", shot.action)?.trim() || shot.action;
    shot.camera = window.prompt("机位/运动", shot.camera)?.trim() || shot.camera;
    shot.speaker = window.prompt("台词角色（无台词可留空）", shot.speaker || "")?.trim() || "";
    shot.dialogue = window.prompt("角色台词（不要改写成旁白）", shot.dialogue || "")?.trim() || "";
    const nextPrompt = window.prompt("生成提示词", shot.prompt);
    if (nextPrompt !== null && nextPrompt.trim() !== shot.prompt) { archivePrompt(shot, "manual-edit", "镜头编辑前版本"); shot.prompt = nextPrompt.trim(); }
    const negative = window.prompt("负面提示词", shot.negativePrompt || QUALITY_NEGATIVE); if (negative !== null) shot.negativePrompt = negative.trim();
    // 取消（null）必须保持原时长：以前 Number(null) 得到 0，被 clamp 成 1 秒，等于悄悄改数据。
    const rawDuration = window.prompt("时长（秒）", String(shot.duration));
    if (rawDuration !== null && String(rawDuration).trim() !== "") {
      const duration = Number(rawDuration);
      if (Number.isFinite(duration)) shot.duration = clamp(duration, 1, 60);
      else showToast("时长需要填写数字，已保留原值。", true);
    }
    persist(); render();
  };

  const addVariation = id => {
    const asset = findAsset(id); if (!asset) return;
    const name = window.prompt("造型名称", "日常造型"); if (!name?.trim()) return;
    const visualPrompt = window.prompt("造型描述", `保持${asset.name}同一张脸、年龄、发型与体型，仅更换服装造型`) || "";
    asset.variations ||= []; asset.variations.push({ id: uid("variation"), name: name.trim(), visualPrompt: visualPrompt.trim(), negativePrompt: QUALITY_NEGATIVE, promptVersions: [], referenceImage: "", status: "pending" });
    asset.version = (Number(asset.version) || 1) + 1; persist(); render();
  };
  const generateVariation = async (assetId, variationId) => {
    const asset = findAsset(assetId); const variation = asset?.variations?.find(item => item.id === variationId); if (!asset || !variation) return;
    if (!asset.referenceImage) return showToast("请先锁定角色定妆图。", true);
    variation.status = "generating"; persist(); render();
    try {
      const cfg = state.settings.providers.image;
      const prompt = `${variation.visualPrompt}。身份必须与输入定妆图完全一致，只允许服装、配饰和状态变化；单人全身或半身角色设定图，中性背景，无文字无水印。${variation.negativePrompt || QUALITY_NEGATIVE}`;
      const data = await proxyRequest("image", await imagePayloadOf(prompt, { refs: [asset.referenceImage], square: true }));
      const { source, isData } = imageResult(data); if (!source) throw new Error("图片接口未返回造型图");
      variation.referenceImage = await persistMedia(isData ? { dataUrl: source, name: `wardrobe-${asset.name}-${variation.name}` } : { sourceUrl: source, name: `wardrobe-${asset.name}-${variation.name}` });
      variation.status = "completed"; asset.version = (Number(asset.version) || 1) + 1; addLog(`角色「${asset.name}」造型「${variation.name}」已生成并锁定。`); showToast("衣橱造型已生成。");
    } catch (error) { variation.status = "failed"; addLog(`造型「${variation.name}」生成失败：${error.message}`); showToast(error.message, true); }
    persist(); render();
  };
  const deleteVariation = (assetId, variationId) => {
    const asset = findAsset(assetId); if (!asset) return; asset.variations = (asset.variations || []).filter(item => item.id !== variationId);
    getEpisode().shots.forEach(shot => { if (shot.characterVariations?.[assetId] === variationId) delete shot.characterVariations[assetId]; }); persist(); render();
  };
  const saveArtDirection = () => {
    const art = getProject().artDirection || emptyArtDirection();
    art.palette = document.querySelector("#art-palette")?.value.trim() || ""; art.lighting = document.querySelector("#art-lighting")?.value.trim() || "";
    art.texture = document.querySelector("#art-texture")?.value.trim() || ""; art.characterRules = document.querySelector("#art-character-rules")?.value.trim() || ""; art.anchors = document.querySelector("#art-anchors")?.value.trim() || "";
    getProject().artDirection = art; addLog("全局美术指导已保存，后续提示词将自动注入。"); persist(); render(); showToast("美术指导已保存。");
  };
  const generateArtDirectionSuggestion = () => {
    const project = getProject(); const script = getEpisode().script; const dark = /(悬疑|惊悚|夜|雨|危机|复仇)/.test(`${project.genre} ${script}`);
    project.artDirection = { palette: dark ? "低饱和青灰主色，暗红作危险点缀" : "中等饱和暖中性色，重点色统一", lighting: dark ? "低调电影光，轮廓光与实景动机光" : "柔和电影光，肤色稳定", texture: "电影级写实材质，克制锐化，避免塑料皮肤", characterRules: "同一角色锁定脸型、五官比例、年龄、发型、体型与标志性配饰；服装变化必须来自衣橱版本", moodKeywords: dark ? ["压迫","克制","悬念"] : ["自然","统一","叙事清晰"], anchors: `项目《${project.name}》统一视觉：${project.format} 构图，电影感，人物身份稳定，场景材质与色温连续。` };
    persist(); render(); showToast("已由剧本关键词生成本地美术建议，未调用模型。");
  };

  const queueSelected = () => {
    const shots = getEpisode().shots.filter(item => item.selected);
    if (!shots.length) return showToast("请先勾选镜头。", true);
    shots.forEach(item => { if (item.status === "draft") item.status = "queued"; });
    addLog(`${shots.length} 个镜头加入生成队列；尚未提交外部请求。`); persist(); render(); showToast("已加入队列，没有模拟生成。");
  };

  const fileToDataUrl = file => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("文件读取失败"));
    reader.readAsDataURL(file);
  });

  const mediaToDataUrl = async source => {
    if (String(source).startsWith("data:")) return source;
    const response = await fetch(source);
    if (!response.ok) throw new Error("参考图读取失败");
    return fileToDataUrl(await response.blob());
  };

  // 智谱要求首帧 ≤5MB 且只认 png/jpeg：过大或 PNG 体积失控时压成 JPEG 再送。
  const shrinkImageDataUrl = async (dataUrl, limitBytes = 4.6 * 1024 * 1024) => {
    const bytes = Math.floor(String(dataUrl).length * 0.75);
    if (bytes <= limitBytes * 0.6) return dataUrl;
    try {
      const image = new Image();
      image.src = dataUrl;
      await image.decode();
      const scale = Math.min(1, 1920 / Math.max(image.width, image.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/jpeg", 0.88);
    } catch { return dataUrl; }
  };

  const persistMedia = async ({ dataUrl = "", sourceUrl = "", name = "media" }) => {
    const response = await fetch("/api/local-media", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataUrl, sourceUrl, name }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || data.error || "媒体保存失败");
    return data.url;
  };

  const findAsset = id => Object.values(getEpisode().assets).flat().find(item => item.id === id);
  const isCharacterAsset = asset => getEpisode().assets.characters.some(item => item.id === asset.id);

  const invalidateAssetDependents = asset => {
    if (isCharacterAsset(asset) && asset.faceRequired !== false) asset.turnaround = emptyTurnaround();
    getEpisode().shots.filter(shot => shot.characterIds.includes(asset.id)).forEach(shot => {
      shot.qc = null;
      if (["completed", "qc_failed"].includes(shot.status)) shot.status = "draft";
    });
  };

  const generateAssetReference = async id => {
    const asset = findAsset(id);
    if (!asset) return;
    const type = assetTypeFor(id);
    asset.referenceStatus = "generating"; persist(); render();
    showToast(`正在生成「${asset.name}」参考图…`);
    try {
      const cfg = state.settings.providers.image;
      const referenceRule = type === "characters"
        ? (asset.faceRequired !== false
          ? "single Chinese character identity reference sheet, exactly one person, front-facing medium portrait, neutral expression, unobstructed face, consistent hair and clothing, plain cinematic background"
          : "single clean non-human entity reference sheet, preserve its exact silhouette, colors and interface design, no people")
        : type === "scenes"
          // 场景参考图必须是“空镜”。旧规则只写 no prominent people，模型仍会把场景描述里的
          // 老太太/家人画进去；这些人物随后会被首帧模型当成角色基准，造成换脸、年龄跳变。
          ? "empty architecture plate, clearly readable spatial layout, furniture, materials and lighting, wide establishing composition, absolutely zero people, no human figures, no silhouettes, no portraits, remove every person mentioned in the description"
          : "single prop design reference, isolated complete object, clearly readable shape, scale, materials and wear details, product composition, no hands, no people";
      const sceneGuard = type === "scenes" ? ", empty room, nobody inside, zero human figures, no faces, no body parts" : "";
      const prompt = `${asset.prompt || `${asset.name}, ${asset.note}`}, ${referenceRule}${sceneGuard}, no text, no letters, no watermark, no collage`;
      const data = await proxyRequest("image", await imagePayloadOf(prompt, { square: true }));
      const { source, isData } = imageResult(data);
      if (!source) throw new Error("图片接口未返回参考图");
      asset.referenceImage = await persistMedia(isData ? { dataUrl: source, name: `asset-${asset.name}` } : { sourceUrl: source, name: `asset-${asset.name}` });
      asset.referenceStatus = "ready";
      asset.referenceOutdated = false;
      asset.referencePromptVersion = asset.version || 1;
      invalidateAssetDependents(asset);
      addLog(`资产「${asset.name}」参考图已生成并锁定到本机。`);
      showToast("参考图已生成并锁定。");
    } catch (error) {
      asset.referenceStatus = "failed";
      addLog(`资产「${asset.name}」参考图生成失败：${error.message}`);
      showToast(error.message, true);
    }
    persist(); render();
  };

  const processTurnaround = async (asset, imageUrl) => {
    asset.turnaround ||= emptyTurnaround();
    asset.turnaround.imageUrl = imageUrl;
    asset.turnaround.status = "checking";
    persist(); render();
    const response = await fetch("/api/qc-turnaround", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mediaUrl: imageUrl, referenceUrl: asset.referenceImage || "", faceRequired: asset.faceRequired !== false }),
    });
    const qc = await response.json();
    if (!response.ok) throw new Error(qc.detail || qc.error || "九宫格质检失败");
    asset.turnaround.qc = qc;
    asset.turnaround.panelUrls = qc.panelUrls || [];
    asset.turnaround.status = qc.passed ? "completed" : "qc_failed";
    getEpisode().shots.filter(shot => shot.characterIds.includes(asset.id)).forEach(shot => {
      shot.qc = null;
      if (["completed", "qc_failed"].includes(shot.status)) shot.status = "draft";
    });
    addLog(`角色「${asset.name}」九宫格转面图${qc.passed ? "已切分为 9 个视角并通过质检" : "质检未通过，已禁止用于视频生成"}。`);
    persist(); render();
    return qc;
  };

  // 九宫格图已经生成、但切分/质检那一步没跑完的角色（status=failed、panelUrls 空）：
  // 启动时用已有图片补做切分與质检，不重新出图、不消耗额度。
  let turnaroundsHealing = false;
  const healTurnarounds = async () => {
    if (turnaroundsHealing) return;
    const targets = [];
    for (const project of state.projects || []) {
      for (const episode of project.episodes || []) {
        for (const character of (episode.assets?.characters) || []) {
          const turn = character.turnaround || {};
          if (turn.imageUrl && (turn.panelUrls || []).length !== 9) targets.push(character);
        }
      }
    }
    if (!targets.length) return;
    turnaroundsHealing = true;
    let fixed = 0;
    try {
      for (const character of targets) {
        try {
          const response = await fetch("/api/qc-turnaround", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mediaUrl: character.turnaround.imageUrl, referenceUrl: character.referenceImage || "", faceRequired: character.faceRequired !== false }),
          });
          const qc = await response.json();
          if (!response.ok) throw new Error(qc.detail || qc.error || "九宫格质检失败");
          character.turnaround.qc = qc;
          character.turnaround.panelUrls = qc.panelUrls || [];
          character.turnaround.status = qc.passed ? "completed" : "qc_failed";
          if (qc.passed) fixed += 1;
          addLog(`角色「${character.name}」九宫格图已存在，自动补做切分与质检（${qc.passed ? "通过" : "未通过"}）。`);
        } catch (error) {
          addLog(`角色「${character.name}」九宫格自动补切分失败：${error.message}`);
        }
      }
      persist(); render();
      if (fixed) showToast(`已自动补做 ${fixed} 个角色的九宫格切分与质检，现在可以正常绑定。`);
    } finally { turnaroundsHealing = false; }
  };
  const reprocessTurnaround = async id => {
    const asset = findAsset(id);
    if (!asset?.turnaround?.imageUrl) return showToast("没有可重新处理的九宫格。", true);
    asset.turnaround.status = "checking"; persist(); render();
    try {
      const qc = await processTurnaround(asset, asset.turnaround.imageUrl);
      addLog(`角色「${asset.name}」九宫格已重新切分并质检。`);
      showToast(qc.passed ? "九宫格重新切分并通过质检。" : "九宫格已重新切分，但质检未通过。", !qc.passed);
    } catch (error) {
      asset.turnaround.status = "failed"; addLog(`角色「${asset.name}」九宫格重新处理失败：${error.message}`);
      persist(); render(); showToast(error.message, true);
    }
  };

  const turnaroundPrompt = asset => `以输入定妆图中的同一角色为唯一身份基准，生成一张正方形 3×3 九宫格角色转面设定图。九格从左到右、从上到下依次为：正面全身、正面半身、正面面部特写、左侧全身、右侧全身、四分之三侧面半身、背面全身、仰视半身、俯视半身。九格必须是同一张脸、同一发型、同一年龄、同一体型、同一套服装和配饰，只允许视角与景别变化。中性纯色背景，均匀棚拍光，细分隔线，不出现文字、标签、水印、额外人物或拼贴素材。角色设定：${asset.prompt || asset.note || asset.name}。`;

  const generateTurnaround = async id => {
    const asset = findAsset(id);
    if (!asset) return;
    if (!asset.referenceImage) return showToast("请先上传或生成角色定妆图。", true);
    asset.turnaround = { ...emptyTurnaround(), status: "generating" };
    persist(); render(); showToast(`正在为「${asset.name}」生成 3×3 九宫格…`);
    try {
      const cfg = state.settings.providers.image;
      const payload = await imagePayloadOf(turnaroundPrompt(asset), { refs: [asset.referenceImage], square: true });
      // 九宫格必须是正方形。万相传 "2K" 时会跟着参考图的竖幅比例走，
      // 实测返回 1535×2730，切不出 3×3，质检直接 threeByLayout 失败。
      // 显式指定 2048×2048 才能保证方形画布。
      if (cfg.vendor === "dashscope") payload.parameters.size = "2048*2048";
      else if (cfg.vendor !== "zhipu") { payload.size = "2K"; payload.response_format = "url"; }
      const data = await proxyRequest("image", payload);
      const { source, isData } = imageResult(data);
      if (!source) throw new Error("图片接口未返回九宫格图片");
      const localUrl = await persistMedia(isData ? { dataUrl: source, name: `turnaround-${asset.name}` } : { sourceUrl: source, name: `turnaround-${asset.name}` });
      const qc = await processTurnaround(asset, localUrl);
      showToast(qc.passed ? "九宫格已生成、切分并通过质检。" : "九宫格生成完成，但质检未通过。", !qc.passed);
    } catch (error) {
      asset.turnaround ||= emptyTurnaround(); asset.turnaround.status = "failed";
      // 图已经存下来了、只是切分/质检这一步挂了：别再让用户以为要重新出图（会白花额度）。
      const imageKept = Boolean(asset.turnaround.imageUrl);
      addLog(`角色「${asset.name}」九宫格${imageKept ? "图已生成，但切分/质检失败" : "生成失败"}：${error.message}`);
      persist(); render();
      showToast(imageKept ? `九宫格图已生成并保存，但切分/质检失败（${error.message}）。到「角色与资产」点「补做切分/质检」即可，不用重新出图。` : error.message, true);
    }
  };

  const shotReferenceAssets = shot => shot.characterIds.map(findAsset).filter(Boolean);

  // 九宫格面板必须“先按景别选全身/半身，再按角度选方位”。
  // 旧逻辑先匹配“鸟瞰→panels[8]”，而 8 号是俯拍半身/近景，
  // 大远景拿到近景参考图后会把人放大、把环境吃掉，是角色漂移和穿帮的主因之一。
  const turnaroundPanelEntryForShot = (asset, shot) => {
    const panels = asset.turnaround?.panelUrls || [];
    if (panels.length !== 9) return null;
    const context = `${shot.camera || ""} ${shot.shotSize || ""} ${shot.action || ""}`;
    const wide = /(大远景|大全景|远景|全景|建立镜头|空镜|航拍)/.test(context);
    const close = /(大特写|特写|近景|半身特写)/.test(context);
    const back = /(背面|背影|斜后|后方)/.test(context);
    const left = /左侧/.test(context);
    const right = /右侧/.test(context);
    const side = /(侧面|侧拍|侧脸)/.test(context);
    const low = /(仰视|仰拍|低机位)/.test(context);
    const high = /(俯视|俯拍|高机位|鸟瞰)/.test(context);
    if (wide) {
      // 景别优先：远景/全景必须用全身板，保证身高、服装、鞋履和比例不被裁掉。
      if (back) return { url: panels[6], index: 6, label: "背面全身" };
      if (left) return { url: panels[3], index: 3, label: "左侧全身" };
      if (right) return { url: panels[4], index: 4, label: "右侧全身" };
      return { url: panels[0], index: 0, label: "正面全身" };
    }
    if (back) return { url: panels[6], index: 6, label: "背面全身" };
    if (left) return { url: panels[3], index: 3, label: "左侧全身" };
    if (right) return { url: panels[4], index: 4, label: "右侧全身" };
    if (side) return { url: panels[5], index: 5, label: "侧面半身" };
    if (low) return { url: panels[7], index: 7, label: "仰拍半身" };
    if (high) return { url: panels[8], index: 8, label: "俯拍半身" };
    if (close) return { url: panels[2], index: 2, label: "面部特写" };
    return { url: panels[1], index: 1, label: "正面半身" };
  };
  const turnaroundPanelForShot = (asset, shot) => turnaroundPanelEntryForShot(asset, shot)?.url || "";

  // 参考图不仅要“按顺序送进去”，还要在提示词里明确标注“第几张是谁/是什么”。
  // 旧版只送图不标号，多角色镜头里模型会把 A 的脸和 B 的衣服拼在一起，
  // 这是“角色变脸、服装串戏、同一个人出现两次”的直接原因。
  // limit>0 时按通道实际可提交的张数截断：提示词里的“输入参考图N”必须和真正发出去的
  // 图片数量一一对应，否则模型会按错位的编号把 A 的脸配到 B 的衣服上。
  const referencePlanForShot = (shot, limit = 0) => {
    const episode = getEpisode();
    const plan = [];
    const seen = new Set();
    const push = (url, label) => { if (url && !seen.has(url)) { seen.add(url); plan.push({ url, label }); } };
    const identity = [];
    const angle = [];
    shotReferenceAssets(shot).forEach(asset => {
      const variation = asset.variations?.find(item => item.id === shot.characterVariations?.[asset.id]);
      const url = variation?.referenceImage || asset.referenceImage;
      if (url) identity.push({ url, asset, variation });
      if (asset.faceRequired !== false) {
        const panel = turnaroundPanelEntryForShot(asset, shot);
        if (panel) angle.push({ panel, asset });
      }
    });
    identity.forEach(({ url, asset, variation }) => push(url,
      `角色参考｜${asset.name}${variation ? `·造型“${variation.name}”` : ""}定妆照：本镜头唯一身份基准。` +
      `年龄、性别、脸型、五官、发长/发色/发型、肤色、身高体型、上衣/下装/鞋、配饰全部锁定，禁止换脸或改变年龄。`));
    angle.forEach(({ panel, asset }) => push(panel.url,
      `角色参考｜${asset.name}九宫格·${panel.label}（第${panel.index + 1}格）：只校正身体比例、朝向与姿态；脸、发型和服装必须以定妆照为准，不得替换。`));
    const scene = episode.assets.scenes.find(item => item.id === shot.sceneId);
    push(scene?.referenceImage, `场景空镜｜${scene?.name || "场景"}：只取空间结构、家具、材质、色调、透视和光线。参考图里若出现任何人物，一律忽略，禁止复制其中人物的脸、发型、服装、人数或姿态。`);
    (shot.propIds || []).forEach(id => { const prop = episode.assets.props.find(item => item.id === id); push(prop?.referenceImage, `道具参考｜${prop?.name || "道具"}：只锁定外观、材质与颜色，不增加额外道具。`); });
    return limit > 0 ? plan.slice(0, limit) : plan;
  };
  const videoReferenceUrls = shot => referencePlanForShot(shot).map(item => item.url);

  const buildProductionPrompt = (shot, { forceReferences = false, includeDialogue = true, forVideo = false, referenceLimit = 0 } = {}) => {
    const episode = getEpisode();
    const characters = shotReferenceAssets(shot);
    const scene = episode.assets.scenes.find(item => item.id === shot.sceneId);
    const props = (shot.propIds||[]).map(id=>episode.assets.props.find(item=>item.id===id)).filter(Boolean);
    const usesReferences = forceReferences || (shot.videoInputMode || "text") !== "text";
    const identity = characters.map(item => { const variation = item.variations?.find(value => value.id === shot.characterVariations?.[item.id]); const sourceNote = usesReferences ? (item.faceRequired === false ? "（非人形参考图锚点）" : forVideo ? "（以输入首帧为唯一身份基准：脸、年龄、发型、服装全部继承首帧，禁止换脸或改年龄）" : "（唯一身份基准：定妆照+九宫格，禁止换脸、改年龄、改服装）") : "（纯文本模式，仅使用这段外观描述）"; return `${item.name}：${item.note || item.prompt}${variation ? `；本镜使用造型“${variation.name}”：${variation.visualPrompt}` : ""}${sourceNote}`; }).join("；");
    // 图生视频阶段只喂首帧，不会传参考图；此时禁止在提示词里声称“输入参考图”，
    // 否则模型会去找不存在的图，反而丢掉首帧里的身份。
    const referencePlan = usesReferences && !forVideo ? referencePlanForShot(shot, referenceLimit) : [];
    const referenceMap = referencePlan.length
      ? referencePlan.map((item, index) => `输入参考图${index + 1}＝${item.label}`).join("\n")
      : "";
    const castRule = characters.length
      ? `本镜绑定角色共 ${characters.length} 人：${characters.map(item => item.name).join("、")}。画面中每个角色只出现一次，禁止双胞胎、分身、重复人物或额外的主要角色；群演只能作为虚焦背景，不得拥有与主角相同的脸或服装。`
      : "本镜头无绑定角色，画面中不得出现与故事角色相似的主要人物。";
    const art = getProject().artDirection || emptyArtDirection();
    const dialogue = includeDialogue
      ? (shot.dialogue
        ? `对白规则：仅由角色“${shot.speaker || characters[0]?.name || "画面角色"}”当面说出以下原句，不得改写为旁白，不得添加解说或额外台词：“${shot.dialogue}”。口型与说话动作自然同步。`
        : "本镜头无台词，不要添加旁白或解说。")
      : (shot.dialogue
        ? `画面表演：角色“${shot.speaker || characters[0]?.name || "画面角色"}”正在自然说话，但定帧图中禁止出现台词、字幕、引号、气泡或任何可读文字。`
        : "定帧图中禁止出现字幕、标题、气泡或任何可读文字。");
    return [
      shot.prompt, `镜头动作：${shot.action}`, `机位：${shot.camera}`,
      referenceMap,
      identity ? `${usesReferences ? "锁定" : "文字定义"}角色身份与外观：${identity}` : (shot.speaker === "旁白" ? "旁白镜头，按镜头动作中的人物与环境呈现" : "无人物镜头"),
      castRule,
      scene ? `${usesReferences ? "锁定" : "文字定义"}场景：${scene.name}，${scene.note || scene.prompt}${usesReferences ? "；场景参考图只作空镜使用，图中出现的人物一律忽略。" : ""}` : (usesReferences ? "延续输入首帧的场景与光线" : "按镜头提示词中的场景与光线生成"),
      props.length ? `${usesReferences ? "锁定" : "文字定义"}关键道具：${props.map(item=>`${item.name}（${item.note||item.prompt}）`).join("；")}` : "",
      `全局美术指导：色彩=${art.palette}；光影=${art.lighting}；质感=${art.texture}；角色规则=${art.characterRules}；一致性锚点=${art.anchors}`,
      usesReferences ? "身份优先级：脸和服装以定妆照为唯一基准；九宫格只校正比例与朝向；场景图只校正空间与光线。三者冲突时，先保住角色脸、年龄和服装，再保构图。" : "当前为纯文生视频，不得声称读取参考图；依靠上述角色、场景、道具文字描述保持连续性。",
      usesReferences ? (shot.chainSourceShotId ? "这是连续镜头，严格继承输入首帧中的人物、服装、构图关系、场景和光线，并用九宫格对应角度校正身体结构。" : "严格继承定妆图中的身份，并优先匹配九宫格中与当前机位相同的视角。") : "",
      dialogue, shot.negativePrompt || QUALITY_NEGATIVE,
    ].filter(Boolean).join("\n");
  };

  const rollbackShotPrompt = id => {
    const shot = getEpisode().shots.find(item => item.id === id); const history = shot?.promptVersions || []; if (!history.length) return showToast("没有可回滚的镜头提示词。", true);
    const latest = history.pop(); archivePrompt(shot, "rollback", "回滚前版本"); shot.prompt = latest.prompt; shot.qc = null; persist(); render(); showToast("镜头提示词已回滚。");
  };
  const generateShotFrame = async (id, frameType = "start") => {
    const shot = getEpisode().shots.find(item => item.id === id); if (!shot) return;
    try { validateShotBindings(shot, { purpose: "frame" }); } catch (error) { return showToast(error.message, true); }
    const label = frameType === "end" ? "尾帧" : "首帧"; shot.status = "generating"; persist(); render();
    const startedAt = Date.now(); const task = { id: uid("task"), kind: label, shotId: shot.id, shotTitle: shot.title, status: "submitted", at: now(), message: `${label}请求已提交` }; getEpisode().tasks.unshift(task);
    try {
      const cfg = state.settings.providers.image; const refs = [frameType === "end" ? shot.firstFrameUrl : "", ...videoReferenceUrls(shot)].filter(Boolean);
      task.model = cfg.model;
      const promptText = `${buildProductionPrompt(shot, { forceReferences: true, includeDialogue: false })}\n${label}定帧图，单一画面，不要分镜网格，不得渲染任何文字。${frameType === "end" ? "呈现动作完成后的稳定落点，和首帧保持身份、服装、场景与光线连续。" : "作为镜头动作开始前的稳定构图。"}`;
      const payload = await imagePayloadOf(promptText, { refs });
      task.prompt = promptText;
      const data = await withRateLimitRetry(`镜头「${shot.title}」${label}`, () => proxyRequest("image", payload), (round, seconds, total) => {
        task.status = "queued"; task.queued = true; task.queueAttempt = round; task.queueTotal = total; task.queueNextAt = Date.now() + seconds * 1000;
        task.message = `平台限流，后台排队第 ${round}/${total} 次`; shot.status = "queued"; persist(); render();
      }); const { source, isData } = imageResult(data); if (!source) throw new Error("图片接口未返回关键帧");
      const local = await persistMedia(isData ? { dataUrl: source, name: `${frameType}-frame-${shot.id}` } : { sourceUrl: source, name: `${frameType}-frame-${shot.id}` });
      if (frameType === "end") shot.lastFrameUrl = local; else { shot.firstFrameUrl = local; shot.chainSourceShotId = ""; shot.firstFrameOrigin = "generated"; } shot.status = "queued"; shot.qc = null; task.status = "completed"; task.queued = false; task.queueNextAt = 0; task.durationMs = Date.now()-startedAt; task.message = `${label}已生成并锁定`; addLog(`镜头「${shot.title}」${label}真实生成完成。`, { model: cfg.model, durationMs: task.durationMs, prompt: payload.prompt });
    } catch (error) {
      if (error.queueExhausted) { shot.status = "queued"; task.status = "queued"; task.queued = true; task.queueNextAt = 0; task.message = `${label}免费通道持续拥挤，已保留待重试`; }
      else { shot.status = "failed"; task.status = "failed"; task.queued = false; task.message = error.message; }
      addLog(`镜头「${shot.title}」${label}生成未完成：${error.message}`); showToast(error.message, true);
    }
    persist(); render();
  };
  const copyPreviousFrame = id => {
    const episode = getEpisode(); const index = episode.shots.findIndex(item => item.id === id); const shot = episode.shots[index]; const previous = episode.shots[index-1];
    if (!shot || !previous?.lastFrameUrl) return showToast("上一镜还没有可承接的尾帧。", true);
    if (!assignChainSource(shot, previous)) return showToast("上一镜与本镜没有共同角色，已阻止错误续帧；请用角色定妆首帧或选择其他同角色镜头。", true);
    persist(); render(); showToast("已将上一镜同角色尾帧接入本镜首帧。");
  };
  const prepareShotGrid = id => {
    const shot = getEpisode().shots.find(item => item.id === id); if (!shot) return; const count = gridPanelCount(shot);
    const presets = [
      ["远景","平视","建立空间、人物位置和行动方向"],["全景","轻微俯拍","强化空间关系与调度"],["中景","平视","推进主要动作与角色关系"],
      ["近景","3/4侧面","捕捉角色反应和台词表演"],["特写","平视","强调关键表情或道具细节"],["中景","低机位","制造力量感或威胁"],
      ["全景","高机位","交代后续行动路线"],["近景","侧拍","提供剪辑反打与视线匹配"],["特写","斜侧角","落在动作或情绪终点"],
    ];
    shot.storyboardGrid = { ...emptyStoryboardGrid(), status: "panels_ready", panelCount: count, panels: presets.slice(0,count).map(([shotSize,cameraAngle,description],index)=>({ index, shotSize, cameraAngle, description: `${description}；${shot.action}` })) };
    persist(); render(); showToast(`${count} 格镜头规划已建立，未调用模型。`);
  };
  const storyboardGridPrompt = shot => {
    const grid = shot.storyboardGrid; const rows = grid.panelCount === 4 ? 2 : grid.panelCount === 6 ? 2 : 3; const cols = grid.panelCount === 4 ? 2 : 3;
    return `${buildProductionPrompt(shot, { forceReferences: true, includeDialogue: false })}\n生成一张 ${cols}列×${rows}行、共${grid.panelCount}格的电影分镜构图探索图。所有格子必须是同一场景、同一人物身份和同一套服装，只改变景别与机位。格子依次：${grid.panels.map((item,index)=>`${index+1}.${item.shotSize}/${item.cameraAngle}/${item.description}`).join("；")}。清晰细分隔线，无文字、编号、水印或额外人物。`;
  };
  const processShotGrid = async (shot, imageUrl) => {
    const response = await fetch("/api/split-grid", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ imageUrl, panelCount: gridPanelCount(shot), name: `storyboard-${shot.id}` }) });
    const data = await response.json(); if (!response.ok) throw new Error(data.detail || data.error || "分镜网格切分失败");
    shot.storyboardGrid.imageUrl = data.imageUrl || imageUrl; shot.storyboardGrid.panelUrls = data.panelUrls || []; shot.storyboardGrid.status = "completed"; persist(); return data;
  };
  const generateShotGrid = async id => {
    const shot = getEpisode().shots.find(item => item.id === id); if (!shot?.storyboardGrid?.panels?.length) return showToast("请先规划分镜网格。", true);
    try { validateShotBindings(shot, { purpose: "frame" }); } catch (error) { return showToast(error.message, true); }
    shot.storyboardGrid.status = "generating"; persist(); render();
    try {
      const cfg = state.settings.providers.image; const refs = videoReferenceUrls(shot);
      const payload = await imagePayloadOf(storyboardGridPrompt(shot), { refs });
      if (cfg.vendor === "dashscope") payload.parameters.size = "2K"; else if (cfg.vendor !== "zhipu") payload.size = "2K";
      const data = await proxyRequest("image", payload); const { source, isData } = imageResult(data); if (!source) throw new Error("图片接口未返回分镜网格");
      const local = await persistMedia(isData ? { dataUrl: source, name: `storyboard-grid-${shot.id}` } : { sourceUrl: source, name: `storyboard-grid-${shot.id}` }); await processShotGrid(shot, local); addLog(`镜头「${shot.title}」${gridPanelCount(shot)}格分镜图已生成并切分。`); showToast("分镜网格已生成，可选择单格作为首帧。");
    } catch(error){ shot.storyboardGrid.status="failed"; addLog(`镜头「${shot.title}」分镜网格生成失败：${error.message}`); persist(); render(); showToast(error.message,true); }
  };
  const useGridPanel = (id, index) => {
    const shot=getEpisode().shots.find(item=>item.id===id); const url=shot?.storyboardGrid?.panelUrls?.[Number(index)]; if(!shot||!url)return;
    shot.firstFrameUrl=url; shot.chainSourceShotId=""; shot.firstFrameOrigin="grid"; shot.qc=null; persist(); render(); showToast(`已将网格第 ${Number(index)+1} 格设为首帧。`);
  };

  const validateShotBindings = (shot, { purpose = "video" } = {}) => {
    const mode = shot.videoInputMode || "text";
    const usesReferences = mode !== "text";
    const narratorOnly = /^(旁白|画外音|系统播报)$/u.test(String(shot.speaker || "").trim());
    const peopleMentioned = Boolean((shot.speaker && !narratorOnly) || (!narratorOnly && shot.dialogue) || shot.characterIds.length);
    if (peopleMentioned && !shot.characterIds.length) throw new Error(`镜头「${shot.title}」未绑定角色`);
    const assets = shotReferenceAssets(shot);
    const missing = assets.filter(item => !item.referenceImage);
    if (missing.length) throw new Error(`镜头「${shot.title}」缺少角色参考图：${missing.map(item => item.name).join("、")}`);
    const missingTurnarounds = assets.filter(item => item.faceRequired !== false && !turnaroundReady(item));
    if (missingTurnarounds.length) throw new Error(`镜头「${shot.title}」缺少已质检九宫格：${missingTurnarounds.map(item => item.name).join("、")}`);
    if (shot.chainSourceShotId) {
      const source = getEpisode().shots.find(item => item.id === shot.chainSourceShotId);
      if (!source || !canChainShotFrame(source, shot, { manual: Boolean(shot.chainSourceManual) })) throw new Error(`镜头「${shot.title}」的帧链来源不可用；请重新选择有尾帧的同角色或同场景镜头`);
    }
    if (purpose === "frame") return;
    if (peopleMentioned && !usesReferences) throw new Error(`镜头「${shot.title}」包含人物，纯文生视频无法锁定身份；请先生成定妆图和九宫格，再生成首帧并切换为“首帧图生视频”`);
    if (usesReferences && !shot.firstFrameUrl) throw new Error(`镜头「${shot.title}」尚未生成或选择首帧`);
    if (mode === "keyframes" && !shot.lastFrameUrl) throw new Error(`镜头「${shot.title}」的首尾帧模式缺少尾帧`);
  };

  const ensureDashscopeMedia = async (mediaUrl, model) => {
    if (String(mediaUrl).startsWith("oss://")) return mediaUrl;
    const response = await fetch("/api/dashscope-upload", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mediaUrl, model }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || data.error || "参考图上传失败");
    return data.url;
  };

  const sleep = delay => new Promise(resolve => setTimeout(resolve, delay));
  // 免费 Flash 模型是平台共享通道。所有入口（单镜、批量、一键生成）共用一条本地请求车道，
  // 防止用户连续点击后在浏览器里形成多批并发，把本来可以排到的请求也撞成 429。
  const providerLanes = new Map();
  const sharedFreeLaneConfig = (provider, config = {}, body = {}, options = {}) => {
    const model = String(body?.model || config.model || "");
    const zhipu = config.vendor === "zhipu" || /open\.bigmodel\.cn/i.test(String(config.baseUrl || "")) || /Zhipu/i.test(String(options.secretName || ""));
    const enabled = zhipu && /(?:^|[-_.])(flash|free)(?:$|[-_.])/i.test(model);
    return {
      enabled,
      key: enabled ? "zhipu-shared-free" : "",
      gapMs: provider === "video" ? 45000 : 15000,
      label: provider === "video" ? "免费视频通道" : "免费图片通道",
    };
  };
  const acquireProviderLane = async (provider, config, body, options) => {
    const rule = sharedFreeLaneConfig(provider, config, body, options);
    if (!rule.enabled) return () => {};
    const lane = providerLanes.get(rule.key) || { tail: Promise.resolve(), nextAt: 0 };
    providerLanes.set(rule.key, lane);
    const previous = lane.tail;
    let releaseTurn = () => {};
    lane.tail = new Promise(resolve => { releaseTurn = resolve; });
    await previous;
    const wait = Math.max(0, lane.nextAt - Date.now());
    if (wait > 1000) {
      const seconds = Math.ceil(wait / 1000);
      showToast(`${rule.label}正在串行保护，约 ${seconds} 秒后提交；请勿重复点击。`);
      await sleep(wait);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      lane.nextAt = Date.now() + rule.gapMs;
      releaseTurn();
    };
  };
  // 智谱免费模型（cogvideox-flash / cogview-3-flash）的 429 是平台级共享配额（错误码 1305「该模型当前访问量过大」），
  // 跟你一次提交几个镜头无关——单个视频同样会被拒。官方建议是「间隔 30–90 秒以上、不要高频重试」，
  // 因此这里不再用密集重试去硬撞，而是拉长到 30 秒起步、最长 10 分钟，累计约 21 分钟，全程后台排队不占用操作。
  const RATE_LIMIT_RETRY_DELAYS = [30000, 60000, 120000, 180000, 300000, 600000];
  const RATE_LIMIT_TOTAL_MINUTES = Math.round(RATE_LIMIT_RETRY_DELAYS.reduce((sum, value) => sum + value, 0) / 60000);
  const DEFERRED_QUEUE_DELAY_MS = 15 * 60 * 1000;
  const DEFERRED_QUEUE_MAX_CYCLES = 8;
  const isRateLimited = (error) => /429|访问量过大|限流|频率|too many requests|rate.?limit|1302|1303|1305/i.test(String(error?.message || ""));
  // onWait(第几次, 等待秒数, 总次数) 让调用方把「排队等待中」写进任务台账，避免看起来像卡死。
  const withRateLimitRetry = async (label, run, onWait) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await run();
      } catch (error) {
        if (!isRateLimited(error)) throw error;
        if (attempt >= RATE_LIMIT_RETRY_DELAYS.length) {
          const exhausted = new Error(`免费模型持续返回 1305「该模型当前访问量过大」（平台侧共享配额，与本机无关）。本轮已退避约 ${RATE_LIMIT_TOTAL_MINUTES} 分钟，将转入 15 分钟低频候车。`);
          exhausted.queueExhausted = true;
          throw exhausted;
        }
        const wait = RATE_LIMIT_RETRY_DELAYS[attempt];
        const seconds = Math.round(wait / 1000);
        const round = attempt + 1;
        addLog(`${label}触发免费通道限流（HTTP 429 / 1305），${seconds} 秒后自动重试（第 ${round}/${RATE_LIMIT_RETRY_DELAYS.length} 次）。`);
        try { onWait?.(round, seconds, RATE_LIMIT_RETRY_DELAYS.length); } catch {}
        showToast(`${label}被平台侧限流，已后台排队，约 ${seconds} 秒后自动重试（第 ${round}/${RATE_LIMIT_RETRY_DELAYS.length} 次），你可以继续做别的。`);
        await sleep(wait);
      }
    }
  };
  // 排队倒计时：只改文字节点，不整页重绘（否则 30 镜会不停跳回顶部）。
  let queueTicker = null;
  const startQueueTicker = () => {
    const tick = () => {
      document.querySelectorAll("[data-queue-countdown]").forEach(node => {
        const target = Number(node.dataset.queueCountdown || 0);
        const left = Math.round((target - Date.now()) / 1000);
        node.textContent = !target ? "" : left > 0 ? `约 ${left} 秒后自动重试` : "正在重试…";
      });
    };
    if (!queueTicker) queueTicker = setInterval(tick, 1000);
    tick();
  };
  const queryDashscopeTask = async (taskId, baseUrl) => {
    let transientFailures = 0;
    for (let attempt = 0; attempt < 180; attempt += 1) {
      let response;let data;
      try {
        response = await safeFetch("/api/model-task", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ taskId, baseUrl }),
        });
        data = await response.json();
        if (!response.ok) throw new Error(data.message || data.detail || (typeof data.error === "string" ? data.error : "") || "任务查询失败");
        transientFailures = 0;
      } catch (error) {
        if (/No such file or directory|本地服务没有响应|Failed to fetch|timed?\s*out|temporar|connection/i.test(String(error.message || error)) && transientFailures < 6) {
          transientFailures += 1;
          addLog(`任务 ${taskId} 本地轮询暂时失败，4 秒后续查（${transientFailures}/6）；不会重新提交。`);
          await sleep(4000);
          continue;
        }
        throw error;
      }
      const status = String(data?.output?.task_status || data?.task_status || data?.status || "").toUpperCase();
      if (["SUCCEEDED", "SUCCESS", "COMPLETED"].includes(status)) return data;
      if (["FAILED", "CANCELED", "CANCELLED", "UNKNOWN"].includes(status)) throw new Error(data?.output?.message || data?.message || `视频任务${status}`);
      await sleep(4000);
    }
    throw new Error("视频任务等待超过 12 分钟，请稍后在任务台账继续查询");
  };

  const queryAgentPlanTask = async (taskId, baseUrl) => {
    for (let attempt = 0; attempt < 450; attempt += 1) {
      const apiKey = secrets.video === SERVER_SECRET_SENTINEL ? "" : (secrets.video || "");
      const response = await safeFetch("/api/model-task", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId, baseUrl, apiKey }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || data.detail || data.error || "Agent Plan 任务查询失败");
      const status = String(data?.status || "").toLowerCase();
      if (status === "succeeded") return data;
      if (["failed", "cancelled", "canceled", "expired"].includes(status)) throw new Error(data?.error?.message || data?.message || `Agent Plan 视频任务 ${status}`);
      await sleep(4000);
    }
    throw new Error("Agent Plan 视频任务等待超过 30 分钟，请稍后在任务台账继续查询");
  };

  const runShotQc = async (shot, mediaUrl = shot.mediaUrl) => {
    if (!mediaUrl) throw new Error("镜头没有可质检的媒体");
    const humanAssets = shotReferenceAssets(shot).filter(item => item.faceRequired !== false);
    const references = [...new Set(videoReferenceUrls(shot))];
    // 免费 CogVideoX 不出音轨、且默认带官方水印：把这两件事声明给质检，
    // 否则「生成成功」会被判成 qc_failed（有台词就要求音轨、单行水印当硬字幕）。
    const videoCfg = state.settings.providers.video || {};
    const modelCapability = ProviderCapabilities?.model(videoCfg.vendor, videoCfg.model) || { audio: true, watermark: false };
    const response = await fetch("/api/qc-media", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mediaUrl, referenceUrls: references, expectedPeople: humanAssets.length, expectedDialogue: shot.dialogue || "", requireAudio: Boolean(shot.dialogue), transcribeDialogue: false, audioCapability: modelCapability.audio !== false, allowWatermark: modelCapability.watermark === true }),
    });
    const qc = await response.json();
    if (!response.ok) throw new Error(qc.detail || qc.error || "质检失败");
    shot.qc = qc;
    shot.mediaUrl = qc.cachedMediaUrl || mediaUrl;
    shot.firstFrameUrl = qc.firstFrameUrl || shot.firstFrameUrl;
    shot.lastFrameUrl = qc.lastFrameUrl || shot.lastFrameUrl;
    shot.status = qc.passed ? "completed" : "qc_failed";
    if (qc.passed && shot.lastFrameUrl) {
      const episode = getEpisode();
      const index = episode.shots.findIndex(item => item.id === shot.id);
      const next = episode.shots[index + 1];
      if (next && (!next.firstFrameUrl || next.firstFrameOrigin === "chain") && assignChainSource(next, shot)) {
        addLog(`镜头「${shot.title}」与下一镜「${next.title}」包含共同角色，末帧已安全接入。`);
      }
    }
    addLog(`镜头「${shot.title}」启发式质检${qc.passed ? "通过；仅在下一镜含同一角色时自动续帧" : "未通过，已阻止进入交付"}。`);
    persist();
    return qc;
  };

  const runSubmitImages = async (list, options = {}) => {
    const episode = getEpisode();
    const shots = list || episode.shots.filter(item => item.selected);
    if (!shots.length) return showToast("请先选择镜头。", true);
    currentView = "generation"; render();
    for (const shot of shots) {
      if (options.skipExisting && shot.firstFrameUrl) { addLog(`镜头「${shot.title}」已有首帧，一键生成跳过以免重复计费。`); continue; }
      try { validateShotBindings(shot, { purpose: "frame" }); }
      catch (error) { showToast(error.message, true); addLog(error.message); continue; }
      // 批量首帧最容易把角色打散：每个镜头都独立生一张首帧，帧链逻辑永远轮不到生效。
      // 上一镜已有尾帧且与本镜共享角色时，直接承接尾帧，先保脸和服装连续，再谈构图。
      const shotIndex = episode.shots.findIndex(item => item.id === shot.id);
      const previous = shotIndex > 0 ? episode.shots[shotIndex - 1] : null;
      if (previous?.lastFrameUrl && assignChainSource(shot, previous)) {
        shot.status = "queued";
        addLog(`镜头「${shot.title}」首帧直接承接上一镜尾帧（同角色续帧），未调用图片模型。`);
        persist(); render(); continue;
      }
      shot.status = "generating"; render();
      // 重载后继续排队时，替换同镜头尚未拿到结果的旧记录，避免任务台账无限堆叠。
      const previousDeferredCycles = Math.max(0, ...episode.tasks.filter(item => item.kind === "图片" && item.shotId === shot.id).map(item => Number(item.deferredCycles || 0)));
      episode.tasks = episode.tasks.filter(item => !(item.kind === "图片" && item.shotId === shot.id && ["submitted", "queued"].includes(item.status)));
      const task = { id: uid("task"), kind: "图片", shotId: shot.id, shotTitle: shot.title, status: "submitted", at: now(), deferredCycles: previousDeferredCycles, message: "请求已提交" };
      const startedAt = Date.now();
      episode.tasks.unshift(task);
      try {
        const cfg = state.settings.providers.image;
        const imageVendor = cfg.vendor === "zhipu" ? "zhipu" : (cfg.vendor === "dashscope" ? "dashscope" : "ark");
        const isZhipuImage = imageVendor === "zhipu";
        const payload = await imagePayloadFor(shot, imageVendor, cfg.model);
        task.model=cfg.model;task.prompt=payload.input ? payload.input.messages[0].content.find(part => part.text)?.text || "" : payload.prompt;
        let data;
        const requestImage = async () => {
          try {
            return await proxyRequest("image", payload);
          } catch (error) {
            // 火山账号欠费时若已配置智谱 Key，自动改走免费通道，别让整批首帧卡死。
            const fallbackToZhipu = !isZhipuImage && zhipuKeyAvailable() && /overdue|balance|欠费/i.test(error.message);
            if (!fallbackToZhipu) throw error;
            const fallbackPayload = await imagePayloadFor(shot, "zhipu", "cogview-3-flash");
            addLog("火山图片通道欠费，本镜自动改走智谱 CogView-3-Flash 免费通道。", { fallbackFrom: cfg.model, prompt: fallbackPayload.prompt });
            task.model = fallbackPayload.model;
            return await proxyRequest("image", fallbackPayload, { secretName: "imageZhipu" });
          }
        };
        data = await withRateLimitRetry(`镜头「${shot.title}」首帧`, requestImage, (round, seconds, total) => {
          task.status = "queued"; task.queued = true; task.queueAttempt = round; task.queueTotal = total; task.queueNextAt = Date.now() + seconds * 1000;
          task.message = `平台限流，后台排队第 ${round}/${total} 次`; shot.status = "queued"; persist(); render();
        });
        const { source: imageSource, isData: imageIsData } = imageResult(data);
        if (!imageSource) throw new Error("接口未返回图片地址");
        shot.firstFrameUrl = await persistMedia(imageIsData ? { dataUrl: imageSource, name: `first-frame-${shot.id}` } : { sourceUrl: imageSource, name: `first-frame-${shot.id}` });
        shot.chainSourceShotId = "";
        shot.firstFrameOrigin = "generated";
        shot.qc = null;
        shot.status = "queued"; task.status = "completed"; task.queued = false; task.queueNextAt = 0; task.durationMs=Date.now()-startedAt; task.message = "首帧已生成并锁定，等待视频生成";
        addLog(`镜头「${shot.title}」首帧真实生成完成。`, { model: cfg.model, durationMs: task.durationMs, prompt: payload.prompt });
      } catch (error) {
        if (error.queueExhausted) {
          shot.status = "queued"; task.status = "queued"; task.queued = true;
          task.deferredCycles = Number(task.deferredCycles || 0) + 1;
          if (task.deferredCycles <= DEFERRED_QUEUE_MAX_CYCLES) {
            task.queueNextAt = Date.now() + DEFERRED_QUEUE_DELAY_MS;
            task.message = `免费图片通道持续拥挤，约 15 分钟后自动续排（${task.deferredCycles}/${DEFERRED_QUEUE_MAX_CYCLES}）`;
            scheduleDeferredTask(task, shot);
          } else {
            task.queueNextAt = 0;
            task.message = "免费图片通道持续拥挤，低频候车已达 8 轮；已安全暂停，未提交、未重复计费";
          }
        }
        else {
          // 欠费 / 额度用尽 / Key 失效：镜头内容本身没问题，别标成失败。
          const envIssue = isEnvIssue(error.message);
          shot.status = envIssue ? "draft" : "failed";
          task.status = "failed";
          task.queued = false;
          task.environmentIssue = envIssue;
          task.message = envIssue ? `环境问题（非镜头质量问题）：${error.message}` : error.message;
          if (envIssue) raiseEnvAlert(error.message, "图片");
        }
        const hint = providerHint(error.message);
        addLog(`镜头「${shot.title}」首帧生成未完成：${error.message}${hint ? `\n提示：${hint}` : ""}`);
      }
      persist(); render();
    }
  };
  let imageSubmitting = false;
  const submitImages = async (list, options = {}) => {
    if (imageSubmitting) return showToast("上一批首帧仍在串行生成或限流等待中，请勿重复提交。", true);
    imageSubmitting = true;
    try { await runSubmitImages(list, options); }
    finally { imageSubmitting = false; }
  };
  const videoDurationForModel=(model,requested)=>{
    const seconds=Number(requested)||5;
    if(/^doubao-seedance-/i.test(model))return clamp(Math.round(seconds),4,12);
    if(/^happyhorse-/i.test(model))return clamp(Math.round(seconds),3,15);
    // 万相 i2v 只接受 5 秒或 10 秒；传 6 秒会被直接拒单。
    if(/wan2\.7-i2v|wan2\.6-i2v/i.test(model))return seconds<=5?5:10;
    if(/wan2\.5-/i.test(model))return seconds<=5?5:10;
    if(/wanx?2\.1-/i.test(model))return 5;
    return clamp(Math.round(seconds),2,30);
  };
  // 生成分辨率：默认 1080p（竞品与平台交付都是 1080p 起），通道不支持时自动回退 720p。
  const videoResolutionSetting=()=>state.settings.providers.video?.resolution==="720p"?"720p":"1080p";

  const queryZhipuTask = async (taskId, baseUrl) => {
    // 查任务同样三层兜底：智谱两个通道共用一把 Key，本机保存时传空让服务端注入。
    const resolved = resolveSecret("video");
    const apiKey = resolved.value && resolved.value !== SERVER_SECRET_SENTINEL ? normalizeKey(resolved.value) : "";
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const response = await safeFetch("/api/model-task", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId, baseUrl, apiKey }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error?.message || data?.detail || data?.error || "智谱任务查询失败");
      const status = String(data?.task_status || data?.status || "").toUpperCase();
      if (status === "SUCCESS") return data;
      if (["FAIL", "FAILED"].includes(status)) throw new Error(data?.error?.message || "智谱视频任务失败（内容审核或参数不合法）");
      await sleep(5000);
    }
    throw new Error("智谱视频任务等待超过 10 分钟，请稍后在任务台账重试");
  };

  const queryTencentTask = async taskId => {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const data = await proxyRequest("video", { action: "DescribeHunyuanToVideoJob", params: { JobId: taskId } });
      const response = data?.Response || {};
      if (response.Error) throw new Error(response.Error.Message || response.Error.Code || "腾讯混元任务查询失败");
      const status = String(response.Status || "").toUpperCase();
      if (status === "DONE") return data;
      if (status === "FAIL") throw new Error(response.ErrorMessage || response.ErrorCode || "腾讯混元视频任务失败");
      await sleep(5000);
    }
    throw new Error("腾讯混元任务等待超过 10 分钟，请稍后在任务台账续查");
  };

  const runSubmitVideos = async (list, { chainDepth = 0 } = {}) => {
    const episode = getEpisode();
    // 支持直接传入镜头列表（任务台账/失败重试只跑指定镜头），不传则用页面勾选。
    const picked = Array.isArray(list) ? list.filter(Boolean) : [];
    const shots = picked.length ? picked : episode.shots.filter(item => item.selected);
    if (!shots.length) return showToast("请先选择镜头。", true);
    const selectedVideoProvider = state.settings.providers.video;
    // 同一集内锁定视频模型：wan/混元/HappyHorse 的镜头语言、肤色和年龄稳定性不同，
    // 中途切换会让同一角色换脸、变老、服装漂移。已有成片时禁止静默换模型。
    const modelSignature = `${selectedVideoProvider.vendor}/${selectedVideoProvider.model}/${selectedVideoProvider.imageToVideoModel || ""}`;
    const lock = episode.videoModelLock;
    if (lock && episode.shots.some(shot => shot.mediaUrl) && lock.signature !== modelSignature) {
      return showToast(`本集已锁定视频模型 ${lock.label || lock.signature}；中途切换会造成角色换脸/年龄漂移。请先在交付中心解除本集模型锁定，或重做全部镜头。`, true);
    }
    // 关键修复：只要已有首帧，人物镜头必须自动切到“首帧图生视频”。
    // 旧版一键生成后仍保留 text 模式，视频只读文字、不读定妆/九宫格，
    // 这是角色换脸、服装漂移和“同一个人重复出现”的最主要原因。
    shots.forEach(shot => {
      const i2vModel = selectedVideoProvider.imageToVideoModel || selectedVideoProvider.model;
      const canFirst = ProviderCapabilities?.supports(selectedVideoProvider.vendor, i2vModel, "first") !== false;
      if ((shot.videoInputMode || "text") === "text" && shot.firstFrameUrl && canFirst) {
        shot.videoInputMode = "first";
        shot.videoInputModeAuto = true;
      }
    });
    // 逐镜校验：重试失败镜头时，个别镜头缺绑定不应把整批带崩。
    const blocked = new Map();
    shots.forEach(shot => {
      try {
        validateShotBindings(shot);
        const mode = shot.videoInputMode || "text";
        const model = mode === "text" ? selectedVideoProvider.model : (selectedVideoProvider.imageToVideoModel || selectedVideoProvider.model);
        if (ProviderCapabilities && !ProviderCapabilities.supports(selectedVideoProvider.vendor, model, mode)) {
          throw new Error(`${ProviderCapabilities.provider(selectedVideoProvider.vendor).label} ${model} 不支持“${mode === "keyframes" ? "首尾帧" : mode === "first" ? "首帧" : "文生"}”模式`);
        }
      } catch (error) { blocked.set(shot.id, error.message); }
    });
    const runnable = shots.filter(shot => !blocked.has(shot.id));
    if (!runnable.length) return showToast(`所选镜头都不满足生成条件：${[...blocked.values()][0] || "请检查角色与场景绑定"}`, true);
    if (["dashscope", "tencent"].includes(selectedVideoProvider?.vendor) && !selectedVideoProvider.freeTierOnlyConfirmed) {
      return showToast(selectedVideoProvider.vendor === "tencent"
        ? "为避免误用后付费，请先领取腾讯混元 50 点免费包、确认未开启后付费，再到设置页勾选确认并保存。"
        : "为避免免费额度耗尽后自动扣费，请先到百炼控制台开启“免费额度用完即停”，再到设置页勾选确认并保存。", true);
    }
    // 默认通道是火山 Agent Plan，但多数本机没有这个 Key，逐镜报错会让人误以为是镜头问题。
    // 提交前先做一次密钥预检，直接指出该切哪个通道。
    const videoVendor = selectedVideoProvider?.vendor || "";
    const hasVideoSecret = videoVendor === "tencent"
      ? Boolean(secrets.videoTencentId || serverSecrets.videoTencentId) && Boolean(secrets.videoTencentKey || serverSecrets.videoTencentKey)
      : Boolean(resolveSecret("video").value);
    if (!hasVideoSecret) {
      return showToast(`当前视频通道「${selectedVideoProvider?.label || videoVendor}」没有配置 API Key，无法提交。请到设置页改选已配置密钥的通道（腾讯混元 / 智谱 / 阿里百炼）后再生成。`, true);
    }
    if (blocked.size) {
      const detail = [...blocked.entries()].map(([id, message]) => `${episode.shots.find(item => item.id === id)?.title || id}：${message}`).join("\n");
      addLog(`跳过 ${blocked.size} 个缺绑定的镜头，其余继续提交。\n${detail}`);
      showToast(`${blocked.size} 个镜头缺绑定已跳过（原因见运行日志），其余 ${runnable.length} 个继续提交。`, true);
    }
    currentView = "generation"; render();
    // 提交前把预估费用写进日志与提示，避免用户「不知道要花多少钱就点了」。
    const cost = estimateEpisodeCost(episode, runnable.filter(shot => !shot.qc?.passed));
    if (cost.amount !== null && cost.shots > 0) {
      addLog(`本次提交预估费用：${cost.shots} 个镜头 · ${cost.seconds.toFixed(1)} 秒 · 约 ¥${cost.amount.toFixed(2)}。`);
    }
    for (const shot of runnable) {
      if (shot.qc?.passed) {
        addLog(`镜头「${shot.title}」已有质检通过成片，为避免重复计费已跳过。`);
        continue;
      }
      shot.status = "generating"; render();
      let task = episode.tasks.find(item => item.kind === "视频" && item.shotId === shot.id && item.taskId && ["submitted", "generating", "failed"].includes(item.status));
      const resumesExistingTask = Boolean(task);
      if (!task) {
        // 清掉同镜头「排队中被中断、从未拿到任务 ID」的僵尸记录，台账才不会越积越多。
        const previousDeferredCycles = Math.max(0, ...episode.tasks.filter(item => item.kind === "视频" && item.shotId === shot.id).map(item => Number(item.deferredCycles || 0)));
        episode.tasks = episode.tasks.filter(item => !(item.kind === "视频" && item.shotId === shot.id && !item.taskId && ["submitted", "queued"].includes(item.status)));
        task = { id: uid("task"), kind: "视频", shotId: shot.id, shotTitle: shot.title, status: "submitted", at: now(), startedAt: Date.now(), deferredCycles: previousDeferredCycles, message: "异步任务已提交" };
        episode.tasks.unshift(task);
      } else {
        task.status = "generating";
        task.message = `续查已有任务 ${task.taskId}，不会重复提交计费请求`;
        addLog(`镜头「${shot.title}」续查已有任务 ${task.taskId}；未重复提交。`);
      }
      try {
        const cfg = state.settings.providers.video;
        const isVolcengineTask = cfg.endpoint.includes("/contents/generations/tasks");
        const isZhipuTask = cfg.vendor === "zhipu" || cfg.baseUrl.includes("open.bigmodel.cn");
        const isDashscope = cfg.baseUrl.includes("dashscope.aliyuncs.com") || cfg.baseUrl.includes(".maas.aliyuncs.com");
        const isTencentTask = cfg.vendor === "tencent" || cfg.baseUrl.includes("vclm.tencentcloudapi.com");
        const mode=shot.videoInputMode||"text";const model=task.model||(mode==="text"?cfg.model:(cfg.imageToVideoModel||cfg.model));
        const prompt=`${buildProductionPrompt(shot, { forVideo: true })}\n运动强度：${Number(shot.motionStrength||.55).toFixed(2)}；保持动作自然、镜头稳定；不得改变首帧中角色的脸、年龄、发型、服装和鞋包。`;
        task.model=model;task.prompt=prompt;task.startedAt ||= Date.now();
        let payload;
        if (resumesExistingTask && (isDashscope || isVolcengineTask || isZhipuTask || isTencentTask)) {
          payload = null;
        } else if (isTencentTask) {
          if (mode === "keyframes") throw new Error("腾讯混元当前官方接口只支持文生或单张首帧，不支持首尾帧");
          // 腾讯只收 200 字，直接截断会把“每个角色只出现一次”这类硬规则整段切掉，
          // 模型就按提示词前半段自由发挥，出现分身/换脸。这里把角色规则前置，保证它一定留下。
          const castNames = shotReferenceAssets(shot).map(item => item.name).filter(Boolean);
          const castRule = castNames.length
            ? `本镜角色：${castNames.join("、")}，每人只出现一次，禁止分身、双胞胎或重复人物。`
            : "画面不得出现重复人物。";
          const params = { Prompt: `${castRule}${prompt}`.slice(0, 200), Resolution: "720p", LogoAdd: 0 };
          const frame = mode === "text" ? "" : (shot.firstFrameUrl || videoReferenceUrls(shot)[0]);
          if (mode !== "text") {
            if (!frame) throw new Error("腾讯混元图生视频缺少首帧");
            const dataUrl = await mediaToDataUrl(frame);
            const encoded = String(dataUrl || "").split(",", 2)[1] || "";
            if (!encoded) throw new Error("腾讯混元首帧转换失败");
            params.Image = { Base64: encoded };
          }
          payload = { action: "SubmitHunyuanToVideoJob", params };
        } else if (isZhipuTask) {
          if (mode === "keyframes") throw new Error("智谱 CogVideoX 只支持单张首帧图生视频；请把该镜头的输入模式改为首帧图生视频");
          payload = {
            model, prompt: prompt.slice(0, 500),
            size: getProject().format === "9:16" ? "1080x1920" : "1920x1080",
            fps: 30,
            with_audio: false,
            watermark_enabled: false,
          };
          const frame = mode==="text"?"":(shot.firstFrameUrl || (mode==="grid"?shot.storyboardGrid?.imageUrl:"") || videoReferenceUrls(shot)[0]);
          if (frame) payload.image_url = await shrinkImageDataUrl(await mediaToDataUrl(frame));
        } else if (isVolcengineTask) {
          if (mode === "keyframes") throw new Error("Agent Plan 当前接入支持文生视频和首帧图生视频；请将输入模式改为首帧图生视频");
          const content = [{ type: "text", text: prompt }];
          const frame = mode==="text"?"":(shot.firstFrameUrl || (mode==="grid"?shot.storyboardGrid?.imageUrl:"") || videoReferenceUrls(shot)[0]);
          if (frame) content.push({ type: "image_url", image_url: { url: await mediaToDataUrl(frame) } });
          payload = {
            model, content, generate_audio: true,
            ratio: getProject().format === "9:16" ? "9:16" : "16:9", resolution: videoResolutionSetting(),
            duration: videoDurationForModel(model, shot.duration), watermark: false, return_last_frame: true,
          };
        } else if (isDashscope) {
          // Wan3 与 HappyHorse 1.1 共用异步端点，但素材能力不同，按模型能力组装请求。
          const happyHorse = /^happyhorse-1\.1-(t2v|i2v|r2v)$/i.exec(model);
          const first = mode==="grid"?shot.storyboardGrid?.imageUrl:shot.firstFrameUrl;
          if (happyHorse) {
            const capability = happyHorse[1].toLowerCase();
            const params = {
              resolution: videoResolutionSetting().toUpperCase(),
              duration: videoDurationForModel(model, shot.duration),
              watermark: false,
            };
            if (capability === "t2v") {
              if (mode !== "text") throw new Error("happyhorse-1.1-t2v 只支持文生视频；请把镜头输入模式改为纯文本");
              params.ratio = getProject().format === "9:16" ? "9:16" : "16:9";
              payload = { model, input: { prompt }, parameters: params };
            } else if (capability === "i2v") {
              if (mode === "text" || !first) throw new Error("happyhorse-1.1-i2v 需要一张首帧");
              if (mode === "keyframes") throw new Error("happyhorse-1.1-i2v 不支持首尾帧；请改用 wan3.0-video");
              payload = { model, input: { prompt, media: [{ type: "first_frame", url: await ensureDashscopeMedia(first, model) }] }, parameters: params };
            } else {
              const references = [...new Set([first, ...videoReferenceUrls(shot)].filter(Boolean))].slice(0, 9);
              if (!references.length) throw new Error("happyhorse-1.1-r2v 至少需要一张参考图");
              const media = [];
              for (const reference of references) media.push({ type: "reference_image", url: await ensureDashscopeMedia(reference, model) });
              params.ratio = getProject().format === "9:16" ? "9:16" : "16:9";
              payload = { model, input: { prompt: `参考[Image 1]保持主体身份、服装与画面风格。${prompt}`, media }, parameters: params };
            }
          } else {
            if (mode !== "text" && !first) throw new Error("图生视频模式缺少首帧");
            const media = [];
            if(mode!=="text"){if(!first)throw new Error("图生视频模式缺少首帧");media.push({type:"first_frame",url:await ensureDashscopeMedia(first,model)});}
            if(mode==="keyframes"){if(!shot.lastFrameUrl)throw new Error("首尾帧模式缺少尾帧");media.push({type:"last_frame",url:await ensureDashscopeMedia(shot.lastFrameUrl,model)});}
            payload = {
              model,
              input: { prompt, ...(media.length ? { media } : {}) },
              parameters: {
                resolution: videoResolutionSetting().toUpperCase(), ratio: getProject().format === "9:16" ? "9:16" : "16:9",
                duration: videoDurationForModel(model,shot.duration), audio: true,
                prompt_extend: true, watermark: false,
              },
            };
          }
        } else {
          payload = { model, prompt, seconds: String(shot.duration), size: getProject().format === "9:16" ? "720x1280" : "1280x720" };
        }
        let data;
        if (resumesExistingTask && (isDashscope || isVolcengineTask || isZhipuTask || isTencentTask)) {
          data = { id: task.taskId, output: { task_id: task.taskId } };
        } else {
          data = await withRateLimitRetry(`镜头「${shot.title}」视频`, async () => {
            try {
              return await proxyRequest("video", payload);
            } catch (error) {
              // 没在智谱签「去水印免责声明」时 watermark_enabled:false 会被拒：回退为带官方水印再发一次，别让整批任务挂掉。
              if (isZhipuTask && payload?.watermark_enabled === false && /watermark|水印|免责/i.test(error.message)) {
                payload = { ...payload, watermark_enabled: true };
                addLog("智谱拒绝关闭水印（未签署免责声明），该镜改用官方水印重新提交。", { model });
                return await proxyRequest("video", payload);
              }
              // 套餐不支持 1080p 时退回 720p：宁可画质低一档，也别让整批生成失败。
              const askedHigh = String(payload?.resolution || payload?.parameters?.resolution || "").toLowerCase() === "1080p";
              if (askedHigh && /resolution|分辨率|不支持|not support|invalid.*param/i.test(error.message)) {
                payload = { ...payload, resolution: "720p", parameters: payload.parameters ? { ...payload.parameters, resolution: "720P" } : undefined };
                addLog(`当前通道不支持 1080p，该镜已降级为 720p 重新提交（${error.message.slice(0, 80)}）。`, { model });
                return await proxyRequest("video", payload);
              }
              throw error;
            }
          }, (round, seconds, total) => {
            // 排队状态写进台账：状态是 queued（不是 failed），带一个截止时间用于倒计时。
            task.status = "queued";
            task.queued = true;
            task.queueAttempt = round;
            task.queueTotal = total;
            task.queueNextAt = Date.now() + seconds * 1000;
            task.message = `免费通道限流（1305 平台侧拥挤），后台排队第 ${round}/${total} 次`;
            shot.status = "queued";
            persist(); render();
          });
        }
        task.taskId = task.taskId || data?.Response?.JobId || data.id || data.task_id || data.data?.id || data.output?.task_id || "";
        if (task.taskId) { task.queued = false; task.queueNextAt = 0; task.status = "submitted"; task.message = "异步任务已提交"; }
        let result = data;
        if (isDashscope && task.taskId) {
          task.message = `任务 ID: ${task.taskId}，正在轮询`;
          persist(); render();
          result = await queryDashscopeTask(task.taskId, cfg.baseUrl);
        } else if (isZhipuTask && task.taskId) {
          task.message = `智谱任务 ${task.taskId}，正在轮询`;
          persist(); render();
          result = await queryZhipuTask(task.taskId, cfg.baseUrl);
        } else if (isVolcengineTask && task.taskId) {
          task.message = `Agent Plan 任务 ${task.taskId}，正在轮询`;
          persist(); render();
          result = await queryAgentPlanTask(task.taskId, cfg.baseUrl);
        } else if (isTencentTask && task.taskId) {
          task.message = `腾讯混元任务 ${task.taskId}，正在轮询`;
          persist(); render();
          result = await queryTencentTask(task.taskId);
        }
        const output = result.Response || result.output || result.data || result;
        const results = Array.isArray(output.results) ? output.results : [];
        const videoUrl = output.ResultVideoUrl || output.content?.video_url || output.video_url || output.url || output.output_url || results[0]?.video_url || results[0]?.url || (Array.isArray(output.video_result) ? output.video_result[0]?.url : "") || result.content?.video_url || result.video_url || result.url || "";
        if (!videoUrl) throw new Error(task.taskId ? `任务 ${task.taskId} 未返回视频地址` : "服务未返回任务 ID 或视频地址");
        // 各家返回的都是带签名的临时地址（几小时就过期，万相还挂在 OSS 上）。
        // 以前直接写进 mediaUrl，结果质检失败或过一阵再打开时成片就 404。
        // 现在先落盘到本地媒体目录，远端地址只作为兜底。
        task.remoteUrl = videoUrl;
        let localVideo = videoUrl;
        try {
          localVideo = await persistMedia({ sourceUrl: videoUrl, name: `shot-${shot.id}` });
        } catch (error) {
          addLog(`镜头「${shot.title}」成片落盘失败，暂用临时地址（会过期，请尽快重试）：${error.message}`);
        }
        shot.mediaUrl = localVideo;
        shot.videoModel = modelSignature;
        shot.videoProvider = selectedVideoProvider.vendor;
        if (!episode.videoModelLock) {
          episode.videoModelLock = { signature: modelSignature, label: `${selectedVideoProvider.vendor} / ${model}`, lockedAt: now() };
          addLog(`本集已锁定视频模型 ${episode.videoModelLock.label}，后续镜头将强制使用同一模型以保持角色连续性。`);
        }
        const qc = await runShotQc(shot, localVideo);
        task.status = qc.passed ? "completed" : "qc_failed";
        task.durationMs=Date.now()-task.startedAt;
        task.message = qc.passed ? `任务 ${task.taskId || "同步"} 已完成并通过质检` : `任务 ${task.taskId || "同步"} 已完成，但质检未通过`;
        addLog(`镜头「${shot.title}」${resumesExistingTask ? "已有视频任务已完成轮询" : "视频请求已被外部服务接受"}${task.taskId ? `，任务 ${task.taskId}` : ""}。`, { model, taskId: task.taskId, durationMs: task.durationMs, prompt });
      } catch (error) {
        if (error.queueExhausted && !task.taskId) {
          // 一轮密集退避耗尽后转为低频候车，不再让用户盯着「6/6」手动重点。
          shot.status = "queued";
          task.status = "queued";
          task.queued = true;
          task.deferredCycles = Number(task.deferredCycles || 0) + 1;
          if (task.deferredCycles <= DEFERRED_QUEUE_MAX_CYCLES) {
            task.queueNextAt = Date.now() + DEFERRED_QUEUE_DELAY_MS;
            task.message = `免费模型持续 1305 限流，已转入低频候车：约 15 分钟后自动续排（${task.deferredCycles}/${DEFERRED_QUEUE_MAX_CYCLES}）`;
            scheduleDeferredTask(task, shot);
          } else {
            task.queueNextAt = 0;
            task.message = "免费模型持续 1305 限流，低频候车已达 8 轮；已安全暂停，未提交、未重复计费";
          }
        } else {
          // 账户欠费 / 额度用尽 / Key 失效属于环境问题：镜头本身没问题，
          // 标成 failed 会让交付中心显示一堆「坏镜头」，用户还得逐个重试。
          const envIssue = isEnvIssue(error.message);
          shot.status = envIssue ? "draft" : "failed";
          task.status = "failed";
          task.queued = false;
          task.queueNextAt = 0;
          task.environmentIssue = envIssue;
          task.message = envIssue ? `环境问题（非镜头质量问题）：${error.message}` : error.message;
          if (envIssue) raiseEnvAlert(error.message, "视频");
        }
        const hint = providerHint(error.message);
        addLog(`镜头「${shot.title}」视频提交失败：${error.message}${hint ? `\n提示：${hint}` : ""}`);
      }
      persist(); render();
    }
    // 连续镜头依赖自动续排：第一批里因为“还没有首帧”被跳过的下游镜头，
    // 在上游质检通过、尾帧写入后必须自动补投，不能永久跳过。
    if (chainDepth < 1) {
      const downstream = shots.filter(shot => blocked.has(shot.id) && shot.firstFrameUrl && !shot.qc?.passed && shot.status !== "generating");
      if (downstream.length) {
        addLog(`上游已完成，检测到 ${downstream.length} 个下游连续镜头已拿到首帧，自动续排：${downstream.map(shot => shot.title).join("、")}`);
        showToast(`${downstream.length} 个下游镜头已拿到上游尾帧，正在自动续排。`);
        await runSubmitVideos(downstream, { chainDepth: chainDepth + 1 });
      }
    }
  };
  let videoSubmitting = false;
  // 防重入：免费通道一次只该跑一队。等待限流期间用户再点一次，会让两批请求并行排队，越点越限流。
  const submitVideos = async (list) => {
    if (videoSubmitting) {
      return showToast("上一批视频还在提交或排队等待限流，请等它跑完；任务台账里会显示「自动排队等待中」。", true);
    }
    videoSubmitting = true;
    try { await runSubmitVideos(list); }
    finally { videoSubmitting = false; }
  };
  const deferredQueueTimers = new Map();
  const scheduleDeferredTask = (task, shot) => {
    if (!task || !shot || task.status !== "queued") return;
    const existing = deferredQueueTimers.get(task.id);
    if (existing) clearTimeout(existing);
    const nextAt = Number(task.queueNextAt || 0) || (Date.now() + 5000);
    task.queueNextAt = nextAt;
    const timer = setTimeout(async () => {
      deferredQueueTimers.delete(task.id);
      if (task.status !== "queued") return;
      const busy = task.kind === "视频" ? videoSubmitting : imageSubmitting;
      if (busy) {
        task.queueNextAt = Date.now() + 60000;
        task.message = "生成通道仍有任务执行，约 1 分钟后继续低频候车";
        persist(); render(); scheduleDeferredTask(task, shot);
        return;
      }
      task.queueNextAt = 0;
      task.message = "低频候车到点，正在重新提交…";
      persist(); render();
      if (task.kind === "视频") await submitVideos([shot]);
      else await submitImages([shot], { skipExisting: true });
    }, Math.max(1000, nextAt - Date.now()));
    deferredQueueTimers.set(task.id, timer);
  };
  const reconcileDeferredQueue = () => {
    const episode = getEpisode();
    if (!episode) return;
    episode.tasks.filter(task => task.status === "queued" && ["视频", "图片"].includes(task.kind) && Number(task.queueNextAt || 0) > 0 && Number(task.deferredCycles || 0) <= DEFERRED_QUEUE_MAX_CYCLES).forEach(task => {
      const shot = episode.shots.find(item => item.id === task.shotId);
      if (!shot) return;
      // WebEngine 在窗口被遮挡或系统休眠时可能延后长定时器；心跳发现已到期就重新挂一个 1 秒任务。
      if (Number(task.queueNextAt) <= Date.now() || !deferredQueueTimers.has(task.id)) scheduleDeferredTask(task, shot);
    });
  };
  // 「续查」同时兜住「排队中被中断、还没拿到任务 ID」的镜头（关程序/刷新后常见），否则这些镜头会永远卡在 submitted。
  const resumePendingTasks = async () => {
    const episode = getEpisode();
    const pending = episode.tasks.filter(task => task.kind === "视频" && (["submitted", "generating", "queued"].includes(task.status) || (task.status === "failed" && task.taskId)));
    if (!pending.length) return showToast("没有可续查任务。", true);
    const shotIds = new Set(pending.map(task => task.shotId));
    const shots = episode.shots.filter(shot => shotIds.has(shot.id));
    if (!shots.length) return showToast("待续查任务对应的镜头已被删除。", true);
    const hasTaskId = shot => pending.some(task => task.shotId === shot.id && task.taskId);
    const queued = shots.filter(hasTaskId).length;
    episode.shots.forEach(shot => { shot.selected = shotIds.has(shot.id); });
    persist(); render();
    if (queued < shots.length) {
      addLog(`续查：${queued} 个镜头有任务 ID 走轮询，${shots.length - queued} 个镜头无任务 ID，重新提交。`);
    }
    await submitVideos(shots);
  };
  // 启动自动续排：排队中的任务在热重载/重开程序后会丢，这里把用户已经发起过的请求接回去，不需要再点按钮。
  const autoResumeQueue = () => {
    const episode = getEpisode();
    const waiting = episode.tasks.filter(task => task.status === "queued" && ["视频", "图片"].includes(task.kind) && Number(task.deferredCycles || 0) <= DEFERRED_QUEUE_MAX_CYCLES);
    if (!waiting.length) return;
    let scheduled = 0;
    waiting.forEach((task, index) => {
      const shot = episode.shots.find(item => item.id === task.shotId);
      if (!shot) return;
      // 没有截止时间的是旧版遗留任务，错开 5 秒续排；已有截止时间必须原样恢复，避免刷新页面绕过退避。
      if (!Number(task.queueNextAt || 0)) task.queueNextAt = Date.now() + 5000 + index * 60000;
      scheduleDeferredTask(task, shot);
      scheduled += 1;
    });
    if (!scheduled) return;
    const earliest = Math.min(...waiting.map(task => Number(task.queueNextAt || 0)).filter(Boolean));
    const seconds = Math.max(1, Math.ceil((earliest - Date.now()) / 1000));
    addLog(`检测到 ${scheduled} 个限流排队任务，已按原定退避时间恢复低频候车。`);
    showToast(`已恢复 ${scheduled} 个限流排队任务，最早约 ${seconds} 秒后自动重试。`);
    persist(); render();
  };
  // 任务台账里单条失败任务的一键重试：只重提该镜头，不动页面其它勾选。
  const retryTaskById = async (taskId) => {
    const episode = getEpisode();
    const task = episode.tasks.find(item => item.id === taskId);
    if (!task) return showToast("找不到该任务记录。", true);
    const shot = episode.shots.find(item => item.id === task.shotId);
    if (!shot) return showToast("该任务对应的镜头已被删除，无法重试。", true);
    if (task.kind === "视频" && !window.confirm(`重新提交镜头「${shot.title}」的视频生成？\n会真实调用外部接口并消耗额度。`)) return;
    // 清掉这条失败记录，避免台账里同一镜头堆出一长串红色历史。
    episode.tasks = episode.tasks.filter(item => item.id !== task.id);
    shot.status = "pending";
    persist(); render();
    addLog(`手动重试镜头「${shot.title}」的${task.kind}任务。`, { taskId: task.taskId || "", model: task.model || "" });
    if (task.kind === "图片") await submitImages([shot]);
    else await submitVideos([shot]);
  };

  // 取消排队：这条请求从未拿到任务 ID，删掉记录不会产生任何费用。
  const cancelQueue = (taskId) => {
    const episode = getEpisode();
    const task = episode.tasks.find(item => item.id === taskId);
    if (!task) return;
    const shot = episode.shots.find(item => item.id === task.shotId);
    episode.tasks = episode.tasks.filter(item => item.id !== taskId);
    if (shot && shot.status === "queued") shot.status = "pending";
    persist(); render();
    addLog(`已取消镜头「${task.shotTitle}」的限流排队（未提交，不产生费用）。`);
    showToast("已取消排队。想再跑时点「重试这一镜」即可。");
  };
  // 后台日志查看器：后端异常不再只打在控制台（pythonw 下根本看不到），这里直接读落盘日志。
  const openServerLog = async () => {
    document.querySelector("#server-log-modal")?.remove();
    const wrapper = document.createElement("div");
    wrapper.id = "server-log-modal";
    wrapper.className = "modal-backdrop";
    wrapper.innerHTML = `<section class="modal log-modal" role="dialog" aria-modal="true" aria-label="后台日志">
      <div class="panel-title"><div><span class="badge">BACKEND</span><h3>后台日志</h3></div><button class="btn ghost" data-modal-close>关闭</button></div>
      <p class="hint" id="server-log-path">读取中…</p>
      <pre class="server-log" id="server-log-body">加载中…</pre>
      <div class="modal-actions"><button class="btn ghost" data-log-copy>复制全文</button><button class="btn primary" data-log-refresh>刷新</button></div>
    </section>`;
    document.body.appendChild(wrapper);
    const close = () => wrapper.remove();
    const load = async () => {
      const bodyNode = wrapper.querySelector("#server-log-body");
      bodyNode.textContent = "加载中…";
      try {
        const response = await fetch("/api/server-log?tail=300", { cache: "no-store" });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        wrapper.querySelector("#server-log-path").textContent = data.path || "";
        bodyNode.textContent = (data.lines || []).join("\n") || "日志为空：启动后还没有错误或慢请求记录。";
        bodyNode.scrollTop = bodyNode.scrollHeight;
      } catch (error) {
        bodyNode.textContent = `读取失败：${error.message}\n如果本地服务没在运行，请点窗口顶部的「启动 / 重载」。`;
      }
    };
    wrapper.querySelector("[data-modal-close]").addEventListener("click", close);
    wrapper.addEventListener("click", event => { if (event.target === wrapper) close(); });
    wrapper.querySelector("[data-log-refresh]").addEventListener("click", load);
    wrapper.querySelector("[data-log-copy]").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(wrapper.querySelector("#server-log-body").textContent || "");
        showToast("日志已复制。");
      } catch { showToast("复制失败，请手动选中文本。", true); }
    });
    load();
  };
  // 只重跑质检，不重新生成：模型已经出片、只是被门禁挡住时，这一步不花额度。
  const requalifyShot = async (taskId) => {
    const episode = getEpisode();
    const task = episode.tasks.find(item => item.id === taskId);
    const shot = episode.shots.find(item => item.id === task?.shotId);
    if (!shot?.mediaUrl) return showToast("该镜头没有可复检的成片，请重新生成。", true);
    showToast("正在重新质检（沿用已有成片，不消耗额度）…");
    try {
      const qc = await runShotQc(shot, shot.mediaUrl);
      if (task) {
        task.status = qc.passed ? "completed" : "qc_failed";
        task.message = qc.passed ? "重新质检通过（沿用已有成片，未重新生成）" : "重新质检仍未通过";
      }
      persist(); render();
      showToast(qc.passed ? "重新质检通过，这个镜头已可进入交付。" : "仍未通过，请按下方提示核对画面。", !qc.passed);
    } catch (error) {
      addLog(`镜头「${shot.title}」重新质检失败：${error.message}`);
      persist(); render();
      showToast(error.message, true);
    }
  };
  // 自动质检是启发式门禁，可能把多人物背景或低对比度画面误判为失败。
  // 人工验收只放行现有成片并保留原始警告，不会重新提交云端任务。
  const approveShot = (id) => {
    const episode = getEpisode();
    const shot = episode.shots.find(item => item.id === id);
    if (!shot?.mediaUrl || !shot.qc) return showToast("该镜头没有可供人工验收的质检成片。", true);
    shot.qc = { ...shot.qc, passed: true, manualOverride: true, manualApprovedAt: new Date().toISOString() };
    shot.status = "completed";
    const task = episode.tasks.find(item => item.kind === "视频" && item.shotId === shot.id);
    if (task) {
      task.status = "completed";
      task.message = `人工验收通过；保留自动质检警告：${(shot.qc.warnings || []).join("；") || "无"}`;
    }
    if (shot.lastFrameUrl) {
      const index = episode.shots.findIndex(item => item.id === shot.id);
      const next = episode.shots[index + 1];
      if (next && (!next.firstFrameUrl || next.firstFrameOrigin === "chain")) assignChainSource(next, shot);
    }
    addLog(`镜头「${shot.title}」已人工验收通过；自动质检警告仍保留在台账中。`);
    persist(); render(); showToast("人工验收通过，未重新生成、未消耗额度。");
  };
  // 批量人工验收：质检误报往往集中在“人数/侧脸/尾帧”这类启发式项上，
  // 逐镜点放行很费时间，这里允许一次放行当前选中的、已成片但未通过的镜头。
  const approveSelectedShots = () => {
    const episode = getEpisode();
    const targets = episode.shots.filter(shot => shot.selected && shot.mediaUrl && !shot.qc?.passed);
    if (!targets.length) return showToast("当前选中镜头里没有“已成片但质检未通过”的，无需放行。", true);
    targets.forEach(shot => {
      shot.qc = { ...(shot.qc || {}), passed: true, manualOverride: true, manualApprovedAt: new Date().toISOString() };
      shot.status = "completed";
      const task = episode.tasks.find(item => item.kind === "视频" && item.shotId === shot.id);
      if (task) {
        task.status = "completed";
        task.message = `批量人工验收通过；保留自动质检警告：${(shot.qc.warnings || []).join("；") || "无"}`;
      }
    });
    addLog(`批量人工验收 ${targets.length} 个镜头：${targets.map(shot => shot.title).join("、")}；未重新生成。`);
    persist(); render();
    showToast(`已人工放行 ${targets.length} 个质检误报镜头，未重新生成、未消耗额度。`);
  };
  const testProvider = async (type) => {
    collectSettings(false);
    try {
      if (type === "video") {
        const cfg = state.settings.providers.video;
        const zhipu = cfg.vendor === "zhipu";
        const dashscope = cfg.vendor === "dashscope";
        const tencent = cfg.vendor === "tencent";
        if (tencent) {
          const managed = serverSecrets.videoTencentId && serverSecrets.videoTencentKey;
          const credentialId = normalizeKey(secrets.videoTencentId || "");
          const credentialKey = normalizeKey(secrets.videoTencentKey || "");
          if ((!credentialId || !credentialKey) && !managed) throw new Error("请成对填写腾讯云 SecretId 与 SecretKey，或在 .env.models.local 配置 TENCENTCLOUD_SECRET_ID / TENCENTCLOUD_SECRET_KEY");
          const shapeProblem = describeTencentCredentialProblem(credentialId, credentialKey);
          if (shapeProblem) throw new Error(shapeProblem);
          const response = await safeFetch("/api/model-test", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ provider: "video", baseUrl: cfg.baseUrl, endpoint: cfg.endpoint, credentialId, credentialKey }),
          });
          const data = await response.json();
          if (!response.ok) throw new Error(data?.Response?.Error?.Message || data?.detail || data?.error || `腾讯云 HTTP ${response.status}`);
          showToast("腾讯云凭据已通过只读签名校验；仅查询不存在的任务，未消耗积分。");
          return;
        }
        const typedKey = document.querySelector("#video-key")?.value || "";
        if (typedKey.trim() && !normalizeKey(typedKey)) {
          throw new Error("Key 里没有可用的英文字符：看起来粘贴的是中文说明或占位文字。请到控制台「API Keys」重新复制真正的 Key。");
        }
        const resolvedVideoSecret = resolveSecret("video");
        const rawSecret = resolvedVideoSecret.value && resolvedVideoSecret.value !== SERVER_SECRET_SENTINEL ? normalizeKey(resolvedVideoSecret.value) : "";
        const managedByServer = resolvedVideoSecret.value === SERVER_SECRET_SENTINEL;
        if (!rawSecret && !managedByServer) {
          throw new Error(zhipu ? "请先填写智谱开放平台 API Key（bigmodel.cn；图片与视频共用同一把 Key）"
            : dashscope ? "请先填写百炼 API Key（sk- 开头；图片与视频共用同一把 Key）"
            : "请先填写 Agent Plan 专属 API Key");
        }
        const response = await safeFetch("/api/model-test", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: "video", baseUrl: cfg.baseUrl, endpoint: cfg.endpoint, apiKey: rawSecret }),
        });
        const data = await response.json();
        if (!response.ok) {
          const raw = data?.error?.message || data?.detail || (typeof data?.error === "string" ? data.error : "") || `视频通道 HTTP ${response.status}`;
          const hint = providerHint(`${raw} ${data?.error?.code || ""}`);
          throw new Error(hint ? `${raw}\n提示：${hint}` : raw);
        }
        showToast(zhipu
          ? "智谱 Key 已通过只读校验；未提交生成任务，未消耗额度。"
          : dashscope ? "百炼 Key 已通过只读校验（查询了一个不存在的任务）；未消耗额度。"
          : "Agent Plan 专属 Key 已通过真实只读连接测试；未提交生成任务，未消耗视频额度。");
        return;
      } else if (type === "chat") {
        const cfg = state.settings.providers.chat;
        await proxyRequest("chat", { model: cfg.model, thinking: { type: "disabled" }, messages: [{ role: "user", content: "只回答 OK" }], max_tokens: 8, temperature: 0 });
      } else if (type === "image" && ["zhipu", "dashscope"].includes(state.settings.providers.image.vendor)) {
        const cfg = state.settings.providers.image;
        const vendor = cfg.vendor;
        const typedKey = document.querySelector("#image-key")?.value || "";
        if (typedKey.trim() && !normalizeKey(typedKey)) {
          throw new Error("Key 里没有可用的英文字符：看起来粘贴的是中文说明或占位文字。请到控制台「API Keys」重新复制真正的 Key。");
        }
        const resolvedImageSecret = resolveSecret("image");
        // 本机 .env 已保存时 value 是哨兵：交给服务端注入，此时不算「没填」。
        const managedByServer = resolvedImageSecret.value === SERVER_SECRET_SENTINEL;
        const rawSecret = managedByServer ? "" : normalizeKey(resolvedImageSecret.value || "");
        if (!rawSecret && !managedByServer) {
          throw new Error(vendor === "dashscope"
            ? "请先填写百炼 API Key（sk- 开头），或把 DASHSCOPE_API_KEY 写进 .env.models.local"
            : "请先填写智谱开放平台 API Key（bigmodel.cn；图片与视频共用同一把 Key）");
        }
        const response = await safeFetch("/api/model-test", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: "image", baseUrl: cfg.baseUrl, endpoint: cfg.endpoint, apiKey: rawSecret }),
        });
        const data = await response.json();
        if (!response.ok) {
          const raw = data?.error?.message || data?.detail || (typeof data?.error === "string" ? data.error : "") || `图片通道 HTTP ${response.status}`;
          const hint = providerHint(`${raw} ${data?.error?.code || ""}`);
          throw new Error(hint ? `${raw}\n提示：${hint}` : raw);
        }
        showToast(vendor === "dashscope"
          ? "百炼 Key 已通过只读校验（空提示词探针）；未出图，未消耗额度。"
          : "智谱 Key 已通过只读校验；未提交生成任务，未消耗额度。");
        return;
      } else {
        const cfg = state.settings.providers[type];
        if (!cfg.baseUrl.startsWith("https://")) throw new Error("商业模式要求外部 API 使用 HTTPS");
        if (!secrets[type]) throw new Error("请先填写 API Key");
      }
      showToast(`${state.settings.providers[type].label}配置可用。${type === "chat" ? "已完成真实轻量请求。" : "地址与密钥格式检查通过，未提交计费生成。"}`);
    } catch (error) { showToast(error.message, true); }
  };

  // 只读当前渲染出来的那一家服务商（编辑区一次只显示一个节点），其余服务商的配置桶保持不动。
  // 参数分两档写：通道级进 options，模型级进 models[模型 id]，空值等于「不覆盖」。
  const readSettingsDom = () => {
    const adjustedKeys = [];
    const saveSecret = (secretName, label, rawValue) => {
      const cleaned = normalizeKey(rawValue);
      if (keyWasAdjusted(rawValue)) adjustedKeys.push(label);
      if (cleaned) {
        secrets[secretName] = cleaned;
        secretOrigins[secretName] = "manual";
        // 智谱的图片与视频共用同一个 Key：任一通道填入后同步给另一个通道，
        // 否则会出现「图片生成正常、视频整批报未配置 Key」这种自相矛盾的状态。
        const sibling = zhipuSiblingSecret(secretName);
        if (sibling) { secrets[sibling] = cleaned; secretOrigins[sibling] = "manual"; }
      } else if (secrets[secretName] !== SERVER_SECRET_SENTINEL) { delete secrets[secretName]; delete secretOrigins[secretName]; }
    };
    const readValue = node => {
      if (!node) return "";
      if (node.type === "checkbox") return node.checked;
      return String(node.value ?? "").trim();
    };
    const kind = settingsNode.kind;
    const providerId = settingsNode.providerId || cfgActiveProvider(kind)?.id;
    const provider = providerId ? schemaProvider(kind, providerId) : null;
    if (provider) {
      const bucket = cfgBucket(kind, provider.id);
      const base = document.querySelector(`#${kind}-base`);
      if (base) bucket.baseUrl = base.value.trim().replace(/\/+$/, "");
      const endpoint = document.querySelector(`#${kind}-endpoint`);
      if (endpoint) bucket.endpoint = endpoint.value.trim();
      const modelSelect = document.querySelector(`#${kind}-model`);
      if (modelSelect) bucket.model = modelSelect.value;

      document.querySelectorAll(`[data-cfg-param][data-cfg-scope="channel"]`).forEach((node) => {
        const key = node.dataset.cfgParam;
        const value = readValue(node);
        if (value === "" || value === undefined) delete bucket.options[key];
        else bucket.options[key] = value;
      });
      document.querySelectorAll(`[data-cfg-param][data-cfg-scope="model"]`).forEach((node) => {
        const key = node.dataset.cfgParam;
        const modelId = settingsNode.modelId;
        if (!modelId) return;
        const value = readValue(node);
        bucket.models[modelId] ||= {};
        if (value === "" || value === undefined) delete bucket.models[modelId][key];
        else bucket.models[modelId][key] = value;
        if (!Object.keys(bucket.models[modelId]).length) delete bucket.models[modelId];
      });

      // 凭据：单 Key 服务商用 #kind-key；腾讯云必须成对，用 #video-tencent-id / -key。
      if (provider.secret.length > 1) {
        provider.secret.forEach((field) => {
          const id = `${kind}-${field.name === "secretId" ? "tencent-id" : "tencent-key"}`;
          const node = document.querySelector(`#${id}`);
          if (node) saveSecret(field.slot, field.name === "secretId" ? "腾讯 SecretId" : "腾讯 SecretKey", node.value);
        });
      } else {
        const node = document.querySelector(`#${kind}-key`);
        if (node) saveSecret(provider.secret[0].slot, provider.secret[0].label || "API Key", node.value);
      }
    }
    const remember = document.querySelector("#remember-secrets");
    if (remember) state.settings.rememberSecrets = remember.checked;
    return adjustedKeys;
  };

  // 把「每家服务商一个桶」收敛回生成链路认的 state.settings.providers[kind]。
  // 只写当前启用的那一家：改别的通道的配置不该影响正在跑的流水线。
  const applyVendorsToProviders = () => {
    ["chat", "image", "video"].forEach((kind) => {
      const current = state.settings.providers[kind] || {};
      const vendor = current.vendor || SCHEMA_KIND_DEFAULT_VENDOR[kind];
      const list = schemaProviders(kind);
      const provider = list.find(item => item.vendor === vendor) || list[0];
      if (!provider) return;
      const bucket = cfgBucket(kind, provider.id);
      const model = bucket.model || provider.defaults.model;
      const next = {
        ...current,
        vendor: provider.vendor,
        label: kind === "chat" ? "对话模型" : kind === "image" ? "图片模型" : "视频模型",
        baseUrl: bucket.baseUrl || provider.defaults.baseUrl,
        endpoint: bucket.endpoint || provider.defaults.endpoint,
        model,
        // 明确告诉下游用哪个密钥槽位，避免再靠 URL 猜服务商
        secretName: provider.secret[0].slot,
      };
      if (kind === "video") {
        const spec = (schemaModel(kind, provider.id, model)?.params || []).find(item => item.key === "resolution");
        const picked = spec ? String(cfgParamValue(kind, provider.id, model, spec) || "") : "";
        // 混元目前只出 720p，其余通道按用户选择；没选过沿用老的 1080p 默认。
        next.imageToVideoModel = model;
        next.resolution = provider.vendor === "tencent" ? "720p" : (picked === "720p" ? "720p" : "1080p");
        const freeOnly = document.querySelector("#video-free-tier-only");
        if (freeOnly) next.freeTierOnlyConfirmed = freeOnly.checked;
        const priceInput = document.querySelector("#video-price-per-second");
        if (priceInput) {
          // 单价留空就是「不估算」，不能当成 0 —— 0 会让用户以为生成免费。
          const raw = String(priceInput.value || "").trim();
          next.pricePerSecond = raw === "" ? null : Math.max(0, Number(raw) || 0);
        }
      }
      state.settings.providers[kind] = next;
    });
    // 打过标记之后，重开应用不再用「预设漂移就重置」的老规则覆盖界面里的配置。
    state.settings.vendorsManaged = true;
  };

  const collectSettings = (notify = true) => {
    const adjustedKeys = readSettingsDom();
    applyVendorsToProviders();
    persist(); saveSecrets(); saveSecretOrigins();
    if (adjustedKeys.length) {
      showToast(`${adjustedKeys.join("、")} Key 里混入了中文/全角字符，已自动移除这些干扰字符；若验证仍失败，请回控制台重新复制密钥。`, true);
    } else if (notify) showToast("模型配置已保存。");
  };

  const download = (name, text, type = "application/json") => {
    const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
    const link = document.createElement("a"); link.href = url; link.download = name; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const packagingDimension = () => {
    const format = getProject().format || "9:16";
    // 成片分辨率跟画幅走：竞品与平台交付都是 1080p 起，720p 会被平台二次压缩。
    const high = resolvePackagingResolution() === "1080";
    if (format === "16:9") return high ? { width: 1920, height: 1080, fps: 30 } : { width: 1280, height: 720, fps: 30 };
    if (format === "1:1") return { width: 1080, height: 1080, fps: 30 };
    return high ? { width: 1080, height: 1920, fps: 30 } : { width: 720, height: 1280, fps: 30 };
  };
  // 分辨率可能还没落进 episode.packaging（老项目），所以两处都读一次。
  const resolvePackagingResolution = () => {
    const raw = getEpisode().packaging?.video?.resolution;
    return raw === "720" ? "720" : "1080";
  };
  // 输入框里的值只在点按钮时读回来：这样用户改完音色/字号直接点「生成」就生效，
  // 不需要给每个控件挂 change 监听（也不会在 render() 时被重渲染打断输入）。
  const packagingForm = () => {
    const episode = getEpisode();
    const pack = normalizePackaging(episode.packaging);
    const read = (id) => document.getElementById(id)?.value;
    const num = (id, fallback, low, high) => {
      const raw = read(id);
      const parsed = Number(raw);
      if (raw === undefined || raw === null || raw === "" || Number.isNaN(parsed)) return fallback;
      return clamp(parsed, low, high);
    };
    const flag = (id, fallback) => {
      const node = document.getElementById(id);
      return node ? Boolean(node.checked) : fallback;
    };
    if (document.getElementById("pkg-voice")) pack.voice = read("pkg-voice");
    // 角色音色：只保留下拉里真正选了的，空串表示跟随默认。
    document.querySelectorAll("select[data-voice-speaker]").forEach(node => {
      const name = String(node.getAttribute("data-voice-speaker") || "").trim();
      if (!name) return;
      const value = String(node.value || "").trim();
      if (value) pack.voiceMap[name] = value;
      else delete pack.voiceMap[name];
    });
    pack.rate = num("pkg-rate", pack.rate, -40, 60);
    if (document.getElementById("pkg-tts-style")) pack.tts.style = read("pkg-tts-style") || "drama";
    pack.tts.volume = num("pkg-tts-volume", pack.tts.volume, 0, 1.5);
    pack.video.sourceVolume = num("pkg-source-volume", pack.video.sourceVolume, 0, 2);
    pack.tts.enabled = flag("pkg-tts-enabled", pack.tts.enabled);
    pack.subtitles.maxChars = Math.round(num("pkg-sub-max", pack.subtitles.maxChars, 6, 40));
    pack.subtitles.style.size = Math.round(num("pkg-sub-size", pack.subtitles.style.size, 16, 96));
    if (document.getElementById("pkg-sub-position")) pack.subtitles.style.position = read("pkg-sub-position");
    if (document.getElementById("pkg-sub-color")) pack.subtitles.style.color = read("pkg-sub-color");
    pack.subtitles.enabled = flag("pkg-sub-enabled", pack.subtitles.enabled);
    pack.subtitles.style.outline = num("pkg-sub-outline", pack.subtitles.style.outline, 0, 12);
    pack.subtitles.style.boxed = flag("pkg-sub-boxed", pack.subtitles.style.boxed);
    pack.subtitles.style.marginV = num("pkg-sub-margin", pack.subtitles.style.marginV, 0, 800);
    if (document.getElementById("pkg-sub-font")) pack.subtitles.style.font = read("pkg-sub-font");
    if (document.getElementById("pkg-sub-template")) pack.subtitles.style.template = read("pkg-sub-template") || "plain";
    pack.bgm.volume = num("pkg-bgm-volume", pack.bgm.volume, 0, 1);
    pack.bgm.fadeIn = num("pkg-bgm-fadein", pack.bgm.fadeIn, 0, 8);
    pack.bgm.fadeOut = num("pkg-bgm-fadeout", pack.bgm.fadeOut, 0, 8);
    pack.bgm.enabled = flag("pkg-bgm-enabled", pack.bgm.enabled);
    pack.sfx.enabled = flag("pkg-sfx-enabled", pack.sfx.enabled);
    pack.sfx.volume = num("pkg-sfx-volume", pack.sfx.volume, 0, 1.5);
    // 手动指定的音效：每镜一个多选下拉，一个都没选就是不配。
    document.querySelectorAll("select[data-sfx-shot]").forEach(node => {
      const shotId = String(node.getAttribute("data-sfx-shot") || "").trim();
      if (!shotId) return;
      const picked = Array.from(node.selectedOptions || []).map(option => option.value).filter(Boolean);
      if (picked.length) pack.sfx.map[shotId] = picked;
      else delete pack.sfx.map[shotId];
    });
    if (document.getElementById("pkg-transition")) pack.video.transition = read("pkg-transition");
    pack.video.transitionDuration = num("pkg-transition-duration", pack.video.transitionDuration, 0.1, 2);
    if (document.getElementById("pkg-grade")) pack.video.grade = read("pkg-grade");
    pack.video.speed = num("pkg-speed", pack.video.speed, 0.25, 4);
    if (document.getElementById("pkg-resolution")) pack.video.resolution = read("pkg-resolution");
    if (document.getElementById("pkg-source-mode")) pack.video.sourceMode = read("pkg-source-mode");
    if (document.getElementById("pkg-fit")) pack.video.fit = read("pkg-fit");
    if (document.getElementById("pkg-cover-title") !== undefined) pack.cover.title = read("pkg-cover-title") || "";
    if (document.getElementById("pkg-cover-subtitle") !== undefined) pack.cover.subtitle = read("pkg-cover-subtitle") || "";
    episode.packaging = pack;
    return pack;
  };
  const packagingPayload = (pack) => {
    const size = packagingDimension();
    const hasVoice = pack.tts.enabled && Object.keys(pack.tts.lines || {}).length > 0;
    // 原声处理：模型视频通常自带人声（提示词里写了台词），再叠配音就会出现两句重复台词。
    // auto = 有配音就丢原声、没配音就留；keep / mute 由用户显式决定。
    const mode = pack.video.sourceMode || "auto";
    const keepSource = mode === "keep" ? true : (mode === "mute" ? false : !hasVoice);
    return {
      width: size.width, height: size.height, fps: size.fps,
      transition: pack.video.transition, transitionDuration: pack.video.transitionDuration,
      grade: pack.video.grade, speed: pack.video.speed, fit: pack.video.fit || "blur",
      subtitles: { enabled: pack.subtitles.enabled, maxChars: pack.subtitles.maxChars, style: pack.subtitles.style },
      tts: { enabled: pack.tts.enabled, lines: pack.tts.lines, volume: pack.tts.volume },
      audio: { keepSource, sourceVolume: pack.video.sourceVolume, sourceMode: mode },
      bgm: {
        enabled: pack.bgm.enabled, track: pack.bgm.track, url: pack.bgm.url,
        volume: pack.bgm.volume, fadeIn: pack.bgm.fadeIn, fadeOut: pack.bgm.fadeOut,
      },
      sfx: {
        enabled: pack.sfx.enabled, volume: pack.sfx.volume, map: pack.sfx.map || {},
      },
    };
  };
  const generateVoiceOver = async () => {
    const episode = getEpisode();
    const pack = packagingForm();
    const lines = episode.shots
      .filter(shot => String(shot.dialogue || "").trim())
      .map(shot => ({
        id: shot.id,
        text: shot.dialogue,
        duration: Number(shot.duration) || 5,
        speaker: String(shot.speaker || "").trim(),
      }));
    if (!lines.length) return showToast("还没有台词：先在分镜导演里给镜头写台词。", true);
    const speakerNames = [];
    lines.forEach(line => { if (line.speaker && !speakerNames.includes(line.speaker)) speakerNames.push(line.speaker); });
    // 没指定音色的角色统一跟随默认；服务端会按 voiceMap 逐句取音色。
    const voiceMap = { ...pack.voiceMap };
    speakerNames.forEach(name => { if (!voiceMap[name]) voiceMap[name] = pack.voice; });
    showToast(`正在合成 ${lines.length} 句配音（本机神经语音，不消耗模型额度）…`);
    try {
      const response = await fetch("/api/tts", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lines, voice: pack.voice, voiceMap, style: pack.tts.style || "drama", rate: pack.rate, pitch: pack.pitch }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || data.error || "配音失败");
      pack.tts.lines = {}; pack.tts.meta = {}; pack.tts.voices = {};
      data.lines.forEach(line => {
        pack.tts.lines[line.id] = line.url;
        pack.tts.meta[line.id] = { duration: line.duration, overrun: line.overrun, voice: line.voice, speaker: line.speaker };
        if (line.voice) pack.tts.voices[line.id] = line.voice;
      });
      // 服务端回传实际生效的映射（含回落结果），下次打开界面能看到真实分配。
      if (data.voiceMap && Object.keys(data.voiceMap).length) {
        Object.entries(data.voiceMap).forEach(([name, voice]) => {
          if (voice && voice !== pack.voice) pack.voiceMap[name] = voice;
        });
      }
      pack.tts.enabled = true;
      pack.tts.generatedAt = now();
      episode.packaging = pack;
      const voiceCount = new Set(data.lines.map(line => line.voice).filter(Boolean)).size;
      addLog(`配音完成：${data.lines.length} 句，使用 ${voiceCount} 个音色${data.usedVoices?.length ? `（${data.usedVoices.join("、")}）` : ""}。`);
      persist(); render();
      const failed = (data.failed || []).length;
      showToast(`配音完成 ${data.lines.length} 句${voiceCount > 1 ? `，${voiceCount} 个角色音色` : ""}${failed ? `，${failed} 句失败` : ""}${data.warnings?.length ? "；有台词超出镜头时长，见卡片提示" : ""}。`);
    } catch (error) {
      addLog(`配音失败：${error.message}`);
      persist(); render();
      showToast(error.message, true);
    }
  };
  const clearVoiceOver = () => {
    const episode = getEpisode();
    const pack = normalizePackaging(episode.packaging);
    pack.tts = { ...pack.tts, enabled: false, lines: {}, meta: {}, voices: {}, generatedAt: "" };
    episode.packaging = pack;
    addLog("已清空配音。");
    persist(); render();
    showToast("配音已清空。");
  };

// 自动分配角色音色：能判出性别就按性别取音色（女主女声、男主男声），
// 判不出就按男女使用次数少的那个补，保证不同角色不是同一个声音。
const FEMALE_WORDS = ["女", "母", "姐", "妹", "娘", "妻", "姑娘", "女儿", "少女"];
const MALE_WORDS = ["男", "父", "哥", "弟", "爷", "夫", "小子", "儿子", "少年"];
// 英文必须按词边界匹配：woman 里含 man、the 里含 he，纯子串会把性别判反。
const FEMALE_EN = /\b(woman|women|female|lady|ladies|girl|girls|she|her)\b/;
const MALE_EN = /\b(man|men|male|boy|boys|guy|guys|he|his|him)\b/;
const detectSpeakerGender = (speaker) => {
  const character = (getEpisode().assets?.characters || []).find(item => String(item.name || "").trim() === speaker);
  const text = character ? `${character.note || ""} ${character.prompt || ""}`.toLowerCase() : "";
  const female = FEMALE_WORDS.some(word => text.includes(word)) || FEMALE_EN.test(text);
  const male = MALE_WORDS.some(word => text.includes(word)) || MALE_EN.test(text);
  if (female && !male) return "female";
  if (male && !female) return "male";
  return "";
};

const autoAssignVoices = () => {
    const episode = getEpisode();
    // 先把表单里其它没保存的改动收进来，避免这一下点击把语速、音量之类的设置抹掉。
    const pack = packagingForm();
    const names = [];
    episode.shots.forEach(shot => {
      const name = String(shot.speaker || "").trim();
      if (name && String(shot.dialogue || "").trim() && !names.includes(name)) names.push(name);
    });
    if (!names.length) return showToast("本集还没有带说话人的台词，无法分配角色音色。", true);
    const female = PACKAGING_VOICES.filter(([, , gender]) => gender === "female").map(([id]) => id);
    const male = PACKAGING_VOICES.filter(([, , gender]) => gender === "male").map(([id]) => id);
    const used = new Set();
    const counters = { female: 0, male: 0 };
    const take = (pool, fallback) => {
      const free = pool.find(id => !used.has(id));
      if (free) { used.add(free); return free; }
      return pool[0] || fallback;
    };
    names.forEach(name => {
      let gender = detectSpeakerGender(name);
      if (gender !== "female" && gender !== "male") {
        gender = counters.female <= counters.male ? "female" : "male";
      }
      const pool = gender === "female" ? female : male;
      pack.voiceMap[name] = take(pool, pool[0]);
      counters[gender] += 1;
    });
    episode.packaging = pack;
    addLog(`已自动分配 ${names.length} 个角色的音色。`);
    persist(); render();
    showToast(`已为 ${names.length} 个角色分配不同音色。`);
  };
  const buildSubtitles = async () => {
    const episode = getEpisode();
    if (!episode.shots.length) return showToast("还没有分镜。", true);
    const pack = packagingForm();
    const size = packagingDimension();
    const shots = episode.shots.map(shot => ({ id: shot.id, dialogue: shot.dialogue || "", duration: Number(shot.duration) || 5 }));
    try {
      const response = await fetch("/api/subtitles", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shots, speed: pack.video.speed, transition: pack.video.transition,
          transitionDuration: pack.video.transitionDuration, maxChars: pack.subtitles.maxChars,
          style: pack.subtitles.style, width: size.width, height: size.height,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || data.error || "字幕生成失败");
      pack.subtitles.cues = data.cues || [];
      pack.subtitles.srt = data.srt || "";
      pack.subtitles.generatedAt = now();
      pack.subtitles.enabled = Boolean(data.count);
      episode.packaging = pack;
      addLog(`字幕已生成：${data.count} 条。`);
      persist(); render();
      showToast(data.count ? `字幕 ${data.count} 条已就绪（与 ${data.duration}s 成片轴对齐）。` : "台词都是空的，没有可生成的字幕。", !data.count);
    } catch (error) {
      addLog(`字幕生成失败：${error.message}`);
      persist(); render();
      showToast(error.message, true);
    }
  };
  const downloadSubtitle = () => {
    const episode = getEpisode();
    const pack = normalizePackaging(episode.packaging);
    if (!pack.subtitles.srt) return showToast("先生成字幕，再下载 SRT。", true);
    download(`${getProject().name}-${episode.title}.srt`, pack.subtitles.srt, "text/plain");
    showToast("SRT 已开始下载。");
  };
  // ---------------------------------------------------------------- 音效库
  // 试听：直接播后端给的文件地址，播完就停，不进合成管线。
  const previewSfx = async (id) => {
    try {
      const response = await fetch("/api/sfx-library");
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || data.error || "音效库读取失败");
      const item = (data.items || []).find(entry => entry.id === id);
      if (!item) throw new Error("没找到这个音效。");
      const audio = new Audio(item.url);
      audio.volume = 1;
      await audio.play().catch(() => {});
    } catch (error) {
      showToast(error.message || "音效试听失败。", true);
    }
  };
  // 自动匹配：按镜头画面描述挑音效，只给有命中的镜头分配。
  const autoMatchSfx = () => {
    const episode = getEpisode();
    const pack = packagingForm();
    let hit = 0;
    episode.shots.forEach(shot => {
      const ids = matchSfxForShot(shot);
      if (!ids.length) return;
      hit += 1;
      pack.sfx.map[shot.id] = ids;
    });
    pack.sfx.auto = true;
    episode.packaging = pack;
    addLog(`音效自动匹配：${hit}/${episode.shots.length} 个镜头命中。`);
    persist(); render();
    showToast(hit ? `已为 ${hit} 个镜头自动匹配音效。` : "没有匹配到音效：镜头描述里再写点动作词（例如「推门」「开枪」）。", !hit);
  };
  const clearSfx = () => {
    const episode = getEpisode();
    const pack = packagingForm();
    pack.sfx.map = {};
    pack.sfx.auto = false;
    episode.packaging = pack;
    addLog("已清空镜头音效。");
    persist(); render();
    showToast("镜头音效已清空。");
  };
  const removeSfxFromShot = (shotId) => {
    const episode = getEpisode();
    const pack = packagingForm();
    delete pack.sfx.map[shotId];
    episode.packaging = pack;
    persist(); render();
  };
  const generateCover = async () => {
    const episode = getEpisode();
    const pack = packagingForm();
    const frameSource = episode.shots.find(shot => shot.qc?.firstFrameUrl)?.qc?.firstFrameUrl
      || episode.shots.find(shot => shot.firstFrameUrl)?.firstFrameUrl || "";
    const title = (pack.cover.title || getProject().name || "").trim();
    const subtitle = (pack.cover.subtitle || episode.title || "").trim();
    showToast("正在用第一镜首帧排版封面…");
    try {
      const response = await fetch("/api/cover", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ frame: frameSource, title, subtitle, width: 1080, height: 1920, watermark: episode.title }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || data.error || "封面生成失败");
      pack.cover.url = data.url;
      pack.cover.generatedAt = now();
      episode.packaging = pack;
      addLog("封面已生成（1080×1920）。");
      persist(); render();
      showToast(data.usedFrame ? "封面已生成，取的是第一镜首帧。" : "首帧还没出，已用深色底生成封面。");
    } catch (error) {
      addLog(`封面生成失败：${error.message}`);
      persist(); render();
      showToast(error.message, true);
    }
  };
  // ---------------------------------------------------------------- 局部重绘
  // 竞品（即梦 / 小云雀）的局部重绘：框一块区域 + 写一句描述，只改这块，其余画面不动。
  // 图片模型本身不吃蒙版，所以流程是：本地裁选区 → 送模型重绘 → 按遮罩羽化融合回原图。
  const INPAINT_MODES = [
    { id: "replace", label: "替换物体", instruction: "把选区里的主体替换成新的物件，材质、比例与视角要和周围一致" },
    { id: "remove", label: "移除物体", instruction: "移除选区里的物体，用周围环境自然补全，纹理与光影连续，不要留下痕迹" },
    { id: "detail", label: "补全细节", instruction: "补全选区里缺失或破损的细节，让边缘、纹理和光影与相邻区域自然衔接" },
  ];
  // 按裁切图比例算一个出图尺寸：模型出图比例不一致时，融合会被拉伸。
  const inpaintSizeFor = (vendor, width, height) => {
    const area = 1024 * 1024;
    const scale = Math.sqrt(area / Math.max(1, width * height));
    let w = Math.round((width * scale) / 8) * 8;
    let h = Math.round((height * scale) / 8) * 8;
    w = Math.min(1536, Math.max(512, w));
    h = Math.min(1536, Math.max(512, h));
    return vendor === "dashscope" ? `${w}*${h}` : `${w}x${h}`;
  };
  const openInpaintEditor = (shotId, frameType = "start") => {
    const episode = getEpisode();
    const shot = episode.shots.find(item => item.id === shotId);
    if (!shot) return;
    const source = frameType === "end" ? shot.lastFrameUrl : shot.firstFrameUrl;
    if (!source) return showToast("这个镜头还没有可重绘的图。", true);
    const cfg = state.settings.providers.image;
    // 智谱 cogview 只有文生图，没有参考图入口：没有参考图就没有「局部」，会整张重画。
    if (cfg.vendor === "zhipu") {
      return showToast("当前图片通道（智谱）只支持文生图。局部重绘需要能带参考图的通道，请到「模型配置」切成万相或方舟。", true);
    }
    document.querySelector("#inpaint-modal")?.remove();
    const wrapper = document.createElement("div");
    wrapper.id = "inpaint-modal";
    wrapper.className = "modal-backdrop";
    const label = frameType === "end" ? "尾帧" : "首帧";
    wrapper.innerHTML = `<section class="modal inpaint-modal" role="dialog" aria-modal="true" aria-label="局部重绘">
      <div class="panel-title"><div><span class="badge">局部重绘</span><h3>镜头「${esc(shot.title)}」· ${label}</h3></div><button class="btn ghost" data-inpaint-close>关闭</button></div>
      <div class="inpaint-body">
        <div class="inpaint-stage" data-inpaint-stage>
          <img class="inpaint-image" src="${esc(source)}" alt="待重绘的${label}" data-inpaint-image>
          <canvas class="inpaint-canvas" data-inpaint-canvas></canvas>
          <div class="inpaint-badge" data-inpaint-hint>在图上涂抹要重绘的区域</div>
        </div>
        <aside class="inpaint-side">
          <div class="form-group"><label>操作类型</label>
            <div class="inpaint-modes">${INPAINT_MODES.map((mode, index) => `<button type="button" class="chip ${index === 0 ? "active" : ""}" data-inpaint-mode="${esc(mode.id)}">${esc(mode.label)}</button>`).join("")}</div>
          </div>
          <div class="form-group"><label>要改成什么</label>
            <textarea id="inpaint-prompt" class="textarea small-area" placeholder="例如：把这只手换成握紧的拳头"></textarea>
            <small class="hint">写清楚目标物件或状态；不写也能生成，但模型会按画面语境自由发挥。</small>
          </div>
          <div class="form-group"><label>画笔大小 <b data-inpaint-brush-value>56</b> px</label><input id="inpaint-brush" type="range" min="8" max="240" step="4" value="56"></div>
          <div class="form-group"><label>边缘羽化 <b data-inpaint-feather-value>12</b> px</label><input id="inpaint-feather" type="range" min="0" max="40" step="2" value="12"></div>
          <div class="pkg-actions">
            <button type="button" class="btn tiny ghost" data-inpaint-undo>撤销一笔</button>
            <button type="button" class="btn tiny ghost" data-inpaint-clear>清空选区</button>
          </div>
          <p class="hint">只有涂抹到的像素会被改动，其余部分保持原样。这一步会调用一次图片模型（消耗额度）。</p>
        </aside>
      </div>
      <div class="modal-actions"><button class="btn ghost" data-inpaint-close>取消</button><button class="btn primary" data-inpaint-run>生成重绘</button></div>
    </section>`;
    document.body.appendChild(wrapper);
    const close = () => wrapper.remove();
    wrapper.querySelectorAll("[data-inpaint-close]").forEach(node => node.addEventListener("click", close));
    wrapper.addEventListener("click", event => { if (event.target === wrapper) close(); });
    setupInpaintCanvas(wrapper, source, shot, frameType);
  };
  // 画布遮罩：笔迹按矢量记录，撤销只要丢掉最后一笔，不用缓存整张位图。
  const setupInpaintCanvas = (wrapper, source, shot, frameType) => {
    const image = wrapper.querySelector("[data-inpaint-image]");
    const canvas = wrapper.querySelector("[data-inpaint-canvas]");
    const stage = wrapper.querySelector("[data-inpaint-stage]");
    const hint = wrapper.querySelector("[data-inpaint-hint]");
    const brushInput = wrapper.querySelector("#inpaint-brush");
    const featherInput = wrapper.querySelector("#inpaint-feather");
    const brushValue = wrapper.querySelector("[data-inpaint-brush-value]");
    const featherValue = wrapper.querySelector("[data-inpaint-feather-value]");
    const context = canvas.getContext("2d");
    const strokes = [];
    let current = null;
    const brush = () => Number(brushInput.value) || 56;
    const feather = () => Number(featherInput.value) || 0;
    // 画布要跟图片像素级对齐：容器比图片宽时（竖图放进宽容器），
    // 画布铺满容器会让涂抹坐标整体偏移，遮罩落到画面之外。
    // 这里按图片的实际显示框给画布定位，尺寸用 JS 算，CSS 不猜。
    const syncCanvas = () => {
      const imageBox = image.getBoundingClientRect();
      const stageBox = stage.getBoundingClientRect();
      if (!imageBox.width || !imageBox.height) return;
      canvas.style.left = `${imageBox.left - stageBox.left}px`;
      canvas.style.top = `${imageBox.top - stageBox.top}px`;
      canvas.style.width = `${imageBox.width}px`;
      canvas.style.height = `${imageBox.height}px`;
    };
    const paint = () => {
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.strokeStyle = "rgba(255,255,255,1)";
      context.fillStyle = "rgba(255,255,255,1)";
      context.lineCap = "round";
      context.lineJoin = "round";
      strokes.forEach(stroke => {
        context.lineWidth = stroke.size;
        if (stroke.points.length === 1) {
          context.beginPath();
          context.arc(stroke.points[0].x, stroke.points[0].y, stroke.size / 2, 0, Math.PI * 2);
          context.fill();
          return;
        }
        context.beginPath();
        stroke.points.forEach((point, index) => {
          if (index === 0) context.moveTo(point.x, point.y);
          else context.lineTo(point.x, point.y);
        });
        context.stroke();
      });
    };
    const pointFrom = event => {
      const rect = canvas.getBoundingClientRect();
      return {
        x: (event.clientX - rect.left) * (canvas.width / Math.max(1, rect.width)),
        y: (event.clientY - rect.top) * (canvas.height / Math.max(1, rect.height)),
      };
    };
    const applySize = () => {
      canvas.width = image.naturalWidth || image.width || 1024;
      canvas.height = image.naturalHeight || image.height || 1024;
      syncCanvas();
      paint();
    };
    image.addEventListener("load", applySize);
    if (image.complete && image.naturalWidth) applySize();
    window.addEventListener("resize", syncCanvas);
    canvas.addEventListener("pointerdown", event => {
      event.preventDefault();
      canvas.setPointerCapture(event.pointerId);
      current = { size: brush(), points: [pointFrom(event)] };
      strokes.push(current);
      paint();
      if (hint) hint.textContent = "已选区，继续涂抹可加选";
    });
    canvas.addEventListener("pointermove", event => {
      if (!current) return;
      event.preventDefault();
      current.points.push(pointFrom(event));
      paint();
    });
    const finish = () => { current = null; };
    canvas.addEventListener("pointerup", finish);
    canvas.addEventListener("pointercancel", finish);
    canvas.addEventListener("pointerleave", finish);
    brushInput.addEventListener("input", () => { brushValue.textContent = brushInput.value; });
    featherInput.addEventListener("input", () => { featherValue.textContent = featherInput.value; });
    wrapper.querySelector("[data-inpaint-undo]").addEventListener("click", () => {
      strokes.pop();
      paint();
      if (hint) hint.textContent = strokes.length ? "已选区，继续涂抹可加选" : "在图上涂抹要重绘的区域";
    });
    wrapper.querySelector("[data-inpaint-clear]").addEventListener("click", () => {
      strokes.length = 0;
      paint();
      if (hint) hint.textContent = "在图上涂抹要重绘的区域";
    });
    let mode = INPAINT_MODES[0].id;
    wrapper.querySelectorAll("[data-inpaint-mode]").forEach(node => node.addEventListener("click", () => {
      mode = node.dataset.inpaintMode;
      wrapper.querySelectorAll("[data-inpaint-mode]").forEach(item => item.classList.toggle("active", item === node));
    }));
    wrapper.querySelector("[data-inpaint-run]").addEventListener("click", async event => {
      const runButton = event.currentTarget;
      if (!strokes.length) return showToast("先在图上涂抹要重绘的区域。", true);
      const promptText = (wrapper.querySelector("#inpaint-prompt")?.value || "").trim();
      const instruction = (INPAINT_MODES.find(item => item.id === mode) || INPAINT_MODES[0]).instruction;
      runButton.disabled = true;
      runButton.textContent = "重绘中…";
      try {
        const maskDataUrl = canvas.toDataURL("image/png");
        const result = await runInpaintPipeline({ shot, frameType, source, maskDataUrl, promptText, instruction, feather: feather() });
        wrapper.remove();
        persist(); render();
        showToast(result);
      } catch (error) {
        runButton.disabled = false;
        runButton.textContent = "生成重绘";
        showToast(error.message, true);
      }
    });
  };
  // 三步管线：取景 → 模型重绘 → 融合回原图。
  const runInpaintPipeline = async ({ shot, frameType, source, maskDataUrl, promptText, instruction, feather }) => {
    const cfg = state.settings.providers.image;
    const vendor = cfg.vendor || "ark";
    const prepareResponse = await fetch("/api/inpaint/prepare", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: source, mask: maskDataUrl }),
    });
    const prepared = await prepareResponse.json();
    if (!prepareResponse.ok) throw new Error(prepared.detail || prepared.error || "取景失败");
    const cropSize = prepared.size || [1024, 1024];
    const fullPrompt = [
      buildProductionPrompt(shot),
      instruction,
      promptText ? `具体要求：${promptText}` : "",
      "只重绘图中这一处区域，画面其余部分、人物身份、服装与光线保持不变。",
    ].filter(Boolean).join("\n");
    const payload = await imagePayloadOf(fullPrompt, { refs: [prepared.cropUrl] });
    const inpaintSize = inpaintSizeFor(vendor, cropSize[0], cropSize[1]);
    if (vendor === "dashscope") payload.parameters = { ...(payload.parameters || {}), size: inpaintSize };
    else payload.size = inpaintSize;
    const data = await proxyRequest("image", payload);
    const { source: resultSource, isData } = imageResult(data);
    if (!resultSource) throw new Error("图片接口未返回重绘结果");
    const resultLocal = await persistMedia(isData ? { dataUrl: resultSource, name: `inpaint-result-${shot.id}` } : { sourceUrl: resultSource, name: `inpaint-result-${shot.id}` });
    const mergeResponse = await fetch("/api/inpaint/merge", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: source, mask: maskDataUrl, result: resultLocal, feather }),
    });
    const merged = await mergeResponse.json();
    if (!mergeResponse.ok) throw new Error(merged.detail || merged.error || "合成失败");
    const finalLocal = await persistMedia({ sourceUrl: merged.url, name: `inpaint-${frameType}-${shot.id}` });
    if (frameType === "end") shot.lastFrameUrl = finalLocal;
    else { shot.firstFrameUrl = finalLocal; shot.chainSourceShotId = ""; shot.firstFrameOrigin = "inpaint"; }
    shot.qc = null;
    addLog(`镜头「${shot.title}」${frameType === "end" ? "尾帧" : "首帧"}局部重绘完成（模型 ${cfg.model}）。`);
    return "局部重绘完成，未选中的像素保持原样。";
  };
  const exportJianyingDraft = async () => {
    const episode = getEpisode();
    const pack = packagingForm();
    const size = packagingDimension();
    const shots = episode.shots
      .filter(shot => shot.mediaUrl)
      .map(shot => ({ id: shot.id, url: shot.mediaUrl, dialogue: shot.dialogue || "" }));
    if (!shots.length) return showToast("还没有生成任何镜头。", true);
    showToast("正在打包剪映草稿（视频 + 字幕 + 配音 + BGM 四条轨）…");
    try {
      const response = await fetch("/api/draft-export", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `${getProject().name}-${episode.title}`,
          width: size.width, height: size.height, fps: size.fps, speed: pack.video.speed,
          shots,
          subtitles: { enabled: true, maxChars: pack.subtitles.maxChars, style: pack.subtitles.style },
          tts: { enabled: pack.tts.enabled, lines: pack.tts.lines },
          bgm: { enabled: pack.bgm.enabled, track: pack.bgm.track, url: pack.bgm.url, volume: pack.bgm.volume },
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || data.error || "草稿导出失败");
      const link = document.createElement("a");
      link.href = data.url; link.download = ""; link.click();
      addLog(`剪映草稿已导出：${data.shots} 镜 / ${data.subtitles} 条字幕 / ${data.tts} 条配音。`);
      persist(); render();
      showToast(`草稿包已生成：${data.shots} 镜 · ${data.subtitles} 条字幕 · ${data.tts} 条配音${data.bgm ? " · 含 BGM" : ""}。`);
    } catch (error) {
      addLog(`草稿导出失败：${error.message}`);
      persist(); render();
      showToast(error.message, true);
    }
  };
  const renderMasterVideo = async () => {
    const episode = getEpisode();
    const selected = episode.shots.filter(shot => shot.selected);
    const missing = selected.filter(shot => !shot.mediaUrl);
    const qcFailed = selected.filter(shot => shot.mediaUrl && !shot.qc?.passed);
    if (!selected.length) return showToast("请先在分镜导演页勾选要成片的镜头。", true);
    if (missing.length) return showToast(`还有 ${missing.length} 个入片镜头没有视频：${missing.map(shot => shot.title).join("、")}`, true);
    if (qcFailed.length) return showToast(`还有 ${qcFailed.length} 个入片镜头质检未通过：${qcFailed.map(shot => shot.title).join("、")}。请重做或人工验收。`, true);
    const pack = packagingForm();
    // 有台词却没有可用配音时，交付中心会安静地合成一条无声成片——这是上一版成片
    // “没有配音”的直接原因。出片前必须明确告诉用户，而不是等播放时才发现。
    const dialogueShots = selected.filter(shot => String(shot.dialogue || "").trim());
    const ttsReady = pack.tts.enabled && Object.keys(pack.tts.lines || {}).length > 0;
    if (dialogueShots.length && !ttsReady) {
      addLog(`成片警告：${dialogueShots.length} 个镜头有台词但未生成配音（或配音开关关闭），本次输出为无声片。`);
      showToast(`有 ${dialogueShots.length} 个镜头带台词，但还没有可用配音，本次将合成无声成片。请先到「后期包装 · 配音 TTS」点「生成配音」。`, true);
    }
    const packaging = packagingPayload(pack);
    // 只合成勾选的镜头，按分镜顺序；未勾选的镜头留在探索区，不进入正片。
    const clips = selected.map(shot => ({ url: shot.mediaUrl, shotId: shot.id, dialogue: shot.dialogue || "", duration: Number(shot.duration || 0) }));
    const notes = [
      pack.subtitles.enabled ? "烧字幕" : "",
      pack.tts.enabled && Object.keys(pack.tts.lines).length ? "混配音" : "",
      pack.bgm.enabled ? "混 BGM" : "",
      pack.video.transition !== "none" ? "加转场" : "",
      pack.video.grade !== "none" ? "调色" : "",
    ].filter(Boolean).join(" · ") || "纯拼接";
    showToast(`正在本地合成成片（${notes}），不调用模型、不计费…`);
    try {
      const started = Date.now();
      const response = await fetch("/api/render-master", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clips, name: `${getProject().name}-${episode.title}-master`, packaging }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || data.error || "成片合成失败");
      const result = data.packaging || {};
      const warnings = Array.isArray(data.warnings) ? data.warnings : [];
      const deliveryEntry = {
        mediaUrl: data.url,
        title: `${getProject().name} · ${episode.title}`,
        model: "本地 ffmpeg",
        note: `${data.clipCount} 镜 · ${data.duration}s · ${result.size || ""} · 字幕 ${result.subtitles || 0} 条 · 配音 ${result.tts || 0} 条${result.bgm ? " · 含 BGM" : ""}${result.grade && result.grade !== "none" ? " · 已调色" : ""}${result.keepSource === false ? " · 已丢弃模型原声" : ""}；未调用模型。`,
        renderedAt: now(),
        shotIds: selected.map(shot => shot.id),
      };
      episode.delivery = deliveryEntry;
      // 旧版本不覆盖：每次合片都进历史列表（新→旧），最多保留 20 条记录（文件仍留在磁盘）。
      episode.deliveryHistory = [deliveryEntry, ...(Array.isArray(episode.deliveryHistory) ? episode.deliveryHistory : []).filter(item => item && item.mediaUrl !== deliveryEntry.mediaUrl)].slice(0, 20);
      warnings.forEach(item => addLog(`成片提示：${item}`));
      addLog(`成片已合成：${notes}。`, { model: "local-ffmpeg", durationMs: Date.now() - started });
      persist(); render();
      showToast(warnings.length ? `成片合成完成，但有 ${warnings.length} 条提示需要确认。` : "成片合成完成。", warnings.length > 0);
    } catch (error) {
      addLog(`成片合成失败：${error.message}`);
      persist(); render();
      showToast(error.message, true);
    }
  };

  const exportJson = () => {
    const project = getProject();
    const payload = { schema: "xinghe-commercial-project-v1", exportedAt: now(), project, modelConfig: state.settings.providers };
    download(`${project.name}-项目.json`, JSON.stringify(payload, null, 2)); addLog("导出完整项目 JSON（不含 API Key）。"); persist();
  };

  const exportCsv = () => {
    const episode = getEpisode();
    const cells = value => `"${String(value ?? "").replaceAll('"','""')}"`;
    const rows = [["序号","标题","动作","台词角色","角色台词","绑定角色","场景","帧链来源","质检","机位","时长","状态","提示词"], ...episode.shots.map((shot,index)=>[
      index+1,shot.title,shot.action,shot.speaker||"",shot.dialogue||"",
      shot.characterIds.map(id=>episode.assets.characters.find(item=>item.id===id)?.name||id).join("|"),
      episode.assets.scenes.find(item=>item.id===shot.sceneId)?.name||"",shot.chainSourceShotId||"",
      shot.qc ? (shot.qc.passed ? "通过" : "未通过") : "未质检",shot.camera,shot.duration,shot.status,buildProductionPrompt(shot)
    ])];
    download(`${getProject().name}-${episode.title}-分镜.csv`, "\ufeff" + rows.map(row=>row.map(cells).join(",")).join("\n"), "text/csv"); addLog("导出分镜 CSV。"); persist();
  };

  const exportPrompts = () => {
    const episode = getEpisode();
    const sections = ["# 资产提示词", ...Object.entries(episode.assets).flatMap(([type,list])=>list.map(item=>`[${type}] ${item.name}\n${item.prompt}\n定妆图：${item.referenceImage || "缺失"}${type==="characters"?`\n九宫格：${item.turnaround?.imageUrl || "缺失"}\n九宫格质检：${item.turnaround?.qc?.passed?"通过":"未通过"}`:""}`)), "\n# 分镜生产提示词", ...episode.shots.map((shot,index)=>`S${String(index+1).padStart(2,"0")} ${shot.title}\n${buildProductionPrompt(shot)}`)];
    download(`${getProject().name}-${episode.title}-提示词包.txt`, sections.join("\n\n"), "text/plain"); addLog("导出提示词包。"); persist();
  };

  const secondsToTc = value => { const frames=Math.round(Number(value||0)*25);const ff=frames%25;const seconds=Math.floor(frames/25);const ss=seconds%60;const minutes=Math.floor(seconds/60);const mm=minutes%60;const hh=Math.floor(minutes/60);return [hh,mm,ss,ff].map(item=>String(item).padStart(2,"0")).join(":"); };
  const exportEdl = () => {
    const episode=getEpisode();let cursor=0;const lines=[`TITLE: ${getProject().name} - ${episode.title}`,"FCM: NON-DROP FRAME",""];
    episode.shots.forEach((shot,index)=>{const start=cursor;const end=cursor+Number(shot.duration||0);lines.push(`${String(index+1).padStart(3,"0")}  AX       V     C        ${secondsToTc(0)} ${secondsToTc(shot.duration)} ${secondsToTc(start)} ${secondsToTc(end)}`,`* FROM CLIP NAME: ${shot.title}`,`* MEDIA: ${shot.mediaUrl||"MISSING"}`,"");cursor=end;});
    download(`${getProject().name}-${episode.title}.edl`,lines.join("\n"),"text/plain");addLog("导出 EDL 剪辑决策表。");persist();
  };
  const xmlEsc = value => String(value||"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll('"',"&quot;");
  const exportXml = () => {
    const episode=getEpisode();let offset=0;const clips=episode.shots.map((shot,index)=>{const duration=Math.max(1,Math.round(Number(shot.duration||1)*25));const node=`<asset-clip name="${xmlEsc(shot.title)}" ref="r${index+2}" offset="${Math.round(offset*25)}/25s" duration="${duration}/25s" start="0s"/>`;offset+=Number(shot.duration||0);return node;});
    const resources=episode.shots.map((shot,index)=>`<asset id="r${index+2}" name="${xmlEsc(shot.title)}" src="${xmlEsc(shot.mediaUrl||"file:///MISSING")}" duration="${Math.max(1,Math.round(Number(shot.duration||1)*25))}/25s" hasVideo="1"/>`).join("");
    const xml=`<?xml version="1.0" encoding="UTF-8"?><fcpxml version="1.10"><resources><format id="r1" name="FFVideoFormat1080p25" frameDuration="1/25s" width="${getProject().format==="9:16"?1080:1920}" height="${getProject().format==="9:16"?1920:1080}"/>${resources}</resources><library><event name="${xmlEsc(getProject().name)}"><project name="${xmlEsc(episode.title)}"><sequence format="r1" duration="${Math.max(1,Math.round(offset*25))}/25s" tcStart="0s" tcFormat="NDF"><spine>${clips.join("")}</spine></sequence></project></event></library></fcpxml>`;
    download(`${getProject().name}-${episode.title}.fcpxml`,xml,"application/xml");addLog("导出 FCPXML 时间轴；媒体路径需在剪辑软件内核对。");persist();
  };
  const exportAssetManifest = () => {
    const episode=getEpisode();const assets=Object.entries(episode.assets).flatMap(([type,list])=>list.flatMap(item=>[{type,name:item.name,role:"reference",url:item.referenceImage||""},...(type==="characters"?[{type,name:item.name,role:"turnaround",url:item.turnaround?.imageUrl||""},...(item.variations||[]).map(value=>({type,name:`${item.name}-${value.name}`,role:"wardrobe",url:value.referenceImage||""}))]:[])]));
    const shots=episode.shots.flatMap((shot,index)=>[{type:"shot",name:`S${String(index+1).padStart(2,"0")}-${shot.title}`,role:"start-frame",url:shot.firstFrameUrl||""},{type:"shot",name:`S${String(index+1).padStart(2,"0")}-${shot.title}`,role:"end-frame",url:shot.lastFrameUrl||""},{type:"shot",name:`S${String(index+1).padStart(2,"0")}-${shot.title}`,role:"video",url:shot.mediaUrl||""}]);
    download(`${getProject().name}-${episode.title}-源素材清单.json`,JSON.stringify({schema:"xinghe-source-manifest-v1",exportedAt:now(),assets:[...assets,...shots]},null,2));addLog("导出源素材清单。");persist();
  };

  const importProject = async (file) => {
    try {
      const data = JSON.parse(await file.text());
      const project = data.project || data;
      if (!project?.name || !Array.isArray(project.episodes)) throw new Error("不是有效的星河制片台项目文件");
      project.id = uid("project"); project.createdAt = now(); project.updatedAt = now();
      project.episodes.forEach(ep => { ep.id ||= uid("episode"); ep.assets ||= { characters:[], scenes:[], props:[] }; ep.beats ||= []; ep.shots ||= []; ep.tasks ||= []; ep.logs ||= []; });
      state.projects.push(project); state.currentProjectId = project.id; state.currentEpisodeId = project.episodes[0]?.id;
      normalizeState(state); persist(); currentView = "dashboard"; render(); showToast("项目导入成功。");
    } catch (error) { showToast(error.message, true); }
  };

  const bind = () => {
    // 缩略图文件缺失时退回占位符：不然浏览器会画出裂图图标，还把 alt 标题铺满整个画框。
    app.querySelectorAll(".shot-frame img").forEach(node => {
      node.addEventListener("error", () => {
        const frame = node.closest(".shot-frame");
        node.remove();
        if (frame && !frame.querySelector(".frame-empty")) frame.insertAdjacentHTML("beforeend", '<span class="frame-empty">▱</span>');
      }, { once: true });
    });
    // 预览解码失败（转码不可用、文件损坏）时给出可执行的下一步，而不是留一块黑屏。
    app.querySelectorAll("video").forEach(node => {
      node.addEventListener("error", () => {
        const message = node.dataset.previewFallback || "该视频在内嵌浏览器里无法解码，可在交付页用「系统播放器打开」查看原始文件。";
        showToast(message, true);
      }, { once: true });
    });
    document.querySelectorAll("[data-action]").forEach(node => node.addEventListener("click", async event => {
      const button = event.currentTarget; const action = button.dataset.action;
      if (action === "nav") { currentView = button.dataset.view; render(); }
      if (action === "new-project") {
        const name = window.prompt("项目名称", "新漫剧项目"); if (!name?.trim()) return;
        const project = makeDemoProject(); project.name = name.trim(); project.episodes[0].title = "EP01"; project.episodes[0].script = ""; project.episodes[0].beats=[]; project.episodes[0].assets={characters:[],scenes:[],props:[]}; project.episodes[0].shots=[]; project.episodes[0].tasks=[]; project.episodes[0].logs=[];
        state.projects.push(project); state.currentProjectId=project.id; state.currentEpisodeId=project.episodes[0].id; persist(); currentView="script"; render();
      }
      if (action === "open-project") { state.currentProjectId=button.dataset.id; state.currentEpisodeId=getProject().episodes[0]?.id; persist(); render(); }
      if (action === "rename-project") {
        event.stopPropagation(); // 卡片整体是 open-project 热区，改名按钮不能连带打开项目
        const target = state.projects.find(item => item.id === button.dataset.id) || getProject();
        if (!target) return;
        const name = window.prompt("新的项目名称", target.name);
        const next = name?.trim();
        if (!next || next === target.name) return;
        const before = target.name;
        target.name = next; target.updatedAt = new Date().toISOString();
        persist(); render(); showToast(`项目名已从「${before}」改为「${next}」。`);
      }
      if (action === "new-episode") { const title=window.prompt("剧集名称",`EP${String(getProject().episodes.length+1).padStart(2,"0")}`); if(!title?.trim())return; const ep={id:uid("episode"),title:title.trim(),script:"",beats:[],assets:{characters:[],scenes:[],props:[]},shots:[],tasks:[],logs:[]}; getProject().episodes.push(ep); state.currentEpisodeId=ep.id; persist(); currentView="script"; render(); }
      if (action === "save-script") { saveScriptFromEditor(); render(); showToast("剧本已保存。"); }
      if (action === "ai-continue-script") await aiEditScript("continue");
      if (action === "ai-rewrite-script") await aiEditScript("rewrite");
      if (action === "rollback-script") rollbackScript();
      if (action === "local-breakdown") localBreakdown();
      if (action === "ai-breakdown") await aiBreakdown();
      if (action === "seed-assets") seedAssets();
      if (action === "add-asset") addAsset(button.dataset.type);
      if (action === "upload-asset-ref") { pendingAssetImageId=button.dataset.id; pendingAssetImageKind="reference"; assetImageNode.click(); }
      if (action === "generate-asset-ref") await generateAssetReference(button.dataset.id);
      if (action === "upload-turnaround") {
        const asset=findAsset(button.dataset.id);
        if(asset?.faceRequired!==false&&!asset?.referenceImage){showToast("请先上传或生成角色定妆图。",true);}
        else {pendingAssetImageId=button.dataset.id;pendingAssetImageKind="turnaround";assetImageNode.click();}
      }
      if (action === "generate-turnaround") await generateTurnaround(button.dataset.id);
      if (action === "reprocess-turnaround") await reprocessTurnaround(button.dataset.id);
      if (action === "add-variation") addVariation(button.dataset.id);
      if (action === "generate-variation") await generateVariation(button.dataset.id,button.dataset.variationId);
      if (action === "upload-variation") { pendingAssetImageId=button.dataset.id; pendingVariationId=button.dataset.variationId; pendingAssetImageKind="variation"; assetImageNode.click(); }
      if (action === "delete-variation") deleteVariation(button.dataset.id,button.dataset.variationId);
      if (action === "generate-asset-prompt") await generateAssetPrompt(button.dataset.id,button.dataset.type);
      if (action === "edit-asset-prompt") editAssetPrompt(button.dataset.id,button.dataset.type);
      if (action === "rollback-asset-prompt") rollbackAssetPrompt(button.dataset.id);
      if (action === "save-library") saveAssetToLibrary(button.dataset.id,button.dataset.type);
      if (action === "import-library") importLibraryAsset(button.dataset.id,button.dataset.type);
      if (action === "sync-library") syncLibraryAsset(button.dataset.id,button.dataset.type);
      if (action === "copy-prompt") { const asset=Object.values(getEpisode().assets).flat().find(i=>i.id===button.dataset.id); if(asset) navigator.clipboard.writeText(asset.prompt).then(()=>showToast("提示词已复制。")); }
      if (action === "delete-asset") { const list=getEpisode().assets[button.dataset.type]; getEpisode().assets[button.dataset.type]=list.filter(i=>i.id!==button.dataset.id); persist(); render(); }
      if (action === "build-shots") buildShots();
      if (action === "open-studio") {
        studioOpen = true;
        const studio = studioState();
        const episode = getEpisode();
        const hasMaterial = Boolean(String(episode && episode.script || "").trim() || (episode && episode.beats || []).length);
        if (!studio.segments.length && !studio.seeded && hasMaterial) {
          studio.seeded = true;
          studioLocal({ quiet: true });
          showToast("已按剧本自动铺好分镜草稿（离线规则生成，未调用模型）；点「生成分镜脚本」可交给模型重写。");
        } else {
          render();
        }
      }
      if (action === "close-studio") { studioOpen = false; render(); }
      if (action === "one-click") await oneClickGenerate();
      if (action === "studio-generate") await studioGenerate();
      if (action === "studio-local") studioLocal();
      if (action === "studio-select-all") studioSelect("all");
      if (action === "studio-select-none") studioSelect("none");
      if (action === "studio-select-invert") studioSelect("invert");
      if (action === "studio-delete-selected") studioDeleteSelected();
      if (action === "studio-delete-shot") studioDeleteShot(button.dataset.id);
      if (action === "studio-regen-segment") await studioRegenerateSegment(button.dataset.id);
      if (action === "studio-regen-shot") await studioRegenerateShot(button.dataset.id);
      if (action === "studio-apply") studioApply("append");
      if (action === "studio-frames") await studioGenerateSelectedFrames();
      if (action === "studio-queue") studioQueueSelected();
      if (action === "studio-copy-prompt") { const draft = studioDrafts().find(item => item.id === button.dataset.id); if (draft) navigator.clipboard.writeText(draft.prompt).then(() => showToast("提示词已复制。")); }
      if (action === "add-shot") addShot();
      if (action === "edit-shot") editShot(button.dataset.id);
      if (action === "rollback-shot-prompt") rollbackShotPrompt(button.dataset.id);
      if (action === "upload-shot-frame") { pendingShotImageId=button.dataset.id; pendingAssetImageKind=`shot-${button.dataset.frame}`; assetImageNode.click(); }
      if (action === "generate-shot-frame") await generateShotFrame(button.dataset.id,button.dataset.frame);
      if (action === "copy-previous-frame") copyPreviousFrame(button.dataset.id);
      if (action === "prepare-shot-grid") prepareShotGrid(button.dataset.id);
      if (action === "generate-shot-grid") await generateShotGrid(button.dataset.id);
      if (action === "use-grid-panel") useGridPanel(button.dataset.id,button.dataset.index);
      if (action === "move-shot") { const list=getEpisode().shots; const index=list.findIndex(i=>i.id===button.dataset.id); const target=clamp(index+Number(button.dataset.dir),0,list.length-1); if(index!==target)[list[index],list[target]]=[list[target],list[index]]; persist(); render(); }
      if (action === "delete-shot") { getEpisode().shots=getEpisode().shots.filter(i=>i.id!==button.dataset.id); persist(); render(); }
      if (action === "queue-selected") queueSelected();
      // 走 attachment 通道拿原始 mp4，而不是预览用的 WebM 转码件。
      if (action === "download-media") downloadMedia(button.dataset.url);
      if (action === "open-media") await openMedia(button.dataset.url);
      if (action === "preview-clip") openClipPreview({ url: button.dataset.url, title: button.dataset.title, poster: button.dataset.poster });
      if (action === "run-qc") {
        const shot=getEpisode().shots.find(item=>item.id===button.dataset.id);
        if (shot) { try { await runShotQc(shot); render(); showToast(shot.qc?.passed?"质检通过。":"质检未通过，已阻止进入交付。",!shot.qc?.passed); } catch(error) { showToast(error.message,true); } }
      }
      if (action === "approve-shot") approveShot(button.dataset.id);
      if (action === "approve-selected-shots") approveSelectedShots();
      if (action === "unlock-video-model") {
        const episode = getEpisode();
        if (!episode.videoModelLock) return showToast("本集当前没有模型锁定。", true);
        const label = episode.videoModelLock.label || episode.videoModelLock.signature;
        if (!window.confirm(`解除后可以切换视频模型，但新旧镜头可能出现换脸/年龄漂移。\n当前锁定：${label}\n确定解除？`)) return;
        delete episode.videoModelLock;
        persist(); render(); showToast("已解除本集视频模型锁定。");
      }
      if (action === "shots-select") selectShots(button.dataset.mode);
      if (action === "retry-task") await retryTaskById(button.dataset.id);
      if (action === "cancel-queue") cancelQueue(button.dataset.id);
      if (action === "requalify-task") await requalifyShot(button.dataset.id);
      if (action === "server-log") openServerLog();
      // 全量重试容易再次撞限流；留一条“只跑勾选的失败镜”的手动后手。
      if (action === "retry-selected-videos") {
        const picked = getEpisode().shots.filter(shot => shot.selected);
        const targets = picked.filter(shotIsFailed);
        if (!picked.length) return showToast("请先在分镜卡片上勾选要重试的失败镜头。", true);
        if (!targets.length) return showToast("勾选的镜头里没有失败/质检未过的镜头。", true);
        const rest = getEpisode().shots.filter(shotIsFailed).length - targets.length;
        if (!window.confirm(`只重试勾选的 ${targets.length} 个失败镜头：\n${targets.map((shot, index) => `${index + 1}. ${shot.title}`).join("\n")}\n\n${rest ? `其余 ${rest} 个失败镜头保持不动。` : ""}遇到限流会自动排队等待重试。继续？`)) return;
        await submitVideos(targets);
      }
      if (action === "retry-failed-videos") {
        const targets = getEpisode().shots.filter(shotIsFailed);
        if (!targets.length) return showToast("没有失败镜头需要重试。", true);
        if (!window.confirm(`重试 ${targets.length} 个失败镜头：\n${targets.map((shot, index) => `${index + 1}. ${shot.title}`).join("\n")}\n\n将逐镜重新提交视频生成，遇到限流会自动等待重试。继续？`)) return;
        await submitVideos(targets);
      }
      if (action === "submit-image") await submitImages();
      if (action === "submit-video") await submitVideos();
      if (action === "resume-tasks") await resumePendingTasks();
      if (action === "env-alert-dismiss") { clearEnvAlert(); render(); showToast("已关闭账户提示。充值或换通道后直接重新提交即可续跑，已完成的镜头不会重复生成。"); }
      if (action === "env-alert-free") {
        // 复用设置页的通道切换：地址、端点、密钥槽位由层级表重算，避免这里再写一份。
        const alert = readEnvAlert() || {};
        const kind = alert.channel === "图片" ? "image" : "video";
        const target = schemaProviders(kind).find(item => item.vendor === (button.dataset.vendor || "zhipu"));
        currentView = "settings";
        if (!target) { render(); showToast("层级表里没有这个通道，请到「模型与设置」手动切换。", true); return; }
        activateChannel(kind, target.id, "", { silent: true });
      }
      if (action === "save-settings") collectSettings();
      if (action === "cfg-pick") {
        // 先落盘当前编辑区，再切节点：否则改了一半的输入会在重绘时丢掉。
        collectSettings(false);
        const kind = button.dataset.kind || settingsNode.kind;
        const providerId = button.dataset.provider || "";
        const modelId = button.dataset.model || "";
        const providerChanged = settingsNode.kind !== kind || settingsNode.providerId !== providerId;
        settingsNode.kind = kind;
        settingsNode.providerId = providerId;
        settingsNode.modelId = modelId;
        settingsCollapsed.delete(kind);
        if (providerId) {
          const key = kind + "/" + providerId;
          // 再点一次已展开的服务商才收起，单点一次不会把树抖来抖去。
          if (!modelId && !providerChanged && !settingsCollapsed.has(key)) settingsCollapsed.add(key);
          else if (modelId) settingsCollapsed.delete(key);
          else settingsCollapsed.delete(key);
        }
        render();
        return;
      }
      if (action === "cfg-activate") {
        collectSettings(false);
        activateChannel(button.dataset.kind, button.dataset.provider, "");
        return;
      }
      if (action === "cfg-activate-model") {
        collectSettings(false);
        activateChannel(button.dataset.kind, button.dataset.provider, button.dataset.model);
        return;
      }
      if (action === "cfg-reset-param") {
        const bucket = cfgBucket(settingsNode.kind, settingsNode.providerId);
        const modelId = settingsNode.modelId;
        if (modelId && bucket.models[modelId]) {
          delete bucket.models[modelId][button.dataset.key];
          if (!Object.keys(bucket.models[modelId]).length) delete bucket.models[modelId];
        }
        collectSettings(false); render();
        return;
      }
      if (action === "cfg-reset") {
        if (!window.confirm("恢复出厂会清空本机保存的地址、模型选择与该页所有参数（API Key 不受影响）。继续？")) return;
        const factory = defaultSettings().providers;
        state.settings.vendors = {};
        state.settings.providers = { ...factory };
        delete state.settings.vendorsSchemaVersion;
        seedVendorSettings(state);
        collectSettings(false); render();
        showToast("已恢复出厂配置。");
        return;
      }
      if (action === "cfg-toggle-all") {
        const all = [];
        MODEL_SCHEMA.modules.forEach((mod) => {
          all.push(mod.kind);
          (mod.providers || []).forEach(provider => all.push(mod.kind + "/" + provider.id));
        });
        const fullyOpen = all.every(key => !settingsCollapsed.has(key));
        settingsCollapsed.clear();
        if (fullyOpen) all.forEach(key => settingsCollapsed.add(key));
        render();
        return;
      }
      if (action === "cfg-expand") {
        const kind = button.dataset.kind;
        settingsCollapsed.delete(kind);
        schemaProviders(kind).forEach(provider => settingsCollapsed.delete(kind + "/" + provider.id));
        render();
        return;
      }
      if (action === "toggle-secret-id") {
        const input = document.querySelector(`#${button.dataset.target}`);
        if (!input) return;
        input.type = input.type === "password" ? "text" : "password";
        button.textContent = input.type === "password" ? "显示" : "隐藏";
        return;
      }
      if (action === "save-art-direction") saveArtDirection();
      if (action === "generate-art-direction") generateArtDirectionSuggestion();
      if (action === "toggle-secret") { const input=document.querySelector(`#${button.dataset.type}-key`); input.type=input.type==="password"?"text":"password"; button.textContent=input.type==="password"?"显示":"隐藏"; }
      if (action === "test-provider") await testProvider(button.dataset.type);
      if (["quick-export","export-json"].includes(action)) exportJson();
      if (action === "render-master") await renderMasterVideo();
      if (action === "use-delivery-version") {
        const episode = getEpisode();
        const entry = (Array.isArray(episode.deliveryHistory) ? episode.deliveryHistory : []).find(item => item && item.mediaUrl === button.dataset.url);
        if (!entry) { showToast("找不到这个历史版本。", true); }
        else { episode.delivery = entry; persist(); render(); showToast("已把该版本设为当前交付；成片文件未改动。"); }
      }
      if (action === "post-tts") await generateVoiceOver();
      if (action === "post-tts-clear") clearVoiceOver();
      if (action === "post-tts-auto-voice") autoAssignVoices();
      if (action === "post-subtitles") await buildSubtitles();
      if (action === "download-srt") downloadSubtitle();
      if (action === "post-cover") await generateCover();
      if (action === "post-draft") await exportJianyingDraft();
      if (action === "post-sfx-preview") await previewSfx(button.dataset.sfx);
      if (action === "post-sfx-auto") autoMatchSfx();
      if (action === "post-sfx-clear") clearSfx();
      if (action === "post-sfx-remove") removeSfxFromShot(button.dataset.shot);
      if (action === "inpaint-shot") openInpaintEditor(button.dataset.id, button.dataset.frame || "start");
      if (action === "export-csv") exportCsv();
      if (action === "export-prompts") exportPrompts();
      if (action === "export-edl") exportEdl();
      if (action === "export-xml") exportXml();
      if (action === "export-assets") exportAssetManifest();
      if (action === "import-project") importNode.click();
    }));
    document.querySelector("[data-action='episode-select']")?.addEventListener("change", event => { state.currentEpisodeId=event.target.value; persist(); render(); });
    // 粘贴即落库：很多人填完 Key 直接切到生成页，没点「保存配置」，
    // 之前就表现为「明明填了 Key，提交时却报未配置」。失焦即写入会话存储，不再依赖手动保存。
    [["image", "image-key"], ["video", "video-key"]].forEach(([type, id]) => {
      const input = document.querySelector(`#${id}`);
      if (!input) return;
      input.addEventListener("change", () => {
        const cfg = state.settings.providers[type];
        const zhipu = cfg?.vendor === "zhipu" || String(cfg?.baseUrl || "").includes("open.bigmodel.cn");
        const secretName = zhipu ? (type === "image" ? "imageZhipu" : "videoZhipu") : type;
        const cleaned = normalizeKey(input.value);
        if (!cleaned) return;
        secrets[secretName] = cleaned;
        secretOrigins[secretName] = "manual";
        const sibling = zhipuSiblingSecret(secretName);
        if (sibling) { secrets[sibling] = cleaned; secretOrigins[sibling] = "manual"; }
        saveSecrets(); saveSecretOrigins();
        showToast(zhipu ? "智谱 Key 已即时保存（图片/视频两个通道共用同一把）。" : "Key 已即时保存到本机会话。");
      });
    });
    [["videoTencentId", "video-tencent-id"], ["videoTencentKey", "video-tencent-key"]].forEach(([secretName, id]) => {
      const input = document.querySelector(`#${id}`);
      if (!input) return;
      input.addEventListener("change", () => {
        const cleaned = normalizeKey(input.value);
        if (!cleaned) return;
        secrets[secretName] = cleaned;
        secretOrigins[secretName] = "manual";
        saveSecrets(); saveSecretOrigins();
        showToast("腾讯云凭据已即时保存到本机会话。");
      });
    });
    // 设置页编辑即落库：不重绘整页，避免输入框失焦；只刷新右下角校验。
    // 换模型/换服务商这种会改变控件集合的操作走 render()。
    const cfgPane = document.querySelector(".cfg-main");
    if (cfgPane) {
      const refreshIssues = () => {
        const box = cfgPane.querySelector(".cfg-issues");
        if (box) box.innerHTML = renderCfgIssues();
      };
      // 参数改完后就地更新这一行的「已覆盖 / 继承」，不整体重绘：
      // 重绘会把光标和滚动位置一起丢掉。
      const syncParamRow = (input) => {
        const row = input.closest(".cfg-row");
        if (!row || input.dataset.cfgScope !== "model") return;
        const label = row.querySelector(".cfg-row-label");
        const overridden = String(input.value ?? "").trim() !== "" && !(input.type === "checkbox" && !input.checked);
        const flag = label?.querySelector(".cfg-flag.override");
        if (overridden && !flag && label) {
          const badge = document.createElement("span");
          badge.className = "cfg-flag on override";
          badge.textContent = "已覆盖";
          label.appendChild(badge);
        } else if (!overridden && flag) flag.remove();
        const control = row.querySelector(".cfg-row-control");
        const existing = row.querySelector('[data-action="cfg-reset-param"]');
        if (overridden && !existing && control && input.type !== "checkbox") {
          const btn = document.createElement("button");
          btn.className = "btn tiny ghost";
          btn.dataset.action = "cfg-reset-param";
          btn.dataset.key = input.dataset.cfgParam;
          btn.title = "清除本模型的覆盖，回到通道默认";
          btn.textContent = "继承";
          control.appendChild(btn);
        } else if (!overridden && existing) existing.remove();
      };
      cfgPane.addEventListener("change", event => {
        const target = event.target;
        if (!target.matches("input, select, textarea")) return;
        collectSettings(false);
        if (target.id.endsWith("-model")) { render(); return; }
        syncParamRow(target);
        refreshIssues();
      });
      cfgPane.addEventListener("input", event => {
        // 数字/文本边输边存，切节点时不会丢；不重绘，光标不跳。
        if (!event.target.matches("[data-cfg-param], #video-price-per-second")) return;
        collectSettings(false);
      });
    }
    // 单镜勾选不重绘整页（30 镜会跳回顶部），只就地更新高亮与计数。
    document.querySelectorAll("[data-shot-select]").forEach(input=>input.addEventListener("change",event=>{
      const shot=getEpisode().shots.find(i=>i.id===event.target.dataset.shotSelect);
      if(!shot)return;
      shot.selected=event.target.checked; persist();
      event.target.closest("article.shot")?.classList.toggle("selected", shot.selected);
      document.querySelectorAll(".shot-select-bar .ssb-count b").forEach(node=>{ node.textContent=String(getEpisode().shots.filter(item=>item.selected).length); });
    }));
    document.querySelectorAll("[data-shot-character]").forEach(input=>input.addEventListener("change",event=>{
      const shot=getEpisode().shots.find(item=>item.id===event.target.dataset.shotCharacter); if(!shot)return;
      const id=event.target.dataset.characterId;
      shot.characterIds=event.target.checked?[...new Set([...shot.characterIds,id])]:shot.characterIds.filter(item=>item!==id);
      shot.qc=null; persist(); render();
    }));
    document.querySelectorAll("[data-shot-scene]").forEach(select=>select.addEventListener("change",event=>{
      const shot=getEpisode().shots.find(item=>item.id===event.target.dataset.shotScene); if(shot){shot.sceneId=event.target.value;shot.qc=null;persist();}
    }));
    document.querySelectorAll("[data-shot-prop]").forEach(input=>input.addEventListener("change",event=>{
      const shot=getEpisode().shots.find(item=>item.id===event.target.dataset.shotProp);if(!shot)return;const id=event.target.dataset.propId;shot.propIds=event.target.checked?[...new Set([...(shot.propIds||[]),id])]:(shot.propIds||[]).filter(item=>item!==id);shot.qc=null;persist();render();
    }));
    document.querySelectorAll("[data-shot-variation]").forEach(select=>select.addEventListener("change",event=>{
      const shot=getEpisode().shots.find(item=>item.id===event.target.dataset.shotVariation); if(!shot)return; shot.characterVariations||={};
      if(event.target.value)shot.characterVariations[event.target.dataset.characterId]=event.target.value;else delete shot.characterVariations[event.target.dataset.characterId]; shot.qc=null;persist();render();
    }));
    document.querySelectorAll("[data-grid-count]").forEach(select=>select.addEventListener("change",event=>{
      const shot=getEpisode().shots.find(item=>item.id===event.target.dataset.gridCount); if(!shot)return; shot.storyboardGrid={...emptyStoryboardGrid(),panelCount:Number(event.target.value)};persist();render();
    }));
    document.querySelectorAll("[data-video-mode]").forEach(select=>select.addEventListener("change",event=>{const shot=getEpisode().shots.find(item=>item.id===event.target.dataset.videoMode);if(!shot)return;shot.videoInputMode=event.target.value;persist();render();}));
    document.querySelectorAll("[data-shot-chain-source]").forEach(select=>select.addEventListener("change",event=>{
      const episode=getEpisode();const shot=episode.shots.find(item=>item.id===event.target.dataset.shotChainSource);if(!shot)return;
      const source=episode.shots.find(item=>item.id===event.target.value);
      if(!source){if(shot.firstFrameOrigin==="chain")shot.firstFrameUrl="";shot.chainSourceShotId="";shot.firstFrameOrigin=shot.firstFrameUrl?"manual":"";shot.qc=null;persist();render();return;}
      if(!assignChainSource(shot,source,{manual:true})){showToast("所选镜头没有可用尾帧，或与本镜既不同角色也不同场景，不能作为续帧来源。",true);render();return;}
      persist();render();showToast(`已从镜头「${source.title}」承接尾帧（${sharedCharacterIds(source,shot).length?"同角色":"同场景空间锚点"}）。`);
    }));
    document.querySelectorAll("[data-motion-strength]").forEach(select=>select.addEventListener("change",event=>{const shot=getEpisode().shots.find(item=>item.id===event.target.dataset.motionStrength);if(!shot)return;shot.motionStrength=Number(event.target.value);persist();}));
    // 镜头音效下拉：改完立刻落库，不用等下一次点按钮才生效。
    document.querySelectorAll("[data-sfx-shot]").forEach(select => select.addEventListener("change", event => {
      const episode = getEpisode();
      const pack = packagingForm();
      const shotId = event.target.dataset.sfxShot;
      // 多选：一个镜头可以同时要门声和脚步声，单选会把自动匹配的三个音效砍掉两个。
      const picked = Array.from(event.target.selectedOptions || []).map(option => option.value).filter(Boolean);
      if (picked.length) pack.sfx.map[shotId] = picked;
      else delete pack.sfx.map[shotId];
      episode.packaging = pack;
      persist(); render();
    }));
    // 后期包装面板：设置改完立刻落库。
    // 之前这些字段只有点「生成字幕 / 生成配音 / 合成成片」时才会被读走，
    // 用户调完样式切到别的页再回来，设置就被还原成上一次保存的值——看着像没保存。
    document.addEventListener("change", event => {
      const target = event.target;
      if (!target || typeof target.closest !== "function") return;
      if (!target.closest(".packaging-grid")) return;
      const episode = getEpisode();
      episode.packaging = packagingForm();
      persist();
      // 花字模板的说明文案跟着换，不用整页重绘（重绘会把用户正在操作的控件换掉）。
      const templateNode = document.getElementById("pkg-sub-template");
      const hintNode = document.getElementById("pkg-sub-template-hint");
      if (templateNode && hintNode) hintNode.textContent = SUBTITLE_TEMPLATE_HINTS[templateNode.value] || "";
    });
    document.querySelectorAll("[data-studio-param]").forEach(node => node.addEventListener("change", event => {
      const raw = event.target.type === "checkbox" ? event.target.checked : event.target.value;
      studioSetParam(event.target.dataset.studioParam, raw);
      studioRenderStay();
    }));
    document.querySelectorAll("[data-studio-character]").forEach(node => node.addEventListener("change", event => {
      const studio = studioState(); const id = event.target.dataset.studioCharacter;
      const locked = new Set(studio.params.lockedCharacterIds || []);
      if (event.target.checked) locked.add(id); else locked.delete(id);
      studio.params.lockedCharacterIds = [...locked];
      persist(); studioRenderStay();
    }));
    document.querySelectorAll("[data-studio-select]").forEach(node => node.addEventListener("change", event => {
      const draft = studioDrafts().find(item => item.id === event.target.dataset.studioSelect);
      if (!draft) return;
      draft.selected = event.target.checked; persist(); studioRenderStay();
    }));
    document.querySelectorAll("[data-studio-segment]").forEach(node => node.addEventListener("change", event => {
      const segment = studioState().segments.find(item => item.id === event.target.dataset.studioSegment);
      if (!segment) return;
      (segment.shots || []).forEach(item => { item.selected = event.target.checked; });
      persist(); studioRenderStay();
    }));
    document.querySelectorAll("[data-studio-duration]").forEach(node => node.addEventListener("change", event => {
      studioUpdateDraft(event.target.dataset.studioDuration, { duration: Number(event.target.value) || 5 }, false);
      studioRenderStay();
    }));
    document.querySelectorAll("[data-studio-field]").forEach(node => node.addEventListener("change", event => {
      studioUpdateDraft(event.target.dataset.id, { [event.target.dataset.studioField]: event.target.value }, true);
      studioRenderStay();
    }));
    document.querySelectorAll("[data-studio-desc]").forEach(node => node.addEventListener("change", event => {
      studioUpdateDraft(event.target.dataset.studioDesc, { description: event.target.value.trim() }, true);
    }));
    document.querySelectorAll("[data-studio-dialogue]").forEach(node => node.addEventListener("change", event => {
      studioUpdateDraft(event.target.dataset.studioDialogue, { dialogue: event.target.value.trim() }, false);
      studioRenderStay();
    }));
    document.querySelectorAll("[data-studio-speaker]").forEach(node => node.addEventListener("change", event => {
      studioUpdateDraft(event.target.dataset.studioSpeaker, { speaker: event.target.value.trim() }, false);
    }));
    document.querySelector(".studio-backdrop")?.addEventListener("click", event => {
      if (event.target === event.currentTarget) { studioOpen = false; render(); }
    });
  };

  importNode.addEventListener("change", event => { const file=event.target.files?.[0]; if(file) importProject(file); event.target.value=""; });
  assetImageNode.addEventListener("change", async event => {
    const file=event.target.files?.[0]; const asset=findAsset(pendingAssetImageId); const shot=getEpisode()?.shots.find(item=>item.id===pendingShotImageId); const kind=pendingAssetImageKind; const variationId=pendingVariationId; pendingAssetImageId=""; pendingShotImageId=""; pendingVariationId=""; pendingAssetImageKind="reference"; event.target.value="";
    if(!file)return;
    if(file.size>20*1024*1024)return showToast("参考图不能超过 20MB。",true);
    try {
      if(kind.startsWith("shot-")){
        if(!shot)throw new Error("未找到镜头"); const url=await persistMedia({dataUrl:await fileToDataUrl(file),name:`${kind}-${shot.id}`}); if(kind==="shot-end")shot.lastFrameUrl=url;else{shot.firstFrameUrl=url;shot.chainSourceShotId="";shot.firstFrameOrigin="manual";}shot.qc=null;addLog(`镜头「${shot.title}」${kind==="shot-end"?"尾帧":"首帧"}已上传并锁定。`);persist();render();showToast("关键帧已锁定。");
      }else if(kind==="variation"){
        const variation=asset?.variations?.find(item=>item.id===variationId);if(!asset||!variation)throw new Error("未找到衣橱造型");variation.referenceImage=await persistMedia({dataUrl:await fileToDataUrl(file),name:`wardrobe-${asset.name}-${variation.name}`});variation.status="completed";asset.version=(Number(asset.version)||1)+1;addLog(`角色「${asset.name}」造型「${variation.name}」已上传并锁定。`);persist();render();showToast("衣橱造型已锁定。");
      }else if(kind==="turnaround"){
        if(!asset)throw new Error("未找到角色资产");
        asset.turnaround={...emptyTurnaround(),status:"uploading"};persist();render();
        const url=await persistMedia({dataUrl:await fileToDataUrl(file),name:`turnaround-${asset.name}`});
        const qc=await processTurnaround(asset,url);showToast(qc.passed?"九宫格已切分并通过质检。":"九宫格质检未通过。",!qc.passed);
      }else{
        if(!asset)throw new Error("未找到资产");
        asset.referenceStatus="uploading"; persist(); render();
        asset.referenceImage=await persistMedia({dataUrl:await fileToDataUrl(file),name:`asset-${asset.name}`});
        asset.referenceStatus="ready";asset.referenceOutdated=false;asset.referencePromptVersion=asset.version||1;invalidateAssetDependents(asset);const uploadedType=assetTypeFor(asset.id);const uploadedLabel={characters:"定妆图",scenes:"场景参考图",props:"道具参考图"}[uploadedType]||"参考图";addLog(`资产「${asset.name}」${uploadedLabel}已上传并锁定到本机。`);persist();render();showToast(uploadedType==="characters"?"定妆图已锁定；真人角色还需九宫格转面图。":`${uploadedLabel}已锁定。`);
      }
    } catch(error){
      if(kind==="turnaround"&&asset){
        asset.turnaround||=emptyTurnaround();asset.turnaround.status="failed";
        if(asset.turnaround.imageUrl){
          addLog(`角色「${asset.name}」九宫格图已保存，但切分/质检失败：${error.message}`);
          persist();render();
          showToast(`九宫格图已保存，但切分/质检失败（${error.message}）。点「补做切分/质检」重试，不必重新上传。`,true);
          return;
        }
      }else if(kind==="reference"&&asset)asset.referenceStatus="failed";
      persist();render();showToast(error.message,true);
    }
  });
  const bootstrap = async () => {
    try {
      const savedResponse = await fetch("/api/workspace-snapshot", { cache: "no-store" });
      if (savedResponse.ok) {
        const saved = await savedResponse.json();
        if (saved?.state?.version === 1 && Array.isArray(saved.state.projects)) {
          state = normalizeState(saved.state);
          snapshotRevision = Number(state.externalRevision || 0);
        }
      }
      const response = await fetch("/api/model-config", { cache: "no-store" });
      if (response.ok) {
        const config = await response.json();
        // 七个密钥槽位都要同步：漏掉 imageDashscope / videoDashscope 会让「本机 .env 已配 Key」
        // 的百炼通道在设置页显示成「未配置」，用户以为没配，重复粘贴或误判出片失败原因。
        for (const type of ["chat", "image", "imageZhipu", "imageDashscope", "video", "videoZhipu", "videoDashscope", "videoTencentId", "videoTencentKey"]) {
          serverSecrets[type] = Boolean(config.localSecrets?.[type]);
          if (!serverSecrets[type]) continue;
          const stored = secrets[type];
          if (!stored || stored === SERVER_SECRET_SENTINEL) {
            secrets[type] = SERVER_SECRET_SENTINEL;
            delete secretOrigins[type];
            continue;
          }
          const expected = config.localSecretFingerprints?.[type] || "";
          const actual = await keyFingerprint(stored);
          if (expected && actual && expected === actual) {
            // 浏览器里存的正是本机那把，只是镜像一份，改回引用即可。
            secrets[type] = SERVER_SECRET_SENTINEL;
            delete secretOrigins[type];
            continue;
          }
          if (secretOrigins[type] === "manual") continue; // 用户亲手填的，先用着，401 时再回退
          // 本机有可用密钥，浏览器里却躺着一把来路不明的旧 Key（换号/吊销后仍留着）：
          // 它会在每次请求里盖住本机密钥，直接表现为 401。以本机为准，顺手清掉旧值。
          staleSecrets.add(type);
          secrets[type] = SERVER_SECRET_SENTINEL;
          delete secretOrigins[type];
        }
        if (staleSecrets.size) {
          saveSecrets();
          saveSecretOrigins();
          addLog(`已停用浏览器里过期的 ${[...staleSecrets].map(type => type.startsWith("videoTencent") ? "腾讯视频" : type.startsWith("video") ? "视频" : type.startsWith("image") ? "图片" : "对话").join("、")} Key，改用本机密钥。`);
        }
      }
      await fetch("/api/workspace-snapshot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state }),
      });
    } catch (error) {
      console.warn("本机模型密钥状态读取失败。", error);
    }
    if (new URLSearchParams(window.location.search).get("studio") === "1") studioOpen = true;
    persist();
    render();
    if (staleSecrets.size) {
      setTimeout(() => showToast(`已停用浏览器里过期的 ${[...staleSecrets].map(type => type.startsWith("videoTencent") ? "腾讯视频" : type.startsWith("video") ? "视频" : type.startsWith("image") ? "图片" : "对话").join("、")} Key，改用本机密钥。`), 600);
    }
  };
  const syncExternalSnapshot = async () => {
    try {
      const response = await fetch("/api/workspace-snapshot", { cache: "no-store" });
      if (!response.ok) return;
      const saved = await response.json();
      const incoming = saved?.state;
      const revision = Number(incoming?.externalRevision || 0);
      if (incoming?.version === 1 && Array.isArray(incoming.projects) && revision > snapshotRevision) {
        const localProjectId = state.currentProjectId;
        const localEpisodeId = state.currentEpisodeId;
        state = normalizeState(incoming);
        const localProject = state.projects.find(item => item.id === localProjectId);
        if (localProject) {
          state.currentProjectId = localProjectId;
          if (localProject.episodes.some(item => item.id === localEpisodeId)) state.currentEpisodeId = localEpisodeId;
        }
        snapshotRevision = revision;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        render();
      }
    } catch (error) {
      console.warn("外部制作进度同步失败。", error);
    }
  };
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    // 预览弹层比工坊更靠前，先关最上层。
    if (document.querySelector(".clip-preview")) { closeClipPreview(); return; }
    if (studioOpen) { studioOpen = false; render(); }
  });
  bootstrap().then(() => {
    setInterval(syncExternalSnapshot, 3000);
    setInterval(reconcileDeferredQueue, 30000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) reconcileDeferredQueue(); });
    window.addEventListener("focus", reconcileDeferredQueue);
    healTurnarounds(); autoResumeQueue();
  });
})();

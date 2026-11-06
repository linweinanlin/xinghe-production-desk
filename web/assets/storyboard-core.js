/*!
 * 星河制片台 · AI 分镜脚本核心（原创实现，MIT）
 *
 * 设计参照（功能语义，非代码/素材复用）：
 *  - 即梦「短剧工作室」分镜：片段 →「分镜N · 时长 · 景别+人物+动作」一句话式描述，
 *    单条可改时长，多选后可批量提交。
 *  - 小云雀「短剧 Agent」分镜：剧本 → 片段 → 分镜脚本，每镜给出景别、构图、机位、
 *    焦段、时长、画面描述与台词，底部「全选 / 批量生成」。
 *
 * 本文件只做纯计算：批次规划、提示词构建、模型输出归一化、离线兜底生成。
 * 不发起网络请求，不读写存储，因此可被 Node 直接单测。
 */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (root) root.StoryboardCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const SHOT_SIZES = ["大远景", "远景", "全景", "中景", "中近景", "近景", "特写", "大特写"];
  const COMPOSITIONS = ["三分法构图", "中心构图", "对称构图", "框架构图", "前景遮挡", "对角线构图", "留白构图"];
  const CAMERA_ANGLES = ["平视", "轻微俯拍", "俯拍", "低机位仰拍", "高机位", "侧拍", "过肩", "鸟瞰"];
  const LENSES = ["24mm 广角", "35mm 人文", "50mm 标准", "85mm 中长焦", "135mm 长焦"];
  const MOVEMENTS = ["固定镜头", "缓慢推近", "缓慢拉远", "横移跟拍", "手持跟随", "环绕", "升降", "摇镜"];
  const DURATIONS = [2, 3, 4, 5, 6, 8, 10, 12, 15];
  const DENSITIES = ["auto", "wide", "medium", "close"];
  const DENSITY_LABEL = { auto: "自动配比", wide: "全景建立为主", medium: "中近景叙事为主", close: "特写情绪为主" };
  const DIALOGUE_MODES = { verbatim: "逐字保留台词", concise: "允许精简台词" };

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const asText = (value) => (value === null || value === undefined ? "" : String(value)).trim();

  function defaultParams() {
    return {
      shotCount: "auto",
      shotDuration: 5,
      density: "auto",
      includeLens: true,
      dialogueMode: "verbatim",
      batchSize: 4,
      style: "",
      ratio: "9:16",
      lockedCharacterIds: [],
    };
  }

  function normalizeParams(input) {
    const params = { ...defaultParams(), ...(input || {}) };
    params.shotCount = ["auto", 6, 9, 12, 16, 24].includes(params.shotCount) ? params.shotCount : "auto";
    params.shotDuration = clamp(Number(params.shotDuration) || 5, 2, 15);
    params.density = DENSITIES.includes(params.density) ? params.density : "auto";
    params.dialogueMode = params.dialogueMode === "concise" ? "concise" : "verbatim";
    params.batchSize = clamp(Number(params.batchSize) || 4, 1, 8);
    params.includeLens = Boolean(params.includeLens);
    params.lockedCharacterIds = Array.isArray(params.lockedCharacterIds) ? params.lockedCharacterIds.filter(Boolean) : [];
    params.ratio = ["9:16", "16:9", "1:1"].includes(params.ratio) ? params.ratio : "9:16";
    return params;
  }

  /**
   * 按句切分，但不切断引号/括号内的句子，避免把「签了它。」拆成两段。
   */
  function splitSentences(text) {
    const source = asText(text);
    if (!source) return [];
    const openers = "「『“‘（(【《";
    const closers = "」』”’）)】》";
    const enders = "。！？!?；;\n";
    const out = [];
    let depth = 0;
    let buffer = "";
    for (let index = 0; index < source.length; index += 1) {
      const char = source[index];
      buffer += char;
      if (openers.includes(char)) depth += 1;
      else if (closers.includes(char)) depth = Math.max(0, depth - 1);
      if (enders.includes(char) && depth === 0) {
        let cursor = index + 1;
        while (cursor < source.length && closers.includes(source[cursor])) {
          buffer += source[cursor];
          cursor += 1;
        }
        index = cursor - 1;
        if (buffer.trim()) out.push(buffer.trim());
        buffer = "";
      }
    }
    if (buffer.trim()) out.push(buffer.trim());
    return out;
  }

  /**
   * 把剧本/节拍切成「片段」批次。每个批次是一次模型请求的输入。
   */
  function planBatches(input) {
    const params = normalizeParams(input && input.params);
    const script = asText(input && input.script);
    const beats = (input && Array.isArray(input.beats) ? input.beats : []).filter((beat) => asText(beat && beat.text));
    const targetDuration = Number(input && input.targetDuration) || 0;

    let sources = [];
    if (beats.length) {
      sources = beats.map((beat, index) => ({
        beatId: asText(beat.id),
        title: asText(beat.title) || `节拍 ${index + 1}`,
        scene: asText(beat.location),
        mood: asText(beat.mood),
        text: asText(beat.text),
      }));
    } else {
      const sentences = splitSentences(script);
      const perSegment = 2;
      for (let index = 0; index < sentences.length; index += perSegment) {
        sources.push({
          beatId: "",
          title: `段落 ${sources.length + 1}`,
          scene: "",
          mood: "",
          text: sentences.slice(index, index + perSegment).join(""),
        });
      }
    }
    if (!sources.length) return [];

    let target = params.shotCount === "auto"
      ? Math.round((targetDuration || sources.length * 15) / Math.max(2, params.shotDuration))
      : Number(params.shotCount);
    target = clamp(target, Math.max(2, sources.length), Math.max(4, sources.length * 6));

    const base = Math.floor(target / sources.length);
    const extra = target % sources.length;
    const batches = [];
    sources.forEach((source, sourceIndex) => {
      const wanted = Math.max(1, base + (sourceIndex < extra ? 1 : 0));
      const chunks = Math.ceil(wanted / params.batchSize);
      let remaining = wanted;
      for (let chunk = 0; chunk < chunks; chunk += 1) {
        const take = Math.min(params.batchSize, remaining);
        remaining -= take;
        const segmentLabel = `片段 ${sourceIndex + 1}`;
        batches.push({
          id: `batch_${sourceIndex + 1}_${chunk + 1}`,
          segmentIndex: sourceIndex,
          segmentLabel,
          label: chunks > 1 ? `${segmentLabel} · 第 ${chunk + 1}/${chunks} 批` : segmentLabel,
          beatId: source.beatId,
          sourceTitle: source.title,
          scene: source.scene,
          mood: source.mood,
          text: source.text,
          shotCount: take,
          chunkIndex: chunk,
          chunkTotal: chunks,
        });
      }
    });
    return batches;
  }

  const densityHint = (density) => {
    if (density === "wide") return "景别以远景、全景、中景为主，先建立空间再推进叙事。";
    if (density === "medium") return "景别以中景、中近景、近景为主，保持人物关系与表演。";
    if (density === "close") return "景别以近景、特写为主，强调情绪、视线与关键道具。";
    return "景别按叙事节奏自动配比：开场建立空间，冲突处切近景，情绪落点用特写。";
  };

  function characterRoster(ctx) {
    return (ctx && Array.isArray(ctx.characters) ? ctx.characters : [])
      .map((item) => asText(item && item.name))
      .filter(Boolean);
  }

  function sceneRoster(ctx) {
    return (ctx && Array.isArray(ctx.scenes) ? ctx.scenes : [])
      .map((item) => asText(item && item.name))
      .filter(Boolean);
  }

  function propRoster(ctx) {
    return (ctx && Array.isArray(ctx.props) ? ctx.props : [])
      .map((item) => asText(item && item.name))
      .filter(Boolean);
  }

  function lockedCharacters(ctx, params) {
    const ids = (params && params.lockedCharacterIds) || [];
    return (ctx && Array.isArray(ctx.characters) ? ctx.characters : [])
      .filter((item) => ids.includes(item.id))
      .map((item) => asText(item && item.name))
      .filter(Boolean);
  }

  function buildRequest(input) {
    const batch = input.batch || {};
    const ctx = input.ctx || {};
    const params = normalizeParams(input.params);
    const style = asText(params.style) || asText(ctx.style) || "电影写实";
    const characters = characterRoster(ctx);
    const scenes = sceneRoster(ctx);
    const props = propRoster(ctx);
    const locked = lockedCharacters(ctx, params);

    const system = [
      "你是短剧分镜师兼导演，负责把剧本片段拆成可直接执行的镜头脚本。",
      "只输出 JSON 对象，不要解释、不要 Markdown 代码块。",
      "台词必须保持原文逐字一致，禁止把角色台词改写成旁白；原文没有的台词不得凭空新增。",
      `景别只能取：${SHOT_SIZES.join("、")}；构图只能取：${COMPOSITIONS.join("、")}；机位只能取：${CAMERA_ANGLES.join("、")}；运镜只能取：${MOVEMENTS.join("、")}。`,
      params.includeLens ? `焦段只能取：${LENSES.join("、")}。` : "焦段字段可留空字符串。",
    ].join("\n");

    const requirement = [
      `本批需要 ${batch.shotCount || 1} 个分镜，按剧情顺序完整覆盖下面的片段内容，不要跳段，不要重复。`,
      densityHint(params.density),
      `单镜时长在 2-15 秒之间，默认 ${params.shotDuration} 秒，总和接近 ${(batch.shotCount || 1) * params.shotDuration} 秒。`,
      params.dialogueMode === "concise"
        ? "台词可以精简口语助词，但语义、称呼与信息量不得改变。"
        : "台词逐字保留，一字不改。",
      "画面描述必须具体到可直接喂给生图/生视频模型：主体 + 动作 + 环境 + 光线质感，40-90 字，不要写“同上”“继续”。",
      "description 中不要出现字幕、文字板、水印、镜号等描述对象。",
      characters.length
        ? `只能使用以下已建立的角色名，不得新增人物名：${characters.join("、")}。`
        : "如果出现人物，用“男主”“女主”“配角 A”这类可绑定的称呼，后续会统一替换为资产角色。",
      locked.length ? `以下角色必须出现在每个分镜的画面描述或人物字段中：${locked.join("、")}。` : "",
      scenes.length ? `场景优先从这些已建立场景中选择：${scenes.join("、")}；都不匹配时再写新的场景名。` : "",
      props.length ? `本片已有道具：${props.join("、")}，剧情涉及时必须写进画面。` : "",
      `视觉风格统一为「${style}」，画幅 ${params.ratio}，色彩与光线在同一片段内保持连续。`,
    ].filter(Boolean).join("\n");

    const schema = {
      shots: [
        {
          title: "镜头标题，4-12 字",
          shotSize: "景别",
          composition: "构图",
          cameraAngle: "机位",
          lens: params.includeLens ? "焦段" : "",
          movement: "运镜",
          duration: params.shotDuration,
          description: "画面与动作描述",
          dialogue: "台词原文，无台词填空字符串",
          speaker: "说话角色名，无台词填空字符串",
          characters: ["出场角色名"],
          scene: "场景名",
          props: ["相关道具名"],
          prompt: "可直接用于生图模型的完整提示词",
        },
      ],
    };

    const context = [
      `项目：${asText(ctx.projectName) || "未命名"}｜类型：${asText(ctx.genre) || "短剧"}｜风格：${style}｜画幅：${params.ratio}｜语言：${asText(ctx.language) || "中文"}`,
      batch.scene ? `本片段场景设定：${batch.scene}` : "",
      batch.mood ? `本片段情绪基调：${batch.mood}` : "",
      ctx.artDirection && asText(ctx.artDirection.anchors) ? `美术锚点：${asText(ctx.artDirection.anchors)}` : "",
    ].filter(Boolean).join("\n");

    const user = [
      requirement,
      "",
      context,
      "",
      `片段原文（${batch.label || "片段"}）：`,
      asText(batch.text),
      "",
      "输出 JSON 结构示例：",
      JSON.stringify(schema, null, 2),
    ].join("\n");

    return { system, user, schema };
  }

  const pick = (raw, keys) => {
    for (const key of keys) {
      const value = raw && raw[key];
      if (typeof value === "string" && value.trim()) return value.trim();
      if (typeof value === "number") return String(value);
    }
    return "";
  };

  function snap(value, options, fallback, aliases) {
    const text = asText(value);
    if (!text) return fallback;
    const exact = options.find((option) => option === text);
    if (exact) return exact;
    const loose = options.find((option) => text.includes(option) || option.includes(text));
    if (loose) return loose;
    const table = aliases || {};
    for (const key of Object.keys(table)) {
      if (text.includes(key)) return table[key];
    }
    return fallback;
  }

  const SIZE_ALIASES = {
    大远: "大远景", 极远: "大远景", 远: "远景", 全: "全景", 中近: "中近景",
    中: "中景", 近: "近景", 特: "特写", 细节: "大特写", 微距: "大特写",
  };
  const MOVE_ALIASES = {
    推进: "缓慢推近", 推: "缓慢推近", 拉: "缓慢拉远", 后拉: "缓慢拉远",
    摇: "摇镜", 横移: "横移跟拍", 跟: "手持跟随", 环绕: "环绕", 旋转: "环绕",
    升: "升降", 降: "升降", 固定: "固定镜头", 静止: "固定镜头",
  };
  const ANGLE_ALIASES = {
    俯: "俯拍", 低机: "低机位仰拍", 仰: "低机位仰拍", 高机: "高机位",
    侧: "侧拍", 过肩: "过肩", 鸟: "鸟瞰", 平: "平视",
  };
  const COMP_ALIASES = { 三分: "三分法构图", 中心: "中心构图", 对称: "对称构图", 框架: "框架构图", 前景: "前景遮挡", 对角: "对角线构图", 留白: "留白构图" };
  const LENS_ALIASES = { 24: "24mm 广角", 35: "35mm 人文", 50: "50mm 标准", 85: "85mm 中长焦", 135: "135mm 长焦" };

  function snapDuration(value, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return fallback;
    return clamp(Math.round(number), 2, 15);
  }

  function composePrompt(input) {
    const draft = input.draft || {};
    const params = normalizeParams(input.params);
    const ctx = input.ctx || {};
    const segment = input.segment || {};
    const style = asText(params.style) || asText(ctx.style) || "电影写实";
    const parts = [
      `${style}，${params.ratio} 画幅，电影级短片画面`,
      asText(segment.scene) ? `场景：${segment.scene}` : "",
      draft.shotSize ? `景别：${draft.shotSize}` : "",
      draft.composition ? `构图：${draft.composition}` : "",
      draft.cameraAngle ? `机位：${draft.cameraAngle}` : "",
      params.includeLens && draft.lens ? `焦段：${draft.lens}` : "",
      draft.movement ? `运镜：${draft.movement}` : "",
      `画面：${asText(draft.description)}`,
      (draft.characterNames || []).length ? `出场角色：${draft.characterNames.join("、")}，身份与服装保持一致` : "",
      "统一色温与光线方向，真实材质，画面内无文字、无字幕、无水印。",
    ].filter(Boolean);
    return parts.join("；");
  }

  function matchCharacterNames(text, ctx) {
    const names = characterRoster(ctx);
    const source = asText(text);
    return names.filter((name) => name && source.includes(name));
  }

  /**
   * 把模型返回的任意近似结构归一化为统一的分镜草稿。
   */
  function normalizeDrafts(payload, input) {
    const ctx = (input && input.ctx) || {};
    const params = normalizeParams(input && input.params);
    const segment = (input && input.segment) || {};
    const fallbackTitle = (input && input.segmentLabel) || "分镜";
    let raw = payload;
    if (raw && typeof raw === "string") {
      const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
      try { raw = JSON.parse(cleaned); } catch { raw = null; }
    }
    let list = [];
    if (Array.isArray(raw)) list = raw;
    else if (raw && Array.isArray(raw.shots)) list = raw.shots;
    else if (raw && Array.isArray(raw.storyboard)) list = raw.storyboard;
    else if (raw && Array.isArray(raw.分镜)) list = raw.分镜;
    else if (raw && Array.isArray(raw.segments)) list = raw.segments.flatMap((item) => (Array.isArray(item && item.shots) ? item.shots : []));
    else if (raw && raw.data) return normalizeDrafts(raw.data, input);

    const drafts = [];
    list.forEach((item, index) => {
      if (!item || typeof item !== "object") return;
      const description = pick(item, ["description", "画面描述", "content", "action", "visual", "desc", "shot"]);
      const dialogue = pick(item, ["dialogue", "台词", "line", "speech"]);
      if (!description && !dialogue) return;
      const shotSize = snap(pick(item, ["shotSize", "景别", "size", "shot_size"]), SHOT_SIZES, params.density === "close" ? "近景" : "中景", SIZE_ALIASES);
      const movement = snap(pick(item, ["movement", "运镜", "camera", "cameraMovement"]), MOVEMENTS, "固定镜头", MOVE_ALIASES);
      let angleSource = pick(item, ["cameraAngle", "机位", "angle", "camera_angle"]);
      if (!angleSource) {
        const cameraText = pick(item, ["camera", "镜头"]);
        angleSource = /俯/u.test(cameraText) ? "俯拍" : /仰/u.test(cameraText) ? "低机位仰拍" : "";
      }
      const rawCharacters = Array.isArray(item.characters) ? item.characters.map(asText) : asText(item.characters) ? [asText(item.characters)] : [];
      const matched = [...new Set([...rawCharacters, ...matchCharacterNames(`${description} ${dialogue} ${pick(item, ["speaker", "角色"])}`, ctx)].filter(Boolean))];
      const draft = {
        id: `${segment.id || "seg"}_shot_${index + 1}_${Math.random().toString(36).slice(2, 7)}`,
        index: index + 1,
        title: pick(item, ["title", "标题", "name"]) || `${fallbackTitle} · ${shotSize}`,
        shotSize,
        composition: snap(pick(item, ["composition", "构图"]), COMPOSITIONS, "三分法构图", COMP_ALIASES),
        cameraAngle: snap(angleSource, CAMERA_ANGLES, "平视", ANGLE_ALIASES),
        lens: params.includeLens ? snap(pick(item, ["lens", "焦段", "focal"]), LENSES, "50mm 标准", LENS_ALIASES) : "",
        movement,
        duration: snapDuration(pick(item, ["duration", "时长", "seconds"]), params.shotDuration),
        description,
        dialogue,
        speaker: pick(item, ["speaker", "说话人", "角色"]),
        characterNames: matched,
        scene: pick(item, ["scene", "场景"]) || asText(segment.scene),
        props: Array.isArray(item.props) ? item.props.map(asText).filter(Boolean) : [],
        prompt: "",
        selected: true,
        status: "draft",
        method: "ai",
      };
      draft.prompt = pick(item, ["prompt", "提示词"]) || composePrompt({ draft, params, ctx, segment });
      drafts.push(draft);
    });
    return drafts;
  }

  /**
   * 离线兜底：没有可用对话模型时，仍按分镜规范产出可编辑的草稿。
   */
  function localDrafts(input) {
    const batch = input.batch || {};
    const ctx = input.ctx || {};
    const params = normalizeParams(input.params);
    const sentences = splitSentences(batch.text);
    const count = clamp(Number(batch.shotCount) || 1, 1, 8);
    const preset = [
      { shotSize: "大远景", movement: "缓慢推近", composition: "对称构图", angle: "鸟瞰" },
      { shotSize: "全景", movement: "横移跟拍", composition: "三分法构图", angle: "平视" },
      { shotSize: "中景", movement: "固定镜头", composition: "三分法构图", angle: "平视" },
      { shotSize: "近景", movement: "缓慢推近", composition: "中心构图", angle: "侧拍" },
      { shotSize: "特写", movement: "固定镜头", composition: "留白构图", angle: "平视" },
      { shotSize: "中近景", movement: "手持跟随", composition: "前景遮挡", angle: "过肩" },
      { shotSize: "全景", movement: "升降", composition: "对角线构图", angle: "高机位" },
      { shotSize: "大特写", movement: "缓慢拉远", composition: "中心构图", angle: "平视" },
    ];
    const drafts = [];
    for (let index = 0; index < count; index += 1) {
      const shape = preset[index % preset.length];
      const sentenceIndex = sentences.length
        ? Math.min(sentences.length - 1, Math.floor((index * sentences.length) / Math.max(1, count)))
        : 0;
      const text = sentences[sentenceIndex] || asText(batch.text);
      const quota = text.match(/[「“"]([^」”"]{1,40})[」”"]/u);
      const speaker = (text.match(/([\u4e00-\u9fa5A-Za-z]{2,4})(说|问|喊|道|答|低语|开口)/u) || [])[1] || "";
      const draft = {
        id: `local_${batch.id}_${index + 1}`,
        index: index + 1,
        title: `${batch.segmentLabel || "片段"} · ${shape.shotSize}`,
        shotSize: shape.shotSize,
        composition: shape.composition,
        cameraAngle: shape.angle,
        lens: params.includeLens ? LENSES[index % LENSES.length] : "",
        movement: shape.movement,
        duration: params.shotDuration,
        description: text,
        dialogue: quota ? quota[1] : "",
        speaker,
        characterNames: matchCharacterNames(`${text} ${speaker}`, ctx),
        scene: asText(batch.scene),
        props: [],
        prompt: "",
        selected: true,
        status: "draft",
        method: "local",
      };
      draft.prompt = composePrompt({ draft, params, ctx, segment: batch });
      drafts.push(draft);
    }
    return drafts;
  }

  function summarize(segments) {
    const list = Array.isArray(segments) ? segments : [];
    const shots = list.flatMap((segment) => (Array.isArray(segment && segment.shots) ? segment.shots : []));
    return {
      segments: list.length,
      shots: shots.length,
      selected: shots.filter((shot) => shot && shot.selected).length,
      duration: Math.round(shots.reduce((sum, shot) => sum + (Number(shot && shot.duration) || 0), 0) * 10) / 10,
      failed: list.filter((segment) => segment && segment.status === "failed").length,
    };
  }

  return {
    SHOT_SIZES, COMPOSITIONS, CAMERA_ANGLES, LENSES, MOVEMENTS, DURATIONS,
    DENSITIES, DENSITY_LABEL, DIALOGUE_MODES,
    defaultParams, normalizeParams, planBatches, buildRequest, normalizeDrafts,
    localDrafts, composePrompt, summarize, splitSentences, matchCharacterNames,
  };
});

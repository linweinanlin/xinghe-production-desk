(() => {
  "use strict";

  // 星河统一供应商能力层。
  // 页面、提交器和额度保护只读取这里，不再散落判断供应商名称。
  const catalog = {
    dashscope: {
      label: "阿里百炼",
      billing: { free: "新人模型独立额度", guard: "console-stop", requiresConfirmation: true },
      credentials: ["apiKey"],
      models: {
        "wan3.0-video": { modes: ["text", "first", "keyframes"], audio: true, watermark: false, resolutions: ["720p", "1080p"], references: 2 },
        "happyhorse-1.1-t2v": { modes: ["text"], audio: true, watermark: false, resolutions: ["720p", "1080p"], references: 0 },
        "happyhorse-1.1-i2v": { modes: ["first"], audio: true, watermark: false, resolutions: ["720p", "1080p"], references: 1 },
        "happyhorse-1.1-r2v": { modes: ["first"], audio: true, watermark: false, resolutions: ["720p", "1080p"], references: 9 },
      },
    },
    zhipu: {
      label: "智谱",
      billing: { free: "cogvideox-flash 免费共享通道", guard: "model-free", requiresConfirmation: false },
      credentials: ["apiKey"],
      models: {
        "cogvideox-flash": { modes: ["text", "first"], audio: false, watermark: true, resolutions: ["1080p"], references: 1 },
        "cogvideox-2": { modes: ["text", "first"], audio: false, watermark: true, resolutions: ["1080p"], references: 1 },
        "cogvideox-3": { modes: ["text", "first"], audio: false, watermark: true, resolutions: ["1080p"], references: 1 },
      },
    },
    agentPlan: {
      label: "火山 Agent Plan",
      billing: { free: "无免费 API", guard: "subscription", requiresConfirmation: false },
      credentials: ["apiKey"],
      models: Object.fromEntries([
        "doubao-seedance-2.0", "doubao-seedance-2.0-fast", "doubao-seedance-2.0-mini", "doubao-seedance-2.5",
      ].map(model => [model, { modes: ["text", "first"], audio: true, watermark: false, resolutions: ["720p", "1080p"], references: 1 }])),
    },
    tencent: {
      label: "腾讯混元",
      billing: { free: "50 点一次性免费资源包 · 1 年", guard: "default-stop", requiresConfirmation: true },
      credentials: ["secretId", "secretKey"],
      models: {
        "hunyuan-video": { modes: ["text", "first"], audio: false, watermark: true, resolutions: ["720p"], references: 1, concurrency: 1 },
      },
    },
  };

  const provider = vendor => catalog[vendor] || catalog.agentPlan;
  const model = (vendor, modelId) => provider(vendor).models[modelId] || Object.values(provider(vendor).models)[0];
  const supports = (vendor, modelId, mode) => Boolean(model(vendor, modelId)?.modes?.includes(mode));
  const describe = (vendor, modelId) => {
    const item = model(vendor, modelId);
    return [
      ...(item.modes.includes("text") ? ["文生"] : []),
      ...(item.modes.includes("first") ? ["首帧"] : []),
      ...(item.modes.includes("keyframes") ? ["首尾帧"] : []),
      item.references > 1 ? `多参考×${item.references}` : "",
      item.audio ? "带音轨" : "无音轨",
      item.watermark ? "有标识" : "无水印",
      item.resolutions.join("/"),
    ].filter(Boolean);
  };

  window.XingheProviderCapabilities = Object.freeze({ catalog, provider, model, supports, describe });
})();

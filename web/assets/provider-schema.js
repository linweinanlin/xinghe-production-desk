/**
 * 星河制片台 · 模型与配置层级表（界面唯一数据源）
 *
 * 结构：模块 → 服务商 → 模型 → 参数，四级。
 * 界面只读这张表，不写任何「某家服务商特殊」的分支；设置页的树、表单、
 * 校验提示、下拉选项全部由这里长出来。
 *
 * 新增一家服务商的做法（不需要改界面代码）：
 *   1. 在对应模块的 providers 里加一条：vendor / id / 名称 / defaults / secret 槽位；
 *   2. 在它的 models 里写模型 id、能力（capabilities）与参数描述符（params）；
 *   3. 参数描述符支持 type / options / min / max / default / wired 六个字段，
 *      wired=true 表示这个参数真的会进请求，false 表示仅存档（界面会标「仅存档」）。
 *   4. 改完运行 python tools/seal.py 重新盖章，否则启动会提示「已修改构建」。
 *
 * 溯源标记 XHPD-2026-7f3c91a4d0e5b28c · Copyright (c) 2026 linweinanlin
 */
(() => {
  "use strict";
  const SCHEMA = {
  "version": 2,
  "generatedAt": "2026-11-05T06:56:30.478Z",
  "modules": [
    {
      "kind": "chat",
      "label": "对话模型",
      "desc": "剧本拆解、分镜生成、提示词改写；同步返回文本。",
      "providers": [
        {
          "id": "deepseek",
          "vendor": "deepseek",
          "label": "DeepSeek",
          "desc": "",
          "live": true,
          "unavailableReason": "",
          "secret": [
            {
              "name": "apiKey",
              "label": "API KEY",
              "slot": "chat",
              "required": true
            }
          ],
          "billing": null,
          "defaults": {
            "baseUrl": "https://api.deepseek.com",
            "endpoint": "/chat/completions",
            "model": "deepseek-v4-flash"
          },
          "params": [
            {
              "key": "temperature",
              "type": "number",
              "label": "温度 temperature",
              "min": 0,
              "max": 2,
              "step": 0.1,
              "placeholder": "留空则用服务商默认",
              "help": "越低越稳定，剧本拆解建议 0.3–0.7",
              "wired": true
            },
            {
              "key": "maxTokens",
              "type": "number",
              "label": "最大输出 max_tokens",
              "min": 256,
              "max": 65536,
              "step": 256,
              "placeholder": "留空则用服务商默认",
              "help": "单次响应上限，分镜批量生成时需放宽",
              "wired": true
            },
            {
              "key": "jsonMode",
              "type": "boolean",
              "label": "强制 JSON 输出",
              "default": false,
              "help": "开启后带 response_format=json_object，分镜解析失败率更低",
              "wired": true
            }
          ],
          "models": [
            {
              "id": "deepseek-v4-flash",
              "label": "deepseek-v4-flash",
              "capability": [
                "文生",
                "无音轨",
                "无水印"
              ],
              "spec": {
                "modes": [
                  "text"
                ],
                "contextTokens": 128000,
                "tools": true
              },
              "params": [
                {
                  "key": "temperature",
                  "type": "number",
                  "label": "温度 temperature",
                  "min": 0,
                  "max": 2,
                  "step": 0.1,
                  "placeholder": "留空则用服务商默认",
                  "help": "越低越稳定，剧本拆解建议 0.3–0.7",
                  "wired": true
                },
                {
                  "key": "maxTokens",
                  "type": "number",
                  "label": "最大输出 max_tokens",
                  "min": 256,
                  "max": 65536,
                  "step": 256,
                  "placeholder": "留空则用服务商默认",
                  "help": "单次响应上限，分镜批量生成时需放宽",
                  "wired": true
                },
                {
                  "key": "jsonMode",
                  "type": "boolean",
                  "label": "强制 JSON 输出",
                  "default": false,
                  "help": "开启后带 response_format=json_object，分镜解析失败率更低",
                  "wired": true
                }
              ]
            },
            {
              "id": "deepseek-v4",
              "label": "deepseek-v4",
              "capability": [
                "文生",
                "无音轨",
                "无水印"
              ],
              "spec": {
                "modes": [
                  "text"
                ],
                "contextTokens": 128000,
                "tools": true
              },
              "params": [
                {
                  "key": "temperature",
                  "type": "number",
                  "label": "温度 temperature",
                  "min": 0,
                  "max": 2,
                  "step": 0.1,
                  "placeholder": "留空则用服务商默认",
                  "help": "越低越稳定，剧本拆解建议 0.3–0.7",
                  "wired": true
                },
                {
                  "key": "maxTokens",
                  "type": "number",
                  "label": "最大输出 max_tokens",
                  "min": 256,
                  "max": 65536,
                  "step": 256,
                  "placeholder": "留空则用服务商默认",
                  "help": "单次响应上限，分镜批量生成时需放宽",
                  "wired": true
                },
                {
                  "key": "jsonMode",
                  "type": "boolean",
                  "label": "强制 JSON 输出",
                  "default": false,
                  "help": "开启后带 response_format=json_object，分镜解析失败率更低",
                  "wired": true
                }
              ]
            }
          ]
        },
        {
          "id": "openai",
          "vendor": "openai",
          "label": "OpenAI",
          "desc": "",
          "live": true,
          "unavailableReason": "",
          "secret": [
            {
              "name": "apiKey",
              "label": "API KEY",
              "slot": "chatOpenai",
              "required": true
            }
          ],
          "billing": null,
          "defaults": {
            "baseUrl": "https://api.openai.com/v1",
            "endpoint": "/chat/completions",
            "model": "gpt-4.1-mini"
          },
          "params": [
            {
              "key": "temperature",
              "type": "number",
              "label": "温度 temperature",
              "min": 0,
              "max": 2,
              "step": 0.1,
              "placeholder": "留空则用服务商默认",
              "help": "越低越稳定，剧本拆解建议 0.3–0.7",
              "wired": true
            },
            {
              "key": "maxTokens",
              "type": "number",
              "label": "最大输出 max_tokens",
              "min": 256,
              "max": 65536,
              "step": 256,
              "placeholder": "留空则用服务商默认",
              "help": "单次响应上限，分镜批量生成时需放宽",
              "wired": true
            },
            {
              "key": "jsonMode",
              "type": "boolean",
              "label": "强制 JSON 输出",
              "default": false,
              "help": "开启后带 response_format=json_object，分镜解析失败率更低",
              "wired": true
            }
          ],
          "models": [
            {
              "id": "gpt-4.1-mini",
              "label": "gpt-4.1-mini",
              "capability": [
                "文生",
                "无音轨",
                "无水印"
              ],
              "spec": {
                "modes": [
                  "text"
                ],
                "contextTokens": 1000000,
                "tools": true
              },
              "params": [
                {
                  "key": "temperature",
                  "type": "number",
                  "label": "温度 temperature",
                  "min": 0,
                  "max": 2,
                  "step": 0.1,
                  "placeholder": "留空则用服务商默认",
                  "help": "越低越稳定，剧本拆解建议 0.3–0.7",
                  "wired": true
                },
                {
                  "key": "maxTokens",
                  "type": "number",
                  "label": "最大输出 max_tokens",
                  "min": 256,
                  "max": 65536,
                  "step": 256,
                  "placeholder": "留空则用服务商默认",
                  "help": "单次响应上限，分镜批量生成时需放宽",
                  "wired": true
                },
                {
                  "key": "jsonMode",
                  "type": "boolean",
                  "label": "强制 JSON 输出",
                  "default": false,
                  "help": "开启后带 response_format=json_object，分镜解析失败率更低",
                  "wired": true
                }
              ]
            },
            {
              "id": "gpt-4.1",
              "label": "gpt-4.1",
              "capability": [
                "文生",
                "无音轨",
                "无水印"
              ],
              "spec": {
                "modes": [
                  "text"
                ],
                "contextTokens": 1000000,
                "tools": true
              },
              "params": [
                {
                  "key": "temperature",
                  "type": "number",
                  "label": "温度 temperature",
                  "min": 0,
                  "max": 2,
                  "step": 0.1,
                  "placeholder": "留空则用服务商默认",
                  "help": "越低越稳定，剧本拆解建议 0.3–0.7",
                  "wired": true
                },
                {
                  "key": "maxTokens",
                  "type": "number",
                  "label": "最大输出 max_tokens",
                  "min": 256,
                  "max": 65536,
                  "step": 256,
                  "placeholder": "留空则用服务商默认",
                  "help": "单次响应上限，分镜批量生成时需放宽",
                  "wired": true
                },
                {
                  "key": "jsonMode",
                  "type": "boolean",
                  "label": "强制 JSON 输出",
                  "default": false,
                  "help": "开启后带 response_format=json_object，分镜解析失败率更低",
                  "wired": true
                }
              ]
            },
            {
              "id": "gpt-5-mini",
              "label": "gpt-5-mini",
              "capability": [
                "文生",
                "无音轨",
                "无水印"
              ],
              "spec": {
                "modes": [
                  "text"
                ],
                "contextTokens": 400000,
                "tools": true
              },
              "params": [
                {
                  "key": "temperature",
                  "type": "number",
                  "label": "温度 temperature",
                  "min": 0,
                  "max": 2,
                  "step": 0.1,
                  "placeholder": "留空则用服务商默认",
                  "help": "越低越稳定，剧本拆解建议 0.3–0.7",
                  "wired": true
                },
                {
                  "key": "maxTokens",
                  "type": "number",
                  "label": "最大输出 max_tokens",
                  "min": 256,
                  "max": 65536,
                  "step": 256,
                  "placeholder": "留空则用服务商默认",
                  "help": "单次响应上限，分镜批量生成时需放宽",
                  "wired": true
                },
                {
                  "key": "jsonMode",
                  "type": "boolean",
                  "label": "强制 JSON 输出",
                  "default": false,
                  "help": "开启后带 response_format=json_object，分镜解析失败率更低",
                  "wired": true
                }
              ]
            }
          ]
        },
        {
          "id": "ark",
          "vendor": "ark",
          "label": "火山方舟",
          "desc": "",
          "live": true,
          "unavailableReason": "",
          "secret": [
            {
              "name": "apiKey",
              "label": "API KEY",
              "slot": "chatArk",
              "required": true
            }
          ],
          "billing": null,
          "defaults": {
            "baseUrl": "https://ark.cn-beijing.volces.com/api/v3",
            "endpoint": "/chat/completions",
            "model": "doubao-seed-2-0-pro"
          },
          "params": [
            {
              "key": "temperature",
              "type": "number",
              "label": "温度 temperature",
              "min": 0,
              "max": 2,
              "step": 0.1,
              "placeholder": "留空则用服务商默认",
              "help": "越低越稳定，剧本拆解建议 0.3–0.7",
              "wired": true
            },
            {
              "key": "maxTokens",
              "type": "number",
              "label": "最大输出 max_tokens",
              "min": 256,
              "max": 65536,
              "step": 256,
              "placeholder": "留空则用服务商默认",
              "help": "单次响应上限，分镜批量生成时需放宽",
              "wired": true
            },
            {
              "key": "jsonMode",
              "type": "boolean",
              "label": "强制 JSON 输出",
              "default": false,
              "help": "开启后带 response_format=json_object，分镜解析失败率更低",
              "wired": true
            }
          ],
          "models": [
            {
              "id": "doubao-seed-2-0-pro",
              "label": "doubao-seed-2-0-pro",
              "capability": [
                "文生",
                "无音轨",
                "无水印"
              ],
              "spec": {
                "modes": [
                  "text"
                ],
                "contextTokens": 256000,
                "tools": true
              },
              "params": [
                {
                  "key": "temperature",
                  "type": "number",
                  "label": "温度 temperature",
                  "min": 0,
                  "max": 2,
                  "step": 0.1,
                  "placeholder": "留空则用服务商默认",
                  "help": "越低越稳定，剧本拆解建议 0.3–0.7",
                  "wired": true
                },
                {
                  "key": "maxTokens",
                  "type": "number",
                  "label": "最大输出 max_tokens",
                  "min": 256,
                  "max": 65536,
                  "step": 256,
                  "placeholder": "留空则用服务商默认",
                  "help": "单次响应上限，分镜批量生成时需放宽",
                  "wired": true
                },
                {
                  "key": "jsonMode",
                  "type": "boolean",
                  "label": "强制 JSON 输出",
                  "default": false,
                  "help": "开启后带 response_format=json_object，分镜解析失败率更低",
                  "wired": true
                }
              ]
            },
            {
              "id": "doubao-seed-2-0-lite",
              "label": "doubao-seed-2-0-lite",
              "capability": [
                "文生",
                "无音轨",
                "无水印"
              ],
              "spec": {
                "modes": [
                  "text"
                ],
                "contextTokens": 256000,
                "tools": true
              },
              "params": [
                {
                  "key": "temperature",
                  "type": "number",
                  "label": "温度 temperature",
                  "min": 0,
                  "max": 2,
                  "step": 0.1,
                  "placeholder": "留空则用服务商默认",
                  "help": "越低越稳定，剧本拆解建议 0.3–0.7",
                  "wired": true
                },
                {
                  "key": "maxTokens",
                  "type": "number",
                  "label": "最大输出 max_tokens",
                  "min": 256,
                  "max": 65536,
                  "step": 256,
                  "placeholder": "留空则用服务商默认",
                  "help": "单次响应上限，分镜批量生成时需放宽",
                  "wired": true
                },
                {
                  "key": "jsonMode",
                  "type": "boolean",
                  "label": "强制 JSON 输出",
                  "default": false,
                  "help": "开启后带 response_format=json_object，分镜解析失败率更低",
                  "wired": true
                }
              ]
            }
          ]
        }
      ]
    },
    {
      "kind": "image",
      "label": "图片模型",
      "desc": "首帧与角色定妆；参考图数量受各模型能力限制。",
      "providers": [
        {
          "id": "ark",
          "vendor": "ark",
          "label": "火山方舟 · Seedream",
          "desc": "",
          "live": true,
          "unavailableReason": "",
          "secret": [
            {
              "name": "apiKey",
              "label": "API KEY",
              "slot": "image",
              "required": true
            }
          ],
          "billing": null,
          "defaults": {
            "baseUrl": "https://ark.cn-beijing.volces.com/api/v3",
            "endpoint": "/images/generations",
            "model": "doubao-seedream-5-0-flash-260915"
          },
          "params": [
            {
              "key": "size",
              "type": "select",
              "label": "画幅尺寸 size",
              "options": [
                "1024x1024",
                "1024x1536",
                "1536x1024",
                "2048x2048"
              ],
              "default": "1024x1536",
              "help": "竖屏短剧用 1024x1536（2:3），避免后期加黑边",
              "wired": false
            },
            {
              "key": "watermark",
              "type": "boolean",
              "label": "水印",
              "default": false,
              "help": "关闭后成片无「AI 生成」标识",
              "wired": true
            },
            {
              "key": "responseFormat",
              "type": "select",
              "label": "返回方式 response_format",
              "options": [
                "url",
                "b64_json"
              ],
              "default": "url",
              "help": "url 直接拿链接，b64_json 内联返回（适合大图落盘）",
              "wired": false
            },
            {
              "key": "seed",
              "type": "number",
              "label": "随机种子 seed",
              "min": 0,
              "max": 4294967295,
              "step": 1,
              "placeholder": "留空则随机",
              "help": "固定种子可复现同一张图",
              "wired": false
            }
          ],
          "models": [
            {
              "id": "doubao-seedream-5-0-flash-260915",
              "label": "doubao-seedream-5-0-flash-260915",
              "capability": [
                "文生",
                "多参考×10",
                "无音轨",
                "无水印",
                "1024x1024/1024x1536/1536x1024"
              ],
              "spec": {
                "modes": [
                  "text",
                  "reference"
                ],
                "resolutions": [
                  "1024x1024",
                  "1024x1536",
                  "1536x1024"
                ],
                "references": 10,
                "watermark": false
              },
              "params": [
                {
                  "key": "size",
                  "type": "select",
                  "label": "画幅尺寸 size",
                  "options": [
                    "1024x1024",
                    "1024x1536",
                    "1536x1024"
                  ],
                  "default": "1024x1536",
                  "help": "竖屏短剧用 1024x1536（2:3），避免后期加黑边",
                  "wired": false
                },
                {
                  "key": "watermark",
                  "type": "boolean",
                  "label": "水印",
                  "default": false,
                  "help": "关闭后成片无「AI 生成」标识",
                  "wired": true
                },
                {
                  "key": "responseFormat",
                  "type": "select",
                  "label": "返回方式 response_format",
                  "options": [
                    "url",
                    "b64_json"
                  ],
                  "default": "url",
                  "help": "url 直接拿链接，b64_json 内联返回（适合大图落盘）",
                  "wired": false
                },
                {
                  "key": "seed",
                  "type": "number",
                  "label": "随机种子 seed",
                  "min": 0,
                  "max": 4294967295,
                  "step": 1,
                  "placeholder": "留空则随机",
                  "help": "固定种子可复现同一张图",
                  "wired": false
                }
              ]
            },
            {
              "id": "doubao-seedream-5-0-pro-260915",
              "label": "doubao-seedream-5-0-pro-260915",
              "capability": [
                "文生",
                "多参考×10",
                "无音轨",
                "无水印",
                "1024x1024/2048x2048"
              ],
              "spec": {
                "modes": [
                  "text",
                  "reference"
                ],
                "resolutions": [
                  "1024x1024",
                  "2048x2048"
                ],
                "references": 10,
                "watermark": false
              },
              "params": [
                {
                  "key": "size",
                  "type": "select",
                  "label": "画幅尺寸 size",
                  "options": [
                    "1024x1024",
                    "2048x2048"
                  ],
                  "default": "1024x1024",
                  "help": "竖屏短剧用 1024x1536（2:3），避免后期加黑边",
                  "wired": false
                },
                {
                  "key": "watermark",
                  "type": "boolean",
                  "label": "水印",
                  "default": false,
                  "help": "关闭后成片无「AI 生成」标识",
                  "wired": true
                },
                {
                  "key": "responseFormat",
                  "type": "select",
                  "label": "返回方式 response_format",
                  "options": [
                    "url",
                    "b64_json"
                  ],
                  "default": "url",
                  "help": "url 直接拿链接，b64_json 内联返回（适合大图落盘）",
                  "wired": false
                },
                {
                  "key": "seed",
                  "type": "number",
                  "label": "随机种子 seed",
                  "min": 0,
                  "max": 4294967295,
                  "step": 1,
                  "placeholder": "留空则随机",
                  "help": "固定种子可复现同一张图",
                  "wired": false
                }
              ]
            }
          ]
        },
        {
          "id": "dashscope",
          "vendor": "dashscope",
          "label": "阿里云 · 万相",
          "desc": "",
          "live": true,
          "unavailableReason": "",
          "secret": [
            {
              "name": "apiKey",
              "label": "API KEY",
              "slot": "imageDashscope",
              "required": true
            }
          ],
          "billing": null,
          "defaults": {
            "baseUrl": "https://dashscope.aliyuncs.com",
            "endpoint": "/api/v1/services/aigc/multimodal-generation/generation",
            "model": "wan2.7-image"
          },
          "params": [
            {
              "key": "size",
              "type": "select",
              "label": "画幅尺寸 size",
              "options": [
                "1024*1024",
                "1024*1536",
                "2048*2048"
              ],
              "default": "1024*1536",
              "help": "百炼用星号分隔（1024*1536），与方舟的 1024x1536 写法不同，已按通道各自转换",
              "wired": false
            },
            {
              "key": "watermark",
              "type": "boolean",
              "label": "水印",
              "default": false,
              "help": "万相免费额度下也可关闭水印",
              "wired": true
            },
            {
              "key": "promptExtend",
              "type": "boolean",
              "label": "提示词扩写 prompt_extend",
              "default": true,
              "help": "开启后平台自动补全描述，角色一致性场景建议关闭",
              "wired": false
            },
            {
              "key": "n",
              "type": "number",
              "label": "生成张数 n",
              "min": 1,
              "max": 4,
              "step": 1,
              "default": 1,
              "help": "单次请求出图数量，影响额度消耗",
              "wired": false
            }
          ],
          "models": [
            {
              "id": "wan2.7-image",
              "label": "wan2.7-image",
              "capability": [
                "文生",
                "多参考×9",
                "无音轨",
                "无水印",
                "1024*1024/1024*1536"
              ],
              "spec": {
                "modes": [
                  "text",
                  "reference"
                ],
                "resolutions": [
                  "1024*1024",
                  "1024*1536"
                ],
                "references": 9,
                "watermark": false,
                "note": "唯一能锁角色一致性的多图参考通道"
              },
              "params": [
                {
                  "key": "size",
                  "type": "select",
                  "label": "画幅尺寸 size",
                  "options": [
                    "1024*1024",
                    "1024*1536"
                  ],
                  "default": "1024*1536",
                  "help": "百炼用星号分隔（1024*1536），与方舟的 1024x1536 写法不同，已按通道各自转换",
                  "wired": false
                },
                {
                  "key": "watermark",
                  "type": "boolean",
                  "label": "水印",
                  "default": false,
                  "help": "万相免费额度下也可关闭水印",
                  "wired": true
                },
                {
                  "key": "promptExtend",
                  "type": "boolean",
                  "label": "提示词扩写 prompt_extend",
                  "default": true,
                  "help": "开启后平台自动补全描述，角色一致性场景建议关闭",
                  "wired": false
                },
                {
                  "key": "n",
                  "type": "number",
                  "label": "生成张数 n",
                  "min": 1,
                  "max": 4,
                  "step": 1,
                  "default": 1,
                  "help": "单次请求出图数量，影响额度消耗",
                  "wired": false
                }
              ]
            },
            {
              "id": "wan2.7-image-pro",
              "label": "wan2.7-image-pro",
              "capability": [
                "文生",
                "多参考×9",
                "无音轨",
                "无水印",
                "1024*1024/2048*2048"
              ],
              "spec": {
                "modes": [
                  "text",
                  "reference"
                ],
                "resolutions": [
                  "1024*1024",
                  "2048*2048"
                ],
                "references": 9,
                "watermark": false
              },
              "params": [
                {
                  "key": "size",
                  "type": "select",
                  "label": "画幅尺寸 size",
                  "options": [
                    "1024*1024",
                    "2048*2048"
                  ],
                  "default": "1024*1024",
                  "help": "百炼用星号分隔（1024*1536），与方舟的 1024x1536 写法不同，已按通道各自转换",
                  "wired": false
                },
                {
                  "key": "watermark",
                  "type": "boolean",
                  "label": "水印",
                  "default": false,
                  "help": "万相免费额度下也可关闭水印",
                  "wired": true
                },
                {
                  "key": "promptExtend",
                  "type": "boolean",
                  "label": "提示词扩写 prompt_extend",
                  "default": true,
                  "help": "开启后平台自动补全描述，角色一致性场景建议关闭",
                  "wired": false
                },
                {
                  "key": "n",
                  "type": "number",
                  "label": "生成张数 n",
                  "min": 1,
                  "max": 4,
                  "step": 1,
                  "default": 1,
                  "help": "单次请求出图数量，影响额度消耗",
                  "wired": false
                }
              ]
            },
            {
              "id": "qwen-image-2.1-pro",
              "label": "qwen-image-2.1-pro",
              "capability": [
                "文生",
                "无音轨",
                "无水印",
                "1024*1024"
              ],
              "spec": {
                "modes": [
                  "text"
                ],
                "resolutions": [
                  "1024*1024"
                ],
                "references": 0,
                "watermark": false
              },
              "params": [
                {
                  "key": "size",
                  "type": "select",
                  "label": "画幅尺寸 size",
                  "options": [
                    "1024*1024"
                  ],
                  "default": "1024*1024",
                  "help": "百炼用星号分隔（1024*1536），与方舟的 1024x1536 写法不同，已按通道各自转换",
                  "wired": false
                },
                {
                  "key": "watermark",
                  "type": "boolean",
                  "label": "水印",
                  "default": false,
                  "help": "万相免费额度下也可关闭水印",
                  "wired": true
                },
                {
                  "key": "promptExtend",
                  "type": "boolean",
                  "label": "提示词扩写 prompt_extend",
                  "default": true,
                  "help": "开启后平台自动补全描述，角色一致性场景建议关闭",
                  "wired": false
                },
                {
                  "key": "n",
                  "type": "number",
                  "label": "生成张数 n",
                  "min": 1,
                  "max": 4,
                  "step": 1,
                  "default": 1,
                  "help": "单次请求出图数量，影响额度消耗",
                  "wired": false
                }
              ]
            }
          ]
        },
        {
          "id": "zhipu",
          "vendor": "zhipu",
          "label": "智谱 · CogView",
          "desc": "",
          "live": true,
          "unavailableReason": "",
          "secret": [
            {
              "name": "apiKey",
              "label": "API KEY",
              "slot": "imageZhipu",
              "required": true
            }
          ],
          "billing": null,
          "defaults": {
            "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
            "endpoint": "/images/generations",
            "model": "cogview-3-flash"
          },
          "params": [
            {
              "key": "size",
              "type": "select",
              "label": "画幅尺寸 size",
              "options": [
                "1024x1024",
                "768x1344",
                "1440x720"
              ],
              "default": "768x1344",
              "help": "CogView 不支持自定义参考图，角色一致性需靠提示词固定",
              "wired": false
            }
          ],
          "models": [
            {
              "id": "cogview-3-flash",
              "label": "cogview-3-flash",
              "capability": [
                "文生",
                "无音轨",
                "无水印",
                "1024x1024/768x1344"
              ],
              "spec": {
                "modes": [
                  "text"
                ],
                "resolutions": [
                  "1024x1024",
                  "768x1344"
                ],
                "references": 0,
                "watermark": false,
                "freeTier": true
              },
              "params": [
                {
                  "key": "size",
                  "type": "select",
                  "label": "画幅尺寸 size",
                  "options": [
                    "1024x1024",
                    "768x1344"
                  ],
                  "default": "768x1344",
                  "help": "CogView 不支持自定义参考图，角色一致性需靠提示词固定",
                  "wired": false
                }
              ]
            },
            {
              "id": "cogview-4-250304",
              "label": "cogview-4-250304",
              "capability": [
                "文生",
                "无音轨",
                "无水印",
                "1024x1024/1440x720"
              ],
              "spec": {
                "modes": [
                  "text"
                ],
                "resolutions": [
                  "1024x1024",
                  "1440x720"
                ],
                "references": 0,
                "watermark": false
              },
              "params": [
                {
                  "key": "size",
                  "type": "select",
                  "label": "画幅尺寸 size",
                  "options": [
                    "1024x1024",
                    "1440x720"
                  ],
                  "default": "1024x1024",
                  "help": "CogView 不支持自定义参考图，角色一致性需靠提示词固定",
                  "wired": false
                }
              ]
            }
          ]
        }
      ]
    },
    {
      "kind": "video",
      "label": "视频模型",
      "desc": "分镜成片；异步任务制，提交后轮询至终态。",
      "providers": [
        {
          "id": "agentPlan",
          "vendor": "agentPlan",
          "label": "火山引擎 · Seedance",
          "desc": "",
          "live": true,
          "unavailableReason": "",
          "secret": [
            {
              "name": "apiKey",
              "label": "API KEY",
              "slot": "video",
              "required": true
            }
          ],
          "billing": null,
          "defaults": {
            "baseUrl": "https://ark.cn-beijing.volces.com/api/plan/v3",
            "endpoint": "/contents/generations/tasks",
            "model": "doubao-seedance-2.0"
          },
          "params": [
            {
              "key": "resolution",
              "type": "select",
              "label": "分辨率 resolution",
              "options": [
                "720p",
                "1080p"
              ],
              "default": "1080p",
              "help": "以 --resolution 参数拼进 prompt 尾部，不是独立字段",
              "wired": true
            },
            {
              "key": "duration",
              "type": "number",
              "label": "时长 duration（秒）",
              "min": 5,
              "max": 10,
              "step": 1,
              "default": 5,
              "help": "Seedance 2.x 单镜建议 5 秒，长镜需分镜拼接",
              "wired": false
            },
            {
              "key": "aspectRatio",
              "type": "select",
              "label": "画面比例 ratio",
              "options": [
                "16:9",
                "9:16",
                "1:1"
              ],
              "default": "9:16",
              "help": "竖屏短剧固定 9:16，改比例会让图生视频继承错误画幅",
              "wired": false
            }
          ],
          "models": [
            {
              "id": "doubao-seedance-2.0",
              "label": "doubao-seedance-2.0",
              "capability": [
                "文生",
                "首帧",
                "带音轨",
                "无水印",
                "720p/1080p"
              ],
              "spec": {
                "modes": [
                  "text",
                  "first"
                ],
                "resolutions": [
                  "720p",
                  "1080p"
                ],
                "references": 1,
                "audio": true,
                "watermark": false
              },
              "params": [
                {
                  "key": "resolution",
                  "type": "select",
                  "label": "分辨率 resolution",
                  "options": [
                    "720p",
                    "1080p"
                  ],
                  "default": "1080p",
                  "help": "以 --resolution 参数拼进 prompt 尾部，不是独立字段",
                  "wired": true
                },
                {
                  "key": "duration",
                  "type": "number",
                  "label": "时长 duration（秒）",
                  "min": 5,
                  "max": 10,
                  "step": 1,
                  "default": 5,
                  "help": "Seedance 2.x 单镜建议 5 秒，长镜需分镜拼接",
                  "wired": false
                },
                {
                  "key": "aspectRatio",
                  "type": "select",
                  "label": "画面比例 ratio",
                  "options": [
                    "16:9",
                    "9:16",
                    "1:1"
                  ],
                  "default": "9:16",
                  "help": "竖屏短剧固定 9:16，改比例会让图生视频继承错误画幅",
                  "wired": false
                }
              ]
            },
            {
              "id": "doubao-seedance-2.0-fast",
              "label": "doubao-seedance-2.0-fast",
              "capability": [
                "文生",
                "首帧",
                "带音轨",
                "无水印",
                "720p/1080p"
              ],
              "spec": {
                "modes": [
                  "text",
                  "first"
                ],
                "resolutions": [
                  "720p",
                  "1080p"
                ],
                "references": 1,
                "audio": true,
                "watermark": false
              },
              "params": [
                {
                  "key": "resolution",
                  "type": "select",
                  "label": "分辨率 resolution",
                  "options": [
                    "720p",
                    "1080p"
                  ],
                  "default": "1080p",
                  "help": "以 --resolution 参数拼进 prompt 尾部，不是独立字段",
                  "wired": true
                },
                {
                  "key": "duration",
                  "type": "number",
                  "label": "时长 duration（秒）",
                  "min": 5,
                  "max": 10,
                  "step": 1,
                  "default": 5,
                  "help": "Seedance 2.x 单镜建议 5 秒，长镜需分镜拼接",
                  "wired": false
                },
                {
                  "key": "aspectRatio",
                  "type": "select",
                  "label": "画面比例 ratio",
                  "options": [
                    "16:9",
                    "9:16",
                    "1:1"
                  ],
                  "default": "9:16",
                  "help": "竖屏短剧固定 9:16，改比例会让图生视频继承错误画幅",
                  "wired": false
                }
              ]
            },
            {
              "id": "doubao-seedance-2.0-mini",
              "label": "doubao-seedance-2.0-mini",
              "capability": [
                "文生",
                "首帧",
                "带音轨",
                "无水印",
                "720p/1080p"
              ],
              "spec": {
                "modes": [
                  "text",
                  "first"
                ],
                "resolutions": [
                  "720p",
                  "1080p"
                ],
                "references": 1,
                "audio": true,
                "watermark": false
              },
              "params": [
                {
                  "key": "resolution",
                  "type": "select",
                  "label": "分辨率 resolution",
                  "options": [
                    "720p",
                    "1080p"
                  ],
                  "default": "1080p",
                  "help": "以 --resolution 参数拼进 prompt 尾部，不是独立字段",
                  "wired": true
                },
                {
                  "key": "duration",
                  "type": "number",
                  "label": "时长 duration（秒）",
                  "min": 5,
                  "max": 10,
                  "step": 1,
                  "default": 5,
                  "help": "Seedance 2.x 单镜建议 5 秒，长镜需分镜拼接",
                  "wired": false
                },
                {
                  "key": "aspectRatio",
                  "type": "select",
                  "label": "画面比例 ratio",
                  "options": [
                    "16:9",
                    "9:16",
                    "1:1"
                  ],
                  "default": "9:16",
                  "help": "竖屏短剧固定 9:16，改比例会让图生视频继承错误画幅",
                  "wired": false
                }
              ]
            },
            {
              "id": "doubao-seedance-2.5",
              "label": "doubao-seedance-2.5",
              "capability": [
                "文生",
                "首帧",
                "带音轨",
                "无水印",
                "720p/1080p/2k"
              ],
              "spec": {
                "modes": [
                  "text",
                  "first"
                ],
                "resolutions": [
                  "720p",
                  "1080p",
                  "2k"
                ],
                "references": 1,
                "audio": true,
                "watermark": false
              },
              "params": [
                {
                  "key": "resolution",
                  "type": "select",
                  "label": "分辨率 resolution",
                  "options": [
                    "720p",
                    "1080p",
                    "2k"
                  ],
                  "default": "1080p",
                  "help": "以 --resolution 参数拼进 prompt 尾部，不是独立字段",
                  "wired": true
                },
                {
                  "key": "duration",
                  "type": "number",
                  "label": "时长 duration（秒）",
                  "min": 5,
                  "max": 10,
                  "step": 1,
                  "default": 5,
                  "help": "Seedance 2.x 单镜建议 5 秒，长镜需分镜拼接",
                  "wired": false
                },
                {
                  "key": "aspectRatio",
                  "type": "select",
                  "label": "画面比例 ratio",
                  "options": [
                    "16:9",
                    "9:16",
                    "1:1"
                  ],
                  "default": "9:16",
                  "help": "竖屏短剧固定 9:16，改比例会让图生视频继承错误画幅",
                  "wired": false
                }
              ]
            }
          ]
        },
        {
          "id": "dashscope",
          "vendor": "dashscope",
          "label": "阿里云 · 万相",
          "desc": "",
          "live": true,
          "unavailableReason": "",
          "secret": [
            {
              "name": "apiKey",
              "label": "API KEY",
              "slot": "videoDashscope",
              "required": true
            }
          ],
          "billing": null,
          "defaults": {
            "baseUrl": "https://dashscope.aliyuncs.com",
            "endpoint": "/api/v1/services/aigc/video-generation/video-synthesis",
            "model": "wan3.0-video"
          },
          "params": [
            {
              "key": "mode",
              "type": "select",
              "label": "生成模式 mode",
              "options": [
                "text",
                "first",
                "keyframes"
              ],
              "default": "text",
              "help": "text 文生；first 单首帧；keyframes 首尾帧（仅 wan3.0-video）",
              "wired": false
            },
            {
              "key": "resolution",
              "type": "select",
              "label": "分辨率 resolution",
              "options": [
                "720p",
                "1080p"
              ],
              "default": "1080p",
              "help": "1080p 消耗额度翻倍",
              "wired": true
            },
            {
              "key": "duration",
              "type": "number",
              "label": "时长 duration（秒）",
              "min": 5,
              "max": 10,
              "step": 1,
              "default": 5,
              "help": "万相按 5 秒/档计费",
              "wired": false
            },
            {
              "key": "audio",
              "type": "boolean",
              "label": "生成音轨 audio",
              "default": true,
              "help": "关闭后成片无声道，需后期配",
              "wired": false
            },
            {
              "key": "aspectRatio",
              "type": "select",
              "label": "画面比例 ratio",
              "options": [
                "16:9",
                "9:16",
                "1:1"
              ],
              "default": "9:16",
              "help": "与首帧比例不一致时会被平台裁切",
              "wired": false
            }
          ],
          "models": [
            {
              "id": "wan3.0-video",
              "label": "wan3.0-video",
              "capability": [
                "文生",
                "首帧",
                "首尾帧",
                "多参考×2",
                "带音轨",
                "无水印",
                "720p/1080p"
              ],
              "spec": {
                "modes": [
                  "text",
                  "first",
                  "keyframes"
                ],
                "resolutions": [
                  "720p",
                  "1080p"
                ],
                "references": 2,
                "audio": true,
                "watermark": false
              },
              "params": [
                {
                  "key": "mode",
                  "type": "select",
                  "label": "生成模式 mode",
                  "options": [
                    "text",
                    "first",
                    "keyframes"
                  ],
                  "default": "text",
                  "help": "text 文生；first 单首帧；keyframes 首尾帧（仅 wan3.0-video）",
                  "wired": false
                },
                {
                  "key": "resolution",
                  "type": "select",
                  "label": "分辨率 resolution",
                  "options": [
                    "720p",
                    "1080p"
                  ],
                  "default": "1080p",
                  "help": "1080p 消耗额度翻倍",
                  "wired": true
                },
                {
                  "key": "duration",
                  "type": "number",
                  "label": "时长 duration（秒）",
                  "min": 5,
                  "max": 10,
                  "step": 1,
                  "default": 5,
                  "help": "万相按 5 秒/档计费",
                  "wired": false
                },
                {
                  "key": "audio",
                  "type": "boolean",
                  "label": "生成音轨 audio",
                  "default": true,
                  "help": "万相 3.0 支持原生音轨，可省掉后期配音",
                  "wired": false
                },
                {
                  "key": "aspectRatio",
                  "type": "select",
                  "label": "画面比例 ratio",
                  "options": [
                    "16:9",
                    "9:16",
                    "1:1"
                  ],
                  "default": "9:16",
                  "help": "与首帧比例不一致时会被平台裁切",
                  "wired": false
                }
              ]
            },
            {
              "id": "happyhorse-1.1-t2v",
              "label": "happyhorse-1.1-t2v",
              "capability": [
                "文生",
                "带音轨",
                "无水印",
                "720p/1080p"
              ],
              "spec": {
                "modes": [
                  "text"
                ],
                "resolutions": [
                  "720p",
                  "1080p"
                ],
                "references": 0,
                "audio": true,
                "watermark": false
              },
              "params": [
                {
                  "key": "mode",
                  "type": "select",
                  "label": "生成模式 mode",
                  "options": [
                    "text"
                  ],
                  "default": "text",
                  "help": "text 文生；first 单首帧；keyframes 首尾帧（仅 wan3.0-video）",
                  "wired": false
                },
                {
                  "key": "resolution",
                  "type": "select",
                  "label": "分辨率 resolution",
                  "options": [
                    "720p",
                    "1080p"
                  ],
                  "default": "1080p",
                  "help": "1080p 消耗额度翻倍",
                  "wired": true
                },
                {
                  "key": "duration",
                  "type": "number",
                  "label": "时长 duration（秒）",
                  "min": 5,
                  "max": 10,
                  "step": 1,
                  "default": 5,
                  "help": "万相按 5 秒/档计费",
                  "wired": false
                },
                {
                  "key": "audio",
                  "type": "boolean",
                  "label": "生成音轨 audio",
                  "default": true,
                  "help": "关闭后成片无声道，需后期配",
                  "wired": false
                },
                {
                  "key": "aspectRatio",
                  "type": "select",
                  "label": "画面比例 ratio",
                  "options": [
                    "16:9",
                    "9:16",
                    "1:1"
                  ],
                  "default": "9:16",
                  "help": "与首帧比例不一致时会被平台裁切",
                  "wired": false
                }
              ]
            },
            {
              "id": "happyhorse-1.1-i2v",
              "label": "happyhorse-1.1-i2v",
              "capability": [
                "首帧",
                "带音轨",
                "无水印",
                "720p/1080p"
              ],
              "spec": {
                "modes": [
                  "first"
                ],
                "resolutions": [
                  "720p",
                  "1080p"
                ],
                "references": 1,
                "audio": true,
                "watermark": false
              },
              "params": [
                {
                  "key": "mode",
                  "type": "select",
                  "label": "生成模式 mode",
                  "options": [
                    "first"
                  ],
                  "default": "first",
                  "help": "text 文生；first 单首帧；keyframes 首尾帧（仅 wan3.0-video）",
                  "wired": false
                },
                {
                  "key": "resolution",
                  "type": "select",
                  "label": "分辨率 resolution",
                  "options": [
                    "720p",
                    "1080p"
                  ],
                  "default": "1080p",
                  "help": "1080p 消耗额度翻倍",
                  "wired": true
                },
                {
                  "key": "duration",
                  "type": "number",
                  "label": "时长 duration（秒）",
                  "min": 5,
                  "max": 10,
                  "step": 1,
                  "default": 5,
                  "help": "万相按 5 秒/档计费",
                  "wired": false
                },
                {
                  "key": "audio",
                  "type": "boolean",
                  "label": "生成音轨 audio",
                  "default": true,
                  "help": "关闭后成片无声道，需后期配",
                  "wired": false
                },
                {
                  "key": "aspectRatio",
                  "type": "select",
                  "label": "画面比例 ratio",
                  "options": [
                    "16:9",
                    "9:16",
                    "1:1"
                  ],
                  "default": "9:16",
                  "help": "与首帧比例不一致时会被平台裁切",
                  "wired": false
                }
              ]
            },
            {
              "id": "happyhorse-1.1-r2v",
              "label": "happyhorse-1.1-r2v",
              "capability": [
                "首帧",
                "多参考×9",
                "带音轨",
                "无水印",
                "720p/1080p"
              ],
              "spec": {
                "modes": [
                  "first"
                ],
                "resolutions": [
                  "720p",
                  "1080p"
                ],
                "references": 9,
                "audio": true,
                "watermark": false
              },
              "params": [
                {
                  "key": "mode",
                  "type": "select",
                  "label": "生成模式 mode",
                  "options": [
                    "first"
                  ],
                  "default": "first",
                  "help": "text 文生；first 单首帧；keyframes 首尾帧（仅 wan3.0-video）",
                  "wired": false
                },
                {
                  "key": "resolution",
                  "type": "select",
                  "label": "分辨率 resolution",
                  "options": [
                    "720p",
                    "1080p"
                  ],
                  "default": "1080p",
                  "help": "1080p 消耗额度翻倍",
                  "wired": true
                },
                {
                  "key": "duration",
                  "type": "number",
                  "label": "时长 duration（秒）",
                  "min": 5,
                  "max": 10,
                  "step": 1,
                  "default": 5,
                  "help": "万相按 5 秒/档计费",
                  "wired": false
                },
                {
                  "key": "audio",
                  "type": "boolean",
                  "label": "生成音轨 audio",
                  "default": true,
                  "help": "关闭后成片无声道，需后期配",
                  "wired": false
                },
                {
                  "key": "aspectRatio",
                  "type": "select",
                  "label": "画面比例 ratio",
                  "options": [
                    "16:9",
                    "9:16",
                    "1:1"
                  ],
                  "default": "9:16",
                  "help": "与首帧比例不一致时会被平台裁切",
                  "wired": false
                }
              ]
            }
          ]
        },
        {
          "id": "zhipu",
          "vendor": "zhipu",
          "label": "智谱 · CogVideoX",
          "desc": "",
          "live": true,
          "unavailableReason": "",
          "secret": [
            {
              "name": "apiKey",
              "label": "API KEY",
              "slot": "videoZhipu",
              "required": true
            }
          ],
          "billing": null,
          "defaults": {
            "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
            "endpoint": "/videos/generations",
            "model": "cogvideox-flash"
          },
          "params": [
            {
              "key": "withAudio",
              "type": "boolean",
              "label": "生成音轨 with_audio",
              "default": false,
              "help": "仅 cogvideox-3 支持；Flash/2.0 开启无效",
              "wired": false
            },
            {
              "key": "duration",
              "type": "select",
              "label": "时长 duration（秒）",
              "options": [
                "5",
                "10"
              ],
              "default": "5",
              "help": "智谱按固定档位出片，非任意秒数",
              "wired": false
            }
          ],
          "models": [
            {
              "id": "cogvideox-flash",
              "label": "cogvideox-flash",
              "capability": [
                "文生",
                "首帧",
                "无音轨",
                "有标识",
                "1080p"
              ],
              "spec": {
                "modes": [
                  "text",
                  "first"
                ],
                "resolutions": [
                  "1080p"
                ],
                "references": 1,
                "audio": false,
                "watermark": true,
                "freeTier": true
              },
              "params": [
                {
                  "key": "withAudio",
                  "type": "readonly",
                  "label": "生成音轨 with_audio",
                  "default": false,
                  "help": "Flash 无音轨",
                  "wired": false
                },
                {
                  "key": "duration",
                  "type": "select",
                  "label": "时长 duration（秒）",
                  "options": [
                    "5",
                    "10"
                  ],
                  "default": "5",
                  "help": "智谱按固定档位出片，非任意秒数",
                  "wired": false
                }
              ]
            },
            {
              "id": "cogvideox-2",
              "label": "cogvideox-2",
              "capability": [
                "文生",
                "首帧",
                "无音轨",
                "有标识",
                "1080p"
              ],
              "spec": {
                "modes": [
                  "text",
                  "first"
                ],
                "resolutions": [
                  "1080p"
                ],
                "references": 1,
                "audio": false,
                "watermark": true
              },
              "params": [
                {
                  "key": "withAudio",
                  "type": "readonly",
                  "label": "生成音轨 with_audio",
                  "default": false,
                  "help": "2.0 无音轨",
                  "wired": false
                },
                {
                  "key": "duration",
                  "type": "select",
                  "label": "时长 duration（秒）",
                  "options": [
                    "5",
                    "10"
                  ],
                  "default": "5",
                  "help": "智谱按固定档位出片，非任意秒数",
                  "wired": false
                }
              ]
            },
            {
              "id": "cogvideox-3",
              "label": "cogvideox-3",
              "capability": [
                "文生",
                "首帧",
                "带音轨",
                "无水印",
                "1080p"
              ],
              "spec": {
                "modes": [
                  "text",
                  "first"
                ],
                "resolutions": [
                  "1080p"
                ],
                "references": 1,
                "audio": true,
                "watermark": false
              },
              "params": [
                {
                  "key": "withAudio",
                  "type": "boolean",
                  "label": "生成音轨 with_audio",
                  "default": true,
                  "help": "3.0 支持原生音轨",
                  "wired": false
                },
                {
                  "key": "duration",
                  "type": "select",
                  "label": "时长 duration（秒）",
                  "options": [
                    "5",
                    "10"
                  ],
                  "default": "5",
                  "help": "智谱按固定档位出片，非任意秒数",
                  "wired": false
                }
              ]
            }
          ]
        },
        {
          "id": "tencent",
          "vendor": "tencent",
          "label": "腾讯云 · 混元生视频",
          "desc": "",
          "live": true,
          "unavailableReason": "",
          "secret": [
            {
              "name": "secretId",
              "label": "SecretId",
              "slot": "videoTencentId",
              "required": true
            },
            {
              "name": "secretKey",
              "label": "SecretKey",
              "slot": "videoTencentKey",
              "required": true
            }
          ],
          "billing": {
            "free": "50 点一次性免费资源包 · 有效期 1 年",
            "guard": "default-stop",
            "requiresConfirmation": true,
            "note": "不开后付费；资源包用尽即停，不会自动转按量计费"
          },
          "defaults": {
            "baseUrl": "https://vclm.tencentcloudapi.com",
            "endpoint": "/",
            "model": "hunyuan-video"
          },
          "params": [
            {
              "key": "resolution",
              "type": "select",
              "label": "分辨率 Resolution",
              "options": [
                "720p"
              ],
              "default": "720p",
              "help": "官方当前仅 720p；1080p 需走专业版接口，未在此通道开放",
              "wired": true
            },
            {
              "key": "duration",
              "type": "number",
              "label": "时长（秒）",
              "min": 5,
              "max": 5,
              "step": 1,
              "default": 5,
              "help": "单条固定 5 秒，并发上限 1（云端排队）",
              "wired": false
            }
          ],
          "models": [
            {
              "id": "hunyuan-video",
              "label": "hunyuan-video",
              "capability": [
                "文生",
                "首帧",
                "无音轨",
                "有标识",
                "720p"
              ],
              "spec": {
                "modes": [
                  "text",
                  "first"
                ],
                "resolutions": [
                  "720p"
                ],
                "references": 1,
                "audio": false,
                "watermark": true,
                "concurrency": 1
              },
              "params": [
                {
                  "key": "resolution",
                  "type": "select",
                  "label": "分辨率 Resolution",
                  "options": [
                    "720p"
                  ],
                  "default": "720p",
                  "help": "官方当前仅 720p；1080p 需走专业版接口，未在此通道开放",
                  "wired": true
                },
                {
                  "key": "duration",
                  "type": "number",
                  "label": "时长（秒）",
                  "min": 5,
                  "max": 5,
                  "step": 1,
                  "default": 5,
                  "help": "单条固定 5 秒，并发上限 1（云端排队）",
                  "wired": false
                }
              ]
            }
          ]
        },
        {
          "id": "openai",
          "vendor": "openai",
          "label": "OpenAI · Sora",
          "desc": "",
          "live": false,
          "unavailableReason": "OpenAI Sora 的提交与轮询接口尚未接入本地代理，先把地址与参数存好，接完后一句切换即可。",
          "secret": [
            {
              "name": "apiKey",
              "label": "API KEY",
              "slot": "videoOpenai",
              "required": true
            }
          ],
          "billing": null,
          "defaults": {
            "baseUrl": "https://api.openai.com/v1",
            "endpoint": "/videos",
            "model": "sora-2"
          },
          "params": [
            {
              "key": "resolution",
              "type": "select",
              "label": "分辨率 size",
              "options": [
                "720p",
                "1080p",
                "1792x1024"
              ],
              "default": "720p",
              "help": "720p 映射 1280x720，1080p 映射 1792x1024",
              "wired": true
            },
            {
              "key": "duration",
              "type": "select",
              "label": "时长 seconds",
              "options": [
                "4",
                "8",
                "12"
              ],
              "default": "8",
              "help": "Sora 按档位计费，4/8/12 秒",
              "wired": false
            }
          ],
          "models": [
            {
              "id": "sora-2",
              "label": "sora-2",
              "capability": [
                "文生",
                "首帧",
                "带音轨",
                "无水印",
                "720p/1080p"
              ],
              "spec": {
                "modes": [
                  "text",
                  "first"
                ],
                "resolutions": [
                  "720p",
                  "1080p"
                ],
                "references": 1,
                "audio": true,
                "watermark": false,
                "durationRange": [
                  4,
                  12
                ]
              },
              "params": [
                {
                  "key": "resolution",
                  "type": "select",
                  "label": "分辨率 size",
                  "options": [
                    "720p",
                    "1080p"
                  ],
                  "default": "720p",
                  "help": "720p 映射 1280x720，1080p 映射 1792x1024",
                  "wired": true
                },
                {
                  "key": "duration",
                  "type": "select",
                  "label": "时长 seconds",
                  "options": [
                    "4",
                    "8",
                    "12"
                  ],
                  "default": "8",
                  "help": "Sora 按档位计费，4/8/12 秒",
                  "wired": false
                }
              ]
            },
            {
              "id": "sora-2-pro",
              "label": "sora-2-pro",
              "capability": [
                "文生",
                "首帧",
                "带音轨",
                "无水印",
                "720p/1080p/1792x1024"
              ],
              "spec": {
                "modes": [
                  "text",
                  "first"
                ],
                "resolutions": [
                  "720p",
                  "1080p",
                  "1792x1024"
                ],
                "references": 1,
                "audio": true,
                "watermark": false
              },
              "params": [
                {
                  "key": "resolution",
                  "type": "select",
                  "label": "分辨率 size",
                  "options": [
                    "720p",
                    "1080p",
                    "1792x1024"
                  ],
                  "default": "720p",
                  "help": "720p 映射 1280x720，1080p 映射 1792x1024",
                  "wired": true
                },
                {
                  "key": "duration",
                  "type": "select",
                  "label": "时长 seconds",
                  "options": [
                    "4",
                    "8",
                    "12"
                  ],
                  "default": "8",
                  "help": "Sora 按档位计费，4/8/12 秒",
                  "wired": false
                }
              ]
            }
          ]
        },
        {
          "id": "minimax",
          "vendor": "minimax",
          "label": "MiniMax · 海螺",
          "desc": "",
          "live": false,
          "unavailableReason": "MiniMax（海螺）需要 GroupId 拼在 query 上，本地代理尚未透传，先把地址与参数存好。",
          "secret": [
            {
              "name": "apiKey",
              "label": "API KEY",
              "slot": "videoMinimax",
              "required": true
            }
          ],
          "billing": null,
          "defaults": {
            "baseUrl": "https://api.minimax.chat",
            "endpoint": "/v1/video_generation",
            "model": "MiniMax-Hailuo-02"
          },
          "params": [
            {
              "key": "groupId",
              "type": "text",
              "label": "GroupId",
              "default": "",
              "help": "MiniMax 控制台的组织 ID，会拼进请求 query；缺失时接口返回鉴权失败",
              "wired": false
            },
            {
              "key": "resolution",
              "type": "select",
              "label": "分辨率 resolution",
              "options": [
                "720p",
                "1080p"
              ],
              "default": "1080p",
              "help": "1080p 消耗更多额度",
              "wired": true
            },
            {
              "key": "duration",
              "type": "select",
              "label": "时长 duration（秒）",
              "options": [
                "6",
                "10"
              ],
              "default": "6",
              "help": "Hailuo-02 支持 6 或 10 秒",
              "wired": false
            }
          ],
          "models": [
            {
              "id": "MiniMax-Hailuo-02",
              "label": "MiniMax-Hailuo-02",
              "capability": [
                "文生",
                "首帧",
                "无音轨",
                "无水印",
                "720p/1080p"
              ],
              "spec": {
                "modes": [
                  "text",
                  "first"
                ],
                "resolutions": [
                  "720p",
                  "1080p"
                ],
                "references": 1,
                "audio": false,
                "watermark": false,
                "durationRange": [
                  6,
                  10
                ]
              },
              "params": [
                {
                  "key": "groupId",
                  "type": "text",
                  "label": "GroupId",
                  "default": "",
                  "help": "MiniMax 控制台的组织 ID，会拼进请求 query；缺失时接口返回鉴权失败",
                  "wired": false
                },
                {
                  "key": "resolution",
                  "type": "select",
                  "label": "分辨率 resolution",
                  "options": [
                    "720p",
                    "1080p"
                  ],
                  "default": "1080p",
                  "help": "1080p 消耗更多额度",
                  "wired": true
                },
                {
                  "key": "duration",
                  "type": "select",
                  "label": "时长 duration（秒）",
                  "options": [
                    "6",
                    "10"
                  ],
                  "default": "6",
                  "help": "Hailuo-02 支持 6 或 10 秒",
                  "wired": false
                }
              ]
            },
            {
              "id": "hailuo-02",
              "label": "hailuo-02",
              "capability": [
                "文生",
                "首帧",
                "无音轨",
                "无水印",
                "720p/1080p"
              ],
              "spec": {
                "modes": [
                  "text",
                  "first"
                ],
                "resolutions": [
                  "720p",
                  "1080p"
                ],
                "references": 1,
                "audio": false,
                "watermark": false,
                "durationRange": [
                  6,
                  10
                ]
              },
              "params": [
                {
                  "key": "groupId",
                  "type": "text",
                  "label": "GroupId",
                  "default": "",
                  "help": "MiniMax 控制台的组织 ID，会拼进请求 query；缺失时接口返回鉴权失败",
                  "wired": false
                },
                {
                  "key": "resolution",
                  "type": "select",
                  "label": "分辨率 resolution",
                  "options": [
                    "720p",
                    "1080p"
                  ],
                  "default": "1080p",
                  "help": "1080p 消耗更多额度",
                  "wired": true
                },
                {
                  "key": "duration",
                  "type": "select",
                  "label": "时长 duration（秒）",
                  "options": [
                    "6",
                    "10"
                  ],
                  "default": "6",
                  "help": "Hailuo-02 支持 6 或 10 秒",
                  "wired": false
                }
              ]
            },
            {
              "id": "T2V-01-Director",
              "label": "T2V-01-Director",
              "capability": [
                "文生",
                "无音轨",
                "无水印",
                "720p/1080p"
              ],
              "spec": {
                "modes": [
                  "text"
                ],
                "resolutions": [
                  "720p",
                  "1080p"
                ],
                "references": 1,
                "audio": false,
                "watermark": false
              },
              "params": [
                {
                  "key": "groupId",
                  "type": "text",
                  "label": "GroupId",
                  "default": "",
                  "help": "MiniMax 控制台的组织 ID，会拼进请求 query；缺失时接口返回鉴权失败",
                  "wired": false
                },
                {
                  "key": "resolution",
                  "type": "select",
                  "label": "分辨率 resolution",
                  "options": [
                    "720p",
                    "1080p"
                  ],
                  "default": "1080p",
                  "help": "1080p 消耗更多额度",
                  "wired": true
                },
                {
                  "key": "duration",
                  "type": "select",
                  "label": "时长 duration（秒）",
                  "options": [
                    "6",
                    "10"
                  ],
                  "default": "6",
                  "help": "Hailuo-02 支持 6 或 10 秒",
                  "wired": false
                }
              ]
            },
            {
              "id": "I2V-01-Director",
              "label": "I2V-01-Director",
              "capability": [
                "首帧",
                "无音轨",
                "无水印",
                "720p/1080p"
              ],
              "spec": {
                "modes": [
                  "first"
                ],
                "resolutions": [
                  "720p",
                  "1080p"
                ],
                "references": 1,
                "audio": false,
                "watermark": false
              },
              "params": [
                {
                  "key": "groupId",
                  "type": "text",
                  "label": "GroupId",
                  "default": "",
                  "help": "MiniMax 控制台的组织 ID，会拼进请求 query；缺失时接口返回鉴权失败",
                  "wired": false
                },
                {
                  "key": "resolution",
                  "type": "select",
                  "label": "分辨率 resolution",
                  "options": [
                    "720p",
                    "1080p"
                  ],
                  "default": "1080p",
                  "help": "1080p 消耗更多额度",
                  "wired": true
                },
                {
                  "key": "duration",
                  "type": "select",
                  "label": "时长 duration（秒）",
                  "options": [
                    "6",
                    "10"
                  ],
                  "default": "6",
                  "help": "Hailuo-02 支持 6 或 10 秒",
                  "wired": false
                }
              ]
            }
          ]
        }
      ]
    }
  ]
};
  window.XH_MODEL_SCHEMA = Object.freeze(SCHEMA);
})();

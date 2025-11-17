/**
 * Claude Messages API → OpenAI Chat Completions 请求转换器
 *
 * 核心转换：
 * - system → messages[] 中的第一条 system 消息
 * - messages[] → messages[]（role 保持一致）
 * - content.text → content (string)
 * - content.image → content (array with image_url)
 * - tool_use → tool_calls
 * - tool_result → role: "tool" 消息
 * - tools[] → tools[]（input_schema → parameters）
 * - max_tokens → max_tokens
 */

import { logger } from "@/lib/logger";

/**
 * Claude Messages API 格式的请求体接口（简化类型定义）
 */
interface ClaudeRequest {
  model?: string;
  system?: string | Array<{ type: string; text: string }>;
  messages?: Array<{
    role: string;
    content:
      | string
      | Array<{
          type: string;
          text?: string;
          source?: {
            type: string;
            media_type?: string;
            data?: string;
            url?: string;
          };
          id?: string;
          name?: string;
          input?: Record<string, unknown>;
          tool_use_id?: string;
          content?: string | Array<unknown>;
        }>;
  }>;
  tools?: Array<{
    name: string;
    description?: string;
    input_schema: Record<string, unknown>;
    type?: string;
  }>;
  tool_choice?: { type: string; name?: string } | string;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  [key: string]: unknown;
}

/**
 * OpenAI Chat Completions 格式的请求体接口（简化类型定义）
 */
interface OpenAIChatCompletionRequest {
  model: string;
  messages: Array<{
    role: string;
    content?:
      | string
      | Array<{
          type: string;
          text?: string;
          image_url?: {
            url: string;
            detail?: string;
          };
        }>;
    tool_calls?: Array<{
      id: string;
      type: string;
      function: {
        name: string;
        arguments: string;
      };
    }>;
    tool_call_id?: string;
    name?: string;
  }>;
  tools?: Array<{
    type: string;
    function: {
      name: string;
      description?: string;
      parameters: Record<string, unknown>;
    };
  }>;
  tool_choice?:
    | string
    | {
        type: string;
        function?: {
          name: string;
        };
      };
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  [key: string]: unknown;
}

/**
 * 转换 Claude Messages API 请求为 OpenAI Chat Completions 格式
 *
 * @param model - 模型名称
 * @param request - Claude Messages API 格式的请求体
 * @param stream - 是否为流式请求
 * @returns OpenAI Chat Completions 格式的请求体
 */
export function transformClaudeRequestToOpenAI(
  model: string,
  request: Record<string, unknown>,
  stream: boolean
): Record<string, unknown> {
  // 参数验证
  if (!model || typeof model !== "string") {
    logger.error("[Claude→OpenAI] Invalid model parameter", { model });
    throw new Error("Model parameter is required and must be a string");
  }

  if (!request || typeof request !== "object") {
    logger.error("[Claude→OpenAI] Invalid request parameter", { request });
    throw new Error("Request parameter is required and must be an object");
  }

  const req = request as ClaudeRequest;

  // 验证 messages 数组
  if (!Array.isArray(req.messages) || req.messages.length === 0) {
    logger.error("[Claude→OpenAI] Invalid or empty messages array", {
      messages: req.messages,
    });
    throw new Error("Messages array is required and must not be empty");
  }

  // 检测是否为 count_tokens 请求
  // Claude count_tokens 端点不支持 stream，OpenAI 也应该禁用 stream
  const isCountTokens = req.max_tokens === 0 || (req as Record<string, unknown>)._isCountTokens;

  // 基础 OpenAI 请求结构
  const output: OpenAIChatCompletionRequest = {
    model,
    messages: [],
    stream: isCountTokens ? false : stream, // count_tokens 请求强制禁用 stream
  };

  logger.debug("[Claude→OpenAI] Starting request transformation", {
    model,
    stream: output.stream,
    isCountTokens,
    hasSystem: !!req.system,
    messageCount: req.messages?.length || 0,
    hasTools: !!req.tools,
    toolsCount: req.tools?.length || 0,
  });

  // 1. 处理 system 消息（转换为首个 system 消息）
  if (req.system) {
    let systemText = "";

    if (typeof req.system === "string") {
      systemText = req.system;
    } else if (Array.isArray(req.system)) {
      systemText = req.system
        .map((part) => {
          if (part.type === "text" && part.text) {
            return part.text;
          }
          return "";
        })
        .join("");
    }

    if (systemText) {
      output.messages.push({
        role: "system",
        content: systemText,
      });
    }
  }

  // 2. 处理 messages 数组
  if (req.messages && Array.isArray(req.messages)) {
    for (let idx = 0; idx < req.messages.length; idx++) {
      const message = req.messages[idx];
      const role = message.role;
      const content = message.content;

      // 处理不同的 content 格式
      if (typeof content === "string") {
        // 简单文本内容
        output.messages.push({
          role,
          content,
        });
      } else if (Array.isArray(content)) {
        // 复杂内容块数组
        const contentParts: Array<{
          type: string;
          text?: string;
          image_url?: {
            url: string;
            detail?: string;
          };
        }> = [];
        let hasToolUse = false;
        let hasToolResult = false;

        for (const part of content) {
          const partType = part.type;

          switch (partType) {
            case "text": {
              const text = part.text || "";
              contentParts.push({
                type: "text",
                text,
              });
              break;
            }

            case "image": {
              // 处理图片内容
              const source = part.source;
              if (source) {
                let imageUrl = "";

                if (source.type === "base64") {
                  // 构建 data URL
                  const mediaType = source.media_type || "application/octet-stream";
                  const data = source.data || "";

                  if (!data) {
                    logger.warn("[Claude→OpenAI] Empty base64 image data", {
                      messageIndex: idx,
                      partType: part.type,
                    });
                  } else {
                    imageUrl = `data:${mediaType};base64,${data}`;
                  }
                } else if (source.type === "url") {
                  imageUrl = source.url || "";

                  if (!imageUrl) {
                    logger.warn("[Claude→OpenAI] Empty image URL", {
                      messageIndex: idx,
                      partType: part.type,
                    });
                  }
                } else {
                  logger.warn("[Claude→OpenAI] Unknown image source type", {
                    messageIndex: idx,
                    sourceType: source.type,
                  });
                }

                if (imageUrl) {
                  contentParts.push({
                    type: "image_url",
                    image_url: {
                      url: imageUrl,
                      detail: "auto",
                    },
                  });
                  // 仅在开发环境记录详细日志，避免生产环境日志暴增
                  if (process.env.NODE_ENV === "development") {
                    logger.debug("[Claude→OpenAI] Converted image content", {
                      messageIndex: idx,
                      sourceType: source.type,
                      urlLength: imageUrl.length,
                    });
                  }
                }
              } else {
                logger.warn("[Claude→OpenAI] Image part missing source", {
                  messageIndex: idx,
                });
              }
              break;
            }

            case "tool_use": {
              // 单独处理 tool_use（作为 tool_calls）
              hasToolUse = true;

              // 验证必需字段
              if (!part.id || !part.name) {
                logger.error("[Claude→OpenAI] Invalid tool_use: missing id or name", {
                  messageIndex: idx,
                  toolUseId: part.id,
                  toolUseName: part.name,
                });
                throw new Error("tool_use must have both id and name");
              }

              // 先保存当前的文本内容（如果有）
              if (contentParts.length > 0) {
                output.messages.push({
                  role,
                  content: contentParts.slice(), // 复制数组
                });
                contentParts.length = 0; // 清空
              }

              const toolUse = {
                id: part.id,
                type: "function",
                function: {
                  name: part.name,
                  arguments: JSON.stringify(part.input || {}),
                },
              };

              // 仅在开发环境记录详细日志
              if (process.env.NODE_ENV === "development") {
                logger.debug("[Claude→OpenAI] Converted tool_use to tool_calls", {
                  messageIndex: idx,
                  toolId: part.id,
                  toolName: part.name,
                  hasInput: !!part.input,
                });
              }

              // 添加 assistant 消息with tool_calls
              output.messages.push({
                role: "assistant",
                content: null as unknown as string, // OpenAI 允许 null
                tool_calls: [toolUse],
              });
              break;
            }

            case "tool_result": {
              // 单独处理 tool_result（作为 tool 角色消息）
              hasToolResult = true;

              // 验证必需字段
              if (!part.tool_use_id) {
                logger.error("[Claude→OpenAI] Invalid tool_result: missing tool_use_id", {
                  messageIndex: idx,
                });
                throw new Error("tool_result must have tool_use_id");
              }

              // 先保存当前的文本内容（如果有）
              if (contentParts.length > 0) {
                output.messages.push({
                  role,
                  content: contentParts.slice(),
                });
                contentParts.length = 0;
              }

              let outputStr = "";
              const toolResultContent = part.content;

              if (typeof toolResultContent === "string") {
                outputStr = toolResultContent;
              } else if (Array.isArray(toolResultContent)) {
                outputStr = toolResultContent
                  .map((item) => {
                    if (typeof item === "object" && item !== null && "text" in item) {
                      return (item as Record<string, unknown>).text as string;
                    }
                    return String(item);
                  })
                  .join("");
              } else if (toolResultContent !== undefined) {
                logger.warn("[Claude→OpenAI] Unexpected tool_result content type", {
                  messageIndex: idx,
                  contentType: typeof toolResultContent,
                });
                outputStr = String(toolResultContent);
              }

              // 仅在开发环境记录详细日志
              if (process.env.NODE_ENV === "development") {
                logger.debug("[Claude→OpenAI] Converted tool_result to tool message", {
                  messageIndex: idx,
                  toolUseId: part.tool_use_id,
                  contentLength: outputStr.length,
                });
              }

              const toolResult = {
                role: "tool",
                content: outputStr,
                tool_call_id: part.tool_use_id,
              };

              output.messages.push(toolResult);
              break;
            }

            default: {
              // 处理未知的 content 类型
              logger.warn("[Claude→OpenAI] Unknown content part type, skipping", {
                messageIndex: idx,
                partType: part.type,
              });
              break;
            }
          }
        }

        // 保存剩余的内容块（如果有）
        if (contentParts.length > 0 && !hasToolUse && !hasToolResult) {
          output.messages.push({
            role,
            content: contentParts,
          });
        }
      }
    }
  }

  // 3. 转换 tools（input_schema → parameters）
  if (req.tools && Array.isArray(req.tools) && req.tools.length > 0) {
    output.tools = [];

    for (const tool of req.tools) {
      // 特殊处理：Claude web search 工具（跳过）
      if (tool.type === "web_search_20250305") {
        continue;
      }

      const toolName = tool.name || "";

      const openAITool: {
        type: string;
        function: {
          name: string;
          description?: string;
          parameters: Record<string, unknown>;
        };
      } = {
        type: "function",
        function: {
          name: toolName,
          parameters: tool.input_schema || {},
        },
      };

      if (tool.description) {
        openAITool.function.description = tool.description;
      }

      output.tools.push(openAITool);
    }
  }

  // 4. 转换 tool_choice
  if (req.tool_choice) {
    if (typeof req.tool_choice === "string") {
      // 字符串格式（不应该出现在 Claude API 中，但做兼容处理）
      output.tool_choice = req.tool_choice;
    } else if (typeof req.tool_choice === "object") {
      const tc = req.tool_choice as { type: string; name?: string };
      switch (tc.type) {
        case "auto":
          output.tool_choice = "auto";
          break;
        case "any":
          output.tool_choice = "required";
          break;
        case "tool":
          if (tc.name) {
            output.tool_choice = {
              type: "function",
              function: {
                name: tc.name,
              },
            };
          }
          break;
      }
    }
  }

  // 5. 传递其他参数
  if (req.max_tokens !== undefined) {
    // 特殊处理：count_tokens 请求（max_tokens=0）
    // OpenAI 不支持 max_tokens=0，使用 1 来模拟 token 计数
    if (isCountTokens && req.max_tokens === 0) {
      output.max_tokens = 1;
      logger.debug("[Claude→OpenAI] Adjusted max_tokens for count_tokens endpoint", {
        original: 0,
        adjusted: 1,
        note: "OpenAI does not support max_tokens=0, using 1 to simulate token counting",
      });
    } else {
      output.max_tokens = req.max_tokens;
      // 仅在开发环境记录详细日志
      if (process.env.NODE_ENV === "development") {
        logger.debug("[Claude→OpenAI] Forwarding max_tokens", {
          value: req.max_tokens,
          isCountTokens,
        });
      }
    }
  } else if (process.env.NODE_ENV === "development") {
    logger.debug("[Claude→OpenAI] No max_tokens specified in request");
  }

  if (req.temperature !== undefined) {
    output.temperature = req.temperature;
  }

  if (req.top_p !== undefined) {
    output.top_p = req.top_p;
  }

  logger.debug("[Claude→OpenAI] Request transformation completed", {
    messageCount: output.messages.length,
    hasTools: !!output.tools,
    toolsCount: output.tools?.length || 0,
    maxTokens: output.max_tokens,
    isCountTokens,
  });

  return output as unknown as Record<string, unknown>;
}

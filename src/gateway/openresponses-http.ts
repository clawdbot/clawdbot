/**
 * OpenResponses HTTP Handler
 *
 * Implements the OpenResponses `/v1/responses` endpoint for Clawdbot Gateway.
 *
 * @see https://www.open-responses.com/
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { buildHistoryContextFromEntries, type HistoryEntry } from "../auto-reply/reply/history.js";
import { createDefaultDeps } from "../cli/deps.js";
import { agentCommand } from "../commands/agent.js";
import { emitAgentEvent, onAgentEvent } from "../infra/agent-events.js";
import { defaultRuntime } from "../runtime.js";
import { authorizeGatewayConnect, type ResolvedGatewayAuth } from "./auth.js";
import { getBearerToken, resolveAgentIdForRequest, resolveSessionKey } from "./http-utils.js";
import {
  readJsonBodyOrError,
  sendJson,
  sendMethodNotAllowed,
  sendUnauthorized,
  setSseHeaders,
  writeDone,
} from "./http-common.js";
import {
  CreateResponseBodySchema,
  type ContentPart,
  type CreateResponseBody,
  type ItemParam,
  type OutputItem,
  type ResponseResource,
  type StreamingEvent,
  type Usage,
} from "./open-responses.schema.js";
import type { GatewayHttpResponsesConfig } from "../config/types.gateway.js";
import type { ClientToolDefinition } from "../agents/pi-embedded-runner/run/params.js";
import type { ImageContent } from "../commands/agent/types.js";
import {
  DEFAULT_INPUT_FILE_MAX_BYTES,
  DEFAULT_INPUT_FILE_MAX_CHARS,
  DEFAULT_INPUT_FILE_MIMES,
  DEFAULT_INPUT_IMAGE_MAX_BYTES,
  DEFAULT_INPUT_IMAGE_MIMES,
  DEFAULT_INPUT_MAX_REDIRECTS,
  DEFAULT_INPUT_PDF_MAX_PAGES,
  DEFAULT_INPUT_PDF_MAX_PIXELS,
  DEFAULT_INPUT_PDF_MIN_TEXT_CHARS,
  DEFAULT_INPUT_TIMEOUT_MS,
  extractFileContentFromSource,
  extractImageContentFromSource,
  normalizeMimeList,
  type InputFileLimits,
  type InputImageLimits,
  type InputImageSource,
} from "../media/input-files.js";

type OpenResponsesHttpOptions = {
  auth: ResolvedGatewayAuth;
  maxBodyBytes?: number;
  config?: GatewayHttpResponsesConfig;
  trustedProxies?: string[];
};

const DEFAULT_BODY_BYTES = 20 * 1024 * 1024;

function writeSseEvent(res: ServerResponse, event: StreamingEvent) {
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function extractTextContent(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => {
      if (part.type === "input_text") return part.text;
      if (part.type === "output_text") return part.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

type ResolvedResponsesLimits = {
  maxBodyBytes: number;
  files: InputFileLimits;
  images: InputImageLimits;
};

function resolveResponsesLimits(
  config: GatewayHttpResponsesConfig | undefined,
): ResolvedResponsesLimits {
  const files = config?.files;
  const images = config?.images;
  return {
    maxBodyBytes: config?.maxBodyBytes ?? DEFAULT_BODY_BYTES,
    files: {
      allowUrl: files?.allowUrl ?? true,
      allowedMimes: normalizeMimeList(files?.allowedMimes, DEFAULT_INPUT_FILE_MIMES),
      maxBytes: files?.maxBytes ?? DEFAULT_INPUT_FILE_MAX_BYTES,
      maxChars: files?.maxChars ?? DEFAULT_INPUT_FILE_MAX_CHARS,
      maxRedirects: files?.maxRedirects ?? DEFAULT_INPUT_MAX_REDIRECTS,
      timeoutMs: files?.timeoutMs ?? DEFAULT_INPUT_TIMEOUT_MS,
      pdf: {
        maxPages: files?.pdf?.maxPages ?? DEFAULT_INPUT_PDF_MAX_PAGES,
        maxPixels: files?.pdf?.maxPixels ?? DEFAULT_INPUT_PDF_MAX_PIXELS,
        minTextChars: files?.pdf?.minTextChars ?? DEFAULT_INPUT_PDF_MIN_TEXT_CHARS,
      },
    },
    images: {
      allowUrl: images?.allowUrl ?? true,
      allowedMimes: normalizeMimeList(images?.allowedMimes, DEFAULT_INPUT_IMAGE_MIMES),
      maxBytes: images?.maxBytes ?? DEFAULT_INPUT_IMAGE_MAX_BYTES,
      maxRedirects: images?.maxRedirects ?? DEFAULT_INPUT_MAX_REDIRECTS,
      timeoutMs: images?.timeoutMs ?? DEFAULT_INPUT_TIMEOUT_MS,
    },
  };
}

function extractClientTools(body: CreateResponseBody): ClientToolDefinition[] {
  return (body.tools ?? []) as ClientToolDefinition[];
}

function applyToolChoice(params: {
  tools: ClientToolDefinition[];
  toolChoice: CreateResponseBody["tool_choice"];
}): { tools: ClientToolDefinition[]; extraSystemPrompt?: string } {
  const { tools, toolChoice } = params;
  if (!toolChoice) return { tools };

  if (toolChoice === "none") {
    return { tools: [] };
  }

  if (toolChoice === "required") {
    if (tools.length === 0) {
      throw new Error("tool_choice=required but no tools were provided");
    }
    return {
      tools,
      extraSystemPrompt: "You must call one of the available tools before responding.",
    };
  }

  if (typeof toolChoice === "object" && toolChoice.type === "function") {
    const targetName = toolChoice.function?.name?.trim();
    if (!targetName) {
      throw new Error("tool_choice.function.name is required");
    }
    const matched = tools.filter((tool) => tool.function?.name === targetName);
    if (matched.length === 0) {
      throw new Error(`tool_choice requested unknown tool: ${targetName}`);
    }
    return {
      tools: matched,
      extraSystemPrompt: `You must call the ${targetName} tool before responding.`,
    };
  }

  return { tools };
}

export function buildAgentPrompt(input: string | ItemParam[]): {
  message: string;
  extraSystemPrompt?: string;
} {
  if (typeof input === "string") {
    return { message: input };
  }

  const systemParts: string[] = [];
  const conversationEntries: Array<{ role: "user" | "assistant" | "tool"; entry: HistoryEntry }> =
    [];

  for (const item of input) {
    if (item.type === "message") {
      const content = extractTextContent(item.content).trim();
      if (!content) continue;

      if (item.role === "system" || item.role === "developer") {
        systemParts.push(content);
        continue;
      }

      const normalizedRole = item.role === "assistant" ? "assistant" : "user";
      const sender = normalizedRole === "assistant" ? "Assistant" : "User";

      conversationEntries.push({
        role: normalizedRole,
        entry: { sender, body: content },
      });
    } else if (item.type === "function_call_output") {
      conversationEntries.push({
        role: "tool",
        entry: { sender: `Tool:${item.call_id}`, body: item.output },
      });
    }
    // Skip reasoning and item_reference for prompt building (Phase 1)
  }

  let message = "";
  if (conversationEntries.length > 0) {
    // Find the last user or tool message as the current message
    let currentIndex = -1;
    for (let i = conversationEntries.length - 1; i >= 0; i -= 1) {
      const entryRole = conversationEntries[i]?.role;
      if (entryRole === "user" || entryRole === "tool") {
        currentIndex = i;
        break;
      }
    }
    if (currentIndex < 0) currentIndex = conversationEntries.length - 1;

    const currentEntry = conversationEntries[currentIndex]?.entry;
    if (currentEntry) {
      const historyEntries = conversationEntries.slice(0, currentIndex).map((entry) => entry.entry);
      if (historyEntries.length === 0) {
        message = currentEntry.body;
      } else {
        const formatEntry = (entry: HistoryEntry) => `${entry.sender}: ${entry.body}`;
        message = buildHistoryContextFromEntries({
          entries: [...historyEntries, currentEntry],
          currentMessage: formatEntry(currentEntry),
          formatEntry,
        });
      }
    }
  }

  return {
    message,
    extraSystemPrompt: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
  };
}

function resolveOpenResponsesSessionKey(params: {
  req: IncomingMessage;
  agentId: string;
  user?: string | undefined;
}): string {
  return resolveSessionKey({ ...params, prefix: "openresponses" });
}

function createEmptyUsage(): Usage {
  return { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
}

function toUsage(
  value:
    | {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
        total?: number;
      }
    | undefined,
): Usage {
  if (!value) return createEmptyUsage();
  const input = value.input ?? 0;
  const output = value.output ?? 0;
  const cacheRead = value.cacheRead ?? 0;
  const cacheWrite = value.cacheWrite ?? 0;
  const total = value.total ?? input + output + cacheRead + cacheWrite;
  return {
    input_tokens: Math.max(0, input),
    output_tokens: Math.max(0, output),
    total_tokens: Math.max(0, total),
  };
}

function extractUsageFromResult(result: unknown): Usage {
  const meta = (result as { meta?: { agentMeta?: { usage?: unknown } } } | null)?.meta;
  const usage = meta && typeof meta === "object" ? meta.agentMeta?.usage : undefined;
  return toUsage(
    usage as
      | { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number }
      | undefined,
  );
}

function createResponseResource(params: {
  id: string;
  model: string;
  status: ResponseResource["status"];
  output: OutputItem[];
  usage?: Usage;
  error?: { code: string; message: string };
}): ResponseResource {
  return {
    id: params.id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: params.status,
    model: params.model,
    output: params.output,
    usage: params.usage ?? createEmptyUsage(),
    error: params.error,
  };
}

function createAssistantOutputItem(params: {
  id: string;
  text: string;
  status?: "in_progress" | "completed";
}): OutputItem {
  return {
    type: "message",
    id: params.id,
    role: "assistant",
    content: [{ type: "output_text", text: params.text }],
    status: params.status,
  };
}

export async function handleOpenResponsesHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: OpenResponsesHttpOptions,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);
  if (url.pathname !== "/v1/responses") return false;

  if (req.method !== "POST") {
    sendMethodNotAllowed(res);
    return true;
  }

  const token = getBearerToken(req);
  const authResult = await authorizeGatewayConnect({
    auth: opts.auth,
    connectAuth: { token, password: token },
    req,
    trustedProxies: opts.trustedProxies,
  });
  if (!authResult.ok) {
    sendUnauthorized(res);
    return true;
  }

  const limits = resolveResponsesLimits(opts.config);
  const maxBodyBytes =
    opts.maxBodyBytes ??
    (opts.config?.maxBodyBytes
      ? limits.maxBodyBytes
      : Math.max(limits.maxBodyBytes, limits.files.maxBytes * 2, limits.images.maxBytes * 2));
  const body = await readJsonBodyOrError(req, res, maxBodyBytes);
  if (body === undefined) return true;

  // Validate request body with Zod
  const parseResult = CreateResponseBodySchema.safeParse(body);
  if (!parseResult.success) {
    const issue = parseResult.error.issues[0];
    const message = issue ? `${issue.path.join(".")}: ${issue.message}` : "Invalid request body";
    sendJson(res, 400, {
      error: { message, type: "invalid_request_error" },
    });
    return true;
  }

  const payload: CreateResponseBody = parseResult.data;
  const stream = Boolean(payload.stream);
  const model = payload.model;
  const user = payload.user;

  // Extract images + files from input (Phase 2)
  let images: ImageContent[] = [];
  let fileContexts: string[] = [];
  try {
    if (Array.isArray(payload.input)) {
      for (const item of payload.input) {
        if (item.type === "message" && typeof item.content !== "string") {
          for (const part of item.content) {
            if (part.type === "input_image") {
              const source = part.source as {
                type?: string;
                url?: string;
                data?: string;
                media_type?: string;
              };
              const sourceType =
                source.type === "base64" || source.type === "url" ? source.type : undefined;
              if (!sourceType) {
                throw new Error("input_image must have 'source.url' or 'source.data'");
              }
              const imageSource: InputImageSource = {
                type: sourceType,
                url: source.url,
                data: source.data,
                mediaType: source.media_type,
              };
              const image = await extractImageContentFromSource(imageSource, limits.images);
              images.push(image);
              continue;
            }

            if (part.type === "input_file") {
              const source = part.source as {
                type?: string;
                url?: string;
                data?: string;
                media_type?: string;
                filename?: string;
              };
              const sourceType =
                source.type === "base64" || source.type === "url" ? source.type : undefined;
              if (!sourceType) {
                throw new Error("input_file must have 'source.url' or 'source.data'");
              }
              const file = await extractFileContentFromSource({
                source: {
                  type: sourceType,
                  url: source.url,
                  data: source.data,
                  mediaType: source.media_type,
                  filename: source.filename,
                },
                limits: limits.files,
              });
              if (file.text?.trim()) {
                fileContexts.push(`<file name="${file.filename}">\n${file.text}\n</file>`);
              } else if (file.images && file.images.length > 0) {
                fileContexts.push(
                  `<file name="${file.filename}">[PDF content rendered to images]</file>`,
                );
              }
              if (file.images && file.images.length > 0) {
                images = images.concat(file.images);
              }
            }
          }
        }
      }
    }
  } catch (err) {
    sendJson(res, 400, {
      error: { message: String(err), type: "invalid_request_error" },
    });
    return true;
  }

  const clientTools = extractClientTools(payload);
  let toolChoicePrompt: string | undefined;
  let resolvedClientTools = clientTools;
  try {
    const toolChoiceResult = applyToolChoice({
      tools: clientTools,
      toolChoice: payload.tool_choice,
    });
    resolvedClientTools = toolChoiceResult.tools;
    toolChoicePrompt = toolChoiceResult.extraSystemPrompt;
  } catch (err) {
    sendJson(res, 400, {
      error: { message: String(err), type: "invalid_request_error" },
    });
    return true;
  }
  const agentId = resolveAgentIdForRequest({ req, model });
  const sessionKey = resolveOpenResponsesSessionKey({ req, agentId, user });

  // Build prompt from input
  const prompt = buildAgentPrompt(payload.input);

  const fileContext = fileContexts.length > 0 ? fileContexts.join("\n\n") : undefined;
  const toolChoiceContext = toolChoicePrompt?.trim();

  // Handle instructions + file context as extra system prompt
  const extraSystemPrompt = [
    payload.instructions,
    prompt.extraSystemPrompt,
    toolChoiceContext,
    fileContext,
  ]
    .filter(Boolean)
    .join("\n\n");

  if (!prompt.message) {
    sendJson(res, 400, {
      error: {
        message: "Missing user message in `input`.",
        type: "invalid_request_error",
      },
    });
    return true;
  }

  const responseId = `resp_${randomUUID()}`;
  const outputItemId = `msg_${randomUUID()}`;
  const deps = createDefaultDeps();
  const streamParams =
    typeof payload.max_output_tokens === "number"
      ? { maxTokens: payload.max_output_tokens }
      : undefined;

  if (!stream) {
    try {
      const result = await agentCommand(
        {
          message: prompt.message,
          images: images.length > 0 ? images : undefined,
          clientTools: resolvedClientTools.length > 0 ? resolvedClientTools : undefined,
          extraSystemPrompt: extraSystemPrompt || undefined,
          streamParams: streamParams ?? undefined,
          sessionKey,
          runId: responseId,
          deliver: false,
          messageChannel: "webchat",
          bestEffortDeliver: false,
        },
        defaultRuntime,
        deps,
      );

      const payloads = (result as { payloads?: Array<{ text?: string }> } | null)?.payloads;
      const usage = extractUsageFromResult(result);
      const meta = (result as { meta?: unknown } | null)?.meta;
      const stopReason =
        meta && typeof meta === "object" ? (meta as { stopReason?: string }).stopReason : undefined;
      const pendingToolCalls =
        meta && typeof meta === "object"
          ? (meta as { pendingToolCalls?: Array<{ id: string; name: string; arguments: string }> })
              .pendingToolCalls
          : undefined;

      // If agent called a client tool, return function_call instead of text
      if (stopReason === "tool_calls" && pendingToolCalls && pendingToolCalls.length > 0) {
        const functionCall = pendingToolCalls[0];
        const functionCallItemId = `call_${randomUUID()}`;
        const response = createResponseResource({
          id: responseId,
          model,
          status: "incomplete",
          output: [
            {
              type: "function_call",
              id: functionCallItemId,
              call_id: functionCall.id,
              name: functionCall.name,
              arguments: functionCall.arguments,
            },
          ],
          usage,
        });
        sendJson(res, 200, response);
        return true;
      }

      const content =
        Array.isArray(payloads) && payloads.length > 0
          ? payloads
              .map((p) => (typeof p.text === "string" ? p.text : ""))
              .filter(Boolean)
              .join("\n\n")
          : "No response from Clawdbot.";

      const response = createResponseResource({
        id: responseId,
        model,
        status: "completed",
        output: [
          createAssistantOutputItem({ id: outputItemId, text: content, status: "completed" }),
        ],
        usage,
      });

      sendJson(res, 200, response);
    } catch (err) {
      const response = createResponseResource({
        id: responseId,
        model,
        status: "failed",
        output: [],
        error: { code: "api_error", message: String(err) },
      });
      sendJson(res, 500, response);
    }
    return true;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Streaming mode
  // ─────────────────────────────────────────────────────────────────────────

  setSseHeaders(res);

  let accumulatedText = "";
  let sawAssistantDelta = false;
  let closed = false;
  let unsubscribe = () => {};
  let finalUsage: Usage | undefined;
  let finalizeRequested: { status: ResponseResource["status"]; text: string } | null = null;

  const maybeFinalize = () => {
    if (closed) return;
    if (!finalizeRequested) return;
    if (!finalUsage) return;
    const usage = finalUsage;

    closed = true;
    unsubscribe();

    writeSseEvent(res, {
      type: "response.output_text.done",
      item_id: outputItemId,
      output_index: 0,
      content_index: 0,
      text: finalizeRequested.text,
    });

    writeSseEvent(res, {
      type: "response.content_part.done",
      item_id: outputItemId,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: finalizeRequested.text },
    });

    const completedItem = createAssistantOutputItem({
      id: outputItemId,
      text: finalizeRequested.text,
      status: "completed",
    });

    writeSseEvent(res, {
      type: "response.output_item.done",
      output_index: 0,
      item: completedItem,
    });

    const finalResponse = createResponseResource({
      id: responseId,
      model,
      status: finalizeRequested.status,
      output: [completedItem],
      usage,
    });

    writeSseEvent(res, { type: "response.completed", response: finalResponse });
    writeDone(res);
    res.end();
  };

  const requestFinalize = (status: ResponseResource["status"], text: string) => {
    if (finalizeRequested) return;
    finalizeRequested = { status, text };
    maybeFinalize();
  };

  // Send initial events
  const initialResponse = createResponseResource({
    id: responseId,
    model,
    status: "in_progress",
    output: [],
  });

  writeSseEvent(res, { type: "response.created", response: initialResponse });
  writeSseEvent(res, { type: "response.in_progress", response: initialResponse });

  // Add output item
  const outputItem = createAssistantOutputItem({
    id: outputItemId,
    text: "",
    status: "in_progress",
  });

  writeSseEvent(res, {
    type: "response.output_item.added",
    output_index: 0,
    item: outputItem,
  });

  // Add content part
  writeSseEvent(res, {
    type: "response.content_part.added",
    item_id: outputItemId,
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text: "" },
  });

  unsubscribe = onAgentEvent((evt) => {
    if (evt.runId !== responseId) return;
    if (closed) return;

    if (evt.stream === "assistant") {
      const delta = evt.data?.delta;
      const text = evt.data?.text;
      const content = typeof delta === "string" ? delta : typeof text === "string" ? text : "";
      if (!content) return;

      sawAssistantDelta = true;
      accumulatedText += content;

      writeSseEvent(res, {
        type: "response.output_text.delta",
        item_id: outputItemId,
        output_index: 0,
        content_index: 0,
        delta: content,
      });
      return;
    }

    if (evt.stream === "lifecycle") {
      const phase = evt.data?.phase;
      if (phase === "end" || phase === "error") {
        const finalText = accumulatedText || "No response from Clawdbot.";
        const finalStatus = phase === "error" ? "failed" : "completed";
        requestFinalize(finalStatus, finalText);
      }
    }
  });

  req.on("close", () => {
    closed = true;
    unsubscribe();
  });

  void (async () => {
    try {
      const result = await agentCommand(
        {
          message: prompt.message,
          images: images.length > 0 ? images : undefined,
          clientTools: resolvedClientTools.length > 0 ? resolvedClientTools : undefined,
          extraSystemPrompt: extraSystemPrompt || undefined,
          streamParams: streamParams ?? undefined,
          sessionKey,
          runId: responseId,
          deliver: false,
          messageChannel: "webchat",
          bestEffortDeliver: false,
        },
        defaultRuntime,
        deps,
      );

      finalUsage = extractUsageFromResult(result);
      maybeFinalize();

      if (closed) return;

      // Fallback: if no streaming deltas were received, send the full response
      if (!sawAssistantDelta) {
        const resultAny = result as { payloads?: Array<{ text?: string }>; meta?: unknown };
        const payloads = resultAny.payloads;
        const meta = resultAny.meta;
        const stopReason =
          meta && typeof meta === "object"
            ? (meta as { stopReason?: string }).stopReason
            : undefined;
        const pendingToolCalls =
          meta && typeof meta === "object"
            ? (
                meta as {
                  pendingToolCalls?: Array<{ id: string; name: string; arguments: string }>;
                }
              ).pendingToolCalls
            : undefined;

        // If agent called a client tool, emit function_call instead of text
        if (stopReason === "tool_calls" && pendingToolCalls && pendingToolCalls.length > 0) {
          const functionCall = pendingToolCalls[0];
          const usage = finalUsage ?? createEmptyUsage();

          writeSseEvent(res, {
            type: "response.output_text.done",
            item_id: outputItemId,
            output_index: 0,
            content_index: 0,
            text: "",
          });
          writeSseEvent(res, {
            type: "response.content_part.done",
            item_id: outputItemId,
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: "" },
          });

          const completedItem = createAssistantOutputItem({
            id: outputItemId,
            text: "",
            status: "completed",
          });
          writeSseEvent(res, {
            type: "response.output_item.done",
            output_index: 0,
            item: completedItem,
          });

          const functionCallItemId = `call_${randomUUID()}`;
          const functionCallItem = {
            type: "function_call" as const,
            id: functionCallItemId,
            call_id: functionCall.id,
            name: functionCall.name,
            arguments: functionCall.arguments,
          };
          writeSseEvent(res, {
            type: "response.output_item.added",
            output_index: 1,
            item: functionCallItem,
          });
          writeSseEvent(res, {
            type: "response.output_item.done",
            output_index: 1,
            item: { ...functionCallItem, status: "completed" as const },
          });

          const incompleteResponse = createResponseResource({
            id: responseId,
            model,
            status: "incomplete",
            output: [completedItem, functionCallItem],
            usage,
          });
          closed = true;
          unsubscribe();
          writeSseEvent(res, { type: "response.completed", response: incompleteResponse });
          writeDone(res);
          res.end();
          return;
        }

        const content =
          Array.isArray(payloads) && payloads.length > 0
            ? payloads
                .map((p) => (typeof p.text === "string" ? p.text : ""))
                .filter(Boolean)
                .join("\n\n")
            : "No response from Clawdbot.";

        accumulatedText = content;
        sawAssistantDelta = true;

        writeSseEvent(res, {
          type: "response.output_text.delta",
          item_id: outputItemId,
          output_index: 0,
          content_index: 0,
          delta: content,
        });
      }
    } catch (err) {
      if (closed) return;

      finalUsage = finalUsage ?? createEmptyUsage();
      const errorResponse = createResponseResource({
        id: responseId,
        model,
        status: "failed",
        output: [],
        error: { code: "api_error", message: String(err) },
        usage: finalUsage,
      });

      writeSseEvent(res, { type: "response.failed", response: errorResponse });
      emitAgentEvent({
        runId: responseId,
        stream: "lifecycle",
        data: { phase: "error" },
      });
    } finally {
      if (!closed) {
        // Emit lifecycle end to trigger completion
        emitAgentEvent({
          runId: responseId,
          stream: "lifecycle",
          data: { phase: "end" },
        });
      }
    }
  })();

  return true;
}

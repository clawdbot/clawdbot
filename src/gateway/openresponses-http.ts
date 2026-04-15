/**
 * OpenResponses HTTP Handler
 *
 * Implements the OpenResponses `/v1/responses` endpoint for OpenClaw Gateway.
 *
 * @see https://www.open-responses.com/
 */

import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ImageContent } from "../agents/command/types.js";
import type { ClientToolDefinition } from "../agents/pi-embedded-runner/run/params.js";
import { createDefaultDeps } from "../cli/deps.js";
import type { CliDeps } from "../cli/deps.types.js";
import { agentCommandFromIngress } from "../commands/agent.js";
import type { GatewayHttpResponsesConfig } from "../config/types.gateway.js";
import { emitAgentEvent, onAgentEvent } from "../infra/agent-events.js";
import { logWarn } from "../logger.js";
import { renderFileContextBlock } from "../media/file-context.js";
import {
  DEFAULT_INPUT_IMAGE_MAX_BYTES,
  DEFAULT_INPUT_IMAGE_MIMES,
  DEFAULT_INPUT_MAX_REDIRECTS,
  DEFAULT_INPUT_TIMEOUT_MS,
  extractFileContentFromSource,
  extractImageContentFromSource,
  normalizeMimeList,
  resolveInputFileLimits,
  type InputFileLimits,
  type InputImageLimits,
  type InputImageSource,
} from "../media/input-files.js";
import { defaultRuntime } from "../runtime.js";
import { resolveAssistantStreamDeltaText } from "./agent-event-assistant-text.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { sendJson, setSseHeaders, watchClientDisconnect, writeDone } from "./http-common.js";
import { handleGatewayPostJsonEndpoint } from "./http-endpoint-helpers.js";
import {
  getBearerToken,
  getHeader,
  resolveAgentIdForRequest,
  resolveGatewayRequestContext,
  resolveOpenAiCompatModelOverride,
  resolveOpenAiCompatibleHttpOperatorScopes,
  resolveOpenAiCompatibleHttpSenderIsOwner,
} from "./http-utils.js";
import { normalizeInputHostnameAllowlist } from "./input-allowlist.js";
import {
  CreateResponseBodySchema,
  type CreateResponseBody,
  type OutputItem,
  type ResponseResource,
  type StreamingEvent,
  type Usage,
} from "./open-responses.schema.js";
import { wrapUntrustedFileContent } from "./openresponses-file-content.js";
import { buildAgentPrompt } from "./openresponses-prompt.js";
import { createAssistantOutputItem, createFunctionCallOutputItem } from "./openresponses-shape.js";

type OpenResponsesHttpOptions = {
  auth: ResolvedGatewayAuth;
  maxBodyBytes?: number;
  config?: GatewayHttpResponsesConfig;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
};

const DEFAULT_BODY_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_URL_PARTS = 8;

// In-memory map from responseId -> sessionKey for previous_response_id continuity.
// Entries are evicted after 30 minutes to bound memory usage.
const RESPONSE_SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_RESPONSE_SESSION_ENTRIES = 500;
type ResponseSessionScope = {
  authSubject: string;
  agentId: string;
  requestedSessionKey?: string;
};

type ResponseSessionEntry = ResponseSessionScope & {
  sessionKey: string;
  ts: number;
};

const responseSessionMap = new Map<string, ResponseSessionEntry>();

function normalizeResponseSessionScope(scope: ResponseSessionScope): ResponseSessionScope {
  const authSubject = scope.authSubject.trim();
  const requestedSessionKey = scope.requestedSessionKey?.trim();
  return {
    authSubject,
    agentId: scope.agentId,
    requestedSessionKey: requestedSessionKey || undefined,
  };
}

function resolveResponseSessionAuthSubject(params: {
  req: IncomingMessage;
  auth: ResolvedGatewayAuth;
}): string {
  const bearer = getBearerToken(params.req);
  if (bearer) {
    return `bearer:${createHash("sha256").update(bearer).digest("hex")}`;
  }
  if (params.auth.mode === "trusted-proxy" && params.auth.trustedProxy?.userHeader) {
    const user = getHeader(params.req, params.auth.trustedProxy.userHeader)?.trim();
    if (user) {
      return `trusted-proxy:${user}`;
    }
  }
  return `gateway-auth:${params.auth.mode}`;
}

function createResponseSessionScope(params: {
  req: IncomingMessage;
  auth: ResolvedGatewayAuth;
  agentId: string;
}): ResponseSessionScope {
  return normalizeResponseSessionScope({
    authSubject: resolveResponseSessionAuthSubject({ req: params.req, auth: params.auth }),
    agentId: params.agentId,
    requestedSessionKey: getHeader(params.req, "x-openclaw-session-key"),
  });
}

function matchesResponseSessionScope(
  entry: ResponseSessionEntry,
  scope: ResponseSessionScope,
): boolean {
  return (
    entry.authSubject === scope.authSubject &&
    entry.agentId === scope.agentId &&
    entry.requestedSessionKey === scope.requestedSessionKey
  );
}

function pruneExpiredResponseSessions(now: number) {
  while (responseSessionMap.size > 0) {
    const oldest = responseSessionMap.entries().next().value;
    if (!oldest) {
      return;
    }
    const [oldestKey, oldestValue] = oldest;
    if (now - oldestValue.ts <= RESPONSE_SESSION_TTL_MS) {
      return;
    }
    responseSessionMap.delete(oldestKey);
  }
}

function evictOverflowResponseSessions() {
  while (responseSessionMap.size > MAX_RESPONSE_SESSION_ENTRIES) {
    const oldestKey = responseSessionMap.keys().next().value;
    if (!oldestKey) {
      return;
    }
    responseSessionMap.delete(oldestKey);
  }
}

function storeResponseSession(
  responseId: string,
  sessionKey: string,
  scope: ResponseSessionScope,
  now = Date.now(),
) {
  // Reinsert existing keys so the map stays ordered by freshest timestamp.
  responseSessionMap.delete(responseId);
  responseSessionMap.set(responseId, { ...scope, sessionKey, ts: now });
  pruneExpiredResponseSessions(now);
  evictOverflowResponseSessions();
}

function lookupResponseSession(
  responseId: string | undefined,
  scope: ResponseSessionScope,
  now = Date.now(),
): string | undefined {
  if (!responseId) {
    return undefined;
  }
  const entry = responseSessionMap.get(responseId);
  if (!entry) {
    return undefined;
  }
  if (now - entry.ts > RESPONSE_SESSION_TTL_MS) {
    responseSessionMap.delete(responseId);
    return undefined;
  }
  if (!matchesResponseSessionScope(entry, scope)) {
    return undefined;
  }
  return entry.sessionKey;
}

export const __testing = {
  resetResponseSessionState() {
    responseSessionMap.clear();
  },
  wrapUntrustedFileContent,
  storeResponseSessionAt(
    responseId: string,
    sessionKey: string,
    now: number,
    scope: ResponseSessionScope = { authSubject: "test", agentId: "main" },
  ) {
    storeResponseSession(responseId, sessionKey, normalizeResponseSessionScope(scope), now);
  },
  lookupResponseSessionAt(
    responseId: string | undefined,
    now: number,
    scope: ResponseSessionScope = { authSubject: "test", agentId: "main" },
  ) {
    return lookupResponseSession(responseId, normalizeResponseSessionScope(scope), now);
  },
  getResponseSessionIds() {
    return [...responseSessionMap.keys()];
  },
};

function writeSseEvent(res: ServerResponse, event: StreamingEvent) {
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

type ResolvedResponsesLimits = {
  maxBodyBytes: number;
  maxUrlParts: number;
  files: InputFileLimits;
  images: InputImageLimits;
};

function resolveResponsesLimits(
  config: GatewayHttpResponsesConfig | undefined,
): ResolvedResponsesLimits {
  const files = config?.files;
  const images = config?.images;
  const fileLimits = resolveInputFileLimits(files);
  return {
    maxBodyBytes: config?.maxBodyBytes ?? DEFAULT_BODY_BYTES,
    maxUrlParts:
      typeof config?.maxUrlParts === "number"
        ? Math.max(0, Math.floor(config.maxUrlParts))
        : DEFAULT_MAX_URL_PARTS,
    files: {
      ...fileLimits,
      urlAllowlist: normalizeInputHostnameAllowlist(files?.urlAllowlist),
    },
    images: {
      allowUrl: images?.allowUrl ?? true,
      urlAllowlist: normalizeInputHostnameAllowlist(images?.urlAllowlist),
      allowedMimes: normalizeMimeList(images?.allowedMimes, DEFAULT_INPUT_IMAGE_MIMES),
      maxBytes: images?.maxBytes ?? DEFAULT_INPUT_IMAGE_MAX_BYTES,
      maxRedirects: images?.maxRedirects ?? DEFAULT_INPUT_MAX_REDIRECTS,
      timeoutMs: images?.timeoutMs ?? DEFAULT_INPUT_TIMEOUT_MS,
    },
  };
}

function extractClientTools(body: CreateResponseBody): ClientToolDefinition[] {
  // Normalize from Responses API flat format to the internal wrapped format.
  return (body.tools ?? []).map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: tool.strict,
    },
  }));
}

function applyToolChoice(params: {
  tools: ClientToolDefinition[];
  toolChoice: CreateResponseBody["tool_choice"];
}): { tools: ClientToolDefinition[]; extraSystemPrompt?: string } {
  const { tools, toolChoice } = params;
  if (!toolChoice) {
    return { tools };
  }

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

export { buildAgentPrompt } from "./openresponses-prompt.js";

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
  if (!value) {
    return createEmptyUsage();
  }
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

type PendingToolCall = { id: string; name: string; arguments: string };

function resolveStopReasonAndPendingToolCalls(meta: unknown): {
  stopReason: string | undefined;
  pendingToolCalls: PendingToolCall[] | undefined;
} {
  if (!meta || typeof meta !== "object") {
    return { stopReason: undefined, pendingToolCalls: undefined };
  }
  const record = meta as { stopReason?: string; pendingToolCalls?: PendingToolCall[] };
  return { stopReason: record.stopReason, pendingToolCalls: record.pendingToolCalls };
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

async function runResponsesAgentCommand(params: {
  message: string;
  images: ImageContent[];
  clientTools: ClientToolDefinition[];
  extraSystemPrompt: string;
  modelOverride?: string;
  streamParams: { maxTokens: number } | undefined;
  sessionKey: string;
  runId: string;
  messageChannel: string;
  senderIsOwner: boolean;
  deps: CliDeps;
  abortSignal?: AbortSignal;
}) {
  return agentCommandFromIngress(
    {
      message: params.message,
      images: params.images.length > 0 ? params.images : undefined,
      clientTools: params.clientTools.length > 0 ? params.clientTools : undefined,
      extraSystemPrompt: params.extraSystemPrompt || undefined,
      model: params.modelOverride,
      streamParams: params.streamParams ?? undefined,
      sessionKey: params.sessionKey,
      runId: params.runId,
      deliver: false,
      messageChannel: params.messageChannel,
      bestEffortDeliver: false,
      senderIsOwner: params.senderIsOwner,
      allowModelOverride: true,
      abortSignal: params.abortSignal,
    },
    defaultRuntime,
    params.deps,
  );
}

export async function handleOpenResponsesHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: OpenResponsesHttpOptions,
): Promise<boolean> {
  const limits = resolveResponsesLimits(opts.config);
  const maxBodyBytes =
    opts.maxBodyBytes ??
    (opts.config?.maxBodyBytes
      ? limits.maxBodyBytes
      : Math.max(limits.maxBodyBytes, limits.files.maxBytes * 2, limits.images.maxBytes * 2));
  const handled = await handleGatewayPostJsonEndpoint(req, res, {
    pathname: "/v1/responses",
    requiredOperatorMethod: "chat.send",
    // Compat HTTP uses a different scope model from generic HTTP helpers:
    // shared-secret bearer auth is treated as full operator access here.
    resolveOperatorScopes: resolveOpenAiCompatibleHttpOperatorScopes,
    auth: opts.auth,
    trustedProxies: opts.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
    maxBodyBytes,
  });
  if (handled === false) {
    return false;
  }
  if (!handled) {
    return true;
  }
  // On the compat surface, shared-secret bearer auth is also treated as an
  // owner sender so owner-only tool policy matches the documented contract.
  const senderIsOwner = resolveOpenAiCompatibleHttpSenderIsOwner(req, handled.requestAuth);

  // Validate request body with Zod
  const parseResult = CreateResponseBodySchema.safeParse(handled.body);
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
  const agentId = resolveAgentIdForRequest({ req, model });
  const { modelOverride, errorMessage: modelError } = await resolveOpenAiCompatModelOverride({
    req,
    agentId,
    model,
  });
  if (modelError) {
    sendJson(res, 400, {
      error: { message: modelError, type: "invalid_request_error" },
    });
    return true;
  }

  // Extract images + files from input (Phase 2)
  let images: ImageContent[] = [];
  let fileContexts: string[] = [];
  let urlParts = 0;
  const markUrlPart = () => {
    urlParts += 1;
    if (urlParts > limits.maxUrlParts) {
      throw new Error(
        `Too many URL-based input sources: ${urlParts} (limit: ${limits.maxUrlParts})`,
      );
    }
  };
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
              if (sourceType === "url") {
                markUrlPart();
              }
              const imageSource: InputImageSource =
                sourceType === "url"
                  ? {
                      type: "url",
                      url: source.url ?? "",
                      mediaType: source.media_type,
                    }
                  : {
                      type: "base64",
                      data: source.data ?? "",
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
              if (sourceType === "url") {
                markUrlPart();
              }
              const file = await extractFileContentFromSource({
                source:
                  sourceType === "url"
                    ? {
                        type: "url",
                        url: source.url ?? "",
                        mediaType: source.media_type,
                        filename: source.filename,
                      }
                    : {
                        type: "base64",
                        data: source.data ?? "",
                        mediaType: source.media_type,
                        filename: source.filename,
                      },
                limits: limits.files,
              });
              const rawText = file.text;
              if (rawText?.trim()) {
                fileContexts.push(
                  renderFileContextBlock({
                    filename: file.filename,
                    content: wrapUntrustedFileContent(rawText),
                  }),
                );
              } else if (file.images && file.images.length > 0) {
                fileContexts.push(
                  renderFileContextBlock({
                    filename: file.filename,
                    content: "[PDF content rendered to images]",
                    surroundContentWithNewlines: false,
                  }),
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
    logWarn(`openresponses: request parsing failed: ${String(err)}`);
    sendJson(res, 400, {
      error: { message: "invalid request", type: "invalid_request_error" },
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
    logWarn(`openresponses: tool configuration failed: ${String(err)}`);
    sendJson(res, 400, {
      error: { message: "invalid tool configuration", type: "invalid_request_error" },
    });
    return true;
  }
  const resolved = resolveGatewayRequestContext({
    req,
    model,
    user,
    sessionPrefix: "openresponses",
    defaultMessageChannel: "webchat",
    useMessageChannelHeader: true,
  });
  const responseSessionScope = createResponseSessionScope({
    req,
    auth: opts.auth,
    agentId: resolved.agentId,
  });
  // Resolve session key: reuse previous_response_id only when it matches the
  // same auth-subject/agent/requested-session scope as the current request.
  const previousSessionKey = lookupResponseSession(
    payload.previous_response_id,
    responseSessionScope,
  );
  const sessionKey = previousSessionKey ?? resolved.sessionKey;
  const messageChannel = resolved.messageChannel;

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
  const rememberResponseSession = () =>
    storeResponseSession(responseId, sessionKey, responseSessionScope);
  const outputItemId = `msg_${randomUUID()}`;
  const deps = createDefaultDeps();
  const abortController = new AbortController();
  const streamParams =
    typeof payload.max_output_tokens === "number"
      ? { maxTokens: payload.max_output_tokens }
      : undefined;

  if (!stream) {
    const stopWatchingDisconnect = watchClientDisconnect(req, res, abortController);
    try {
      const result = await runResponsesAgentCommand({
        message: prompt.message,
        images,
        clientTools: resolvedClientTools,
        extraSystemPrompt,
        modelOverride,
        streamParams,
        sessionKey,
        runId: responseId,
        messageChannel,
        senderIsOwner,
        deps,
        abortSignal: abortController.signal,
      });

      if (abortController.signal.aborted) {
        return true;
      }

      const payloads = (result as { payloads?: Array<{ text?: string }> } | null)?.payloads;
      const usage = extractUsageFromResult(result);
      const meta = (result as { meta?: unknown } | null)?.meta;
      const { stopReason, pendingToolCalls } = resolveStopReasonAndPendingToolCalls(meta);

      // If agent called a client tool, return function_call (and any assistant text) to caller
      if (stopReason === "tool_calls" && pendingToolCalls && pendingToolCalls.length > 0) {
        const functionCall = pendingToolCalls[0];
        const functionCallItemId = `call_${randomUUID()}`;

        const assistantText =
          Array.isArray(payloads) && payloads.length > 0
            ? payloads
                .map((p) => (typeof p.text === "string" ? p.text : ""))
                .filter(Boolean)
                .join("\n\n")
            : "";

        const output: OutputItem[] = [];
        if (assistantText) {
          output.push(
            createAssistantOutputItem({
              id: outputItemId,
              text: assistantText,
              phase: "commentary",
              status: "completed",
            }),
          );
        }
        output.push(
          createFunctionCallOutputItem({
            id: functionCallItemId,
            callId: functionCall.id,
            name: functionCall.name,
            arguments: functionCall.arguments,
          }),
        );

        const response = createResponseResource({
          id: responseId,
          model,
          status: "incomplete",
          output,
          usage,
        });
        rememberResponseSession();
        sendJson(res, 200, response);
        return true;
      }

      const content =
        Array.isArray(payloads) && payloads.length > 0
          ? payloads
              .map((p) => (typeof p.text === "string" ? p.text : ""))
              .filter(Boolean)
              .join("\n\n")
          : "No response from OpenClaw.";

      const response = createResponseResource({
        id: responseId,
        model,
        status: "completed",
        output: [
          createAssistantOutputItem({
            id: outputItemId,
            text: content,
            phase: "final_answer",
            status: "completed",
          }),
        ],
        usage,
      });

      rememberResponseSession();
      sendJson(res, 200, response);
    } catch (err) {
      if (abortController.signal.aborted) {
        return true;
      }
      logWarn(`openresponses: non-stream response failed: ${String(err)}`);
      const response = createResponseResource({
        id: responseId,
        model,
        status: "failed",
        output: [],
        error: { code: "api_error", message: "internal error" },
      });
      rememberResponseSession();
      sendJson(res, 500, response);
    } finally {
      stopWatchingDisconnect();
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
  let stopWatchingDisconnect = () => {};
  let finalUsage: Usage | undefined;
  let finalizeRequested: { status: ResponseResource["status"]; text: string } | null = null;

  const maybeFinalize = () => {
    if (closed) {
      return;
    }
    if (!finalizeRequested) {
      return;
    }
    if (!finalUsage) {
      return;
    }
    const usage = finalUsage;

    closed = true;
    stopWatchingDisconnect();
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
      phase: finalizeRequested.status === "completed" ? "final_answer" : "commentary",
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

    rememberResponseSession();
    writeSseEvent(res, { type: "response.completed", response: finalResponse });
    writeDone(res);
    res.end();
  };

  const requestFinalize = (status: ResponseResource["status"], text: string) => {
    if (finalizeRequested) {
      return;
    }
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
    if (evt.runId !== responseId) {
      return;
    }
    if (closed) {
      return;
    }

    if (evt.stream === "assistant") {
      const text = evt.data?.text;
      const replace = evt.data?.replace === true;
      if (replace && typeof text === "string") {
        accumulatedText = text;
      }
      const content = resolveAssistantStreamDeltaText(evt);
      if (!content) {
        return;
      }

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
        const finalText = accumulatedText || "No response from OpenClaw.";
        const finalStatus = phase === "error" ? "failed" : "completed";
        requestFinalize(finalStatus, finalText);
      }
    }
  });

  stopWatchingDisconnect = watchClientDisconnect(req, res, abortController, () => {
    closed = true;
    unsubscribe();
  });

  void (async () => {
    try {
      const result = await runResponsesAgentCommand({
        message: prompt.message,
        images,
        clientTools: resolvedClientTools,
        extraSystemPrompt,
        modelOverride,
        streamParams,
        sessionKey,
        runId: responseId,
        messageChannel,
        senderIsOwner,
        deps,
        abortSignal: abortController.signal,
      });

      finalUsage = extractUsageFromResult(result);

      // Check for pending client tool calls BEFORE maybeFinalize() because the
      // lifecycle:end event may already have requested finalization.
      const resultAny = result as { payloads?: Array<{ text?: string }>; meta?: unknown };
      const meta = resultAny.meta;
      const { stopReason, pendingToolCalls } = resolveStopReasonAndPendingToolCalls(meta);

      if (
        !closed &&
        stopReason === "tool_calls" &&
        pendingToolCalls &&
        pendingToolCalls.length > 0
      ) {
        const functionCall = pendingToolCalls[0];
        const usage = finalUsage ?? createEmptyUsage();
        const finalText =
          accumulatedText ||
          (Array.isArray(resultAny.payloads)
            ? resultAny.payloads
                .map((p) => (typeof p.text === "string" ? p.text : ""))
                .filter(Boolean)
                .join("\n\n")
            : "");

        writeSseEvent(res, {
          type: "response.output_text.done",
          item_id: outputItemId,
          output_index: 0,
          content_index: 0,
          text: finalText,
        });
        writeSseEvent(res, {
          type: "response.content_part.done",
          item_id: outputItemId,
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: finalText },
        });

        const completedItem = createAssistantOutputItem({
          id: outputItemId,
          text: finalText,
          phase: "commentary",
          status: "completed",
        });
        writeSseEvent(res, {
          type: "response.output_item.done",
          output_index: 0,
          item: completedItem,
        });

        const functionCallItemId = `call_${randomUUID()}`;
        const functionCallItem = createFunctionCallOutputItem({
          id: functionCallItemId,
          callId: functionCall.id,
          name: functionCall.name,
          arguments: functionCall.arguments,
        });
        writeSseEvent(res, {
          type: "response.output_item.added",
          output_index: 1,
          item: functionCallItem,
        });
        const completedFunctionCallItem = createFunctionCallOutputItem({
          id: functionCallItemId,
          callId: functionCall.id,
          name: functionCall.name,
          arguments: functionCall.arguments,
          status: "completed",
        });
        writeSseEvent(res, {
          type: "response.output_item.done",
          output_index: 1,
          item: completedFunctionCallItem,
        });

        const incompleteResponse = createResponseResource({
          id: responseId,
          model,
          status: "incomplete",
          output: [completedItem, functionCallItem],
          usage,
        });
        closed = true;
        stopWatchingDisconnect();
        unsubscribe();
        rememberResponseSession();
        writeSseEvent(res, { type: "response.completed", response: incompleteResponse });
        writeDone(res);
        res.end();
        return;
      }

      maybeFinalize();

      if (closed) {
        return;
      }

      // Fallback: if no streaming deltas were received, send the full response as text
      if (!sawAssistantDelta) {
        const payloads = resultAny.payloads;
        const content =
          Array.isArray(payloads) && payloads.length > 0
            ? payloads
                .map((p) => (typeof p.text === "string" ? p.text : ""))
                .filter(Boolean)
                .join("\n\n")
            : "No response from OpenClaw.";

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
      if (closed || abortController.signal.aborted) {
        return;
      }
      logWarn(`openresponses: streaming response failed: ${String(err)}`);

      finalUsage = finalUsage ?? createEmptyUsage();
      const errorResponse = createResponseResource({
        id: responseId,
        model,
        status: "failed",
        output: [],
        error: { code: "api_error", message: "internal error" },
        usage: finalUsage,
      });

      rememberResponseSession();
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

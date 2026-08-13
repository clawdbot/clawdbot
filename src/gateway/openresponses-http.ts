/**
 * OpenResponses HTTP Handler
 *
 * Implements the OpenResponses `/v1/responses` endpoint for OpenClaw Gateway.
 *
 * @see https://www.open-responses.com/
 */

import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveIntegerOption } from "@openclaw/normalization-core/number-coercion";
import { isClientToolNameConflictError } from "../agents/agent-tool-definition-adapter.js";
import type { ImageContent } from "../agents/command/types.js";
import type { ClientToolDefinition } from "../agents/embedded-agent-runner/run/params.js";
import { toOpenAiResponsesUsage } from "../agents/usage.js";
import { createDefaultDeps } from "../cli/deps.js";
import type { CliDeps } from "../cli/deps.types.js";
import { agentCommandFromIngress } from "../commands/agent.js";
import type { GatewayHttpResponsesConfig } from "../config/types.gateway.js";
import { emitAgentEvent, onAgentEvent } from "../infra/agent-events.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
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
import { retainGatewayRootWorkAdmissionContinuation } from "../process/gateway-work-admission.js";
import { defaultRuntime } from "../runtime.js";
import {
  isReplaceableAssistantStreamEvent,
  resolveAssistantStreamDeltaText,
  resolveAssistantStreamSnapshotText,
} from "./agent-event-assistant-text.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import {
  sendJson,
  sendMissingScopeForbidden,
  setSseHeaders,
  watchClientDisconnect,
  writeDone,
} from "./http-common.js";
import { handleGatewayPostJsonEndpoint } from "./http-endpoint-helpers.js";
import {
  type AuthorizedGatewayHttpRequest,
  authorizeOpenAiCompatibleHttpModelOverride,
  getBearerToken,
  getHeader,
  isAgentSelectionRequiredError,
  isGatewaySessionKeyOverrideError,
  isInvalidGatewayModelError,
  isUnknownGatewayAgentError,
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
import { resolveAgentRunUsage } from "./openai-agent-run-usage.js";
import { resolveOpenAiCompatError } from "./openai-compat-errors.js";
import {
  isToolChoiceConstraintSatisfied,
  resolveUnsatisfiedToolChoiceMessage,
  toolChoiceConstraintPrompt,
  type ToolChoiceConstraint,
} from "./openai-tool-choice.js";
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
  requestAuth: AuthorizedGatewayHttpRequest;
}): string {
  // Proxy-verified identity owns continuation; forwarded bearers are unverified.
  if (params.requestAuth.authMethod === "trusted-proxy") {
    return `trusted-proxy:${params.requestAuth.user}`;
  }
  const bearer = getBearerToken(params.req);
  if (bearer) {
    return `bearer:${createHash("sha256").update(bearer).digest("hex")}`;
  }
  return `gateway-auth:${params.auth.mode}`;
}

function createResponseSessionScope(params: {
  req: IncomingMessage;
  auth: ResolvedGatewayAuth;
  requestAuth: AuthorizedGatewayHttpRequest;
  agentId: string;
}): ResponseSessionScope {
  return normalizeResponseSessionScope({
    authSubject: resolveResponseSessionAuthSubject(params),
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
  pruneMapToMaxSize(responseSessionMap, MAX_RESPONSE_SESSION_ENTRIES);
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

export const testing = {
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
  resolveResponsesLimits,
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
    maxBodyBytes: DEFAULT_BODY_BYTES,
    maxUrlParts: resolveIntegerOption(config?.maxUrlParts, DEFAULT_MAX_URL_PARTS, { min: 0 }),
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
}): {
  tools: ClientToolDefinition[];
  extraSystemPrompt?: string;
  constraint?: ToolChoiceConstraint;
} {
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
    const constraint: ToolChoiceConstraint = { type: "required" };
    return { tools, extraSystemPrompt: toolChoiceConstraintPrompt(constraint), constraint };
  }

  if (typeof toolChoice === "object" && toolChoice.type === "function") {
    const targetName = ("name" in toolChoice ? toolChoice.name : toolChoice.function.name).trim();
    if (!targetName) {
      throw new Error("tool_choice.name is required");
    }
    const matched = tools.filter((tool) => tool.function?.name === targetName);
    if (matched.length === 0) {
      throw new Error(`tool_choice requested unknown tool: ${targetName}`);
    }
    const constraint: ToolChoiceConstraint = { type: "function", name: targetName };
    return {
      tools: matched,
      extraSystemPrompt: toolChoiceConstraintPrompt(constraint),
      constraint,
    };
  }

  return { tools };
}

export { buildAgentPrompt } from "./openresponses-prompt.js";

function createEmptyUsage(): Usage {
  return toOpenAiResponsesUsage(undefined);
}

function extractUsageFromResult(result: unknown): Usage {
  return toOpenAiResponsesUsage(resolveAgentRunUsage(result));
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
  streamParams: { maxTokens?: number; temperature?: number; topP?: number } | undefined;
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
      senderIsOwner: params.senderIsOwner,
      bestEffortDeliver: false,
      allowModelOverride: params.modelOverride !== undefined,
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
    Math.max(limits.maxBodyBytes, limits.files.maxBytes * 2, limits.images.maxBytes * 2);
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
  const modelOverrideAuth = authorizeOpenAiCompatibleHttpModelOverride(req, handled.requestAuth);
  if (!modelOverrideAuth.allowed) {
    sendMissingScopeForbidden(res, modelOverrideAuth.missingScope);
    return true;
  }
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
  let agentId: string;
  try {
    agentId = resolveAgentIdForRequest({ req, model });
  } catch (err) {
    if (
      isAgentSelectionRequiredError(err) ||
      isInvalidGatewayModelError(err) ||
      isUnknownGatewayAgentError(err)
    ) {
      sendJson(res, 400, {
        error: { message: err.message, type: "invalid_request_error" },
      });
      return true;
    }
    throw err;
  }
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

  const prompt = buildAgentPrompt(payload.input);

  // Count URL sources request-wide, but replay media only from the current user turn.
  let images: ImageContent[] = [];
  const fileContexts: string[] = [];
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
            if (part.type !== "input_image" && part.type !== "input_file") {
              continue;
            }
            if (part.source.type === "url") {
              markUrlPart();
            }
            if (item !== prompt.activeUserMessage) {
              continue;
            }
            if (part.type === "input_image") {
              const source = part.source;
              const imageSource: InputImageSource =
                source.type === "url"
                  ? { type: "url", url: source.url }
                  : {
                      type: "base64",
                      data: source.data,
                      mediaType: source.media_type,
                    };
              const image = await extractImageContentFromSource(imageSource, limits.images);
              images.push(image);
              continue;
            }

            const source = part.source;
            const file = await extractFileContentFromSource({
              source:
                source.type === "url"
                  ? { type: "url", url: source.url }
                  : {
                      type: "base64",
                      data: source.data,
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
            } else {
              fileContexts.push(
                renderFileContextBlock({
                  filename: file.filename,
                  content: "[No extractable text]",
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
  } catch (err) {
    logWarn(`openresponses: request parsing failed: ${String(err)}`);
    sendJson(res, 400, {
      error: { message: "invalid request", type: "invalid_request_error" },
    });
    return true;
  }

  const clientTools = extractClientTools(payload);
  let toolChoicePrompt: string | undefined;
  let toolChoiceConstraint: ToolChoiceConstraint | undefined;
  let resolvedClientTools = clientTools;
  try {
    const toolChoiceResult = applyToolChoice({
      tools: clientTools,
      toolChoice: payload.tool_choice,
    });
    resolvedClientTools = toolChoiceResult.tools;
    toolChoicePrompt = toolChoiceResult.extraSystemPrompt;
    toolChoiceConstraint = toolChoiceResult.constraint;
  } catch (err) {
    logWarn(`openresponses: tool configuration failed: ${String(err)}`);
    sendJson(res, 400, {
      error: { message: "invalid tool configuration", type: "invalid_request_error" },
    });
    return true;
  }
  let resolved: ReturnType<typeof resolveGatewayRequestContext>;
  try {
    resolved = resolveGatewayRequestContext({
      req,
      model,
      user,
      sessionPrefix: "openresponses",
      defaultMessageChannel: "webchat",
      useMessageChannelHeader: true,
    });
  } catch (err) {
    if (
      isAgentSelectionRequiredError(err) ||
      isUnknownGatewayAgentError(err) ||
      isInvalidGatewayModelError(err) ||
      isGatewaySessionKeyOverrideError(err)
    ) {
      sendJson(res, 400, {
        error: { message: err.message, type: "invalid_request_error" },
      });
      return true;
    }
    throw err;
  }
  const responseSessionScope = createResponseSessionScope({
    req,
    auth: opts.auth,
    requestAuth: handled.requestAuth,
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
  const streamMaxTokens =
    typeof payload.max_output_tokens === "number" ? payload.max_output_tokens : undefined;
  const streamTemperature =
    typeof payload.temperature === "number" ? payload.temperature : undefined;
  const streamTopP = typeof payload.top_p === "number" ? payload.top_p : undefined;
  const streamParams =
    streamMaxTokens !== undefined || streamTemperature !== undefined || streamTopP !== undefined
      ? {
          ...(streamMaxTokens !== undefined ? { maxTokens: streamMaxTokens } : {}),
          ...(streamTemperature !== undefined ? { temperature: streamTemperature } : {}),
          ...(streamTopP !== undefined ? { topP: streamTopP } : {}),
        }
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

      // A `required`/pinned `tool_choice` must reject a text-only turn instead
      // of returning ordinary assistant prose, mirroring /v1/chat/completions.
      // Shared satisfaction check lives in openai-tool-choice.ts.
      if (
        toolChoiceConstraint &&
        !isToolChoiceConstraintSatisfied({ constraint: toolChoiceConstraint, pendingToolCalls })
      ) {
        const failed = createResponseResource({
          id: responseId,
          model,
          status: "failed",
          output: [],
          error: {
            code: "api_error",
            message: resolveUnsatisfiedToolChoiceMessage(toolChoiceConstraint),
          },
          usage,
        });
        rememberResponseSession();
        sendJson(res, 502, failed);
        return true;
      }

      // If the agent invoked client tools, return one `function_call`
      // output item per call (in arrival order) plus any assistant text the
      // model produced before the tool calls. Pre-#52288 only the first
      // pending call was emitted, so multi-tool turns lost every call but
      // the leading one.
      if (stopReason === "tool_calls" && pendingToolCalls && pendingToolCalls.length > 0) {
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
        for (const functionCall of pendingToolCalls) {
          output.push(
            createFunctionCallOutputItem({
              id: `call_${randomUUID()}`,
              callId: functionCall.id,
              name: functionCall.name,
              arguments: functionCall.arguments,
            }),
          );
        }

        const response = createResponseResource({
          id: responseId,
          model,
          status: "completed",
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
      if (isClientToolNameConflictError(err)) {
        const response = createResponseResource({
          id: responseId,
          model,
          status: "failed",
          output: [],
          error: { code: "invalid_request_error", message: "invalid tool configuration" },
        });
        sendJson(res, 400, response);
        return true;
      }
      const response = createResponseResource({
        id: responseId,
        model,
        status: "failed",
        output: [],
        error: { code: "api_error", message: "internal error" },
      });
      const mapped = resolveOpenAiCompatError(err);
      if (mapped) {
        const mappedResponse = createResponseResource({
          id: responseId,
          model,
          status: "failed",
          output: [],
          error: {
            code: mapped.error.type,
            message: mapped.error.message,
          },
        });
        rememberResponseSession();
        sendJson(res, mapped.status, mappedResponse);
        return true;
      }
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
  let streamedAssistantText = "";
  let bufferedReplaceableAssistantContent = "";
  let sawAssistantDelta = false;
  let unrepresentableAssistantReplacement = false;
  let closed = false;
  let unsubscribe = () => {};
  let stopWatchingDisconnect = () => {};
  let finalUsage: Usage | undefined;
  let finalizeStatus: ResponseResource["status"] | null = null;
  let finalizeRequested: { status: ResponseResource["status"]; text: string } | null = null;
  let finalizeScheduled = false;
  let finalizeErrorMessage: string | undefined;
  let terminalLifecyclePhase: "end" | "error" = "end";

  const maybeFinalize = () => {
    if (closed || finalizeScheduled) {
      return;
    }
    if (!finalizeRequested) {
      return;
    }
    if (!finalUsage) {
      return;
    }
    // Lifecycle listeners can queue assistant flushes after this listener runs;
    // the next turn preserves all same-turn deltas before the terminal snapshot.
    finalizeScheduled = true;
    setImmediate(() => {
      if (closed || !finalizeRequested || !finalUsage) {
        return;
      }
      if (unrepresentableAssistantReplacement) {
        finalizeUnrepresentableAssistantReplacement();
        return;
      }
      const usage = finalUsage;
      const finalText =
        accumulatedText || bufferedReplaceableAssistantContent || finalizeRequested.text;

      closed = true;
      stopWatchingDisconnect();
      unsubscribe();

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
        ...(finalizeRequested.status === "failed"
          ? {
              error: {
                code: "server_error",
                message: finalizeErrorMessage || "Agent run failed",
              },
            }
          : {}),
      });

      rememberResponseSession();
      writeSseEvent(res, {
        type: finalizeRequested.status === "failed" ? "response.failed" : "response.completed",
        response: finalResponse,
      });
      writeDone(res);
      res.end();
    });
  };

  const requestFinalize = (
    status: ResponseResource["status"],
    text: string,
    errorMessage?: string,
  ) => {
    if (finalizeRequested) {
      return;
    }
    finalizeStatus = status;
    finalizeErrorMessage = errorMessage;
    finalizeRequested = { status, text };
    maybeFinalize();
  };

  const finalizeFailedResponse = (response: ResponseResource) => {
    if (closed) {
      return;
    }
    // Failure is terminal even when an earlier lifecycle event is waiting for usage.
    closed = true;
    stopWatchingDisconnect();
    unsubscribe();
    writeSseEvent(res, { type: "response.failed", response });
    writeDone(res);
    res.end();
  };

  const finalizeUnrepresentableAssistantReplacement = () => {
    const usage = finalUsage;
    if (!usage) {
      return;
    }
    rememberResponseSession();
    finalizeFailedResponse(
      createResponseResource({
        id: responseId,
        model,
        status: "failed",
        output: [],
        error: {
          code: "server_error",
          message: "Assistant output cannot be represented as an append-only response stream.",
        },
        usage,
      }),
    );
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
      if (isReplaceableAssistantStreamEvent(evt)) {
        const snapshot = resolveAssistantStreamSnapshotText(evt);
        if (snapshot) {
          bufferedReplaceableAssistantContent = snapshot;
        }
        return;
      }

      const text = evt.data?.text;
      const replace = evt.data?.replace === true;
      if (replace && typeof text === "string") {
        accumulatedText = text;
        if (toolChoiceConstraint) {
          return;
        }
        // Responses deltas can only append. A conflicting replacement must
        // fail after usage resolves instead of claiming inconsistent success.
        if (!text.startsWith(streamedAssistantText)) {
          unrepresentableAssistantReplacement = true;
          return;
        }
        unrepresentableAssistantReplacement = false;
        const replacementDelta = text.slice(streamedAssistantText.length);
        if (replacementDelta) {
          sawAssistantDelta = true;
          streamedAssistantText = text;
          writeSseEvent(res, {
            type: "response.output_text.delta",
            item_id: outputItemId,
            output_index: 0,
            content_index: 0,
            delta: replacementDelta,
          });
        }
        return;
      }

      const content = resolveAssistantStreamDeltaText(evt);
      if (!content) {
        return;
      }

      // Hold assistant prose until the tool-choice contract is confirmed. A
      // `required`/pinned request must reject text-only turns, so streaming
      // deltas now could leak output we may have to fail. Buffered text is
      // still flushed as commentary if a matching tool call arrives, matching
      // the openai-http.ts streaming buffer.
      if (toolChoiceConstraint) {
        accumulatedText += content;
        return;
      }

      sawAssistantDelta = true;
      accumulatedText += content;
      streamedAssistantText += content;

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
        const finalText =
          accumulatedText || bufferedReplaceableAssistantContent || "No response from OpenClaw.";
        const finalStatus = phase === "error" ? "failed" : "completed";
        const errorMessage =
          phase === "error" && typeof evt.data?.error === "string"
            ? evt.data.error.trim()
            : undefined;
        requestFinalize(finalStatus, finalText, errorMessage);
      }
    }
  });

  // Agent cleanup and deferred SSE delivery have independent lifetimes;
  // shutdown must wait until both have settled, whichever finishes last.
  const releaseAgentRootWork = retainGatewayRootWorkAdmissionContinuation();
  const releaseResponseRootWork = retainGatewayRootWorkAdmissionContinuation();
  const releaseStreamRootWork = () => {
    res.off("finish", releaseStreamRootWork);
    res.off("close", releaseStreamRootWork);
    releaseResponseRootWork?.();
  };
  res.once("finish", releaseStreamRootWork);
  res.once("close", releaseStreamRootWork);

  stopWatchingDisconnect = watchClientDisconnect(req, res, abortController, () => {
    closed = true;
    unsubscribe();
    releaseStreamRootWork();
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

      if (unrepresentableAssistantReplacement) {
        finalizeUnrepresentableAssistantReplacement();
        return;
      }

      // Check for pending client tool calls BEFORE maybeFinalize() because the
      // lifecycle:end event may already have requested finalization.
      const resultAny = result as { payloads?: Array<{ text?: string }>; meta?: unknown };
      const resultPayloadText = Array.isArray(resultAny.payloads)
        ? resultAny.payloads
            .map((p) => (typeof p.text === "string" ? p.text : ""))
            .filter(Boolean)
            .join("\n\n")
        : "";
      const meta = resultAny.meta;
      const { stopReason, pendingToolCalls } = resolveStopReasonAndPendingToolCalls(meta);

      // Reject an unsatisfied `required`/pinned `tool_choice` before any
      // buffered prose is flushed, mirroring the non-streaming path and
      // /v1/chat/completions. Closes the stream with a `response.failed` event.
      if (
        !closed &&
        toolChoiceConstraint &&
        !isToolChoiceConstraintSatisfied({ constraint: toolChoiceConstraint, pendingToolCalls })
      ) {
        const failed = createResponseResource({
          id: responseId,
          model,
          status: "failed",
          output: [],
          error: {
            code: "api_error",
            message: resolveUnsatisfiedToolChoiceMessage(toolChoiceConstraint),
          },
          usage: finalUsage ?? createEmptyUsage(),
        });
        closed = true;
        stopWatchingDisconnect();
        unsubscribe();
        rememberResponseSession();
        writeSseEvent(res, { type: "response.failed", response: failed });
        writeDone(res);
        res.end();
        return;
      }

      if (
        !closed &&
        stopReason === "tool_calls" &&
        pendingToolCalls &&
        pendingToolCalls.length > 0
      ) {
        const usage = finalUsage ?? createEmptyUsage();
        const finalText =
          accumulatedText || resultPayloadText || bufferedReplaceableAssistantContent;

        if (toolChoiceConstraint && finalText && !sawAssistantDelta) {
          sawAssistantDelta = true;
          writeSseEvent(res, {
            type: "response.output_text.delta",
            item_id: outputItemId,
            output_index: 0,
            content_index: 0,
            delta: finalText,
          });
        }
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

        // Emit one `function_call` output item per pending call, preserving
        // arrival order. `output_index` continues past the assistant
        // message at index 0 so the SSE stream keeps a single, monotonic
        // index per response. Pre-#52288 the streaming path read only
        // `pendingToolCalls[0]` and hard-coded `output_index: 1`, so a turn
        // with multiple client tool calls dropped every call past the
        // first.
        const functionCallItems: OutputItem[] = [];
        let nextStreamOutputIndex = 1;
        for (const functionCall of pendingToolCalls) {
          const functionCallItemId = `call_${randomUUID()}`;
          const functionCallItem = createFunctionCallOutputItem({
            id: functionCallItemId,
            callId: functionCall.id,
            name: functionCall.name,
            arguments: functionCall.arguments,
          });
          writeSseEvent(res, {
            type: "response.output_item.added",
            output_index: nextStreamOutputIndex,
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
            output_index: nextStreamOutputIndex,
            item: completedFunctionCallItem,
          });
          functionCallItems.push(functionCallItem);
          nextStreamOutputIndex += 1;
        }

        const completedResponse = createResponseResource({
          id: responseId,
          model,
          status: "completed",
          output: [completedItem, ...functionCallItems],
          usage,
        });
        closed = true;
        stopWatchingDisconnect();
        unsubscribe();
        rememberResponseSession();
        writeSseEvent(res, { type: "response.completed", response: completedResponse });
        writeDone(res);
        res.end();
        return;
      }

      // Fallback: if no streaming deltas were received, send the full response as text
      if (!sawAssistantDelta) {
        const content =
          resultPayloadText || bufferedReplaceableAssistantContent || "No response from OpenClaw.";

        accumulatedText = content;
        sawAssistantDelta = true;
        if (finalizeStatus !== null) {
          finalizeRequested = { status: finalizeStatus, text: content };
        }

        writeSseEvent(res, {
          type: "response.output_text.delta",
          item_id: outputItemId,
          output_index: 0,
          content_index: 0,
          delta: content,
        });
      }

      maybeFinalize();
    } catch (err) {
      if (closed || abortController.signal.aborted) {
        return;
      }
      terminalLifecyclePhase = "error";
      logWarn(`openresponses: streaming response failed: ${String(err)}`);

      finalUsage = finalUsage ?? createEmptyUsage();
      if (isClientToolNameConflictError(err)) {
        const errorResponse = createResponseResource({
          id: responseId,
          model,
          status: "failed",
          output: [],
          error: { code: "invalid_request_error", message: "invalid tool configuration" },
          usage: finalUsage,
        });

        finalizeFailedResponse(errorResponse);
        return;
      }
      const errorResponse = createResponseResource({
        id: responseId,
        model,
        status: "failed",
        output: [],
        error: { code: "api_error", message: "internal error" },
        usage: finalUsage,
      });

      const mapped = resolveOpenAiCompatError(err);
      if (mapped) {
        const mappedResponse = createResponseResource({
          id: responseId,
          model,
          status: "failed",
          output: [],
          error: {
            code: mapped.error.type,
            message: mapped.error.message,
          },
          usage: finalUsage,
        });
        rememberResponseSession();
        finalizeFailedResponse(mappedResponse);
        return;
      }
      rememberResponseSession();
      finalizeFailedResponse(errorResponse);
    } finally {
      releaseAgentRootWork?.();
      // Existing provider terminals must not be replaced or emitted twice.
      if (finalizeStatus === null && (terminalLifecyclePhase === "error" || !closed)) {
        emitAgentEvent({
          runId: responseId,
          stream: "lifecycle",
          data: { phase: terminalLifecyclePhase },
        });
      }
    }
  })();

  return true;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

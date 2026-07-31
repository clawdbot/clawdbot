import { randomUUID, createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { EventType } from "@ag-ui/core";
import type { RunAgentInput, Message } from "@ag-ui/core";
import { EventEncoder } from "@ag-ui/encoder";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { getSessionEntry, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { aguiChannelPlugin } from "./channel.js";
import { resolveGatewaySecret } from "./gateway-secret.js";
import { extractImagesFromMessages } from "./images.js";
import {
  buildBodyFromMessages,
  buildDeltaPrompt,
  formatContextEntries,
  parseStateWriterTools,
  applyStateWriter,
  formatSharedState,
  isSharedState,
} from "./prompt-builder.js";
import {
  sendJson,
  sendMethodNotAllowed,
  sendUnauthorized,
  readJsonBody,
  getBearerToken,
  validateSessionKeyHeader,
  createDeviceToken,
  verifyDeviceToken,
} from "./request-util.js";
import {
  setWriter,
  clearWriter,
  markClientToolNames,
  wasClientToolCalled,
  clearClientToolCalled,
  clearClientToolNames,
} from "./tool-store.js";

// ---------------------------------------------------------------------------
// HTTP handler factory
// ---------------------------------------------------------------------------

export function createAguiHttpHandler(api: OpenClawPluginApi) {
  const runtime: PluginRuntime = api.runtime;

  // Resolve once at init so the per-request handler never touches env vars.
  const gatewaySecret = resolveGatewaySecret(api);

  return async function handleAguiRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    // Cross-origin callers (for example a clawpilotkit standalone launcher
    // running on a separate port) need CORS response headers — both on the
    // OPTIONS preflight and on the eventual POST. Bearer auth + JSON body
    // forces a preflight, so we have to answer 204 here. The route's
    // gateway-side auth still requires a valid pairing token on the actual
    // POST: CORS only governs which origins can read the response.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Max-Age", "86400");
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }
    // POST-only
    if (req.method !== "POST") {
      sendMethodNotAllowed(res);
      return;
    }

    // Verify gateway secret was resolved at startup
    if (!gatewaySecret) {
      sendJson(res, 500, {
        error: { message: "Gateway not configured", type: "server_error" },
      });
      return;
    }

    // ---------------------------------------------------------------------------
    // Authentication: No auth (pairing initiation) or Device token
    // ---------------------------------------------------------------------------
    let deviceId: string;

    const bearerToken = getBearerToken(req);

    if (!bearerToken) {
      // No auth header: initiate pairing
      // Generate new device ID
      deviceId = randomUUID();

      // Add to pending via OpenClaw pairing API - returns a pairing code for approval
      const { code: pairingCode } = await runtime.channel.pairing.upsertPairingRequest({
        channel: "ag-ui",
        accountId: "default",
        id: deviceId,
        pairingAdapter: aguiChannelPlugin.pairing,
      });

      // Rate limit reached - max pending requests exceeded
      if (!pairingCode) {
        sendJson(res, 429, {
          error: {
            type: "rate_limit",
            message:
              "Too many pending pairing requests. Please wait for existing requests to expire (10 minutes) or ask the owner to approve/reject them.",
          },
        });
        return;
      }

      // Generate signed device token
      const deviceToken = createDeviceToken(gatewaySecret, deviceId);

      // Return pairing pending response with device token and pairing code
      sendJson(res, 403, {
        pairing_code: pairingCode,
        bearer_token: deviceToken,
        error: {
          type: "pairing_pending",
          message: "Device pending approval",
          pairing: {
            pairingCode,
            token: deviceToken,
            instructions: `Save this token for use as a Bearer token and ask the owner to approve: openclaw pairing approve ag-ui ${pairingCode}`,
          },
        },
      });
      return;
    }

    // Device token flow: verify HMAC signature, extract device ID
    const extractedDeviceId = verifyDeviceToken(bearerToken, gatewaySecret);
    if (!extractedDeviceId) {
      sendUnauthorized(res);
      return;
    }
    deviceId = extractedDeviceId;

    // ---------------------------------------------------------------------------
    // Pairing check: verify device is approved
    // ---------------------------------------------------------------------------
    const storeAllowFrom = await (
      runtime.channel.pairing.readAllowFromStore as unknown as (arg: {
        channel: string;
      }) => Promise<string[]>
    )({ channel: "ag-ui" }).catch(() => []);
    const normalizedAllowFrom = storeAllowFrom.map((e) => e.replace(/^ag-ui:/i, "").toLowerCase());
    const allowed = normalizedAllowFrom.includes(deviceId.toLowerCase());

    if (!allowed) {
      sendJson(res, 403, {
        error: {
          type: "pairing_pending",
          message:
            "Device pending approval. Ask the owner to approve using the pairing code from your initial pairing response.",
        },
      });
      return;
    }

    // ---------------------------------------------------------------------------
    // Device approved - proceed with request
    // ---------------------------------------------------------------------------
    await dispatchAuthenticatedAguiRequest(req, res, runtime, {
      id: deviceId,
      fromLabel: `ag-ui:${deviceId}`,
    });
  };
}

/**
 * Factory for the operator-auth AG-UI route.
 *
 * Mounted at a separate path (e.g. `/v1/ag-ui/operator`) with
 * `auth: "gateway"` — the OpenClaw gateway validates the caller's operator
 * scopes before we see the request, so we skip the device-pairing dance. The
 * AG-UI dispatch logic itself is identical to the device-token path.
 *
 * Intended for operator-UI-embedded consumers (plugin-contributed UI slots)
 * that already hold an OpenClaw gateway token via `ExtensionTabContext` and
 * should not need a second pairing flow.
 */
export function createOperatorAguiHttpHandler(api: OpenClawPluginApi) {
  const runtime: PluginRuntime = api.runtime;

  return async function handleOperatorAguiRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    // This route is reached from the OpenClaw operator console's
    // `chat.surface` slot, which runs inside a sandboxed iframe without
    // `allow-same-origin` — the iframe's document origin is opaque ("null").
    // Any fetch from that context is treated by the browser as cross-origin
    // and requires CORS response headers; an `Authorization` request header
    // forces a preflight OPTIONS we also have to satisfy. `*` is safe here
    // because the route still requires the gateway operator token, which the
    // browser's SOP prevents a third-party origin from minting.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Max-Age", "86400");
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }
    if (req.method !== "POST") {
      sendMethodNotAllowed(res);
      return;
    }
    await dispatchAuthenticatedAguiRequest(req, res, runtime, {
      id: OPERATOR_CALLER_ID,
      fromLabel: "ag-ui:operator",
    });
  };
}

// ---------------------------------------------------------------------------
// Post-authentication AG-UI dispatch (shared by pairing + operator routes)
// ---------------------------------------------------------------------------

const OPERATOR_CALLER_ID = "openclaw-operator";

interface AuthenticatedCaller {
  /** Stable id used for peer routing, session keying, and audit attribution. */
  id: string;
  /** Envelope "From" label (typically `ag-ui:<id>`). */
  fromLabel: string;
}

async function dispatchAuthenticatedAguiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: PluginRuntime,
  caller: AuthenticatedCaller,
): Promise<void> {
  // Parse body
  let body: unknown;
  try {
    body = await readJsonBody(req, 1024 * 1024);
  } catch (err) {
    sendJson(res, 400, {
      error: { message: String(err), type: "invalid_request_error" },
    });
    return;
  }

  // Validate the parsed shape before touching any field. `JSON.parse` accepts
  // `null`, numbers, arrays, etc.; reject anything that isn't a plain object
  // so a malformed payload returns 400 rather than throwing later (past the
  // point where response headers are already flushed) and hanging the stream.
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    sendJson(res, 400, {
      error: {
        message: "Request body must be a JSON object.",
        type: "invalid_request_error",
      },
    });
    return;
  }

  const input = body as RunAgentInput;
  // threadId/runId are client-controlled. Only accept a non-empty, reasonably
  // bounded string; otherwise generate one. (A non-string threadId would throw
  // on `.toLowerCase()` when composing the session key, after headers are
  // flushed — an unrecoverable hung request.)
  const threadId =
    typeof input.threadId === "string" && input.threadId.trim() && input.threadId.length <= 256
      ? input.threadId
      : `ag-ui-${randomUUID()}`;
  const runId =
    typeof input.runId === "string" && input.runId.trim()
      ? input.runId
      : `ag-ui-run-${randomUUID()}`;

  // Validate messages — keep only well-formed entries. A `[null]` element or
  // one without a string `role` would otherwise throw in the checks below.
  const messages: Message[] = (Array.isArray(input.messages) ? input.messages : []).filter(
    (m): m is Message =>
      Boolean(m) && typeof m === "object" && typeof (m as Message).role === "string",
  );

  const hasUserMessage = messages.some((m) => m.role === "user");
  const hasToolMessage = messages.some((m) => m.role === "tool");
  if (!hasUserMessage && !hasToolMessage) {
    // AG-UI protocol allows empty messages (used for session init/sync).
    // Return a valid empty run instead of 400.
    const accept =
      typeof req.headers.accept === "string" ? req.headers.accept : "text/event-stream";
    const encoder = new EventEncoder({ accept });
    res.statusCode = 200;
    res.setHeader("Content-Type", encoder.getContentType());
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    res.write(encoder.encode({ type: EventType.RUN_STARTED, threadId, runId }));
    res.write(encoder.encode({ type: EventType.RUN_FINISHED, threadId, runId }));
    res.end();
    return;
  }

  // Build body from messages
  const { body: messageBody } = buildBodyFromMessages(messages);

  // Format AG-UI context entries (if any) for injection into the agent prompt
  const contextSuffix =
    Array.isArray(input.context) && input.context.length > 0
      ? formatContextEntries(input.context as Array<{ description: string; value: string }>)
      : undefined;

  // Bidirectional shared state: the frontend declares its state-writer tools
  // via forwardedProps.stateWriterTools; we inject them into clientTools below
  // and intercept the calls into STATE_SNAPSHOTs. Inbound state is rendered
  // into the prompt so the model can read (and knows how to change) it.
  const { specs: stateWriterSpecs, schemas: stateWriterSchemas } = parseStateWriterTools(
    input.forwardedProps,
  );
  const stateWriterNames = [...stateWriterSpecs.keys()];
  const sharedStateSuffix = formatSharedState(input.state, stateWriterNames);
  // Run-scoped shared-state store, seeded from inbound state so snapshots
  // carry UI-set keys (e.g. preferences) alongside agent-written keys.
  const runSharedState: Record<string, unknown> = isSharedState(input.state)
    ? { ...(input.state as Record<string, unknown>) }
    : {};

  // Multimodal: pull image content blocks out of the messages so they can be
  // sent to the model (they are dropped from the text-only prompt). Requires
  // an image-capable model config (see gateway setup); otherwise the OpenClaw
  // provider ignores them.
  const promptImages = extractImagesFromMessages(messages);
  const hasImages = promptImages.length > 0;

  if (!messageBody.trim()) {
    sendJson(res, 400, {
      error: {
        message: "Could not extract a prompt from `messages`.",
        type: "invalid_request_error",
      },
    });
    return;
  }

  // Resolve agent route
  const cfg = runtime.config.current() as OpenClawConfig;
  const agentIdHeader =
    typeof req.headers["x-openclaw-agent-id"] === "string"
      ? req.headers["x-openclaw-agent-id"]
      : undefined;

  // Support custom session key via header for per-user isolation.
  // Treated as a trusted-proxy-only concern (see README "Session isolation"):
  // the value only *scopes* route.sessionKey — it never replaces it.
  const sessionKeyHeader =
    typeof req.headers["x-openclaw-session-key"] === "string"
      ? req.headers["x-openclaw-session-key"]
      : undefined;
  let userKey: string | undefined;
  if (sessionKeyHeader !== undefined) {
    const validated = validateSessionKeyHeader(sessionKeyHeader);
    if (!validated) {
      sendJson(res, 400, {
        error: {
          message: "Invalid X-OpenClaw-Session-Key header.",
          type: "invalid_request_error",
        },
      });
      return;
    }
    userKey = validated;
  }

  const route = runtime.channel.routing.resolveAgentRoute({
    cfg,
    channel: "ag-ui",
    peer: { kind: "direct", id: caller.id },
    accountId: agentIdHeader,
  });

  // Set up SSE via EventEncoder
  const accept = typeof req.headers.accept === "string" ? req.headers.accept : "text/event-stream";
  const encoder = new EventEncoder({ accept });
  res.statusCode = 200;
  res.setHeader("Content-Type", encoder.getContentType());
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  let closed = false;
  let currentMessageId = `msg-${randomUUID()}`;
  let messageStarted = false;
  const currentRunId = runId;
  // True once assistant text has been streamed token-by-token via
  // onPartialReply, so the block/final callbacks don't re-emit the same text.
  let streamedText = false;
  // Length of assistant text already streamed. OpenClaw's onPartialReply
  // delivers CUMULATIVE text snapshots (not deltas), so we track how much
  // we've forwarded and emit only the newly-appended suffix each time.
  let streamedTextLen = 0;

  // Reasoning & step reporting config (default on, opt-out via channel defaults)
  const channelDefaults = (cfg as Record<string, unknown>).channels as
    | Record<string, { defaults?: Record<string, unknown> }>
    | undefined;
  const aguiDefaults = channelDefaults?.["ag-ui"]?.defaults ?? {};
  const surfaceReasoning = aguiDefaults.surfaceReasoning !== false;

  // Reasoning state
  let reasoningMessageId: string | null = null;
  let reasoningStarted = false;
  // OpenClaw delivers CUMULATIVE reasoning snapshots (each callback carries the
  // full thinking text so far — see btw.ts `reasoningText += delta`). Track how
  // much we've already forwarded so we emit only the newly-appended suffix as a
  // REASONING_MESSAGE_CONTENT delta, exactly like the assistant-text path.
  // Without this the frontend stacks every snapshot into an exploding wall of
  // repeated text. Reset to 0 whenever a reasoning block closes.
  let streamedReasoningLen = 0;

  // Close any open reasoning block (called before RUN_FINISHED)
  const closeReasoningIfOpen = () => {
    if (reasoningStarted && reasoningMessageId) {
      writeEvent({
        type: EventType.REASONING_MESSAGE_END,
        messageId: reasoningMessageId,
      });
      writeEvent({
        type: EventType.REASONING_END,
        messageId: reasoningMessageId,
      });
      reasoningStarted = false;
      reasoningMessageId = null;
      streamedReasoningLen = 0;
    }
  };

  const writeEvent = (event: { type: EventType } & Record<string, unknown>) => {
    if (closed) {
      return;
    }
    try {
      res.write(encoder.encode(event as Parameters<typeof encoder.encode>[0]));
    } catch {
      // Client may have disconnected
      closed = true;
    }
  };

  // Handle client disconnect
  req.on("close", () => {
    closed = true;
  });

  // Emit RUN_STARTED
  writeEvent({
    type: EventType.RUN_STARTED,
    threadId,
    runId,
  });

  // Build inbound context using the plugin runtime (same pattern as msteams).
  // Compose session scopes under route.sessionKey — the :user: suffix (from
  // the validated header) and the :thread: suffix both subdivide the route
  // scope and never replace it.
  let sessionKey = route.sessionKey;
  if (userKey) {
    sessionKey += `:user:${userKey}`;
  }
  if (threadId) {
    sessionKey += `:thread:${threadId.toLowerCase()}`;
  }

  // STABLE per-conversation session id. OpenClaw derives the transcript file
  // from this id, so it IS the isolation boundary between conversations — a
  // stable id keeps every turn of one conversation in ONE transcript (giving
  // continuity/compaction for free), and DISTINCT sessionKeys must map to
  // DISTINCT ids. Hash the raw sessionKey rather than character-replacing it:
  // a lossy `[^a-zA-Z0-9_-] -> -` collapse let different keys (e.g. emails
  // "a.b@x" vs "a-b@x", or "chat.1" vs "chat-1") collide into one transcript
  // and cross-contaminate history. A sha256 hex digest is collision-free and
  // fixed-length (73 chars incl. prefix — safely under OpenClaw's 128-char
  // session-id limit regardless of how long sessionKey grows).
  const embeddedSessionId = `ag-ui-${createHash("sha256").update(sessionKey).digest("hex")}`;

  // Register the SSE writer ALWAYS so the before_tool_call / tool_result_persist
  // hooks can render SERVER-side (backend) tool calls as AG-UI events — even on
  // turns that ALSO carry frontend/client tools, shared state, or images (a
  // typical an AG-UI client page declares frontend tools on every turn, so gating
  // the writer on `!hasClientTools` meant any backend tool the model ran on
  // those turns rendered no card). To avoid a duplicate tool-call sequence,
  // the client/state-writer tool NAMES are marked below and the hooks skip
  // them — those are emitted by this handler's pendingToolCalls path instead.
  setWriter(sessionKey, writeEvent, currentMessageId);

  const abortController = new AbortController();
  req.on("close", () => {
    abortController.abort();
  });

  // Streaming + reasoning callbacks shared by both run paths: the channel
  // reply pipeline (tool-less turns) and runEmbeddedAgent (client-tool
  // turns). runEmbeddedAgent exposes the exact same callback surface, so the
  // AG-UI event mapping lives in one place.
  // No eager assistant-message-start hook. OpenClaw fires onAssistantMessageStart
  // at TURN START — before any reasoning streams — so opening the TEXT message
  // there would register it ahead of the reasoning message, and an AG-UI client
  // (which lays messages out in announce order) would render the reasoning panel
  // BELOW the answer. Instead the text message opens lazily on the first actual
  // text delta (handlePartialReply / sendBlockReply / emitFallbackText), which
  // arrives AFTER reasoning closes — so reasoning renders above the answer, as in
  // the reference integrations. An answer with no text emits no empty bubble.
  // OpenClaw emits CUMULATIVE partial-reply snapshots (no delta field). We
  // forward only the newly-appended suffix as a TEXT_MESSAGE_CONTENT delta;
  // `replace` (a rare full rewrite) resets the cursor.
  const handlePartialReply = (payload: { text?: string; delta?: string; replace?: true }) => {
    if (closed || wasClientToolCalled(sessionKey)) {
      return;
    }
    const full = typeof payload.text === "string" ? payload.text : "";
    let delta: string;
    if (typeof payload.delta === "string" && payload.delta) {
      delta = payload.delta;
      streamedTextLen += delta.length;
    } else if (payload.replace) {
      delta = full;
      streamedTextLen = full.length;
    } else if (full.length > streamedTextLen) {
      delta = full.slice(streamedTextLen);
      streamedTextLen = full.length;
    } else {
      return; // nothing new
    }
    if (!delta) {
      return;
    }
    closeReasoningIfOpen();
    if (!messageStarted) {
      messageStarted = true;
      writeEvent({
        type: EventType.TEXT_MESSAGE_START,
        messageId: currentMessageId,
        runId: currentRunId,
        role: "assistant",
      });
    }
    streamedText = true;
    writeEvent({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: currentMessageId,
      runId: currentRunId,
      delta,
    });
  };
  const handleReasoningStream = (payload: { text?: string; delta?: string }) => {
    if (closed) {
      return;
    }
    // OpenClaw sends cumulative reasoning snapshots (payload.text = the full
    // thinking so far). Forward only the newly-appended suffix as the delta —
    // the same treatment handlePartialReply gives assistant text — so the
    // frontend appends instead of stacking every growing snapshot.
    const full = typeof payload.text === "string" ? payload.text : "";
    let delta: string;
    if (typeof payload.delta === "string" && payload.delta) {
      delta = payload.delta;
      streamedReasoningLen += delta.length;
    } else if (full.length > streamedReasoningLen) {
      delta = full.slice(streamedReasoningLen);
      streamedReasoningLen = full.length;
    } else if (full && full.length < streamedReasoningLen) {
      // Snapshot shrank → a new reasoning block; reset and emit it whole.
      delta = full;
      streamedReasoningLen = full.length;
    } else {
      return; // nothing new
    }
    if (!delta) {
      return;
    }
    if (!reasoningStarted) {
      reasoningStarted = true;
      reasoningMessageId = `reason-${randomUUID()}`;
      writeEvent({
        type: EventType.REASONING_START,
        messageId: reasoningMessageId,
      });
      writeEvent({
        type: EventType.REASONING_MESSAGE_START,
        messageId: reasoningMessageId,
        role: "reasoning",
      });
    }
    writeEvent({
      type: EventType.REASONING_MESSAGE_CONTENT,
      messageId: reasoningMessageId,
      delta,
    });
  };
  const handleReasoningEnd = () => {
    if (closed || !reasoningStarted) {
      return;
    }
    writeEvent({
      type: EventType.REASONING_MESSAGE_END,
      messageId: reasoningMessageId,
    });
    writeEvent({
      type: EventType.REASONING_END,
      messageId: reasoningMessageId,
    });
    reasoningStarted = false;
    reasoningMessageId = null;
    streamedReasoningLen = 0;
  };

  // Shared-state write: the model called a declared state-writer tool. Apply
  // its args to the run-scoped state per the tool's spec (stateKey / arg /
  // replace|append) and emit a full STATE_SNAPSHOT. No browser round-trip —
  // the state panel is the feedback, so the caller suppresses the TOOL_CALL_*
  // card for these tools.
  const emitStateWriterSnapshot = (name: string, rawArgs: string | undefined) => {
    const spec = stateWriterSpecs.get(name);
    if (!spec) {
      return;
    }
    let args: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(rawArgs || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      // Malformed args — emit the current (unchanged) snapshot rather than throw.
    }
    applyStateWriter(runSharedState, spec, args);
    writeEvent({
      type: EventType.STATE_SNAPSHOT,
      snapshot: structuredClone(runSharedState),
    });
  };

  // The single run path for EVERY turn: OpenClaw's caller-provided
  // `clientTools` path via runEmbeddedAgent.
  //
  // Frontend tools cannot go through the channel reply pipeline at all — that
  // path only exposes plugin-registered tools gated by the static
  // `contracts.tools` manifest, so AG-UI's dynamically-named frontend tools
  // are always dropped. runEmbeddedAgent is the supported mechanism: the model
  // sees the frontend tools, calls one, and the run stops with
  // `pendingToolCalls` for the browser to execute. Turns WITHOUT frontend
  // tools (plain chat, backend-tool rendering) run through the same call with
  // an empty `clientTools`; their backend tools execute in-loop and render via
  // the before_tool_call / tool_result_persist hooks (writer registered
  // above). This unifies both on the embedded-agent engine and lets a stable
  // per-conversation session provide history — no full-history-in-prompt.
  const runViaEmbeddedAgent = async () => {
    const agentId = route.agentId;
    const workspaceDir = runtime.agent.resolveAgentWorkspaceDir(cfg, agentId);
    const agentDir = runtime.agent.resolveAgentDir(cfg, agentId);
    const timeoutMs = runtime.agent.resolveAgentTimeoutMs({ cfg });
    await runtime.agent.ensureAgentWorkspace({ dir: workspaceDir });

    // SQLite session model (OpenClaw 2026.7+): runEmbeddedAgent opens the
    // session transcript by sessionId and fails ("Cannot open SQLite session
    // without session entry") if no entry maps that id to our sessionKey. The
    // old file-backed model auto-created it. Create it on the FIRST turn of a
    // conversation; skip when it already exists so later turns keep their
    // transcript, sessionFile, and accumulated metadata. The check-then-create
    // is unlocked: AG-UI drives a conversation's turns sequentially, and
    // `embeddedSessionId` is a deterministic hash of `sessionKey`, so a racing
    // cold turn would at worst redundantly re-create the same entry.
    if (!getSessionEntry({ agentId, sessionKey })) {
      await upsertSessionEntry({
        agentId,
        sessionKey,
        entry: { sessionId: embeddedSessionId, updatedAt: Date.now() },
      });
    }

    const clientTools = (input.tools ?? []).map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description ?? "",
        parameters: (t.parameters ?? {}) as Record<string, unknown>,
      },
    }));

    // Inject the frontend-declared state-writer tools so the model can call
    // them; we intercept the calls (emitStateWriterSnapshot) rather than
    // round-tripping them, so the frontend needs only the declaration.
    for (const schema of stateWriterSchemas) {
      clientTools.push({
        type: "function" as const,
        function: {
          name: schema.function.name,
          description: schema.function.description,
          parameters: schema.function.parameters,
        },
      });
    }

    // Mark the client + state-writer tool names so the before_tool_call /
    // tool_result_persist hooks SKIP them (this handler emits them via the
    // pendingToolCalls path). Backend tools are not marked, so they render
    // through the hooks even on turns that also carry client tools.
    markClientToolNames(
      sessionKey,
      clientTools.map((t) => t.function.name),
    );

    const promptSuffix = [contextSuffix, sharedStateSuffix].filter(Boolean).join("");
    const { prompt: deltaPrompt, systemPrompt } = buildDeltaPrompt(messages);
    // Server-side continuation transcript. After we handle a state-writer
    // call ourselves (apply + STATE_SNAPSHOT), we re-run the model with a
    // synthetic result appended so it NARRATES a confirmation instead of
    // stopping silently — OpenClaw stops at a tool call rather than executing
    // our injected tool in-loop the way Hermes does. Bounded by MAX_TURNS;
    // real (browser) frontend tools end the run immediately.
    let continuation = "";
    // How much of `continuation` has already been submitted, so narration
    // re-runs send only the NEWLY-appended result — not the whole suffix +
    // accumulated continuation again (which the persistent session would
    // otherwise re-record on every turn, polluting the transcript).
    let continuationSentLen = 0;
    const MAX_TURNS = 6;

    const closeRun = () => {
      closeReasoningIfOpen();
      if (messageStarted) {
        writeEvent({
          type: EventType.TEXT_MESSAGE_END,
          messageId: currentMessageId,
          runId: currentRunId,
        });
      }
      writeEvent({ type: EventType.RUN_FINISHED, threadId, runId: currentRunId });
      closed = true;
      res.end();
    };

    // Nothing new to send: a re-sync/regenerate POST can carry history whose
    // tail is an assistant turn (delta empty) with no context/state/images.
    // The persistent session already holds everything, so submitting an empty
    // prompt would trigger a spurious duplicate run — finish the run cleanly
    // instead. (The earlier 400 guard checks the FULL history via
    // buildBodyFromMessages, which is non-empty here, so it doesn't catch it.)
    if (!deltaPrompt.trim() && !promptSuffix.trim() && !hasImages) {
      closeRun();
      return;
    }

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      // Fresh text/reasoning message lifecycle for this turn so a narration
      // turn streams as its own assistant message.
      messageStarted = false;
      currentMessageId = `msg-${randomUUID()}`;
      streamedText = false;
      streamedTextLen = 0;

      // Persistent session: prior turns live in the transcript. Turn 0 sends
      // the DELTA (new messages after the last assistant) + context/state
      // suffix. Later turns are state-writer narration re-runs that send ONLY
      // the newly-appended continuation (the suffix and earlier continuation
      // are already in the session).
      const prompt =
        turn === 0
          ? deltaPrompt + promptSuffix + continuation
          : continuation.slice(continuationSentLen);
      continuationSentLen = continuation.length;
      const result = await runtime.agent.runEmbeddedAgent({
        sessionId: embeddedSessionId,
        sessionKey,
        agentId,
        workspaceDir,
        agentDir,
        config: cfg,
        prompt,
        ...(systemPrompt ? { extraSystemPrompt: systemPrompt } : {}),
        ...(hasImages
          ? {
              images: promptImages,
              imageOrder: promptImages.map(() => "inline" as const),
            }
          : {}),
        clientTools,
        runId: currentRunId,
        timeoutMs,
        abortSignal: abortController.signal,
        messageChannel: "ag-ui",
        chatType: "direct",
        trigger: "user",
        onPartialReply: handlePartialReply,
        // Enable reasoning-summary STREAMING. runEmbeddedAgent defaults
        // reasoningLevel to "off" and does NOT inherit the agent's
        // `reasoningDefault: stream` config, so without this the provider
        // parses the model's reasoning summary but never streams it to
        // onReasoningStream — no REASONING_MESSAGE_* events reach the client.
        // The old channel reply pipeline set this via `streamReasoning: true`;
        // routing through runEmbeddedAgent dropped it (reasoning regression).
        ...(surfaceReasoning
          ? {
              reasoningLevel: "stream" as const,
              onReasoningStream: handleReasoningStream,
              onReasoningEnd: handleReasoningEnd,
            }
          : {}),
      });

      if (closed) {
        return;
      }

      const meta = result?.meta;
      const pending = meta?.pendingToolCalls ?? [];

      // If partial-reply streaming didn't fire (e.g. the model produced only a
      // tool call), surface any assistant text from the final payloads.
      const emitFallbackText = () => {
        if (streamedText) {
          return;
        }
        const text = (result?.payloads ?? [])
          .map((p) => (typeof p.text === "string" ? p.text : ""))
          .filter(Boolean)
          .join("\n\n")
          .trim();
        if (!text) {
          return;
        }
        if (!messageStarted) {
          messageStarted = true;
          writeEvent({
            type: EventType.TEXT_MESSAGE_START,
            messageId: currentMessageId,
            runId: currentRunId,
            role: "assistant",
          });
        }
        writeEvent({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: currentMessageId,
          runId: currentRunId,
          delta: text,
        });
      };

      if (meta?.stopReason === "tool_calls" && pending.length > 0) {
        const writerCalls = pending.filter((c) => stateWriterSpecs.has(c.name));
        const otherCalls = pending.filter((c) => !stateWriterSpecs.has(c.name));

        // Reference integrations (langgraph-python) render the frontend-tool
        // card BEFORE the assistant's closing text, because there the text is
        // produced by the follow-up run that consumes the tool result. Our text
        // arrives in the SAME run, so emitting it here would invert that order.
        // Text that already streamed live cannot be reordered (its START and
        // deltas are on the wire), so defer only the non-streamed fallback text
        // and flush it after the cards below.
        const deferTextUntilAfterCards = otherCalls.length > 0;
        if (!deferTextUntilAfterCards) {
          emitFallbackText();
        }
        closeReasoningIfOpen();
        if (messageStarted) {
          writeEvent({
            type: EventType.TEXT_MESSAGE_END,
            messageId: currentMessageId,
            runId: currentRunId,
          });
          messageStarted = false;
        }

        // State-writer calls: apply + emit STATE_SNAPSHOT. OpenClaw already
        // persisted the call (and its pending placeholder result) to the
        // session, so the narration re-run only needs the concrete result.
        for (const call of writerCalls) {
          emitStateWriterSnapshot(call.name, call.arguments);
          continuation += `\nTool ${call.name} returned: State updated.`;
        }

        // Real frontend tools must round-trip to the browser; emit them and
        // finish (we cannot continue the run server-side past a client tool).
        if (otherCalls.length > 0) {
          for (const call of otherCalls) {
            writeEvent({
              type: EventType.TOOL_CALL_START,
              toolCallId: call.id,
              toolCallName: call.name,
              parentMessageId: currentMessageId,
            });
            if (call.arguments) {
              writeEvent({
                type: EventType.TOOL_CALL_ARGS,
                toolCallId: call.id,
                delta: call.arguments,
              });
            }
            writeEvent({ type: EventType.TOOL_CALL_END, toolCallId: call.id });
          }
          // Closing text goes AFTER the cards so the transcript matches the
          // reference integrations: tool card, then the assistant's summary.
          if (deferTextUntilAfterCards) {
            // The cards above are parented to `currentMessageId`. AG-UI clients
            // group a tool call with its parent message and render that
            // message's text ABOVE its tool cards, so reusing the id here would
            // put the summary above the card no matter what order we emit in.
            // Announce the summary as a NEW message — the same shape the
            // reference integrations get from their separate follow-up run.
            currentMessageId = `msg-${randomUUID()}`;
            emitFallbackText();
            if (messageStarted) {
              writeEvent({
                type: EventType.TEXT_MESSAGE_END,
                messageId: currentMessageId,
                runId: currentRunId,
              });
              messageStarted = false;
            }
          }
          writeEvent({
            type: EventType.RUN_FINISHED,
            threadId,
            runId: currentRunId,
          });
          closed = true;
          res.end();
          return;
        }

        // Only state-writers were called → loop so the model narrates.
        if (writerCalls.length > 0) {
          continue;
        }

        // tool_calls but nothing matched (defensive) — finish.
        closeRun();
        return;
      }

      // No tool calls → the model produced its final text (an answer, or the
      // post-write narration). Emit any non-streamed fallback and finish.
      emitFallbackText();
      closeRun();
      return;
    }

    // Exhausted MAX_TURNS (model kept calling state-writers) — finish cleanly.
    closeRun();
  };

  // Dispatch the inbound message — this triggers the agent run.
  //
  // Option B: EVERY turn runs through `runEmbeddedAgent` (runViaEmbeddedAgent).
  // The former `dispatchReplyFromConfig` (channel reply pipeline / MsgContext)
  // branch is gone — the reply pipeline is itself a wrapper around
  // runEmbeddedAgent plus channel envelope/session machinery that this HTTP
  // AG-UI surface does not need. Backend (server-side) tools still render as
  // AG-UI cards: the writer is registered for tool-less turns (see setWriter
  // above), so the before_tool_call / tool_result_persist hooks emit their
  // TOOL_CALL_* events during the embedded run exactly as they did when the
  // reply pipeline drove the same run internally.
  try {
    await runViaEmbeddedAgent();

    // If the run didn't close the stream, close it now
    if (!closed) {
      closeReasoningIfOpen();
      if (messageStarted) {
        writeEvent({
          type: EventType.TEXT_MESSAGE_END,
          messageId: currentMessageId,
          runId: currentRunId,
        });
      }
      writeEvent({
        type: EventType.RUN_FINISHED,
        threadId,
        runId: currentRunId,
      });
      closed = true;
      res.end();
    }
  } catch (err) {
    if (!closed) {
      writeEvent({
        type: EventType.RUN_ERROR,
        message: String(err),
      });
      closed = true;
      res.end();
    }
  } finally {
    clearWriter(sessionKey);
    clearClientToolCalled(sessionKey);
    clearClientToolNames(sessionKey);
  }
}

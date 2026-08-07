import { randomUUID, createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { EventType } from "@ag-ui/core";
import type { RunAgentInput, Message } from "@ag-ui/core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { getSessionEntry, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { resolveAguiAgentRoute } from "./agent-route.js";
import {
  MAX_CLIENT_TOOL_SCHEMA_CHARS,
  findDeclaredToolConflicts,
  parseDeclaredTools,
} from "./client-tools.js";
import { applyCorsAndHandlePreflight } from "./cors.js";
import { authenticateAguiDevice } from "./device-auth.js";
import { observeDisconnect } from "./disconnect.js";
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
  isInstructionRole,
} from "./prompt-builder.js";
import {
  sendJson,
  sendMethodNotAllowed,
  readJsonBody,
  getBearerToken,
  validateSessionKeyHeader,
} from "./request-util.js";
import { beginSseResponse } from "./sse.js";
import {
  claimRun,
  endRun,
  markClientToolNames,
  markStateWriterNames,
  setRunWriter,
  wasClientToolCalled,
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
    if (applyCorsAndHandlePreflight(req, res)) {
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

    const auth = await authenticateAguiDevice({
      req,
      res,
      runtime,
      api,
      gatewaySecret,
      bearerToken: getBearerToken(req),
    });
    if (!auth.ok) {
      return;
    }
    const deviceId = auth.deviceId;

    // ---------------------------------------------------------------------------
    // Device approved - proceed with request
    // ---------------------------------------------------------------------------
    await dispatchAuthenticatedAguiRequest(req, res, runtime, {
      id: deviceId,
      fromLabel: `ag-ui:${deviceId}`,
      trusted: false,
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
 * Intended for TRUSTED SERVER-SIDE callers that already hold a gateway token and
 * should not need a second pairing flow — an AG-UI runtime proxy, a backend
 * integration, or same-origin operator UI. A cross-origin browser cannot use
 * this route directly: its CORS preflight is unauthenticated and core rejects it
 * before this handler runs (see the note in the handler body). Untrusted browser
 * clients belong on the pairing route `/v1/ag-ui`.
 */
export function createOperatorAguiHttpHandler(api: OpenClawPluginApi) {
  const runtime: PluginRuntime = api.runtime;

  return async function handleOperatorAguiRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    // Sets CORS headers on the POST. `*` is safe here because the route still
    // requires the gateway operator token, which the browser's SOP prevents a
    // third-party origin from minting.
    //
    // The preflight branch is NOT reachable on this route: it is registered
    // `auth: "gateway"`, and core rejects an unauthenticated OPTIONS before any
    // plugin handler runs (src/gateway/server/plugins-http.ts:189). A CORS
    // preflight never carries credentials, so it always 401s. That is why this
    // route is documented for trusted SERVER-SIDE callers (README
    // "Authentication"), which send no preflight — browser clients belong on
    // `/v1/ag-ui`, whose `auth: "plugin"` lets the preflight through, or behind
    // an AG-UI runtime proxy. Serving a cross-origin browser directly from this
    // route would need core to exempt OPTIONS from gateway auth; that is a core
    // security-surface change and is deliberately not attempted here.
    if (applyCorsAndHandlePreflight(req, res)) {
      return;
    }
    if (req.method !== "POST") {
      sendMethodNotAllowed(res);
      return;
    }
    await dispatchAuthenticatedAguiRequest(req, res, runtime, {
      id: OPERATOR_CALLER_ID,
      fromLabel: "ag-ui:operator",
      trusted: true,
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
  /**
   * Whether this caller is gateway-authenticated, and therefore trusted to
   * supply privileged request inputs. Exactly two things depend on it, and both
   * must move together — a paired device is an UNTRUSTED caller:
   *
   * - Choosing the agent with `X-OpenClaw-Agent-Id`. A paired device's agent is
   *   decided by its peer/channel binding; honouring the header would let a
   *   device bound to one agent run another agent's workspace, tools, and
   *   credentials, and the binding would describe nothing.
   * - Supplying `system`/`developer` messages, which become the run's
   *   `extraSystemPrompt`. Core appends that to the agent's assembled system
   *   prompt, so accepting it from an untrusted caller hands it authority over
   *   the agent's instructions.
   */
  trusted: boolean;
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

  const agentIdHeader =
    typeof req.headers["x-openclaw-agent-id"] === "string"
      ? req.headers["x-openclaw-agent-id"]
      : undefined;
  // Checked BEFORE the empty-messages early return below: an init/sync request
  // carrying this header must be refused too, or the rule holds on some request
  // paths and not others.
  //
  // Refuse rather than ignore: silently routing to the bound agent would answer
  // a request the caller believes targeted a different agent, and the mismatch
  // would never surface. Failing closed keeps the binding authoritative and
  // tells the caller its request was not honoured.
  if (agentIdHeader !== undefined && !caller.trusted) {
    sendJson(res, 400, {
      error: {
        message:
          "X-OpenClaw-Agent-Id is not accepted on this route. A paired device runs the agent its binding selects; use the operator route to choose an agent.",
        type: "invalid_request_error",
      },
    });
    return;
  }

  // `system`/`developer` messages become extraSystemPrompt, which core appends
  // to the agent's system prompt. That is instruction authority over the agent,
  // so an untrusted paired caller may not supply it. Refused rather than
  // dropped: silently discarding instructions would run the turn while ignoring
  // what the caller asked for, with no way to tell. Browser clients that need
  // to set instructions belong behind an AG-UI runtime proxy on the operator
  // route, which is the documented topology.
  if (!caller.trusted && messages.some((m) => isInstructionRole(m.role?.trim() ?? ""))) {
    sendJson(res, 400, {
      error: {
        message:
          "system/developer messages are not accepted on this route. A paired device cannot set the agent's instructions; use the operator route.",
        type: "invalid_request_error",
      },
    });
    return;
  }

  const { specs: stateWriterSpecs, schemas: stateWriterSchemas } = parseStateWriterTools(
    input.forwardedProps,
  );

  // the agent can call something it can never see.
  // Validate the SHAPE first, and keep the validated array — measuring a
  // coerced copy while the run later mapped over `input.tools` let a malformed
  // payload past this gate and blow up after admission, headers, and the
  // session upsert, turning a 400 into a committed SSE 200 + RUN_ERROR with a
  // session entry already written. Core enforces the same invariant at the
  // equivalent boundary (`extractClientToolsFromChatRequest` in
  // src/gateway/openai-http.ts), so this surface matches it.
  const declaredTools = parseDeclaredTools(input.tools);
  if (!declaredTools.ok) {
    sendJson(res, 400, {
      error: { message: declaredTools.message, type: "invalid_request_error" },
    });
    return;
  }
  // The set the model actually receives is the declared tools PLUS the
  // state-writer tools this handler injects. Core rejects a colliding set, but
  // only inside the run — after SSE is committed and the session may already be
  // upserted — so the caller would get a 200/RUN_ERROR instead of the
  // documented 400. Check the combined set here, while a JSON status is still
  // possible.
  const toolConflicts = findDeclaredToolConflicts(
    declaredTools.tools.map((t) => t.name),
    stateWriterSchemas.map((s) => s.function.name),
  );
  if (toolConflicts.length > 0) {
    sendJson(res, 400, {
      error: {
        message: `Conflicting tool names: ${toolConflicts.join(", ")}. Each declared tool needs a distinct name, and none may collide with a declared state-writer tool.`,
        type: "invalid_request_error",
      },
    });
    return;
  }

  const declaredToolsChars =
    JSON.stringify(declaredTools.tools).length + JSON.stringify(stateWriterSchemas).length;
  if (declaredToolsChars > MAX_CLIENT_TOOL_SCHEMA_CHARS) {
    sendJson(res, 400, {
      error: {
        message: `Declared tool schemas are too large (${declaredToolsChars} chars, limit ${MAX_CLIENT_TOOL_SCHEMA_CHARS}). Send fewer tools or shorter descriptions/parameter schemas.`,
        type: "invalid_request_error",
      },
    });
    return;
  }

  // Validated BEFORE the empty-messages early return: an init/sync request that
  // declares a bad tool set must be refused too, or the contract holds on turns
  // that run an agent and silently lapses on the ones that do not.

  const hasUserMessage = messages.some((m) => m.role === "user");
  const hasToolMessage = messages.some((m) => m.role === "tool");
  if (!hasUserMessage && !hasToolMessage) {
    // AG-UI protocol allows empty messages (used for session init/sync).
    // Return a valid empty run instead of 400.
    const encoder = beginSseResponse(res);
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
      ? formatContextEntries(input.context)
      : undefined;

  // Bidirectional shared state: the frontend declares its state-writer tools
  // via forwardedProps.stateWriterTools; we inject them into clientTools below
  // and intercept the calls into STATE_SNAPSHOTs. Inbound state is rendered
  // into the prompt so the model can read (and knows how to change) it.
  const stateWriterNames = [...stateWriterSpecs.keys()];
  const sharedStateSuffix = formatSharedState(input.state, stateWriterNames);
  // Run-scoped shared-state store, seeded from inbound state so snapshots
  // carry UI-set keys (e.g. preferences) alongside agent-written keys.
  const runSharedState: Record<string, unknown> = isSharedState(input.state)
    ? { ...(input.state as Record<string, unknown>) }
    : {};

  // An image with no caption is a normal multimodal turn, and
  // `buildBodyFromMessages` only extracts TEXT — so a text-empty body alone is
  // not an empty request. This guard asks "did the client send anything usable
  // at all?", which is why it scans the whole request rather than the delta;
  // what actually gets forwarded is still delta-scoped further down.
  // A tool message also counts: a frontend tool that succeeds with no output
  // sends `{ role: "tool", content: "" }`, which carries no text and no image
  // but IS the turn — rejecting it dead-ends the run right after the browser
  // did the work, so the agent never learns the call succeeded.
  if (!messageBody.trim() && !hasToolMessage && extractImagesFromMessages(messages).length === 0) {
    sendJson(res, 400, {
      error: {
        message: "Could not extract a prompt or image from `messages`.",
        type: "invalid_request_error",
      },
    });
    return;
  }

  // Tool schemas are browser-supplied and reach the model verbatim as tool
  // definitions, so they fall under the same hard cap as `context` and `state`
  // (root prompt-budget policy: every model-visible injected item is bounded).
  // Checked HERE, before the SSE headers are committed, so an oversized toolset
  // gets a clean 400 — silently dropping tools would leave the page believing
  // Resolve agent route
  const cfg = runtime.config.current() as OpenClawConfig;

  const routeResolution = resolveAguiAgentRoute({
    runtime,
    cfg,
    callerId: caller.id,
    agentIdHeader,
  });
  if (!routeResolution.ok) {
    sendJson(res, 400, {
      error: {
        message: `Unknown agent in X-OpenClaw-Agent-Id: ${JSON.stringify(routeResolution.unknownAgentId)}.`,
        type: "invalid_request_error",
      },
    });
    return;
  }
  const route = routeResolution.route;

  // Compose the session scope BEFORE committing any response headers. The
  // :user: suffix (from the validated header) and the :thread: suffix both
  // subdivide route.sessionKey and never replace it.
  let sessionKey = route.sessionKey;
  if (userKey) {
    sessionKey += `:user:${userKey}`;
  }
  if (threadId) {
    sessionKey += `:thread:${threadId.toLowerCase()}`;
  }

  // Identifies THIS request's run inside the shared per-session tool-stream
  // state. Two requests from the same device and thread share `sessionKey`, so
  // ownership — not the session key — decides who may write tool events.
  const runOwner = `${runId}:${randomUUID()}`;

  // Claim before any header is written: once SSE headers are flushed the
  // response is committed and `sendJson` (which calls setHeader) would throw
  // ERR_HTTP_HEADERS_SENT, leaving the client with a truncated 200 stream
  // instead of a retryable 409.
  if (!claimRun({ sessionKey, owner: runOwner })) {
    sendJson(res, 409, {
      error: {
        message:
          "A run is already in progress for this session. Retry once it completes, or use a distinct X-OpenClaw-Session-Key.",
        type: "conflict_error",
      },
    });
    return;
  }

  // Commit SSE headers. Must happen AFTER claimRun above: once headers are
  // flushed the response is committed and the 409 conflict path can no longer
  // call setHeader.
  const encoder = beginSseResponse(res);

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

  const abortController = new AbortController();

  // The run was claimed before headers were committed; wire its writer now that
  // the stream exists so the tool hooks can emit into THIS response.
  setRunWriter({ sessionKey, owner: runOwner, writer: writeEvent, messageId: currentMessageId });

  observeDisconnect({ req, res }, () => {
    closed = true;
    abortController.abort();
    // Deliberately does NOT endRun. Aborting only *requests* that the agent stop;
    // tool hooks can still fire while the run unwinds. Releasing ownership here
    // would let a second request for this session claim the run and install its
    // writer, and the hooks resolve the writer by sessionKey alone — so this
    // run's late TOOL_CALL_* events would be written into the new run's stream.
    // The run keeps the session until its `finally` releases it (ownership-checked),
    // which is reached on every path including abort.
  });

  // Emit RUN_STARTED
  writeEvent({
    type: EventType.RUN_STARTED,
    threadId,
    runId,
  });

  // Build inbound context using the plugin runtime (same pattern as msteams).
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

    // Uses the array validated before admission, never `input.tools` again —
    // re-reading the raw value is what let a malformed payload reach this line.
    const clientTools = declaredTools.tools.map((t) => ({
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
    // State writers are a subset of the above that WE execute, so they must not
    // be treated as "the browser took over" — see markStateWriterNames.
    markStateWriterNames(sessionKey, stateWriterNames);

    const promptSuffix = [contextSuffix, sharedStateSuffix].filter(Boolean).join("");
    const { prompt: deltaPrompt, systemPrompt, deltaMessages } = buildDeltaPrompt(messages);
    // Multimodal: pull image content blocks out of the messages so they can be
    // sent to the model (they are dropped from the text-only prompt). Requires
    // an image-capable model config (see gateway setup); otherwise the OpenClaw
    // provider ignores them.
    //
    // Scoped to `deltaMessages`, NOT the full history: AG-UI clients POST the
    // whole transcript every turn, so extracting from all of it would resend
    // turn 1's image with turn 2's text — the model would answer against a
    // stale image, the attachment would be duplicated in the persisted session,
    // and `hasImages` would stay true and keep empty resync runs alive below.
    const promptImages = extractImagesFromMessages(deltaMessages);
    const hasImages = promptImages.length > 0;
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
        // Trusted callers only — see AuthenticatedCaller.trusted.
        ...(systemPrompt && caller.trusted ? { extraSystemPrompt: systemPrompt } : {}),
        // Turn 0 only. Continuation turns re-run the SAME session to narrate a
        // state-writer result, so the images are already in the transcript;
        // resending them duplicates the attachments and re-bills the context on
        // every narration turn.
        ...(hasImages && turn === 0
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
  // AG-UI cards: this run claims the session's tool-stream state immediately
  // below, so the before_tool_call / tool_result_persist hooks emit their
  // TOOL_CALL_* events during the embedded run exactly as they did when the
  // reply pipeline drove the same run internally.
  //
  // The claim happens HERE rather than at request admission so the window in
  // which a writer is registered matches the window in which this run executes.
  // Registering earlier let a second same-session request take the session's
  // writer while the first run was still queued, sending the first run's tool
  // events into the second response.
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
    // Ownership-checked: a run that has already been displaced must not tear
    // down the state belonging to whoever holds the session now.
    endRun(sessionKey, runOwner);
  }
}

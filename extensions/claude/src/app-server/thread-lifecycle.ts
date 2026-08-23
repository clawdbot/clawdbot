/**
 * Thread lifecycle for the Claude app-server bridge.
 *
 * Mirrors extensions/codex/src/app-server/thread-lifecycle.ts at smaller
 * scope. Owns the decision tree for starting a fresh thread vs resuming an
 * existing thread, the binding-compatibility checks that drive rotation,
 * and the in-place resume patches the server can absorb without losing
 * the SDK transcript.
 *
 * Pulled out of run-attempt.ts so future fixes (thread/fork support,
 * server-side resume of dynamicTools/MCP catalog, additional rotation
 * reasons) land here instead of inflating the turn runner.
 *
 * Resume semantics summary:
 *
 *   Patchable on resume (no transcript loss; server applies via
 *   applyResumeOverrides in openclaw-claude/server/src/handlers/
 *   thread-resume.ts):
 *     - cwd                       (Tank #6)
 *     - approvalPolicy            (Tank #7 P2)
 *     - developerInstructions     (Tank #7 P2)
 *
 *   Catalog drift is now handled WITHOUT rotating where possible:
 *     - dynamicToolsFingerprint changed -> tryRefreshToolsInPlace() calls the
 *       bridge's thread/refresh_tools, which applies the new surface to the
 *       running session via the SDK's Query.setMcpServers. Rotation is only
 *       the fallback (no live attempt, or an older bridge without the RPC).
 *
 *   HISTORY, because the old note here sent us down two wrong paths: it
 *   said refreshing MCP registration "probably requires SDK support — the
 *   SDK's MCP registration isn't refreshable today". That was true when
 *   written and is now stale. @anthropic-ai/claude-agent-sdk 0.3.220 exposes
 *   setMcpServers on the live Query (sdk.d.ts:2550), which is mitigation (b)
 *   from that note and is what tryRefreshToolsInPlace uses. Mitigation (a),
 *   thread/fork, is implemented and remains the fallback.
 *   In practice catalog churn is rare for stable plugin sets.
 */

import {
  embeddedAgentLog,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { ClaudeAppServerClient } from "./client.js";
import { DEFAULT_CLAUDE_APP_SERVER_MODEL_PROVIDER } from "./config.js";
import type { ResolvedClaudeAppServerConfig } from "./config.js";
import type { ClaudeDynamicToolBridge } from "./dynamic-tools.js";
import { assertThreadStartResponse } from "./protocol-validators.js";
import {
  claudeBindingSessionIdentity,
  type ClaudeAppServerBinding,
  type ClaudeAppServerBindingStore,
  type ClaudeBindingSessionIdentity,
} from "./thread-store.js";
import type { ThreadStartParams } from "./types.js";
import { compareClaudeBridgeVersions, MIN_BRIDGE_VERSION_FOR_TOOL_REFRESH } from "./version.js";

const THREAD_NOT_FOUND_RE = /thread not found/i;

/**
 * Lifecycle RPCs (thread/start|resume|fork) are local bridge bookkeeping, not
 * model calls, and they run inside the per-session binding lock — a wedged
 * bridge must not hold that lock for the client's blanket 600s turn-request
 * timeout, so they get their own short deadline.
 */
const CLAUDE_THREAD_LIFECYCLE_RPC_TIMEOUT_MS = 60_000;

export type StartOrResumeClaudeThreadParams = {
  client: ClaudeAppServerClient;
  params: EmbeddedRunAttemptParams;
  cfg: ResolvedClaudeAppServerConfig;
  bridge: ClaudeDynamicToolBridge;
  bindingStore: ClaudeAppServerBindingStore;
  developerInstructions: string;
  developerInstructionsFingerprint: string;
  dynamicToolsFingerprint: string;
  effectiveWorkspace: string;
  /**
   * Native (claude_code preset) tools to block at thread/start, computed
   * from openclaw's tool-policy disableTools/toolsAllow upstream. Passed
   * in rather than computed here to keep this module pure-policy-vs-server
   * (the openclaw policy resolution lives in run-attempt.ts).
   */
  nativeDisallowedTools: readonly string[];
};

export type ThreadLifecycleOutcome = {
  threadId: string;
  /**
   * "resumed" if the thread existed and was patched in-place;
   * "forked"  if catalog drift triggered a thread/fork (transcript
   *           carried forward, new tools registered with the fresh
   *           SDK session);
   * "started" if a fresh thread/start was issued (first turn for the
   *           session, or fork fell back to start because the parent
   *           thread was gone server-side);
   * "refreshed" if the catalog changed but was applied to the LIVE session
   *           via setMcpServers, so no rotation happened at all — the
   *           preferred outcome for catalog drift.
   */
  outcome: "resumed" | "forked" | "started" | "refreshed";
  /**
   * True when this turn ran on a forked thread whose binding was deliberately
   * NOT persisted, so the durable session still points at the parent thread.
   * See isTransientToolPolicyTurn.
   */
  transient?: boolean;
  /**
   * Populated when outcome="forked" or outcome="started" with a binding
   * present (vs first-ever turn for this session).
   */
  rotationReason?: string;
  /**
   * Set when outcome="forked": the parent thread id the new thread was
   * forked from. Lets callers (transcript mirror, logging) tag
   * continuity-relevant context.
   */
  forkedFromThreadId?: string;
};

/**
 * Decide whether to resume or start a thread, then perform the chosen
 * server call. Caller does not need to know the binding internals.
 */
export async function startOrResumeClaudeThread(
  args: StartOrResumeClaudeThreadParams,
): Promise<ThreadLifecycleOutcome> {
  const identity = claudeBindingSessionIdentity(args.params);
  return await args.bindingStore.withLifecycleLock(identity, () =>
    startOrResumeClaudeThreadLocked(args, identity),
  );
}

async function startOrResumeClaudeThreadLocked(
  args: StartOrResumeClaudeThreadParams,
  identity: ClaudeBindingSessionIdentity,
): Promise<ThreadLifecycleOutcome> {
  const {
    client,
    params,
    cfg,
    bridge,
    bindingStore,
    developerInstructions,
    developerInstructionsFingerprint,
    dynamicToolsFingerprint,
    effectiveWorkspace,
    nativeDisallowedTools,
  } = args;
  const existing = await bindingStore.read(identity);

  const rotationReason = classifyRotationReason(existing, dynamicToolsFingerprint);

  if (existing && !rotationReason) {
    try {
      const threadId = await tryResumeWithPatch({
        client,
        existing,
        bindingStore,
        identity,
        cfg,
        effectiveWorkspace,
        developerInstructions,
        developerInstructionsFingerprint,
      });
      return { threadId, outcome: "resumed" };
    } catch (err) {
      if (!isThreadNotFound(err)) {
        throw err;
      }
      embeddedAgentLog.warn("claude-bridge: thread not found on resume; starting fresh", {
        sessionKey: identity.sessionKey,
        sessionId: identity.sessionId,
        threadId: existing.threadId,
      });
    }
  } else if (existing && rotationReason) {
    // Prefer refreshing the live session over rotating it. Only a catalog
    // change is refreshable this way, and only when a live attempt exists;
    // anything else still needs the fork path below.
    const refreshed = await tryRefreshToolsInPlace({
      client,
      threadId: existing.threadId,
      bridge,
      nativeDisallowedTools,
      identity,
    });
    if (refreshed) {
      // Record the new catalog against the SAME thread so the next turn sees
      // no drift. Without this the fingerprint would still look stale and we
      // would rotate on the very next turn, wasting the refresh.
      await bindingStore.write(identity, {
        threadId: existing.threadId,
        cwd: effectiveWorkspace,
        model: existing.model,
        modelProvider: existing.modelProvider,
        approvalPolicy: cfg.appServer.approvalPolicy,
        approvalsReviewer: existing.approvalsReviewer,
        sandbox: existing.sandbox,
        developerInstructionsFingerprint,
        dynamicToolsFingerprint,
        dynamicToolsCount: bridge.specs.length,
        createdAt: existing.createdAt,
      });
      return { threadId: existing.threadId, outcome: "refreshed", rotationReason };
    }
    embeddedAgentLog.info(
      isTransientToolPolicyTurn(params)
        ? "claude-bridge: forking a TRANSIENT thread for a narrowed tool policy (durable binding retained)"
        : "claude-bridge: rotating thread via thread/fork (transcript preserved, new SDK session)",
      {
        sessionKey: identity.sessionKey,
        sessionId: identity.sessionId,
        previousThreadId: existing.threadId,
        reason: rotationReason,
        ...(isTransientToolPolicyTurn(params) ? { trigger: params.trigger } : {}),
      },
    );
    const transient = isTransientToolPolicyTurn(params);
    try {
      const forkedThreadId = await forkThreadOnCatalogDrift({
        client,
        existing,
        params,
        cfg,
        bridge,
        bindingStore,
        identity,
        developerInstructions,
        developerInstructionsFingerprint,
        dynamicToolsFingerprint,
        effectiveWorkspace,
        nativeDisallowedTools,
        persistBinding: !transient,
      });
      return {
        threadId: forkedThreadId,
        outcome: "forked",
        rotationReason,
        forkedFromThreadId: existing.threadId,
        ...(transient ? { transient: true } : {}),
      };
    } catch (err) {
      if (!isThreadNotFound(err)) {
        throw err;
      }
      embeddedAgentLog.warn(
        "claude-bridge: thread/fork hit thread-not-found; falling back to fresh thread/start",
        {
          sessionKey: identity.sessionKey,
          sessionId: identity.sessionId,
          previousThreadId: existing.threadId,
        },
      );
    }
  }

  const threadId = await startFreshThread({
    client,
    params,
    cfg,
    bridge,
    bindingStore,
    identity,
    developerInstructions,
    developerInstructionsFingerprint,
    dynamicToolsFingerprint,
    effectiveWorkspace,
    nativeDisallowedTools,
  });
  return rotationReason
    ? { threadId, outcome: "started", rotationReason }
    : { threadId, outcome: "started" };
}

// ── decision: should we rotate? ─────────────────────────────────────────────

/**
 * Try to apply a changed tool catalog to the ALREADY-RUNNING session instead
 * of rotating the thread, via the bridge's `thread/refresh_tools` (which calls
 * the SDK's `Query.setMcpServers` on the live query).
 *
 * This is the cheap path and should be preferred whenever it works. Rotation
 * costs a full transcript copy, a new SDK session id (so a cold prompt cache)
 * and a respawned subprocess that strands anything the previous turn
 * backgrounded — and catalog changes are frequently POLICY rather than
 * configuration. The gateway's owner-only control-plane deny
 * (src/gateway/tool-resolution.ts:243) removes 13 tools whenever
 * senderIsOwner resolves false, which varies per turn, so the full price was
 * being paid over and over for a security input flipping.
 *
 * Returns true only when the bridge confirms the swap. `{ refreshed: false }`
 * means there is no live attempt (never started, swept, or discarded) — NOT
 * that the tools are already current — so the caller must rotate. Any RPC
 * error is treated the same way: fall back rather than proceed on the
 * assumption that a policy change took effect when it may not have.
 *
 * Gated on MIN_BRIDGE_VERSION_FOR_TOOL_REFRESH. A bridge below that floor
 * answers `{ refreshed: true }` and then wedges the session's MCP binding
 * (openclaw-d42b) — it cannot be detected from the response, so we must not ask
 * it in the first place. See the constant's doc comment for the mechanism.
 */
async function tryRefreshToolsInPlace(args: {
  client: ClaudeAppServerClient;
  threadId: string;
  bridge: ClaudeDynamicToolBridge;
  nativeDisallowedTools: readonly string[];
  identity: ClaudeBindingSessionIdentity;
}): Promise<boolean> {
  const { client, threadId, bridge, identity } = args;
  try {
    // Inside the try deliberately: this whole function is best-effort, and
    // rotation is always correct. A surprise here (an unexpected client shape,
    // a bridge that reported no version) must degrade to rotation, never fail
    // the turn.
    const bridgeVersion = client.getServerInfo()?.version;
    if (compareClaudeBridgeVersions(bridgeVersion, MIN_BRIDGE_VERSION_FOR_TOOL_REFRESH) < 0) {
      embeddedAgentLog.debug(
        "claude-bridge: bridge predates the thread/refresh_tools fix; rotating instead",
        {
          sessionKey: identity.sessionKey,
          threadId,
          bridgeVersion: bridgeVersion ?? "unknown",
          required: MIN_BRIDGE_VERSION_FOR_TOOL_REFRESH,
        },
      );
      return false;
    }
    const raw = await client.request<unknown>(
      "thread/refresh_tools",
      {
        threadId,
        // Shape only, no `instance` — matching the sdk-type server registration
        // turn-runner.ts builds. Correct because the bridge owns the instance
        // and splices its own back in when it recognises the server name as
        // one it owns.
        //
        // Do NOT "fix" this by trying to send an instance: there is nothing
        // sendable over JSON-RPC, and a bridge >= 0.7.6 rejects an sdk-type
        // server it does not own rather than forwarding it. It is the BRIDGE's
        // job to keep the live transport attached; before 0.7.6 it forwarded
        // this shape verbatim to Query.setMcpServers, which read the missing
        // `instance` as "no longer desired" and tore the transport down — see
        // MIN_BRIDGE_VERSION_FOR_TOOL_REFRESH.
        servers: { openclaw: { type: "sdk", name: "openclaw" } },
        dynamicTools: bridge.specs,
      },
      AbortSignal.timeout(CLAUDE_THREAD_LIFECYCLE_RPC_TIMEOUT_MS),
    );
    const refreshed =
      Boolean(raw) &&
      typeof raw === "object" &&
      (raw as { refreshed?: unknown }).refreshed === true;
    if (refreshed) {
      embeddedAgentLog.info(
        "claude-bridge: refreshed dynamic tools on the live session (no rotation)",
        {
          sessionKey: identity.sessionKey,
          sessionId: identity.sessionId,
          threadId,
          toolCount: bridge.specs.length,
        },
      );
    }
    return refreshed;
  } catch (err) {
    // An older bridge without the method, or any transport failure, lands
    // here. Rotation is always still correct, just expensive.
    embeddedAgentLog.debug("claude-bridge: thread/refresh_tools unavailable; will rotate", {
      sessionKey: identity.sessionKey,
      threadId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Whether this turn's tool catalog is a deliberate, temporary narrowing that
 * the NEXT turn will not inherit — so the durable thread binding must survive
 * it untouched.
 *
 * Today that means memory-flush runs. `trigger === "memory"` rebuilds the tool
 * list down to `read` plus an append-only `write` pinned to one file
 * (src/agents/agent-tools.ts:118, :857-872). That is a security restriction,
 * not a catalog malfunction, so the narrowed catalog MUST be the one actually
 * registered for the turn — it cannot be papered over.
 *
 * But the narrowing is also transient: the next ordinary turn gets the full
 * catalog back. Rotating the durable binding into and out of it costs two
 * transcript copies, two new SDK session ids (so a cold prompt cache twice)
 * and two subprocess teardowns, which is how a memory flush silently kills
 * whatever the previous turn backgrounded.
 *
 * Mirrors codex's `shouldStartTransientNoToolThread`
 * (extensions/codex/src/app-server/thread-fingerprints.ts:198). Codex only
 * covers a catalog that arrives empty; a memory-flush catalog arrives with two
 * tools, so the emptiness test alone would miss it.
 */
export function isTransientToolPolicyTurn(params: EmbeddedRunAttemptParams): boolean {
  return params.trigger === "memory";
}

function classifyRotationReason(
  existing: ClaudeAppServerBinding | null,
  dynamicToolsFingerprint: string,
): string | undefined {
  if (!existing) {
    return undefined;
  }
  if (
    existing.dynamicToolsFingerprint &&
    existing.dynamicToolsFingerprint !== dynamicToolsFingerprint
  ) {
    return "dynamic tool catalog changed (plugin set, allowlist, or sandbox shifted)";
  }
  return undefined;
}

// ── resume path: send patches, update binding ───────────────────────────────

async function tryResumeWithPatch(args: {
  client: ClaudeAppServerClient;
  existing: ClaudeAppServerBinding;
  bindingStore: ClaudeAppServerBindingStore;
  identity: ClaudeBindingSessionIdentity;
  cfg: ResolvedClaudeAppServerConfig;
  effectiveWorkspace: string;
  developerInstructions: string;
  developerInstructionsFingerprint: string;
}): Promise<string> {
  const {
    client,
    existing,
    bindingStore,
    identity,
    cfg,
    effectiveWorkspace,
    developerInstructions,
    developerInstructionsFingerprint,
  } = args;

  // Compute the patch set. Each field would have triggered a rotation
  // (with transcript loss) in the pre-Tank-#6/#7 code; the server's
  // applyResumeOverrides handler can absorb them in place.
  const cwdDiverged = existing.cwd !== effectiveWorkspace;
  const approvalPolicyDiverged = existing.approvalPolicy !== cfg.appServer.approvalPolicy;
  const developerInstructionsDiverged =
    existing.developerInstructionsFingerprint != null &&
    existing.developerInstructionsFingerprint !== developerInstructionsFingerprint;

  await client.request(
    "thread/resume",
    {
      threadId: existing.threadId,
      ...(cwdDiverged ? { cwd: effectiveWorkspace } : {}),
      ...(approvalPolicyDiverged ? { approvalPolicy: cfg.appServer.approvalPolicy } : {}),
      ...(developerInstructionsDiverged ? { developerInstructions } : {}),
    },
    AbortSignal.timeout(CLAUDE_THREAD_LIFECYCLE_RPC_TIMEOUT_MS),
  );

  // Persist the patched values so the next turn doesn't re-send the same
  // patches.
  if (cwdDiverged || approvalPolicyDiverged || developerInstructionsDiverged) {
    await bindingStore.write(identity, {
      threadId: existing.threadId,
      cwd: effectiveWorkspace,
      model: existing.model,
      modelProvider: existing.modelProvider,
      approvalPolicy: cfg.appServer.approvalPolicy,
      approvalsReviewer: existing.approvalsReviewer,
      sandbox: existing.sandbox,
      developerInstructionsFingerprint,
      dynamicToolsFingerprint: existing.dynamicToolsFingerprint,
      createdAt: existing.createdAt,
    });
  }
  return existing.threadId;
}

// ── fork path: thread/fork with new catalog, transcript carried forward ────

async function forkThreadOnCatalogDrift(args: {
  client: ClaudeAppServerClient;
  existing: ClaudeAppServerBinding;
  params: EmbeddedRunAttemptParams;
  cfg: ResolvedClaudeAppServerConfig;
  bridge: ClaudeDynamicToolBridge;
  bindingStore: ClaudeAppServerBindingStore;
  identity: ClaudeBindingSessionIdentity;
  developerInstructions: string;
  developerInstructionsFingerprint: string;
  dynamicToolsFingerprint: string;
  effectiveWorkspace: string;
  nativeDisallowedTools: readonly string[];
  /**
   * When false, fork the thread (so this turn gets the transcript AND the
   * correct narrowed catalog) but leave the binding pointing at the parent —
   * see isTransientToolPolicyTurn. The fork itself is what enforces the
   * narrowed policy; skipping the binding write is what keeps the durable
   * session, its warm prompt cache, and its live subprocess intact.
   */
  persistBinding: boolean;
}): Promise<string> {
  const {
    client,
    existing,
    params,
    cfg,
    bridge,
    bindingStore,
    identity,
    developerInstructions,
    developerInstructionsFingerprint,
    dynamicToolsFingerprint,
    effectiveWorkspace,
    nativeDisallowedTools,
    persistBinding,
  } = args;

  // Carry the CURRENT openclaw policy envelope into the fork — not just
  // the new dynamic-tool catalog. Without this the fork inherits the
  // parent's stale approvalPolicy/sandbox/disallowedTools and security
  // posture diverges from what the user's openclaw config currently
  // says. The server's thread/fork handler treats every field below
  // as an explicit override and only falls back to parent inheritance
  // when a field is omitted; we want zero parent inheritance for
  // execution-policy fields.
  // Always send disallowedTools as an explicit array, even when empty.
  // The server treats `omitted` as "inherit parent" but `[]` as "explicit
  // empty policy" — which is exactly what we want when openclaw policy
  // has been RELAXED (parent blocked Bash/Edit, current policy allows
  // them). Without the explicit empty array the fork would keep the
  // parent's stale block. The server's createThread doesn't persist
  // empty disallowedTools to meta.json (see thread-store.ts), so the
  // resulting thread meta is identical to a fresh start.
  const forkParams = {
    threadId: existing.threadId,
    cwd: effectiveWorkspace,
    model: params.modelId,
    modelProvider: cfg.appServer.modelProvider ?? DEFAULT_CLAUDE_APP_SERVER_MODEL_PROVIDER,
    approvalPolicy: cfg.appServer.approvalPolicy,
    sandbox: cfg.appServer.sandbox,
    baseInstructions: developerInstructions,
    dynamicTools: bridge.specs,
    dynamicToolsFingerprint,
    disallowedTools: [...nativeDisallowedTools],
  };
  const rawResponse = await client.request<unknown>(
    "thread/fork",
    forkParams,
    AbortSignal.timeout(CLAUDE_THREAD_LIFECYCLE_RPC_TIMEOUT_MS),
  );
  const response = assertThreadStartResponse(rawResponse);
  const newThreadId = response.thread.id;

  if (!persistBinding) {
    return newThreadId;
  }
  await bindingStore.write(identity, {
    threadId: newThreadId,
    cwd: effectiveWorkspace,
    model: params.modelId,
    modelProvider: cfg.appServer.modelProvider ?? DEFAULT_CLAUDE_APP_SERVER_MODEL_PROVIDER,
    approvalPolicy: cfg.appServer.approvalPolicy,
    approvalsReviewer: "user",
    sandbox: cfg.appServer.sandbox,
    developerInstructionsFingerprint,
    dynamicToolsFingerprint,
  });
  return newThreadId;
}

// ── start path: fresh thread/start + binding persistence ────────────────────

async function startFreshThread(args: {
  client: ClaudeAppServerClient;
  params: EmbeddedRunAttemptParams;
  cfg: ResolvedClaudeAppServerConfig;
  bridge: ClaudeDynamicToolBridge;
  bindingStore: ClaudeAppServerBindingStore;
  identity: ClaudeBindingSessionIdentity;
  developerInstructions: string;
  developerInstructionsFingerprint: string;
  dynamicToolsFingerprint: string;
  effectiveWorkspace: string;
  nativeDisallowedTools: readonly string[];
}): Promise<string> {
  const {
    client,
    params,
    cfg,
    bridge,
    bindingStore,
    identity,
    developerInstructions,
    developerInstructionsFingerprint,
    dynamicToolsFingerprint,
    effectiveWorkspace,
    nativeDisallowedTools,
  } = args;

  const startParams: ThreadStartParams = {
    // effectiveWorkspace, not raw workspaceDir, so when sandbox
    // workspaceAccess is read-only/copy-on-write the SDK's native
    // Read/Edit/Bash see the sandbox-isolated path. Mirrors codex's
    // effectiveWorkspace passthrough.
    cwd: effectiveWorkspace,
    model: params.modelId,
    modelProvider: cfg.appServer.modelProvider ?? DEFAULT_CLAUDE_APP_SERVER_MODEL_PROVIDER,
    approvalPolicy: cfg.appServer.approvalPolicy,
    approvalsReviewer: "user",
    sandbox: cfg.appServer.sandbox,
    dynamicTools: bridge.specs,
    developerInstructions,
    ...(nativeDisallowedTools.length > 0 ? { disallowedTools: [...nativeDisallowedTools] } : {}),
  };

  const rawResponse = await client.request<unknown>(
    "thread/start",
    startParams,
    AbortSignal.timeout(CLAUDE_THREAD_LIFECYCLE_RPC_TIMEOUT_MS),
  );
  const response = assertThreadStartResponse(rawResponse);
  const threadId = response.thread.id;

  await bindingStore.write(identity, {
    threadId,
    cwd: effectiveWorkspace,
    model: params.modelId,
    modelProvider: cfg.appServer.modelProvider ?? DEFAULT_CLAUDE_APP_SERVER_MODEL_PROVIDER,
    approvalPolicy: cfg.appServer.approvalPolicy,
    approvalsReviewer: "user",
    sandbox: cfg.appServer.sandbox,
    developerInstructionsFingerprint,
    dynamicToolsFingerprint,
  });
  return threadId;
}

// ── error classifiers ───────────────────────────────────────────────────────

export function isThreadNotFound(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const e = err as { message?: unknown; data?: unknown };
  if (typeof e.message === "string" && THREAD_NOT_FOUND_RE.test(e.message)) {
    return true;
  }
  if (e.data && typeof e.data === "object" && !Array.isArray(e.data)) {
    const m = (e.data as { message?: unknown }).message;
    if (typeof m === "string" && THREAD_NOT_FOUND_RE.test(m)) {
      return true;
    }
  }
  return false;
}

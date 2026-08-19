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
 *   Rotation reasons (force thread/start; SDK transcript resets):
 *     - dynamicToolsFingerprint changed
 *       (the SDK's MCP server registration happens at thread/start and
 *       isn't refreshable on resume — see KNOWN LIMITATION below)
 *
 *   KNOWN LIMITATION (carry forward to upstream PR notes): a
 *   tool-catalog change mid-session resets conversation history.
 *   Mitigations to consider:
 *     (a) Implement thread/fork on the server side and use it here
 *         instead of thread/start; fork copies the SDK transcript.
 *     (b) Teach the server to refresh sdkOptions.mcpServers on resume
 *         (probably requires SDK support — the SDK's MCP registration
 *         isn't refreshable today).
 *
 *   An earlier revision of this note said "in practice catalog churn is
 *   rare for stable plugin sets." That is true of *genuine* churn but it
 *   is not the whole story: the live binding store shows the catalog
 *   occasionally arriving as a tiny remnant of itself and returning intact
 *   moments later (78 tools -> 2 -> 78, seen 2026-08-12 and 2026-08-17).
 *   Rotating on those cost two transcript copies and two killed
 *   subprocesses for no change at all, so `isCollapsedToolCatalog` now
 *   declines to rotate on a collapse and resumes instead. Why the catalog
 *   collapses is still open (openclaw-enhz); this only stops it from
 *   destroying the session.
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
   *           thread was gone server-side).
   */
  outcome: "resumed" | "forked" | "started";
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

  const classifiedRotationReason = classifyRotationReason(existing, dynamicToolsFingerprint);

  // A rotation is expensive and destructive: thread/fork copies the whole
  // transcript, the new thread id IS the SDK session id (so the prompt cache
  // goes cold), and the respawned subprocess kills anything the previous turn
  // backgrounded. None of that is worth paying for a catalog that has
  // collapsed to a remnant and will be back next turn. Resume instead — the
  // tools registered at thread/start are still the real ones, and the binding
  // keeps describing the real catalog because the resume path preserves the
  // stored fingerprint rather than overwriting it with this turn's.
  const collapsed =
    existing !== null &&
    classifiedRotationReason !== undefined &&
    isCollapsedToolCatalog({
      boundCount: existing.dynamicToolsCount,
      nextCount: bridge.specs.length,
    });
  if (collapsed && existing) {
    embeddedAgentLog.warn(
      "claude-bridge: dynamic tool catalog collapsed; resuming instead of rotating (suspected transient)",
      {
        sessionKey: identity.sessionKey,
        sessionId: identity.sessionId,
        threadId: existing.threadId,
        boundToolCount: existing.dynamicToolsCount,
        incomingToolCount: bridge.specs.length,
      },
    );
  }
  const rotationReason = collapsed ? undefined : classifiedRotationReason;

  if (existing && !rotationReason) {
    try {
      const threadId = await tryResumeWithPatch({
        client,
        existing,
        bindingStore,
        boundCatalogSize: collapsed ? undefined : bridge.specs.length,
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
    embeddedAgentLog.info(
      "claude-bridge: rotating thread via thread/fork (transcript preserved, new SDK session)",
      {
        sessionKey: identity.sessionKey,
        sessionId: identity.sessionId,
        previousThreadId: existing.threadId,
        reason: rotationReason,
      },
    );
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
      });
      return {
        threadId: forkedThreadId,
        outcome: "forked",
        rotationReason,
        forkedFromThreadId: existing.threadId,
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
 * Fraction of the bound catalog below which an incoming catalog is treated as
 * a transient assembly failure rather than a real change.
 *
 * Twice observed in the live binding store (2026-08-12 22:07 and 2026-08-17
 * 20:26): a 78-tool surface arrived as 2 tools (`read`, `write`), rotated, and
 * came back byte-identical within a minute — two full transcript copies and
 * two dead subprocesses to end up exactly where we started. Across ~63k
 * threads in that store, only 14 ever carried 3 tools or fewer while normal
 * catalogs never sit below 33, so a quarter of the bound size is a wide
 * margin between "collapsed" and "legitimately smaller".
 */
const COLLAPSED_CATALOG_MAX_RATIO = 0.25;

/**
 * Whether an incoming dynamic tool catalog looks like a collapse (transient
 * assembly failure) rather than a genuine catalog change.
 *
 * Codex has the analogous guard at thread-fingerprints.ts
 * (`shouldStartTransientNoToolThread`) but only covers the literal-zero case;
 * the collapses we actually observe leave a small remnant, so zero alone
 * would not have caught either of them.
 */
export function isCollapsedToolCatalog(params: {
  boundCount: number | undefined;
  nextCount: number;
}): boolean {
  const { boundCount, nextCount } = params;
  // An empty catalog is always suspect when the bound thread had one.
  if (nextCount === 0) {
    return (boundCount ?? 0) > 0;
  }
  // Bindings predating `dynamicToolsCount` give us no baseline to compare
  // against, so the literal-zero case above is all we can judge.
  if (boundCount === undefined || boundCount <= 0) {
    return false;
  }
  return nextCount < boundCount * COLLAPSED_CATALOG_MAX_RATIO;
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
  /**
   * Size of THIS turn's catalog when it is known to represent the bound
   * catalog (fingerprints matched). `undefined` when the caller suppressed a
   * collapse — that turn's size is a remnant, not a baseline, and adopting it
   * would make the next real collapse look normal.
   */
  boundCatalogSize: number | undefined;
}): Promise<string> {
  const {
    client,
    existing,
    bindingStore,
    boundCatalogSize,
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
  // Bindings written before `dynamicToolsCount` existed carry no baseline, so
  // the collapse guard cannot judge them. Backfill on a turn whose fingerprint
  // MATCHES the binding — a match proves this catalog IS the bound catalog, so
  // its size is the true baseline. Without this the guard would only start
  // working after a session's first rotation, i.e. after the very event it is
  // meant to prevent.
  const needsToolCountBackfill =
    existing.dynamicToolsCount === undefined && boundCatalogSize !== undefined;
  if (
    cwdDiverged ||
    approvalPolicyDiverged ||
    developerInstructionsDiverged ||
    needsToolCountBackfill
  ) {
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
      // Carried through, not recomputed: this turn's catalog may be a
      // collapsed remnant we deliberately declined to rotate on, and
      // adopting its size as the new baseline would make the next real
      // collapse look normal by comparison.
      dynamicToolsCount: existing.dynamicToolsCount ?? boundCatalogSize,
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
    dynamicToolsCount: bridge.specs.length,
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
    dynamicToolsCount: bridge.specs.length,
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

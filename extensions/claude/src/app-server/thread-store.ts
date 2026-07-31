/**
 * Per-session binding for Claude threads. Mirrors codex's session-binding
 * pattern: each OpenClaw session records the corresponding claude-bridge
 * thread_id so the next turn resumes via thread/resume instead of starting
 * a fresh thread.
 *
 * Storage: SQLite plugin state (runtime.state.openSyncKeyedStore), keyed by
 * the stable host session key. The old `<sessionFile>.claude-binding.json`
 * sidecar files are gone — post-SQLite-migration `sessionFile` is a routing
 * token, not a path, so sidecars landed in the gateway CWD and the file lock
 * they required self-deadlocked under fs-safe 0.5 (non-reentrant locks).
 */

import { createHash } from "node:crypto";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { enqueueKeyedTask } from "openclaw/plugin-sdk/keyed-async-queue";
import type {
  OpenKeyedStoreOptions,
  PluginStateSyncKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import type { ApprovalPolicy, SandboxPolicy } from "./types.js";

const SCHEMA_VERSION = 1;
export const CLAUDE_APP_SERVER_BINDING_NAMESPACE = "app-server-thread-bindings";
export const CLAUDE_APP_SERVER_BINDING_MAX_ENTRIES = 50_000;

export type ClaudeAppServerBinding = {
  schemaVersion: number;
  threadId: string;
  cwd: string;
  model?: string;
  modelProvider?: string;
  approvalPolicy?: ApprovalPolicy;
  approvalsReviewer?: "user" | "auto_review";
  sandbox?: SandboxPolicy;
  dynamicToolsFingerprint?: string;
  /**
   * Hash of the developerInstructions sent at thread/start. Used to detect
   * SOUL.md / workspace-file changes mid-session — if the current hash
   * differs from the binding's stored value, we rotate to a fresh thread
   * so the new persona reaches the model. Codex uses the same pattern via
   * its context-engine binding fingerprint.
   */
  developerInstructionsFingerprint?: string;
  /** Epoch milliseconds (Date.now()). Rendered by `/claude threads`. */
  createdAt: number;
  /** Epoch milliseconds (Date.now()). Rendered by `/claude threads`. */
  updatedAt: number;
  /**
   * Turn-completion summary, recorded by the store's recordTurnSummary
   * after each turn finishes — separately from the pre-turn fields above,
   * which thread-lifecycle.ts writes before a turn runs. Absent for bindings
   * written before this field existed, or if a turn is still in flight.
   */
  /** The real turn outcome (openclaw-0ld C3): "stop" | "toolUse" | "aborted" | "error", etc. */
  lastTurnStopReason?: string;
  lastTurnUsage?: { input: number; output: number; total: number };
  /** Truncated final assistant reply text, for a quick "what was this about" glance. */
  lastAssistantPreview?: string;
  /** Count of completed turns recorded against this thread binding. */
  turnCount?: number;
  /**
   * LIFO back-stack of thread ids this session was bound to before an
   * explicit `/claude resume` switched away from them (most-recently-left
   * thread at the end). `/claude thread-pop` pops one entry and rebinds to
   * it, so switching to a different conversation is never a one-way trip —
   * capped at {@link THREAD_STACK_MAX} entries (oldest dropped first).
   */
  threadStack?: string[];
};

/** Cap on threadStack length so repeated /claude resume calls can't grow the binding unbounded. */
export const THREAD_STACK_MAX = 20;

/**
 * Identity of the OpenClaw session a binding belongs to. The stable session
 * key is the store key (one conversation, one binding); the ephemeral session
 * id stamps writes so a stale binding can't leak across `/new` if the harness
 * reset hook did not fire (crash between reset and the next turn).
 */
export type ClaudeBindingSessionIdentity = {
  /** Stable host session key, e.g. `agent:tank:direct:eddie`. */
  sessionKey?: string;
  /** Ephemeral OpenClaw session id for the current session generation. */
  sessionId?: string;
};

/** Stored value: the binding plus the session generation that wrote it. */
export type StoredClaudeAppServerBinding = ClaudeAppServerBinding & {
  sessionId?: string;
};

export type ClaudeThreadTurnSummary = {
  stopReason?: string;
  usage?: { input: number; output: number; total: number };
  assistantPreview?: string;
};

export type ClaudeAppServerBindingStore = {
  read(identity: ClaudeBindingSessionIdentity): Promise<ClaudeAppServerBinding | null>;
  write(
    identity: ClaudeBindingSessionIdentity,
    binding: Omit<ClaudeAppServerBinding, "schemaVersion" | "createdAt" | "updatedAt"> & {
      createdAt?: number;
    },
  ): Promise<void>;
  clear(identity: ClaudeBindingSessionIdentity): Promise<void>;
  recordTurnSummary(
    identity: ClaudeBindingSessionIdentity,
    summary: ClaudeThreadTurnSummary,
  ): Promise<void>;
  /**
   * Serializes read/classify/resume-or-fork-or-start/write for one session so
   * concurrent turns can't overwrite a sibling's patched binding state.
   * In-process only — the gateway is the sole writer of this plugin's state.
   */
  withLifecycleLock<T>(identity: ClaudeBindingSessionIdentity, run: () => Promise<T>): Promise<T>;
};

/** Binding identity from any params shape carrying the session identity pair. */
export function claudeBindingSessionIdentity(params: {
  sessionId?: string;
  sessionKey?: string;
}): ClaudeBindingSessionIdentity {
  return {
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
  };
}

export function claudeBindingStoreKey(identity: ClaudeBindingSessionIdentity): string {
  const sessionKey = identity.sessionKey?.trim();
  if (sessionKey) {
    // Digested, mirroring codex bindingStoreKey: session keys are unbounded
    // (plugin-state caps keys at 512 bytes) and can embed channel/sender
    // handles that should not sit cleartext in the shared state table.
    const digest = createHash("sha256").update(sessionKey).digest("base64url");
    return `session-key:${digest}`;
  }
  const sessionId = identity.sessionId?.trim();
  if (sessionId) {
    return `session-id:${sessionId}`;
  }
  throw new Error("Claude thread binding requires a session key or session id");
}

const ASSISTANT_PREVIEW_MAX_CHARS = 200;

/** Coerces bridge-reported usage into finite numbers; drops the field when unusable. */
function sanitizeTurnUsage(
  usage: ClaudeThreadTurnSummary["usage"],
): ClaudeThreadTurnSummary["usage"] {
  if (!usage) {
    return undefined;
  }
  const input = Number.isFinite(usage.input) ? usage.input : 0;
  const output = Number.isFinite(usage.output) ? usage.output : 0;
  const total = Number.isFinite(usage.total) ? usage.total : input + output;
  return { input, output, total };
}

export function createClaudeAppServerBindingStore(
  state: Pick<
    PluginStateSyncKeyedStore<StoredClaudeAppServerBinding>,
    "lookup" | "update" | "delete"
  >,
): ClaudeAppServerBindingStore {
  const updateEntry = state.update?.bind(state);
  const deleteEntry = state.delete?.bind(state);
  if (!updateEntry || !deleteEntry) {
    throw new Error("Claude thread bindings require atomic plugin-state updates");
  }
  const lifecycleTails = new Map<string, Promise<void>>();

  const asCurrentBinding = (
    stored: StoredClaudeAppServerBinding | undefined,
    identity: ClaudeBindingSessionIdentity,
  ): ClaudeAppServerBinding | null => {
    if (!stored) {
      return null;
    }
    if (stored.schemaVersion !== SCHEMA_VERSION || typeof stored.threadId !== "string") {
      embeddedAgentLog.warn("claude-bridge: binding schema mismatch, ignoring", {
        sessionKey: identity.sessionKey,
        got: stored.schemaVersion,
      });
      return null;
    }
    // Session-generation guard: a binding stamped by a different session id
    // belongs to a pre-`/new` generation whose reset hook never ran. Treating
    // it as absent rotates to a fresh thread instead of silently resuming
    // the retired conversation's context.
    if (stored.sessionId && identity.sessionId && stored.sessionId !== identity.sessionId) {
      return null;
    }
    return stored;
  };

  const stamp = (
    identity: ClaudeBindingSessionIdentity,
    binding: ClaudeAppServerBinding,
  ): StoredClaudeAppServerBinding => ({
    ...binding,
    ...(identity.sessionId ? { sessionId: identity.sessionId } : {}),
  });

  /** Atomic read-modify-write; returning undefined from the mutation is a no-op. */
  const mutate = (
    identity: ClaudeBindingSessionIdentity,
    mutation: (existing: ClaudeAppServerBinding | null) => ClaudeAppServerBinding | undefined,
  ): void => {
    updateEntry(claudeBindingStoreKey(identity), (existing) => {
      const next = mutation(asCurrentBinding(existing, identity));
      return next === undefined ? undefined : stamp(identity, next);
    });
  };

  return {
    async read(identity) {
      try {
        return asCurrentBinding(state.lookup(claudeBindingStoreKey(identity)), identity);
      } catch (err) {
        // A corrupt row must degrade to "no binding" (fresh thread next turn,
        // write self-heals the row) instead of failing every turn — the same
        // recovery the old sidecar reader had for unreadable JSON.
        embeddedAgentLog.warn("claude-bridge: failed to read binding, ignoring", {
          sessionKey: identity.sessionKey,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    },

    async write(identity, binding) {
      const now = Date.now();
      // Full replacement: a fresh thread/start or fork is a NEW thread, so
      // createdAt resets to now unless the caller is read-modify-writing an
      // existing binding and passes its original createdAt through.
      updateEntry(claudeBindingStoreKey(identity), () =>
        stamp(identity, {
          ...binding,
          schemaVersion: SCHEMA_VERSION,
          createdAt: binding.createdAt ?? now,
          updatedAt: now,
        }),
      );
    },

    async clear(identity) {
      deleteEntry(claudeBindingStoreKey(identity));
    },

    async recordTurnSummary(identity, summary) {
      const trimmedPreview = summary.assistantPreview?.trim();
      // Bridge usage numbers are untrusted at this boundary: NaN/Infinity
      // (e.g. a missing addend upstream) fails plugin-state JSON
      // serialization and would void the WHOLE summary write, not just the
      // usage field (seen live: "value.lastTurnUsage.total must be
      // JSON-serializable" on every turn).
      const usage = sanitizeTurnUsage(summary.usage);
      mutate(identity, (existing) => {
        // No-op if no binding exists yet (e.g. the write raced ahead of
        // thread-lifecycle's initial write, or the binding was cleared
        // mid-turn) — the next turn's lifecycle write recreates it anyway.
        if (!existing) {
          return undefined;
        }
        const preview = trimmedPreview
          ? trimmedPreview.length > ASSISTANT_PREVIEW_MAX_CHARS
            ? `${trimmedPreview.slice(0, ASSISTANT_PREVIEW_MAX_CHARS)}…`
            : trimmedPreview
          : existing.lastAssistantPreview;
        return {
          ...existing,
          lastTurnStopReason: summary.stopReason ?? existing.lastTurnStopReason,
          lastTurnUsage: usage ?? existing.lastTurnUsage,
          lastAssistantPreview: preview,
          turnCount: (existing.turnCount ?? 0) + 1,
          updatedAt: Date.now(),
        };
      });
    },

    withLifecycleLock: (identity, run) =>
      enqueueKeyedTask({ tails: lifecycleTails, key: claudeBindingStoreKey(identity), task: run }),
  };
}

export type ClaudeBindingRuntime = {
  state: {
    openSyncKeyedStore: <T>(options: OpenKeyedStoreOptions) => PluginStateSyncKeyedStore<T>;
  };
};

/** Opens the plugin-scoped SQLite-backed binding store off the injected plugin runtime. */
export function openClaudeAppServerBindingStore(
  runtime: ClaudeBindingRuntime,
): ClaudeAppServerBindingStore {
  return createClaudeAppServerBindingStore(
    runtime.state.openSyncKeyedStore<StoredClaudeAppServerBinding>({
      namespace: CLAUDE_APP_SERVER_BINDING_NAMESPACE,
      maxEntries: CLAUDE_APP_SERVER_BINDING_MAX_ENTRIES,
      // Deliberately NOT codex's "reject-new": at the cap, dropping the
      // oldest conversation's binding (it just starts a fresh thread) beats
      // silently refusing to persist bindings for active new conversations.
      overflowPolicy: "evict-oldest",
    }),
  );
}

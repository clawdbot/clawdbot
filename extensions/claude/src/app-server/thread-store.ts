/**
 * Per-session-file binding for Claude threads. Mirrors codex's
 * session-binding pattern: each OpenClaw session has a sidecar JSON file
 * recording the corresponding claude-bridge thread_id so the next turn
 * resumes via thread/resume instead of starting a fresh thread.
 *
 * Sidecar path: <sessionFile>.claude-binding.json
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { promises as fs } from "node:fs";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { type FileLockOptions, withFileLock } from "openclaw/plugin-sdk/file-lock";
import type { ApprovalPolicy, SandboxPolicy } from "./types.js";

const SCHEMA_VERSION = 1;
const CLAUDE_APP_SERVER_BINDING_GUARDED_REQUEST_TIMEOUT_MS = 60_000;
const CLAUDE_APP_SERVER_BINDING_LOCK_RETRY_INTERVAL_MS = 1_000;
const CLAUDE_APP_SERVER_BINDING_LOCK_MIN_WAIT_MS =
  CLAUDE_APP_SERVER_BINDING_GUARDED_REQUEST_TIMEOUT_MS + 15_000;
const CLAUDE_APP_SERVER_BINDING_LOCK_OPTIONS: FileLockOptions = {
  retries: {
    retries: Math.ceil(
      CLAUDE_APP_SERVER_BINDING_LOCK_MIN_WAIT_MS / CLAUDE_APP_SERVER_BINDING_LOCK_RETRY_INTERVAL_MS,
    ),
    factor: 1,
    minTimeout: CLAUDE_APP_SERVER_BINDING_LOCK_RETRY_INTERVAL_MS,
    maxTimeout: CLAUDE_APP_SERVER_BINDING_LOCK_RETRY_INTERVAL_MS,
  },
  stale: CLAUDE_APP_SERVER_BINDING_GUARDED_REQUEST_TIMEOUT_MS * 2,
};
const bindingMutationQueues = new Map<string, Promise<void>>();
const bindingMutationContext = new AsyncLocalStorage<Set<string>>();

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
   * Turn-completion summary, recorded by {@link recordClaudeThreadTurnSummary}
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

/** Cap on threadStack length so repeated /claude resume calls can't grow the sidecar unbounded. */
export const THREAD_STACK_MAX = 20;

export function resolveClaudeAppServerBindingPath(sessionFile: string): string {
  return `${sessionFile}.claude-binding.json`;
}

/** Serializes compare-and-mutate operations for one Claude binding sidecar. */
export async function withClaudeAppServerBindingLock<T>(
  sessionFile: string,
  run: () => Promise<T>,
): Promise<T> {
  const bindingPath = resolveClaudeAppServerBindingPath(sessionFile);
  const ownedBindings = bindingMutationContext.getStore();
  if (ownedBindings?.has(bindingPath)) {
    // This call chain already holds the queue slot and the file lock below.
    // fs-safe locks are non-reentrant without an owner key, so re-acquiring
    // here self-deadlocks into file_lock_timeout and fails the turn.
    return await run();
  }

  const previous = bindingMutationQueues.get(bindingPath) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const queued = previous.then(
    () => current,
    () => current,
  );
  bindingMutationQueues.set(bindingPath, queued);
  await previous.catch(() => undefined);

  const nestedOwnedBindings = new Set(ownedBindings);
  nestedOwnedBindings.add(bindingPath);
  try {
    return await bindingMutationContext.run(nestedOwnedBindings, () =>
      withFileLock(bindingPath, CLAUDE_APP_SERVER_BINDING_LOCK_OPTIONS, run),
    );
  } finally {
    releaseCurrent();
    if (bindingMutationQueues.get(bindingPath) === queued) {
      bindingMutationQueues.delete(bindingPath);
    }
  }
}

export async function readClaudeAppServerBinding(
  sessionFile: string,
): Promise<ClaudeAppServerBinding | null> {
  try {
    const raw = await fs.readFile(resolveClaudeAppServerBindingPath(sessionFile), "utf8");
    const parsed = JSON.parse(raw) as ClaudeAppServerBinding;
    if (parsed.schemaVersion !== SCHEMA_VERSION || typeof parsed.threadId !== "string") {
      embeddedAgentLog.warn("claude-bridge: binding schema mismatch, ignoring", {
        sessionFile,
        got: parsed.schemaVersion,
      });
      return null;
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    embeddedAgentLog.warn("claude-bridge: failed to read binding", {
      sessionFile,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export async function writeClaudeAppServerBinding(
  sessionFile: string,
  binding: Omit<ClaudeAppServerBinding, "schemaVersion" | "createdAt" | "updatedAt"> & {
    createdAt?: number;
  },
): Promise<void> {
  await withClaudeAppServerBindingLock(sessionFile, async () => {
    // Epoch milliseconds — the unit `formatBinding` renders via
    // `new Date(b.updatedAt).toISOString()` and the unit `handleResume`
    // already writes (`Date.now()`). Storing seconds here made `/claude
    // threads` render "Updated" as a 1970 date and split the same field into
    // two units depending on whether the binding was last touched by a normal
    // turn (seconds) or by `/claude resume` (ms) — openclaw-0ld C1.
    const now = Date.now();
    // schemaVersion/createdAt/updatedAt MUST be spread onto AFTER `...binding`,
    // not before — callers that read-modify-write via `{...existing, ...}`
    // (e.g. recordClaudeThreadTurnSummary, handleResume) pass an object that
    // already carries the OLD schemaVersion/createdAt/updatedAt from the
    // existing binding. Spreading `...binding` last would let those stale
    // values silently win over the freshly computed `now`, so every
    // subsequent write kept re-persisting the original creation timestamp
    // as "updated" — this is exactly what caused `/claude threads` and
    // `/claude conversations` to render a frozen "Updated" time.
    const data: ClaudeAppServerBinding = {
      ...binding,
      schemaVersion: SCHEMA_VERSION,
      createdAt: binding.createdAt ?? now,
      updatedAt: now,
    };
    const target = resolveClaudeAppServerBindingPath(sessionFile);
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    try {
      await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
      await fs.rename(tmp, target);
    } catch (err) {
      await fs.unlink(tmp).catch(() => undefined);
      embeddedAgentLog.warn("claude-bridge: failed to persist binding", {
        sessionFile,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  });
}

const ASSISTANT_PREVIEW_MAX_CHARS = 200;

/**
 * Attaches a turn-completion summary (real stop reason, usage, a truncated
 * preview of the final reply) to the existing binding, so `/claude threads`
 * can say more than just "here's the thread id" — read-modify-write onto
 * whatever thread-lifecycle.ts already wrote for this turn, matching the
 * same pattern `/claude resume` already uses (command-handlers.ts) rather
 * than nesting a second binding-lock acquisition inside this one.
 *
 * No-ops if no binding exists yet (e.g. the write raced ahead of
 * thread-lifecycle's initial write, or the binding was cleared mid-turn) —
 * the next turn's thread-lifecycle write recreates the binding regardless.
 */
export async function recordClaudeThreadTurnSummary(
  sessionFile: string,
  summary: {
    stopReason?: string;
    usage?: { input: number; output: number; total: number };
    assistantPreview?: string;
  },
): Promise<void> {
  const existing = await readClaudeAppServerBinding(sessionFile);
  if (!existing) {
    return;
  }
  const trimmedPreview = summary.assistantPreview?.trim();
  const preview = trimmedPreview
    ? trimmedPreview.length > ASSISTANT_PREVIEW_MAX_CHARS
      ? `${trimmedPreview.slice(0, ASSISTANT_PREVIEW_MAX_CHARS)}…`
      : trimmedPreview
    : existing.lastAssistantPreview;
  await writeClaudeAppServerBinding(sessionFile, {
    ...existing,
    lastTurnStopReason: summary.stopReason ?? existing.lastTurnStopReason,
    lastTurnUsage: summary.usage ?? existing.lastTurnUsage,
    lastAssistantPreview: preview,
    turnCount: (existing.turnCount ?? 0) + 1,
  });
}

export async function clearClaudeAppServerBinding(sessionFile: string): Promise<void> {
  await withClaudeAppServerBindingLock(sessionFile, async () => {
    try {
      await fs.unlink(resolveClaudeAppServerBindingPath(sessionFile));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        embeddedAgentLog.warn("claude-bridge: failed to clear binding", {
          sessionFile,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  });
}

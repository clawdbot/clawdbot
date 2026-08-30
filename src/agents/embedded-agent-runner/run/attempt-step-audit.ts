/**
 * Step-audit checkpoint support for review-style plugins.
 *
 * `before_agent_finalize` audits the run only after it finishes, which is too
 * late for review plugins that want each tool/text step verified before the
 * run moves on. This module gives such plugins a per-run checkpoint API:
 *
 * - `capture(stepSeq)` records the current transcript tail as the rollback
 *   checkpoint for one step. The plugin calls it synchronously from its
 *   `before_tool_call` hook (zero cost).
 * - `rollback(feedback, stepSeq?)` truncates the rejected step from both the
 *   active agent state and the persisted session transcript, then injects a
 *   feedback message so the agent redoes the step immediately.
 *
 * The API handle is published on `globalThis.__openclawStepAuditRegistry`
 * keyed by runId because plugin hook callbacks only receive the runId and
 * cannot reach attempt-scoped runtime any other way. Entries are removed when
 * the attempt tears down (see `runEmbeddedAttempt`).
 */
import type { AgentMessage } from "../../runtime/index.js";
import type { AgentSession } from "../../sessions/index.js";
import type { SessionEntry } from "../../sessions/session-manager-types.js";
import { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import { log } from "../logger.js";

/** Maximum in-flight rollbacks per run; guards against feedback storms. */
export const MAX_STEP_AUDIT_ROLLBACKS_PER_RUN = 3;

/**
 * Prefix for injected audit-feedback messages. Also the detection marker used
 * to recognize an already-rolled-back transcript range.
 */
export const STEP_AUDIT_FEEDBACK_MARKER = "[audit-feedback]";

/** Persisted roles that belong to the rejected step suffix and can be removed. */
const REMOVABLE_STEP_AUDIT_ROLES = new Set(["assistant", "toolResult", "bashExecution", "custom"]);

type AttemptSessionManager = ReturnType<typeof guardSessionManager>;

interface StepAuditCut {
  cut: number;
  len: number;
}

export type StepAuditCaptureResult =
  | { ok: true; cut: number; stepSeq: number }
  | { ok: false; reason: string };

export type StepAuditRollbackResult =
  | { ok: true; removed: number; cut: number }
  | {
      ok: false;
      reason:
        | "bad-args"
        | "disposed"
        | "rollback-limit"
        | "no-checkpoint"
        | "no-messages"
        | "nothing-to-remove"
        | "already-rolled-back"
        | "persistence-blocked"
        | "persistence-failed"
        | string;
    };

export interface StepAuditApi {
  capture(stepSeq: number): StepAuditCaptureResult;
  rollback(feedbackText: string, stepSeq?: number): StepAuditRollbackResult;
}

/** Internal handle that can be revoked when the attempt tears down. */
interface StepAuditApiInternal extends StepAuditApi {
  dispose(): void;
}

/**
 * Process-wide bridge between plugin hook callbacks and attempt-scoped
 * checkpoints. Review plugins look their runId up here; see module docs.
 */
const globalRegistry = globalThis as unknown as {
  __openclawStepAuditRegistry?: Map<string, StepAuditApiInternal>;
};

/** Typed accessor for review plugins that prefer an import over the global. */
export function getStepAuditApi(runId: string | null | undefined): StepAuditApi | undefined {
  return runId ? globalRegistry.__openclawStepAuditRegistry?.get(runId) : undefined;
}

/** Installs the step-audit checkpoint API for one embedded-agent attempt. */
export function installStepAuditApi(input: {
  runId: string;
  activeSession: AgentSession;
  sessionManager: AttemptSessionManager;
  /** Prefix marking injected audit feedback; used to detect repeated rollbacks. */
  feedbackMarker: string;
}): void {
  const { runId, activeSession, sessionManager, feedbackMarker } = input;
  const registry =
    globalRegistry.__openclawStepAuditRegistry ??
    (globalRegistry.__openclawStepAuditRegistry = new Map<string, StepAuditApiInternal>());

  const cuts = new Map<number, StepAuditCut>();
  let rollbackCount = 0;
  let disposed = false;

  const readMessages = (): AgentMessage[] | undefined => activeSession.agent.state.messages;

  /**
   * Locates the newest assistant message that starts the current step:
   * scanning backwards, a user/custom message terminates the step, and the
   * first assistant message marks where the step began.
   */
  const findStepCut = (): number => {
    const messages = readMessages();
    if (!Array.isArray(messages)) {
      return -1;
    }
    for (let k = messages.length - 1; k >= 0; k -= 1) {
      const role = messages[k]?.role;
      if (role === "user" || role === "custom") {
        break;
      }
      if (role === "assistant") {
        return k;
      }
    }
    return -1;
  };

  /** True when the range already contains an injected audit-feedback message. */
  const hasFeedbackInjectionFrom = (from: number): boolean => {
    const messages = readMessages();
    if (!Array.isArray(messages) || from < 0 || from >= messages.length) {
      return true;
    }
    for (let k = from; k < messages.length; k += 1) {
      const message = messages[k];
      if (message?.role !== "user") {
        continue;
      }
      const serialized = JSON.stringify(message.content ?? "").slice(0, 4000);
      if (serialized.includes(feedbackMarker)) {
        return true;
      }
    }
    return false;
  };

  const buildFeedbackMessage = (
    feedbackText: string,
  ): Extract<AgentMessage, { role: "user" }> => ({
    role: "user",
    content: [{ type: "text", text: `${feedbackMarker} ${feedbackText.trim()}` }],
    timestamp: Date.now(),
  });

  const api: StepAuditApiInternal = {
    capture(stepSeq: number): StepAuditCaptureResult {
      try {
        if (disposed) {
          return { ok: false, reason: "disposed" };
        }
        const messages = readMessages();
        if (!Array.isArray(messages)) {
          return { ok: false, reason: "no-messages" };
        }
        const cut = findStepCut();
        if (cut < 0) {
          return { ok: false, reason: "no-step" };
        }
        const seq = Number.isFinite(stepSeq) ? stepSeq : -1;
        cuts.set(seq, { cut, len: messages.length });
        return { ok: true, cut, stepSeq: seq };
      } catch (error) {
        return { ok: false, reason: String(error) };
      }
    },
    rollback(feedbackText: string, stepSeq?: number): StepAuditRollbackResult {
      try {
        if (disposed) {
          return { ok: false, reason: "disposed" };
        }
        if (typeof feedbackText !== "string" || !feedbackText.trim()) {
          return { ok: false, reason: "bad-args" };
        }
        if (rollbackCount >= MAX_STEP_AUDIT_ROLLBACKS_PER_RUN) {
          return { ok: false, reason: "rollback-limit" };
        }
        let slot: StepAuditCut | undefined;
        if (Number.isFinite(stepSeq)) {
          slot = cuts.get(stepSeq as number);
          if (!slot) {
            return { ok: false, reason: "no-checkpoint" };
          }
        } else {
          // No stepSeq: roll back the most recent checkpointed step.
          let bestCut = -1;
          for (const [seq, cut] of cuts) {
            if (seq === -1) {
              continue;
            }
            if (cut.cut > bestCut) {
              bestCut = cut.cut;
              slot = cut;
            }
          }
          slot ??= cuts.get(-1);
          if (!slot) {
            return { ok: false, reason: "no-checkpoint" };
          }
        }
        const messages = readMessages();
        if (!Array.isArray(messages)) {
          return { ok: false, reason: "no-messages" };
        }
        const { cut } = slot;
        if (cut >= messages.length) {
          return { ok: false, reason: "nothing-to-remove" };
        }
        if (hasFeedbackInjectionFrom(cut)) {
          return { ok: false, reason: "already-rolled-back" };
        }
        rollbackCount += 1;
        const removed = messages.length - cut;
        const feedbackMessage = buildFeedbackMessage(feedbackText);

        // Persistence first: the session manager owns the durable transcript,
        // so rewrite it before touching the in-memory state. On any failure the
        // active state is left untouched and the rollback reports failure
        // instead of silently diverging memory from the persisted transcript.
        let removedFromPersistence = 0;
        try {
          let budget = removed;
          removedFromPersistence = sessionManager.removeTrailingEntries(
            (entry: SessionEntry) => {
              if (budget <= 0) {
                return false;
              }
              if (entry.type === "message" && REMOVABLE_STEP_AUDIT_ROLES.has(entry.message.role)) {
                budget -= 1;
                return true;
              }
              return false;
            },
            {
              preserveTrailing: (entry) => entry.type === "label" || entry.type === "session_info",
            },
          );
          sessionManager.appendMessage(feedbackMessage);
        } catch (error) {
          rollbackCount -= 1;
          log.warn(
            `step-audit rollback persistence sync failed: runId=${runId} ${String(error)}`,
          );
          return { ok: false, reason: "persistence-failed" };
        }
        if (removedFromPersistence < removed) {
          // A non-removable entry (e.g. a queued steering/custom entry) stopped
          // the contiguous removal early. The durable transcript would diverge
          // from the active state, so refuse the rollback instead of reporting
          // success.
          rollbackCount -= 1;
          log.warn(
            `step-audit rollback persistence incomplete: runId=${runId} removed=${removedFromPersistence}/${removed}`,
          );
          return { ok: false, reason: "persistence-blocked" };
        }

        // Durable rewrite succeeded: now mirror it in the active state.
        const truncated = [...messages.slice(0, cut), feedbackMessage];
        activeSession.agent.state.messages = truncated;
        return { ok: true, removed, cut };
      } catch (error) {
        return { ok: false, reason: String(error) };
      }
    },
    dispose(): void {
      disposed = true;
    },
  };

  registry.set(runId, api);
}

/** Removes the step-audit checkpoint API when an attempt tears down. */
export function uninstallStepAuditApi(runId: string): void {
  const registry = globalRegistry.__openclawStepAuditRegistry;
  if (!registry) {
    return;
  }
  // Revoke handles plugins may have retained: after teardown, capture/rollback
  // calls report `disposed` instead of mutating a closing attempt.
  registry.get(runId)?.dispose();
  registry.delete(runId);
}

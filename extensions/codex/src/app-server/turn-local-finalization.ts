import type { CodexTurnLocalBeforeAgentFinalize } from "./turn-local-finalization-types.js";

export type CodexTurnLocalFinalizeDisposition =
  | {
      action: "revise";
      instruction: string;
      onAccepted?: () => Promise<void> | void;
    }
  | {
      action: "discard";
      onAccepted?: () => Promise<void> | void;
    };

export function shouldEnableCodexTurnLocalFinalization(params: {
  callback?: CodexTurnLocalBeforeAgentFinalize;
  revisionAttempt: number;
  maxRevisionAttempts?: number;
}): boolean {
  if (!params.callback) {
    return false;
  }
  const maxRevisionAttempts = params.maxRevisionAttempts ?? 0;
  return maxRevisionAttempts <= 0 || params.revisionAttempt < maxRevisionAttempts;
}

export function createCodexTurnLocalFinalizationController(params: {
  callback?: CodexTurnLocalBeforeAgentFinalize;
  runId: string;
  sessionId: string;
  sessionKey?: string;
  provider: string;
  model: string;
  revisionAttempt: number;
  maxRevisionAttempts?: number;
}) {
  const enabled = shouldEnableCodexTurnLocalFinalization({
    callback: params.callback,
    revisionAttempt: params.revisionAttempt,
    ...(params.maxRevisionAttempts !== undefined
      ? { maxRevisionAttempts: params.maxRevisionAttempts }
      : {}),
  });
  let turnId: string | undefined;
  let disposition: CodexTurnLocalFinalizeDisposition | undefined;
  let evaluation:
    | Promise<
        { action: "continue" } | { action: "revise"; instruction: string } | { action: "discard" }
      >
    | undefined;
  let sealed = false;
  let accepted = false;
  const projectDisposition = (value: CodexTurnLocalFinalizeDisposition) =>
    value.action === "revise"
      ? ({ action: "revise", instruction: value.instruction } as const)
      : ({ action: "discard" } as const);
  const evaluate = async (event: { turnId: string; lastAssistantMessage: string }) => {
    if (!enabled || !params.callback || !turnId || event.turnId !== turnId) {
      return { action: "continue" } as const;
    }
    if (disposition) {
      return projectDisposition(disposition);
    }
    if (sealed) {
      return { action: "continue" } as const;
    }
    if (!evaluation) {
      const evaluationTurnId = event.turnId;
      const currentEvaluation = Promise.resolve(
        params.callback({
          runId: params.runId,
          sessionId: params.sessionId,
          ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
          provider: params.provider,
          model: params.model,
          lastAssistantMessage: event.lastAssistantMessage,
          revisionAttempt: params.revisionAttempt,
        }),
      ).then((outcome) => {
        if (turnId !== evaluationTurnId || sealed || disposition) {
          return disposition ? projectDisposition(disposition) : ({ action: "continue" } as const);
        }
        if (outcome.action === "revise") {
          const instruction = outcome.instruction.trim();
          if (!instruction) {
            return { action: "continue" } as const;
          }
          disposition = {
            action: "revise",
            instruction,
            ...(outcome.onAccepted ? { onAccepted: outcome.onAccepted } : {}),
          };
          return { action: "revise", instruction } as const;
        }
        if (outcome.action === "discard") {
          disposition = {
            action: "discard",
            ...(outcome.onAccepted ? { onAccepted: outcome.onAccepted } : {}),
          };
          return { action: "discard" } as const;
        }
        return { action: "continue" } as const;
      });
      evaluation = currentEvaluation;
      const clearEvaluation = () => {
        if (evaluation === currentEvaluation) {
          evaluation = undefined;
        }
      };
      void currentEvaluation.then(clearEvaluation, clearEvaluation);
    }
    return await evaluation;
  };
  return {
    enabled,
    evaluate,
    bindTurn: (turnIdInput: string) => {
      if (!enabled) {
        return;
      }
      const normalized = turnIdInput.trim();
      if (!normalized) {
        throw new Error("turn-local finalization requires a Codex turn id");
      }
      if (turnId && turnId !== normalized) {
        throw new Error("turn-local finalization cannot be rebound to another Codex turn");
      }
      turnId = normalized;
    },
    seal: (turnIdInput: string) => {
      if (!turnIdInput.trim() || turnId !== turnIdInput.trim()) {
        return undefined;
      }
      sealed = true;
      return disposition;
    },
    accept: async (turnIdInput: string) => {
      if (!turnIdInput.trim() || turnId !== turnIdInput.trim() || !disposition || accepted) {
        return;
      }
      accepted = true;
      await disposition.onAccepted?.();
    },
  };
}

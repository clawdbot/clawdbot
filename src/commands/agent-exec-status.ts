import { errorCauseChainIncludes } from "../agents/agent-run-terminal-error.js";

export type AgentExecStatus = "ok" | "error" | "timeout";

export type AgentExecErrorPhase = "task" | "infrastructure" | "cleanup";

export type AgentExecError = {
  message: string;
  kind: string;
  phase: AgentExecErrorPhase;
};

export type AgentExecCleanupFailure = {
  status: "failed";
  error: AgentExecError & {
    kind: "cleanup_error";
    phase: "cleanup";
  };
};

export type AgentExecStatusEnvelope = {
  ok: boolean;
  status: AgentExecStatus;
  error?: AgentExecError;
  cleanup?: AgentExecCleanupFailure;
};

export type AgentExecStatusResult<TEnvelope extends AgentExecStatusEnvelope> = {
  envelope: TEnvelope;
  exitCode: 0 | 1 | 2;
};

export function isAgentExecTaskFailure(error: unknown, target: unknown): boolean {
  return errorCauseChainIncludes(error, target);
}

type NormalizedEnvelope<TEnvelope extends AgentExecStatusEnvelope> = Omit<
  TEnvelope,
  keyof AgentExecStatusEnvelope
> &
  AgentExecStatusEnvelope;

export function applyAgentExecCleanupOutcome<TEnvelope extends AgentExecStatusEnvelope>(
  result: AgentExecStatusResult<TEnvelope>,
  cleanupFailure?: { message: string },
): AgentExecStatusResult<NormalizedEnvelope<TEnvelope>> {
  if (!cleanupFailure) {
    return {
      ...result,
      envelope: { ...result.envelope },
    };
  }

  const error: AgentExecCleanupFailure["error"] = {
    message: cleanupFailure.message,
    kind: "cleanup_error",
    phase: "cleanup",
  };
  const cleanup: AgentExecCleanupFailure = {
    status: "failed",
    error,
  };

  if (result.envelope.status === "ok") {
    return {
      exitCode: 1,
      envelope: {
        ...result.envelope,
        ok: false,
        status: "error",
        error,
        cleanup,
      },
    };
  }

  return {
    exitCode: result.envelope.status === "timeout" ? 2 : 1,
    envelope: {
      ...result.envelope,
      cleanup,
    },
  };
}

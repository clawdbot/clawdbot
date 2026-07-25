import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { RunEmbeddedAgentParams } from "./embedded-agent-runner/run/params.js";
import type { EmbeddedAgentRunResult } from "./embedded-agent-runner/types.js";

export type LocalTurnPlacementClaim = {
  sessionId: string;
  agentId?: string;
  sessionKey?: string;
  runId: string;
};

export type SessionPlacementTurnParams = RunEmbeddedAgentParams & { sessionFile: string };

export type SessionPlacementAdmissionProvider = {
  executeLocalTurn: <T>(claim: LocalTurnPlacementClaim, runLocal: () => Promise<T>) => Promise<T>;
  executeTurn: (
    claim: LocalTurnPlacementClaim,
    params: SessionPlacementTurnParams,
    runLocal: () => Promise<EmbeddedAgentRunResult>,
  ) => Promise<EmbeddedAgentRunResult>;
};

type SessionPlacementResetGuard = (sessionId: string) => string | undefined;

type SessionPlacementAdmissionState = {
  provider?: SessionPlacementAdmissionProvider;
  resetGuard?: SessionPlacementResetGuard;
};

// Runtime chunks share one provider. The identity guard keeps an older gateway
// shutdown from clearing a newer lifecycle's admission gate.
const state = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionPlacementAdmissionState"),
  (): SessionPlacementAdmissionState => ({}),
);

export function installSessionPlacementAdmissionProvider(
  provider: SessionPlacementAdmissionProvider,
): () => void {
  state.provider = provider;
  return () => {
    if (state.provider === provider) {
      state.provider = undefined;
    }
  };
}

export function installSessionPlacementResetGuard(guard: SessionPlacementResetGuard): () => void {
  state.resetGuard = guard;
  return () => {
    if (state.resetGuard === guard) {
      state.resetGuard = undefined;
    }
  };
}

export function resolveSessionPlacementResetBlock(sessionId: string): string | undefined {
  return state.resetGuard?.(sessionId);
}

export async function withSessionPlacementTurnAdmission(
  claim: LocalTurnPlacementClaim,
  params: SessionPlacementTurnParams,
  task: () => Promise<EmbeddedAgentRunResult>,
): Promise<EmbeddedAgentRunResult> {
  const provider = state.provider;
  if (!provider) {
    return await task();
  }
  return await provider.executeTurn(claim, params, task);
}

export async function withLocalSessionPlacementTurnAdmission<T>(
  claim: LocalTurnPlacementClaim,
  task: () => Promise<T>,
): Promise<T> {
  const provider = state.provider;
  if (!provider) {
    return await task();
  }
  return await provider.executeLocalTurn(claim, task);
}

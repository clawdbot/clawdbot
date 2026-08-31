import { AsyncLocalStorage } from "node:async_hooks";
import type { SessionTranscriptRuntimeTarget } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { RunEmbeddedAgentParams } from "./embedded-agent-runner/run/params.js";
import type { EmbeddedAgentRunResult } from "./embedded-agent-runner/types.js";
import type { SandboxContext } from "./sandbox/types.js";

export type LocalTurnPlacementClaim = {
  sessionId: string;
  agentId?: string;
  sessionKey?: string;
  runId: string;
};

export type SessionPlacementTurnParams = RunEmbeddedAgentParams & { sessionFile: string };

type SessionPlacementSandboxParams = {
  agentId: string;
  config?: OpenClawConfig;
  sessionId: string;
  sessionKey?: string;
  workspaceDir: string;
};

export type SessionPlacementAdmissionProvider = {
  assertCompactionSuccessorAllowed: (params: {
    currentTarget: SessionTranscriptRuntimeTarget;
    successorSessionId: string;
  }) => void;
  recoverTerminalTurn?: (session: { sessionId: string; sessionKey?: string }) => string | undefined;
  executeLocalTurn: <T>(claim: LocalTurnPlacementClaim, runLocal: () => Promise<T>) => Promise<T>;
  executeTurn: (
    claim: LocalTurnPlacementClaim,
    params: SessionPlacementTurnParams,
    runLocal: () => Promise<EmbeddedAgentRunResult>,
    onAdmitted?: () => void,
  ) => Promise<EmbeddedAgentRunResult>;
};

type PlacementSandboxAdmissionProvider = SessionPlacementAdmissionProvider & {
  resolveSandbox?: (params: SessionPlacementSandboxParams) => Promise<SandboxContext | null>;
};

type SessionPlacementAdmissionState = {
  provider?: PlacementSandboxAdmissionProvider;
};

// Runtime chunks share one provider. The identity guard keeps an older gateway
// shutdown from clearing a newer lifecycle's admission gate.
const state = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionPlacementAdmissionState"),
  (): SessionPlacementAdmissionState => ({}),
);
// Carry exact local-turn cleanup until the embedded handle captures it; never recover by session id.
const forcedTerminalSettlement = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionPlacementForcedTerminalSettlement"),
  () => new AsyncLocalStorage<() => Promise<void>>(),
);

export function withSessionPlacementForcedTerminalSettlement<T>(
  settle: () => Promise<void>,
  task: () => Promise<T>,
): Promise<T> {
  return forcedTerminalSettlement.run(settle, task);
}

export function resolveSessionPlacementForcedTerminalSettlement():
  | (() => Promise<void>)
  | undefined {
  return forcedTerminalSettlement.getStore();
}

export function installSessionPlacementAdmissionProvider(
  provider: SessionPlacementAdmissionProvider,
): () => void {
  state.provider = provider as PlacementSandboxAdmissionProvider;
  return () => {
    if (state.provider === provider) {
      state.provider = undefined;
    }
  };
}

/** Captures the exact placement owner, including standalone absence, before awaited work. */
export function captureSessionPlacementCompactionSuccessorAssertion(): SessionPlacementAdmissionProvider["assertCompactionSuccessorAllowed"] {
  const provider = state.provider;
  return (params) => {
    if (state.provider !== provider) {
      throw new Error("session placement owner changed during compaction successor acceptance");
    }
    provider?.assertCompactionSuccessorAllowed(params);
  };
}

export async function withSessionPlacementTurnAdmission(
  claim: LocalTurnPlacementClaim,
  params: SessionPlacementTurnParams,
  task: () => Promise<EmbeddedAgentRunResult>,
  onAdmitted?: () => void,
): Promise<EmbeddedAgentRunResult> {
  let admitted = false;
  const admitTurn = () => {
    if (admitted) {
      return;
    }
    admitted = true;
    onAdmitted?.();
  };
  // Providers may execute locally or remotely; both must release queue ownership
  // only when their actual execution path has acquired its placement claim.
  const runAdmittedLocalTurn = () => {
    admitTurn();
    return task();
  };
  const provider = state.provider;
  if (!provider) {
    return await runAdmittedLocalTurn();
  }
  return await provider.executeTurn(claim, params, runAdmittedLocalTurn, admitTurn);
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

/** Resolves an authoritative sandbox only when the live placement owns remote execution. */
export async function resolveSessionPlacementSandbox(
  params: SessionPlacementSandboxParams,
): Promise<SandboxContext | null> {
  return (await state.provider?.resolveSandbox?.(params)) ?? null;
}

/** The current placement owner alone can settle a proven terminal worker turn. */
export function recoverTerminalSessionPlacementTurn(session: {
  sessionId: string;
  sessionKey?: string;
}): string | undefined {
  return state.provider?.recoverTerminalTurn?.(session);
}

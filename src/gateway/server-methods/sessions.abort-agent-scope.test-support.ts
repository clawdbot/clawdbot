import type { GatewayRequestContext } from "./types.js";

export function createActiveRun(sessionKey: string, params: { agentId?: string } = {}) {
  const now = Date.now();
  return {
    controller: new AbortController(),
    sessionId: "sess-active",
    sessionKey,
    agentId: params.agentId,
    startedAtMs: now,
    expiresAtMs: now + 30_000,
    kind: "chat-send" as const,
  };
}

export type ActiveRun = ReturnType<typeof createActiveRun>;
type TestAgentConfig = { id: string; default?: boolean };

function createDefaultAgents(): TestAgentConfig[] {
  return [{ id: "main", default: true }, { id: "work" }];
}

export function createContext(
  options: {
    activeRuns?: ReadonlyArray<readonly [string, ActiveRun]>;
    agents?: TestAgentConfig[];
    globalScope?: boolean;
    extra?: Partial<GatewayRequestContext>;
  } = {},
): GatewayRequestContext {
  const cfg = {
    agents: { list: options.agents ?? createDefaultAgents() },
    ...(options.globalScope ? { session: { scope: "global" as const } } : {}),
  };
  return {
    chatAbortControllers: new Map(options.activeRuns ?? []),
    getRuntimeConfig: () => cfg,
    ...options.extra,
  } as unknown as GatewayRequestContext;
}

export function createBetaRunContext(activeRun: ActiveRun): GatewayRequestContext {
  return createContext({
    activeRuns: [["run-beta", activeRun]],
    agents: [{ id: "main", default: true }, { id: "beta" }],
  });
}

export function createGlobalWorkRunContext(activeRun: ActiveRun): GatewayRequestContext {
  return createContext({
    activeRuns: [["run-global", activeRun]],
    globalScope: true,
  });
}

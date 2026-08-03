import { listAgentEntries } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
// Non-interactive onboarding test helpers build runtime stubs that throw instead of exiting.
import type { RuntimeEnv } from "../runtime.js";

type RuntimeLike = Pick<RuntimeEnv, "log" | "error" | "exit">;

type NonInteractiveRuntime = {
  log: RuntimeLike["log"];
  error: RuntimeLike["error"];
  exit: RuntimeLike["exit"];
};

export type WaitForGatewayReachableMock =
  | ((params: {
      url: string;
      token?: string;
      password?: string;
      deadlineMs?: number;
      probeTimeoutMs?: number;
    }) => Promise<{ ok: boolean; detail?: string }>)
  | undefined;

export function createThrowingRuntime(): NonInteractiveRuntime {
  return {
    log: () => {},
    error: (...args: unknown[]) => {
      throw new Error(args.map(String).join(" "));
    },
    exit: (code: number) => {
      throw new Error(`exit:${code}`);
    },
  };
}

export async function mockOnboardingAgent(params: { config: OpenClawConfig; workspace: string }) {
  const roster = listAgentEntries(params.config);
  const existing = roster.find((entry) => entry.default === true) ?? roster[0];
  if (existing) {
    return {
      config: params.config,
      agentId: existing.id,
      bootstrapPending: false,
    };
  }
  return {
    config: {
      ...params.config,
      agents: {
        ...params.config.agents,
        entries: { main: { name: "main", workspace: params.workspace, default: true } },
      },
    },
    agentId: "main",
    bootstrapPending: true,
  };
}

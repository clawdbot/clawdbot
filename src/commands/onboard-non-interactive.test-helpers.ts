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
  const existing =
    params.config.agents?.list?.find((entry) => entry.default === true) ??
    params.config.agents?.list?.[0];
  if (existing) {
    return { config: params.config, agentId: existing.id, bootstrapPending: false };
  }
  return {
    config: {
      ...params.config,
      agents: {
        ...params.config.agents,
        list: [{ id: "main", name: "main", workspace: params.workspace, default: true }],
      },
    },
    agentId: "main",
    bootstrapPending: true,
  };
}

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

export async function mockOnboardingAgent(params: {
  config: OpenClawConfig;
  name: string;
  workspace: string;
}) {
  return {
    config: {
      ...params.config,
      agents: {
        ...params.config.agents,
        list: [{ id: params.name, name: params.name, workspace: params.workspace, default: true }],
      },
    },
    agentId: params.name,
    bootstrapPending: true,
  };
}

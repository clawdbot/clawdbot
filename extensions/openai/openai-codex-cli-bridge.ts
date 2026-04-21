import type {
  CliBackendPreparedExecution,
  CliBackendPrepareExecutionContext,
} from "openclaw/plugin-sdk/cli-backend";
import { prepareCodexAuthBridge } from "openclaw/plugin-sdk/provider-auth-runtime";

export async function prepareOpenAICodexCliExecution(
  ctx: CliBackendPrepareExecutionContext,
): Promise<CliBackendPreparedExecution | null> {
  if (!ctx.agentDir || !ctx.authProfileId) {
    return null;
  }

  const bridge = await prepareCodexAuthBridge({
    agentDir: ctx.agentDir,
    bridgeDir: "cli-auth",
    profileId: ctx.authProfileId,
  });
  if (!bridge) {
    return null;
  }

  return {
    env: {
      CODEX_HOME: bridge.codexHome,
    },
    clearEnv: bridge.clearEnv,
  };
}

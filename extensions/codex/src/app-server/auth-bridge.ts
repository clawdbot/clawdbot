import { prepareCodexAuthBridge } from "openclaw/plugin-sdk/provider-auth-runtime";
import type { CodexAppServerStartOptions } from "./config.js";

const DEFAULT_CODEX_AUTH_PROFILE_ID = "openai-codex:default";

export async function bridgeCodexAppServerStartOptions(params: {
  startOptions: CodexAppServerStartOptions;
  agentDir: string;
  authProfileId?: string;
}): Promise<CodexAppServerStartOptions> {
  const profileId = params.authProfileId?.trim() || DEFAULT_CODEX_AUTH_PROFILE_ID;
  const bridge = await prepareCodexAuthBridge({
    agentDir: params.agentDir,
    bridgeDir: "harness-auth",
    profileId,
    sourceCodexHome: params.startOptions.env?.CODEX_HOME,
  });
  if (!bridge) {
    return params.startOptions;
  }

  return {
    ...params.startOptions,
    env: {
      ...params.startOptions.env,
      CODEX_HOME: bridge.codexHome,
    },
    clearEnv: Array.from(new Set([...(params.startOptions.clearEnv ?? []), ...bridge.clearEnv])),
  };
}

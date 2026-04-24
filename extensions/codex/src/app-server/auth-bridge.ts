import type { CodexAppServerStartOptions } from "./config.js";

export async function bridgeCodexAppServerStartOptions(params: {
  startOptions: CodexAppServerStartOptions;
  agentDir: string;
  authProfileId?: string;
}): Promise<CodexAppServerStartOptions> {
  void params.agentDir;
  void params.authProfileId;
  return params.startOptions;
}

import type { resolveCodexAppServerAuthProfileIdForAgent } from "./auth-bridge.js";
import type { CodexAppServerClient } from "./client.js";
import type { CodexAppServerStartOptions } from "./config.js";

type AuthProfileOrderConfig = Parameters<
  typeof resolveCodexAppServerAuthProfileIdForAgent
>[0]["config"];

export type CodexAppServerClientFactory = (
  startOptions?: CodexAppServerStartOptions,
  authProfileId?: string,
  agentDir?: string,
  config?: AuthProfileOrderConfig,
) => Promise<CodexAppServerClient>;

let sharedClientModulePromise: Promise<typeof import("./shared-client.js")> | null = null;

const loadSharedClientModule = async () => {
  sharedClientModulePromise ??= import("./shared-client.js");
  return await sharedClientModulePromise;
};

export const defaultCodexAppServerClientFactory: CodexAppServerClientFactory = (
  startOptions,
  authProfileId,
  agentDir,
  config,
) =>
  loadSharedClientModule().then(({ getSharedCodexAppServerClient }) =>
    getSharedCodexAppServerClient({ startOptions, authProfileId, agentDir, config }),
  );

export const defaultLeasedCodexAppServerClientFactory: CodexAppServerClientFactory = (
  startOptions,
  authProfileId,
  agentDir,
  config,
) =>
  loadSharedClientModule().then(({ getLeasedSharedCodexAppServerClient }) =>
    getLeasedSharedCodexAppServerClient({ startOptions, authProfileId, agentDir, config }),
  );

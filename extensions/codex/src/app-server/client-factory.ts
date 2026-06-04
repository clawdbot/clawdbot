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
  options?: {
    onStartedClient?: (client: CodexAppServerClient) => void;
    abandonSignal?: AbortSignal;
  },
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
  options,
) =>
  loadSharedClientModule().then(({ getSharedCodexAppServerClient }) =>
    getSharedCodexAppServerClient({
      startOptions,
      authProfileId,
      agentDir,
      config,
      onStartedClient: options?.onStartedClient,
      abandonSignal: options?.abandonSignal,
    }),
  );

export const defaultLeasedCodexAppServerClientFactory: CodexAppServerClientFactory = (
  startOptions,
  authProfileId,
  agentDir,
  config,
  options,
) =>
  loadSharedClientModule().then(({ getLeasedSharedCodexAppServerClient }) =>
    getLeasedSharedCodexAppServerClient({
      startOptions,
      authProfileId,
      agentDir,
      config,
      onStartedClient: options?.onStartedClient,
      abandonSignal: options?.abandonSignal,
    }),
  );

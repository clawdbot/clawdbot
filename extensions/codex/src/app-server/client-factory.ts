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

export const defaultCodexAppServerClientFactory: CodexAppServerClientFactory = (
  startOptions,
  authProfileId,
  agentDir,
  config,
) =>
  import("./shared-client.js").then(({ getSharedCodexAppServerClient }) =>
    getSharedCodexAppServerClient({ startOptions, authProfileId, agentDir, config }),
  );

export function createCodexAppServerClientFactoryTestHooks(
  setFactory: (factory: CodexAppServerClientFactory) => void,
) {
  return {
    setCodexAppServerClientFactoryForTests(factory: CodexAppServerClientFactory): void {
      setFactory(factory);
    },
    resetCodexAppServerClientFactoryForTests(): void {
      setFactory(defaultCodexAppServerClientFactory);
    },
  } as const;
}

import type { CodexAppServerClient } from "./client.js";
import type { CodexAppServerStartOptions } from "./config.js";

export type CodexAppServerClientFactory = (
  startOptions?: CodexAppServerStartOptions,
  authProfileId?: string,
  agentDir?: string,
) => Promise<CodexAppServerClient>;

export const defaultCodexAppServerClientFactory: CodexAppServerClientFactory = (
  startOptions,
  authProfileId,
  agentDir,
) =>
  import("./shared-client.js").then(({ getSharedCodexAppServerClient }) =>
    getSharedCodexAppServerClient({ startOptions, authProfileId, agentDir }),
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

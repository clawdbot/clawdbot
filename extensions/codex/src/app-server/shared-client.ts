import { CodexAppServerClient } from "./client.js";
import {
  codexAppServerStartOptionsKey,
  resolveCodexAppServerRuntimeOptions,
  type CodexAppServerStartOptions,
} from "./config.js";
import { withTimeout } from "./timeout.js";

type SharedCodexAppServerClientState = {
  client?: CodexAppServerClient;
  promise?: Promise<CodexAppServerClient>;
  key?: string;
};

const SHARED_CODEX_APP_SERVER_CLIENT_STATE = Symbol.for("openclaw.codexAppServerClientState");

function getSharedCodexAppServerClientState(): SharedCodexAppServerClientState {
  const globalState = globalThis as typeof globalThis & {
    [SHARED_CODEX_APP_SERVER_CLIENT_STATE]?: SharedCodexAppServerClientState;
  };
  globalState[SHARED_CODEX_APP_SERVER_CLIENT_STATE] ??= {};
  return globalState[SHARED_CODEX_APP_SERVER_CLIENT_STATE];
}

export async function getSharedCodexAppServerClient(options?: {
  startOptions?: CodexAppServerStartOptions;
  timeoutMs?: number;
}): Promise<CodexAppServerClient> {
  const state = getSharedCodexAppServerClientState();
  const startOptions = options?.startOptions ?? resolveCodexAppServerRuntimeOptions().start;
  const key = codexAppServerStartOptionsKey(startOptions);
  if (state.key && state.key !== key) {
    clearSharedCodexAppServerClient();
  }
  state.key = key;
  state.promise ??= (async () => {
    const client = CodexAppServerClient.start(startOptions);
    state.client = client;
    client.addCloseHandler(clearSharedClientIfCurrent);
    try {
      await client.initialize();
      return client;
    } catch (error) {
      // Startup failures happen before callers own the shared client, so close
      // the child here instead of leaving a rejected daemon attached to stdio.
      client.close();
      throw error;
    }
  })();
  try {
    return await withTimeout(
      state.promise,
      options?.timeoutMs ?? 0,
      "codex app-server initialize timed out",
    );
  } catch (error) {
    clearSharedCodexAppServerClient();
    throw error;
  }
}

export function resetSharedCodexAppServerClientForTests(): void {
  const state = getSharedCodexAppServerClientState();
  state.client = undefined;
  state.promise = undefined;
  state.key = undefined;
}

export function clearSharedCodexAppServerClient(): void {
  const state = getSharedCodexAppServerClientState();
  const client = state.client;
  state.client = undefined;
  state.promise = undefined;
  state.key = undefined;
  client?.close();
}

function clearSharedClientIfCurrent(client: CodexAppServerClient): void {
  const state = getSharedCodexAppServerClientState();
  if (state.client !== client) {
    return;
  }
  state.client = undefined;
  state.promise = undefined;
  state.key = undefined;
}

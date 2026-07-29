import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CodexAttemptConnection } from "./run-attempt-connection.js";
import {
  getLeasedSharedCodexAppServerClient,
  getSharedCodexAppServerClient,
  type CodexAppServerClientOptions,
} from "./shared-client.js";

/** Starts the shared process while tools and prompt context are still being prepared. */
export function prewarmCodexAttemptClient(params: {
  connection: CodexAttemptConnection;
  authProfileStore: CodexAppServerClientOptions["authProfileStore"];
  authBindingFingerprint: string | undefined;
}): void {
  const { connection, authProfileStore, authBindingFingerprint } = params;
  const {
    appServer,
    attemptClientFactory,
    options,
    pluginConfig,
    runtimeArtifactRequest,
    startupAuthRequirement,
    startupClientAuthProfileId,
    startupPreparedAuth,
    agentDir,
    params: runParams,
    runAbortController,
  } = connection;
  if (
    options.clientFactory ||
    attemptClientFactory !== getLeasedSharedCodexAppServerClient ||
    runtimeArtifactRequest
  ) {
    return;
  }
  // The real startup later leases this same keyed client. Beginning the
  // non-leased acquire now removes process/auth initialization from the cold path.
  void getSharedCodexAppServerClient({
    startOptions: appServer.start,
    pluginConfig,
    ...(startupPreparedAuth
      ? { preparedAuth: startupPreparedAuth }
      : { authProfileId: startupClientAuthProfileId }),
    authRequirement: startupAuthRequirement,
    authProfileStore,
    authBindingFingerprint,
    agentDir,
    config: runParams.config,
    timeoutMs: appServer.requestTimeoutMs,
    abandonSignal: runAbortController.signal,
  }).catch((error: unknown) => {
    // Startup owns the actionable retry/error. Prewarm failure only restores
    // the old serialized path and must not fail the turn early.
    embeddedAgentLog.debug("codex app-server client prewarm failed", { error });
  });
}

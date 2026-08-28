import { isDeepStrictEqual } from "node:util";
import { resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/agent-runtime";
import type { PluginCommandContext } from "openclaw/plugin-sdk/plugin-entry";
import { fingerprintCodexAppServerAuthBinding } from "./app-server/auth-binding.js";
import {
  resolveCodexAppServerAuthAccountCacheKey,
  resolveCodexAppServerAuthProfileStore,
  resolveCodexAppServerFallbackApiKeyCacheKey,
  resolveCodexAppServerPreparedApiKeyCacheKey,
} from "./app-server/auth-bridge.js";
import { resolveCodexAppServerRuntimeOptions } from "./app-server/config.js";
import { buildCodexPluginAppCacheKey } from "./app-server/plugin-app-cache-key.js";
import { resolveCodexRunSessionBindingAuthority } from "./app-server/session-binding.js";
import {
  getLeasedSharedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient,
} from "./app-server/shared-client.js";
import type { CodexCommandDeps } from "./command-handler-deps.js";
import { resolveCommandAppServerContext, resolveControlTarget } from "./command-handler-scope.js";
import type { CodexPluginsConfigBlock } from "./command-plugin-config.js";
import { prepareCodexControlSessionAuth } from "./command-rpc.js";
import { readCodexConversationBindingData } from "./conversation-binding-data.js";

/** One account and physical connection for an operator's plugin inspection or recheck. */
export type CodexPluginCommandContext = {
  request: <T>(method: string, params?: unknown) => Promise<T>;
  workspaceDir: string;
  agentId: string;
  profileId?: string;
  threadId?: string;
  appCacheKey: string;
  current: CodexPluginsConfigBlock;
  validateCurrent: () => Promise<void>;
};

export async function withCodexPluginCommandContext<T>(
  params: { deps: CodexCommandDeps; ctx: PluginCommandContext; pluginConfig: unknown },
  run: (context: CodexPluginCommandContext) => Promise<T>,
): Promise<T> {
  const { deps, ctx, pluginConfig } = params;
  const current = (await deps.codexPluginsManagementIo?.readConfig()) ?? {};
  const initialPolicy = JSON.stringify(current);
  const { scope, target, binding } = await resolveCommandAppServerContext(deps, ctx, pluginConfig);
  const conversation = readCodexConversationBindingData(await ctx.getCurrentConversationBinding());
  const workspaceDir =
    binding?.cwd ||
    (conversation?.kind === "codex-app-server-session" ? conversation.workspaceDir : undefined) ||
    resolveAgentWorkspaceDir(ctx.config, scope.agentId);
  const configuredRuntime = resolveCodexAppServerRuntimeOptions({ pluginConfig });
  const appServer = scope.startOptions
    ? { ...configuredRuntime, start: scope.startOptions }
    : configuredRuntime;
  const auth = await prepareCodexControlSessionAuth(
    { ...scope, config: ctx.config },
    appServer.start,
  );
  const preparedAuth =
    "preparedAuth" in auth.clientOptions ? auth.clientOptions.preparedAuth : undefined;
  const usesNativeAuth = scope.authProfileId === null || appServer.start.homeScope === "user";
  const profileId = usesNativeAuth ? undefined : auth.authProfileId;
  const readAuthBinding = () =>
    profileId
      ? fingerprintCodexAppServerAuthBinding({
          authProfileId: profileId,
          authProfileStore: resolveCodexAppServerAuthProfileStore({
            authProfileId: profileId,
            agentDir: scope.agentDir,
            config: ctx.config,
          }),
          agentDir: scope.agentDir,
          config: ctx.config,
        })
      : Promise.resolve(undefined);
  // Compare the prepared principal binding, not cache keys with email/profile fallbacks.
  // A profile can change accounts while preparation awaits, before a client is leased.
  const authBinding =
    "authBindingFingerprint" in auth.clientOptions
      ? auth.clientOptions.authBindingFingerprint
      : await readAuthBinding();
  const accountId = usesNativeAuth
    ? undefined
    : preparedAuth?.kind === "api-key"
      ? resolveCodexAppServerPreparedApiKeyCacheKey(preparedAuth.apiKey)
      : preparedAuth?.kind === "profile"
        ? preparedAuth.snapshot.secretFreeCacheKey
        : await resolveCodexAppServerAuthAccountCacheKey({
            authProfileId: profileId,
            agentDir: scope.agentDir,
            config: ctx.config,
          });
  if ((await readAuthBinding()) !== authBinding) {
    throw new Error(
      "Codex account, conversation, or plugin policy changed. Run the command again.",
    );
  }
  const client = await getLeasedSharedCodexAppServerClient({
    startOptions: appServer.start,
    pluginConfig,
    agentDir: scope.agentDir,
    config: ctx.config,
    ...auth.clientOptions,
  });
  let accountChanged = false;
  let unsubscribe: (() => void) | undefined;
  const validateCurrent = async () => {
    const currentTarget = await resolveControlTarget(ctx);
    const currentBinding = currentTarget
      ? await deps.bindingStore.read(currentTarget.identity)
      : undefined;
    const currentConversation = readCodexConversationBindingData(
      await ctx.getCurrentConversationBinding(),
    );
    const currentPolicy = JSON.stringify(await deps.codexPluginsManagementIo?.readConfig());
    const currentAuthBinding = await readAuthBinding();
    if (
      accountChanged ||
      client.getCloseError() ||
      (currentTarget?.identity.kind === "session" &&
        resolveCodexRunSessionBindingAuthority({
          identity: currentTarget.identity,
          config: ctx.config,
        }) === "superseded") ||
      !isDeepStrictEqual(currentTarget, target) ||
      !isDeepStrictEqual(currentConversation, conversation) ||
      currentBinding?.threadId !== binding?.threadId ||
      currentBinding?.clientId !== binding?.clientId ||
      currentBinding?.cwd !== binding?.cwd ||
      currentBinding?.authProfileId !== binding?.authProfileId ||
      currentBinding?.conversationStartId !== binding?.conversationStartId ||
      currentBinding?.pluginAppsFingerprint !== binding?.pluginAppsFingerprint ||
      currentPolicy !== initialPolicy ||
      currentAuthBinding !== authBinding
    ) {
      throw new Error(
        "Codex account, conversation, or plugin policy changed. Run the command again.",
      );
    }
  };
  try {
    // Codex serializes account/read after the full login handler, including its
    // delayed account/updated notification. Drain startup before fencing reads.
    try {
      await client.request("account/read", { refreshToken: false });
    } catch {
      throw new Error(
        "Codex account startup could not be confirmed. Check /codex account and retry.",
      );
    }
    unsubscribe = client.addNotificationHandler((notification) => {
      if (notification.method === "account/updated") {
        accountChanged = true;
      }
    });
    await validateCurrent();
    const result = await run({
      request: async <TResponse>(method: string, requestParams?: unknown): Promise<TResponse> => {
        await validateCurrent();
        const response = await client.request<TResponse>(method, requestParams);
        // A delayed response must not publish into a cache after scope changes.
        await validateCurrent();
        return response;
      },
      workspaceDir,
      agentId: scope.agentId,
      current,
      ...(profileId ? { profileId } : {}),
      // Persisted thread ids alone cannot attest a different physical client.
      ...(binding?.clientId === client.getInstanceId() ? { threadId: binding.threadId } : {}),
      appCacheKey: buildCodexPluginAppCacheKey({
        appServer,
        agentDir: scope.agentDir,
        authProfileId: profileId,
        accountId,
        envApiKeyFingerprint:
          usesNativeAuth || preparedAuth || profileId
            ? undefined
            : resolveCodexAppServerFallbackApiKeyCacheKey({ startOptions: appServer.start }),
        appServerVersion: client.getServerVersion(),
        runtimeIdentity: client.getRuntimeIdentity(),
      }),
      validateCurrent,
    });
    await validateCurrent();
    return result;
  } finally {
    unsubscribe?.();
    releaseLeasedSharedCodexAppServerClient(client);
  }
}

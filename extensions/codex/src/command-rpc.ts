import { prepareAgentRuntimeAuth } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveSessionAgentIds,
} from "openclaw/plugin-sdk/agent-runtime";
import { resolveSessionModelRef } from "openclaw/plugin-sdk/model-session-runtime";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import { getSessionEntry, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { closeCodexStartupClientBestEffort } from "./app-server/attempt-client-cleanup.js";
import { prepareCodexAppServerAuthBinding } from "./app-server/auth-binding.js";
import {
  resolveCodexAppServerAuthProfileId,
  resolveCodexAppServerAuthProfileStore,
  resolveCodexAppServerPreparedAuthHandoff,
  type resolveCodexAppServerAuthProfileIdForAgent,
} from "./app-server/auth-bridge.js";
import {
  CODEX_CONTROL_METHODS,
  describeControlFailure,
  type CodexControlMethod,
} from "./app-server/capabilities.js";
import type { CodexAppServerClient } from "./app-server/client.js";
import {
  resolveCodexAppServerRuntimeOptions,
  resolveCodexSupervisionAppServerRuntimeOptions,
  type CodexAppServerStartOptions,
} from "./app-server/config.js";
import { listCodexAppServerModels } from "./app-server/models.js";
import type {
  CodexAppServerRequestMethod,
  CodexAppServerRequestParams,
  CodexAppServerRequestResult,
  JsonValue,
} from "./app-server/protocol.js";
import { isJsonObject } from "./app-server/protocol.js";
import {
  requestCodexAppServerJson,
  withCodexAppServerJsonClient,
  type CodexAppServerScopedRequest,
} from "./app-server/request.js";
import { resumeCodexAppServerThread } from "./app-server/thread-resume.js";

export type SafeValue<T> = { ok: true; value: T } | { ok: false; error: string };

type AuthProfileOrderConfig = Parameters<
  typeof resolveCodexAppServerAuthProfileIdForAgent
>[0]["config"];

export type CodexControlRequestOptions = {
  config?: AuthProfileOrderConfig;
  authProfileId?: string | null;
  agentId?: string;
  agentDir?: string;
  sessionKey?: string;
  sessionId?: string;
  isolated?: boolean;
  startOptions?: CodexAppServerStartOptions;
  timeoutMs?: number;
  beforeRequest?: (request: CodexAppServerScopedRequest) => Promise<void>;
  onResponse?: (
    response: unknown,
    client: CodexAppServerClient,
    auth: { authProfileId?: string; assertCurrent: () => void },
  ) => Promise<void>;
};

/** Selects the same prepared auth partition as an admitted session turn. */
export async function prepareCodexControlSessionAuth(
  options: CodexControlRequestOptions,
  startOptions: CodexAppServerStartOptions,
) {
  if (
    !options.config ||
    !options.sessionKey ||
    options.authProfileId === null ||
    startOptions.homeScope === "user"
  ) {
    return {
      authProfileId: options.authProfileId ?? undefined,
      clientOptions: { authProfileId: options.authProfileId },
    };
  }
  const config = options.config;
  const { sessionAgentId } = resolveSessionAgentIds({
    config,
    sessionKey: options.sessionKey,
    agentId: options.agentId,
  });
  const agentDir = options.agentDir ?? resolveAgentDir(config, sessionAgentId);
  const workspaceDir = resolveAgentWorkspaceDir(config, sessionAgentId);
  const entry = getSessionEntry({
    agentId: sessionAgentId,
    storePath: resolveStorePath(config.session?.store, { agentId: sessionAgentId }),
    sessionKey: options.sessionKey,
    hydrateSkillPromptRefs: false,
    readConsistency: "latest",
  });
  const model = resolveSessionModelRef(config, entry, sessionAgentId);
  const store = resolveCodexAppServerAuthProfileStore({ agentDir, config });
  const { plan, attempts } = prepareAgentRuntimeAuth({
    provider: model.provider,
    modelId: model.model,
    config,
    agentDir,
    workspaceDir,
    authProfileStore: store,
    sessionAuthProfileId: entry?.authProfileOverride ?? options.authProfileId,
    sessionAuthProfileSource: entry?.authProfileOverrideSource,
    harnessId: "codex",
    harnessAuthBootstrap: "harness",
  });
  const route = plan.modelRoute;
  // A control subscription must use the same prepared auth partition as a turn.
  // Unsubscribe leaves Codex's native writer loaded for 30 minutes; another
  // process cannot resume that thread, even after its OpenClaw binding is gone.
  const resolvedAuth = route
    ? await resolveApiKeyForProvider({
        provider: route.provider,
        modelId: route.modelId,
        modelApi: route.api,
        cfg: config,
        agentDir,
        workspaceDir,
        store,
        profileId: attempts[0]?.profileId,
        lockedProfile: plan.forwardedAuthProfileSource === "user",
        allowAuthProfileFallback: attempts[0]?.allowAuthProfileFallback,
        skipSetupProviderFallback: true,
      })
    : undefined;
  const handoff = await resolveCodexAppServerPreparedAuthHandoff({
    authRequirement: route?.authRequirement,
    resolvedApiKey: resolvedAuth?.apiKey,
    authProfileId: route
      ? plan.forwardedAuthProfileId
      : resolveCodexAppServerAuthProfileId({
          authProfileId: plan.forwardedAuthProfileId,
          store,
          config,
        }),
    authProfileStore: store,
    agentDir,
    homeScope: startOptions.homeScope ?? "agent",
    config,
    subscriptionProfileRequiredError:
      "Prepared Codex subscription route requires a forwarded OpenAI OAuth or token profile.",
    subscriptionProfileUnusableError: "Prepared Codex subscription auth profile is unusable.",
  });
  const binding = handoff.authProfileId
    ? await prepareCodexAppServerAuthBinding({
        authProfileId: handoff.authProfileId,
        authProfileStore: store,
        agentDir,
        config,
      })
    : undefined;
  return {
    authProfileId: handoff.authProfileId,
    clientOptions: {
      ...(handoff.preparedAuth
        ? { preparedAuth: handoff.preparedAuth }
        : { authProfileId: handoff.authProfileId }),
      authRequirement: route?.authRequirement,
      authProfileStore: binding?.authProfileStore ?? store,
      authBindingFingerprint: binding?.fingerprint,
      agentDir,
    },
  };
}

export function requestOptions(
  pluginConfig: unknown,
  limit: number,
  config?: AuthProfileOrderConfig,
  agentDir?: string,
) {
  const runtime = resolveCodexAppServerRuntimeOptions({ pluginConfig });
  return {
    limit,
    timeoutMs: runtime.requestTimeoutMs,
    startOptions: runtime.start,
    config,
    agentDir,
  };
}

type CodexControlRequestMethod = CodexControlMethod & CodexAppServerRequestMethod;

export function codexControlRequest<M extends CodexControlRequestMethod>(
  pluginConfig: unknown,
  method: M,
  requestParams: CodexAppServerRequestParams<M>,
  options?: CodexControlRequestOptions,
): Promise<CodexAppServerRequestResult<M>>;
export function codexControlRequest(
  pluginConfig: unknown,
  method: CodexControlMethod,
  requestParams?: JsonValue,
  options?: CodexControlRequestOptions,
): Promise<JsonValue | undefined>;
export async function codexControlRequest(
  pluginConfig: unknown,
  method: CodexControlMethod,
  requestParams?: unknown,
  options: CodexControlRequestOptions = {},
): Promise<unknown> {
  // Explicit control options own the connection; harness defaults would reject user-home Unix.
  const runtime = options.startOptions
    ? resolveCodexSupervisionAppServerRuntimeOptions({ pluginConfig })
    : resolveCodexAppServerRuntimeOptions({ pluginConfig });
  const startOptions = options.startOptions ?? runtime.start;
  const auth = options.onResponse
    ? await prepareCodexControlSessionAuth(options, startOptions)
    : {
        authProfileId: options.authProfileId ?? undefined,
        clientOptions: { authProfileId: options.authProfileId },
      };
  const controlRequestOptions = {
    timeoutMs: options.timeoutMs ?? runtime.requestTimeoutMs,
    startOptions,
    config: options.config,
    sessionKey: options.sessionKey,
    sessionId: options.sessionId,
    agentDir: options.agentDir,
    isolated: options.isolated,
    ...auth.clientOptions,
  };
  if (options.onResponse || options.beforeRequest) {
    return await withCodexAppServerJsonClient(
      controlRequestOptions,
      async (request, client, scope) => {
        await options.beforeRequest?.(request);
        scope.assertCurrent();
        let response: unknown;
        if (method === "thread/resume") {
          if (!isJsonObject(requestParams) || typeof requestParams.threadId !== "string") {
            throw new Error("Codex thread/resume requires a thread id.");
          }
          response = await resumeCodexAppServerThread({
            client,
            request: { ...requestParams, threadId: requestParams.threadId },
            requestResume: () => request({ method, requestParams }),
            abandonClient: () => closeCodexStartupClientBestEffort(client),
          });
        } else {
          response = await request({ method, requestParams });
        }
        // Subscription-producing control requests must publish their exact
        // physical-client ownership before this shared lease can be released.
        await options.onResponse?.(response, client, {
          authProfileId: auth.authProfileId,
          assertCurrent: scope.assertCurrent,
        });
        scope.assertCurrent();
        return response;
      },
    );
  }
  return await requestCodexAppServerJson({ method, requestParams, ...controlRequestOptions });
}

export function safeCodexControlRequest<M extends CodexControlRequestMethod>(
  pluginConfig: unknown,
  method: M,
  requestParams: CodexAppServerRequestParams<M>,
  options?: CodexControlRequestOptions,
): Promise<SafeValue<CodexAppServerRequestResult<M>>>;
export function safeCodexControlRequest(
  pluginConfig: unknown,
  method: CodexControlMethod,
  requestParams?: JsonValue,
  options?: CodexControlRequestOptions,
): Promise<SafeValue<JsonValue | undefined>>;
export async function safeCodexControlRequest(
  pluginConfig: unknown,
  method: CodexControlMethod,
  requestParams?: unknown,
  options: CodexControlRequestOptions = {},
): Promise<SafeValue<unknown>> {
  return await safeValue(
    async () =>
      await codexControlRequest(pluginConfig, method, requestParams as JsonValue, options),
  );
}

async function safeCodexModelList(
  pluginConfig: unknown,
  limit: number,
  config?: AuthProfileOrderConfig,
  agentDir?: string,
) {
  return await safeValue(
    async () =>
      await listCodexAppServerModels(requestOptions(pluginConfig, limit, config, agentDir)),
  );
}

export async function readCodexStatusProbes(
  pluginConfig: unknown,
  config?: AuthProfileOrderConfig,
  agentDir?: string,
) {
  const [models, account, limits, mcps, skills] = await Promise.all([
    safeCodexModelList(pluginConfig, 20, config, agentDir),
    safeCodexControlRequest(
      pluginConfig,
      CODEX_CONTROL_METHODS.account,
      { refreshToken: false },
      { config, agentDir },
    ),
    safeCodexControlRequest(pluginConfig, CODEX_CONTROL_METHODS.rateLimits, undefined, {
      config,
      agentDir,
    }),
    safeCodexControlRequest(
      pluginConfig,
      CODEX_CONTROL_METHODS.listMcpServers,
      { limit: 100 },
      { config, agentDir },
    ),
    safeCodexControlRequest(
      pluginConfig,
      CODEX_CONTROL_METHODS.listSkills,
      {},
      {
        config,
        agentDir,
      },
    ),
  ]);

  return { models, account, limits, mcps, skills };
}

async function safeValue<T>(read: () => Promise<T>): Promise<SafeValue<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    return { ok: false, error: describeControlFailure(error) };
  }
}

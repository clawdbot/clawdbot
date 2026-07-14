// Codex plugin module implements command rpc behavior.
import type { resolveCodexAppServerAuthProfileIdForAgent } from "./app-server/auth-bridge.js";
import {
  CODEX_CONTROL_METHODS,
  describeControlFailure,
  type CodexControlMethod,
} from "./app-server/capabilities.js";
import {
  resolveCodexAppServerRuntimeOptions,
  type CodexAppServerStartOptions,
} from "./app-server/config.js";
import { listCodexAppServerModels } from "./app-server/models.js";
import type {
  CodexAppServerRequestMethod,
  CodexAppServerRequestParams,
  CodexAppServerRequestResult,
  JsonValue,
} from "./app-server/protocol.js";
import { requestCodexAppServerJson } from "./app-server/request.js";

export type SafeValue<T> = { ok: true; value: T } | { ok: false; error: string };

type AuthProfileOrderConfig = Parameters<
  typeof resolveCodexAppServerAuthProfileIdForAgent
>[0]["config"];

export type CodexControlRequestOptions = {
  config?: AuthProfileOrderConfig;
  authProfileId?: string | null;
  agentDir?: string;
  sessionKey?: string;
  sessionId?: string;
  isolated?: boolean;
  startOptions?: CodexAppServerStartOptions;
  timeoutMs?: number;
};

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
  const runtime = resolveCodexAppServerRuntimeOptions({ pluginConfig });
  return await requestCodexAppServerJson({
    method,
    requestParams,
    timeoutMs: options.timeoutMs ?? runtime.requestTimeoutMs,
    startOptions: options.startOptions ?? runtime.start,
    config: options.config,
    sessionKey: options.sessionKey,
    sessionId: options.sessionId,
    authProfileId: options.authProfileId,
    agentDir: options.agentDir,
    isolated: options.isolated,
  });
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

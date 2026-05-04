import type { resolveCodexAppServerAuthProfileIdForAgent } from "./app-server/auth-bridge.js";
import {
  CODEX_CONTROL_METHODS,
  describeControlFailure,
  type CodexControlMethod,
} from "./app-server/capabilities.js";
import { resolveCodexAppServerRuntimeOptions } from "./app-server/config.js";
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

export function requestOptions(
  pluginConfig: unknown,
  limit: number,
  config?: AuthProfileOrderConfig,
) {
  const runtime = resolveCodexAppServerRuntimeOptions({ pluginConfig });
  return {
    limit,
    timeoutMs: runtime.requestTimeoutMs,
    startOptions: runtime.start,
    config,
  };
}

type CodexControlRequestMethod = CodexControlMethod & CodexAppServerRequestMethod;

export function codexControlRequest<M extends CodexControlRequestMethod>(
  pluginConfig: unknown,
  method: M,
  requestParams: CodexAppServerRequestParams<M>,
  options?: { config?: AuthProfileOrderConfig },
): Promise<CodexAppServerRequestResult<M>>;
export function codexControlRequest(
  pluginConfig: unknown,
  method: CodexControlMethod,
  requestParams?: JsonValue,
  options?: { config?: AuthProfileOrderConfig },
): Promise<JsonValue | undefined>;
export async function codexControlRequest(
  pluginConfig: unknown,
  method: CodexControlMethod,
  requestParams?: unknown,
  options: { config?: AuthProfileOrderConfig } = {},
) {
  const runtime = resolveCodexAppServerRuntimeOptions({ pluginConfig });
  return await requestCodexAppServerJson({
    method,
    requestParams,
    timeoutMs: runtime.requestTimeoutMs,
    startOptions: runtime.start,
    config: options.config,
  });
}

export function safeCodexControlRequest<M extends CodexControlRequestMethod>(
  pluginConfig: unknown,
  method: M,
  requestParams: CodexAppServerRequestParams<M>,
  options?: { config?: AuthProfileOrderConfig },
): Promise<SafeValue<CodexAppServerRequestResult<M>>>;
export function safeCodexControlRequest(
  pluginConfig: unknown,
  method: CodexControlMethod,
  requestParams?: JsonValue,
  options?: { config?: AuthProfileOrderConfig },
): Promise<SafeValue<JsonValue | undefined>>;
export async function safeCodexControlRequest(
  pluginConfig: unknown,
  method: CodexControlMethod,
  requestParams?: unknown,
  options: { config?: AuthProfileOrderConfig } = {},
) {
  return await safeValue(
    async () =>
      await codexControlRequest(pluginConfig, method, requestParams as JsonValue, options),
  );
}

async function safeCodexModelList(
  pluginConfig: unknown,
  limit: number,
  config?: AuthProfileOrderConfig,
) {
  return await safeValue(
    async () => await listCodexAppServerModels(requestOptions(pluginConfig, limit, config)),
  );
}

export async function readCodexStatusProbes(
  pluginConfig: unknown,
  config?: AuthProfileOrderConfig,
) {
  const [models, account, limits, mcps, skills] = await Promise.all([
    safeCodexModelList(pluginConfig, 20, config),
    safeCodexControlRequest(
      pluginConfig,
      CODEX_CONTROL_METHODS.account,
      { refreshToken: false },
      { config },
    ),
    safeCodexControlRequest(pluginConfig, CODEX_CONTROL_METHODS.rateLimits, undefined, { config }),
    safeCodexControlRequest(
      pluginConfig,
      CODEX_CONTROL_METHODS.listMcpServers,
      { limit: 100 },
      { config },
    ),
    safeCodexControlRequest(pluginConfig, CODEX_CONTROL_METHODS.listSkills, {}, { config }),
  ]);

  return { models, account, limits, mcps, skills };
}

export async function safeValue<T>(read: () => Promise<T>): Promise<SafeValue<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    return { ok: false, error: describeControlFailure(error) };
  }
}

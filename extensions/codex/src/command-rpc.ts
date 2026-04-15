import {
  CODEX_CONTROL_METHODS,
  describeControlFailure,
  type CodexControlMethod,
} from "./app-server/capabilities.js";
import { resolveCodexAppServerRuntimeOptions } from "./app-server/config.js";
import { listCodexAppServerModels } from "./app-server/models.js";
import type { JsonValue } from "./app-server/protocol.js";
import { requestCodexAppServerJson } from "./app-server/request.js";

export type SafeValue<T> = { ok: true; value: T } | { ok: false; error: string };

export function requestOptions(pluginConfig: unknown, limit: number) {
  const runtime = resolveCodexAppServerRuntimeOptions({ pluginConfig });
  return {
    limit,
    timeoutMs: runtime.requestTimeoutMs,
    startOptions: runtime.start,
  };
}

export async function codexControlRequest(
  pluginConfig: unknown,
  method: CodexControlMethod,
  requestParams?: JsonValue,
): Promise<JsonValue | undefined> {
  const runtime = resolveCodexAppServerRuntimeOptions({ pluginConfig });
  return await requestCodexAppServerJson({
    method,
    requestParams,
    timeoutMs: runtime.requestTimeoutMs,
    startOptions: runtime.start,
  });
}

export async function safeCodexControlRequest(
  pluginConfig: unknown,
  method: CodexControlMethod,
  requestParams?: JsonValue,
): Promise<SafeValue<JsonValue | undefined>> {
  return await safeValue(
    async () => await codexControlRequest(pluginConfig, method, requestParams),
  );
}

export async function safeCodexModelList(pluginConfig: unknown, limit: number) {
  return await safeValue(
    async () => await listCodexAppServerModels(requestOptions(pluginConfig, limit)),
  );
}

export async function readCodexStatusProbes(pluginConfig: unknown) {
  const [models, account, limits, mcps, skills] = await Promise.all([
    safeCodexModelList(pluginConfig, 20),
    safeCodexControlRequest(pluginConfig, CODEX_CONTROL_METHODS.account, {}),
    safeCodexControlRequest(pluginConfig, CODEX_CONTROL_METHODS.rateLimits, {}),
    safeCodexControlRequest(pluginConfig, CODEX_CONTROL_METHODS.listMcpServers, { limit: 100 }),
    safeCodexControlRequest(pluginConfig, CODEX_CONTROL_METHODS.listSkills, {}),
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

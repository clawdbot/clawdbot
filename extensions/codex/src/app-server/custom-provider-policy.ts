import type { AgentHarnessSupportContext } from "openclaw/plugin-sdk/agent-harness-runtime";
import { readCodexPluginConfig } from "./config-parsing.js";
import {
  normalizeCodexCustomProviderBaseUrl,
  normalizeCodexCustomProviderId,
  type CodexCustomProviderBinding,
} from "./custom-provider.js";

type CustomProviderRoute = {
  api?: string;
  baseUrl?: string;
  authRequirement?: string;
  requestTransportOverrides?: string;
  runtimePolicy?: { compatibleIds: readonly string[] };
};

/** Admission is provisional: the process must verify the native route before inference. */
function resolveCodexCustomProviderRouteUrl(
  route: CustomProviderRoute | undefined,
): string | undefined {
  if (
    route?.api !== "openai-responses" ||
    route.requestTransportOverrides === "present" ||
    (route.runtimePolicy && !route.runtimePolicy.compatibleIds.includes("codex")) ||
    (route.authRequirement !== undefined && route.authRequirement !== "api-key")
  ) {
    return undefined;
  }
  return normalizeCodexCustomProviderBaseUrl(route.baseUrl);
}

export function supportsCodexCustomProvider(
  ctx: AgentHarnessSupportContext,
  pluginConfig: unknown,
): boolean {
  const appServer = readCodexPluginConfig(pluginConfig).appServer;
  const auth = ctx.modelProvider?.preparedAuth;
  return Boolean(
    normalizeCodexCustomProviderId(ctx.provider) &&
    (appServer?.transport === undefined || appServer.transport === "stdio") &&
    appServer?.homeScope !== "user" &&
    resolveCodexCustomProviderRouteUrl({
      ...ctx.modelProvider,
      authRequirement: auth?.requirement,
    }) &&
    !ctx.modelProvider?.azureApiVersion &&
    !ctx.modelProvider?.request &&
    (!auth ||
      ((auth.source === "profile" || auth.source === "direct") &&
        (auth.mode === "api-key" || auth.mode === "api_key"))),
  );
}

/** Reject custom routes that lack a prepared API key or matching native transport. */
export function resolveCodexCustomProviderBinding(params: {
  provider: string;
  route?: CustomProviderRoute;
  preparedModel?: { api?: string; baseUrl?: string; headers?: Record<string, string> };
  preparedAuthMode?: string;
  pluginConfig: unknown;
}): CodexCustomProviderBinding | undefined {
  const id = params.provider.trim().toLowerCase();
  if (id === "codex" || id === "openai") {
    return undefined;
  }
  const provider = normalizeCodexCustomProviderId(params.provider);
  const appServer = readCodexPluginConfig(params.pluginConfig).appServer;
  // Generic providers have no modelRoute; use the resolved model and auth mode.
  const route =
    params.route ??
    (params.preparedModel
      ? {
          api: params.preparedModel.api,
          baseUrl: params.preparedModel.baseUrl,
          authRequirement:
            params.preparedAuthMode === "api-key" || params.preparedAuthMode === "api_key"
              ? "api-key"
              : undefined,
        }
      : undefined);
  const baseUrl = resolveCodexCustomProviderRouteUrl(route);
  if (
    !provider ||
    !baseUrl ||
    !appServer?.providerIds?.some(
      (configuredId) => configuredId.trim().toLowerCase() === provider,
    ) ||
    (appServer.transport !== undefined && appServer.transport !== "stdio") ||
    appServer.homeScope === "user" ||
    route?.authRequirement !== "api-key" ||
    Object.keys(params.preparedModel?.headers ?? {}).length > 0
  ) {
    throw new Error(
      "Configured Codex providers require an allowlisted, prepared Responses API-key route on agent-home stdio.",
    );
  }
  return { provider, baseUrl };
}

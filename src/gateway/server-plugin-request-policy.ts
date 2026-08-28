import { getActivePluginRegistry } from "../plugins/runtime.js";
import type { PluginOrigin } from "../plugins/types.js";
import { normalizeOperatorScopeList, type OperatorScope } from "./operator-scopes.js";

export function canTrustedOfficialPluginRequestScopes(params: {
  pluginId?: string;
  pluginOrigin?: PluginOrigin;
  pluginTrustedOfficialInstall?: boolean;
}): boolean {
  if (!params.pluginId) {
    return false;
  }
  if (params.pluginOrigin === "bundled" || params.pluginTrustedOfficialInstall === true) {
    return true;
  }
  const registry = getActivePluginRegistry();
  const record = registry?.plugins.find((entry) => entry.id === params.pluginId);
  return record?.origin === "bundled" || record?.trustedOfficialInstall === true;
}

export function normalizeTrustedPluginBrowserRequest(params: {
  method: string;
  params: Record<string, unknown>;
  scopes?: string[];
}): {
  params: Record<string, unknown>;
  dispatchOptions: {
    browserRequestCompatibility?: true;
    syntheticScopes?: OperatorScope[];
  };
} {
  const browserRequestCompatibility =
    params.method === "browser.request" && params.params.legacyMeetingRuntime === true;
  const gatewayParams = browserRequestCompatibility ? { ...params.params } : params.params;
  if (browserRequestCompatibility) {
    delete gatewayParams.legacyMeetingRuntime;
  }
  const syntheticScopes = normalizeOperatorScopeList(params.scopes);
  return {
    params: gatewayParams,
    dispatchOptions: {
      ...(browserRequestCompatibility ? { browserRequestCompatibility: true } : {}),
      ...(syntheticScopes ? { syntheticScopes } : {}),
    },
  };
}

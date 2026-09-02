import {
  createLazyRuntimeModule,
  createLazyRuntimeSurface,
} from "openclaw/plugin-sdk/lazy-runtime";
import { resolveNodeHostExecutable } from "openclaw/plugin-sdk/node-host";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  createSessionCatalogNodeHostBindings,
  type SessionCatalogProvider,
} from "openclaw/plugin-sdk/session-catalog";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  PI_SESSIONS_CAPABILITY,
  PI_SESSIONS_LIST_COMMAND,
  PI_SESSION_ID_PATTERN,
  PI_SESSION_READ_COMMAND,
  PI_TERMINAL_RESUME_COMMAND,
} from "./pi-session-catalog-shared.js";
import { piSessionStoreAvailable } from "./pi-session-paths.js";

const loadPiSessionCatalogModule = createLazyRuntimeModule(
  () => import("./pi-session-catalog-runtime.js"),
);

function fullConfigCatalogEnabled(config: unknown): boolean {
  if (!isRecord(config) || !isRecord(config.plugins) || !isRecord(config.plugins.entries)) {
    return true;
  }
  const entry = config.plugins.entries.acpx;
  if (!isRecord(entry) || !isRecord(entry.config) || !isRecord(entry.config.piSessionCatalog)) {
    return true;
  }
  return entry.config.piSessionCatalog.enabled !== false;
}

function isPiSessionCatalogEnabled(pluginConfig: unknown): boolean {
  return (
    !isRecord(pluginConfig) ||
    !isRecord(pluginConfig.piSessionCatalog) ||
    pluginConfig.piSessionCatalog.enabled !== false
  );
}

function createPiSessionNodeHostBindings() {
  const storeAvailable = ({ config, env }: { config: unknown; env: NodeJS.ProcessEnv }) =>
    fullConfigCatalogEnabled(config) && piSessionStoreAvailable(env);
  return createSessionCatalogNodeHostBindings({
    capability: PI_SESSIONS_CAPABILITY,
    listCommand: PI_SESSIONS_LIST_COMMAND,
    readCommand: PI_SESSION_READ_COMMAND,
    terminalCommand: PI_TERMINAL_RESUME_COMMAND,
    sessionIdPattern: PI_SESSION_ID_PATTERN,
    executable: "pi",
    args: (threadId) => ["--session", threadId],
    listAvailable: storeAvailable,
    terminalAvailable: ({ config, env }) =>
      storeAvailable({ config, env }) &&
      Boolean(
        resolveNodeHostExecutable("pi", {
          env,
          pathEnv: env.PATH ?? env.Path ?? "",
          strategy: "direct",
        }),
      ),
    parseParams: (paramsJSON) => {
      if (!paramsJSON) {
        return undefined;
      }
      try {
        return JSON.parse(paramsJSON) as unknown;
      } catch (error) {
        throw new Error("Pi session parameters must be valid JSON", { cause: error });
      }
    },
    list: async (params) => await (await loadPiSessionCatalogModule()).listPiSessions(params),
    read: async (params) => await (await loadPiSessionCatalogModule()).readPiSession(params),
    requireSession: async (threadId) =>
      await (await loadPiSessionCatalogModule()).requireLocalPiSession(threadId),
    terminalIoRequiredMessage: "Pi terminal command requires duplex transport",
    terminalUnavailableMessage: "Pi CLI is unavailable",
    invalidThreadIdMessage: "INVALID_REQUEST: threadId is invalid",
  });
}

export function registerPiSessionCatalog(api: OpenClawPluginApi): void {
  if (!isPiSessionCatalogEnabled(api.pluginConfig)) {
    return;
  }
  const loadCatalogRuntime = createLazyRuntimeSurface(loadPiSessionCatalogModule, (module) =>
    module.createPiSessionCatalogRuntime(api),
  );
  const provider: SessionCatalogProvider = {
    id: "pi",
    label: "Pi",
    supportsProcessHomeIsolation: true,
    list: async (query) => await (await loadCatalogRuntime()).list(query),
    read: async (request) => await (await loadCatalogRuntime()).read(request),
    continueSession: async (request) => await (await loadCatalogRuntime()).continueSession(request),
    checkUpstreamActivity: async (probes, policy) =>
      await (await loadCatalogRuntime()).checkUpstreamActivity(probes, policy),
    openTerminal: async (request) => await (await loadCatalogRuntime()).openTerminal(request),
  };
  api.registerSessionCatalog(provider);
  const nodeHost = createPiSessionNodeHostBindings();
  for (const command of nodeHost.commands) {
    api.registerNodeHostCommand(command);
  }
  for (const policy of nodeHost.policies) {
    api.registerNodeInvokePolicy(policy);
  }
}

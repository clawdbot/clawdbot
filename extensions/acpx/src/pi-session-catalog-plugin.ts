import {
  createLazyRuntimeModule,
  createLazyRuntimeSurface,
} from "openclaw/plugin-sdk/lazy-runtime";
import { resolveNodeHostExecutable } from "openclaw/plugin-sdk/node-host";
import type {
  OpenClawPluginApi,
  OpenClawPluginNodeHostCommand,
  OpenClawPluginNodeInvokePolicy,
} from "openclaw/plugin-sdk/plugin-entry";
import type { SessionCatalogProvider } from "openclaw/plugin-sdk/session-catalog";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  PI_SESSIONS_LIST_COMMAND,
  PI_SESSION_READ_COMMAND,
  PI_TERMINAL_RESUME_COMMAND,
} from "./pi-session-catalog-shared.js";
import { piSessionStoreAvailable } from "./pi-session-paths.js";

const PI_SESSIONS_CAPABILITY = "pi-sessions";
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

function createPiSessionNodeHostCommands(): OpenClawPluginNodeHostCommand[] {
  const storeAvailable = ({ config, env }: { config: unknown; env: NodeJS.ProcessEnv }) =>
    fullConfigCatalogEnabled(config) && piSessionStoreAvailable(env);
  return [
    {
      command: PI_SESSIONS_LIST_COMMAND,
      cap: PI_SESSIONS_CAPABILITY,
      dangerous: false,
      isAvailable: storeAvailable,
      handle: async (paramsJSON) =>
        await (await loadPiSessionCatalogModule()).listPiSessions(paramsJSON),
    },
    {
      command: PI_SESSION_READ_COMMAND,
      cap: PI_SESSIONS_CAPABILITY,
      dangerous: false,
      isAvailable: storeAvailable,
      handle: async (paramsJSON) =>
        await (await loadPiSessionCatalogModule()).readPiSession(paramsJSON),
    },
    {
      command: PI_TERMINAL_RESUME_COMMAND,
      cap: PI_SESSIONS_CAPABILITY,
      dangerous: false,
      duplex: true,
      isAvailable: ({ config, env }) =>
        storeAvailable({ config, env }) &&
        Boolean(
          resolveNodeHostExecutable("pi", {
            env,
            pathEnv: env.PATH ?? env.Path ?? "",
            strategy: "direct",
          }),
        ),
      handle: async (paramsJSON, io) =>
        await (await loadPiSessionCatalogModule()).resumePiSession(paramsJSON, io),
    },
  ];
}

function createPiSessionNodeInvokePolicies(): OpenClawPluginNodeInvokePolicy[] {
  return [
    {
      commands: [PI_SESSIONS_LIST_COMMAND, PI_SESSION_READ_COMMAND, PI_TERMINAL_RESUME_COMMAND],
      defaultPlatforms: ["macos", "linux", "windows"],
      handle: (context) =>
        context.command === PI_TERMINAL_RESUME_COMMAND ? { ok: true } : context.invokeNode(),
    },
  ];
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
  for (const command of createPiSessionNodeHostCommands()) {
    api.registerNodeHostCommand(command);
  }
  for (const policy of createPiSessionNodeInvokePolicies()) {
    api.registerNodeInvokePolicy(policy);
  }
}

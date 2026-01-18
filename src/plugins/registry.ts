import type { AnyAgentTool } from "../agents/tools/common.js";
import type { ChannelDock } from "../channels/dock.js";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import type {
  GatewayRequestHandler,
  GatewayRequestHandlers,
} from "../gateway/server-methods/types.js";
import { registerInternalHook } from "../hooks/internal-hooks.js";
import { resolveUserPath } from "../utils.js";
import type {
  ClawdbotPluginApi,
  ClawdbotPluginChannelRegistration,
  ClawdbotPluginCliRegistrar,
  ClawdbotPluginHttpHandler,
  ClawdbotPluginHookOptions,
  ProviderPlugin,
  ClawdbotPluginService,
  ClawdbotPluginToolContext,
  ClawdbotPluginToolFactory,
  PluginConfigUiHint,
  PluginDiagnostic,
  PluginLogger,
  PluginOrigin,
  PluginKind,
  PluginHookName,
  PluginHookHandlerMap,
  PluginHookRegistration as TypedPluginHookRegistration,
} from "./types.js";
import type { PluginRuntime } from "./runtime/types.js";
import type { HookEntry } from "../hooks/types.js";
import path from "node:path";

export type PluginToolRegistration = {
  pluginId: string;
  factory: ClawdbotPluginToolFactory;
  names: string[];
  optional: boolean;
  source: string;
};

export type PluginCliRegistration = {
  pluginId: string;
  register: ClawdbotPluginCliRegistrar;
  commands: string[];
  source: string;
};

export type PluginHttpRegistration = {
  pluginId: string;
  handler: ClawdbotPluginHttpHandler;
  source: string;
};

export type PluginChannelRegistration = {
  pluginId: string;
  plugin: ChannelPlugin;
  dock?: ChannelDock;
  source: string;
};

export type PluginProviderRegistration = {
  pluginId: string;
  provider: ProviderPlugin;
  source: string;
};

export type PluginHookRegistration = {
  pluginId: string;
  entry: HookEntry;
  events: string[];
  source: string;
};

export type PluginServiceRegistration = {
  pluginId: string;
  service: ClawdbotPluginService;
  source: string;
};

export type PluginRecord = {
  id: string;
  name: string;
  version?: string;
  description?: string;
  kind?: PluginKind;
  source: string;
  origin: PluginOrigin;
  workspaceDir?: string;
  enabled: boolean;
  status: "loaded" | "disabled" | "error";
  error?: string;
  toolNames: string[];
  hookNames: string[];
  channelIds: string[];
  providerIds: string[];
  gatewayMethods: string[];
  cliCommands: string[];
  services: string[];
  httpHandlers: number;
  hookCount: number;
  configSchema: boolean;
  configUiHints?: Record<string, PluginConfigUiHint>;
  configJsonSchema?: Record<string, unknown>;
};

export type PluginRegistry = {
  plugins: PluginRecord[];
  tools: PluginToolRegistration[];
  hooks: PluginHookRegistration[];
  typedHooks: TypedPluginHookRegistration[];
  channels: PluginChannelRegistration[];
  providers: PluginProviderRegistration[];
  gatewayHandlers: GatewayRequestHandlers;
  httpHandlers: PluginHttpRegistration[];
  cliRegistrars: PluginCliRegistration[];
  services: PluginServiceRegistration[];
  diagnostics: PluginDiagnostic[];
};

export type PluginRegistryParams = {
  logger: PluginLogger;
  coreGatewayHandlers?: GatewayRequestHandlers;
  runtime: PluginRuntime;
};

export function createPluginRegistry(registryParams: PluginRegistryParams) {
  const registry: PluginRegistry = {
    plugins: [],
    tools: [],
    hooks: [],
    typedHooks: [],
    channels: [],
    providers: [],
    gatewayHandlers: {},
    httpHandlers: [],
    cliRegistrars: [],
    services: [],
    diagnostics: [],
  };
  const coreGatewayMethods = new Set(Object.keys(registryParams.coreGatewayHandlers ?? {}));

  const pushDiagnostic = (diag: PluginDiagnostic) => {
    registry.diagnostics.push(diag);
  };

  const registerTool = (
    record: PluginRecord,
    tool: AnyAgentTool | ClawdbotPluginToolFactory,
    opts?: { name?: string; names?: string[]; optional?: boolean },
  ) => {
    const names = opts?.names ?? (opts?.name ? [opts.name] : []);
    const optional = opts?.optional === true;
    const factory: ClawdbotPluginToolFactory =
      typeof tool === "function" ? tool : (_ctx: ClawdbotPluginToolContext) => tool;

    if (typeof tool !== "function") {
      names.push(tool.name);
    }

    const normalized = names.map((name) => name.trim()).filter(Boolean);
    if (normalized.length > 0) {
      record.toolNames.push(...normalized);
    }
    registry.tools.push({
      pluginId: record.id,
      factory,
      names: normalized,
      optional,
      source: record.source,
    });
  };

  const registerHook = (
    record: PluginRecord,
    events: string | string[],
    handler: Parameters<typeof registerInternalHook>[1],
    opts: ClawdbotPluginHookOptions | undefined,
    config: ClawdbotPluginApi["config"],
  ) => {
    const eventList = Array.isArray(events) ? events : [events];
    const normalizedEvents = eventList.map((event) => event.trim()).filter(Boolean);
    const entry = opts?.entry ?? null;
    const name = entry?.hook.name ?? opts?.name?.trim();
    if (!name) {
      pushDiagnostic({
        level: "warn",
        pluginId: record.id,
        source: record.source,
        message: "hook registration missing name",
      });
      return;
    }

    const description = entry?.hook.description ?? opts?.description ?? "";
    const hookEntry: HookEntry = entry
      ? {
          ...entry,
          hook: {
            ...entry.hook,
            name,
            description,
            source: "clawdbot-plugin",
            pluginId: record.id,
          },
          clawdbot: {
            ...entry.clawdbot,
            events: normalizedEvents,
          },
        }
      : {
          hook: {
            name,
            description,
            source: "clawdbot-plugin",
            pluginId: record.id,
            filePath: record.source,
            baseDir: path.dirname(record.source),
            handlerPath: record.source,
          },
          frontmatter: {},
          clawdbot: { events: normalizedEvents },
          invocation: { enabled: true },
        };

    record.hookNames.push(name);
    registry.hooks.push({
      pluginId: record.id,
      entry: hookEntry,
      events: normalizedEvents,
      source: record.source,
    });

    const hookSystemEnabled = config?.hooks?.internal?.enabled === true;
    if (!hookSystemEnabled || opts?.register === false) {
      return;
    }

    for (const event of normalizedEvents) {
      registerInternalHook(event, handler);
    }
  };

  const registerGatewayMethod = (
    record: PluginRecord,
    method: string,
    handler: GatewayRequestHandler,
  ) => {
    const trimmed = method.trim();
    if (!trimmed) return;
    if (coreGatewayMethods.has(trimmed) || registry.gatewayHandlers[trimmed]) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `gateway method already registered: ${trimmed}`,
      });
      return;
    }
    registry.gatewayHandlers[trimmed] = handler;
    record.gatewayMethods.push(trimmed);
  };

  const registerHttpHandler = (record: PluginRecord, handler: ClawdbotPluginHttpHandler) => {
    record.httpHandlers += 1;
    registry.httpHandlers.push({
      pluginId: record.id,
      handler,
      source: record.source,
    });
  };

  const registerChannel = (
    record: PluginRecord,
    registration: ClawdbotPluginChannelRegistration | ChannelPlugin,
  ) => {
    const normalized =
      typeof (registration as ClawdbotPluginChannelRegistration).plugin === "object"
        ? (registration as ClawdbotPluginChannelRegistration)
        : { plugin: registration as ChannelPlugin };
    const plugin = normalized.plugin;
    const id = typeof plugin?.id === "string" ? plugin.id.trim() : String(plugin?.id ?? "").trim();
    if (!id) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "channel registration missing id",
      });
      return;
    }
    record.channelIds.push(id);
    registry.channels.push({
      pluginId: record.id,
      plugin,
      dock: normalized.dock,
      source: record.source,
    });
  };

  const registerProvider = (record: PluginRecord, provider: ProviderPlugin) => {
    const id = typeof provider?.id === "string" ? provider.id.trim() : "";
    if (!id) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "provider registration missing id",
      });
      return;
    }
    const existing = registry.providers.find((entry) => entry.provider.id === id);
    if (existing) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `provider already registered: ${id} (${existing.pluginId})`,
      });
      return;
    }
    record.providerIds.push(id);
    registry.providers.push({
      pluginId: record.id,
      provider,
      source: record.source,
    });
  };

  const registerCli = (
    record: PluginRecord,
    registrar: ClawdbotPluginCliRegistrar,
    opts?: { commands?: string[] },
  ) => {
    const commands = (opts?.commands ?? []).map((cmd) => cmd.trim()).filter(Boolean);
    record.cliCommands.push(...commands);
    registry.cliRegistrars.push({
      pluginId: record.id,
      register: registrar,
      commands,
      source: record.source,
    });
  };

  const registerService = (record: PluginRecord, service: ClawdbotPluginService) => {
    const id = service.id.trim();
    if (!id) return;
    record.services.push(id);
    registry.services.push({
      pluginId: record.id,
      service,
      source: record.source,
    });
  };

  const registerTypedHook = <K extends PluginHookName>(
    record: PluginRecord,
    hookName: K,
    handler: PluginHookHandlerMap[K],
    opts?: { priority?: number },
  ) => {
    record.hookCount += 1;
    registry.typedHooks.push({
      pluginId: record.id,
      hookName,
      handler,
      priority: opts?.priority,
      source: record.source,
    } as TypedPluginHookRegistration);
  };

  const normalizeLogger = (logger: PluginLogger): PluginLogger => ({
    info: logger.info,
    warn: logger.warn,
    error: logger.error,
    debug: logger.debug,
  });

  const createApi = (
    record: PluginRecord,
    params: {
      config: ClawdbotPluginApi["config"];
      pluginConfig?: Record<string, unknown>;
    },
  ): ClawdbotPluginApi => {
    return {
      id: record.id,
      name: record.name,
      version: record.version,
      description: record.description,
      source: record.source,
      config: params.config,
      pluginConfig: params.pluginConfig,
      runtime: registryParams.runtime,
      logger: normalizeLogger(registryParams.logger),
      registerTool: (tool, opts) => registerTool(record, tool, opts),
      registerHook: (events, handler, opts) =>
        registerHook(record, events, handler, opts, params.config),
      registerHttpHandler: (handler) => registerHttpHandler(record, handler),
      registerChannel: (registration) => registerChannel(record, registration),
      registerProvider: (provider) => registerProvider(record, provider),
      registerGatewayMethod: (method, handler) => registerGatewayMethod(record, method, handler),
      registerCli: (registrar, opts) => registerCli(record, registrar, opts),
      registerService: (service) => registerService(record, service),
      resolvePath: (input: string) => resolveUserPath(input),
      on: (hookName, handler, opts) => registerTypedHook(record, hookName, handler, opts),
    };
  };

  return {
    registry,
    createApi,
    pushDiagnostic,
    registerTool,
    registerChannel,
    registerProvider,
    registerGatewayMethod,
    registerCli,
    registerService,
    registerHook,
    registerTypedHook,
  };
}

import path from "node:path";
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import {
  getRegisteredAgentHarness,
  registerAgentHarness as registerGlobalAgentHarness,
} from "../agents/harness/registry.js";
import type { AgentHarness } from "../agents/harness/types.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import {
  clearContextEnginesForOwner,
  registerContextEngineForOwner,
} from "../context-engine/registry.js";
import type { OperatorScope } from "../gateway/operator-scopes.js";
import type { GatewayRequestHandler } from "../gateway/server-methods/types.js";
import { registerInternalHook, unregisterInternalHook } from "../hooks/internal-hooks.js";
import type { HookEntry } from "../hooks/types.js";
import {
  NODE_EXEC_APPROVALS_COMMANDS,
  NODE_SYSTEM_NOTIFY_COMMAND,
  NODE_SYSTEM_RUN_COMMANDS,
} from "../infra/node-commands.js";
import { normalizePluginGatewayMethodScope } from "../shared/gateway-method-policy.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import {
  getDetachedTaskLifecycleRuntimeRegistration,
  registerDetachedTaskLifecycleRuntime,
} from "../tasks/detached-task-runtime-state.js";
import { resolveUserPath } from "../utils.js";
import { buildPluginApi } from "./api-builder.js";
import { normalizeRegisteredChannelPlugin } from "./channel-validation.js";
import { CODEX_APP_SERVER_EXTENSION_RUNTIME_ID } from "./codex-app-server-extension-factory.js";
import type { CodexAppServerExtensionFactory } from "./codex-app-server-extension-types.js";
import { registerPluginCommand, validatePluginCommandDefinition } from "./command-registration.js";
import { clearPluginCommandsForPlugin } from "./command-registry-state.js";
import {
  getRegisteredCompactionProvider,
  registerCompactionProvider,
} from "./compaction-provider.js";
import { PI_EMBEDDED_EXTENSION_RUNTIME_ID } from "./embedded-extension-factory.js";
import { normalizePluginHttpPath } from "./http-path.js";
import { findOverlappingPluginHttpRoute } from "./http-route-overlap.js";
import {
  clearPluginInteractiveHandlersForPlugin,
  registerPluginInteractiveHandler,
} from "./interactive-registry.js";
import type { PluginDiagnostic } from "./manifest-types.js";
import {
  getRegisteredMemoryEmbeddingProvider,
  registerMemoryEmbeddingProvider,
} from "./memory-embedding-providers.js";
import {
  registerMemoryCapability,
  registerMemoryCorpusSupplement,
  registerMemoryFlushPlanResolver,
  registerMemoryPromptSupplement,
  registerMemoryPromptSection,
  registerMemoryRuntime,
} from "./memory-state.js";
import { normalizeRegisteredProvider } from "./provider-validation.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import type {
  PluginCliBackendRegistration,
  PluginCliRegistration,
  PluginCommandRegistration,
  PluginConversationBindingResolvedHandlerRegistration,
  PluginHookRegistration,
  PluginHttpRouteRegistration as RegistryTypesPluginHttpRouteRegistration,
  PluginAgentHarnessRegistration,
  PluginMemoryEmbeddingProviderRegistration,
  PluginNodeHostCommandRegistration,
  PluginProviderRegistration,
  PluginRecord,
  PluginRegistry,
  PluginRegistryParams,
  PluginReloadRegistration,
  PluginSecurityAuditCollectorRegistration,
  PluginServiceRegistration,
  PluginTextTransformsRegistration,
} from "./registry-types.js";
import { withPluginRuntimePluginIdScope } from "./runtime/gateway-request-scope.js";
import type { PluginRuntime } from "./runtime/types.js";
import { defaultSlotIdForKey, hasKind } from "./slots.js";
import {
  isConversationHookName,
  isPluginHookName,
  isPromptInjectionHookName,
  stripPromptMutationFieldsFromLegacyHookResult,
} from "./types.js";
import type {
  CliBackendPlugin,
  ImageGenerationProviderPlugin,
  MusicGenerationProviderPlugin,
  OpenClawPluginApi,
  OpenClawPluginChannelRegistration,
  OpenClawPluginCliCommandDescriptor,
  OpenClawPluginCliRegistrar,
  OpenClawPluginCommandDefinition,
  PluginConversationBindingResolvedEvent,
  OpenClawPluginGatewayRuntimeScopeSurface,
  OpenClawGatewayDiscoveryService,
  OpenClawPluginHttpRouteParams,
  OpenClawPluginHookOptions,
  OpenClawPluginNodeHostCommand,
  OpenClawPluginReloadRegistration,
  OpenClawPluginSecurityAuditCollector,
  MediaUnderstandingProviderPlugin,
  OpenClawPluginService,
  OpenClawPluginToolContext,
  OpenClawPluginToolFactory,
  PluginHookHandlerMap,
  PluginHookName,
  PluginHookRegistration as TypedPluginHookRegistration,
  PluginLogger,
  PluginRegistrationMode,
  ProviderPlugin,
  RealtimeTranscriptionProviderPlugin,
  RealtimeVoiceProviderPlugin,
  SpeechProviderPlugin,
  VideoGenerationProviderPlugin,
  WebFetchProviderPlugin,
  WebSearchProviderPlugin,
} from "./types.js";

export type PluginHttpRouteRegistration = RegistryTypesPluginHttpRouteRegistration & {
  gatewayRuntimeScopeSurface?: OpenClawPluginGatewayRuntimeScopeSurface;
};
type PluginOwnedProviderRegistration<T extends { id: string }> = {
  pluginId: string;
  pluginName?: string;
  provider: T;
  source: string;
  rootDir?: string;
};

export type {
  PluginChannelRegistration,
  PluginChannelSetupRegistration,
  PluginCliBackendRegistration,
  PluginCliRegistration,
  PluginCommandRegistration,
  PluginConversationBindingResolvedHandlerRegistration,
  PluginHookRegistration,
  PluginAgentHarnessRegistration,
  PluginMemoryEmbeddingProviderRegistration,
  PluginNodeHostCommandRegistration,
  PluginProviderRegistration,
  PluginRecord,
  PluginRegistry,
  PluginRegistryParams,
  PluginReloadRegistration,
  PluginSecurityAuditCollectorRegistration,
  PluginServiceRegistration,
  PluginTextTransformsRegistration,
  PluginToolRegistration,
  PluginSpeechProviderRegistration,
  PluginRealtimeTranscriptionProviderRegistration,
  PluginRealtimeVoiceProviderRegistration,
  PluginMediaUnderstandingProviderRegistration,
  PluginImageGenerationProviderRegistration,
  PluginVideoGenerationProviderRegistration,
  PluginMusicGenerationProviderRegistration,
  PluginWebFetchProviderRegistration,
  PluginWebSearchProviderRegistration,
} from "./registry-types.js";

type PluginTypedHookPolicy = {
  allowPromptInjection?: boolean;
  allowConversationAccess?: boolean;
};

const constrainLegacyPromptInjectionHook = (
  handler: PluginHookHandlerMap["before_agent_start"],
): PluginHookHandlerMap["before_agent_start"] => {
  return (event, ctx) => {
    const result = handler(event, ctx);
    if (result && typeof result === "object" && "then" in result) {
      return Promise.resolve(result).then((resolved) =>
        stripPromptMutationFieldsFromLegacyHookResult(resolved),
      );
    }
    return stripPromptMutationFieldsFromLegacyHookResult(result);
  };
};

export { createEmptyPluginRegistry } from "./registry-empty.js";

const ACTIVE_PLUGIN_HOOK_REGISTRATIONS_KEY = Symbol.for("openclaw.activePluginHookRegistrations");
const activePluginHookRegistrations = resolveGlobalSingleton<
  Map<string, Array<{ event: string; handler: Parameters<typeof registerInternalHook>[1] }>>
>(ACTIVE_PLUGIN_HOOK_REGISTRATIONS_KEY, () => new Map());

type HookRegistration = { event: string; handler: Parameters<typeof registerInternalHook>[1] };
type HookRollbackEntry = { name: string; previousRegistrations: HookRegistration[] };

export function createPluginRegistry(registryParams: PluginRegistryParams) {
  const registry = createEmptyPluginRegistry();
  const coreGatewayMethods = new Set(Object.keys(registryParams.coreGatewayHandlers ?? {}));
  const pluginHookRollback = new Map<string, HookRollbackEntry[]>();

  const pushDiagnostic = (diag: PluginDiagnostic) => {
    registry.diagnostics.push(diag);
  };

  const registerPiEmbeddedExtensionFactory = (
    record: PluginRecord,
    factory: Parameters<OpenClawPluginApi["registerEmbeddedExtensionFactory"]>[0],
  ) => {
    if (record.origin !== "bundled") {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "only bundled plugins can register Pi embedded extension factories",
      });
      return;
    }
    if (
      !(record.contracts?.embeddedExtensionFactories ?? []).includes(
        PI_EMBEDDED_EXTENSION_RUNTIME_ID,
      )
    ) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message:
          'plugin must declare contracts.embeddedExtensionFactories: ["pi"] to register Pi embedded extension factories',
      });
      return;
    }
    if (typeof (factory as unknown) !== "function") {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "embedded extension factory must be a function",
      });
      return;
    }
    if (
      registry.embeddedExtensionFactories.some(
        (entry) => entry.pluginId === record.id && entry.rawFactory === factory,
      )
    ) {
      return;
    }
    const safeFactory: ExtensionFactory = async (pi) => {
      try {
        await factory(pi);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        registryParams.logger.warn(
          `[plugins] embedded extension factory failed for ${record.id}: ${detail}`,
        );
      }
    };
    registry.embeddedExtensionFactories.push({
      pluginId: record.id,
      pluginName: record.name,
      rawFactory: factory,
      factory: safeFactory,
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  const registerCodexAppServerExtensionFactory = (
    record: PluginRecord,
    factory: Parameters<OpenClawPluginApi["registerCodexAppServerExtensionFactory"]>[0],
  ) => {
    if (record.origin !== "bundled") {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "only bundled plugins can register Codex app-server extension factories",
      });
      return;
    }
    if (
      !(record.contracts?.embeddedExtensionFactories ?? []).includes(
        CODEX_APP_SERVER_EXTENSION_RUNTIME_ID,
      )
    ) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message:
          'plugin must declare contracts.embeddedExtensionFactories: ["codex-app-server"] to register Codex app-server extension factories',
      });
      return;
    }
    if (typeof (factory as unknown) !== "function") {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "codex app-server extension factory must be a function",
      });
      return;
    }
    if (
      registry.codexAppServerExtensionFactories.some(
        (entry) => entry.pluginId === record.id && entry.rawFactory === factory,
      )
    ) {
      return;
    }
    const safeFactory: CodexAppServerExtensionFactory = async (codex) => {
      try {
        await factory(codex);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        registryParams.logger.warn(
          `[plugins] codex app-server extension factory failed for ${record.id}: ${detail}`,
        );
      }
    };
    registry.codexAppServerExtensionFactories.push({
      pluginId: record.id,
      pluginName: record.name,
      rawFactory: factory,
      factory: safeFactory,
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  const registerTool = (
    record: PluginRecord,
    tool: AnyAgentTool | OpenClawPluginToolFactory,
    opts?: { name?: string; names?: string[]; optional?: boolean },
  ) => {
    const names = opts?.names ?? (opts?.name ? [opts.name] : []);
    const optional = opts?.optional === true;
    const factory: OpenClawPluginToolFactory =
      typeof tool === "function" ? tool : (_ctx: OpenClawPluginToolContext) => tool;

    if (typeof tool !== "function") {
      names.push(tool.name);
    }

    const normalized = names.map((name) => name.trim()).filter(Boolean);
    if (normalized.length > 0) {
      record.toolNames.push(...normalized);
    }
    registry.tools.push({
      pluginId: record.id,
      pluginName: record.name,
      factory,
      names: normalized,
      optional,
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  const registerHook = (
    record: PluginRecord,
    events: string | string[],
    handler: Parameters<typeof registerInternalHook>[1],
    opts: OpenClawPluginHookOptions | undefined,
    config: OpenClawPluginApi["config"],
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
    const existingHook = registry.hooks.find((entry) => entry.entry.hook.name === name);
    if (existingHook) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `hook already registered: ${name} (${existingHook.pluginId})`,
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
            source: "openclaw-plugin",
            pluginId: record.id,
          },
          metadata: {
            ...entry.metadata,
            events: normalizedEvents,
          },
        }
      : {
          hook: {
            name,
            description,
            source: "openclaw-plugin",
            pluginId: record.id,
            filePath: record.source,
            baseDir: path.dirname(record.source),
            handlerPath: record.source,
          },
          frontmatter: {},
          metadata: { events: normalizedEvents },
          invocation: { enabled: true },
        };

    record.hookNames.push(name);
    registry.hooks.push({
      pluginId: record.id,
      entry: hookEntry,
      events: normalizedEvents,
      source: record.source,
    });

    const hookSystemEnabled = config?.hooks?.internal?.enabled !== false;
    if (
      !registryParams.activateGlobalSideEffects ||
      !hookSystemEnabled ||
      opts?.register === false
    ) {
      return;
    }

    const previousRegistrations = activePluginHookRegistrations.get(name) ?? [];
    for (const registration of previousRegistrations) {
      unregisterInternalHook(registration.event, registration.handler);
    }

    const nextRegistrations: Array<{
      event: string;
      handler: Parameters<typeof registerInternalHook>[1];
    }> = [];
    for (const event of normalizedEvents) {
      registerInternalHook(event, handler);
      nextRegistrations.push({ event, handler });
    }
    activePluginHookRegistrations.set(name, nextRegistrations);
    const rollbackEntries = pluginHookRollback.get(record.id) ?? [];
    rollbackEntries.push({
      name,
      previousRegistrations: [...previousRegistrations],
    });
    pluginHookRollback.set(record.id, rollbackEntries);
  };

  const registerGatewayMethod = (
    record: PluginRecord,
    method: string,
    handler: GatewayRequestHandler,
    opts?: { scope?: OperatorScope },
  ) => {
    const trimmed = method.trim();
    if (!trimmed) {
      return;
    }
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
    const normalizedScope = normalizePluginGatewayMethodScope(trimmed, opts?.scope);
    if (normalizedScope.coercedToReservedAdmin) {
      pushDiagnostic({
        level: "warn",
        pluginId: record.id,
        source: record.source,
        message: `gateway method scope coerced to operator.admin for reserved core namespace: ${trimmed}`,
      });
    }
    const effectiveScope = normalizedScope.scope;
    if (effectiveScope) {
      registry.gatewayMethodScopes ??= {};
      registry.gatewayMethodScopes[trimmed] = effectiveScope;
    }
    record.gatewayMethods.push(trimmed);
  };

  const describeHttpRouteOwner = (entry: PluginHttpRouteRegistration): string => {
    const plugin = normalizeOptionalString(entry.pluginId) || "unknown-plugin";
    const source = normalizeOptionalString(entry.source) || "unknown-source";
    return `${plugin} (${source})`;
  };

  const registerHttpRoute = (record: PluginRecord, params: OpenClawPluginHttpRouteParams) => {
    const normalizedPath = normalizePluginHttpPath(params.path);
    if (!normalizedPath) {
      pushDiagnostic({
        level: "warn",
        pluginId: record.id,
        source: record.source,
        message: "http route registration missing path",
      });
      return;
    }
    if (params.auth !== "gateway" && params.auth !== "plugin") {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `http route registration missing or invalid auth: ${normalizedPath}`,
      });
      return;
    }
    const match = params.match ?? "exact";
    const overlappingRoute = findOverlappingPluginHttpRoute(registry.httpRoutes, {
      path: normalizedPath,
      match,
    });
    if (overlappingRoute && overlappingRoute.auth !== params.auth) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message:
          `http route overlap rejected: ${normalizedPath} (${match}, ${params.auth}) ` +
          `overlaps ${overlappingRoute.path} (${overlappingRoute.match}, ${overlappingRoute.auth}) ` +
          `owned by ${describeHttpRouteOwner(overlappingRoute)}`,
      });
      return;
    }
    const existingIndex = registry.httpRoutes.findIndex(
      (entry) => entry.path === normalizedPath && entry.match === match,
    );
    if (existingIndex >= 0) {
      const existing = registry.httpRoutes[existingIndex];
      if (!existing) {
        return;
      }
      if (!params.replaceExisting) {
        pushDiagnostic({
          level: "error",
          pluginId: record.id,
          source: record.source,
          message: `http route already registered: ${normalizedPath} (${match}) by ${describeHttpRouteOwner(existing)}`,
        });
        return;
      }
      if (existing.pluginId && existing.pluginId !== record.id) {
        pushDiagnostic({
          level: "error",
          pluginId: record.id,
          source: record.source,
          message: `http route replacement rejected: ${normalizedPath} (${match}) owned by ${describeHttpRouteOwner(existing)}`,
        });
        return;
      }
      registry.httpRoutes[existingIndex] = {
        pluginId: record.id,
        path: normalizedPath,
        handler: params.handler,
        auth: params.auth,
        match,
        ...(params.gatewayRuntimeScopeSurface
          ? { gatewayRuntimeScopeSurface: params.gatewayRuntimeScopeSurface }
          : {}),
        source: record.source,
      };
      return;
    }
    record.httpRoutes += 1;
    registry.httpRoutes.push({
      pluginId: record.id,
      path: normalizedPath,
      handler: params.handler,
      auth: params.auth,
      match,
      ...(params.gatewayRuntimeScopeSurface
        ? { gatewayRuntimeScopeSurface: params.gatewayRuntimeScopeSurface }
        : {}),
      source: record.source,
    });
  };

  const registerChannel = (
    record: PluginRecord,
    registration: OpenClawPluginChannelRegistration | ChannelPlugin,
    mode: PluginRegistrationMode = "full",
  ) => {
    const normalized =
      typeof (registration as OpenClawPluginChannelRegistration).plugin === "object"
        ? (registration as OpenClawPluginChannelRegistration)
        : { plugin: registration as ChannelPlugin };
    const plugin = normalizeRegisteredChannelPlugin({
      pluginId: record.id,
      source: record.source,
      plugin: normalized.plugin,
      pushDiagnostic,
    });
    if (!plugin) {
      return;
    }
    const id = plugin.id;
    const existingRuntime = registry.channels.find((entry) => entry.plugin.id === id);
    if (mode !== "setup-only" && existingRuntime) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `channel already registered: ${id} (${existingRuntime.pluginId})`,
      });
      return;
    }
    const existingSetup = registry.channelSetups.find((entry) => entry.plugin.id === id);
    if (existingSetup) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `channel setup already registered: ${id} (${existingSetup.pluginId})`,
      });
      return;
    }
    record.channelIds.push(id);
    registry.channelSetups.push({
      pluginId: record.id,
      pluginName: record.name,
      plugin,
      source: record.source,
      enabled: record.enabled,
      rootDir: record.rootDir,
    });
    if (mode === "setup-only") {
      return;
    }
    registry.channels.push({
      pluginId: record.id,
      pluginName: record.name,
      plugin,
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  const registerProvider = (record: PluginRecord, provider: ProviderPlugin) => {
    const normalizedProvider = normalizeRegisteredProvider({
      pluginId: record.id,
      source: record.source,
      provider,
      pushDiagnostic,
    });
    if (!normalizedProvider) {
      return;
    }
    const id = normalizedProvider.id;
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
      pluginName: record.name,
      provider: normalizedProvider,
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  const registerAgentHarness = (record: PluginRecord, harness: AgentHarness) => {
    const id = harness.id.trim();
    if (!id) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "agent harness registration missing id",
      });
      return;
    }
    const existing =
      registryParams.activateGlobalSideEffects === false
        ? registry.agentHarnesses.find((entry) => entry.harness.id === id)
        : getRegisteredAgentHarness(id);
    if (existing) {
      const ownerPluginId =
        "ownerPluginId" in existing
          ? existing.ownerPluginId
          : "pluginId" in existing
            ? existing.pluginId
            : undefined;
      const ownerDetail = ownerPluginId ? ` (owner: ${ownerPluginId})` : "";
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `agent harness already registered: ${id}${ownerDetail}`,
      });
      return;
    }
    const normalizedHarness = {
      ...harness,
      id,
      pluginId: harness.pluginId ?? record.id,
    };
    if (registryParams.activateGlobalSideEffects !== false) {
      registerGlobalAgentHarness(normalizedHarness, { ownerPluginId: record.id });
    }
    record.agentHarnessIds.push(id);
    registry.agentHarnesses.push({
      pluginId: record.id,
      pluginName: record.name,
      harness: normalizedHarness,
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  const registerCliBackend = (record: PluginRecord, backend: CliBackendPlugin) => {
    const id = backend.id.trim();
    if (!id) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "cli backend registration missing id",
      });
      return;
    }
    const existing = (registry.cliBackends ?? []).find((entry) => entry.backend.id === id);
    if (existing) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `cli backend already registered: ${id} (${existing.pluginId})`,
      });
      return;
    }
    (registry.cliBackends ??= []).push({
      pluginId: record.id,
      pluginName: record.name,
      backend: {
        ...backend,
        id,
      },
      source: record.source,
      rootDir: record.rootDir,
    });
    record.cliBackendIds.push(id);
  };

  const registerTextTransforms = (
    record: PluginRecord,
    transforms: PluginTextTransformsRegistration["transforms"],
  ) => {
    if (
      (!transforms.input || transforms.input.length === 0) &&
      (!transforms.output || transforms.output.length === 0)
    ) {
      pushDiagnostic({
        level: "warn",
        pluginId: record.id,
        source: record.source,
        message: "text transform registration has no input or output replacements",
      });
      return;
    }
    registry.textTransforms.push({
      pluginId: record.id,
      pluginName: record.name,
      transforms,
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  const registerUniqueProviderLike = <T extends { id: string }>(params: {
    record: PluginRecord;
    provider: T;
    kindLabel: string;
    registrations: Array<PluginOwnedProviderRegistration<T>>;
    ownedIds: string[];
  }) => {
    const id = params.provider.id.trim();
    const { record, kindLabel } = params;
    const missingLabel = `${kindLabel} registration missing id`;
    const duplicateLabel = `${kindLabel} already registered: ${id}`;
    if (!id) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: missingLabel,
      });
      return;
    }
    const existing = params.registrations.find((entry) => entry.provider.id === id);
    if (existing) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `${duplicateLabel} (${existing.pluginId})`,
      });
      return;
    }
    params.ownedIds.push(id);
    params.registrations.push({
      pluginId: record.id,
      pluginName: record.name,
      provider: params.provider,
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  const registerSpeechProvider = (record: PluginRecord, provider: SpeechProviderPlugin) => {
    registerUniqueProviderLike({
      record,
      provider,
      kindLabel: "speech provider",
      registrations: registry.speechProviders,
      ownedIds: record.speechProviderIds,
    });
  };

  const registerRealtimeTranscriptionProvider = (
    record: PluginRecord,
    provider: RealtimeTranscriptionProviderPlugin,
  ) => {
    registerUniqueProviderLike({
      record,
      provider,
      kindLabel: "realtime transcription provider",
      registrations: registry.realtimeTranscriptionProviders,
      ownedIds: record.realtimeTranscriptionProviderIds,
    });
  };

  const registerRealtimeVoiceProvider = (
    record: PluginRecord,
    provider: RealtimeVoiceProviderPlugin,
  ) => {
    registerUniqueProviderLike({
      record,
      provider,
      kindLabel: "realtime voice provider",
      registrations: registry.realtimeVoiceProviders,
      ownedIds: record.realtimeVoiceProviderIds,
    });
  };

  const registerMediaUnderstandingProvider = (
    record: PluginRecord,
    provider: MediaUnderstandingProviderPlugin,
  ) => {
    registerUniqueProviderLike({
      record,
      provider,
      kindLabel: "media provider",
      registrations: registry.mediaUnderstandingProviders,
      ownedIds: record.mediaUnderstandingProviderIds,
    });
  };

  const registerImageGenerationProvider = (
    record: PluginRecord,
    provider: ImageGenerationProviderPlugin,
  ) => {
    registerUniqueProviderLike({
      record,
      provider,
      kindLabel: "image-generation provider",
      registrations: registry.imageGenerationProviders,
      ownedIds: record.imageGenerationProviderIds,
    });
  };

  const registerVideoGenerationProvider = (
    record: PluginRecord,
    provider: VideoGenerationProviderPlugin,
  ) => {
    registerUniqueProviderLike({
      record,
      provider,
      kindLabel: "video-generation provider",
      registrations: registry.videoGenerationProviders,
      ownedIds: record.videoGenerationProviderIds,
    });
  };

  const registerMusicGenerationProvider = (
    record: PluginRecord,
    provider: MusicGenerationProviderPlugin,
  ) => {
    registerUniqueProviderLike({
      record,
      provider,
      kindLabel: "music-generation provider",
      registrations: registry.musicGenerationProviders,
      ownedIds: record.musicGenerationProviderIds,
    });
  };

  const registerWebFetchProvider = (record: PluginRecord, provider: WebFetchProviderPlugin) => {
    registerUniqueProviderLike({
      record,
      provider,
      kindLabel: "web fetch provider",
      registrations: registry.webFetchProviders,
      ownedIds: record.webFetchProviderIds,
    });
  };

  const registerWebSearchProvider = (record: PluginRecord, provider: WebSearchProviderPlugin) => {
    registerUniqueProviderLike({
      record,
      provider,
      kindLabel: "web search provider",
      registrations: registry.webSearchProviders,
      ownedIds: record.webSearchProviderIds,
    });
  };

  const registerCli = (
    record: PluginRecord,
    registrar: OpenClawPluginCliRegistrar,
    opts?: { commands?: string[]; descriptors?: OpenClawPluginCliCommandDescriptor[] },
  ) => {
    const descriptors = (opts?.descriptors ?? [])
      .map((descriptor) => ({
        name: descriptor.name.trim(),
        description: descriptor.description.trim(),
        hasSubcommands: descriptor.hasSubcommands,
      }))
      .filter((descriptor) => descriptor.name && descriptor.description);
    const commands = [
      ...(opts?.commands ?? []),
      ...descriptors.map((descriptor) => descriptor.name),
    ]
      .map((cmd) => cmd.trim())
      .filter(Boolean);
    if (commands.length === 0) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "cli registration missing explicit commands metadata",
      });
      return;
    }
    const existing = registry.cliRegistrars.find((entry) =>
      entry.commands.some((command) => commands.includes(command)),
    );
    if (existing) {
      const overlap = commands.find((command) => existing.commands.includes(command));
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `cli command already registered: ${overlap ?? commands[0]} (${existing.pluginId})`,
      });
      return;
    }
    record.cliCommands.push(...commands);
    registry.cliRegistrars.push({
      pluginId: record.id,
      pluginName: record.name,
      register: registrar,
      commands,
      descriptors,
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  const reservedNodeHostCommands = new Set<string>([
    ...NODE_SYSTEM_RUN_COMMANDS,
    ...NODE_EXEC_APPROVALS_COMMANDS,
    NODE_SYSTEM_NOTIFY_COMMAND,
  ]);

  const registerReload = (record: PluginRecord, registration: OpenClawPluginReloadRegistration) => {
    const normalize = (values?: string[]) =>
      (values ?? []).map((value) => value.trim()).filter(Boolean);
    const normalized: OpenClawPluginReloadRegistration = {
      restartPrefixes: normalize(registration.restartPrefixes),
      hotPrefixes: normalize(registration.hotPrefixes),
      noopPrefixes: normalize(registration.noopPrefixes),
    };
    if (
      (normalized.restartPrefixes?.length ?? 0) === 0 &&
      (normalized.hotPrefixes?.length ?? 0) === 0 &&
      (normalized.noopPrefixes?.length ?? 0) === 0
    ) {
      pushDiagnostic({
        level: "warn",
        pluginId: record.id,
        source: record.source,
        message: "reload registration missing prefixes",
      });
      return;
    }
    registry.reloads ??= [];
    registry.reloads.push({
      pluginId: record.id,
      pluginName: record.name,
      registration: normalized,
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  const registerNodeHostCommand = (
    record: PluginRecord,
    nodeCommand: OpenClawPluginNodeHostCommand,
  ) => {
    const command = nodeCommand.command.trim();
    if (!command) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "node host command registration missing command",
      });
      return;
    }
    if (reservedNodeHostCommands.has(command)) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `node host command reserved by core: ${command}`,
      });
      return;
    }
    registry.nodeHostCommands ??= [];
    const existing = registry.nodeHostCommands.find((entry) => entry.command.command === command);
    if (existing) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `node host command already registered: ${command} (${existing.pluginId})`,
      });
      return;
    }
    registry.nodeHostCommands.push({
      pluginId: record.id,
      pluginName: record.name,
      command: {
        ...nodeCommand,
        command,
        cap: normalizeOptionalString(nodeCommand.cap),
      },
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  const registerSecurityAuditCollector = (
    record: PluginRecord,
    collector: OpenClawPluginSecurityAuditCollector,
  ) => {
    registry.securityAuditCollectors ??= [];
    registry.securityAuditCollectors.push({
      pluginId: record.id,
      pluginName: record.name,
      collector,
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  const registerService = (record: PluginRecord, service: OpenClawPluginService) => {
    const id = service.id.trim();
    if (!id) {
      return;
    }
    const existing = registry.services.find((entry) => entry.service.id === id);
    if (existing) {
      // Idempotent: the same plugin can hit registration twice across snapshot vs
      // activating loads (see #62033). Keep the first registration.
      if (existing.pluginId === record.id) {
        return;
      }
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `service already registered: ${id} (${existing.pluginId})`,
      });
      return;
    }
    record.services.push(id);
    registry.services.push({
      pluginId: record.id,
      pluginName: record.name,
      service,
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  const registerGatewayDiscoveryService = (
    record: PluginRecord,
    service: OpenClawGatewayDiscoveryService,
  ) => {
    const id = service.id.trim();
    if (!id) {
      return;
    }
    const existing = registry.gatewayDiscoveryServices.find((entry) => entry.service.id === id);
    if (existing) {
      if (existing.pluginId === record.id) {
        return;
      }
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `gateway discovery service already registered: ${id} (${existing.pluginId})`,
      });
      return;
    }
    record.gatewayDiscoveryServiceIds.push(id);
    registry.gatewayDiscoveryServices.push({
      pluginId: record.id,
      pluginName: record.name,
      service,
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  const registerCommand = (record: PluginRecord, command: OpenClawPluginCommandDefinition) => {
    const name = command.name.trim();
    if (!name) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "command registration missing name",
      });
      return;
    }

    // For snapshot (non-activating) loads, record the command locally without touching the
    // global plugin command registry so running gateway commands stay intact.
    // We still validate the command definition so diagnostics match the real activation path.
    // NOTE: cross-plugin duplicate command detection is intentionally skipped here because
    // snapshot registries are isolated and never write to the global command table. Conflicts
    // will surface when the plugin is loaded via the normal activation path at gateway startup.
    if (!registryParams.activateGlobalSideEffects) {
      const validationError = validatePluginCommandDefinition(command);
      if (validationError) {
        pushDiagnostic({
          level: "error",
          pluginId: record.id,
          source: record.source,
          message: `command registration failed: ${validationError}`,
        });
        return;
      }
    } else {
      const result = registerPluginCommand(record.id, command, {
        pluginName: record.name,
        pluginRoot: record.rootDir,
      });
      if (!result.ok) {
        pushDiagnostic({
          level: "error",
          pluginId: record.id,
          source: record.source,
          message: `command registration failed: ${result.error}`,
        });
        return;
      }
    }

    record.commands.push(name);
    registry.commands.push({
      pluginId: record.id,
      pluginName: record.name,
      command,
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  const registerTypedHook = <K extends PluginHookName>(
    record: PluginRecord,
    hookName: K,
    handler: PluginHookHandlerMap[K],
    opts?: { priority?: number },
    policy?: PluginTypedHookPolicy,
  ) => {
    if (!isPluginHookName(hookName)) {
      pushDiagnostic({
        level: "warn",
        pluginId: record.id,
        source: record.source,
        message: `unknown typed hook "${String(hookName)}" ignored`,
      });
      return;
    }
    let effectiveHandler = handler;
    if (policy?.allowPromptInjection === false && isPromptInjectionHookName(hookName)) {
      if (hookName === "before_prompt_build") {
        pushDiagnostic({
          level: "warn",
          pluginId: record.id,
          source: record.source,
          message: `typed hook "${hookName}" blocked by plugins.entries.${record.id}.hooks.allowPromptInjection=false`,
        });
        return;
      }
      if (hookName === "before_agent_start") {
        pushDiagnostic({
          level: "warn",
          pluginId: record.id,
          source: record.source,
          message: `typed hook "${hookName}" prompt fields constrained by plugins.entries.${record.id}.hooks.allowPromptInjection=false`,
        });
        effectiveHandler = constrainLegacyPromptInjectionHook(
          handler as PluginHookHandlerMap["before_agent_start"],
        ) as PluginHookHandlerMap[K];
      }
    }
    if (isConversationHookName(hookName)) {
      const explicitConversationAccess = policy?.allowConversationAccess;
      if (record.origin !== "bundled" && explicitConversationAccess !== true) {
        pushDiagnostic({
          level: "warn",
          pluginId: record.id,
          source: record.source,
          message:
            `typed hook "${hookName}" blocked because non-bundled plugins must set ` +
            `plugins.entries.${record.id}.hooks.allowConversationAccess=true`,
        });
        return;
      }
      if (record.origin === "bundled" && explicitConversationAccess === false) {
        pushDiagnostic({
          level: "warn",
          pluginId: record.id,
          source: record.source,
          message: `typed hook "${hookName}" blocked by plugins.entries.${record.id}.hooks.allowConversationAccess=false`,
        });
        return;
      }
    }
    record.hookCount += 1;
    registry.typedHooks.push({
      pluginId: record.id,
      hookName,
      handler: effectiveHandler,
      priority: opts?.priority,
      source: record.source,
    } as TypedPluginHookRegistration);
  };

  const registerConversationBindingResolvedHandler = (
    record: PluginRecord,
    handler: (event: PluginConversationBindingResolvedEvent) => void | Promise<void>,
  ) => {
    registry.conversationBindingResolvedHandlers.push({
      pluginId: record.id,
      pluginName: record.name,
      pluginRoot: record.rootDir,
      handler,
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  const normalizeLogger = (logger: PluginLogger): PluginLogger => ({
    info: logger.info,
    warn: logger.warn,
    error: logger.error,
    debug: logger.debug,
  });

  const pluginRuntimeById = new Map<string, PluginRuntime>();

  const resolvePluginRuntime = (pluginId: string): PluginRuntime => {
    const cached = pluginRuntimeById.get(pluginId);
    if (cached) {
      return cached;
    }
    const runtime = new Proxy(registryParams.runtime, {
      get(target, prop, receiver) {
        if (prop !== "subagent") {
          return Reflect.get(target, prop, receiver);
        }
        const subagent = Reflect.get(target, prop, receiver);
        return {
          run: (params) => withPluginRuntimePluginIdScope(pluginId, () => subagent.run(params)),
          waitForRun: (params) =>
            withPluginRuntimePluginIdScope(pluginId, () => subagent.waitForRun(params)),
          getSessionMessages: (params) =>
            withPluginRuntimePluginIdScope(pluginId, () => subagent.getSessionMessages(params)),
          getSession: (params) =>
            withPluginRuntimePluginIdScope(pluginId, () => subagent.getSession(params)),
          deleteSession: (params) =>
            withPluginRuntimePluginIdScope(pluginId, () => subagent.deleteSession(params)),
        } satisfies PluginRuntime["subagent"];
      },
    });
    pluginRuntimeById.set(pluginId, runtime);
    return runtime;
  };

  const createApi = (
    record: PluginRecord,
    params: {
      config: OpenClawPluginApi["config"];
      pluginConfig?: Record<string, unknown>;
      hookPolicy?: PluginTypedHookPolicy;
      registrationMode?: PluginRegistrationMode;
    },
  ): OpenClawPluginApi => {
    const registrationMode = params.registrationMode ?? "full";
    return buildPluginApi({
      id: record.id,
      name: record.name,
      version: record.version,
      description: record.description,
      source: record.source,
      rootDir: record.rootDir,
      registrationMode,
      config: params.config,
      pluginConfig: params.pluginConfig,
      runtime: resolvePluginRuntime(record.id),
      logger: normalizeLogger(registryParams.logger),
      resolvePath: (input: string) => resolveUserPath(input),
      handlers: {
        ...(registrationMode === "full"
          ? {
              registerTool: (tool, opts) => registerTool(record, tool, opts),
              registerHook: (events, handler, opts) =>
                registerHook(record, events, handler, opts, params.config),
              registerHttpRoute: (routeParams) => registerHttpRoute(record, routeParams),
              registerProvider: (provider) => registerProvider(record, provider),
              registerAgentHarness: (harness) => registerAgentHarness(record, harness),
              registerDetachedTaskRuntime: (runtime) => {
                const existing = getDetachedTaskLifecycleRuntimeRegistration();
                if (existing && existing.pluginId !== record.id) {
                  pushDiagnostic({
                    level: "error",
                    pluginId: record.id,
                    source: record.source,
                    message: `detached task runtime already registered by ${existing.pluginId}`,
                  });
                  return;
                }
                registerDetachedTaskLifecycleRuntime(record.id, runtime);
              },
              registerSpeechProvider: (provider) => registerSpeechProvider(record, provider),
              registerRealtimeTranscriptionProvider: (provider) =>
                registerRealtimeTranscriptionProvider(record, provider),
              registerRealtimeVoiceProvider: (provider) =>
                registerRealtimeVoiceProvider(record, provider),
              registerMediaUnderstandingProvider: (provider) =>
                registerMediaUnderstandingProvider(record, provider),
              registerImageGenerationProvider: (provider) =>
                registerImageGenerationProvider(record, provider),
              registerVideoGenerationProvider: (provider) =>
                registerVideoGenerationProvider(record, provider),
              registerMusicGenerationProvider: (provider) =>
                registerMusicGenerationProvider(record, provider),
              registerWebFetchProvider: (provider) => registerWebFetchProvider(record, provider),
              registerWebSearchProvider: (provider) => registerWebSearchProvider(record, provider),
              registerGatewayMethod: (method, handler, opts) =>
                registerGatewayMethod(record, method, handler, opts),
              registerService: (service) => registerService(record, service),
              registerGatewayDiscoveryService: (service) =>
                registerGatewayDiscoveryService(record, service),
              registerCliBackend: (backend) => registerCliBackend(record, backend),
              registerTextTransforms: (transforms) => registerTextTransforms(record, transforms),
              registerReload: (registration) => registerReload(record, registration),
              registerNodeHostCommand: (command) => registerNodeHostCommand(record, command),
              registerSecurityAuditCollector: (collector) =>
                registerSecurityAuditCollector(record, collector),
              registerInteractiveHandler: (registration) => {
                const result = registerPluginInteractiveHandler(record.id, registration, {
                  pluginName: record.name,
                  pluginRoot: record.rootDir,
                });
                if (!result.ok) {
                  pushDiagnostic({
                    level: "warn",
                    pluginId: record.id,
                    source: record.source,
                    message: result.error ?? "interactive handler registration failed",
                  });
                }
              },
              onConversationBindingResolved: (handler) =>
                registerConversationBindingResolvedHandler(record, handler),
              registerCommand: (command) => registerCommand(record, command),
              registerContextEngine: (id, factory) => {
                if (id === defaultSlotIdForKey("contextEngine")) {
                  pushDiagnostic({
                    level: "error",
                    pluginId: record.id,
                    source: record.source,
                    message: `context engine id reserved by core: ${id}`,
                  });
                  return;
                }
                const result = registerContextEngineForOwner(id, factory, `plugin:${record.id}`, {
                  allowSameOwnerRefresh: true,
                });
                if (!result.ok) {
                  pushDiagnostic({
                    level: "error",
                    pluginId: record.id,
                    source: record.source,
                    message: `context engine already registered: ${id} (${result.existingOwner})`,
                  });
                  return;
                }
                if (!record.contextEngineIds?.includes(id)) {
                  record.contextEngineIds = [...(record.contextEngineIds ?? []), id];
                }
              },
              registerCompactionProvider: (
                provider: Parameters<OpenClawPluginApi["registerCompactionProvider"]>[0],
              ) => {
                const existing = getRegisteredCompactionProvider(provider.id);
                if (existing) {
                  const ownerDetail = existing.ownerPluginId
                    ? ` (owner: ${existing.ownerPluginId})`
                    : "";
                  pushDiagnostic({
                    level: "error",
                    pluginId: record.id,
                    source: record.source,
                    message: `compaction provider already registered: ${provider.id}${ownerDetail}`,
                  });
                  return;
                }
                registerCompactionProvider(provider, { ownerPluginId: record.id });
              },
              registerEmbeddedExtensionFactory: (factory) => {
                registerPiEmbeddedExtensionFactory(record, factory);
              },
              registerCodexAppServerExtensionFactory: (factory) => {
                registerCodexAppServerExtensionFactory(record, factory);
              },
              registerMemoryCapability: (capability) => {
                if (!hasKind(record.kind, "memory")) {
                  pushDiagnostic({
                    level: "error",
                    pluginId: record.id,
                    source: record.source,
                    message: "only memory plugins can register a memory capability",
                  });
                  return;
                }
                if (
                  Array.isArray(record.kind) &&
                  record.kind.length > 1 &&
                  !record.memorySlotSelected
                ) {
                  pushDiagnostic({
                    level: "warn",
                    pluginId: record.id,
                    source: record.source,
                    message:
                      "dual-kind plugin not selected for memory slot; skipping memory capability registration",
                  });
                  return;
                }
                registerMemoryCapability(record.id, capability);
              },
              registerMemoryPromptSection: (builder) => {
                if (!hasKind(record.kind, "memory")) {
                  pushDiagnostic({
                    level: "error",
                    pluginId: record.id,
                    source: record.source,
                    message: "only memory plugins can register a memory prompt section",
                  });
                  return;
                }
                if (
                  Array.isArray(record.kind) &&
                  record.kind.length > 1 &&
                  !record.memorySlotSelected
                ) {
                  pushDiagnostic({
                    level: "warn",
                    pluginId: record.id,
                    source: record.source,
                    message:
                      "dual-kind plugin not selected for memory slot; skipping memory prompt section registration",
                  });
                  return;
                }
                registerMemoryPromptSection(builder);
              },
              registerMemoryPromptSupplement: (builder) => {
                registerMemoryPromptSupplement(record.id, builder);
              },
              registerMemoryCorpusSupplement: (supplement) => {
                registerMemoryCorpusSupplement(record.id, supplement);
              },
              registerMemoryFlushPlan: (resolver) => {
                if (!hasKind(record.kind, "memory")) {
                  pushDiagnostic({
                    level: "error",
                    pluginId: record.id,
                    source: record.source,
                    message: "only memory plugins can register a memory flush plan",
                  });
                  return;
                }
                if (
                  Array.isArray(record.kind) &&
                  record.kind.length > 1 &&
                  !record.memorySlotSelected
                ) {
                  pushDiagnostic({
                    level: "warn",
                    pluginId: record.id,
                    source: record.source,
                    message:
                      "dual-kind plugin not selected for memory slot; skipping memory flush plan registration",
                  });
                  return;
                }
                registerMemoryFlushPlanResolver(resolver);
              },
              registerMemoryRuntime: (runtime) => {
                if (!hasKind(record.kind, "memory")) {
                  pushDiagnostic({
                    level: "error",
                    pluginId: record.id,
                    source: record.source,
                    message: "only memory plugins can register a memory runtime",
                  });
                  return;
                }
                if (
                  Array.isArray(record.kind) &&
                  record.kind.length > 1 &&
                  !record.memorySlotSelected
                ) {
                  pushDiagnostic({
                    level: "warn",
                    pluginId: record.id,
                    source: record.source,
                    message:
                      "dual-kind plugin not selected for memory slot; skipping memory runtime registration",
                  });
                  return;
                }
                registerMemoryRuntime(runtime);
              },
              registerMemoryEmbeddingProvider: (adapter) => {
                if (hasKind(record.kind, "memory")) {
                  if (
                    Array.isArray(record.kind) &&
                    record.kind.length > 1 &&
                    !record.memorySlotSelected
                  ) {
                    pushDiagnostic({
                      level: "warn",
                      pluginId: record.id,
                      source: record.source,
                      message:
                        "dual-kind plugin not selected for memory slot; skipping memory embedding provider registration",
                    });
                    return;
                  }
                } else if (
                  !(record.contracts?.memoryEmbeddingProviders ?? []).includes(adapter.id)
                ) {
                  pushDiagnostic({
                    level: "error",
                    pluginId: record.id,
                    source: record.source,
                    message: `plugin must own memory slot or declare contracts.memoryEmbeddingProviders for adapter: ${adapter.id}`,
                  });
                  return;
                }
                const existing = getRegisteredMemoryEmbeddingProvider(adapter.id);
                if (existing) {
                  const ownerDetail = existing.ownerPluginId
                    ? ` (owner: ${existing.ownerPluginId})`
                    : "";
                  pushDiagnostic({
                    level: "error",
                    pluginId: record.id,
                    source: record.source,
                    message: `memory embedding provider already registered: ${adapter.id}${ownerDetail}`,
                  });
                  return;
                }
                registerMemoryEmbeddingProvider(adapter, {
                  ownerPluginId: record.id,
                });
                registry.memoryEmbeddingProviders.push({
                  pluginId: record.id,
                  pluginName: record.name,
                  provider: adapter,
                  source: record.source,
                  rootDir: record.rootDir,
                });
              },
              on: (hookName, handler, opts) =>
                registerTypedHook(record, hookName, handler, opts, params.hookPolicy),
            }
          : {}),
        // Allow setup-only/setup-runtime paths to surface parse-time CLI metadata
        // without opting into the wider full-registration surface.
        registerCli: (registrar, opts) => registerCli(record, registrar, opts),
        registerChannel: (registration) => registerChannel(record, registration, registrationMode),
      },
    });
  };

  const rollbackPluginGlobalSideEffects = (pluginId: string) => {
    if (registryParams.activateGlobalSideEffects === false) {
      return;
    }

    clearPluginCommandsForPlugin(pluginId);
    clearPluginInteractiveHandlersForPlugin(pluginId);
    clearContextEnginesForOwner(`plugin:${pluginId}`);

    const hookRollbackEntries = pluginHookRollback.get(pluginId) ?? [];
    for (const entry of hookRollbackEntries.toReversed()) {
      const activeRegistrations = activePluginHookRegistrations.get(entry.name) ?? [];
      for (const registration of activeRegistrations) {
        unregisterInternalHook(registration.event, registration.handler);
      }

      if (entry.previousRegistrations.length === 0) {
        activePluginHookRegistrations.delete(entry.name);
        continue;
      }

      for (const registration of entry.previousRegistrations) {
        registerInternalHook(registration.event, registration.handler);
      }
      activePluginHookRegistrations.set(entry.name, [...entry.previousRegistrations]);
    }
    pluginHookRollback.delete(pluginId);
  };

  return {
    registry,
    createApi,
    rollbackPluginGlobalSideEffects,
    pushDiagnostic,
    registerTool,
    registerChannel,
    registerProvider,
    registerAgentHarness,
    registerCliBackend,
    registerTextTransforms,
    registerSpeechProvider,
    registerRealtimeTranscriptionProvider,
    registerRealtimeVoiceProvider,
    registerMediaUnderstandingProvider,
    registerImageGenerationProvider,
    registerVideoGenerationProvider,
    registerMusicGenerationProvider,
    registerWebSearchProvider,
    registerGatewayMethod,
    registerCli,
    registerReload,
    registerNodeHostCommand,
    registerSecurityAuditCollector,
    registerService,
    registerCommand,
    registerHook,
    registerTypedHook,
  };
}

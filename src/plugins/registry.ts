/** In-memory plugin registry builder and mutation API for plugin runtime registration. */
import path from "node:path";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { uniqueValues } from "@openclaw/normalization-core/string-normalization";
import {
  normalizeStringEntries,
  normalizeUniqueStringEntries,
} from "@openclaw/normalization-core/string-normalization";
import { normalizeOptionalAgentRuntimeId } from "../agents/agent-runtime-id.js";
import { clearCodeModeNamespacesForPlugin } from "../agents/code-mode-namespaces.js";
import {
  getRegisteredAgentHarness,
  registerAgentHarness as registerGlobalAgentHarness,
} from "../agents/harness/registry.js";
import type { AgentHarness } from "../agents/harness/types.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { createChannelIngressQueue } from "../channels/message/ingress-queue.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import {
  normalizeCommandDescriptorName,
  sanitizeCommandDescriptorDescription,
} from "../cli/program/command-descriptor-utils.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  clearContextEnginesForOwner,
  registerContextEngineForOwner,
} from "../context-engine/registry.js";
import { createPluginGatewayMethodDescriptor } from "../gateway/methods/registry.js";
import { isOperatorScope, type OperatorScope } from "../gateway/operator-scopes.js";
import type { GatewayRequestHandler, RespondFn } from "../gateway/server-methods/types.js";
import { registerInternalHook, unregisterInternalHook } from "../hooks/internal-hooks.js";
import type { HookEntry } from "../hooks/types.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  NODE_EXEC_APPROVALS_COMMANDS,
  NODE_SYSTEM_NOTIFY_COMMAND,
  NODE_SYSTEM_RUN_COMMANDS,
} from "../infra/node-commands.js";
import {
  createPluginStateKeyedStore,
  createPluginStateSyncKeyedStore,
  type OpenKeyedStoreOptions,
  type PluginStateKeyedStore,
  type PluginStateSyncKeyedStore,
} from "../plugin-state/plugin-state-store.js";
import {
  isAgentHarnessSessionKey,
  isAgentHarnessSessionKeyOwnedBy,
} from "../sessions/agent-harness-session-key.js";
import { normalizePluginGatewayMethodScope } from "../shared/gateway-method-policy.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  getDetachedTaskLifecycleRuntimeRegistration,
  registerDetachedTaskLifecycleRuntime,
} from "../tasks/detached-task-runtime-state.js";
import { resolveUserPath } from "../utils.js";
import { emitPluginAgentEvent } from "./agent-event-emission.js";
import type { AgentToolResultMiddleware } from "./agent-tool-result-middleware-types.js";
import {
  normalizeAgentToolResultMiddlewareRuntimeIds,
  normalizeAgentToolResultMiddlewareRuntimes,
} from "./agent-tool-result-middleware.js";
import { buildPluginApi } from "./api-builder.js";
import { normalizeRegisteredChannelPlugin } from "./channel-validation.js";
import { CODEX_APP_SERVER_EXTENSION_RUNTIME_ID } from "./codex-app-server-extension-factory.js";
import type { CodexAppServerExtensionFactory } from "./codex-app-server-extension-types.js";
import {
  isReservedCommandName,
  registerPluginCommand,
  validatePluginCommandDefinition,
} from "./command-registration.js";
import { clearPluginCommandsForPlugin, pluginCommands } from "./command-registry-state.js";
import {
  getRegisteredCompactionProvider,
  registerCompactionProvider,
} from "./compaction-provider.js";
import { getPluginCompatRecord } from "./compat/registry.js";
import {
  getRegisteredEmbeddingProvider,
  registerEmbeddingProvider,
  type EmbeddingProviderAdapter,
} from "./embedding-providers.js";
import { sendPluginSessionAttachment } from "./host-hook-attachments.js";
import {
  clearPluginRunContext,
  getPluginRunContext,
  getPluginSessionSchedulerJobGeneration,
  registerPluginSessionSchedulerJob,
  setPluginRunContext,
} from "./host-hook-runtime.js";
import {
  schedulePluginSessionTurn,
  unschedulePluginSessionTurnsByTag,
} from "./host-hook-scheduled-turns.js";
import { enqueuePluginNextTurnInjection } from "./host-hook-state.js";
import {
  isPluginJsonValue,
  normalizePluginHostHookId,
  type PluginAgentEventSubscriptionRegistration,
  type PluginControlUiDescriptor,
  type PluginRuntimeLifecycleRegistration,
  type PluginSessionActionRegistration,
  type PluginSessionSchedulerJobRegistration,
  type PluginSessionExtensionRegistration,
  type PluginToolMetadataRegistration,
  type PluginTrustedToolPolicyRegistration,
} from "./host-hooks.js";
import { normalizePluginHttpPath } from "./http-path.js";
import { findOverlappingPluginHttpRoute } from "./http-route-overlap.js";
import {
  clearPluginInteractiveHandlersForPlugin,
  registerRegistryPluginInteractiveHandler,
} from "./interactive-registry.js";
import type { PluginDiagnostic } from "./manifest-types.js";
import {
  getRegisteredMemoryEmbeddingProvider,
  registerMemoryEmbeddingProvider,
} from "./memory-embedding-providers.js";
import {
  registerMemoryCapability,
  registerMemoryCorpusSupplement,
  registerMemoryFlushPlanResolverForPlugin,
  registerMemoryPromptSupplement,
  registerMemoryPromptSectionForPlugin,
  registerMemoryRuntimeForPlugin,
} from "./memory-state.js";
import { createModelCatalogRegistrationHandlers } from "./model-catalog-registration.js";
import { normalizeRegisteredProvider } from "./provider-validation.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { isPluginRegistryActivated, isPluginRegistryRetired } from "./registry-lifecycle.js";
import type {
  PluginHttpRouteRegistration as RegistryTypesPluginHttpRouteRegistration,
  PluginRecord,
  PluginRegistryParams,
  PluginSessionActionRegistryRegistration,
  PluginTextTransformsRegistration,
  PluginTrustedToolPolicyRegistryRegistration,
} from "./registry-types.js";
export type {
  PluginReloadRegistration,
  PluginRuntimeLifecycleRegistryRegistration,
  PluginSecurityAuditCollectorRegistration,
  PluginServiceRegistration,
  PluginSessionExtensionRegistryRegistration,
} from "./registry-types.js";
import { getActivePluginRegistry } from "./runtime.js";
import {
  withPluginRuntimePluginIdScope,
  withPluginRuntimePluginScope,
} from "./runtime/gateway-request-scope.js";
import type { PluginRuntime } from "./runtime/types.js";
import { validateJsonSchemaValue, type JsonSchemaValue } from "./schema-validator.js";
import type { SessionCatalogProvider } from "./session-catalog.js";
import { normalizeSessionEntrySlotKey } from "./session-entry-slot-keys.js";
import { defaultSlotIdForKey, hasKind } from "./slots.js";
import {
  findUndeclaredPluginToolNames,
  normalizePluginToolContractNames,
  normalizePluginToolNames,
} from "./tool-contracts.js";
import {
  DEPRECATED_PLUGIN_HOOKS,
  isConversationHookName,
  isDeprecatedPluginHookName,
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
  OpenClawPluginHostedMediaResolver,
  OpenClawPluginHttpRouteParams,
  OpenClawPluginHookOptions,
  OpenClawPluginNodeHostCommand,
  OpenClawPluginNodeInvokePolicy,
  OpenClawPluginReloadRegistration,
  OpenClawPluginSecurityAuditCollector,
  MediaUnderstandingProviderPlugin,
  TranscriptSourceProvider,
  MigrationProviderPlugin,
  OpenClawPluginService,
  OpenClawPluginToolContext,
  OpenClawPluginToolFactory,
  OpenClawPluginToolOptions,
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
  WorkerProvider,
} from "./types.js";
import { validateWorkerProviderContract } from "./worker-provider-registry.js";

export type PluginHttpRouteRegistration = RegistryTypesPluginHttpRouteRegistration & {
  gatewayRuntimeScopeSurface?: OpenClawPluginGatewayRuntimeScopeSurface;
};

const GATEWAY_METHOD_DISPATCH_CONTRACT = "authenticated-request";
const LEGACY_DEACTIVATE_HOOK_ALIAS_COMPAT = getPluginCompatRecord("legacy-deactivate-hook-alias");
const LEGACY_SUBAGENT_SPAWNING_HOOK_COMPAT = getPluginCompatRecord("legacy-subagent-spawning-hook");

const PLUGIN_GATEWAY_SESSION_MUTATION_METHODS = new Set([
  "agent",
  "chat.abort",
  "chat.inject",
  "chat.send",
  "message.action",
  "plugins.sessionAction",
  "send",
  "sessions.abort",
  "sessions.compact",
  "sessions.compaction.branch",
  "sessions.compaction.restore",
  "sessions.create",
  "sessions.delete",
  "sessions.patch",
  "sessions.pluginPatch",
  "sessions.reset",
  "sessions.send",
  "sessions.steer",
  "wake",
]);

const PLUGIN_GATEWAY_GLOBAL_SESSION_MUTATION_METHODS = new Set([
  "sessions.cleanup",
  "sessions.groups.delete",
  "sessions.groups.rename",
]);

function formatLegacyDeactivateHookAliasDiagnostic(): string {
  const removeAfter =
    LEGACY_DEACTIVATE_HOOK_ALIAS_COMPAT.removeAfter ?? "a future breaking release";
  return (
    `typed hook "deactivate" is deprecated (${LEGACY_DEACTIVATE_HOOK_ALIAS_COMPAT.code}); ` +
    `use "gateway_stop". This compatibility alias will be removed after ${removeAfter}.`
  );
}

function formatDeprecatedTypedHookDiagnostic(hookName: PluginHookName): string | undefined {
  if (!isDeprecatedPluginHookName(hookName) || hookName === "deactivate") {
    return undefined;
  }
  const deprecation = DEPRECATED_PLUGIN_HOOKS[hookName];
  const compat =
    hookName === "subagent_spawning" ? LEGACY_SUBAGENT_SPAWNING_HOOK_COMPAT : undefined;
  const removeAfter = compat?.removeAfter ?? deprecation.removeAfter ?? "a future breaking release";
  const code = compat?.code ?? "deprecated-plugin-hook";
  return (
    `typed hook "${hookName}" is deprecated (${code}); ` +
    `${deprecation.reason} Use ${deprecation.replacement}. ` +
    `This compatibility hook will be removed after ${removeAfter}.`
  );
}

function canRegisterInstalledTrustedHook(record: PluginRecord): boolean {
  return record.origin === "bundled" || (record.enabled && record.explicitlyEnabled === true);
}

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
  PluginWorkerProviderRegistration,
  PluginControlUiDescriptorRegistryRegistration,
  PluginHostedMediaResolverRegistration,
  PluginRecord,
  PluginRegistry,
  PluginRegistryParams,
  PluginTextTransformsRegistration,
  PluginToolMetadataRegistryRegistration,
  PluginTrustedToolPolicyRegistryRegistration,
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
  timeoutMs?: number;
  timeouts?: Record<string, number>;
};

function normalizeHookTimeoutMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function resolveTypedHookTimeoutMs(params: {
  hookName: PluginHookName;
  opts?: { timeoutMs?: number };
  policy?: PluginTypedHookPolicy;
}): number | undefined {
  return (
    normalizeHookTimeoutMs(params.policy?.timeouts?.[params.hookName]) ??
    normalizeHookTimeoutMs(params.policy?.timeoutMs) ??
    normalizeHookTimeoutMs(params.opts?.timeoutMs)
  );
}

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

export function resolvePluginPath(input: string, rootDir: string | undefined): string {
  const trimmed = input.trim();
  if (!trimmed || path.isAbsolute(trimmed) || trimmed.startsWith("~")) {
    return resolveUserPath(input);
  }
  return rootDir ? path.resolve(rootDir, trimmed) : resolveUserPath(input);
}

function isOfficialCodexPluginRecord(
  record: Pick<PluginRecord, "id" | "origin" | "packageName" | "rootDir" | "source">,
) {
  if (record.id !== "codex") {
    return false;
  }
  if (record.origin !== "global") {
    return false;
  }
  if (record.packageName === "@openclaw/codex") {
    return true;
  }
  const sourcePath = path
    .normalize(record.rootDir ?? record.source)
    .split(path.sep)
    .join("/");
  return sourcePath.includes("/node_modules/@openclaw/codex");
}

function canClaimReservedCommandOwnership(
  record: Pick<PluginRecord, "id" | "origin" | "packageName" | "rootDir" | "source">,
) {
  return record.origin === "bundled" || isOfficialCodexPluginRecord(record);
}

const ACTIVE_PLUGIN_HOOK_REGISTRATIONS_KEY = Symbol.for("openclaw.activePluginHookRegistrations");
const activePluginHookRegistrations = resolveGlobalSingleton<
  Map<string, Array<{ event: string; handler: Parameters<typeof registerInternalHook>[1] }>>
>(ACTIVE_PLUGIN_HOOK_REGISTRATIONS_KEY, () => new Map());

type HookRegistration = { event: string; handler: Parameters<typeof registerInternalHook>[1] };
type HookRollbackEntry = { name: string; previousRegistrations: HookRegistration[] };
type PluginSideEffectGuard = {
  active: boolean;
};

type PluginRegistrationCapabilities = {
  /** Broad registry writes that discovery and live activation both need. */
  capabilityHandlers: boolean;
  /** Setup-runtime may publish pre-listen gateway surfaces without full activation. */
  setupRuntimeHandlers: boolean;
  /** Runtime channel registration is suppressed for setup-only and tool discovery loads. */
  runtimeChannel: boolean;
};

/**
 * Keep mode decoding centralized. PluginRegistrationMode is the public label;
 * registry code should consume these booleans instead of duplicating string
 * checks across individual registration handlers.
 */
function resolvePluginRegistrationCapabilities(
  mode: PluginRegistrationMode,
): PluginRegistrationCapabilities {
  const capabilityHandlers = mode === "full" || mode === "discovery" || mode === "tool-discovery";
  return {
    capabilityHandlers,
    setupRuntimeHandlers: mode === "setup-runtime",
    runtimeChannel: mode !== "setup-only" && mode !== "tool-discovery",
  };
}

function adaptPluginGatewayMethodHandler(handler: GatewayRequestHandler): GatewayRequestHandler {
  return async (opts) => {
    let responded = false;
    const respond: RespondFn = (ok, payload, error, meta) => {
      responded = true;
      opts.respond(ok, payload, error, meta);
    };
    const result = (await handler({ ...opts, respond })) as unknown;
    if (!responded && result !== undefined) {
      respond(true, result);
    }
  };
}

export function createPluginRegistry(registryParams: PluginRegistryParams) {
  const registry = createEmptyPluginRegistry();
  const coreGatewayMethodNames = Array.from(
    new Set([
      ...(registryParams.coreGatewayMethodNames ?? []),
      ...Object.keys(registryParams.coreGatewayHandlers ?? {}),
    ]),
  ).toSorted();
  registry.coreGatewayMethodNames = coreGatewayMethodNames;
  const coreGatewayMethods = new Set(coreGatewayMethodNames);
  const getHostCronService = () => registryParams.hostServices?.cron;
  const pluginHookRollback = new Map<string, HookRollbackEntry[]>();
  const pluginsWithChannelRegistrationConflict = new Set<string>();
  const pluginSideEffectGuards = new Map<string, Set<PluginSideEffectGuard>>();

  const pushDiagnostic = (diag: PluginDiagnostic) => {
    registry.diagnostics.push(diag);
  };
  const {
    registerModelCatalogProvider,
    registerSynthesizedTextModelCatalogProvider,
    registerSynthesizedMediaModelCatalogProvider,
    registerSynthesizedVoiceModelCatalogProvider,
  } = createModelCatalogRegistrationHandlers({
    registry,
    pushDiagnostic,
  });

  const throwRegistrationError = (message: string): never => {
    throw new Error(message);
  };

  const requireRegistrationValue = (value: string | undefined, message: string): string => {
    if (!value) {
      throw new Error(message);
    }
    return value;
  };

  const createPluginSideEffectGuard = (pluginId: string): PluginSideEffectGuard => {
    const guard = { active: true };
    const guards = pluginSideEffectGuards.get(pluginId) ?? new Set<PluginSideEffectGuard>();
    guards.add(guard);
    pluginSideEffectGuards.set(pluginId, guards);
    return guard;
  };

  const deactivatePluginSideEffectGuards = (pluginId: string): void => {
    const guards = pluginSideEffectGuards.get(pluginId);
    if (!guards) {
      return;
    }
    for (const guard of guards) {
      guard.active = false;
    }
    pluginSideEffectGuards.delete(pluginId);
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

  const registerAgentToolResultMiddleware = (
    record: PluginRecord,
    handler: Parameters<OpenClawPluginApi["registerAgentToolResultMiddleware"]>[0],
    options: Parameters<OpenClawPluginApi["registerAgentToolResultMiddleware"]>[1],
  ) => {
    if (typeof (handler as unknown) !== "function") {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "agent tool result middleware must be a function",
      });
      return;
    }
    const runtimes = normalizeAgentToolResultMiddlewareRuntimes(options);
    if (runtimes.length === 0) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "agent tool result middleware must target at least one supported runtime",
      });
      return;
    }
    const declared = normalizeAgentToolResultMiddlewareRuntimeIds(
      record.contracts?.agentToolResultMiddleware,
    );
    const missing = runtimes.filter((runtime) => !declared.includes(runtime));
    if (missing.length > 0) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `plugin must declare contracts.agentToolResultMiddleware for: ${missing.join(", ")}`,
      });
      return;
    }
    if (!canRegisterInstalledTrustedHook(record)) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "plugin must be explicitly enabled to register agent tool result middleware",
      });
      return;
    }
    const existing = registry.agentToolResultMiddlewares.find(
      (entry) => entry.pluginId === record.id && entry.rawHandler === handler,
    );
    if (existing) {
      existing.runtimes = uniqueValues([...existing.runtimes, ...runtimes]);
      return;
    }
    const safeHandler: AgentToolResultMiddleware = async (event, ctx) => {
      try {
        return await handler(event, ctx);
      } catch (error) {
        registryParams.logger.warn(
          `[plugins] agent tool result middleware failed for ${record.id}`,
        );
        throw error;
      }
    };
    registry.agentToolResultMiddlewares.push({
      pluginId: record.id,
      pluginName: record.name,
      rawHandler: handler,
      handler: safeHandler,
      runtimes,
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  const registerTool = (
    record: PluginRecord,
    tool: AnyAgentTool | OpenClawPluginToolFactory,
    opts?: OpenClawPluginToolOptions,
  ) => {
    if (pluginsWithChannelRegistrationConflict.has(record.id)) {
      return;
    }
    const declaredNames = normalizePluginToolContractNames(record.contracts);
    if (declaredNames.length === 0) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "plugin must declare contracts.tools before registering agent tools",
      });
      return;
    }
    const names = [...(opts?.names ?? []), ...(opts?.name ? [opts.name] : [])];
    const optional = opts?.optional === true;
    const factory: OpenClawPluginToolFactory =
      typeof tool === "function" ? tool : (_ctx: OpenClawPluginToolContext) => tool;

    if (typeof tool !== "function") {
      names.push(tool.name);
    }

    const normalized = normalizePluginToolNames(names);
    const undeclared = findUndeclaredPluginToolNames({
      declaredNames,
      toolNames: normalized,
    });
    if (undeclared.length > 0) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `plugin must declare contracts.tools for: ${undeclared.join(", ")}`,
      });
      return;
    }
    if (normalized.length > 0) {
      record.toolNames.push(...normalized);
    }
    registry.tools.push({
      pluginId: record.id,
      pluginName: record.name,
      factory,
      names: normalized,
      declaredNames,
      optional,
      origin: record.origin,
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
    pluginConfig: unknown,
  ) => {
    const normalizedEvents = normalizeStringEntries(Array.isArray(events) ? events : [events]);
    const entry = opts?.entry ?? null;
    const hookName = requireRegistrationValue(
      entry?.hook.name ?? opts?.name?.trim(),
      "hook registration missing name",
    );
    const existingHook = registry.hooks.find(
      (entryLocal) => entryLocal.entry.hook.name === hookName,
    );
    if (existingHook) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `hook already registered: ${hookName} (${existingHook.pluginId})`,
      });
      return;
    }

    const description = entry?.hook.description ?? opts?.description ?? "";
    const hookEntry: HookEntry = entry
      ? {
          ...entry,
          hook: {
            ...entry.hook,
            name: hookName,
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
            name: hookName,
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

    record.hookNames.push(hookName);
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

    const previousRegistrations = activePluginHookRegistrations.get(hookName) ?? [];
    for (const registration of previousRegistrations) {
      unregisterInternalHook(registration.event, registration.handler);
    }

    const nextRegistrations: Array<{
      event: string;
      handler: Parameters<typeof registerInternalHook>[1];
    }> = [];
    for (const event of normalizedEvents) {
      const wrappedHandler: typeof handler = async (evt) => {
        const context = evt.context;
        const hadPluginConfig = Object.hasOwn(context, "pluginConfig");
        const previousPluginConfig = context.pluginConfig;
        // Internal hooks intentionally share one mutable context object across
        // handlers; only pluginConfig stays per-handler and is restored after.
        context.pluginConfig = pluginConfig;
        try {
          return await handler({ ...evt, context });
        } finally {
          if (hadPluginConfig) {
            context.pluginConfig = previousPluginConfig;
          } else {
            delete context.pluginConfig;
          }
        }
      };
      registerInternalHook(event, wrappedHandler);
      nextRegistrations.push({ event, handler: wrappedHandler });
    }
    activePluginHookRegistrations.set(hookName, nextRegistrations);
    const rollbackEntries = pluginHookRollback.get(record.id) ?? [];
    rollbackEntries.push({
      name: hookName,
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
    const wrappedHandler = adaptPluginGatewayMethodHandler(handler);
    registry.gatewayHandlers[trimmed] = wrappedHandler;
    const normalizedScope = normalizePluginGatewayMethodScope(trimmed, opts?.scope);
    if (normalizedScope.coercedToReservedAdmin) {
      pushDiagnostic({
        level: "warn",
        pluginId: record.id,
        source: record.source,
        message: `gateway method scope coerced to operator.admin for reserved core namespace: ${trimmed}`,
      });
    }
    registry.gatewayMethodDescriptors.push(
      createPluginGatewayMethodDescriptor({
        pluginId: record.id,
        name: trimmed,
        handler: wrappedHandler,
        scope: normalizedScope.scope,
      }),
    );
  };

  const registerSessionCatalog = (record: PluginRecord, provider: SessionCatalogProvider) => {
    const id = provider.id.trim();
    const label = provider.label.trim();
    if (!id || !label) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "session catalog requires non-empty id and label",
      });
      return;
    }
    const existing = registry.sessionCatalogs.find((entry) => entry.provider.id === id);
    if (existing) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `session catalog already registered: ${id} (${existing.pluginId})`,
      });
      return;
    }
    registry.sessionCatalogs.push({
      pluginId: record.id,
      pluginName: record.name,
      provider: { ...provider, id, label },
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  const describeHttpRouteOwner = (entry: PluginHttpRouteRegistration): string => {
    const plugin = normalizeOptionalString(entry.pluginId) || "unknown-plugin";
    const source = normalizeOptionalString(entry.source) || "unknown-source";
    return `${plugin} (${source})`;
  };

  const canDispatchGatewayMethodsFromHttpRoute = (record: PluginRecord): boolean =>
    (record.contracts?.gatewayMethodDispatch ?? []).includes(GATEWAY_METHOD_DISPATCH_CONTRACT);

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
      if (!params.replaceExisting && existing.pluginId !== record.id) {
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
        ...(params.handleUpgrade ? { handleUpgrade: params.handleUpgrade } : {}),
        auth: params.auth,
        match,
        ...(params.gatewayRuntimeScopeSurface
          ? { gatewayRuntimeScopeSurface: params.gatewayRuntimeScopeSurface }
          : {}),
        ...(canDispatchGatewayMethodsFromHttpRoute(record)
          ? { gatewayMethodDispatchAllowed: true }
          : {}),
        ...(params.nodeCapability ? { nodeCapability: { ...params.nodeCapability } } : {}),
        source: record.source,
      };
      return;
    }
    record.httpRoutes += 1;
    registry.httpRoutes.push({
      pluginId: record.id,
      path: normalizedPath,
      handler: params.handler,
      ...(params.handleUpgrade ? { handleUpgrade: params.handleUpgrade } : {}),
      auth: params.auth,
      match,
      ...(params.gatewayRuntimeScopeSurface
        ? { gatewayRuntimeScopeSurface: params.gatewayRuntimeScopeSurface }
        : {}),
      ...(canDispatchGatewayMethodsFromHttpRoute(record)
        ? { gatewayMethodDispatchAllowed: true }
        : {}),
      ...(params.nodeCapability ? { nodeCapability: { ...params.nodeCapability } } : {}),
      source: record.source,
    });
  };

  const registerHostedMediaResolver = (
    record: PluginRecord,
    resolver: OpenClawPluginHostedMediaResolver,
  ) => {
    if (typeof resolver !== "function") {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "hosted media resolver registration missing resolver",
      });
      return;
    }
    registry.hostedMediaResolvers.push({
      pluginId: record.id,
      pluginName: record.name,
      resolver,
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  const registerChannel = (
    record: PluginRecord,
    registration: OpenClawPluginChannelRegistration | ChannelPlugin,
    mode: PluginRegistrationMode = "full",
  ) => {
    if (record.origin === "workspace" && !record.enabled) {
      pushDiagnostic({
        level: "warn",
        pluginId: record.id,
        source: record.source,
        message: `channel registration rejected for disabled workspace plugin: ${record.id}`,
      });
      return;
    }
    const registrationCapabilities = resolvePluginRegistrationCapabilities(mode);
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
    if (registrationCapabilities.runtimeChannel && existingRuntime) {
      if (existingRuntime.pluginId === record.id) {
        existingRuntime.plugin = plugin;
        existingRuntime.pluginName = record.name;
        existingRuntime.origin = record.origin;
        existingRuntime.source = record.source;
        existingRuntime.rootDir = record.rootDir;
        const existingSetup = registry.channelSetups.find((entry) => entry.plugin.id === id);
        if (existingSetup) {
          existingSetup.plugin = plugin;
          existingSetup.pluginName = record.name;
          existingSetup.origin = record.origin;
          existingSetup.source = record.source;
          existingSetup.enabled = record.enabled;
          existingSetup.rootDir = record.rootDir;
        }
        return;
      }
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `channel already registered: ${id} (${existingRuntime.pluginId})`,
      });
      pluginsWithChannelRegistrationConflict.add(record.id);
      return;
    }
    const existingSetup = registry.channelSetups.find((entry) => entry.plugin.id === id);
    if (existingSetup) {
      if (existingSetup.pluginId === record.id) {
        existingSetup.plugin = plugin;
        existingSetup.pluginName = record.name;
        existingSetup.origin = record.origin;
        existingSetup.source = record.source;
        existingSetup.enabled = record.enabled;
        existingSetup.rootDir = record.rootDir;
        return;
      }
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `channel setup already registered: ${id} (${existingSetup.pluginId})`,
      });
      pluginsWithChannelRegistrationConflict.add(record.id);
      return;
    }
    if (!record.channelIds.includes(id)) {
      record.channelIds.push(id);
    }
    registry.channelSetups.push({
      pluginId: record.id,
      pluginName: record.name,
      plugin,
      origin: record.origin,
      source: record.source,
      enabled: record.enabled,
      rootDir: record.rootDir,
    });
    if (!registrationCapabilities.runtimeChannel) {
      return;
    }
    registry.channels.push({
      pluginId: record.id,
      pluginName: record.name,
      plugin,
      origin: record.origin,
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
    if (!record.providerIds.includes(id)) {
      record.providerIds.push(id);
    }
    registry.providers.push({
      pluginId: record.id,
      pluginName: record.name,
      provider: normalizedProvider,
      source: record.source,
      rootDir: record.rootDir,
    });
    registerSynthesizedTextModelCatalogProvider({
      record,
      provider: normalizedProvider,
    });
  };

  const registerAgentHarness = (record: PluginRecord, harness: AgentHarness) => {
    const id = normalizeOptionalString((harness as Partial<AgentHarness> | undefined)?.id) ?? "";
    if (!id) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "agent harness registration missing id",
      });
      return;
    }
    if (typeof harness.supports !== "function" || typeof harness.runAttempt !== "function") {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `agent harness "${id}" registration missing required runtime methods`,
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
    const existing = registry.cliBackends.find((entry) => entry.backend.id === id);
    if (existing) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `cli backend already registered: ${id} (${existing.pluginId})`,
      });
      return;
    }
    registry.cliBackends.push({
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

  const registerEmbeddingProviderForPlugin = (
    record: PluginRecord,
    adapter: EmbeddingProviderAdapter,
  ) => {
    const id = adapter.id.trim();
    if (!id) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "embedding provider registration missing id",
      });
      return;
    }
    if (!(record.contracts?.embeddingProviders ?? []).includes(id)) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `plugin must declare contracts.embeddingProviders for adapter: ${id}`,
      });
      return;
    }
    const existing =
      registryParams.activateGlobalSideEffects === false
        ? registry.embeddingProviders.find((entry) => entry.provider.id === id)
        : getRegisteredEmbeddingProvider(id);
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
        message: `embedding provider already registered: ${id}${ownerDetail}`,
      });
      return;
    }
    if (registryParams.activateGlobalSideEffects !== false) {
      registerEmbeddingProvider(adapter, {
        ownerPluginId: record.id,
      });
    }
    registry.embeddingProviders.push({
      pluginId: record.id,
      pluginName: record.name,
      provider: adapter,
      source: record.source,
      rootDir: record.rootDir,
    });
    if (!record.embeddingProviderIds.includes(id)) {
      record.embeddingProviderIds.push(id);
    }
  };

  const registerUniqueProviderLike = <T extends { id: string }>(params: {
    record: PluginRecord;
    provider: T;
    kindLabel: string;
    registrations: Array<PluginOwnedProviderRegistration<T>>;
    ownedIds: string[];
  }): boolean => {
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
      return false;
    }
    const existing = params.registrations.find((entry) => entry.provider.id === id);
    if (existing) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `${duplicateLabel} (${existing.pluginId})`,
      });
      return false;
    }
    if (!params.ownedIds.includes(id)) {
      params.ownedIds.push(id);
    }
    params.registrations.push({
      pluginId: record.id,
      pluginName: record.name,
      provider: params.provider,
      source: record.source,
      rootDir: record.rootDir,
    });
    return true;
  };

  const registerWorkerProvider = (record: PluginRecord, provider: WorkerProvider) => {
    const reject = (message: string) =>
      pushDiagnostic({ level: "error", pluginId: record.id, source: record.source, message });
    const validation = validateWorkerProviderContract(
      provider,
      record.contracts?.workerProviders ?? [],
    );
    if (!validation.ok) {
      reject(validation.message);
      return;
    }
    const { id } = validation;
    const existing = registry.workerProviders.get(id);
    if (existing) {
      reject(`worker provider already registered: ${id} (${existing.pluginId})`);
      return;
    }
    registry.workerProviders.set(id, {
      pluginId: record.id,
      pluginName: record.name,
      provider,
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  const registerSpeechProvider = (record: PluginRecord, provider: SpeechProviderPlugin) => {
    const registered = registerUniqueProviderLike({
      record,
      provider,
      kindLabel: "speech provider",
      registrations: registry.speechProviders,
      ownedIds: record.speechProviderIds,
    });
    if (registered) {
      registerSynthesizedVoiceModelCatalogProvider({
        record,
        provider,
        capabilities: { tts: true },
        modes: ["tts"],
      });
    }
  };

  const registerRealtimeTranscriptionProvider = (
    record: PluginRecord,
    provider: RealtimeTranscriptionProviderPlugin,
  ) => {
    const registered = registerUniqueProviderLike({
      record,
      provider,
      kindLabel: "realtime transcription provider",
      registrations: registry.realtimeTranscriptionProviders,
      ownedIds: record.realtimeTranscriptionProviderIds,
    });
    if (registered) {
      registerSynthesizedVoiceModelCatalogProvider({
        record,
        provider,
        capabilities: { realtime_transcription: true },
        modes: ["realtime_transcription"],
      });
    }
  };

  const registerRealtimeVoiceProvider = (
    record: PluginRecord,
    provider: RealtimeVoiceProviderPlugin,
  ) => {
    const registered = registerUniqueProviderLike({
      record,
      provider,
      kindLabel: "realtime voice provider",
      registrations: registry.realtimeVoiceProviders,
      ownedIds: record.realtimeVoiceProviderIds,
    });
    if (registered) {
      registerSynthesizedVoiceModelCatalogProvider({
        record,
        provider,
        capabilities: { realtime_voice: true },
        modes: ["realtime_voice"],
      });
    }
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

  const registerTranscriptSourceProvider = (
    record: PluginRecord,
    provider: TranscriptSourceProvider,
  ) => {
    registerUniqueProviderLike({
      record,
      provider,
      kindLabel: "transcripts source provider",
      registrations: registry.transcriptSourceProviders,
      ownedIds: record.transcriptSourceProviderIds,
    });
  };

  const registerImageGenerationProvider = (
    record: PluginRecord,
    provider: ImageGenerationProviderPlugin,
  ) => {
    const registered = registerUniqueProviderLike({
      record,
      provider,
      kindLabel: "image-generation provider",
      registrations: registry.imageGenerationProviders,
      ownedIds: record.imageGenerationProviderIds,
    });
    if (registered) {
      registerSynthesizedMediaModelCatalogProvider({
        record,
        kind: "image_generation",
        provider,
      });
    }
  };

  const registerVideoGenerationProvider = (
    record: PluginRecord,
    provider: VideoGenerationProviderPlugin,
  ) => {
    const registered = registerUniqueProviderLike({
      record,
      provider,
      kindLabel: "video-generation provider",
      registrations: registry.videoGenerationProviders,
      ownedIds: record.videoGenerationProviderIds,
    });
    if (registered) {
      registerSynthesizedMediaModelCatalogProvider({
        record,
        kind: "video_generation",
        provider,
      });
    }
  };

  const registerMusicGenerationProvider = (
    record: PluginRecord,
    provider: MusicGenerationProviderPlugin,
  ) => {
    const registered = registerUniqueProviderLike({
      record,
      provider,
      kindLabel: "music-generation provider",
      registrations: registry.musicGenerationProviders,
      ownedIds: record.musicGenerationProviderIds,
    });
    if (registered) {
      registerSynthesizedMediaModelCatalogProvider({
        record,
        kind: "music_generation",
        provider,
      });
    }
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

  const registerMigrationProvider = (record: PluginRecord, provider: MigrationProviderPlugin) => {
    registerUniqueProviderLike({
      record,
      provider,
      kindLabel: "migration provider",
      registrations: registry.migrationProviders,
      ownedIds: record.migrationProviderIds,
    });
  };

  const registerCli = (
    record: PluginRecord,
    registrar: OpenClawPluginCliRegistrar,
    opts?: {
      parentPath?: string[];
      commands?: string[];
      descriptors?: OpenClawPluginCliCommandDescriptor[];
    },
  ) => {
    const normalizeCommandRoot = (raw: string, source: "command" | "descriptor") => {
      const normalized = normalizeCommandDescriptorName(raw);
      if (!normalized) {
        pushDiagnostic({
          level: "error",
          pluginId: record.id,
          source: record.source,
          message: `invalid cli ${source} name: ${JSON.stringify(raw.trim())}`,
        });
      }
      return normalized;
    };
    const parentPath = (opts?.parentPath ?? []).map((segment) =>
      normalizeCommandRoot(segment, "command"),
    );
    if (parentPath.some((segment) => segment === null)) {
      return;
    }
    const normalizedParentPath = parentPath as string[];
    const descriptors = (opts?.descriptors ?? [])
      .map((descriptor) => {
        const name = normalizeCommandRoot(descriptor.name, "descriptor");
        const description = sanitizeCommandDescriptorDescription(descriptor.description);
        return name && description
          ? {
              name,
              description,
              hasSubcommands: descriptor.hasSubcommands,
            }
          : null;
      })
      .filter(
        (descriptor): descriptor is OpenClawPluginCliCommandDescriptor => descriptor !== null,
      );
    const commands = [
      ...(opts?.commands ?? []),
      ...descriptors.map((descriptor) => descriptor.name),
    ]
      .map((cmd) => normalizeCommandRoot(cmd, "command"))
      .filter((command): command is string => command !== null);
    if (commands.length === 0) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "cli registration missing explicit commands metadata",
      });
      return;
    }
    const serializeCommandPath = (command: string) => [...normalizedParentPath, command].join(" ");
    const commandPaths = commands.map(serializeCommandPath);
    const commandPathSet = new Set(commandPaths);
    const existing = registry.cliRegistrars.find((entry) =>
      entry.commands
        .map((command) => [...(entry.parentPath ?? []), command].join(" "))
        .some((commandPath) => commandPathSet.has(commandPath)),
    );
    if (existing) {
      const existingCommandPaths = new Set(
        existing.commands.map((command) => [...(existing.parentPath ?? []), command].join(" ")),
      );
      const overlap = commandPaths.find((commandPath) => existingCommandPaths.has(commandPath));
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `cli command already registered: ${overlap ?? commands[0]} (${existing.pluginId})`,
      });
      return;
    }
    record.cliCommands.push(...commandPaths);
    registry.cliRegistrars.push({
      pluginId: record.id,
      pluginName: record.name,
      register: registrar,
      parentPath: normalizedParentPath,
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
    const normalized: OpenClawPluginReloadRegistration = {
      restartPrefixes: normalizeStringEntries(registration.restartPrefixes),
      hotPrefixes: normalizeStringEntries(registration.hotPrefixes),
      noopPrefixes: normalizeStringEntries(registration.noopPrefixes),
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

  const registerNodeInvokePolicy = (
    record: PluginRecord,
    policy: OpenClawPluginNodeInvokePolicy,
    pluginConfig?: Record<string, unknown>,
  ) => {
    const commands = normalizeUniqueStringEntries(
      Array.isArray(policy.commands) ? policy.commands : [],
    );
    if (commands.length === 0) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "node invoke policy registration missing commands",
      });
      return;
    }
    if (typeof policy.handle !== "function") {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `node invoke policy registration missing handler: ${commands.join(", ")}`,
      });
      return;
    }
    for (const command of commands) {
      const existing = registry.nodeInvokePolicies.find((entry) =>
        entry.policy.commands.includes(command),
      );
      if (existing) {
        pushDiagnostic({
          level: "error",
          pluginId: record.id,
          source: record.source,
          message: `node invoke policy already registered for ${command} (${existing.pluginId})`,
        });
        return;
      }
    }
    registry.nodeInvokePolicies.push({
      pluginId: record.id,
      pluginName: record.name,
      policy: { ...policy, commands },
      pluginConfig,
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  const registerSecurityAuditCollector = (
    record: PluginRecord,
    collector: OpenClawPluginSecurityAuditCollector,
  ) => {
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
      origin: record.origin,
      trustedOfficialInstall: record.trustedOfficialInstall,
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
    const allowReservedCommandNames = command.ownership === "reserved";
    if (allowReservedCommandNames && !canClaimReservedCommandOwnership(record)) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `only bundled plugins can claim reserved command ownership: ${name}`,
      });
      return;
    }
    if (allowReservedCommandNames && !isReservedCommandName(name)) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `reserved command ownership requires a reserved command name: ${name}`,
      });
      return;
    }
    if (allowReservedCommandNames && record.id !== normalizeLowercaseStringOrEmpty(name)) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `command registration failed: Reserved command ownership requires plugin id "${record.id}" to match reserved command name "${normalizeLowercaseStringOrEmpty(name)}"`,
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
      const validationError = validatePluginCommandDefinition(command, {
        allowReservedCommandNames,
      });
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
      const { ownership: _ownership, ...commandForRegistration } = command;
      void _ownership;
      const result = registerPluginCommand(
        record.id,
        allowReservedCommandNames ? commandForRegistration : command,
        {
          pluginName: record.name,
          pluginRoot: record.rootDir,
          allowReservedCommandNames,
          allowOwnerStatusExposure: canClaimReservedCommandOwnership(record),
        },
      );
      if (!result.ok) {
        pushDiagnostic({
          level: "error",
          pluginId: record.id,
          source: record.source,
          message: `command registration failed: ${result.error}`,
        });
        return;
      }
      if (allowReservedCommandNames) {
        const registeredCommand = pluginCommands.get(`/${name.toLowerCase()}`);
        if (registeredCommand?.pluginId === record.id) {
          registeredCommand.ownership = "reserved";
        }
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

  const normalizeHostHookString = (value: unknown): string =>
    typeof value === "string" ? normalizePluginHostHookId(value) : "";

  const normalizeOptionalHostHookString = (value: unknown): string | undefined => {
    if (value === undefined) {
      return undefined;
    }
    if (typeof value !== "string") {
      return "";
    }
    return value.trim();
  };

  const normalizeHostHookStringList = (value: unknown): string[] | undefined | null => {
    if (value === undefined) {
      return undefined;
    }
    if (!Array.isArray(value)) {
      return null;
    }
    const normalized = value.map((item) => normalizeOptionalHostHookString(item));
    if (normalized.some((item) => !item)) {
      return null;
    }
    return normalized as string[];
  };

  const validateSessionActionSchema = (
    record: PluginRecord,
    id: string,
    schema: unknown,
  ): schema is JsonSchemaValue => {
    if (schema === undefined) {
      return true;
    }
    if (!isPluginJsonValue(schema)) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `session action schema must be JSON-compatible: ${id}`,
      });
      return false;
    }
    if (
      typeof schema !== "boolean" &&
      (!schema || typeof schema !== "object" || Array.isArray(schema))
    ) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `session action schema must be a JSON schema object or boolean: ${id}`,
      });
      return false;
    }
    try {
      validateJsonSchemaValue({
        schema,
        cacheKey: `plugin-session-action-registration:${record.id}:${id}`,
        value: undefined,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `session action schema is not valid JSON Schema: ${id}: ${message}`,
      });
      return false;
    }
    return true;
  };

  const controlUiSurfaces = new Set<PluginControlUiDescriptor["surface"]>([
    "session",
    "tool",
    "run",
    "settings",
    "tab",
  ]);

  const registerSessionExtension = (
    record: PluginRecord,
    extension: PluginSessionExtensionRegistration,
  ) => {
    const namespace = normalizeHostHookString(extension.namespace);
    const description = normalizeHostHookString(extension.description);
    const project = extension.project;
    let normalizedSessionEntrySlotKey: string | undefined;
    let invalidMessage: string | undefined;
    if (!namespace || !description) {
      invalidMessage = "session extension registration requires namespace and description";
    } else if (project !== undefined && typeof project !== "function") {
      invalidMessage = "session extension projector must be a function";
    } else if (project?.constructor?.name === "AsyncFunction") {
      invalidMessage = "session extension projector must be synchronous";
    } else if (extension.cleanup !== undefined && typeof extension.cleanup !== "function") {
      invalidMessage = "session extension cleanup must be a function";
    } else if (extension.sessionEntrySlotKey !== undefined) {
      const slotKey = normalizeSessionEntrySlotKey(extension.sessionEntrySlotKey);
      if (!slotKey.ok) {
        invalidMessage = slotKey.error;
      } else {
        normalizedSessionEntrySlotKey = slotKey.key;
      }
    }
    if (invalidMessage) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: invalidMessage,
      });
      return;
    }
    const existing = registry.sessionExtensions.find(
      (entry) => entry.pluginId === record.id && entry.extension.namespace === namespace,
    );
    if (existing) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `session extension already registered: ${namespace}`,
      });
      return;
    }
    if (normalizedSessionEntrySlotKey) {
      const existingSlot = registry.sessionExtensions.find((entry) => {
        const existingSlotKey = entry.extension.sessionEntrySlotKey;
        if (existingSlotKey === undefined) {
          return false;
        }
        const normalizedExistingSlotKey = normalizeSessionEntrySlotKey(existingSlotKey);
        return (
          normalizedExistingSlotKey.ok &&
          normalizedExistingSlotKey.key === normalizedSessionEntrySlotKey
        );
      });
      if (existingSlot) {
        pushDiagnostic({
          level: "error",
          pluginId: record.id,
          source: record.source,
          message: `sessionEntrySlotKey already registered: ${normalizedSessionEntrySlotKey}`,
        });
        return;
      }
    }
    registry.sessionExtensions.push({
      pluginId: record.id,
      pluginName: record.name,
      extension: {
        ...extension,
        namespace,
        description,
        ...(normalizedSessionEntrySlotKey
          ? { sessionEntrySlotKey: normalizedSessionEntrySlotKey }
          : {}),
      },
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  const registerTrustedToolPolicy = (
    record: PluginRecord,
    policy: PluginTrustedToolPolicyRegistration,
  ) => {
    if (!policy || typeof policy !== "object") {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "trusted tool policy registration requires id, description, and evaluate()",
      });
      return;
    }
    const id = normalizeHostHookString(policy.id);
    const description = normalizeHostHookString(policy.description);
    if (!id || !description || typeof policy.evaluate !== "function") {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "trusted tool policy registration requires id, description, and evaluate()",
      });
      return;
    }
    if (
      record.origin !== "bundled" &&
      !(record.contracts?.trustedToolPolicies ?? []).includes(id)
    ) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `plugin must declare contracts.trustedToolPolicies for: ${id}`,
      });
      return;
    }
    if (!canRegisterInstalledTrustedHook(record)) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `plugin must be explicitly enabled to register trusted tool policy: ${id}`,
      });
      return;
    }
    const policies = registry.trustedToolPolicies;
    const existing = policies.find(
      (entry) => entry.pluginId === record.id && entry.policy.id === id,
    );
    if (existing) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `trusted tool policy already registered: ${id} (${existing.pluginId})`,
      });
      return;
    }
    const registration: PluginTrustedToolPolicyRegistryRegistration = {
      pluginId: record.id,
      pluginName: record.name,
      policy: {
        ...policy,
        id,
        description,
      },
      origin: record.origin,
      source: record.source,
      rootDir: record.rootDir,
    };
    if (record.origin === "bundled") {
      const firstInstalledPolicyIndex = policies.findIndex((entry) => entry.origin !== "bundled");
      if (firstInstalledPolicyIndex === -1) {
        policies.push(registration);
      } else {
        policies.splice(firstInstalledPolicyIndex, 0, registration);
      }
      return;
    }
    policies.push(registration);
  };

  const registerToolMetadata = (record: PluginRecord, metadata: PluginToolMetadataRegistration) => {
    const toolName = normalizeHostHookString(metadata.toolName);
    if (!toolName) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "tool metadata registration missing toolName",
      });
      return;
    }
    const declaredNames = normalizePluginToolContractNames(record.contracts);
    const undeclared = findUndeclaredPluginToolNames({
      declaredNames,
      toolNames: [toolName],
    });
    if (undeclared.length > 0) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `plugin must declare contracts.tools for tool metadata: ${undeclared.join(", ")}`,
      });
      return;
    }
    // Uniqueness is scoped to (pluginId + toolName): different plugins may each
    // register metadata under the same toolName for their own tools, but a given
    // plugin may not register the same toolName twice. At projection time
    // (tools-effective-inventory.ts, tools-catalog.ts) the metadata is matched
    // back to the tool's owning pluginId so plugin-X cannot decorate plugin-Y's
    // tool (or a core tool) by registering metadata with the same name.
    const existing = registry.toolMetadata.find(
      (entry) => entry.pluginId === record.id && entry.metadata.toolName === toolName,
    );
    if (existing) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `tool metadata already registered: ${toolName} (${existing.pluginId})`,
      });
      return;
    }
    const displayName = normalizeOptionalHostHookString(metadata.displayName);
    const description = normalizeOptionalHostHookString(metadata.description);
    const tags = normalizeHostHookStringList(metadata.tags);
    if (
      displayName === "" ||
      description === "" ||
      tags === null ||
      (metadata.risk !== undefined && !["low", "medium", "high"].includes(metadata.risk))
    ) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `tool metadata registration has invalid metadata: ${toolName}`,
      });
      return;
    }
    registry.toolMetadata.push({
      pluginId: record.id,
      pluginName: record.name,
      metadata: {
        ...metadata,
        toolName,
        ...(displayName !== undefined ? { displayName } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(tags !== undefined ? { tags } : {}),
      },
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  const registerControlUiDescriptor = (
    record: PluginRecord,
    descriptor: PluginControlUiDescriptor,
  ) => {
    const legacyDescriptor = descriptor as PluginControlUiDescriptor & { name?: unknown };
    const id = normalizeHostHookString(descriptor.id);
    const label = normalizeHostHookString(descriptor.label ?? legacyDescriptor.name);
    const description = normalizeOptionalHostHookString(descriptor.description);
    const placement = normalizeOptionalHostHookString(descriptor.placement);
    const requiredScopes = normalizeHostHookStringList(descriptor.requiredScopes);
    // The flat registerControlUiDescriptor API shipped before descriptor.surface/label were
    // required. Keep older external JS plugins loadable while current typed plugins stay explicit.
    const surface = typeof descriptor.surface === "string" ? descriptor.surface : "session";
    if (
      !id ||
      !label ||
      !controlUiSurfaces.has(surface) ||
      description === "" ||
      placement === "" ||
      requiredScopes === null
    ) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message:
          "control UI descriptor registration requires id, surface, label, and valid optional fields",
      });
      return;
    }
    // Validate each requiredScope against the known OperatorScope set so untyped
    // (JS) plugins cannot project arbitrary strings to clients as if they were
    // valid operator scopes.
    if (requiredScopes !== undefined) {
      const unknownScope = requiredScopes.find((scope) => !isOperatorScope(scope));
      if (unknownScope !== undefined) {
        pushDiagnostic({
          level: "error",
          pluginId: record.id,
          source: record.source,
          message: `control UI descriptor requiredScopes contains unknown operator scope: ${unknownScope}`,
        });
        return;
      }
    }
    if (descriptor.schema !== undefined && !isPluginJsonValue(descriptor.schema)) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `control UI descriptor schema must be JSON-compatible: ${id}`,
      });
      return;
    }
    const existing = registry.controlUiDescriptors.find(
      (entry) => entry.pluginId === record.id && entry.descriptor.id === id,
    );
    if (existing) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `control UI descriptor already registered: ${id}`,
      });
      return;
    }
    const icon = normalizeOptionalHostHookString(descriptor.icon);
    const tabPath = normalizeOptionalHostHookString(descriptor.path);
    // Single leading slash only: "//host" and "/\\host" are protocol-relative
    // URLs in browsers, which would let a descriptor iframe external content.
    const isLocalAbsolutePath =
      tabPath === undefined ||
      (tabPath.startsWith("/") && !tabPath.startsWith("//") && !tabPath.startsWith("/\\"));
    if (!isLocalAbsolutePath) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `control UI descriptor path must be a gateway-local absolute path: ${id}`,
      });
      return;
    }
    // Tab placement/order are projected to hello clients; keep junk values out.
    const group =
      descriptor.group === "control" || descriptor.group === "agent" ? descriptor.group : undefined;
    const order =
      typeof descriptor.order === "number" && Number.isFinite(descriptor.order)
        ? descriptor.order
        : undefined;
    registry.controlUiDescriptors.push({
      pluginId: record.id,
      pluginName: record.name,
      descriptor: {
        ...descriptor,
        id,
        surface,
        label,
        ...(description !== undefined ? { description } : {}),
        ...(placement !== undefined ? { placement } : {}),
        ...(requiredScopes !== undefined
          ? { requiredScopes: requiredScopes as OperatorScope[] }
          : {}),
        icon,
        path: tabPath,
        group,
        order,
      },
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  const registerRuntimeLifecycle = (
    record: PluginRecord,
    lifecycle: PluginRuntimeLifecycleRegistration,
  ) => {
    const id = normalizePluginHostHookId(lifecycle.id);
    if (!id) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "runtime lifecycle registration missing id",
      });
      return;
    }
    const existing = registry.runtimeLifecycles.find(
      (entry) => entry.pluginId === record.id && entry.lifecycle.id === id,
    );
    if (existing) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `runtime lifecycle already registered: ${id}`,
      });
      return;
    }
    if (lifecycle.cleanup !== undefined && typeof lifecycle.cleanup !== "function") {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `runtime lifecycle cleanup must be a function: ${id}`,
      });
      return;
    }
    registry.runtimeLifecycles.push({
      pluginId: record.id,
      pluginName: record.name,
      lifecycle: { ...lifecycle, id },
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  const registerAgentEventSubscription = (
    record: PluginRecord,
    subscription: PluginAgentEventSubscriptionRegistration,
  ) => {
    const id = normalizePluginHostHookId(subscription.id);
    if (!id || typeof subscription.handle !== "function") {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "agent event subscription registration requires id and handle",
      });
      return;
    }
    const streams = normalizeHostHookStringList(subscription.streams);
    if (streams === null) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `agent event subscription streams must be an array of strings: ${id}`,
      });
      return;
    }
    const existing = registry.agentEventSubscriptions.find(
      (entry) => entry.pluginId === record.id && entry.subscription.id === id,
    );
    if (existing) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `agent event subscription already registered: ${id}`,
      });
      return;
    }
    registry.agentEventSubscriptions.push({
      pluginId: record.id,
      pluginName: record.name,
      subscription: { ...subscription, id, ...(streams !== undefined ? { streams } : {}) },
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  const registerSessionSchedulerJob = (
    record: PluginRecord,
    job: PluginSessionSchedulerJobRegistration,
  ) => {
    const jobId = normalizeHostHookString(job.id);
    const sessionKey = normalizeHostHookString(job.sessionKey);
    const kind = normalizeHostHookString(job.kind);
    if (
      jobId &&
      registry.sessionSchedulerJobs.some(
        (entry) => entry.pluginId === record.id && entry.job.id === jobId,
      )
    ) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `session scheduler job already registered: ${jobId}`,
      });
      return undefined;
    }
    if (!jobId || !sessionKey || !kind) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "session scheduler job registration requires unique id, sessionKey, and kind",
      });
      return undefined;
    }
    if (job.cleanup !== undefined && typeof job.cleanup !== "function") {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `session scheduler job cleanup must be a function: ${jobId}`,
      });
      return undefined;
    }
    if (registryParams.activateGlobalSideEffects === false) {
      registry.sessionSchedulerJobs.push({
        pluginId: record.id,
        pluginName: record.name,
        job: { ...job, id: jobId, sessionKey, kind },
        source: record.source,
        rootDir: record.rootDir,
      });
      return { id: jobId, pluginId: record.id, sessionKey, kind };
    }
    const handle = registerPluginSessionSchedulerJob({
      pluginId: record.id,
      pluginName: record.name,
      ownerRegistry: registry,
      job: { ...job, id: jobId, sessionKey, kind },
    });
    if (!handle) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "session scheduler job registration requires unique id, sessionKey, and kind",
      });
      return undefined;
    }
    registry.sessionSchedulerJobs.push({
      pluginId: record.id,
      pluginName: record.name,
      job: { ...job, id: handle.id, sessionKey: handle.sessionKey, kind: handle.kind },
      generation: getPluginSessionSchedulerJobGeneration({
        pluginId: record.id,
        jobId: handle.id,
        sessionKey: handle.sessionKey,
      }),
      source: record.source,
      rootDir: record.rootDir,
    });
    return handle;
  };

  const registerSessionAction = (record: PluginRecord, action: PluginSessionActionRegistration) => {
    const id = normalizeHostHookString(action.id);
    const description = normalizeOptionalHostHookString(action.description);
    const requiredScopes = normalizeHostHookStringList(action.requiredScopes);
    if (
      !id ||
      description === "" ||
      requiredScopes === null ||
      typeof action.handler !== "function"
    ) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "session action registration requires id, handler, and valid optional fields",
      });
      return;
    }
    if (requiredScopes !== undefined) {
      const unknownScope = requiredScopes.find((scope) => !isOperatorScope(scope));
      if (unknownScope !== undefined) {
        pushDiagnostic({
          level: "error",
          pluginId: record.id,
          source: record.source,
          message: `session action requiredScopes contains unknown operator scope: ${unknownScope}`,
        });
        return;
      }
    }
    if (!validateSessionActionSchema(record, id, action.schema)) {
      return;
    }
    const existing = registry.sessionActions.find(
      (entry) => entry.pluginId === record.id && entry.action.id === id,
    );
    if (existing) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `session action already registered: ${id}`,
      });
      return;
    }
    registry.sessionActions.push({
      pluginId: record.id,
      pluginName: record.name,
      action: {
        ...action,
        id,
        ...(description !== undefined ? { description } : {}),
        ...(requiredScopes !== undefined
          ? { requiredScopes: requiredScopes as OperatorScope[] }
          : {}),
      },
      source: record.source,
      rootDir: record.rootDir,
    } satisfies PluginSessionActionRegistryRegistration);
  };

  const registerTypedHook = <K extends PluginHookName>(
    record: PluginRecord,
    hookName: K,
    handler: PluginHookHandlerMap[K],
    opts?: { priority?: number; timeoutMs?: number },
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
    const effectiveHookName = hookName === "deactivate" ? "gateway_stop" : hookName;
    if (hookName === "deactivate") {
      pushDiagnostic({
        level: "warn",
        pluginId: record.id,
        source: record.source,
        message: formatLegacyDeactivateHookAliasDiagnostic(),
      });
    } else {
      const deprecatedHookDiagnostic = formatDeprecatedTypedHookDiagnostic(hookName);
      if (deprecatedHookDiagnostic) {
        pushDiagnostic({
          level: "warn",
          pluginId: record.id,
          source: record.source,
          message: deprecatedHookDiagnostic,
        });
      }
    }
    let effectiveHandler = handler;
    if (policy?.allowPromptInjection === false && isPromptInjectionHookName(effectiveHookName)) {
      if (effectiveHookName !== "before_agent_start") {
        pushDiagnostic({
          level: "warn",
          pluginId: record.id,
          source: record.source,
          message: `typed hook "${effectiveHookName}" blocked by plugins.entries.${record.id}.hooks.allowPromptInjection=false`,
        });
        return;
      }
      pushDiagnostic({
        level: "warn",
        pluginId: record.id,
        source: record.source,
        message: `typed hook "${effectiveHookName}" prompt fields constrained by plugins.entries.${record.id}.hooks.allowPromptInjection=false`,
      });
      effectiveHandler = constrainLegacyPromptInjectionHook(
        handler as PluginHookHandlerMap["before_agent_start"],
      ) as PluginHookHandlerMap[K];
    }
    if (isConversationHookName(effectiveHookName)) {
      const explicitConversationAccess = policy?.allowConversationAccess;
      if (record.origin !== "bundled" && explicitConversationAccess !== true) {
        pushDiagnostic({
          level: "warn",
          pluginId: record.id,
          source: record.source,
          message:
            `typed hook "${effectiveHookName}" blocked because non-bundled plugins must set ` +
            `plugins.entries.${record.id}.hooks.allowConversationAccess=true`,
        });
        return;
      }
      if (record.origin === "bundled" && explicitConversationAccess === false) {
        pushDiagnostic({
          level: "warn",
          pluginId: record.id,
          source: record.source,
          message: `typed hook "${effectiveHookName}" blocked by plugins.entries.${record.id}.hooks.allowConversationAccess=false`,
        });
        return;
      }
    }
    const timeoutMs = resolveTypedHookTimeoutMs({ hookName: effectiveHookName, opts, policy });
    record.hookCount += 1;
    registry.typedHooks.push({
      pluginId: record.id,
      hookName: effectiveHookName,
      handler: effectiveHandler,
      priority: opts?.priority,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
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
  const pluginRuntimeRecordById = new Map<string, PluginRecord>();

  const addPluginRuntimeResolutionContext = (params: {
    error: unknown;
    pluginId: string;
    prop: PropertyKey;
  }): never => {
    const { error, pluginId, prop } = params;
    if (
      error instanceof Error &&
      error.message.startsWith("Unable to resolve plugin runtime module") &&
      !error.message.includes("pluginRuntimeContext=")
    ) {
      const record =
        pluginRuntimeRecordById.get(pluginId) ??
        registry.plugins.find((entry) => entry.id === pluginId);
      const propName =
        typeof prop === "symbol" ? (prop.description ?? prop.toString()) : String(prop);
      error.message = [
        error.message,
        `pluginRuntimeContext=pluginId:${pluginId}`,
        `property:${propName}`,
        ...(record?.source ? [`source:${record.source}`] : []),
      ].join("; ");
    }
    throw error;
  };

  const resolvePluginRuntime = (pluginId: string): PluginRuntime => {
    const cached = pluginRuntimeById.get(pluginId);
    if (cached) {
      return cached;
    }
    const resolveHarnessRegistration = (harnessId: unknown) => {
      const normalizedHarnessId = normalizeOptionalAgentRuntimeId(harnessId);
      return normalizedHarnessId
        ? registry.agentHarnesses.find(
            (entry) => normalizeOptionalAgentRuntimeId(entry.harness.id) === normalizedHarnessId,
          )
        : undefined;
    };
    const resolveHarnessRegistrationForSessionKey = (sessionKey: string) =>
      registry.agentHarnesses.find((entry) => {
        const rawHarnessId = normalizeOptionalString(entry.harness.id)?.toLowerCase();
        return (
          rawHarnessId === normalizeOptionalAgentRuntimeId(rawHarnessId) &&
          isAgentHarnessSessionKeyOwnedBy(sessionKey, rawHarnessId)
        );
      });
    const assertOwnedHarness = (harnessId: unknown, action: string): string => {
      const normalizedHarnessId = normalizeOptionalAgentRuntimeId(harnessId);
      if (!normalizedHarnessId) {
        throw new Error(
          `Plugin "${pluginId}" must provide a registered agent harness id to ${action}.`,
        );
      }
      const registration = resolveHarnessRegistration(normalizedHarnessId);
      if (!registration) {
        throw new Error(
          `Plugin "${pluginId}" must register agent harness "${normalizedHarnessId}" before it can ${action}.`,
        );
      }
      if (registration.pluginId !== pluginId) {
        throw new Error(
          `Agent harness "${normalizedHarnessId}" is owned by plugin "${registration.pluginId}", not "${pluginId}".`,
        );
      }
      return normalizedHarnessId;
    };
    const assertReservedSessionKeyOwned = (sessionKey: unknown, action: string): void => {
      const normalizedSessionKey = normalizeOptionalString(sessionKey);
      if (!normalizedSessionKey || !isAgentHarnessSessionKey(normalizedSessionKey)) {
        return;
      }
      const registration = resolveHarnessRegistrationForSessionKey(normalizedSessionKey);
      if (!registration) {
        throw new Error(
          `Plugin "${pluginId}" cannot ${action} reserved agent harness session "${normalizedSessionKey}" because its harness is not registered.`,
        );
      }
      if (registration.pluginId !== pluginId) {
        throw new Error(
          `Plugin "${pluginId}" cannot ${action} reserved agent harness session "${normalizedSessionKey}" owned by plugin "${registration.pluginId}".`,
        );
      }
    };
    const resolveLockedSessionHarnessRegistration = (
      sessionKey: string,
      entry: SessionEntry,
      action: string,
    ) => {
      if (entry.modelSelectionLocked !== true) {
        return undefined;
      }
      const harnessId = normalizeOptionalAgentRuntimeId(entry.agentHarnessId);
      if (!harnessId) {
        const pluginOwnerId = normalizeOptionalString(entry.pluginOwnerId);
        if (pluginOwnerId) {
          return { ownerPluginId: pluginOwnerId };
        }
        throw new Error(
          `Plugin "${pluginId}" must provide a registered agent harness id to ${action} locked sessions.`,
        );
      }
      const registration = resolveHarnessRegistration(harnessId);
      if (!registration) {
        throw new Error(
          `Plugin "${pluginId}" must register agent harness "${harnessId}" before it can ${action} locked sessions.`,
        );
      }
      if (
        isAgentHarnessSessionKey(sessionKey) &&
        !isAgentHarnessSessionKeyOwnedBy(sessionKey, harnessId)
      ) {
        throw new Error(
          `Locked session "${sessionKey}" belongs to agent harness "${harnessId}", which does not match its reserved session key.`,
        );
      }
      return { ownerPluginId: registration.pluginId, harnessId, registration };
    };
    const assertLockedSessionEntryOwned = (
      sessionKey: string,
      entry: SessionEntry,
      action: string,
    ): void => {
      const resolved = resolveLockedSessionHarnessRegistration(sessionKey, entry, action);
      if (!resolved) {
        return;
      }
      if (resolved.ownerPluginId !== pluginId) {
        throw new Error(
          `Locked session "${sessionKey}" is owned by plugin "${resolved.ownerPluginId}", not "${pluginId}".`,
        );
      }
    };
    const assertSessionEntryOwned = (params: {
      action: string;
      entry?: SessionEntry;
      sessionKey: string;
    }): void => {
      if (params.entry) {
        // Before harness locking shipped, plugins could create ordinary sessions
        // whose user-chosen key happened to start with `harness:`.
        assertLockedSessionEntryOwned(params.sessionKey, params.entry, params.action);
        return;
      }
      assertReservedSessionKeyOwned(params.sessionKey, params.action);
    };
    const assertStoredSessionEntryOwned = (params: {
      action: string;
      agentId?: string;
      env?: NodeJS.ProcessEnv;
      sessionKey: string;
      storePath?: string;
    }): SessionEntry | undefined => {
      const entry = registryParams.runtime.agent.session.getSessionEntry({
        sessionKey: params.sessionKey,
        readConsistency: "latest",
        ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
        ...(params.env !== undefined ? { env: params.env } : {}),
        ...(params.storePath !== undefined ? { storePath: params.storePath } : {}),
      });
      assertSessionEntryOwned({ action: params.action, entry, sessionKey: params.sessionKey });
      return entry;
    };
    const resolveStoredSessionExecutionOwner = (params: {
      action: string;
      agentId?: string;
      sessionKey: string;
      storePath?: string;
    }): string | undefined => {
      const entry = registryParams.runtime.agent.session.getSessionEntry({
        sessionKey: params.sessionKey,
        readConsistency: "latest",
        ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
        ...(params.storePath !== undefined ? { storePath: params.storePath } : {}),
      });
      const locked = entry
        ? resolveLockedSessionHarnessRegistration(params.sessionKey, entry, params.action)
        : undefined;
      if (!entry || !locked || locked.ownerPluginId === pluginId) {
        assertSessionEntryOwned({ action: params.action, entry, sessionKey: params.sessionKey });
        return undefined;
      }
      const registration = "registration" in locked ? locked.registration : undefined;
      if (!registration) {
        throw new Error(
          `Locked session "${params.sessionKey}" is owned by plugin "${locked.ownerPluginId}", not "${pluginId}".`,
        );
      }
      if (!registration.harness.delegatedExecutionPluginIds?.includes(pluginId)) {
        assertLockedSessionEntryOwned(params.sessionKey, entry, params.action);
      }
      return locked.ownerPluginId;
    };
    const assertSessionIdentitiesOwned = (params: {
      action: string;
      agentId?: unknown;
      sessionFiles?: unknown[];
      sessionIds?: unknown[];
      sessionKeys?: unknown[];
      storePath?: unknown;
    }): void => {
      const agentId = normalizeOptionalString(params.agentId);
      const storePath = normalizeOptionalString(params.storePath);
      const sessionKeys = new Set<string>();
      for (const value of params.sessionKeys ?? []) {
        const sessionKey = normalizeOptionalString(value);
        if (sessionKey) {
          sessionKeys.add(sessionKey);
        }
      }
      for (const sessionKey of sessionKeys) {
        assertStoredSessionEntryOwned({
          action: params.action,
          sessionKey,
          ...(agentId ? { agentId } : {}),
          ...(storePath ? { storePath } : {}),
        });
      }

      const sessionIds = new Set<string>();
      for (const value of params.sessionIds ?? []) {
        const sessionId = normalizeOptionalString(value);
        if (sessionId) {
          sessionIds.add(sessionId);
        }
      }
      const sessionFiles = new Set<string>();
      for (const value of params.sessionFiles ?? []) {
        const sessionFile = normalizeOptionalString(value);
        if (sessionFile) {
          sessionFiles.add(sessionFile);
        }
      }
      if (sessionIds.size === 0 && sessionFiles.size === 0) {
        return;
      }
      const entries = registryParams.runtime.agent.session.listSessionEntries({
        ...(agentId ? { agentId } : {}),
        ...(storePath ? { storePath } : {}),
      });
      for (const { sessionKey, entry } of entries) {
        if (
          sessionIds.has(entry.sessionId) ||
          (entry.sessionFile ? sessionFiles.has(entry.sessionFile) : false)
        ) {
          assertSessionEntryOwned({ action: params.action, entry, sessionKey });
        }
      }
    };
    const resolveRunSessionExecutionOwner = (
      params: Parameters<PluginRuntime["agent"]["runEmbeddedAgent"]>[0],
    ): string | undefined => {
      const target = params.sessionTarget;
      const targetSessionKey = normalizeOptionalString(target?.sessionKey);
      const directSessionKey = normalizeOptionalString(params.sessionKey);
      if (targetSessionKey && directSessionKey && targetSessionKey !== directSessionKey) {
        throw new Error("Delegated agent execution requires one exact session key.");
      }
      const sessionKey = targetSessionKey ?? directSessionKey;
      const storePath = normalizeOptionalString(target?.storePath);
      const agentId = normalizeOptionalString(target?.agentId ?? params.agentId);
      const entry = sessionKey
        ? registryParams.runtime.agent.session.getSessionEntry({
            sessionKey,
            readConsistency: "latest",
            ...(agentId ? { agentId } : {}),
            ...(storePath ? { storePath } : {}),
          })
        : undefined;
      const targetSessionId = normalizeOptionalString(target?.sessionId);
      const targetAgentId = normalizeOptionalString(target?.agentId);
      const directSessionId = normalizeOptionalString(params.sessionId);
      const directAgentId = normalizeOptionalString(params.agentId);
      const sessionFile = normalizeOptionalString(params.sessionFile);
      if (target) {
        const targetIdentityMatches =
          targetSessionKey === sessionKey &&
          Boolean(storePath) &&
          Boolean(entry) &&
          targetSessionId === entry?.sessionId &&
          directSessionId === entry?.sessionId &&
          targetAgentId === directAgentId &&
          (!sessionFile || sessionFile === entry?.sessionFile);
        if (!targetIdentityMatches) {
          throw new Error(
            `Plugin "${pluginId}" may execute a persisted session only with its exact session target identity.`,
          );
        }
      }
      const locked =
        sessionKey && entry
          ? resolveLockedSessionHarnessRegistration(sessionKey, entry, "run")
          : undefined;
      const ownerPluginId = locked?.ownerPluginId;
      if (locked && entry && sessionKey && ownerPluginId !== pluginId) {
        const registration = "registration" in locked ? locked.registration : undefined;
        if (!registration) {
          throw new Error(
            `Locked session "${sessionKey}" is owned by plugin "${locked.ownerPluginId}", not "${pluginId}".`,
          );
        }
        if (!registration.harness.delegatedExecutionPluginIds?.includes(pluginId)) {
          assertLockedSessionEntryOwned(sessionKey, entry, "run");
        }
        const requestedHarnessId = normalizeOptionalAgentRuntimeId(params.agentHarnessId);
        const requestedRuntimeOverride = normalizeOptionalAgentRuntimeId(
          params.agentHarnessRuntimeOverride,
        );
        const identityMatches =
          Boolean(target) &&
          targetSessionId === entry.sessionId &&
          directSessionId === entry.sessionId;
        const harnessMatches =
          params.modelSelectionLocked === true &&
          requestedHarnessId === locked.harnessId &&
          requestedRuntimeOverride === locked.harnessId;
        if (!identityMatches || !harnessMatches) {
          throw new Error(
            `Plugin "${pluginId}" may execute locked session "${sessionKey}" only with its exact persisted identity and harness.`,
          );
        }
        return ownerPluginId;
      }
      assertSessionIdentitiesOwned({
        action: "run",
        agentId: target?.agentId ?? params.agentId,
        sessionFiles: [params.sessionFile],
        sessionIds: [target?.sessionId ?? params.sessionId],
        sessionKeys: [target?.sessionKey ?? params.sessionKey],
        storePath: target?.storePath,
      });
      return undefined;
    };
    const assertGatewaySessionRequestOwned = (
      method: string,
      params: Record<string, unknown> | undefined,
    ): void => {
      if (PLUGIN_GATEWAY_GLOBAL_SESSION_MUTATION_METHODS.has(method)) {
        throw new Error(`Plugin "${pluginId}" cannot request global session mutation "${method}".`);
      }
      if (!PLUGIN_GATEWAY_SESSION_MUTATION_METHODS.has(method)) {
        return;
      }
      const request = params ?? {};
      const sessionKeys = [request.sessionKey, request.key, request.parentSessionKey];
      const sessionIds = [request.sessionId];
      assertSessionIdentitiesOwned({
        action: `request gateway method "${method}" for`,
        agentId: request.agentId,
        sessionIds,
        sessionKeys,
      });
      if (
        method === "sessions.abort" &&
        !sessionKeys.some((value) => normalizeOptionalString(value)) &&
        !sessionIds.some((value) => normalizeOptionalString(value))
      ) {
        throw new Error(
          `Plugin "${pluginId}" must provide a session key when requesting gateway method "${method}".`,
        );
      }
    };
    const assertStoreEntryOwned = (params: {
      action: string;
      before?: SessionEntry;
      entry: SessionEntry;
      sessionKey: string;
    }): void => {
      if (params.entry.modelSelectionLocked === true) {
        assertLockedSessionEntryOwned(params.sessionKey, params.entry, params.action);
        return;
      }
      if (params.before?.modelSelectionLocked === true) {
        assertLockedSessionEntryOwned(params.sessionKey, params.before, params.action);
        return;
      }
      if (isAgentHarnessSessionKey(params.sessionKey) && !params.before) {
        assertReservedSessionKeyOwned(params.sessionKey, params.action);
      }
    };
    let scopedAgentRuntime: PluginRuntime["agent"] | undefined;
    const runtime = new Proxy(registryParams.runtime, {
      get(target, prop, receiver) {
        const runWithPluginScope = <T>(run: () => T): T => {
          const record =
            pluginRuntimeRecordById.get(pluginId) ??
            registry.plugins.find((entry) => entry.id === pluginId);
          return record?.source
            ? withPluginRuntimePluginScope(
                {
                  pluginId,
                  pluginSource: record.source,
                  pluginOrigin: record.origin,
                  pluginTrustedOfficialInstall: record.trustedOfficialInstall,
                },
                run,
              )
            : withPluginRuntimePluginScope({ pluginId }, run);
        };
        const getRuntimeProperty = () => {
          try {
            return Reflect.get(target, prop, receiver);
          } catch (error) {
            return addPluginRuntimeResolutionContext({ error, pluginId, prop });
          }
        };
        if (prop === "state") {
          const baseState = getRuntimeProperty();
          const assertPluginStateAllowed = () => {
            const record =
              pluginRuntimeRecordById.get(pluginId) ??
              registry.plugins.find((entry) => entry.id === pluginId);
            if (record?.origin !== "bundled" && record?.trustedOfficialInstall !== true) {
              throw new Error(
                "openKeyedStore is only available for trusted plugins in this release.",
              );
            }
          };
          return {
            ...baseState,
            openKeyedStore: <T>(options: OpenKeyedStoreOptions): PluginStateKeyedStore<T> => {
              assertPluginStateAllowed();
              return createPluginStateKeyedStore<T>(pluginId, options);
            },
            openSyncKeyedStore: <T>(
              options: OpenKeyedStoreOptions,
            ): PluginStateSyncKeyedStore<T> => {
              assertPluginStateAllowed();
              return createPluginStateSyncKeyedStore<T>(pluginId, options);
            },
            openChannelIngressQueue: <TPayload, TMetadata = unknown, TCompletedMetadata = unknown>(
              options?: Omit<Parameters<typeof createChannelIngressQueue>[0], "channelId">,
            ) => {
              assertPluginStateAllowed();
              const stateDir = options?.stateDir ?? baseState.resolveStateDir();
              return createChannelIngressQueue<TPayload, TMetadata, TCompletedMetadata>({
                ...options,
                channelId: pluginId,
                stateDir,
              });
            },
          } satisfies PluginRuntime["state"];
        }
        if (prop === "config") {
          const config: PluginRuntime["config"] = getRuntimeProperty();
          return {
            ...config,
            current: () => runWithPluginScope(() => config.current()),
            mutateConfigFile: (params) => runWithPluginScope(() => config.mutateConfigFile(params)),
            replaceConfigFile: (params) =>
              runWithPluginScope(() => config.replaceConfigFile(params)),
          } satisfies PluginRuntime["config"];
        }
        if (prop === "llm") {
          const llm = getRuntimeProperty();
          return {
            acquireLocalService: (...args) =>
              withPluginRuntimePluginIdScope(pluginId, () => llm.acquireLocalService(...args)),
            complete: (params) =>
              withPluginRuntimePluginIdScope(pluginId, () => llm.complete(params)),
          } satisfies PluginRuntime["llm"];
        }
        if (prop === "gateway") {
          const gateway = getRuntimeProperty();
          return {
            isAvailable: () => runWithPluginScope(() => gateway.isAvailable()),
            request: async (method, params, options) =>
              await runWithPluginScope(async () => {
                assertGatewaySessionRequestOwned(method, params);
                return await gateway.request(method, params, options);
              }),
          } satisfies PluginRuntime["gateway"];
        }
        if (prop === "nodes") {
          const nodes = getRuntimeProperty();
          return {
            list: (params) => runWithPluginScope(() => nodes.list(params)),
            invoke: (params) => runWithPluginScope(() => nodes.invoke(params)),
          } satisfies PluginRuntime["nodes"];
        }
        if (prop === "agent") {
          if (scopedAgentRuntime) {
            return scopedAgentRuntime;
          }
          const agent: PluginRuntime["agent"] = getRuntimeProperty();
          const session = agent.session;
          const scopedSession = {
            resolveStorePath: session.resolveStorePath,
            getSessionEntry: session.getSessionEntry,
            listSessionEntries: session.listSessionEntries,
            createSessionEntry: async (params) =>
              await runWithPluginScope(async () => {
                if (
                  "agentHarnessId" in params.initialEntry ===
                  "cliBackendId" in params.initialEntry
                ) {
                  throw new Error(
                    `Plugin "${pluginId}" session creation requires exactly one runtime owner.`,
                  );
                }
                if ("agentHarnessId" in params.initialEntry) {
                  // Session ownership follows the registered harness capability,
                  // independently of whether the caller chooses its reserved namespace.
                  assertOwnedHarness(params.initialEntry.agentHarnessId, "create its sessions");
                  assertReservedSessionKeyOwned(params.key, "create");
                  return await session.createSessionEntry(params);
                }
                const cliInitial = params.initialEntry;
                const backend = registry.cliBackends.find(
                  (entry) => entry.backend.id === cliInitial.cliBackendId,
                );
                if (!backend || backend.pluginId !== pluginId) {
                  throw new Error(
                    `Plugin "${pluginId}" must own CLI backend "${cliInitial.cliBackendId}" to create its sessions.`,
                  );
                }
                // Plugin-owned sessions stay inside a namespace that no other plugin can claim.
                if (!params.key.startsWith(`plugin:${pluginId}:`)) {
                  throw new Error(
                    `Plugin "${pluginId}" session keys must start with "plugin:${pluginId}:".`,
                  );
                }
                return await session.createSessionEntry({
                  ...params,
                  initialEntry: { ...cliInitial, pluginOwnerId: pluginId },
                });
              }),
            patchSessionEntry: async (params) =>
              await runWithPluginScope(async () => {
                assertStoredSessionEntryOwned({
                  action: "patch",
                  sessionKey: params.sessionKey,
                  ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
                  ...(params.env !== undefined ? { env: params.env } : {}),
                  ...(params.storePath !== undefined ? { storePath: params.storePath } : {}),
                });
                return await session.patchSessionEntry({
                  ...params,
                  update: async (entry, context) => {
                    const patch = await params.update(entry, context);
                    if (!patch) {
                      return patch;
                    }
                    const next = params.replaceEntry
                      ? (patch as SessionEntry)
                      : ({ ...entry, ...patch } satisfies SessionEntry);
                    assertStoreEntryOwned({
                      action: "patch",
                      before: context.existingEntry ?? entry,
                      entry: next,
                      sessionKey: params.sessionKey,
                    });
                    return patch;
                  },
                });
              }),
            upsertSessionEntry: async (params) =>
              await runWithPluginScope(async () => {
                const before = assertStoredSessionEntryOwned({
                  action: "upsert",
                  sessionKey: params.sessionKey,
                  ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
                  ...(params.env !== undefined ? { env: params.env } : {}),
                  ...(params.storePath !== undefined ? { storePath: params.storePath } : {}),
                });
                assertStoreEntryOwned({
                  action: "upsert",
                  before,
                  entry: params.entry,
                  sessionKey: params.sessionKey,
                });
                await session.upsertSessionEntry(params);
              }),
            runWithWorkAdmission: async (params, run) =>
              await runWithPluginScope(async () => {
                const resolveCurrentExecutionOwner = () =>
                  resolveStoredSessionExecutionOwner({
                    action: "admit work on",
                    sessionKey: params.sessionKey,
                    storePath: params.storePath,
                  });
                const ownerPluginId = resolveCurrentExecutionOwner();
                const admissionSession = ownerPluginId
                  ? resolvePluginRuntime(ownerPluginId).agent.session
                  : session;
                return await admissionSession.runWithWorkAdmission(params, async (signal) => {
                  // Admission can wait behind another run that changes ownership.
                  // Recheck delegation inside the admitted callback before plugin work starts.
                  if (resolveCurrentExecutionOwner() !== ownerPluginId) {
                    throw new Error(
                      `Session "${params.sessionKey}" changed execution ownership while starting work.`,
                    );
                  }
                  // The owner supplies the admission primitive, but the caller's
                  // callback must not inherit the owner's plugin identity.
                  return await runWithPluginScope(() => run(signal));
                });
              }),
            updateSessionStoreEntry: async (params) =>
              await runWithPluginScope(async () => {
                assertStoredSessionEntryOwned({
                  action: "update",
                  sessionKey: params.sessionKey,
                  storePath: params.storePath,
                });
                return await session.updateSessionStoreEntry({
                  ...params,
                  update: async (entry) => {
                    const patch = await params.update(entry);
                    if (!patch) {
                      return patch;
                    }
                    assertStoreEntryOwned({
                      action: "update",
                      before: entry,
                      entry: { ...entry, ...patch },
                      sessionKey: params.sessionKey,
                    });
                    return patch;
                  },
                });
              }),
          } satisfies PluginRuntime["agent"]["session"];
          const runEmbeddedAgent: PluginRuntime["agent"]["runEmbeddedAgent"] = async (params) =>
            await runWithPluginScope(async () => {
              const ownerPluginId = resolveRunSessionExecutionOwner(params);
              return ownerPluginId
                ? await resolvePluginRuntime(ownerPluginId).agent.runEmbeddedAgent(params)
                : await agent.runEmbeddedAgent(params);
            });
          const scopedAgent = Object.create(
            Object.getPrototypeOf(agent),
            Object.getOwnPropertyDescriptors(agent),
          ) as PluginRuntime["agent"];
          Object.defineProperties(scopedAgent, {
            runEmbeddedAgent: {
              configurable: true,
              enumerable: true,
              value: runEmbeddedAgent,
            },
            runEmbeddedPiAgent: {
              configurable: true,
              enumerable: true,
              value: runEmbeddedAgent,
            },
            session: {
              configurable: true,
              enumerable: true,
              value: scopedSession,
            },
          });
          scopedAgentRuntime = scopedAgent;
          return scopedAgentRuntime;
        }
        if (prop !== "subagent") {
          return getRuntimeProperty();
        }
        const subagent = getRuntimeProperty();
        return {
          run: async (params) =>
            await withPluginRuntimePluginIdScope(pluginId, async () => {
              assertSessionIdentitiesOwned({
                action: "run",
                sessionKeys: [params.sessionKey],
              });
              return await subagent.run(params);
            }),
          waitForRun: (params) =>
            withPluginRuntimePluginIdScope(pluginId, () => subagent.waitForRun(params)),
          getSessionMessages: (params) =>
            withPluginRuntimePluginIdScope(pluginId, () => subagent.getSessionMessages(params)),
          getSession: (params) =>
            withPluginRuntimePluginIdScope(pluginId, () => subagent.getSession(params)),
          deleteSession: async (params) =>
            await withPluginRuntimePluginIdScope(pluginId, async () => {
              assertStoredSessionEntryOwned({ action: "delete", sessionKey: params.sessionKey });
              await subagent.deleteSession(params);
            }),
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
    const registrationCapabilities = resolvePluginRegistrationCapabilities(registrationMode);
    pluginRuntimeRecordById.set(record.id, record);
    const sideEffectGuard = createPluginSideEffectGuard(record.id);
    const isLoadedRecordInRegistry = () =>
      registry.plugins.some((plugin) => plugin.id === record.id && plugin.status === "loaded");
    const isLoadedRecordInActiveRegistry = () =>
      getActivePluginRegistry() === registry && isLoadedRecordInRegistry();
    const isActivatingLoadedRecord = () =>
      registryParams.activateGlobalSideEffects !== false &&
      record.enabled &&
      record.status === "loaded" &&
      !registry.plugins.some((plugin) => plugin.id === record.id);
    const shouldCommitWorkflowSideEffect = () =>
      sideEffectGuard.active &&
      !isPluginRegistryRetired(registry) &&
      (isActivatingLoadedRecord() ||
        (isPluginRegistryActivated(registry) && isLoadedRecordInRegistry()));
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
      resolvePath: (input: string) => resolvePluginPath(input, record.rootDir),
      handlers: {
        ...(registrationCapabilities.capabilityHandlers
          ? {
              registerTool: (tool, opts) => registerTool(record, tool, opts),
              registerHook: (events, handler, opts) =>
                registerHook(record, events, handler, opts, params.config, params.pluginConfig),
              registerHttpRoute: (routeParams) => registerHttpRoute(record, routeParams),
              registerHostedMediaResolver: (resolver) =>
                registerHostedMediaResolver(record, resolver),
              registerProvider: (provider) => registerProvider(record, provider),
              registerWorkerProvider: (provider) => registerWorkerProvider(record, provider),
              registerModelCatalogProvider: (provider) =>
                registerModelCatalogProvider(record, provider),
              registerEmbeddingProvider: (provider) =>
                registerEmbeddingProviderForPlugin(record, provider),
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
              registerTranscriptSourceProvider: (provider) =>
                registerTranscriptSourceProvider(record, provider),
              registerImageGenerationProvider: (provider) =>
                registerImageGenerationProvider(record, provider),
              registerVideoGenerationProvider: (provider) =>
                registerVideoGenerationProvider(record, provider),
              registerMusicGenerationProvider: (provider) =>
                registerMusicGenerationProvider(record, provider),
              registerWebFetchProvider: (provider) => registerWebFetchProvider(record, provider),
              registerWebSearchProvider: (provider) => registerWebSearchProvider(record, provider),
              registerMigrationProvider: (provider) => registerMigrationProvider(record, provider),
              registerGatewayMethod: (method, handler, opts) =>
                registerGatewayMethod(record, method, handler, opts),
              registerSessionCatalog: (provider) => registerSessionCatalog(record, provider),
              registerService: (service) => registerService(record, service),
              registerGatewayDiscoveryService: (service) =>
                registerGatewayDiscoveryService(record, service),
              registerCliBackend: (backend) => registerCliBackend(record, backend),
              registerTextTransforms: (transforms) => registerTextTransforms(record, transforms),
              registerReload: (registration) => registerReload(record, registration),
              registerNodeHostCommand: (command) => registerNodeHostCommand(record, command),
              registerNodeInvokePolicy: (policy) =>
                registerNodeInvokePolicy(record, policy, params.pluginConfig),
              registerSecurityAuditCollector: (collector) =>
                registerSecurityAuditCollector(record, collector),
              registerInteractiveHandler: (registration) => {
                const result = registerRegistryPluginInteractiveHandler(record.id, registration, {
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
                  return;
                }
                registry.interactiveHandlers.push({
                  ...registration,
                  pluginId: record.id,
                  pluginName: record.name,
                  pluginRoot: record.rootDir,
                });
              },
              onConversationBindingResolved: (handler) =>
                registerConversationBindingResolvedHandler(record, handler),
              registerCommand: (command) => registerCommand(record, command),
              registerContextEngine: (id, factory) => {
                const normalizedId = normalizeOptionalString(id) ?? "";
                if (!normalizedId) {
                  pushDiagnostic({
                    level: "error",
                    pluginId: record.id,
                    source: record.source,
                    message: "context engine registration missing id",
                  });
                  return;
                }
                if (typeof factory !== "function") {
                  pushDiagnostic({
                    level: "error",
                    pluginId: record.id,
                    source: record.source,
                    message: `context engine "${normalizedId}" registration missing factory`,
                  });
                  return;
                }
                if (normalizedId === defaultSlotIdForKey("contextEngine")) {
                  pushDiagnostic({
                    level: "error",
                    pluginId: record.id,
                    source: record.source,
                    message: `context engine id reserved by core: ${normalizedId}`,
                  });
                  return;
                }
                const result = registerContextEngineForOwner(
                  normalizedId,
                  factory,
                  `plugin:${record.id}`,
                  {
                    allowSameOwnerRefresh: true,
                    lifecycle: registrationMode === "full" ? "runtime" : "readOnlyDiscovery",
                  },
                );
                if (!result.ok) {
                  pushDiagnostic({
                    level: "error",
                    pluginId: record.id,
                    source: record.source,
                    message: `context engine already registered: ${normalizedId} (${result.existingOwner})`,
                  });
                  return;
                }
                if (!record.contextEngineIds?.includes(normalizedId)) {
                  record.contextEngineIds = [...(record.contextEngineIds ?? []), normalizedId];
                }
              },
              registerCompactionProvider: (
                provider: Parameters<OpenClawPluginApi["registerCompactionProvider"]>[0],
              ) => {
                const id = normalizeOptionalString(
                  (
                    provider as Partial<
                      Parameters<OpenClawPluginApi["registerCompactionProvider"]>[0]
                    > | null
                  )?.id,
                );
                if (!id) {
                  pushDiagnostic({
                    level: "error",
                    pluginId: record.id,
                    source: record.source,
                    message: "compaction provider registration missing id",
                  });
                  return;
                }
                if (typeof provider?.summarize !== "function") {
                  pushDiagnostic({
                    level: "error",
                    pluginId: record.id,
                    source: record.source,
                    message: `compaction provider "${id}" registration missing summarize`,
                  });
                  return;
                }
                const existing = getRegisteredCompactionProvider(id);
                if (existing) {
                  const ownerDetail = existing.ownerPluginId
                    ? ` (owner: ${existing.ownerPluginId})`
                    : "";
                  pushDiagnostic({
                    level: "error",
                    pluginId: record.id,
                    source: record.source,
                    message: `compaction provider already registered: ${id}${ownerDetail}`,
                  });
                  return;
                }
                registerCompactionProvider(provider, { ownerPluginId: record.id });
              },
              registerCodexAppServerExtensionFactory: (factory) => {
                registerCodexAppServerExtensionFactory(record, factory);
              },
              registerAgentToolResultMiddleware: (handler, options) => {
                registerAgentToolResultMiddleware(record, handler, options);
              },
              registerSessionExtension: (extension) => registerSessionExtension(record, extension),
              enqueueNextTurnInjection: (injection) => {
                if (params.hookPolicy?.allowPromptInjection === false) {
                  pushDiagnostic({
                    level: "warn",
                    pluginId: record.id,
                    source: record.source,
                    message: `next-turn injection blocked by plugins.entries.${record.id}.hooks.allowPromptInjection=false`,
                  });
                  return Promise.resolve({
                    enqueued: false,
                    id: "",
                    sessionKey: injection.sessionKey,
                  });
                }
                return enqueuePluginNextTurnInjection({
                  cfg: registryParams.runtime.config.current() as OpenClawConfig,
                  pluginId: record.id,
                  pluginName: record.name,
                  injection,
                });
              },
              registerTrustedToolPolicy: (policy) => registerTrustedToolPolicy(record, policy),
              registerToolMetadata: (metadata) => registerToolMetadata(record, metadata),
              registerControlUiDescriptor: (descriptor) =>
                registerControlUiDescriptor(record, descriptor),
              registerRuntimeLifecycle: (lifecycle) => registerRuntimeLifecycle(record, lifecycle),
              registerAgentEventSubscription: (subscription) =>
                registerAgentEventSubscription(record, subscription),
              emitAgentEvent: (event) => {
                if (registryParams.activateGlobalSideEffects === false) {
                  return { emitted: false, reason: "global side effects disabled" };
                }
                if (!shouldCommitWorkflowSideEffect()) {
                  return { emitted: false, reason: "plugin is not loaded" };
                }
                return emitPluginAgentEvent({
                  pluginId: record.id,
                  pluginName: record.name,
                  origin: record.origin,
                  event,
                });
              },
              setRunContext: (patch) =>
                registryParams.activateGlobalSideEffects !== false &&
                shouldCommitWorkflowSideEffect()
                  ? setPluginRunContext({ pluginId: record.id, patch })
                  : false,
              getRunContext: (get) => getPluginRunContext({ pluginId: record.id, get }),
              clearRunContext: (paramsLocal) => {
                if (
                  registryParams.activateGlobalSideEffects === false ||
                  !shouldCommitWorkflowSideEffect()
                ) {
                  return;
                }
                clearPluginRunContext({
                  pluginId: record.id,
                  runId: paramsLocal.runId,
                  namespace: paramsLocal.namespace,
                });
              },
              registerSessionSchedulerJob: (job) => registerSessionSchedulerJob(record, job),
              registerSessionAction: (action) => registerSessionAction(record, action),
              sendSessionAttachment: async (attachment) => {
                if (registryParams.activateGlobalSideEffects === false) {
                  return { ok: false, error: "global side effects disabled" };
                }
                try {
                  if (!isLoadedRecordInActiveRegistry()) {
                    return { ok: false, error: "plugin is not loaded" };
                  }
                  const runtimeConfig =
                    (registryParams.runtime.config?.current?.() as OpenClawConfig | undefined) ??
                    params.config;
                  return await sendPluginSessionAttachment({
                    ...attachment,
                    config: runtimeConfig,
                    origin: record.origin,
                  });
                } catch (error) {
                  return {
                    ok: false,
                    error: `attachment delivery setup failed: ${formatErrorMessage(error)}`,
                  };
                }
              },
              scheduleSessionTurn: async (schedule) => {
                if (registryParams.activateGlobalSideEffects === false) {
                  return undefined;
                }
                await Promise.resolve();
                return schedulePluginSessionTurn({
                  pluginId: record.id,
                  pluginName: record.name,
                  origin: record.origin,
                  schedule,
                  cron: getHostCronService(),
                  shouldCommit: isLoadedRecordInActiveRegistry,
                  ownerRegistry: registry,
                });
              },
              unscheduleSessionTurnsByTag: async (request) => {
                if (registryParams.activateGlobalSideEffects === false) {
                  return { removed: 0, failed: 0 };
                }
                await Promise.resolve();
                if (!isLoadedRecordInActiveRegistry()) {
                  return { removed: 0, failed: 0 };
                }
                return unschedulePluginSessionTurnsByTag({
                  pluginId: record.id,
                  origin: record.origin,
                  cron: getHostCronService(),
                  request,
                });
              },
              registerMemoryCapability: (capability) => {
                if (!hasKind(record.kind, "memory")) {
                  throwRegistrationError("only memory plugins can register a memory capability");
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
                  throwRegistrationError(
                    "only memory plugins can register a memory prompt section",
                  );
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
                registerMemoryPromptSectionForPlugin(record.id, builder);
              },
              registerMemoryPromptSupplement: (builder) => {
                if (typeof builder !== "function") {
                  pushDiagnostic({
                    level: "error",
                    pluginId: record.id,
                    source: record.source,
                    message: "memory prompt supplement registration missing builder",
                  });
                  return;
                }
                registerMemoryPromptSupplement(record.id, builder);
              },
              registerMemoryCorpusSupplement: (supplement) => {
                registerMemoryCorpusSupplement(record.id, supplement);
              },
              registerMemoryFlushPlan: (resolver) => {
                if (!hasKind(record.kind, "memory")) {
                  throwRegistrationError("only memory plugins can register a memory flush plan");
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
                registerMemoryFlushPlanResolverForPlugin(record.id, resolver);
              },
              registerMemoryRuntime: (runtime) => {
                if (!hasKind(record.kind, "memory")) {
                  throwRegistrationError("only memory plugins can register a memory runtime");
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
                registerMemoryRuntimeForPlugin(record.id, runtime);
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
        ...(registrationCapabilities.setupRuntimeHandlers
          ? {
              registerHttpRoute: (routeParams) => registerHttpRoute(record, routeParams),
              registerGatewayMethod: (method, handler, opts) =>
                registerGatewayMethod(record, method, handler, opts),
              registerSessionCatalog: (provider) => registerSessionCatalog(record, provider),
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
    deactivatePluginSideEffectGuards(pluginId);
    if (registryParams.activateGlobalSideEffects === false) {
      return;
    }

    clearPluginCommandsForPlugin(pluginId);
    clearPluginInteractiveHandlersForPlugin(pluginId);
    clearCodeModeNamespacesForPlugin(pluginId);
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
    registerHostedMediaResolver,
    registerProvider,
    registerWorkerProvider,
    registerModelCatalogProvider,
    registerAgentHarness,
    registerCliBackend,
    registerTextTransforms,
    registerEmbeddingProvider: registerEmbeddingProviderForPlugin,
    registerSpeechProvider,
    registerRealtimeTranscriptionProvider,
    registerRealtimeVoiceProvider,
    registerMediaUnderstandingProvider,
    registerTranscriptSourceProvider,
    registerImageGenerationProvider,
    registerVideoGenerationProvider,
    registerMusicGenerationProvider,
    registerWebSearchProvider,
    registerMigrationProvider,
    registerGatewayMethod,
    registerSessionCatalog,
    registerCli,
    registerReload,
    registerNodeHostCommand,
    registerSecurityAuditCollector,
    registerService,
    registerCommand,
    registerSessionExtension,
    registerTrustedToolPolicy,
    registerToolMetadata,
    registerControlUiDescriptor,
    registerRuntimeLifecycle,
    registerAgentEventSubscription,
    registerSessionSchedulerJob,
    registerSessionAction,
    registerHook,
    registerTypedHook,
  };
}

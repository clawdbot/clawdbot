import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { resolveUserPath } from "../utils.js";
import { emitPluginAgentEvent } from "./agent-event-emission.js";
import { buildPluginApi } from "./api-builder.js";
import {
  clearPluginRunContext,
  getPluginRunContext,
  setPluginRunContext,
} from "./host-hook-runtime.js";
import {
  schedulePluginSessionTurn,
  unschedulePluginSessionTurnsByTag,
} from "./host-hook-scheduled-turns.js";
import { isPluginRegistryActivated, isPluginRegistryRetired } from "./registry-lifecycle.js";
import type { PluginRegistrars } from "./registry-registrars.js";
import type { PluginRuntimeResolver } from "./registry-runtime.js";
import {
  resolvePluginRegistrationCapabilities,
  type PluginRegistryState,
  type PluginTypedHookPolicy,
  type PluginSideEffectGuard,
} from "./registry-state.js";
import type { PluginRecord } from "./registry-types.js";
import type { OpenClawPluginApi, PluginLogger, PluginRegistrationMode } from "./types.js";

type BoundRegistrars = {
  [K in keyof PluginRegistrars]: PluginRegistrars[K] extends (
    record: PluginRecord,
    ...args: infer Args
  ) => infer Result
    ? (...args: Args) => Result
    : never;
};

// Registration exposes these async operations without loading session storage or delivery.
const loadAttachments = createLazyRuntimeModule(() => import("./host-hook-attachments.js"));
const loadHookState = createLazyRuntimeModule(() => import("./host-hook-state.js"));

function normalizeLogger(logger: PluginLogger): PluginLogger {
  return {
    info: logger.info,
    warn: logger.warn,
    error: logger.error,
    debug: logger.debug,
  };
}

function resolvePluginPath(input: string, rootDir: string | undefined): string {
  const trimmed = input.trim();
  if (!trimmed || path.isAbsolute(trimmed) || trimmed.startsWith("~")) {
    return resolveUserPath(input);
  }
  return rootDir ? path.resolve(rootDir, trimmed) : resolveUserPath(input);
}

export function createPluginApiFactory(
  state: PluginRegistryState,
  registrars: PluginRegistrars,
  runtimeResolver: PluginRuntimeResolver,
) {
  const { registry, registryParams, getHostCronService, pluginSideEffectGuards, pushDiagnostic } =
    state;
  const { resolvePluginRuntime, resolveRegisteredChannelRuntime, setPluginRuntimeRecord } =
    runtimeResolver;

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
    setPluginRuntimeRecord(record);
    const sideEffectGuard = createPluginSideEffectGuard(record.id);
    const isLoadedRecordInRegistry = () =>
      registry.plugins.some((plugin) => plugin.id === record.id && plugin.status === "loaded");
    const isLoadedRecordInLiveRegistry = () =>
      sideEffectGuard.active &&
      isPluginRegistryActivated(registry) &&
      !isPluginRegistryRetired(registry) &&
      isLoadedRecordInRegistry();
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
    const boundRegistrars = Object.fromEntries(
      Object.entries(registrars).map(([name, register]) => [
        name,
        (...args: unknown[]) => Reflect.apply(register, undefined, [record, ...args]),
      ]),
    );
    // SAFETY: Each registrar keeps its signature with only the leading record bound.
    const { registerChannel, ...bound } = boundRegistrars as BoundRegistrars;
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
              ...bound,
              registerHook: (events, handler, opts) =>
                bound.registerHook(events, handler, opts, params.config, params.pluginConfig),
              registerNodeInvokePolicy: (policy) =>
                bound.registerNodeInvokePolicy(policy, params.pluginConfig),
              onConversationBindingResolved: bound.registerConversationBindingResolvedHandler,
              registerContextEngine: (id, factory) =>
                bound.registerContextEngine(id, factory, registrationMode),
              registerAgentToolResultMiddleware: (handler, options) => {
                bound.registerAgentToolResultMiddleware(handler, options, params.hookPolicy);
              },
              enqueueNextTurnInjection: async (injection) => {
                if (params.hookPolicy?.allowPromptInjection === false) {
                  pushDiagnostic({
                    level: "warn",
                    pluginId: record.id,
                    source: record.source,
                    message: `next-turn injection blocked by plugins.entries.${record.id}.hooks.allowPromptInjection=false`,
                  });
                  return {
                    enqueued: false,
                    id: "",
                    sessionKey: injection.sessionKey,
                  };
                }
                const { enqueuePluginNextTurnInjection } = await loadHookState();
                return enqueuePluginNextTurnInjection({
                  cfg: registryParams.runtime.config.current() as OpenClawConfig,
                  pluginId: record.id,
                  pluginName: record.name,
                  injection,
                });
              },
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
              getRunContext: (get) =>
                registryParams.activateGlobalSideEffects !== false &&
                shouldCommitWorkflowSideEffect()
                  ? getPluginRunContext({ pluginId: record.id, get })
                  : undefined,
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
              sendSessionAttachment: async (attachment) => {
                if (registryParams.activateGlobalSideEffects === false) {
                  return { ok: false, error: "global side effects disabled" };
                }
                try {
                  const { sendPluginSessionAttachment } = await loadAttachments();
                  if (!isLoadedRecordInLiveRegistry()) {
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
                  shouldCommit: isLoadedRecordInLiveRegistry,
                  ownerRegistry: registry,
                });
              },
              unscheduleSessionTurnsByTag: async (request) => {
                if (registryParams.activateGlobalSideEffects === false) {
                  return { removed: 0, failed: 0 };
                }
                await Promise.resolve();
                if (!isLoadedRecordInLiveRegistry()) {
                  return { removed: 0, failed: 0 };
                }
                return unschedulePluginSessionTurnsByTag({
                  pluginId: record.id,
                  origin: record.origin,
                  cron: getHostCronService(),
                  request,
                });
              },
              on: (hookName, handler, opts) =>
                registrars.registerTypedHook(record, hookName, handler, opts, params.hookPolicy),
            }
          : {}),
        ...(registrationCapabilities.setupRuntimeHandlers
          ? {
              registerHttpRoute: bound.registerHttpRoute,
              registerGatewayMethod: bound.registerGatewayMethod,
              registerSessionCatalog: bound.registerSessionCatalog,
            }
          : {}),
        // Allow setup-only/setup-runtime paths to surface parse-time CLI metadata
        // without opting into the wider full-registration surface.
        registerCli: bound.registerCli,
        registerChannel: (registration) =>
          registerChannel(
            registration,
            registrationMode,
            registrationCapabilities.runtimeChannel
              ? () => resolveRegisteredChannelRuntime(record)
              : undefined,
          ),
      },
    });
  };

  return { createApi, deactivatePluginSideEffectGuards };
}

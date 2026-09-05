import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { resolveUserPath } from "../utils.js";
import { emitPluginAgentEvent } from "./agent-event-emission.js";
import { buildPluginApi, createUnavailableRuntime } from "./api-builder.js";
import {
  clearPluginRunContext,
  getPluginRunContext,
  setPluginRunContext,
} from "./host-hook-runtime.js";
import {
  schedulePluginSessionTurn,
  unschedulePluginSessionTurnsByTag,
} from "./host-hook-scheduled-turns.js";
import { getPluginRecordRegistry, isPluginRecordActive } from "./registry-lifecycle.js";
import type { PluginRegistrars } from "./registry-registrars.js";
import type { PluginRuntimeResolver } from "./registry-runtime.js";
import {
  resolvePluginRegistrationCapabilities,
  type PluginRegistryState,
  type PluginTypedHookPolicy,
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
  const { registry, registryParams, getHostCronService, pushDiagnostic } = state;
  const { resolvePluginRuntime, resolveRegisteredChannelRuntime } = runtimeResolver;

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
    const isLoadedRecordInLiveRegistry = () => isPluginRecordActive(registry, record);
    const boundRegistrars = Object.fromEntries(
      Object.entries(registrars).map(([name, register]) => [
        name,
        (...args: unknown[]) => Reflect.apply(register, undefined, [record, ...args]),
      ]),
    );
    // SAFETY: Every registrar retains its key and signature with only its leading record bound.
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
      runtime:
        registrationMode === "cli-metadata"
          ? createUnavailableRuntime(registrationMode, record.id)
          : resolvePluginRuntime(record),
      logger: normalizeLogger(registryParams.logger),
      resolvePath: (input: string) =>
        resolvePluginPath(input, registrationMode === "cli-metadata" ? undefined : record.rootDir),
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
                if (
                  registryParams.activateGlobalSideEffects === false ||
                  !isLoadedRecordInLiveRegistry()
                ) {
                  return { enqueued: false, id: "", sessionKey: injection.sessionKey };
                }
                return enqueuePluginNextTurnInjection({
                  // SAFETY: The host helper reads the SDK's readonly view of the same config data.
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
                if (!isLoadedRecordInLiveRegistry()) {
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
                registryParams.activateGlobalSideEffects !== false && isLoadedRecordInLiveRegistry()
                  ? setPluginRunContext({ pluginId: record.id, patch })
                  : false,
              getRunContext: (get) =>
                registryParams.activateGlobalSideEffects !== false && isLoadedRecordInLiveRegistry()
                  ? getPluginRunContext({ pluginId: record.id, get })
                  : undefined,
              clearRunContext: (paramsLocal) => {
                if (
                  registryParams.activateGlobalSideEffects === false ||
                  !isLoadedRecordInLiveRegistry()
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
                    // SAFETY: Attachment setup reads the published config without mutating it.
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
                  ownerRegistry: getPluginRecordRegistry(registry, record),
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
        ...(registrationMode === "cli-metadata"
          ? {}
          : {
              registerChannel: (registration) =>
                registerChannel(
                  registration,
                  registrationMode,
                  registrationCapabilities.runtimeChannel
                    ? () => resolveRegisteredChannelRuntime(record)
                    : undefined,
                ),
            }),
      },
    });
  };

  return createApi;
}

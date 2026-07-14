import path from "node:path";
import { uniqueValues } from "@openclaw/normalization-core/string-normalization";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { registerInternalHook, unregisterInternalHook } from "../hooks/internal-hooks.js";
import type { HookEntry } from "../hooks/types.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { AgentToolResultMiddleware } from "./agent-tool-result-middleware-types.js";
import {
  normalizeAgentToolResultMiddlewareRuntimeIds,
  normalizeAgentToolResultMiddlewareRuntimes,
} from "./agent-tool-result-middleware.js";
import { CODEX_APP_SERVER_EXTENSION_RUNTIME_ID } from "./codex-app-server-extension-factory.js";
import type { CodexAppServerExtensionFactory } from "./codex-app-server-extension-types.js";
import { getPluginCompatRecord } from "./compat/registry.js";
import {
  resolveTypedHookTimeoutMs,
  type PluginRegistryState,
  type PluginTypedHookPolicy,
} from "./registry-state.js";
import type { PluginRecord } from "./registry-types.js";
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
  OpenClawPluginApi,
  OpenClawPluginHookOptions,
  OpenClawPluginToolContext,
  OpenClawPluginToolFactory,
  OpenClawPluginToolOptions,
  PluginHookHandlerMap,
  PluginHookName,
  PluginHookRegistration as TypedPluginHookRegistration,
} from "./types.js";

const LEGACY_DEACTIVATE_HOOK_ALIAS_COMPAT = getPluginCompatRecord("legacy-deactivate-hook-alias");
const LEGACY_SUBAGENT_SPAWNING_HOOK_COMPAT = getPluginCompatRecord("legacy-subagent-spawning-hook");

const ACTIVE_PLUGIN_HOOK_REGISTRATIONS_KEY = Symbol.for("openclaw.activePluginHookRegistrations");
const activePluginHookRegistrations = resolveGlobalSingleton<
  Map<string, Array<{ event: string; handler: Parameters<typeof registerInternalHook>[1] }>>
>(ACTIVE_PLUGIN_HOOK_REGISTRATIONS_KEY, () => new Map());

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

export function createToolHookRegistrars(state: PluginRegistryState) {
  const {
    registry,
    registryParams,
    pluginHookRollback,
    pluginsWithChannelRegistrationConflict,
    pushDiagnostic,
  } = state;

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
    const undeclared = findUndeclaredPluginToolNames({ declaredNames, toolNames: normalized });
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
    const hookName = entry?.hook.name ?? opts?.name?.trim();
    if (!hookName) {
      throw new Error("hook registration missing name");
    }
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
          metadata: { ...entry.metadata, events: normalizedEvents },
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
        // Internal hooks share one context; restore per-plugin config after each handler.
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
    rollbackEntries.push({ name: hookName, previousRegistrations: [...previousRegistrations] });
    pluginHookRollback.set(record.id, rollbackEntries);
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
      const diagnostic = formatDeprecatedTypedHookDiagnostic(hookName);
      if (diagnostic) {
        pushDiagnostic({
          level: "warn",
          pluginId: record.id,
          source: record.source,
          message: diagnostic,
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

  const rollbackHooks = (pluginId: string) => {
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
    registerCodexAppServerExtensionFactory,
    registerAgentToolResultMiddleware,
    registerTool,
    registerHook,
    registerTypedHook,
    rollbackHooks,
  };
}

import path from "node:path";
import {
  normalizeStringEntries,
  uniqueValues,
} from "@openclaw/normalization-core/string-normalization";
import type { AnyAgentTool } from "../agents/tools/common.js";
import type { InternalHookHandler } from "../hooks/internal-hook-types.js";
import type { HookEntry } from "../hooks/types.js";
import { withTimeout } from "../utils/with-timeout.js";
import type { AgentToolResultMiddleware } from "./agent-tool-result-middleware-types.js";
import {
  agentToolResultMiddlewareRegistrationCoversTool,
  appendAgentToolResultMiddlewareScope,
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
import type {
  PluginAgentToolResultMiddlewareRegistration,
  PluginRecord,
} from "./registry-types.js";
import {
  findUndeclaredPluginToolNames,
  normalizePluginToolContractNames,
  normalizePluginToolNames,
} from "./tool-contracts.js";
import { normalizePluginToolMatcher } from "./tool-hook-matcher.js";
import {
  DEPRECATED_PLUGIN_HOOKS,
  isConversationHookName,
  isDeprecatedPluginHookName,
  isPluginHookAgentTrigger,
  isPluginHookName,
  isPromptInjectionHookName,
} from "./types.js";
import type {
  OpenClawPluginApi,
  OpenClawPluginHookOptions,
  OpenClawPluginToolContext,
  OpenClawPluginToolFactory,
  OpenClawPluginToolOptions,
  PluginHookHandlerMap,
  PluginHookName,
  PluginHookRegistrationOptions,
  PluginHookRegistration as TypedPluginHookRegistration,
} from "./types.js";

const LEGACY_SUBAGENT_SPAWNING_HOOK_COMPAT = getPluginCompatRecord("legacy-subagent-spawning-hook");

function normalizeEligibleTriggers(value: unknown) {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const triggers = Array.from(value);
  if (triggers.length === 0 || !triggers.every(isPluginHookAgentTrigger)) {
    return undefined;
  }
  return uniqueValues(triggers);
}

function formatDeprecatedTypedHookDiagnostic(hookName: PluginHookName): string | undefined {
  if (!isDeprecatedPluginHookName(hookName)) {
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

export function createToolHookRegistrars(state: PluginRegistryState) {
  const { registry, registryParams, pluginsWithChannelRegistrationConflict, pushDiagnostic } =
    state;

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
    policy?: PluginTypedHookPolicy,
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
    const matcher = normalizePluginToolMatcher(options?.matcher);
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
      appendAgentToolResultMiddlewareScope(existing, { runtimes, matcher });
      return;
    }
    const timeoutMs = resolveTypedHookTimeoutMs({ hookName: "after_tool_call", policy });
    const safeHandler: AgentToolResultMiddleware = async (event, ctx) => {
      if (
        !agentToolResultMiddlewareRegistrationCoversTool(registration, ctx.runtime, event.toolName)
      ) {
        return;
      }
      try {
        // fs-safe bounds only this await; it cannot cancel plugin work, so late side effects remain possible.
        return await withTimeout(
          Promise.resolve(handler(event, ctx)),
          timeoutMs ?? 0,
          `agent tool result middleware for ${record.id}`,
        );
      } catch (error) {
        registryParams.logger.warn(
          `[plugins] agent tool result middleware failed for ${record.id}`,
        );
        throw error;
      }
    };
    const registration: PluginAgentToolResultMiddlewareRegistration = {
      pluginId: record.id,
      pluginName: record.name,
      rawHandler: handler,
      handler: safeHandler,
      runtimes,
      scopes: [{ runtimes, ...(matcher ? { matcher } : {}) }],
      source: record.source,
      rootDir: record.rootDir,
    };
    registry.agentToolResultMiddlewares.push(registration);
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
    handler: InternalHookHandler,
    opts: OpenClawPluginHookOptions | undefined,
    config: OpenClawPluginApi["config"],
    pluginConfig: unknown,
  ) => {
    const normalizedEvents = normalizeStringEntries(Array.isArray(events) ? events : [events]);
    // Typed lifecycle names (before_tool_call, message_received, ...) are dispatched only by
    // the typed hook runner; registerHook uses the legacy internal-hook path so they never
    // fire. Warn so authors move to `api.on(...)` instead of trusting a false "loaded".
    for (const event of normalizedEvents) {
      if (isPluginHookName(event)) {
        pushDiagnostic({
          level: "warn",
          pluginId: record.id,
          source: record.source,
          message:
            `hook event "${event}" is dispatched by the typed hook runner only; ` +
            `api.registerHook registrations for it are not invoked. ` +
            `Use api.on("${event}", ...) instead.`,
        });
      }
    }
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
    if (!hookSystemEnabled || opts?.register === false) {
      return;
    }
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
      registry.legacyInternalHooks.push({
        pluginId: record.id,
        name: hookName,
        event,
        handler: wrappedHandler,
      });
    }
  };

  const registerTypedHook = <K extends PluginHookName>(
    record: PluginRecord,
    hookName: K,
    handler: PluginHookHandlerMap[K],
    opts?: PluginHookRegistrationOptions<K>,
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
    const diagnostic = formatDeprecatedTypedHookDiagnostic(hookName);
    if (diagnostic) {
      pushDiagnostic({
        level: "warn",
        pluginId: record.id,
        source: record.source,
        message: diagnostic,
      });
    }
    if (policy?.allowPromptInjection === false && isPromptInjectionHookName(hookName)) {
      pushDiagnostic({
        level: "warn",
        pluginId: record.id,
        source: record.source,
        message: `typed hook "${hookName}" blocked by plugins.entries.${record.id}.hooks.allowPromptInjection=false`,
      });
      return;
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
    const timeoutMs = resolveTypedHookTimeoutMs({ hookName, opts, policy });
    const eligibleTriggers =
      hookName === "before_agent_reply"
        ? normalizeEligibleTriggers(opts?.eligibleTriggers)
        : undefined;
    const matcher =
      hookName === "before_tool_call" || hookName === "after_tool_call"
        ? normalizePluginToolMatcher(opts?.matcher)
        : undefined;
    if (opts?.matcher && hookName !== "before_tool_call" && hookName !== "after_tool_call") {
      pushDiagnostic({
        level: "warn",
        pluginId: record.id,
        source: record.source,
        message: `typed hook "${hookName}" ignores tool matcher`,
      });
    }
    record.hookCount += 1;
    registry.typedHooks.push({
      pluginId: record.id,
      ...(opts?.registrationId ? { registrationId: opts.registrationId } : {}),
      hookName,
      handler,
      ...(matcher ? { matcher } : {}),
      priority: opts?.priority,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(eligibleTriggers ? { eligibleTriggers } : {}),
      source: record.source,
    } as TypedPluginHookRegistration);
  };

  return {
    registerCodexAppServerExtensionFactory,
    registerAgentToolResultMiddleware,
    registerTool,
    registerHook,
    registerTypedHook,
  };
}

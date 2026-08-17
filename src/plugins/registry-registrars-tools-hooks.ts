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
import {
  resolveTypedHookTimeoutMs,
  type PluginRegistryState,
  type PluginTypedHookPolicy,
} from "./registry-state.js";
import type {
  PluginAgentToolResultMiddlewareRegistration,
  PluginBlockedHookReason,
  PluginRecord,
} from "./registry-types.js";
import {
  findUndeclaredPluginToolNames,
  normalizePluginToolContractNames,
  normalizePluginToolNames,
} from "./tool-contracts.js";
import { normalizePluginToolMatcher } from "./tool-hook-matcher.js";
import {
  isConversationHookName,
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

/**
 * The implicit conversation-access refusal is the only one the operator did not
 * ask for: a non-bundled plugin registers a conversation hook, nobody ever set
 * `allowConversationAccess`, and the default deny silently disables the handler
 * while `api.on()` reports nothing back. That combination has shipped
 * multi-day silent degradation, so the message must carry the config path, the
 * remedy, and how to verify — and it is emitted at `error`, unlike the two
 * deliberate denials below.
 */
function formatImplicitConversationAccessBlockDiagnostic(params: {
  pluginId: string;
  hookName: PluginHookName;
  configPath: string;
}): string {
  return (
    `typed hook "${params.hookName}" from non-bundled plugin "${params.pluginId}" was NOT registered: ` +
    `conversation hooks need an explicit grant and ${params.configPath} is unset, so the plugin's ` +
    `handler is inactive even though api.on() reported no error. ` +
    `Fix: set "${params.configPath}": true in openclaw.json and restart the Gateway. ` +
    `To keep the hook blocked without this error, set it to false. ` +
    `Verify with \`openclaw plugins inspect ${params.pluginId} --runtime\` or \`/status plugins\`.`
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
    // Records the refusal on the registry as well as emitting the diagnostic, so
    // "is any hook of mine refused?" stays answerable after the startup scroll
    // is gone. `api.on()` returns void, so the plugin itself can never observe
    // that its handler was refused.
    const blockTypedHook = (params: {
      reason: PluginBlockedHookReason;
      severity: "warn" | "error";
      configPath: string;
      message: string;
    }) => {
      pushDiagnostic({
        level: params.severity,
        pluginId: record.id,
        source: record.source,
        code: "hook-registration-blocked",
        message: params.message,
      });
      registry.blockedHooks.push({
        pluginId: record.id,
        hookName,
        reason: params.reason,
        severity: params.severity,
        configPath: params.configPath,
        message: params.message,
        source: record.source,
      });
    };
    if (policy?.allowPromptInjection === false && isPromptInjectionHookName(hookName)) {
      // Deliberate operator configuration: stays a warning.
      const configPath = `plugins.entries.${record.id}.hooks.allowPromptInjection`;
      blockTypedHook({
        reason: "prompt-injection-denied",
        severity: "warn",
        configPath,
        message:
          `typed hook "${hookName}" blocked by ${configPath}=false; ` +
          `the handler is not registered and will never run`,
      });
      return;
    }
    if (isConversationHookName(hookName)) {
      const explicitConversationAccess = policy?.allowConversationAccess;
      const configPath = `plugins.entries.${record.id}.hooks.allowConversationAccess`;
      // An operator who wrote `false` chose this outcome, whatever the plugin's
      // origin, so it stays a warning. This check must come first: a non-bundled
      // plugin with an explicit `false` also satisfies the implicit-deny
      // condition below, and reporting that as an error would raise the severity
      // of a decision the operator made and tell them to set a key they already
      // set.
      if (explicitConversationAccess === false) {
        blockTypedHook({
          reason: "conversation-access-denied",
          severity: "warn",
          configPath,
          message:
            `typed hook "${hookName}" blocked by ${configPath}=false; ` +
            `the handler is not registered and will never run`,
        });
        return;
      }
      if (record.origin !== "bundled" && explicitConversationAccess !== true) {
        // Implicit deny: nobody expressed an opinion. See the formatter's note.
        blockTypedHook({
          reason: "conversation-access-missing",
          severity: "error",
          configPath,
          message: formatImplicitConversationAccessBlockDiagnostic({
            pluginId: record.id,
            hookName,
            configPath,
          }),
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

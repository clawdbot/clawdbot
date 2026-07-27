/**
 * Active Memory plugin entry. Runtime behavior lives in focused sibling modules.
 */
import { resolveAgentDir, resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  normalizePluginsConfig,
  resolveLivePluginConfigObject,
} from "openclaw/plugin-sdk/plugin-config-runtime";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  applyCliRuntimeRecallTimeoutDefault,
  hasDeprecatedModelFallbackPolicy,
  isMissingRegisteredMemoryToolsError,
  normalizePluginConfig,
  resetActiveMemoryConfigForTests,
  setMinimumTimeoutMsForTests,
  setSetupGraceTimeoutMsForTests,
} from "./config.js";
import { buildMetadata, buildPromptPrefix } from "./prompt.js";
import { buildQuery, buildSearchQuery, extractRecentTurns, getModelRef } from "./query.js";
import {
  buildCacheKey,
  buildCircuitBreakerKey,
  getCachedResult,
  getCircuitBreakerEntry,
  isCircuitBreakerOpen,
  resetActiveRecallStateForTests,
  setCachedResult,
  shouldCacheResult,
  toSingleLineLogValue,
} from "./recall-state.js";
import { maybeResolveActiveRecall } from "./recall.js";
import {
  ACTIVE_MEMORY_GLOBAL_MUTATION_ADMIN_REQUIRED_TEXT,
  formatActiveMemoryCommandHelp,
  isActiveMemoryGloballyEnabled,
  isActiveMemoryPluginEnabled,
  isAllowedChatId,
  isAllowedChatType,
  isEligibleInteractiveSession,
  isEnabledForAgent,
  isPrivateRecallDestination,
  isSessionActiveMemoryDisabled,
  lacksAdminToMutateActiveMemoryGlobal,
  resolveCommandSessionKey,
  setSessionActiveMemoryDisabled,
  hasRememberAcrossConversationsAgent,
  shouldRememberAcrossConversations,
  shouldSkipActiveMemoryForHarnessSession,
  updateActiveMemoryGlobalEnabledInConfig,
} from "./session-policy.js";
import {
  buildPluginStatusLine,
  persistPluginStatusLines,
  resolveCanonicalSessionKeyFromSessionId,
  resolveStatusUpdateAgentId,
} from "./session.js";
import {
  readPartialAssistantText,
  resetActiveMemoryTranscriptForTests,
  setTimeoutPartialDataGraceMsForTests,
} from "./transcript-result.js";
import { readActiveMemorySearchDebug } from "./transcript-watch.js";
import {
  createActiveMemoryHookDeadline,
  hasUsableMemoryResultInSessionRecord,
} from "./transcript.js";
import {
  HOOK_TIMEOUT_RECOVERY_GRACE_MS,
  MAX_SETUP_GRACE_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  type ConversationRecallContext,
} from "./types.js";

const MEMORY_CORE_PLUGIN_ID = "memory-core";

/** Plugin entry registering Active Memory hooks, tools, config schema, and doctor cleanup. */
export default definePluginEntry({
  id: "active-memory",
  name: "Active Memory",
  description: "Proactively surfaces relevant memory before eligible conversational replies.",
  register(api: OpenClawPluginApi) {
    const readCurrentConfig = (): OpenClawConfig | undefined => {
      try {
        return (
          (api.runtime.config?.current?.() as OpenClawConfig | undefined) ??
          (api.config as OpenClawConfig | undefined)
        );
      } catch {
        return api.config as OpenClawConfig | undefined;
      }
    };
    let config = normalizePluginConfig(api.pluginConfig, readCurrentConfig());
    const warnDeprecatedModelFallbackPolicy = (pluginConfig: unknown) => {
      if (hasDeprecatedModelFallbackPolicy(pluginConfig)) {
        // Wording matters here: the previous text ("set config.modelFallback
        // explicitly if you want a fallback model") read naturally as runtime
        // failover (model A errors → switch to model B), but `getModelRef`
        // only consults `modelFallback` as the *last candidate* in the
        // resolution chain after `config.model`, the current run's model,
        // and the agent's configured default have all resolved to nothing.
        // Surface the chain-resolution semantics directly so operators
        // don't waste debug cycles assuming runtime failover (#74587).
        api.logger.warn?.(
          "active-memory: config.modelFallbackPolicy is deprecated and no longer changes runtime behavior. " +
            "config.modelFallback is a chain-resolution last-resort (consulted only when config.model, " +
            "the current run's model, and the agent's configured default all resolve to nothing) — " +
            "it is NOT a runtime failover that substitutes a different model when the resolved model errors out.",
        );
      }
    };
    warnDeprecatedModelFallbackPolicy(api.pluginConfig);
    const refreshLiveConfigFromRuntime = () => {
      const livePluginConfig = resolveLivePluginConfigObject(
        api.runtime.config?.current
          ? () => api.runtime.config.current() as OpenClawConfig
          : undefined,
        "active-memory",
        api.pluginConfig as Record<string, unknown>,
      );
      const liveConfig = readCurrentConfig();
      const fallbackConfig =
        liveConfig && hasRememberAcrossConversationsAgent(liveConfig) ? {} : { enabled: false };
      const effectivePluginConfig =
        liveConfig && !isActiveMemoryPluginEnabled(liveConfig)
          ? { enabled: false }
          : (livePluginConfig ?? fallbackConfig);
      config = normalizePluginConfig(effectivePluginConfig, liveConfig);
      if (livePluginConfig) {
        warnDeprecatedModelFallbackPolicy(livePluginConfig);
      }
    };
    api.registerCommand({
      name: "active-memory",
      description: "Enable, disable, or inspect Active Memory for this session.",
      acceptsArgs: true,
      exposeSenderIsOwner: true,
      handler: async (ctx) => {
        const tokens = ctx.args?.trim().split(/\s+/).filter(Boolean) ?? [];
        const isGlobal = tokens.includes("--global");
        const action = (tokens.find((token) => token !== "--global") ?? "status").toLowerCase();
        if (action === "help") {
          return { text: formatActiveMemoryCommandHelp() };
        }
        refreshLiveConfigFromRuntime();
        if (isGlobal) {
          const currentConfig = api.runtime.config.current() as OpenClawConfig;
          if (action === "status") {
            return {
              text: `Active Memory: ${isActiveMemoryGloballyEnabled(currentConfig) ? "on" : "off"} globally.`,
            };
          }
          if (
            lacksAdminToMutateActiveMemoryGlobal({
              senderIsOwner: ctx.senderIsOwner,
              gatewayClientScopes: ctx.gatewayClientScopes,
            })
          ) {
            return {
              text: ACTIVE_MEMORY_GLOBAL_MUTATION_ADMIN_REQUIRED_TEXT,
            };
          }
          if (action === "on" || action === "enable" || action === "enabled") {
            await api.runtime.config.mutateConfigFile({
              afterWrite: { mode: "auto" },
              mutate: (draft) => {
                const nextConfig = updateActiveMemoryGlobalEnabledInConfig(draft, true);
                Object.assign(draft, nextConfig);
              },
            });
            refreshLiveConfigFromRuntime();
            return { text: "Active Memory: on globally." };
          }
          if (action === "off" || action === "disable" || action === "disabled") {
            await api.runtime.config.mutateConfigFile({
              afterWrite: { mode: "auto" },
              mutate: (draft) => {
                const nextConfig = updateActiveMemoryGlobalEnabledInConfig(draft, false);
                Object.assign(draft, nextConfig);
              },
            });
            refreshLiveConfigFromRuntime();
            return { text: "Active Memory: off globally." };
          }
        }
        const sessionKey = resolveCommandSessionKey({
          api,
          config,
          sessionKey: ctx.sessionKey,
          sessionId: ctx.sessionId,
        });
        if (!sessionKey) {
          return {
            text: "Active Memory: session toggle unavailable because this command has no session context.",
          };
        }
        const commandAgentId = resolveStatusUpdateAgentId({ sessionKey });
        const liveConfig = readCurrentConfig() ?? api.config;
        const commandRecallEnabled =
          isEnabledForAgent(config, commandAgentId) ||
          (config.enabled && shouldRememberAcrossConversations(liveConfig, commandAgentId));
        if (!commandRecallEnabled) {
          return { text: "Active Memory: off for this session." };
        }
        if (action === "status") {
          const disabled = await isSessionActiveMemoryDisabled({ api, sessionKey });
          return {
            text: `Active Memory: ${disabled ? "off" : "on"} for this session.`,
          };
        }
        if (action === "on" || action === "enable" || action === "enabled") {
          await setSessionActiveMemoryDisabled({ api, sessionKey, disabled: false });
          return { text: "Active Memory: on for this session." };
        }
        if (action === "off" || action === "disable" || action === "disabled") {
          await setSessionActiveMemoryDisabled({ api, sessionKey, disabled: true });
          await persistPluginStatusLines({
            api,
            agentId: resolveStatusUpdateAgentId({ sessionKey }),
            sessionKey,
          });
          return { text: "Active Memory: off for this session." };
        }
        return {
          text: `Unknown Active Memory action: ${action}\n\n${formatActiveMemoryCommandHelp()}`,
        };
      },
    });

    // Preflight and recall own separate deadlines. Reserve enough hook time for
    // both maxima so preflight latency cannot consume recall settlement time.
    const beforePromptBuildTimeoutMs =
      MAX_TIMEOUT_MS + MAX_SETUP_GRACE_TIMEOUT_MS + HOOK_TIMEOUT_RECOVERY_GRACE_MS * 2;
    api.on(
      "before_prompt_build",
      async (event, ctx) => {
        refreshLiveConfigFromRuntime();
        const liveConfig = readCurrentConfig() ?? api.config;
        // The hook deadline, watchdog, and embedded-run budget all flow from
        // this config, so the CLI-runtime default raise must happen before
        // any of them are armed. Budgeting shares the runner's own dispatch
        // eligibility so API-key/missing-backend passthrough runs keep the
        // plain default.
        const timeoutAgentId = resolveStatusUpdateAgentId(ctx);
        // getModelRef returns undefined when no recall model resolves; the
        // eligibility check treats a missing provider as ineligible.
        const timeoutModelRef =
          (timeoutAgentId
            ? getModelRef(liveConfig, timeoutAgentId, config, {
                modelProviderId: ctx.modelProviderId,
                modelId: ctx.modelId,
              })
            : { provider: ctx.modelProviderId, model: ctx.modelId }) ?? {};
        const cliDispatchEligibility = api.runtime.agent.resolveCliBackendDispatchEligibility({
          provider: timeoutModelRef.provider,
          model: timeoutModelRef.model,
          config: liveConfig,
          ...(timeoutAgentId
            ? {
                agentId: timeoutAgentId,
                agentDir: resolveAgentDir(liveConfig, timeoutAgentId),
                workspaceDir: resolveAgentWorkspaceDir(liveConfig, timeoutAgentId),
              }
            : {}),
        });
        const invocationConfig = applyCliRuntimeRecallTimeoutDefault(
          config,
          cliDispatchEligibility !== undefined,
        );
        const liveRecallTimeoutMs =
          invocationConfig.timeoutMs +
          invocationConfig.setupGraceTimeoutMs +
          HOOK_TIMEOUT_RECOVERY_GRACE_MS;
        const deadlineController = new AbortController();
        const hookDeadline = createActiveMemoryHookDeadline();
        const armHookDeadline = (timeoutMs: number, phase: "preflight" | "recall") => {
          hookDeadline.arm(timeoutMs, () => {
            deadlineController.abort(
              new Error(`active-memory ${phase} timeout after ${timeoutMs}ms`),
            );
            api.logger.warn?.(
              `active-memory: before_prompt_build ${phase} timed out after ${String(timeoutMs)}ms; skipping memory lookup`,
            );
          });
        };
        armHookDeadline(HOOK_TIMEOUT_RECOVERY_GRACE_MS, "preflight");
        const handlerPromise = (async () => {
          try {
            const resolvedAgentId = resolveStatusUpdateAgentId(ctx);
            const resolvedSessionKey =
              ctx.sessionKey?.trim() ||
              (resolvedAgentId
                ? resolveCanonicalSessionKeyFromSessionId({
                    api,
                    agentId: resolvedAgentId,
                    sessionId: ctx.sessionId,
                  })
                : undefined);
            const effectiveAgentId =
              resolvedAgentId || resolveStatusUpdateAgentId({ sessionKey: resolvedSessionKey });
            if (
              shouldSkipActiveMemoryForHarnessSession({
                api,
                agentId: effectiveAgentId,
                sessionKey: resolvedSessionKey,
              })
            ) {
              return undefined;
            }
            const sessionDisabled = await isSessionActiveMemoryDisabled({
              api,
              sessionKey: resolvedSessionKey,
            });
            deadlineController.signal.throwIfAborted();
            if (sessionDisabled) {
              await persistPluginStatusLines({
                api,
                agentId: effectiveAgentId,
                sessionKey: resolvedSessionKey,
              });
              return undefined;
            }
            const sessionContext = {
              ...ctx,
              sessionKey: resolvedSessionKey ?? ctx.sessionKey,
            };
            if (!isEligibleInteractiveSession(sessionContext)) {
              await persistPluginStatusLines({
                api,
                agentId: effectiveAgentId,
                sessionKey: resolvedSessionKey,
              });
              return undefined;
            }
            const destinationContext = {
              ...sessionContext,
              mainKey: liveConfig.session?.mainKey ?? api.config.session?.mainKey,
            };
            const activeMemoryConfigured = isEnabledForAgent(invocationConfig, effectiveAgentId);
            const chatIdAllowed = isAllowedChatId(invocationConfig, {
              sessionKey: destinationContext.sessionKey,
              messageProvider: destinationContext.messageProvider,
              channelId: destinationContext.channelId,
            });
            const activeMemoryAllowed =
              activeMemoryConfigured &&
              isAllowedChatType(invocationConfig, destinationContext) &&
              chatIdAllowed;
            const productRecallRequested = Boolean(
              invocationConfig.enabled &&
              resolvedSessionKey &&
              shouldRememberAcrossConversations(liveConfig, effectiveAgentId) &&
              isPrivateRecallDestination(destinationContext) &&
              chatIdAllowed,
            );
            const memorySlot = normalizePluginsConfig(liveConfig.plugins).slots.memory;
            const productRecallEligible =
              productRecallRequested && memorySlot === MEMORY_CORE_PLUGIN_ID;
            if (productRecallRequested && !productRecallEligible) {
              api.logger.warn?.(
                "active-memory: the current memory provider does not support protected private transcript recall; skipping Remember across conversations",
              );
            }
            const productRecallAllowed =
              productRecallEligible && invocationConfig.toolsAllow.includes("memory_search");
            if (productRecallEligible && !productRecallAllowed) {
              api.logger.warn?.(
                "active-memory: memory_search is unavailable; skipping Remember across conversations private transcript recall",
              );
            }
            if (!activeMemoryAllowed && !productRecallAllowed) {
              await persistPluginStatusLines({
                api,
                agentId: effectiveAgentId,
                sessionKey: resolvedSessionKey,
              });
              return undefined;
            }
            const conversationRecall: ConversationRecallContext | undefined =
              productRecallAllowed && resolvedSessionKey
                ? {
                    anchorSessionKey: resolvedSessionKey,
                    scope: "same-agent-private",
                    corpus: activeMemoryAllowed ? "configured" : "sessions",
                  }
                : undefined;
            const recallConfig =
              productRecallAllowed && !activeMemoryAllowed
                ? { ...invocationConfig, toolsAllow: ["memory_search"] }
                : invocationConfig;
            const recentTurns = extractRecentTurns(event.messages);
            const query = buildQuery({
              latestUserMessage: event.prompt,
              recentTurns,
              config: recallConfig,
            });
            const searchQuery = buildSearchQuery({
              latestUserMessage: event.prompt,
              recentTurns,
            });
            // Start recall with its full configured budget. The preceding
            // session/config checks must not consume abort-settlement time.
            armHookDeadline(liveRecallTimeoutMs, "recall");
            const result = await maybeResolveActiveRecall({
              api,
              runtimeConfig: liveConfig,
              config: recallConfig,
              agentId: effectiveAgentId,
              sessionKey: resolvedSessionKey,
              sessionId: ctx.sessionId,
              messageProvider: ctx.messageProvider,
              channelId: ctx.channelId,
              query,
              searchQuery,
              currentModelProviderId: ctx.modelProviderId,
              currentModelId: ctx.modelId,
              conversationRecall,
              abortSignal: deadlineController.signal,
            });
            deadlineController.signal.throwIfAborted();
            if (!result.summary) {
              return undefined;
            }
            const promptPrefix = buildPromptPrefix(result.summary);
            if (!promptPrefix) {
              return undefined;
            }
            return {
              prependContext: promptPrefix,
            };
          } catch (error) {
            if (deadlineController.signal.aborted) {
              return undefined;
            }
            const message = toSingleLineLogValue(
              error instanceof Error ? error.message : String(error),
            );
            api.logger.warn?.(
              `active-memory: before_prompt_build failed, skipping memory lookup: ${message}`,
            );
            return undefined;
          }
        })();
        try {
          const result = await Promise.race([handlerPromise, hookDeadline.promise]);
          return typeof result === "symbol" ? undefined : result;
        } finally {
          hookDeadline.stop();
        }
      },
      { timeoutMs: beforePromptBuildTimeoutMs },
    );
  },
});

const testing = {
  buildSearchQuery,
  buildCacheKey,
  buildCircuitBreakerKey,
  buildMetadata,
  buildPluginStatusLine,
  buildPromptPrefix,
  getCachedResult,
  hasUsableMemoryResultInSessionRecord,
  isCircuitBreakerOpen,
  isMissingRegisteredMemoryToolsError,
  normalizePluginConfig,
  readActiveMemorySearchDebug,
  readPartialAssistantText,
  shouldCacheResult,
  resetActiveRecallCacheForTests() {
    resetActiveRecallStateForTests();
    resetActiveMemoryConfigForTests();
    resetActiveMemoryTranscriptForTests();
  },
  setMinimumTimeoutMsForTests,
  setSetupGraceTimeoutMsForTests,
  setTimeoutPartialDataGraceMsForTests,
  setCachedResult,
  getCircuitBreakerEntry,
};

export { testing, testing as __testing };

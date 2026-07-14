/**
 * Active Memory plugin entry. Runtime behavior lives in focused sibling modules.
 */
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveLivePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  hasDeprecatedModelFallbackPolicy,
  isMissingRegisteredMemoryToolsError,
  normalizePluginConfig,
  resetActiveMemoryConfigForTests,
  setMinimumTimeoutMsForTests,
  setSetupGraceTimeoutMsForTests,
} from "./config.js";
import { buildMetadata, buildPromptPrefix } from "./prompt.js";
import { buildQuery, buildSearchQuery, extractRecentTurns } from "./query.js";
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
  isAllowedChatId,
  isAllowedChatType,
  isEligibleInteractiveSession,
  isEnabledForAgent,
  isSessionActiveMemoryDisabled,
  lacksAdminToMutateActiveMemoryGlobal,
  resolveCommandSessionKey,
  setSessionActiveMemoryDisabled,
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
} from "./types.js";

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
      config = normalizePluginConfig(livePluginConfig ?? { enabled: false }, readCurrentConfig());
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
        if (!isEnabledForAgent(config, commandAgentId)) {
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
        const invocationConfig = config;
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
            if (!isEnabledForAgent(invocationConfig, effectiveAgentId)) {
              await persistPluginStatusLines({
                api,
                agentId: effectiveAgentId,
                sessionKey: resolvedSessionKey,
              });
              return undefined;
            }
            if (
              !isEligibleInteractiveSession({
                ...ctx,
                sessionKey: resolvedSessionKey ?? ctx.sessionKey,
              })
            ) {
              await persistPluginStatusLines({
                api,
                agentId: effectiveAgentId,
                sessionKey: resolvedSessionKey,
              });
              return undefined;
            }
            if (
              !isAllowedChatType(invocationConfig, {
                ...ctx,
                sessionKey: resolvedSessionKey ?? ctx.sessionKey,
                mainKey: api.config.session?.mainKey,
              })
            ) {
              await persistPluginStatusLines({
                api,
                agentId: effectiveAgentId,
                sessionKey: resolvedSessionKey,
              });
              return undefined;
            }
            if (
              !isAllowedChatId(invocationConfig, {
                sessionKey: resolvedSessionKey ?? ctx.sessionKey,
                messageProvider: ctx.messageProvider,
              })
            ) {
              await persistPluginStatusLines({
                api,
                agentId: effectiveAgentId,
                sessionKey: resolvedSessionKey,
              });
              return undefined;
            }
            const recentTurns = extractRecentTurns(event.messages);
            const query = buildQuery({
              latestUserMessage: event.prompt,
              recentTurns,
              config: invocationConfig,
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
              config: invocationConfig,
              agentId: effectiveAgentId,
              sessionKey: resolvedSessionKey,
              sessionId: ctx.sessionId,
              messageProvider: ctx.messageProvider,
              channelId: ctx.channelId,
              query,
              searchQuery,
              currentModelProviderId: ctx.modelProviderId,
              currentModelId: ctx.modelId,
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

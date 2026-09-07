import { resolveAgentDir, resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { getMemoryCapabilityRegistration } from "openclaw/plugin-sdk/memory-host-core";
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
  readActiveMemoryConfig,
  resetActiveMemoryConfigForTests,
  setMinimumTimeoutMsForTests,
  setSetupGraceTimeoutMsForTests,
} from "./config.js";
import { resolveRecallEscalationDecision } from "./escalation.js";
import { buildPromptPrefix, buildRecallOutcomePrefix } from "./prompt.js";
import { buildQuery, buildSearchQuery, extractRecentTurns, getModelRef } from "./query.js";
import {
  buildCacheKey,
  buildCircuitBreakerKey,
  forgetActiveRecallRun,
  getCachedResult,
  getCircuitBreakerEntry,
  isCircuitBreakerOpen,
  resetActiveRecallStateForTests,
  setCachedResult,
  toSingleLineErrorMessage,
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
  shouldRememberAcrossConversations,
  shouldSkipActiveMemoryForHarnessSession,
  updateActiveMemoryGlobalEnabledInConfig,
} from "./session-policy.js";
import {
  persistPluginStatusLines,
  resolveCanonicalSessionKeyFromSessionId,
  resolveStatusUpdateAgentId,
} from "./session.js";
import {
  readPartialAssistantText,
  resetActiveMemoryTranscriptForTests,
  setTimeoutPartialDataGraceMsForTests,
} from "./transcript-result.js";
import {
  createActiveMemoryHookDeadline,
  hasUsableMemoryResultInSessionRecord,
} from "./transcript.js";
import {
  forgetTriggerRecallRun,
  resetTriggerRecallRunsForTests,
  resolveTriggerRecall,
} from "./trigger-recall.js";
import {
  ACTIVE_MEMORY_STATUS_PREFIX,
  HOOK_TIMEOUT_RECOVERY_GRACE_MS,
  MAX_SETUP_GRACE_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  type ConversationRecallContext,
} from "./types.js";

export default definePluginEntry({
  id: "active-memory",
  name: "Active Memory",
  description: "Proactively surfaces relevant memory before eligible conversational replies.",
  register(api: OpenClawPluginApi) {
    const readCurrentConfig = () => readActiveMemoryConfig(api);
    let config = normalizePluginConfig(api.pluginConfig, readCurrentConfig());
    const warnDeprecatedModelFallbackPolicy = (pluginConfig: unknown) => {
      if (hasDeprecatedModelFallbackPolicy(pluginConfig)) {
        // modelFallback is a last model-selection candidate, never runtime failover.
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
      const effectivePluginConfig = !isActiveMemoryPluginEnabled(liveConfig)
        ? { enabled: false }
        : (livePluginConfig ?? {});
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
        const enabled = ["on", "enable", "enabled"].includes(action)
          ? true
          : ["off", "disable", "disabled"].includes(action)
            ? false
            : undefined;
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
          if (enabled !== undefined) {
            await api.runtime.config.mutateConfigFile({
              afterWrite: { mode: "auto" },
              mutate: (draft) => {
                const nextConfig = updateActiveMemoryGlobalEnabledInConfig(draft, enabled);
                Object.assign(draft, nextConfig);
              },
            });
            refreshLiveConfigFromRuntime();
            return { text: `Active Memory: ${enabled ? "on" : "off"} globally.` };
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
        const liveConfig = readCurrentConfig();
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
        if (enabled !== undefined) {
          await setSessionActiveMemoryDisabled({ api, sessionKey, disabled: !enabled });
          if (!enabled) {
            await persistPluginStatusLines({ api, agentId: commandAgentId, sessionKey });
          }
          return { text: `Active Memory: ${enabled ? "on" : "off"} for this session.` };
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
    // Names the exit taken when recall is configured off for this session, so
    // "no relevant memory found" and "recall never ran" stop being
    // indistinguishable at info level. Reserved for states an operator can act
    // on; the routine escalation decision stays at debug. Deliberately not
    // gated on config.logging, which defaults to false and would reproduce the
    // invisibility this reports.
    const logRecallSkipped = (reason: string) => {
      api.logger.info?.(`active-memory: recall skipped reason=${reason}`);
    };
    api.on(
      "before_prompt_build",
      async (event, ctx) => {
        const toolAuthority = ctx.toolAuthority;
        if (!toolAuthority) {
          // Defensive only: the host filters authority-required registrations
          // out of the unauthorized pass, so this never runs in production.
          api.logger.debug?.(
            "active-memory: recall skipped because this prompt has no turn tool authority",
          );
          return undefined;
        }
        toolAuthority.assertActive();
        refreshLiveConfigFromRuntime();
        const liveConfig = readCurrentConfig();
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
        const authorityAllowedRecallTools = invocationConfig.toolsAllow.filter((toolName) =>
          toolAuthority.allows(toolName),
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
            if (authorityAllowedRecallTools.length === 0) {
              await persistPluginStatusLines({
                api,
                agentId: effectiveAgentId,
                sessionKey: resolvedSessionKey,
                statusLine: `${ACTIVE_MEMORY_STATUS_PREFIX} status=policy-disabled`,
              });
              logRecallSkipped("policy-disabled");
              toolAuthority.assertActive();
              return undefined;
            }
            if (
              shouldSkipActiveMemoryForHarnessSession({
                api,
                agentId: effectiveAgentId,
                sessionKey: resolvedSessionKey,
              })
            ) {
              logRecallSkipped("harness-session");
              return undefined;
            }
            const sessionDisabled = await isSessionActiveMemoryDisabled({
              api,
              sessionKey: resolvedSessionKey,
            });
            deadlineController.signal.throwIfAborted();
            toolAuthority.assertActive();
            if (sessionDisabled) {
              logRecallSkipped("session-disabled");
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
              logRecallSkipped("session-ineligible");
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
            const recentTurns = extractRecentTurns(event.messages);
            const searchQuery = buildSearchQuery({
              latestUserMessage: event.prompt,
              recentTurns,
            });
            const memorySlot = normalizePluginsConfig(liveConfig.plugins).slots.memory;
            const memoryCapabilityRegistration = getMemoryCapabilityRegistration();
            const memoryCapability =
              memoryCapabilityRegistration && memoryCapabilityRegistration.pluginId === memorySlot
                ? memoryCapabilityRegistration.capability
                : undefined;
            const allowedRecallTools = authorityAllowedRecallTools;
            const deterministicRecallToolName = memoryCapability?.deterministicRecallToolName;
            const chatIdAllowed = isAllowedChatId(invocationConfig, {
              sessionKey: destinationContext.sessionKey,
              messageProvider: destinationContext.messageProvider,
              channelId: destinationContext.channelId,
            });
            const activeMemoryConfigured = isEnabledForAgent(invocationConfig, effectiveAgentId);
            let laneOne: { context?: string; hasStrongHit: boolean; injectedCount: number } = {
              hasStrongHit: false,
              injectedCount: 0,
            };
            if (
              activeMemoryConfigured &&
              effectiveAgentId &&
              deterministicRecallToolName &&
              allowedRecallTools.includes(deterministicRecallToolName) &&
              isPrivateRecallDestination(destinationContext) &&
              chatIdAllowed
            ) {
              toolAuthority.assertActive();
              laneOne = await resolveTriggerRecall({
                cfg: liveConfig,
                agentId: effectiveAgentId,
                query: searchQuery,
                message: event.prompt,
                activeProjectKeys: ctx.activeProjectKeys,
                signal: AbortSignal.timeout(HOOK_TIMEOUT_RECOVERY_GRACE_MS),
                runId: ctx.runId,
                authorityFingerprint: toolAuthority.fingerprint,
              }).catch((error: unknown) => {
                api.logger.debug?.(
                  `active-memory: lane-1 trigger recall failed: ${toSingleLineErrorMessage(error)}`,
                );
                return { hasStrongHit: false, injectedCount: 0 };
              });
              toolAuthority.assertActive();
              if (laneOne.context && laneOne.injectedCount > 0 && invocationConfig.logging) {
                api.logger.info?.(
                  `active-memory: lane-1 injected ${laneOne.injectedCount} trigger-matched entries`,
                );
              }
            }
            const laneOneContext = laneOne.context;
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
            const productRecallEligible =
              productRecallRequested && memoryCapability?.supportsPrivateTranscriptRecall === true;
            if (productRecallRequested && !productRecallEligible) {
              api.logger.warn?.(
                "active-memory: the current memory provider does not support protected private transcript recall; skipping Remember across conversations",
              );
            }
            const productRecallToolName =
              productRecallEligible &&
              deterministicRecallToolName &&
              allowedRecallTools.includes(deterministicRecallToolName)
                ? deterministicRecallToolName
                : undefined;
            const productRecallAllowed = Boolean(productRecallToolName);
            if (productRecallEligible && !productRecallAllowed) {
              api.logger.warn?.(
                `active-memory: ${deterministicRecallToolName ?? "the provider's deterministic recall tool"} is unavailable; skipping Remember across conversations private transcript recall`,
              );
            }
            if (!activeMemoryAllowed && !productRecallAllowed) {
              logRecallSkipped("destination-not-allowed");
              await persistPluginStatusLines({
                api,
                agentId: effectiveAgentId,
                sessionKey: resolvedSessionKey,
              });
              return laneOneContext ? { prependContext: laneOneContext } : undefined;
            }
            const escalationDecision = resolveRecallEscalationDecision({
              mode: invocationConfig.mode,
              message: event.prompt,
              hasStrongLaneOneHit: laneOne.hasStrongHit,
            });
            if (escalationDecision !== "recall") {
              // Stays at debug: escalate is the default mode and ordinary
              // prompts resolve to no-recall-intent, so this is the healthy
              // path rather than an actionable skip.
              api.logger.debug?.(`active-memory: recall skipped reason=${escalationDecision}`);
              const outcomeContext =
                escalationDecision === "no-recall-intent"
                  ? buildRecallOutcomePrefix("skipped-no-recall-intent")
                  : undefined;
              const prependContext = [laneOneContext, outcomeContext].filter(Boolean).join("\n");
              return prependContext ? { prependContext } : undefined;
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
              productRecallToolName && !activeMemoryAllowed
                ? { ...invocationConfig, toolsAllow: [productRecallToolName] }
                : { ...invocationConfig, toolsAllow: allowedRecallTools };
            const query = buildQuery({
              latestUserMessage: event.prompt,
              recentTurns,
              config: recallConfig,
            });
            // Start recall with its full configured budget. The preceding
            // session/config checks must not consume abort-settlement time.
            armHookDeadline(liveRecallTimeoutMs, "recall");
            toolAuthority.assertActive();
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
              runId: ctx.runId,
              authorityFingerprint: toolAuthority.fingerprint,
              memorySlot: memorySlot ?? undefined,
              activeProjectKeys: ctx.activeProjectKeys,
            });
            deadlineController.signal.throwIfAborted();
            toolAuthority.assertActive();
            const recallContext = result.summary
              ? buildPromptPrefix(result.summary)
              : result.status === "unavailable"
                ? buildRecallOutcomePrefix(result.status)
                : undefined;
            const prependContext = [laneOneContext, recallContext].filter(Boolean).join("\n");
            return prependContext ? { prependContext } : undefined;
          } catch (error) {
            if (deadlineController.signal.aborted) {
              return undefined;
            }
            const message = toSingleLineErrorMessage(error);
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
      { timeoutMs: beforePromptBuildTimeoutMs, requiresToolAuthority: true },
    );
    api.on("agent_end", (event, ctx) => {
      const runId = event.runId ?? ctx.runId;
      forgetActiveRecallRun(runId);
      forgetTriggerRecallRun(runId);
    });
  },
});

const testing = {
  buildCacheKey,
  buildCircuitBreakerKey,
  getCachedResult,
  hasUsableMemoryResultInSessionRecord,
  isCircuitBreakerOpen,
  isMissingRegisteredMemoryToolsError,
  normalizePluginConfig,
  readPartialAssistantText,
  resetActiveRecallCacheForTests() {
    resetActiveRecallStateForTests();
    resetActiveMemoryConfigForTests();
    resetActiveMemoryTranscriptForTests();
    resetTriggerRecallRunsForTests();
  },
  setMinimumTimeoutMsForTests,
  setSetupGraceTimeoutMsForTests,
  setTimeoutPartialDataGraceMsForTests,
  setCachedResult,
  getCircuitBreakerEntry,
};

export { testing };

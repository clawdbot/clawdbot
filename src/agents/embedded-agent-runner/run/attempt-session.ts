/**
 * Prepares embedded-agent resources, tools, and active sessions.
 */
import { getGlobalHookRunner } from "../../../plugins/hook-runner-global.js";
import type { PluginMetadataSnapshot } from "../../../plugins/plugin-metadata-snapshot.types.js";
import { createPreparedEmbeddedAgentSettingsManager } from "../../agent-project-settings.js";
import {
  applyAgentAutoCompactionGuard,
  applyAgentCompactionSettingsFromConfig,
  isSilentOverflowProneModel,
  resolveEffectiveCompactionMode,
} from "../../agent-settings.js";
import { toToolDefinitions } from "../../agent-tool-definition-adapter.js";
import type { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import {
  createAgentSession,
  type AgentSession,
  type CreateAgentSessionOptions,
} from "../../sessions/index.js";
import { wrapToolDefinition } from "../../sessions/tools/tool-definition-wrapper.js";
import { resolveToolSearchCatalogTool } from "../../tool-search.js";
import { buildEmbeddedExtensionFactories } from "../extensions.js";
import { log } from "../logger.js";
import { createEmbeddedAgentResourceLoader } from "../resource-loader.js";
import { applySystemPromptToSession } from "../system-prompt.js";
import { prepareEmbeddedAttemptClientTools } from "./attempt-client-tools.js";
import type { AttemptContextEngine } from "./attempt.context-engine-helpers.js";
import type { EmbeddedAttemptSessionLockController } from "./attempt.session-lock.js";
import { installMessageToolOnlyTerminalHook } from "./message-tool-terminal.js";
import { notifyToolActivity } from "./tool-activity-heartbeat.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type ClientToolPreparation = Omit<
  Parameters<typeof prepareEmbeddedAttemptClientTools>[0],
  "attempt"
>;

type AttemptSessionManager = ReturnType<typeof guardSessionManager>;

/** Prepares resource loading, client tools, and the active agent session. */
export async function prepareEmbeddedAttemptAgentSession(input: {
  attempt: EmbeddedRunAttemptParams;
  activeContextEngineInfo?: AttemptContextEngine["info"];
  agentCoreThinkingLevel: CreateAgentSessionOptions["thinkingLevel"];
  agentDir: string;
  clientToolPreparation: ClientToolPreparation;
  effectiveCwd: string;
  getCurrentAttemptPluginMetadataSnapshot: () => PluginMetadataSnapshot | undefined;
  initialSystemPrompt: string;
  markStage: (stage: string) => void;
  onSessionCreated: (session: AgentSession) => void;
  onSystemPromptChanged: (systemPrompt: string) => void;
  runAbortSignal: AbortSignal;
  sessionAgentId: string;
  sessionLockController: EmbeddedAttemptSessionLockController;
  sessionManager: AttemptSessionManager;
}) {
  const { attempt } = input;
  const settingsManager = createPreparedEmbeddedAgentSettingsManager({
    cwd: input.effectiveCwd,
    agentDir: input.agentDir,
    cfg: attempt.config,
    pluginMetadataSnapshot: input.getCurrentAttemptPluginMetadataSnapshot(),
    contextTokenBudget: attempt.contextTokenBudget,
  });
  const autoCompactionGuardArgs = {
    settingsManager,
    contextEngineInfo: input.activeContextEngineInfo,
    compactionMode: resolveEffectiveCompactionMode(attempt.config),
    silentOverflowProneProvider: isSilentOverflowProneModel({
      provider: attempt.provider,
      modelId: attempt.modelId,
      baseUrl: attempt.model.baseUrl ?? undefined,
    }),
  };
  applyAgentAutoCompactionGuard(autoCompactionGuardArgs);

  // These factories carry compaction/pruning runtime state into the resource loader.
  const extensionFactories = buildEmbeddedExtensionFactories({
    cfg: attempt.config,
    sessionManager: input.sessionManager,
    provider: attempt.provider,
    modelId: attempt.modelId,
    model: attempt.model,
    runId: attempt.runId,
  });
  const resourceLoader = createEmbeddedAgentResourceLoader({
    cwd: input.effectiveCwd,
    agentDir: input.agentDir,
    settingsManager,
    extensionFactories,
  });
  await resourceLoader.reload();
  // reload() rehydrates disk settings. Reapply OpenClaw's context budget and
  // auto-compaction guards before the session can submit a prompt (#75799).
  applyAgentCompactionSettingsFromConfig({
    settingsManager,
    cfg: attempt.config,
    contextTokenBudget: attempt.contextTokenBudget,
  });
  applyAgentAutoCompactionGuard(autoCompactionGuardArgs);
  input.markStage("session-resource-loader");

  // Tool creation needs the same runner later used by lifecycle hooks.
  const hookRunner = getGlobalHookRunner();
  const preparedClientTools = prepareEmbeddedAttemptClientTools({
    attempt,
    ...input.clientToolPreparation,
  });
  const { allCustomTools, sessionToolAllowlist, ...clientToolRuntime } = preparedClientTools;

  const createdSession = await createAgentSession({
    cwd: input.effectiveCwd,
    agentDir: input.agentDir,
    authStorage: attempt.authStorage,
    modelRegistry: attempt.modelRegistry,
    model: attempt.model,
    thinkingLevel: input.agentCoreThinkingLevel,
    tools: sessionToolAllowlist,
    customTools: allCustomTools,
    sessionManager: input.sessionManager,
    settingsManager,
    resourceLoader,
    resolveDeferredTool: input.clientToolPreparation.deferredDirectoryToolsCallable
      ? ({ toolCall }) => {
          const tool = resolveToolSearchCatalogTool(
            {
              config: attempt.config,
              runtimeConfig: attempt.config,
              agentId: input.sessionAgentId,
              sessionKey: input.clientToolPreparation.sandboxSessionKey,
              sessionId: attempt.sessionId,
              runId: attempt.runId,
              catalogRef: input.clientToolPreparation.toolSearchCatalogRef,
              abortSignal: input.runAbortSignal,
            },
            toolCall.name,
          );
          // Catalog entries already own before_tool_call wrapping.
          const definition = tool
            ? toToolDefinitions([tool], input.clientToolPreparation.catalogToolHookContext)[0]
            : undefined;
          const hydratedTool = definition ? wrapToolDefinition(definition) : undefined;
          if (hydratedTool) {
            log.info(`tool-search: hydrated deferred directory tool ${toolCall.name}`);
            const originalExecute = hydratedTool.execute;
            hydratedTool.execute = (async (...args: Parameters<typeof originalExecute>) => {
              const interval = setInterval(() => notifyToolActivity(attempt.runId), 60_000);
              interval.unref?.();
              try {
                notifyToolActivity(attempt.runId);
                return await originalExecute(...args);
              } finally {
                clearInterval(interval);
                notifyToolActivity(attempt.runId);
              }
            }) as typeof originalExecute;
          }
          return hydratedTool;
        }
      : undefined,
    withSessionWriteLock: (operation) =>
      input.sessionLockController.withSessionWriteLock(operation),
  });
  const activeSession = createdSession.session;
  if (!activeSession) {
    throw new Error("Embedded agent session missing");
  }
  // Publish ownership before post-construction hooks. Outer cleanup must dispose
  // the session if tool activation or terminal-hook installation fails.
  input.onSessionCreated(activeSession);
  activeSession.setActiveToolsByName(sessionToolAllowlist);
  const setActiveSessionSystemPrompt = (nextSystemPrompt: string) => {
    input.onSystemPromptChanged(nextSystemPrompt);
    applySystemPromptToSession(activeSession, nextSystemPrompt);
  };
  setActiveSessionSystemPrompt(input.initialSystemPrompt);
  let didDeliverSourceReplyViaMessageTool = false;
  const markSourceReplyDelivered = () => {
    didDeliverSourceReplyViaMessageTool = true;
  };
  installMessageToolOnlyTerminalHook({
    agent: activeSession.agent,
    sourceReplyDeliveryMode: attempt.sourceReplyDeliveryMode,
    onDeliveredSourceReply: markSourceReplyDelivered,
  });
  input.markStage("agent-session");

  return {
    activeSession,
    allCustomTools,
    ...clientToolRuntime,
    hasDeliveredSourceReply: () => didDeliverSourceReplyViaMessageTool,
    hookRunner,
    markSourceReplyDelivered,
    setActiveSessionSystemPrompt,
    settingsManager,
  };
}

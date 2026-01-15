import fs from "node:fs/promises";
import os from "node:os";

import { createAgentSession, SessionManager, SettingsManager } from "@mariozechner/pi-coding-agent";

import { resolveHeartbeatPrompt } from "../../auto-reply/heartbeat.js";
import type { ReasoningLevel, ThinkLevel } from "../../auto-reply/thinking.js";
import { resolveChannelCapabilities } from "../../config/channel-capabilities.js";
import type { ClawdbotConfig } from "../../config/config.js";
import { getMachineDisplayName } from "../../infra/machine-name.js";
import { type enqueueCommand, enqueueCommandInLane } from "../../process/command-queue.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";
import { isReasoningTagProvider } from "../../utils/provider-utils.js";
import { resolveUserPath } from "../../utils.js";
import { resolveClawdbotAgentDir } from "../agent-paths.js";
import { resolveSessionAgentIds } from "../agent-scope.js";
import type { ExecElevatedDefaults } from "../bash-tools.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../defaults.js";
import { getApiKeyForModel, resolveModelAuthMode } from "../model-auth.js";
import { ensureClawdbotModelsJson } from "../models-config.js";
import {
  buildBootstrapContextFiles,
  type EmbeddedContextFile,
  ensureSessionHeader,
  resolveBootstrapMaxChars,
  validateAnthropicTurns,
  validateGeminiTurns,
} from "../pi-embedded-helpers.js";
import {
  ensurePiCompactionReserveTokens,
  resolveCompactionReserveTokensFloor,
} from "../pi-settings.js";
import { createClawdbotCodingTools } from "../pi-tools.js";
import { resolveSandboxContext } from "../sandbox.js";
import { guardSessionManager } from "../session-tool-result-guard-wrapper.js";
import { acquireSessionWriteLock } from "../session-write-lock.js";
import {
  applySkillEnvOverrides,
  applySkillEnvOverridesFromSnapshot,
  loadWorkspaceSkillEntries,
  resolveSkillsPromptForRun,
  type SkillSnapshot,
} from "../skills.js";
import { filterBootstrapFilesForSession, loadWorkspaceBootstrapFiles } from "../workspace.js";
import { buildEmbeddedExtensionPaths } from "./extensions.js";
import { logToolSchemasForGoogle, sanitizeSessionHistory } from "./google.js";
import { getDmHistoryLimitFromSessionKey, limitHistoryTurns } from "./history.js";
import { resolveGlobalLane, resolveSessionLane } from "./lanes.js";
import { log } from "./logger.js";
import { buildModelAliasLines, resolveModel } from "./model.js";
import { buildEmbeddedSandboxInfo } from "./sandbox-info.js";
import { prewarmSessionFile, trackSessionManagerAccess } from "./session-manager-cache.js";
import { buildEmbeddedSystemPrompt, createSystemPromptOverride } from "./system-prompt.js";
import { splitSdkTools } from "./tool-split.js";
import type { EmbeddedPiCompactResult } from "./types.js";
import {
  describeUnknownError,
  formatUserTime,
  mapThinkingLevel,
  resolveExecToolDefaults,
  resolveUserTimezone,
} from "./utils.js";

export async function compactEmbeddedPiSession(params: {
  sessionId: string;
  sessionKey?: string;
  messageChannel?: string;
  messageProvider?: string;
  agentAccountId?: string;
  sessionFile: string;
  workspaceDir: string;
  agentDir?: string;
  config?: ClawdbotConfig;
  skillsSnapshot?: SkillSnapshot;
  provider?: string;
  model?: string;
  thinkLevel?: ThinkLevel;
  reasoningLevel?: ReasoningLevel;
  bashElevated?: ExecElevatedDefaults;
  customInstructions?: string;
  lane?: string;
  enqueue?: typeof enqueueCommand;
  extraSystemPrompt?: string;
  ownerNumbers?: string[];
}): Promise<EmbeddedPiCompactResult> {
  const sessionLane = resolveSessionLane(params.sessionKey?.trim() || params.sessionId);
  const globalLane = resolveGlobalLane(params.lane);
  const enqueueGlobal =
    params.enqueue ?? ((task, opts) => enqueueCommandInLane(globalLane, task, opts));
  return enqueueCommandInLane(sessionLane, () =>
    enqueueGlobal(async () => {
      const resolvedWorkspace = resolveUserPath(params.workspaceDir);
      const prevCwd = process.cwd();

      const provider = (params.provider ?? DEFAULT_PROVIDER).trim() || DEFAULT_PROVIDER;
      const modelId = (params.model ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;
      const agentDir = params.agentDir ?? resolveClawdbotAgentDir();
      await ensureClawdbotModelsJson(params.config, agentDir);
      const { model, error, authStorage, modelRegistry } = resolveModel(
        provider,
        modelId,
        agentDir,
        params.config,
      );
      if (!model) {
        return {
          ok: false,
          compacted: false,
          reason: error ?? `Unknown model: ${provider}/${modelId}`,
        };
      }
      try {
        const apiKeyInfo = await getApiKeyForModel({
          model,
          cfg: params.config,
          agentDir,
        });

        if (model.provider === "github-copilot") {
          const { resolveCopilotApiToken } =
            await import("../../providers/github-copilot-token.js");
          const copilotToken = await resolveCopilotApiToken({
            githubToken: apiKeyInfo.apiKey,
          });
          authStorage.setRuntimeApiKey(model.provider, copilotToken.token);
        } else {
          authStorage.setRuntimeApiKey(model.provider, apiKeyInfo.apiKey);
        }
      } catch (err) {
        return {
          ok: false,
          compacted: false,
          reason: describeUnknownError(err),
        };
      }

      await fs.mkdir(resolvedWorkspace, { recursive: true });
      const sandboxSessionKey = params.sessionKey?.trim() || params.sessionId;
      const sandbox = await resolveSandboxContext({
        config: params.config,
        sessionKey: sandboxSessionKey,
        workspaceDir: resolvedWorkspace,
      });
      const effectiveWorkspace = sandbox?.enabled
        ? sandbox.workspaceAccess === "rw"
          ? resolvedWorkspace
          : sandbox.workspaceDir
        : resolvedWorkspace;
      await fs.mkdir(effectiveWorkspace, { recursive: true });
      await ensureSessionHeader({
        sessionFile: params.sessionFile,
        sessionId: params.sessionId,
        cwd: effectiveWorkspace,
      });

      let restoreSkillEnv: (() => void) | undefined;
      process.chdir(effectiveWorkspace);
      try {
        const shouldLoadSkillEntries =
          !params.skillsSnapshot || !params.skillsSnapshot.resolvedSkills;
        const skillEntries = shouldLoadSkillEntries
          ? loadWorkspaceSkillEntries(effectiveWorkspace)
          : [];
        restoreSkillEnv = params.skillsSnapshot
          ? applySkillEnvOverridesFromSnapshot({
              snapshot: params.skillsSnapshot,
              config: params.config,
            })
          : applySkillEnvOverrides({
              skills: skillEntries ?? [],
              config: params.config,
            });
        const skillsPrompt = resolveSkillsPromptForRun({
          skillsSnapshot: params.skillsSnapshot,
          entries: shouldLoadSkillEntries ? skillEntries : undefined,
          config: params.config,
          workspaceDir: effectiveWorkspace,
        });

        const bootstrapFiles = filterBootstrapFilesForSession(
          await loadWorkspaceBootstrapFiles(effectiveWorkspace),
          params.sessionKey ?? params.sessionId,
        );
        const sessionLabel = params.sessionKey ?? params.sessionId;
        const contextFiles: EmbeddedContextFile[] = buildBootstrapContextFiles(bootstrapFiles, {
          maxChars: resolveBootstrapMaxChars(params.config),
          warn: (message) => log.warn(`${message} (sessionKey=${sessionLabel})`),
        });
        const runAbortController = new AbortController();
        const tools = createClawdbotCodingTools({
          exec: {
            ...resolveExecToolDefaults(params.config),
            elevated: params.bashElevated,
          },
          sandbox,
          messageProvider: params.messageChannel ?? params.messageProvider,
          agentAccountId: params.agentAccountId,
          sessionKey: params.sessionKey ?? params.sessionId,
          agentDir,
          workspaceDir: effectiveWorkspace,
          config: params.config,
          abortSignal: runAbortController.signal,
          modelProvider: model.provider,
          modelId,
          modelAuthMode: resolveModelAuthMode(model.provider, params.config),
        });
        logToolSchemasForGoogle({ tools, provider });
        const machineName = await getMachineDisplayName();
        const runtimeChannel = normalizeMessageChannel(
          params.messageChannel ?? params.messageProvider,
        );
        const runtimeCapabilities = runtimeChannel
          ? (resolveChannelCapabilities({
              cfg: params.config,
              channel: runtimeChannel,
              accountId: params.agentAccountId,
            }) ?? [])
          : undefined;
        const runtimeInfo = {
          host: machineName,
          os: `${os.type()} ${os.release()}`,
          arch: os.arch(),
          node: process.version,
          model: `${provider}/${modelId}`,
          channel: runtimeChannel,
          capabilities: runtimeCapabilities,
        };
        const sandboxInfo = buildEmbeddedSandboxInfo(sandbox, params.bashElevated);
        const reasoningTagHint = isReasoningTagProvider(provider);
        const userTimezone = resolveUserTimezone(params.config?.agents?.defaults?.userTimezone);
        const userTime = formatUserTime(new Date(), userTimezone);
        const { defaultAgentId, sessionAgentId } = resolveSessionAgentIds({
          sessionKey: params.sessionKey,
          config: params.config,
        });
        const isDefaultAgent = sessionAgentId === defaultAgentId;
        const appendPrompt = buildEmbeddedSystemPrompt({
          workspaceDir: effectiveWorkspace,
          defaultThinkLevel: params.thinkLevel,
          reasoningLevel: params.reasoningLevel ?? "off",
          extraSystemPrompt: params.extraSystemPrompt,
          ownerNumbers: params.ownerNumbers,
          reasoningTagHint,
          heartbeatPrompt: isDefaultAgent
            ? resolveHeartbeatPrompt(params.config?.agents?.defaults?.heartbeat?.prompt)
            : undefined,
          skillsPrompt,
          runtimeInfo,
          sandboxInfo,
          tools,
          modelAliasLines: buildModelAliasLines(params.config),
          userTimezone,
          userTime,
          contextFiles,
        });
        const systemPrompt = createSystemPromptOverride(appendPrompt);

        const sessionLock = await acquireSessionWriteLock({
          sessionFile: params.sessionFile,
        });
        try {
          await prewarmSessionFile(params.sessionFile);
          const sessionManager = guardSessionManager(SessionManager.open(params.sessionFile));
          trackSessionManagerAccess(params.sessionFile);
          const settingsManager = SettingsManager.create(effectiveWorkspace, agentDir);
          ensurePiCompactionReserveTokens({
            settingsManager,
            minReserveTokens: resolveCompactionReserveTokensFloor(params.config),
          });
          const additionalExtensionPaths = buildEmbeddedExtensionPaths({
            cfg: params.config,
            sessionManager,
            provider,
            modelId,
            model,
          });

          const { builtInTools, customTools } = splitSdkTools({
            tools,
            sandboxEnabled: !!sandbox?.enabled,
          });

          let session: Awaited<ReturnType<typeof createAgentSession>>["session"];
          ({ session } = await createAgentSession({
            cwd: resolvedWorkspace,
            agentDir,
            authStorage,
            modelRegistry,
            model,
            thinkingLevel: mapThinkingLevel(params.thinkLevel),
            systemPrompt,
            tools: builtInTools,
            customTools,
            sessionManager,
            settingsManager,
            skills: [],
            contextFiles: [],
            additionalExtensionPaths,
          }));

          try {
            const prior = await sanitizeSessionHistory({
              messages: session.messages,
              modelApi: model.api,
              sessionManager,
              sessionId: params.sessionId,
            });
            const validatedGemini = validateGeminiTurns(prior);
            const validated = validateAnthropicTurns(validatedGemini);
            const limited = limitHistoryTurns(
              validated,
              getDmHistoryLimitFromSessionKey(params.sessionKey, params.config),
            );
            if (limited.length > 0) {
              session.agent.replaceMessages(limited);
            }
            const result = await session.compact(params.customInstructions);
            return {
              ok: true,
              compacted: true,
              result: {
                summary: result.summary,
                firstKeptEntryId: result.firstKeptEntryId,
                tokensBefore: result.tokensBefore,
                details: result.details,
              },
            };
          } finally {
            sessionManager.flushPendingToolResults?.();
            session.dispose();
          }
        } finally {
          await sessionLock.release();
        }
      } catch (err) {
        return {
          ok: false,
          compacted: false,
          reason: describeUnknownError(err),
        };
      } finally {
        restoreSkillEnv?.();
        process.chdir(prevCwd);
      }
    }),
  );
}

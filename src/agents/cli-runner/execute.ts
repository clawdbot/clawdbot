import crypto from "node:crypto";
import { shouldLogVerbose } from "../../globals.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { isTruthyEnvValue } from "../../infra/env.js";
import { requestHeartbeat as requestHeartbeatImpl } from "../../infra/heartbeat-wake.js";
import { sanitizeHostExecEnv } from "../../infra/host-env-security.js";
import { enqueueSystemEvent as enqueueSystemEventImpl } from "../../infra/system-events.js";
import { getProcessSupervisor as getProcessSupervisorImpl } from "../../process/supervisor/index.js";
import { scopedHeartbeatWakeOptions } from "../../routing/session-key.js";
import { appendBootstrapPromptWarning } from "../bootstrap-budget.js";
import {
  createCliJsonlStreamingParser,
  extractCliErrorMessage,
  parseCliOutput,
  type CliOutput,
} from "../cli-output.js";
import { FailoverError, resolveFailoverStatus } from "../failover-error.js";
import { classifyFailoverReason } from "../pi-embedded-helpers.js";
import { applyPluginTextReplacements } from "../plugin-text-transforms.js";
import { applySkillEnvOverridesFromSnapshot } from "../skills.js";
import { runClaudeLiveSessionTurn, shouldUseClaudeLiveSession } from "./claude-live-session.js";
import { prepareClaudeCliSkillsPlugin } from "./claude-skills-plugin.js";
import {
  buildCliSupervisorScopeKey,
  buildCliArgs,
  resolveCliRunQueueKey,
  enqueueCliRun,
  prepareCliPromptImagePayload,
  resolveCliNoOutputTimeoutMs,
  resolvePromptInput,
  resolveSessionIdToSend,
  resolveSystemPromptUsage,
  writeCliSystemPromptFile,
} from "./helpers.js";
import {
  cliBackendLog,
  CLI_BACKEND_LOG_OUTPUT_ENV,
  LEGACY_CLAUDE_CLI_LOG_OUTPUT_ENV,
} from "./log.js";
import type { PreparedCliRunContext } from "./types.js";

const executeDeps = {
  getProcessSupervisor: getProcessSupervisorImpl,
  enqueueSystemEvent: enqueueSystemEventImpl,
  requestHeartbeat: requestHeartbeatImpl,
};

export function setCliRunnerExecuteTestDeps(overrides: Partial<typeof executeDeps>): void {
  Object.assign(executeDeps, overrides);
}

function createCliAbortError(): Error {
  const error = new Error("CLI run aborted");
  error.name = "AbortError";
  return error;
}

function buildCliLogArgs(params: {
  args: string[];
  systemPromptArg?: string;
  sessionArg?: string;
  modelArg?: string;
  imageArg?: string;
  argsPrompt?: string;
}): string[] {
  const logArgs: string[] = [];
  for (let i = 0; i < params.args.length; i += 1) {
    const arg = params.args[i] ?? "";
    if (arg === params.systemPromptArg) {
      const systemPromptValue = params.args[i + 1] ?? "";
      logArgs.push(arg, `<systemPrompt:${systemPromptValue.length} chars>`);
      i += 1;
      continue;
    }
    if (arg === params.sessionArg) {
      logArgs.push(arg, params.args[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (arg === params.modelArg) {
      logArgs.push(arg, params.args[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (arg === params.imageArg) {
      logArgs.push(arg, "<image>");
      i += 1;
      continue;
    }
    logArgs.push(arg);
  }
  if (params.argsPrompt) {
    const promptIndex = logArgs.indexOf(params.argsPrompt);
    if (promptIndex >= 0) {
      logArgs[promptIndex] = `<prompt:${params.argsPrompt.length} chars>`;
    }
  }
  return logArgs;
}

const CLI_ENV_AUTH_LOG_KEYS = [
  "AI_GATEWAY_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_API_KEY_OLD",
  "ANTHROPIC_API_TOKEN",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_OAUTH_TOKEN",
  "ANTHROPIC_UNIX_SOCKET",
  "AZURE_OPENAI_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
  "OPENAI_API_KEY",
  "OPENAI_STEIPETE_API_KEY",
  "OPENROUTER_API_KEY",
] as const;

const CLI_BACKEND_PRESERVE_ENV = "OPENCLAW_LIVE_CLI_BACKEND_PRESERVE_ENV";

function parseCliBackendPreserveEnv(raw: string | undefined): Set<string> {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return new Set();
  }
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return new Set(
        Array.isArray(parsed)
          ? parsed.filter((entry): entry is string => typeof entry === "string")
          : [],
      );
    } catch {
      return new Set();
    }
  }
  return new Set(
    trimmed
      .split(/[,\s]+/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
}

function listPresentCliAuthEnvKeys(env: Record<string, string | undefined>): string[] {
  return CLI_ENV_AUTH_LOG_KEYS.filter((key) => {
    const value = env[key];
    return typeof value === "string" && value.length > 0;
  });
}

function formatCliEnvKeyList(keys: readonly string[]): string {
  return keys.length > 0 ? keys.join(",") : "none";
}

function buildCliEnvMcpLog(childEnv: Record<string, string>): string {
  return [
    `token=${childEnv.OPENCLAW_MCP_TOKEN ? "set" : "missing"}`,
    `sessionKey=${childEnv.OPENCLAW_MCP_SESSION_KEY ? "set" : "<empty>"}`,
    `agentId=${childEnv.OPENCLAW_MCP_AGENT_ID || "<empty>"}`,
    `accountId=${childEnv.OPENCLAW_MCP_ACCOUNT_ID || "<empty>"}`,
    `messageChannel=${childEnv.OPENCLAW_MCP_MESSAGE_CHANNEL || "<empty>"}`,
    `senderIsOwner=${childEnv.OPENCLAW_MCP_SENDER_IS_OWNER || "<empty>"}`,
  ].join(" ");
}

function fingerprintCliSessionId(sessionId?: string): string {
  const trimmed = sessionId?.trim();
  if (!trimmed) {
    return "none";
  }
  return crypto.createHash("sha256").update(trimmed).digest("hex").slice(0, 12);
}

export function buildCliExecLogLine(params: {
  provider: string;
  model: string;
  promptChars: number;
  trigger?: string;
  useResume: boolean;
  cliSessionId?: string;
  resolvedSessionId?: string;
  reusableSessionId?: string;
  invalidatedReason?: string;
  hasHistoryPrompt: boolean;
}): string {
  const reuseState = params.reusableSessionId
    ? "reusable"
    : params.invalidatedReason
      ? `invalidated:${params.invalidatedReason}`
      : "none";
  return [
    `cli exec: provider=${params.provider}`,
    `model=${params.model}`,
    `promptChars=${params.promptChars}`,
    `trigger=${params.trigger ?? "unknown"}`,
    `useResume=${params.useResume ? "true" : "false"}`,
    `session=${params.cliSessionId ? "present" : "none"}`,
    `resumeSession=${params.useResume ? fingerprintCliSessionId(params.resolvedSessionId) : "none"}`,
    `reuse=${reuseState}`,
    `historyPrompt=${params.hasHistoryPrompt ? "present" : "none"}`,
  ].join(" ");
}

export function buildCliEnvAuthLog(childEnv: Record<string, string>): string {
  const hostKeys = listPresentCliAuthEnvKeys(process.env);
  const childKeys = listPresentCliAuthEnvKeys(childEnv);
  const childKeySet = new Set(childKeys);
  const clearedKeys = hostKeys.filter((key) => !childKeySet.has(key));
  return [
    `host=${formatCliEnvKeyList(hostKeys)}`,
    `child=${formatCliEnvKeyList(childKeys)}`,
    `cleared=${formatCliEnvKeyList(clearedKeys)}`,
  ].join(" ");
}

export async function executePreparedCliRun(
  context: PreparedCliRunContext,
  cliSessionIdToUse?: string,
): Promise<CliOutput> {
  const params = context.params;
  if (params.abortSignal?.aborted) {
    throw createCliAbortError();
  }
  const backend = context.preparedBackend.backend;
  const { sessionId: resolvedSessionId, isNew } = resolveSessionIdToSend({
    backend,
    cliSessionId: cliSessionIdToUse,
  });
  const useResume = Boolean(
    cliSessionIdToUse && resolvedSessionId && backend.resumeArgs && backend.resumeArgs.length > 0,
  );
  const systemPromptArg = resolveSystemPromptUsage({
    backend,
    isNewSession: isNew,
    systemPrompt: context.systemPrompt,
  });
  const systemPromptFile =
    !useResume && systemPromptArg
      ? await writeCliSystemPromptFile({
          backend,
          systemPrompt: systemPromptArg,
        })
      : undefined;

  const basePrompt = cliSessionIdToUse
    ? params.prompt
    : (context.openClawHistoryPrompt ?? params.prompt);
  let prompt = applyPluginTextReplacements(
    appendBootstrapPromptWarning(basePrompt, context.bootstrapPromptWarningLines, {
      preserveExactPrompt: context.heartbeatPrompt,
    }),
    context.backendResolved.textTransforms?.input,
  );
  const {
    prompt: promptWithImages,
    imagePaths,
    cleanupImages,
  } = await prepareCliPromptImagePayload({
    backend,
    prompt,
    workspaceDir: context.workspaceDir,
    images: params.images,
  });
  prompt = promptWithImages;

  const { argsPrompt, stdin } = resolvePromptInput({
    backend,
    prompt,
  });
  const stdinPayload = stdin ?? "";
  const baseArgs = useResume ? (backend.resumeArgs ?? backend.args ?? []) : (backend.args ?? []);
  const resolvedArgs = useResume
    ? baseArgs.map((entry) => entry.replaceAll("{sessionId}", resolvedSessionId ?? ""))
    : baseArgs;
  const claudeSkillsPlugin = await prepareClaudeCliSkillsPlugin({
    backendId: context.backendResolved.id,
    skillsSnapshot: params.skillsSnapshot,
  });
  let claudeSkillsPluginCleanupOwned = false;
  const baseArgsWithSkills =
    claudeSkillsPlugin.args.length > 0
      ? [...resolvedArgs, ...claudeSkillsPlugin.args]
      : resolvedArgs;
  const executionBaseArgs =
    context.backendResolved.resolveExecutionArgs?.({
      config: params.config,
      workspaceDir: context.workspaceDir,
      provider: params.provider,
      modelId: context.modelId,
      authProfileId: context.effectiveAuthProfileId,
      thinkingLevel: params.thinkLevel,
      useResume,
      baseArgs: baseArgsWithSkills,
    }) ?? baseArgsWithSkills;
  const args = buildCliArgs({
    backend,
    baseArgs: Array.from(executionBaseArgs),
    modelId: context.normalizedModel,
    sessionId: resolvedSessionId,
    systemPrompt: systemPromptArg,
    systemPromptFilePath: systemPromptFile?.filePath,
    imagePaths,
    promptArg: argsPrompt,
    useResume,
  });

  const queueKey = resolveCliRunQueueKey({
    backendId: context.backendResolved.id,
    serialize: backend.serialize,
    runId: params.runId,
    workspaceDir: context.workspaceDir,
    cliSessionId: useResume ? resolvedSessionId : undefined,
  });

  try {
    return await enqueueCliRun(queueKey, async () => {
      const restoreSkillEnv = params.skillsSnapshot
        ? applySkillEnvOverridesFromSnapshot({
            snapshot: params.skillsSnapshot,
            config: params.config,
          })
        : undefined;
      try {
        cliBackendLog.info(
          buildCliExecLogLine({
            provider: params.provider,
            model: context.normalizedModel,
            promptChars: basePrompt.length,
            trigger: params.trigger,
            useResume,
            cliSessionId: cliSessionIdToUse,
            resolvedSessionId,
            reusableSessionId: context.reusableCliSession.sessionId,
            invalidatedReason: context.reusableCliSession.invalidatedReason,
            hasHistoryPrompt: Boolean(context.openClawHistoryPrompt),
          }),
        );
        const logOutputText =
          isTruthyEnvValue(process.env[CLI_BACKEND_LOG_OUTPUT_ENV]) ||
          isTruthyEnvValue(process.env[LEGACY_CLAUDE_CLI_LOG_OUTPUT_ENV]);
        const env = (() => {
          const next = sanitizeHostExecEnv({
            baseEnv: process.env,
            blockPathOverrides: true,
          });
          const preservedEnv = parseCliBackendPreserveEnv(process.env[CLI_BACKEND_PRESERVE_ENV]);
          for (const key of backend.clearEnv ?? []) {
            if (preservedEnv.has(key)) {
              continue;
            }
            delete next[key];
          }
          if (backend.env && Object.keys(backend.env).length > 0) {
            Object.assign(
              next,
              sanitizeHostExecEnv({
                baseEnv: {},
                overrides: backend.env,
                blockPathOverrides: true,
              }),
            );
          }
          Object.assign(next, context.preparedBackend.env);

          // Never mark Claude CLI as host-managed. That marker routes runs into
          // Anthropic's separate host-managed usage tier instead of normal CLI
          // subscription behavior.
          delete next["CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST"];

          return next;
        })();
        if (logOutputText) {
          const logArgs = buildCliLogArgs({
            args,
            systemPromptArg: backend.systemPromptArg,
            sessionArg: backend.sessionArg,
            modelArg: backend.modelArg,
            imageArg: backend.imageArg,
            argsPrompt,
          });
          cliBackendLog.info(`cli argv: ${backend.command} ${logArgs.join(" ")}`);
          cliBackendLog.info(`cli env auth: ${buildCliEnvAuthLog(env)}`);
          if (
            env.OPENCLAW_MCP_TOKEN ||
            env.OPENCLAW_MCP_SESSION_KEY ||
            env.OPENCLAW_MCP_SENDER_IS_OWNER
          ) {
            cliBackendLog.info(`cli env mcp: ${buildCliEnvMcpLog(env)}`);
          }
        }

        const noOutputTimeoutMs = resolveCliNoOutputTimeoutMs({
          backend,
          timeoutMs: params.timeoutMs,
          useResume,
          trigger: params.trigger,
        });
        const hasJsonlOutput = backend.output === "jsonl";
        if (shouldUseClaudeLiveSession(context)) {
          if (!hasJsonlOutput) {
            throw new Error("Claude live session requires JSONL streaming parser");
          }
          claudeSkillsPluginCleanupOwned = true;
          const ownedPreparedBackendCleanup = context.preparedBackend.cleanup;
          context.preparedBackend.cleanup = undefined;
          const liveResult = await runClaudeLiveSessionTurn({
            context,
            args,
            env,
            prompt,
            useResume,
            noOutputTimeoutMs,
            getProcessSupervisor: executeDeps.getProcessSupervisor,
            onAssistantDelta: ({ text, delta }) => {
              emitAgentEvent({
                runId: params.runId,
                stream: "assistant",
                data: {
                  text: applyPluginTextReplacements(
                    text,
                    context.backendResolved.textTransforms?.output,
                  ),
                  delta: applyPluginTextReplacements(
                    delta,
                    context.backendResolved.textTransforms?.output,
                  ),
                },
              });
            },
            cleanup: async () => {
              try {
                await claudeSkillsPlugin.cleanup();
              } finally {
                await ownedPreparedBackendCleanup?.();
              }
            },
          });
          const rawText = liveResult.output.text;
          return {
            ...liveResult.output,
            rawText,
            finalPromptText: prompt,
            text: applyPluginTextReplacements(
              rawText,
              context.backendResolved.textTransforms?.output,
            ),
          };
        }
        const streamingParser = hasJsonlOutput
          ? createCliJsonlStreamingParser({
              backend,
              providerId: context.backendResolved.id,
              onAssistantDelta: ({ text, delta }) => {
                emitAgentEvent({
                  runId: params.runId,
                  stream: "assistant",
                  data: {
                    text: applyPluginTextReplacements(
                      text,
                      context.backendResolved.textTransforms?.output,
                    ),
                    delta: applyPluginTextReplacements(
                      delta,
                      context.backendResolved.textTransforms?.output,
                    ),
                  },
                });
              },
            })
          : null;
        const supervisor = executeDeps.getProcessSupervisor();
        const scopeKey = buildCliSupervisorScopeKey({
          backend,
          backendId: context.backendResolved.id,
          cliSessionId: useResume ? resolvedSessionId : undefined,
        });

        const managedRun = await supervisor.spawn({
          sessionId: params.sessionId,
          backendId: context.backendResolved.id,
          scopeKey,
          replaceExistingScope: Boolean(useResume && scopeKey),
          mode: "child",
          argv: [backend.command, ...args],
          timeoutMs: params.timeoutMs,
          noOutputTimeoutMs,
          cwd: context.workspaceDir,
          env,
          input: stdinPayload,
          onStdout: streamingParser ? (chunk: string) => streamingParser.push(chunk) : undefined,
        });
        let replyBackendCompleted = false;
        const replyBackendHandle = params.replyOperation
          ? {
              kind: "cli" as const,
              cancel: () => {
                managedRun.cancel("manual-cancel");
              },
              isStreaming: () => !replyBackendCompleted,
            }
          : undefined;
        if (replyBackendHandle) {
          params.replyOperation?.attachBackend(replyBackendHandle);
        }
        const abortManagedRun = () => {
          managedRun.cancel("manual-cancel");
        };
        params.abortSignal?.addEventListener("abort", abortManagedRun, { once: true });
        if (params.abortSignal?.aborted) {
          abortManagedRun();
        }
        let result: Awaited<ReturnType<typeof managedRun.wait>>;
        try {
          result = await managedRun.wait();
        } finally {
          replyBackendCompleted = true;
          if (replyBackendHandle) {
            params.replyOperation?.detachBackend(replyBackendHandle);
          }
          params.abortSignal?.removeEventListener("abort", abortManagedRun);
        }
        streamingParser?.finish();
        if (params.abortSignal?.aborted && result.reason === "manual-cancel") {
          throw createCliAbortError();
        }

        const stdout = result.stdout.trim();
        const stderr = result.stderr.trim();
        if (logOutputText) {
          if (stdout) {
            cliBackendLog.info(`cli stdout:\n${stdout}`);
          }
          if (stderr) {
            cliBackendLog.info(`cli stderr:\n${stderr}`);
          }
        }
        if (shouldLogVerbose()) {
          if (stdout) {
            cliBackendLog.debug(`cli stdout:\n${stdout}`);
          }
          if (stderr) {
            cliBackendLog.debug(`cli stderr:\n${stderr}`);
          }
        }

        if (result.exitCode !== 0 || result.reason !== "exit") {
          if (result.reason === "no-output-timeout" || result.noOutputTimedOut) {
            const timeoutReason = `CLI produced no output for ${Math.round(noOutputTimeoutMs / 1000)}s and was terminated.`;
            cliBackendLog.warn(
              `cli watchdog timeout: provider=${params.provider} model=${context.modelId} session=${resolvedSessionId ?? params.sessionId} noOutputTimeoutMs=${noOutputTimeoutMs} pid=${managedRun.pid ?? "unknown"}`,
            );
            if (params.sessionKey) {
              const stallNotice = [
                `CLI agent (${params.provider}) produced no output for ${Math.round(noOutputTimeoutMs / 1000)}s and was terminated.`,
                "It may have been waiting for interactive input or an approval prompt.",
                "For Claude Code, prefer --permission-mode bypassPermissions --print.",
              ].join(" ");
              executeDeps.enqueueSystemEvent(stallNotice, { sessionKey: params.sessionKey });
              executeDeps.requestHeartbeat(
                scopedHeartbeatWakeOptions(params.sessionKey, {
                  source: "cli-watchdog",
                  intent: "event",
                  reason: "cli:watchdog:stall",
                }),
              );
            }
            throw new FailoverError(timeoutReason, {
              reason: "timeout",
              provider: params.provider,
              model: context.modelId,
              sessionId: params.sessionId,
              lane: params.lane,
              status: resolveFailoverStatus("timeout"),
            });
          }
          if (result.reason === "overall-timeout") {
            const timeoutReason = `CLI exceeded timeout (${Math.round(params.timeoutMs / 1000)}s) and was terminated.`;
            throw new FailoverError(timeoutReason, {
              reason: "timeout",
              provider: params.provider,
              model: context.modelId,
              sessionId: params.sessionId,
              lane: params.lane,
              status: resolveFailoverStatus("timeout"),
            });
          }
          const primaryErrorText = stderr || stdout;
          const structuredError =
            extractCliErrorMessage(primaryErrorText) ??
            (stderr ? extractCliErrorMessage(stdout) : null);
          const err = structuredError || primaryErrorText || "CLI failed.";
          const reason = classifyFailoverReason(err, { provider: params.provider }) ?? "unknown";
          const status = resolveFailoverStatus(reason);
          throw new FailoverError(err, {
            reason,
            provider: params.provider,
            model: context.modelId,
            sessionId: params.sessionId,
            lane: params.lane,
            status,
          });
        }

        const parsed = parseCliOutput({
          raw: stdout,
          backend,
          providerId: context.backendResolved.id,
          outputMode: useResume ? (backend.resumeOutput ?? backend.output) : backend.output,
          fallbackSessionId: resolvedSessionId,
        });
        const rawText = parsed.text;
        return {
          ...parsed,
          rawText,
          finalPromptText: prompt,
          text: applyPluginTextReplacements(
            rawText,
            context.backendResolved.textTransforms?.output,
          ),
        };
      } finally {
        restoreSkillEnv?.();
      }
    });
  } finally {
    if (!claudeSkillsPluginCleanupOwned) {
      await claudeSkillsPlugin.cleanup();
    }
    if (systemPromptFile) {
      await systemPromptFile.cleanup();
    }
    if (cleanupImages) {
      await cleanupImages();
    }
  }
}

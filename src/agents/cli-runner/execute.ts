/**
 * Executes prepared CLI backend runs, including env isolation, streaming parse,
 * live-session routing, and diagnostics.
 */
import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  beginMcpLoopbackToolCallCapture,
  clearMcpLoopbackToolCallCapture,
  type McpLoopbackToolCallStart,
  type McpLoopbackToolCallTerminalOutcome,
  waitForMcpLoopbackToolCallCaptureIdle,
} from "../../gateway/mcp-http.loopback-runtime.js";
import { invokeNodeClaudeCliRun } from "../../gateway/node-agent-cli-runtime.js";
import { shouldLogVerbose } from "../../globals.js";
import {
  assertAgentRunLifecycleGenerationCurrent,
  emitAgentEvent,
} from "../../infra/agent-events.js";
import { emitTrustedDiagnosticEvent } from "../../infra/diagnostic-events.js";
import { isTruthyEnvValue } from "../../infra/env.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  resolveEventSessionKeyForPolicy,
  resolveEventSessionRoutingPolicy,
  scopedHeartbeatWakeOptionsForPolicy,
} from "../../infra/event-session-routing.js";
import { requestHeartbeat as requestHeartbeatImpl } from "../../infra/heartbeat-wake.js";
import { sanitizeHostExecEnv } from "../../infra/host-env-security.js";
import { shouldUseInternalSourceReplySink } from "../../infra/outbound/internal-source-reply.js";
import { enqueueSystemEvent as enqueueSystemEventImpl } from "../../infra/system-events.js";
import type { CliBackendThinkingLevel } from "../../plugins/cli-backend.types.js";
import { getProcessSupervisor as getProcessSupervisorImpl } from "../../process/supervisor/index.js";
import type { RunExit } from "../../process/supervisor/types.js";
import { applySkillEnvOverridesFromSnapshot } from "../../skills/runtime/env-overrides.js";
import {
  registerExecApprovalRequestForHostOrThrow,
  resolveRegisteredExecApprovalDecision,
} from "../bash-tools.exec-approval-request.js";
import { appendBootstrapPromptWarning } from "../bootstrap-budget.js";
import {
  fingerprintCliRuntimeArtifact,
  resolveCliRuntimeOwnerFingerprint,
} from "../cli-auth-epoch.js";
import { resolveCliExecutableIdentity } from "../cli-executable-identity.js";
import {
  createCliJsonlStreamingParser,
  extractCliErrorMessage,
  parseCliOutput,
  type CliOutput,
  type CliStreamingDelta,
  type CliThinkingDelta,
  type CliThinkingProgress,
  type CliToolUseStartDelta,
} from "../cli-output.js";
import { classifyFailoverReason } from "../embedded-agent-helpers.js";
import {
  isDeliveredMessageToolOnlySourceReplyResult,
  isDeliveredMessagingToolResult,
} from "../embedded-agent-message-tool-source-reply.js";
import {
  isMessagingTool,
  isMessagingToolDeliveryAction,
  isMessagingToolSendAction,
} from "../embedded-agent-messaging.js";
import type {
  MessagingToolSend,
  MessagingToolSourceReplyPayload,
} from "../embedded-agent-messaging.types.js";
import {
  extractMessagingToolSendResult,
  extractMessagingToolSourceReplyPayload,
  sanitizeToolArgs,
  sanitizeToolResult,
} from "../embedded-agent-subscribe.tools.js";
import { FailoverError, resolveFailoverStatus } from "../failover-error.js";
import { applyPluginTextReplacements } from "../plugin-text-transforms.js";
import { resolveCliToolTerminalReason } from "../run-termination.js";
import { prepareCliBundleMcpCaptureAttempt } from "./bundle-mcp.js";
import {
  closeClaudeLiveSessionForContext,
  rotateClaudeLiveMcpCaptureKeyForContext,
  runClaudeLiveSessionTurn,
  shouldUseClaudeLiveSession,
} from "./claude-live-session.js";
import { prepareClaudeCliSkillsPlugin } from "./claude-skills-plugin.js";
import { attachCliMessagingDeliveryEvidence } from "./delivery-evidence.js";
import {
  appendUniqueCliMessagingEvidence,
  buildMessagingToolSendEvidenceKey,
  CLI_MESSAGING_EVIDENCE_MAX_CALLS,
  extractCliMessagingContent,
  extractCliMessagingTarget,
  normalizeCliMessagingToolName,
} from "./execute-messaging.js";
import {
  createCliAbortError,
  executeNodeClaudeRun,
  resolveNodeClaudePlacement,
  stripGatewayLocalClaudeArgs,
} from "./execute-node-claude.js";
import { appendCliOutputTail } from "./execute-output-buffer.js";
import {
  buildCliSupervisorScopeKey,
  buildClaudeOwnerKey,
  buildCliArgs,
  resolveCliRunQueueKey,
  enqueueCliRun,
  prepareCliPromptImagePayload,
  resolveCliNoOutputTimeoutMs,
  resolveCliRunTimeoutOverrideMs,
  resolvePromptInput,
  resolveSessionIdToSend,
  resolveSystemPromptUsage,
  writeCliSystemPromptFile,
} from "./helpers.js";
import {
  cliBackendLog,
  CLI_BACKEND_LOG_OUTPUT_ENV,
  formatCliBackendOutputDigest,
  LEGACY_CLAUDE_CLI_LOG_OUTPUT_ENV,
} from "./log.js";
import { createCliOutputFailoverError } from "./output-error.js";
import type { CliReusableSession, PreparedCliRunContext } from "./types.js";

const CLI_RUNNER_OUTPUT_PARSE_BYTES = 1024 * 1024;

function appendCliOutputParseBuffer(
  buffer: Buffer,
  chunk: string,
): { buffer: Buffer; exceeded: boolean } {
  if (!chunk) {
    return { buffer, exceeded: false };
  }
  const chunkBuffer = Buffer.from(chunk);
  if (buffer.byteLength + chunkBuffer.byteLength > CLI_RUNNER_OUTPUT_PARSE_BYTES) {
    const remainingBytes = CLI_RUNNER_OUTPUT_PARSE_BYTES - buffer.byteLength;
    if (remainingBytes <= 0) {
      return { buffer, exceeded: true };
    }
    return {
      buffer: Buffer.concat(
        [buffer, chunkBuffer.subarray(0, remainingBytes)],
        CLI_RUNNER_OUTPUT_PARSE_BYTES,
      ),
      exceeded: true,
    };
  }
  return {
    buffer: Buffer.concat([buffer, chunkBuffer], buffer.byteLength + chunkBuffer.byteLength),
    exceeded: false,
  };
}

const executeDeps = {
  getProcessSupervisor: getProcessSupervisorImpl,

  enqueueSystemEvent: enqueueSystemEventImpl,

  requestHeartbeat: requestHeartbeatImpl,

  writeCliSystemPromptFile,

  invokeNodeClaudeCliRun,

  registerExecApprovalRequestForHostOrThrow,
  resolveRegisteredExecApprovalDecision,
};

const CLI_LOOPBACK_CORRELATION_MAX_CALLS = 64;

const CLI_MCP_DELIVERY_DRAIN_GRACE_MS = 5_000;

const CLI_MCP_REQUEST_ADMISSION_GRACE_MS = 250;

function normalizeCliBackendThinkingLevel(
  level: PreparedCliRunContext["params"]["thinkLevel"],
): CliBackendThinkingLevel | undefined {
  return level === "ultra" ? "max" : level;
}

function buildCliMcpCaptureKey(context: PreparedCliRunContext): string | undefined {
  if (!context.mcpDeliveryCapture) {
    return undefined;
  }
  return crypto.randomUUID();
}

/** Overrides process/event dependencies for CLI runner execution tests. */
function setCliRunnerExecuteTestDeps(overrides: Partial<typeof executeDeps>): void {
  Object.assign(executeDeps, overrides);
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

const CLI_ENV_RUNTIME_LOG_KEYS = ["GEMINI_CLI_HOME", "GEMINI_CLI_SYSTEM_SETTINGS_PATH"] as const;

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

function listPresentCliRuntimeEnvKeys(env: Record<string, string | undefined>): string[] {
  return CLI_ENV_RUNTIME_LOG_KEYS.filter((key) => {
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
    `capture=${childEnv.OPENCLAW_MCP_CLI_CAPTURE_KEY ? "set" : "missing"}`,
  ].join(" ");
}

function fingerprintCliSessionId(sessionId?: string): string {
  const trimmed = sessionId?.trim();
  if (!trimmed) {
    return "none";
  }
  return crypto.createHash("sha256").update(trimmed).digest("hex").slice(0, 12);
}

function formatCliSessionReuseLogState(reusableSession: CliReusableSession): string {
  switch (reusableSession.mode) {
    case "reuse":
      return "reusable";
    case "reuse-with-drift":
      return `reusable-drift:${reusableSession.drift.reasons.join(",")}`;
    case "invalidate":
      return `invalidated:${reusableSession.invalidatedReason}`;
    case "none":
      return "none";
  }
  const exhaustive: never = reusableSession;
  return exhaustive;
}

/** Builds the compact execution summary logged before a CLI backend run. */
function buildCliExecLogLine(params: {
  provider: string;
  model: string;
  promptChars: number;
  trigger?: string;
  useResume: boolean;
  cliSessionId?: string;
  resolvedSessionId?: string;
  reusableSession: CliReusableSession;
  hasHistoryPrompt: boolean;
}): string {
  return [
    `cli exec: provider=${params.provider}`,
    `model=${params.model}`,
    `promptChars=${params.promptChars}`,
    `trigger=${params.trigger ?? "unknown"}`,
    `useResume=${params.useResume ? "true" : "false"}`,
    `session=${params.cliSessionId ? "present" : "none"}`,
    `resumeSession=${params.useResume ? fingerprintCliSessionId(params.resolvedSessionId) : "none"}`,
    `reuse=${formatCliSessionReuseLogState(params.reusableSession)}`,
    `historyPrompt=${params.hasHistoryPrompt ? "present" : "none"}`,
  ].join(" ");
}

/** Summarizes auth-related env keys preserved or cleared for a CLI child process. */
function buildCliEnvAuthLog(childEnv: Record<string, string>): string {
  const hostKeys = listPresentCliAuthEnvKeys(process.env);
  const childKeys = listPresentCliAuthEnvKeys(childEnv);
  const childKeySet = new Set(childKeys);
  const clearedKeys = hostKeys.filter((key) => !childKeySet.has(key));
  const runtimeHostKeys = listPresentCliRuntimeEnvKeys(process.env);
  const runtimeChildKeys = listPresentCliRuntimeEnvKeys(childEnv);
  const runtimeChildKeySet = new Set(runtimeChildKeys);
  const runtimeClearedKeys = runtimeHostKeys.filter((key) => !runtimeChildKeySet.has(key));
  return [
    `host=${formatCliEnvKeyList(hostKeys)}`,
    `child=${formatCliEnvKeyList(childKeys)}`,
    `cleared=${formatCliEnvKeyList(clearedKeys)}`,
    `runtimeHost=${formatCliEnvKeyList(runtimeHostKeys)}`,
    `runtimeChild=${formatCliEnvKeyList(runtimeChildKeys)}`,
    `runtimeCleared=${formatCliEnvKeyList(runtimeClearedKeys)}`,
  ].join(" ");
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.cliRunnerExecuteTestApi")] = {
    buildCliEnvAuthLog,
    buildCliExecLogLine,
    setCliRunnerExecuteTestDeps: (overrides: Record<string, unknown>) => {
      setCliRunnerExecuteTestDeps(overrides as Partial<typeof executeDeps>);
    },
  };
}

/** Executes a prepared CLI run context and returns normalized CLI output. */
export async function executePreparedCliRun(
  context: PreparedCliRunContext,
  cliSessionIdToUse?: string,
): Promise<CliOutput> {
  const params = context.params;
  if (params.abortSignal?.aborted) {
    throw createCliAbortError();
  }
  const backend = context.preparedBackend.backend;
  const nodePlacement = resolveNodeClaudePlacement(context);
  const { sessionId: resolvedSessionId, isNew } = resolveSessionIdToSend({
    backend,
    cliSessionId: cliSessionIdToUse,
  });
  const useResume = Boolean(
    cliSessionIdToUse && resolvedSessionId && backend.resumeArgs && backend.resumeArgs.length > 0,
  );
  const resendSystemPromptForSoftResume = context.reusableCliSession.mode === "reuse-with-drift";
  const systemPromptArg = resolveSystemPromptUsage({
    backend,
    isNewSession: isNew || resendSystemPromptForSoftResume,
    systemPrompt: context.systemPrompt,
  });
  const systemPromptFile =
    !nodePlacement &&
    systemPromptArg &&
    (!useResume || backend.systemPromptWhen === "always" || resendSystemPromptForSoftResume)
      ? await executeDeps.writeCliSystemPromptFile({
          backend,
          systemPrompt: systemPromptArg,
        })
      : undefined;
  const nodeSystemPrompt =
    nodePlacement &&
    systemPromptArg &&
    (!useResume || backend.systemPromptWhen === "always" || resendSystemPromptForSoftResume)
      ? systemPromptArg
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
  if (nodePlacement && ((params.images?.length ?? 0) > 0 || Boolean(params.imagePrompt?.trim()))) {
    throw new Error("paired-node Claude CLI sessions do not support attachments or images");
  }
  const {
    prompt: promptWithImages,
    imagePaths,
    cleanupImages,
  } = nodePlacement
    ? { prompt, imagePaths: [] as string[], cleanupImages: async () => {} }
    : await prepareCliPromptImagePayload({
        backend,
        prompt,
        imagePrompt: params.imagePrompt,
        workspaceDir: context.workspaceDir,
        images: params.images,
        imageOrder: params.imageOrder,
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
  const fallbackClaudeSkillsPlugin =
    !nodePlacement && context.claudeSkillsPluginArgs === undefined
      ? await prepareClaudeCliSkillsPlugin({
          backendId: context.backendResolved.id,
          skillsSnapshot: params.skillsSnapshot,
        })
      : undefined;
  let fallbackClaudeSkillsPluginCleanupOwned = false;
  const claudeSkillsPluginArgs = nodePlacement
    ? []
    : (context.claudeSkillsPluginArgs ?? fallbackClaudeSkillsPlugin?.args ?? []);
  const baseArgsWithSkills =
    claudeSkillsPluginArgs.length > 0 ? [...resolvedArgs, ...claudeSkillsPluginArgs] : resolvedArgs;
  const resolvedExecutionArgs = context.backendResolved.resolveExecutionArgs?.({
    config: params.config,
    workspaceDir: context.workspaceDir,
    provider: params.provider,
    modelId: context.modelId,
    authProfileId: context.effectiveAuthProfileId,
    thinkingLevel: normalizeCliBackendThinkingLevel(params.thinkLevel),
    executionMode: params.executionMode ?? "agent",
    // Node runs project the native subset only: gateway-loopback MCP tools do
    // not exist on the node, and --allowedTools auto-approval must never cross
    // the node boundary. Dropping availability entirely would let a restricted
    // session run with the node's full native toolset.
    toolAvailability:
      nodePlacement && params.cliToolAvailability
        ? { native: params.cliToolAvailability.native, mcp: [] }
        : params.cliToolAvailability,
    useResume,
    baseArgs: baseArgsWithSkills,
  });
  if (params.cliToolAvailability && !resolvedExecutionArgs) {
    throw new Error(
      `CLI backend ${context.backendResolved.id} did not enforce exact per-run tool availability`,
    );
  }
  const executionBaseArgs = nodePlacement
    ? stripGatewayLocalClaudeArgs(resolvedExecutionArgs ?? baseArgsWithSkills)
    : (resolvedExecutionArgs ?? baseArgsWithSkills);
  const argsBackend = nodePlacement
    ? {
        ...backend,
        systemPromptArg: undefined,
        systemPromptFileArg: undefined,
      }
    : backend;
  const args = buildCliArgs({
    backend: argsBackend,
    baseArgs: Array.from(executionBaseArgs),
    modelId: context.normalizedModel,
    sessionId: resolvedSessionId,
    systemPrompt: nodePlacement ? undefined : systemPromptArg,
    systemPromptFilePath: systemPromptFile?.filePath,
    imagePaths,
    promptArg: argsPrompt,
    useResume,
    forkResume: params.forkCliSessionOnResume,
    sendSystemPromptOnResume: resendSystemPromptForSoftResume,
  });

  const claudeOwnerKey = buildClaudeOwnerKey({
    agentAccountId: params.agentAccountId,
    agentId: params.agentId,
    authProfileId: context.effectiveAuthProfileId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
  });
  const queueKey = resolveCliRunQueueKey({
    backendId: context.backendResolved.id,
    liveSession: backend.liveSession,
    serialize: backend.serialize,
    runId: params.runId,
    workspaceDir: context.workspaceDir,
    cliSessionId: useResume ? resolvedSessionId : undefined,
    ownerKey: claudeOwnerKey,
  });

  let completedOutput: CliOutput | undefined;
  let executionError: unknown;
  let forkResumeClaimed = false;
  let forkSuccessorObserved = false;
  let forkSuccessorPersistence: Promise<void> | undefined;
  const observeForkSuccessor = (sessionId: string) => {
    if (
      forkSuccessorObserved ||
      !forkResumeClaimed ||
      !resolvedSessionId ||
      sessionId === resolvedSessionId
    ) {
      return;
    }
    forkSuccessorObserved = true;
    forkSuccessorPersistence = params.persistCliSessionForkSuccessor?.(sessionId);
    void forkSuccessorPersistence?.catch(() => undefined);
  };
  const finishForkSuccessorPersistence = async () => {
    try {
      await forkSuccessorPersistence;
    } catch (error) {
      forkSuccessorObserved = false;
      throw error;
    }
  };
  const cleanupOuterResource = async (cleanup: (() => Promise<void>) | undefined) => {
    try {
      await cleanup?.();
    } catch (error) {
      if (completedOutput?.didSendViaMessagingTool === true) {
        cliBackendLog.warn(
          `CLI outer resource cleanup failed after confirmed message delivery: ${formatErrorMessage(error)}`,
        );
        return;
      }
      if (executionError !== undefined) {
        cliBackendLog.warn(
          `CLI outer resource cleanup also failed after run error: ${formatErrorMessage(error)}`,
        );
        return;
      }
      throw error;
    }
  };
  try {
    completedOutput = await enqueueCliRun(queueKey, async () => {
      if (params.lifecycleGeneration) {
        assertAgentRunLifecycleGenerationCurrent(params.lifecycleGeneration);
      }
      if (params.forkCliSessionOnResume && useResume) {
        if (!params.persistCliSessionForkSuccessor) {
          throw new Error("CLI session fork successor persistence is unavailable");
        }
        forkResumeClaimed = (await params.claimCliSessionFork?.()) === true;
        if (!forkResumeClaimed) {
          throw new Error("CLI session fork marker is no longer available");
        }
        // The fork argument only applies at process startup; a cached warm child
        // would run this turn inside the source session. Force a fresh spawn.
        await closeClaudeLiveSessionForContext(context);
      }
      await context.preparedBackend.beforeExecution?.();
      const cliTurnStartedAt = Date.now();
      const restoreSkillEnv = params.skillsSnapshot
        ? applySkillEnvOverridesFromSnapshot({
            snapshot: params.skillsSnapshot,
            config: params.config,
          })
        : undefined;
      let gatewayCaptureKey: string | undefined;
      let cleanupMcpCaptureAttempt: (() => Promise<void>) | undefined;
      let yielded = false;
      let didSendViaMessagingTool = false;
      let didDeliverSourceReplyViaMessageTool = false;
      let inFlightUnclassifiedMcpRequests = 0;
      let inFlightMessagingToolCalls = 0;
      const inFlightPreparedMessagingCalls = new Set<McpLoopbackToolCallStart>();
      const pendingMessagingCalls = new Map<
        string,
        { toolName: string; args: Record<string, unknown>; target?: MessagingToolSend }
      >();
      type CliToolTerminalOutcome = McpLoopbackToolCallTerminalOutcome | { outcome: "completed" };
      type CliLoopbackAmbiguityGroup = {
        calls: Set<CliLoopbackCall>;
        activeToolCallIds: Set<string>;
      };
      type CliLoopbackCall = {
        admitted: McpLoopbackToolCallStart;
        current: McpLoopbackToolCallStart;
        boundToolCallId?: string;
        outcome?: CliToolTerminalOutcome;
        ambiguous: boolean;
        ambiguityGroup?: CliLoopbackAmbiguityGroup;
      };
      type ActiveCliTool = {
        toolName: string;
        args: Record<string, unknown>;
        loopbackCall?: CliLoopbackCall;
        loopbackAmbiguous: boolean;
        ambiguityGroup?: CliLoopbackAmbiguityGroup;
      };
      const cliLoopbackCalls: CliLoopbackCall[] = [];
      const activeCliTools = new Map<string, ActiveCliTool>();
      let cliLoopbackCorrelationOverflowed = false;
      const matchesCliLoopbackCall = (
        toolName: string,
        toolArgs: Record<string, unknown>,
        call: McpLoopbackToolCallStart,
      ) =>
        normalizeCliMessagingToolName(toolName) === call.toolName &&
        isDeepStrictEqual(toolArgs, call.args);
      const markCliLoopbackCallsAmbiguous = (
        calls: CliLoopbackCall[],
        activeEntries = Array.from(activeCliTools.entries()).filter(
          ([, activeTool]) =>
            activeTool.loopbackCall !== undefined && calls.includes(activeTool.loopbackCall),
        ),
      ) => {
        const groups = new Set<CliLoopbackAmbiguityGroup>();
        for (const call of calls) {
          if (call.ambiguityGroup) {
            groups.add(call.ambiguityGroup);
          }
        }
        for (const [, activeTool] of activeEntries) {
          if (activeTool.ambiguityGroup) {
            groups.add(activeTool.ambiguityGroup);
          }
        }
        const group = groups.values().next().value ?? {
          calls: new Set<CliLoopbackCall>(),
          activeToolCallIds: new Set<string>(),
        };
        for (const existing of groups) {
          if (existing === group) {
            continue;
          }
          for (const call of existing.calls) {
            call.ambiguityGroup = group;
            group.calls.add(call);
          }
          for (const toolCallId of existing.activeToolCallIds) {
            const activeTool = activeCliTools.get(toolCallId);
            if (activeTool) {
              activeTool.ambiguityGroup = group;
              group.activeToolCallIds.add(toolCallId);
            }
          }
          existing.calls.clear();
          existing.activeToolCallIds.clear();
        }
        for (const call of calls) {
          call.ambiguous = true;
          call.ambiguityGroup = group;
          group.calls.add(call);
        }
        for (const [toolCallId, activeTool] of activeEntries) {
          activeTool.loopbackAmbiguous = true;
          activeTool.ambiguityGroup = group;
          group.activeToolCallIds.add(toolCallId);
        }
      };
      const markCliLoopbackSignatureAmbiguous = (call: McpLoopbackToolCallStart) => {
        const calls = cliLoopbackCalls.filter((candidate) =>
          matchesCliLoopbackCall(call.toolName, call.args, candidate.admitted),
        );
        const activeEntries = Array.from(activeCliTools.entries()).filter(([, activeTool]) =>
          matchesCliLoopbackCall(activeTool.toolName, activeTool.args, call),
        );
        markCliLoopbackCallsAmbiguous(calls, activeEntries);
      };
      const retainCliLoopbackCall = (call: McpLoopbackToolCallStart) => {
        if (cliLoopbackCalls.length >= CLI_LOOPBACK_CORRELATION_MAX_CALLS) {
          cliLoopbackCorrelationOverflowed = true;
          for (const activeTool of activeCliTools.values()) {
            if (activeTool.loopbackCall || activeTool.toolName.startsWith("mcp__")) {
              activeTool.loopbackAmbiguous = true;
            }
          }
          cliLoopbackCalls.length = 0;
          return undefined;
        }
        const retained: CliLoopbackCall = {
          admitted: call,
          current: call,
          ambiguous: false,
        };
        cliLoopbackCalls.push(retained);
        return retained;
      };
      const bindCliLoopbackCall = (
        call: CliLoopbackCall,
        toolCallId: string,
        activeTool: ActiveCliTool,
      ) => {
        call.boundToolCallId = toolCallId;
        activeTool.loopbackCall = call;
        activeTool.loopbackAmbiguous ||= call.ambiguous;
        if (call.ambiguityGroup) {
          activeTool.ambiguityGroup = call.ambiguityGroup;
          call.ambiguityGroup.activeToolCallIds.add(toolCallId);
        }
      };
      const removeCliLoopbackCall = (call: CliLoopbackCall | undefined) => {
        if (!call) {
          return;
        }
        const index = cliLoopbackCalls.indexOf(call);
        if (index >= 0) {
          cliLoopbackCalls.splice(index, 1);
        }
      };
      const retireCliLoopbackCorrelation = (
        toolCallId: string,
        activeTool: ActiveCliTool | undefined,
      ) => {
        removeCliLoopbackCall(activeTool?.loopbackCall);
        const group = activeTool?.ambiguityGroup;
        if (!group) {
          return;
        }
        group.activeToolCallIds.delete(toolCallId);
        const hasUnboundCall = Array.from(group.calls).some(
          (call) => call.boundToolCallId === undefined && cliLoopbackCalls.includes(call),
        );
        if (group.activeToolCallIds.size > 0 || hasUnboundCall) {
          return;
        }
        // An ambiguous group owns unbound captures too. Retire the whole group
        // once its parsed tools finish so stale calls cannot poison later tools.
        for (const call of group.calls) {
          removeCliLoopbackCall(call);
        }
        group.calls.clear();
      };
      const resolveCliLoopbackTerminalOutcome = (toolCallId: string) => {
        const activeTool = activeCliTools.get(toolCallId);
        if (activeTool?.loopbackAmbiguous) {
          return { outcome: "unknown" } as const;
        }
        return activeTool?.loopbackCall?.outcome;
      };
      const matchingActiveCliTools = (
        call: McpLoopbackToolCallStart,
      ): Array<[string, ActiveCliTool]> =>
        Array.from(activeCliTools.entries()).filter(([, activeTool]) =>
          matchesCliLoopbackCall(activeTool.toolName, activeTool.args, call),
        );
      const messagingToolSentTexts: string[] = [];
      const messagingToolSentTextKeys = new Set<string>();
      const messagingToolSentMediaUrls: string[] = [];
      const messagingToolSentMediaUrlKeys = new Set<string>();
      const messagingToolSentTargets: MessagingToolSend[] = [];
      const messagingToolSentTargetKeys = new Set<string>();
      const messagingToolSourceReplyPayloads: MessagingToolSourceReplyPayload[] = [];
      const isPreparedInternalSourceReply = async (call: McpLoopbackToolCallStart) => {
        if (
          context.params.sourceReplyDeliveryMode !== "message_tool_only" ||
          normalizeCliMessagingToolName(call.toolName) !== "message" ||
          call.args.action !== "send" ||
          !context.params.config
        ) {
          return false;
        }
        return await shouldUseInternalSourceReplySink(
          {
            cfg: context.params.config,
            action: "send",
            sessionKey: context.params.sessionKey,
            sourceReplyDeliveryMode: context.params.sourceReplyDeliveryMode,
            toolContext: {
              currentChannelProvider:
                context.params.messageChannel ?? context.params.messageProvider,
              currentChannelId: context.params.currentChannelId,
              currentThreadTs: context.params.currentThreadTs,
              currentMessageId: context.params.currentMessageId,
            },
          },
          call.args,
        );
      };
      let runOutput: CliOutput | undefined;
      let runError: unknown;
      let runFailed = false;
      const recordRunError = (error: unknown) => {
        if (runFailed) {
          return;
        }
        runFailed = true;
        runError = error;
      };
      const withExecutionEvidence = (output: CliOutput): CliOutput => {
        return {
          ...output,
          ...(yielded ? { yielded: true as const } : {}),
          ...(didSendViaMessagingTool ? { didSendViaMessagingTool: true } : {}),
          ...(didDeliverSourceReplyViaMessageTool
            ? { didDeliverSourceReplyViaMessageTool: true }
            : {}),
          ...(messagingToolSentTexts.length > 0
            ? { messagingToolSentTexts: messagingToolSentTexts.slice() }
            : {}),
          ...(messagingToolSentMediaUrls.length > 0
            ? { messagingToolSentMediaUrls: messagingToolSentMediaUrls.slice() }
            : {}),
          ...(messagingToolSentTargets.length > 0
            ? { messagingToolSentTargets: messagingToolSentTargets.slice() }
            : {}),
          ...(messagingToolSourceReplyPayloads.length > 0
            ? { messagingToolSourceReplyPayloads: messagingToolSourceReplyPayloads.slice() }
            : {}),
        };
      };
      let finalizeParsedTools = () => {};
      // Opaque owner proof must describe a child spawned for this turn. A
      // warm stdio session could have been created from an older executable.
      const useManagedClaudeLiveSession =
        shouldUseClaudeLiveSession(context) && !params.onSuccessfulAuthBinding;
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
            reusableSession: context.reusableCliSession,
            hasHistoryPrompt: Boolean(context.openClawHistoryPrompt),
          }),
        );
        const logOutputText =
          isTruthyEnvValue(process.env[CLI_BACKEND_LOG_OUTPUT_ENV]) ||
          isTruthyEnvValue(process.env[LEGACY_CLAUDE_CLI_LOG_OUTPUT_ENV]);
        const outputMode = useResume ? (backend.resumeOutput ?? backend.output) : backend.output;
        const hasJsonlOutput = outputMode === "jsonl";
        const initialGatewayCaptureKey =
          useManagedClaudeLiveSession || nodePlacement ? undefined : buildCliMcpCaptureKey(context);
        const mcpCaptureAttempt = nodePlacement
          ? { env: {}, cleanup: undefined }
          : await prepareCliBundleMcpCaptureAttempt({
              mode: context.backendResolved.bundleMcpMode,
              backend,
              env: context.preparedBackend.env,
              captureKey: initialGatewayCaptureKey,
            });
        cleanupMcpCaptureAttempt = mcpCaptureAttempt.cleanup;
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
          const backendEnv = {
            ...backend.env,
            ...context.preparedBackend.env,
          };
          if (Object.keys(backendEnv).length > 0) {
            Object.assign(
              next,
              sanitizeHostExecEnv({
                baseEnv: {},
                overrides: backendEnv,
                blockPathOverrides: true,
              }),
            );
          }
          Object.assign(next, mcpCaptureAttempt.env);

          // Never mark Claude CLI as host-managed. That marker routes runs into
          // Anthropic's separate host-managed usage tier instead of normal CLI
          // subscription behavior.
          delete next["CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST"];

          return next;
        })();
        let executionCommand = backend.command;
        let executionLeadingArgv: readonly string[] = [];
        let executionArgs = args;
        context.runtimeOwnerFingerprint = undefined;
        context.runtimeArtifactFingerprint = undefined;
        if (params.onSuccessfulAuthBinding && !nodePlacement) {
          const executableIdentity = await resolveCliExecutableIdentity({
            command: backend.command,
            cwd: context.cwd ?? context.workspaceDir,
            env,
            ...(context.backendResolved.runtimeArtifact
              ? { runtimeArtifact: context.backendResolved.runtimeArtifact }
              : {}),
          });
          if (!executableIdentity) {
            throw new Error(
              `CLI backend ${context.backendResolved.id} executable cannot be bound to one durable absolute owner`,
            );
          }
          executionCommand = executableIdentity.invocation.command;
          executionLeadingArgv = executableIdentity.invocation.leadingArgv;
          executionArgs = args;
          context.runtimeArtifactFingerprint = fingerprintCliRuntimeArtifact({
            provider: params.provider,
            backendId: context.backendResolved.id,
            executableIdentity,
          });
          if (!context.authBindingFingerprint) {
            context.runtimeOwnerFingerprint = await resolveCliRuntimeOwnerFingerprint({
              provider: params.provider,
              config: params.config ?? context.contextEngineConfig,
              ...(context.agentDir ? { agentDir: context.agentDir } : {}),
              agentId: params.agentId,
              runtimeOwnerId: context.backendResolved.id,
              ...(context.effectiveAuthProfileId
                ? { authProfileId: context.effectiveAuthProfileId }
                : {}),
              ...(context.authBindingSkipsLocalCredential ? { skipLocalCredential: true } : {}),
              runtimeArtifactFingerprint: context.runtimeArtifactFingerprint,
            });
          }
        }
        if (logOutputText) {
          const logArgs = buildCliLogArgs({
            args: executionArgs,
            systemPromptArg: backend.systemPromptArg,
            sessionArg: backend.sessionArg,
            modelArg: backend.modelArg,
            imageArg: backend.imageArg,
            argsPrompt,
          });
          cliBackendLog.info(`cli argv: ${executionCommand} ${logArgs.join(" ")}`);
          cliBackendLog.info(`cli env auth: ${buildCliEnvAuthLog(env)}`);
          if (env.OPENCLAW_MCP_TOKEN) {
            cliBackendLog.info(`cli env mcp: ${buildCliEnvMcpLog(env)}`);
          }
        }

        const runTimeoutOverrideMs = resolveCliRunTimeoutOverrideMs({
          config: params.config,
          lane: params.lane,
          timeoutMs: params.timeoutMs,
          runTimeoutOverrideMs: params.runTimeoutOverrideMs,
        });
        const noOutputTimeoutMs = resolveCliNoOutputTimeoutMs({
          backend,
          timeoutMs: params.timeoutMs,
          runTimeoutOverrideMs,
          useResume,
          trigger: params.trigger,
        });
        const commitMessagingToolResult = (paramsLocal: {
          toolName: string;
          target?: MessagingToolSend;
          args?: Record<string, unknown>;
          result?: unknown;
          isError?: boolean;
        }) => {
          if (!isDeliveredMessagingToolResult(paramsLocal)) {
            return;
          }
          didSendViaMessagingTool = true;
          const toolArgs = paramsLocal.args ?? {};
          const isMessagingSend = isMessagingToolSendAction(paramsLocal.toolName, toolArgs);
          const content = isMessagingSend
            ? extractCliMessagingContent(toolArgs, paramsLocal.result)
            : {};
          if (isMessagingSend) {
            appendUniqueCliMessagingEvidence(
              messagingToolSentTexts,
              messagingToolSentTextKeys,
              content.text ? [content.text] : [],
            );
            appendUniqueCliMessagingEvidence(
              messagingToolSentMediaUrls,
              messagingToolSentMediaUrlKeys,
              content.mediaUrls ?? [],
            );
            if (
              isDeliveredMessageToolOnlySourceReplyResult({
                sourceReplyDeliveryMode: context.params.sourceReplyDeliveryMode,
                toolName: paramsLocal.toolName,
                args: paramsLocal.args,
                result: paramsLocal.result,
                isError: paramsLocal.isError,
              })
            ) {
              didDeliverSourceReplyViaMessageTool = true;
              const sourceReplyPayload = extractMessagingToolSourceReplyPayload(paramsLocal.result);
              if (sourceReplyPayload) {
                if (messagingToolSourceReplyPayloads.length >= CLI_MESSAGING_EVIDENCE_MAX_CALLS) {
                  messagingToolSourceReplyPayloads.shift();
                }
                // Each internal source-reply send is a distinct delivery, even when
                // two intentional sends have identical text or media.
                messagingToolSourceReplyPayloads.push(sourceReplyPayload);
              }
            }
          }
          if (paramsLocal.target) {
            const confirmedTarget = extractMessagingToolSendResult(
              paramsLocal.target,
              paramsLocal.result,
            );
            const targetWithContent = {
              ...confirmedTarget,
              ...content,
            };
            const evidenceKey = buildMessagingToolSendEvidenceKey(targetWithContent);
            if (messagingToolSentTargetKeys.has(evidenceKey)) {
              return;
            }
            if (messagingToolSentTargets.length >= CLI_MESSAGING_EVIDENCE_MAX_CALLS) {
              const removed = messagingToolSentTargets.shift();
              if (removed) {
                messagingToolSentTargetKeys.delete(buildMessagingToolSendEvidenceKey(removed));
              }
            }
            messagingToolSentTargets.push(targetWithContent);
            messagingToolSentTargetKeys.add(evidenceKey);
          }
        };
        const beginGatewayCapture = (captureKey: string | undefined) => {
          if (!captureKey) {
            return;
          }
          if (gatewayCaptureKey === captureKey) {
            return;
          }
          if (gatewayCaptureKey) {
            throw new Error("CLI MCP capture key changed during an active attempt");
          }
          context.preparedBackend.mcpClientGrantCapture?.activate(captureKey);
          gatewayCaptureKey = captureKey;
          const isAdmittedPotentialMessagingDelivery = (toolName: string) => {
            return isMessagingTool(normalizeCliMessagingToolName(toolName));
          };
          const isPreparedMessagingDelivery = (
            toolName: string,
            toolArgs: Record<string, unknown>,
          ) => {
            return (
              toolArgs.dryRun !== true &&
              isMessagingToolDeliveryAction(normalizeCliMessagingToolName(toolName), toolArgs)
            );
          };
          beginMcpLoopbackToolCallCapture({
            captureKey: gatewayCaptureKey,
            onYield: () => {
              yielded = true;
            },
            onRequestStart: () => {
              inFlightUnclassifiedMcpRequests += 1;
            },
            onRequestClassified: () => {
              inFlightUnclassifiedMcpRequests = Math.max(0, inFlightUnclassifiedMcpRequests - 1);
            },
            onToolCallStart: (call) => {
              const retained = retainCliLoopbackCall(call);
              const candidates = matchingActiveCliTools(call);
              // Parallel same-name calls can reach the loopback out of stream
              // order. Bind only a unique name+arguments match; ambiguity is
              // safer than assigning a trusted terminal outcome to the wrong call.
              let matched =
                retained &&
                candidates.length === 1 &&
                !candidates[0]?.[1].loopbackCall &&
                !candidates[0]?.[1].loopbackAmbiguous
                  ? candidates[0]
                  : undefined;
              if (retained && matched) {
                bindCliLoopbackCall(retained, matched[0], matched[1]);
              } else if (retained && candidates.length > 0) {
                markCliLoopbackSignatureAmbiguous(call);
                // The exact identity is unknowable, but pairing an unmatched
                // peer keeps the ambiguity group's lifetime count complete.
                matched = candidates.find(([, activeTool]) => !activeTool.loopbackCall);
                if (matched) {
                  bindCliLoopbackCall(retained, matched[0], matched[1]);
                }
              }
              if (isAdmittedPotentialMessagingDelivery(call.toolName)) {
                inFlightMessagingToolCalls += 1;
              }
              return matched?.[0];
            },
            onToolCallUpdate: ({ previous, current }) => {
              const candidates = cliLoopbackCalls.filter((candidate) =>
                matchesCliLoopbackCall(previous.toolName, previous.args, candidate.current),
              );
              const candidate = candidates.at(0);
              if (candidates.length === 1 && candidate && !candidate.ambiguous) {
                candidate.current = current;
              } else if (candidates.length > 0) {
                markCliLoopbackCallsAmbiguous(candidates);
              }
              inFlightPreparedMessagingCalls.delete(previous);
              const wasMessagingSend = isAdmittedPotentialMessagingDelivery(previous.toolName);
              const isMessagingSend = isPreparedMessagingDelivery(current.toolName, current.args);
              if (wasMessagingSend !== isMessagingSend) {
                inFlightMessagingToolCalls = Math.max(
                  0,
                  inFlightMessagingToolCalls + (isMessagingSend ? 1 : -1),
                );
              }
              if (isMessagingSend) {
                inFlightPreparedMessagingCalls.add(current);
              }
            },
            onToolCallFinish: (call, { prepared }) => {
              const isMessagingSend = prepared
                ? isPreparedMessagingDelivery(call.toolName, call.args)
                : isAdmittedPotentialMessagingDelivery(call.toolName);
              if (isMessagingSend) {
                inFlightMessagingToolCalls = Math.max(0, inFlightMessagingToolCalls - 1);
              }
              inFlightPreparedMessagingCalls.delete(call);
            },
            onToolCallResult: (call) => {
              const terminalOutcome: CliToolTerminalOutcome =
                call.outcome === "blocked"
                  ? { outcome: call.outcome, deniedReason: call.deniedReason }
                  : { outcome: call.outcome };
              const correlated = call.correlationId
                ? cliLoopbackCalls.find(
                    (candidate) => candidate.boundToolCallId === call.correlationId,
                  )
                : undefined;
              const candidates = correlated
                ? [correlated]
                : cliLoopbackCalls.filter((candidate) =>
                    matchesCliLoopbackCall(call.toolName, call.args, candidate.current),
                  );
              if (candidates.length === 1 && candidates[0]) {
                candidates[0].outcome = terminalOutcome;
              } else if (candidates.length > 1) {
                markCliLoopbackCallsAmbiguous(candidates);
              }
              const normalizedToolName = normalizeCliMessagingToolName(call.toolName);
              if (!isMessagingToolDeliveryAction(normalizedToolName, call.args)) {
                return;
              }
              commitMessagingToolResult({
                toolName: normalizedToolName,
                target: extractCliMessagingTarget(context, normalizedToolName, call.args),
                args: call.args,
                result: "result" in call ? call.result : undefined,
                isError: call.outcome !== "completed",
              });
            },
          });
        };
        beginGatewayCapture(initialGatewayCaptureKey);
        let observedCliActivity = false;
        const emitLiveEvents = params.executionMode !== "side-question";
        const activeParsedTools = new Map<
          string,
          { startedAt: number; toolName: string; kind: CliToolUseStartDelta["kind"] }
        >();
        const emitCliToolUseStart = (event: CliToolUseStartDelta) => {
          observedCliActivity = true;
          // Server-native calls have their own result stream and must never inherit MCP outcomes.
          if (event.kind !== "server_tool_use") {
            const activeTool = {
              toolName: event.name,
              args: event.args,
              loopbackAmbiguous: cliLoopbackCorrelationOverflowed && event.name.startsWith("mcp__"),
            };
            activeCliTools.set(event.toolCallId, activeTool);
            const admittedCall = {
              toolName: normalizeCliMessagingToolName(event.name),
              args: event.args,
            };
            const pendingCandidates = cliLoopbackCalls.filter(
              (candidate) =>
                candidate.boundToolCallId === undefined &&
                matchesCliLoopbackCall(event.name, event.args, candidate.admitted),
            );
            const hasAssociatedPeer = matchingActiveCliTools(admittedCall).some(
              ([toolCallId, peer]) =>
                toolCallId !== event.toolCallId &&
                (peer.loopbackCall !== undefined || peer.loopbackAmbiguous),
            );
            const pending = pendingCandidates[0];
            if (hasAssociatedPeer || pendingCandidates.length > 1 || pending?.ambiguous) {
              markCliLoopbackSignatureAmbiguous(admittedCall);
              if (pending) {
                bindCliLoopbackCall(pending, event.toolCallId, activeTool);
              }
            } else if (pendingCandidates.length === 1 && pending) {
              bindCliLoopbackCall(pending, event.toolCallId, activeTool);
            }
          }
          const toolName = normalizeCliMessagingToolName(event.name);
          if (
            event.kind !== "server_tool_use" &&
            !gatewayCaptureKey &&
            event.args.dryRun !== true &&
            isMessagingToolDeliveryAction(toolName, event.args)
          ) {
            if (pendingMessagingCalls.size >= CLI_MESSAGING_EVIDENCE_MAX_CALLS) {
              const oldestToolCallId = pendingMessagingCalls.keys().next().value;
              if (oldestToolCallId !== undefined) {
                pendingMessagingCalls.delete(oldestToolCallId);
                // Once an unresolved send is evicted, its later result cannot be
                // correlated. Fail closed so a failed turn cannot duplicate it.
                didSendViaMessagingTool = true;
              }
            }
            pendingMessagingCalls.set(event.toolCallId, {
              toolName,
              args: event.args,
              target: extractCliMessagingTarget(context, toolName, event.args),
            });
          }
          if (!emitLiveEvents) {
            return;
          }
          emitAgentEvent({
            runId: params.runId,
            stream: "tool",
            data: {
              phase: "start",
              name: event.name,
              toolCallId: event.toolCallId,
              args: sanitizeToolArgs(event.args),
            },
          });
        };
        const emitCliToolResult = (event: {
          toolCallId: string;
          name: string;
          isError: boolean;
          result?: unknown;
        }) => {
          observedCliActivity = true;
          const activeTool = activeCliTools.get(event.toolCallId);
          activeCliTools.delete(event.toolCallId);
          retireCliLoopbackCorrelation(event.toolCallId, activeTool);
          const pending = pendingMessagingCalls.get(event.toolCallId);
          if (pending) {
            pendingMessagingCalls.delete(event.toolCallId);
            commitMessagingToolResult({
              toolName: pending.toolName,
              target: pending.target,
              args: pending.args,
              result: event.result,
              isError: event.isError,
            });
          }
          if (!emitLiveEvents) {
            return;
          }
          emitAgentEvent({
            runId: params.runId,
            stream: "tool",
            data: {
              phase: "result",
              name: event.name,
              toolCallId: event.toolCallId,
              isError: event.isError,
              result: sanitizeToolResult(event.result),
            },
          });
        };
        const emitParsedToolUseStart = (event: CliToolUseStartDelta) => {
          const startedAt = Date.now();
          activeParsedTools.set(event.toolCallId, {
            startedAt,
            toolName: event.name,
            kind: event.kind,
          });
          emitTrustedDiagnosticEvent({
            type: "tool.execution.started",
            runId: params.runId,
            sessionId: params.sessionId,
            ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
            ...(params.agentId ? { agentId: params.agentId } : {}),
            toolName: event.name,
            toolSource: event.name.startsWith("mcp__") ? "mcp" : "core",
            toolOwner: "cli-runner",
            toolCallId: event.toolCallId,
          });
          emitCliToolUseStart(event);
        };
        const emitParsedToolTerminal = (event: {
          toolCallId: string;
          name: string;
          isError: boolean;
          incomplete?: boolean;
        }) => {
          const activeTool = activeParsedTools.get(event.toolCallId);
          activeParsedTools.delete(event.toolCallId);
          const trustedOutcome = resolveCliLoopbackTerminalOutcome(event.toolCallId);
          const toolName = activeTool?.toolName ?? event.name;
          const now = Date.now();
          const trustedTerminalReason =
            trustedOutcome &&
            trustedOutcome.outcome !== "blocked" &&
            trustedOutcome.outcome !== "completed" &&
            trustedOutcome.outcome !== "unknown"
              ? trustedOutcome.outcome
              : undefined;
          const terminalReason =
            trustedTerminalReason ??
            resolveCliToolTerminalReason({
              error: event.incomplete ? runError : undefined,
              abortSignal: params.abortSignal,
            });
          // Incomplete client/MCP tools inherit the enclosing failed run even when
          // the loopback disconnect is ambiguous. Server-native tools do not.
          const useEnclosingTerminalReason =
            event.incomplete &&
            runFailed &&
            activeTool !== undefined &&
            activeTool.kind !== "server_tool_use";
          const diagnosticBase = {
            runId: params.runId,
            sessionId: params.sessionId,
            ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
            ...(params.agentId ? { agentId: params.agentId } : {}),
            toolName,
            toolSource: toolName.startsWith("mcp__") ? ("mcp" as const) : ("core" as const),
            toolOwner: "cli-runner",
            toolCallId: event.toolCallId,
            durationMs: Math.max(0, now - (activeTool?.startedAt ?? now)),
          };
          if (trustedOutcome?.outcome === "unknown" && !useEnclosingTerminalReason) {
            emitTrustedDiagnosticEvent({
              type: "tool.execution.error",
              ...diagnosticBase,
              errorCategory: "cli_tool_ambiguous",
              errorCode: "tool_outcome_unknown",
            });
            return;
          }
          if (
            event.incomplete &&
            activeTool?.kind === "server_tool_use" &&
            trustedOutcome === undefined
          ) {
            emitTrustedDiagnosticEvent({
              type: "tool.execution.error",
              ...diagnosticBase,
              errorCategory: "cli_tool_ambiguous",
              errorCode: "tool_outcome_unknown",
            });
            return;
          }
          const trustedFailure =
            trustedOutcome !== undefined && trustedOutcome.outcome !== "completed";
          emitTrustedDiagnosticEvent(
            trustedOutcome?.outcome === "blocked"
              ? {
                  type: "tool.execution.blocked",
                  ...diagnosticBase,
                  deniedReason: trustedOutcome.deniedReason,
                  reason: "blocked by before-tool policy",
                }
              : trustedFailure || (trustedOutcome === undefined && event.isError)
                ? {
                    type: "tool.execution.error",
                    ...diagnosticBase,
                    errorCategory:
                      terminalReason === "cancelled"
                        ? "aborted"
                        : event.incomplete && (!trustedOutcome || useEnclosingTerminalReason)
                          ? "cli_tool_incomplete"
                          : "cli_tool",
                    terminalReason,
                  }
                : {
                    type: "tool.execution.completed",
                    ...diagnosticBase,
                  },
          );
        };
        const emitParsedToolResult = (event: {
          toolCallId: string;
          name: string;
          isError: boolean;
          result?: unknown;
        }) => {
          emitParsedToolTerminal(event);
          emitCliToolResult(event);
        };
        finalizeParsedTools = () => {
          for (const [toolCallId, activeTool] of Array.from(activeParsedTools)) {
            emitParsedToolTerminal({
              toolCallId,
              name: activeTool.toolName,
              isError: true,
              incomplete: true,
            });
          }
        };
        let commentaryCounter = 0;
        const emitCliCommentaryText = (text: string) => {
          if (!emitLiveEvents) {
            return;
          }
          commentaryCounter += 1;
          const transformedText = applyPluginTextReplacements(
            text,
            context.backendResolved.textTransforms?.output,
          );
          emitAgentEvent({
            runId: params.runId,
            stream: "item",
            data: {
              kind: "preamble",
              itemId: `commentary-${params.runId}-${commentaryCounter}`,
              phase: "update",
              title: "commentary",
              status: "running",
              progressText: transformedText,
            },
          });
        };
        const emitCliAssistantDelta = ({ text, delta }: CliStreamingDelta) => {
          if (text || delta) {
            observedCliActivity = true;
          }
          if (!emitLiveEvents) {
            return;
          }
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
        };
        // Emit-always: thinking reaches the agent-event bus and session archive
        // like the embedded reasoning stream; /reasoning and /verbose gate only
        // presentation. Text stays raw here to match the thinking-stream contract
        // shared with embedded-agent-subscribe, which archives untransformed
        // reasoning regardless of source.
        const emitCliThinkingDelta = ({ text, delta, isReasoningSnapshot }: CliThinkingDelta) => {
          if (text || delta) {
            observedCliActivity = true;
          }
          if (!emitLiveEvents) {
            return;
          }
          emitAgentEvent({
            runId: params.runId,
            stream: "thinking",
            data: { text, delta, ...(isReasoningSnapshot ? { isReasoningSnapshot } : {}) },
          });
        };
        const emitCliThinkingProgress = ({ progressTokens }: CliThinkingProgress) => {
          observedCliActivity = true;
          if (!emitLiveEvents) {
            return;
          }
          emitAgentEvent({
            runId: params.runId,
            stream: "thinking",
            data: { progressTokens },
          });
        };
        if (useManagedClaudeLiveSession) {
          if (!hasJsonlOutput) {
            throw new Error("Claude live session requires JSONL streaming parser");
          }
          params.onExecutionPhase?.({
            phase: "process_spawned",
            provider: params.provider,
            model: context.modelId,
            backend: context.backendResolved.id,
          });
          fallbackClaudeSkillsPluginCleanupOwned = fallbackClaudeSkillsPlugin !== undefined;
          const liveResult = await runClaudeLiveSessionTurn({
            context,
            args: executionArgs,
            executableCommand: executionCommand,
            executableLeadingArgv: executionLeadingArgv,
            env,
            prompt,
            useResume,
            forceNewSession:
              cliSessionIdToUse === undefined && context.openClawHistoryPrompt !== undefined,
            requiredSessionGeneration: cliSessionIdToUse
              ? context.requiredClaudeLiveSessionGeneration
              : undefined,
            noOutputTimeoutMs,
            getProcessSupervisor: executeDeps.getProcessSupervisor,
            onAssistantDelta: emitCliAssistantDelta,
            onThinkingDelta: emitCliThinkingDelta,
            onThinkingProgress: emitCliThinkingProgress,
            onToolUseStart: emitCliToolUseStart,
            onToolResult: emitCliToolResult,
            resolveToolResultTerminalOutcome: (event) => {
              const outcome = resolveCliLoopbackTerminalOutcome(event.toolCallId);
              return outcome?.outcome === "completed" ? undefined : outcome;
            },
            onCommentaryText:
              emitLiveEvents && context.params.emitCommentaryText
                ? emitCliCommentaryText
                : undefined,
            onMcpCaptureReady: beginGatewayCapture,
            cleanup: async () => {
              await fallbackClaudeSkillsPlugin?.cleanup();
            },
            onSessionId: (sessionId) => {
              observeForkSuccessor(sessionId);
            },
          });
          const rawText = liveResult.output.text;
          runOutput = {
            ...liveResult.output,
            rawText,
            finalPromptText: prompt,
            text: applyPluginTextReplacements(
              rawText,
              context.backendResolved.textTransforms?.output,
            ),
          };
        } else {
          const streamingParser = hasJsonlOutput
            ? createCliJsonlStreamingParser({
                backend,
                providerId: context.backendResolved.id,
                onAssistantDelta: emitCliAssistantDelta,
                onThinkingDelta: emitCliThinkingDelta,
                onThinkingProgress: emitCliThinkingProgress,
                onToolUseStart: emitParsedToolUseStart,
                onToolResult: emitParsedToolResult,
                onCommentaryText:
                  emitLiveEvents && context.params.emitCommentaryText
                    ? emitCliCommentaryText
                    : undefined,
                onSessionId: (sessionId) => {
                  observeForkSuccessor(sessionId);
                },
              })
            : null;
          let stdoutTail: Buffer = Buffer.alloc(0);
          let stdoutParseBuffer: Buffer = Buffer.alloc(0);
          let stdoutBytes = 0;
          const stdoutHash = crypto.createHash("sha256");
          let stdoutParseExceeded = false;
          let stderrTail: Buffer = Buffer.alloc(0);
          let stderrParseBuffer: Buffer = Buffer.alloc(0);
          let stderrBytes = 0;
          const stderrHash = crypto.createHash("sha256");
          let stderrParseExceeded = false;
          const consumeStdout = (chunk: string) => {
            stdoutBytes += Buffer.byteLength(chunk);
            stdoutHash.update(chunk);
            stdoutTail = appendCliOutputTail(stdoutTail, chunk);
            if (!stdoutParseExceeded) {
              const nextStdoutParse = appendCliOutputParseBuffer(stdoutParseBuffer, chunk);
              stdoutParseBuffer = nextStdoutParse.buffer;
              stdoutParseExceeded = nextStdoutParse.exceeded;
            }
            streamingParser?.push(chunk);
          };
          const consumeStderr = (chunk: string) => {
            stderrBytes += Buffer.byteLength(chunk);
            stderrHash.update(chunk);
            stderrTail = appendCliOutputTail(stderrTail, chunk);
            if (!stderrParseExceeded) {
              const nextStderrParse = appendCliOutputParseBuffer(stderrParseBuffer, chunk);
              stderrParseBuffer = nextStderrParse.buffer;
              stderrParseExceeded = nextStderrParse.exceeded;
            }
          };

          params.onExecutionPhase?.({
            phase: "process_spawned",
            provider: params.provider,
            model: context.modelId,
            backend: context.backendResolved.id,
          });
          let managedRunPid: number | undefined;
          let nodeRunAbortSignal: AbortSignal | undefined;
          let nodeRunTruncated = false;
          let result: RunExit;
          if (nodePlacement) {
            const nodeRun = await executeNodeClaudeRun({
              context,
              nodePlacement,
              executionArgs,
              stdinPayload,
              ...(nodeSystemPrompt !== undefined ? { nodeSystemPrompt } : {}),
              noOutputTimeoutMs,
              consumeStdout,
              consumeStderr,
              deps: executeDeps,
            });
            result = nodeRun.result;
            nodeRunAbortSignal = nodeRun.nodeRunAbortSignal;
            nodeRunTruncated = nodeRun.nodeRunTruncated;
          } else {
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
              argv: [executionCommand, ...executionLeadingArgv, ...executionArgs],
              timeoutMs: params.timeoutMs,
              noOutputTimeoutMs,
              cwd: context.cwd ?? context.workspaceDir,
              env,
              input: stdinPayload,
              captureOutput: false,
              onStdout: consumeStdout,
              onStderr: consumeStderr,
            });
            managedRunPid = managedRun.pid;
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
            try {
              result = await managedRun.wait();
            } finally {
              replyBackendCompleted = true;
              if (replyBackendHandle) {
                params.replyOperation?.detachBackend(replyBackendHandle);
              }
              params.abortSignal?.removeEventListener("abort", abortManagedRun);
            }
          }
          streamingParser?.finish();
          if (
            (params.abortSignal?.aborted || nodeRunAbortSignal?.aborted) &&
            result.reason === "manual-cancel"
          ) {
            throw createCliAbortError();
          }
          const streamingParserErrorText =
            outputMode === "jsonl" ? (streamingParser?.getErrorText() ?? null) : null;
          if (streamingParserErrorText) {
            throw new FailoverError(streamingParserErrorText, {
              reason: "format",
              provider: params.provider,
              model: context.modelId,
              sessionId: params.sessionId,
              lane: params.lane,
              status: resolveFailoverStatus("format"),
            });
          }
          // The node re-injects the terminal result line when its output cap
          // truncates the stream; if even that is missing, the turn outcome is
          // unknowable and must not pass as a clean exit.
          if (
            nodeRunTruncated &&
            result.exitCode === 0 &&
            !result.timedOut &&
            !streamingParser?.getOutput()
          ) {
            throw new FailoverError(
              "paired node truncated the Claude CLI stream before the terminal result; refusing to accept partial output.",
              {
                reason: "format",
                provider: params.provider,
                model: context.modelId,
                sessionId: params.sessionId,
                lane: params.lane,
                status: resolveFailoverStatus("format"),
              },
            );
          }

          const stdout = stdoutParseBuffer.toString("utf8").trim();
          const stdoutDiagnostic = stdoutTail.toString("utf8").trim();
          const stderr = stderrParseBuffer.toString("utf8").trim();
          const stderrDiagnostic = stderrTail.toString("utf8").trim();
          const processDiagnostics = {
            backendId: context.backendResolved.id,
            processReason: result.reason,
            exitCode: result.exitCode,
            exitSignal: result.exitSignal,
            durationMs: result.durationMs,
            stdoutBytes,
            stdoutHash: stdoutHash.digest("hex").slice(0, 12),
            stderrBytes,
            stderrHash: stderrHash.digest("hex").slice(0, 12),
            useResume,
          };
          if (logOutputText) {
            if (stdoutDiagnostic) {
              cliBackendLog.info(`cli stdout:\n${stdoutDiagnostic}`);
            }
            if (stderrDiagnostic) {
              cliBackendLog.info(`cli stderr:\n${stderrDiagnostic}`);
            }
          }
          if (shouldLogVerbose()) {
            if (stdoutDiagnostic) {
              cliBackendLog.debug(`cli stdout:\n${stdoutDiagnostic}`);
            }
            if (stderrDiagnostic) {
              cliBackendLog.debug(`cli stderr:\n${stderrDiagnostic}`);
            }
          }

          const streamedJsonlOutput =
            outputMode === "jsonl" ? (streamingParser?.getOutput() ?? null) : null;
          const parsedStructuredOutput =
            streamedJsonlOutput ??
            (outputMode === "json" && !stdoutParseExceeded
              ? parseCliOutput({
                  raw: stdout,
                  backend,
                  providerId: context.backendResolved.id,
                  outputMode,
                  fallbackSessionId: resolvedSessionId,
                })
              : null);
          // A completed terminal record is authoritative even if the CLI hangs
          // afterward. Reclassifying it as a timeout could replay completed tools.
          if (parsedStructuredOutput?.terminalFailure) {
            const terminalError = createCliOutputFailoverError({
              output: parsedStructuredOutput,
              provider: params.provider,
              model: context.modelId,
              runId: params.runId,
              sessionId: params.sessionId,
              lane: params.lane,
            });
            if (terminalError) {
              throw terminalError;
            }
          }

          if (result.exitCode !== 0 || result.reason !== "exit") {
            if (result.reason === "no-output-timeout" || result.noOutputTimedOut) {
              const timeoutReason = `CLI produced no output for ${Math.round(noOutputTimeoutMs / 1000)}s and was terminated.`;
              cliBackendLog.warn(
                `cli watchdog timeout: provider=${params.provider} model=${context.modelId} session=${resolvedSessionId ?? params.sessionId} noOutputTimeoutMs=${noOutputTimeoutMs} pid=${managedRunPid ?? "node"}`,
              );
              const retryableNoOutputTimeout =
                !observedCliActivity &&
                stdoutDiagnostic.length === 0 &&
                stderrDiagnostic.length === 0;
              const deferWatchdogNoticeForFreshRetry =
                retryableNoOutputTimeout &&
                Boolean(cliSessionIdToUse) &&
                Boolean(resolvedSessionId) &&
                Boolean(context.openClawHistoryPrompt) &&
                Boolean(params.sessionKey) &&
                params.timeoutMs - (Date.now() - context.started) > 0;
              if (params.sessionKey && emitLiveEvents && !deferWatchdogNoticeForFreshRetry) {
                const stallNotice = [
                  `CLI agent (${params.provider}) produced no output for ${Math.round(noOutputTimeoutMs / 1000)}s and was terminated.`,
                  "It may have been waiting for interactive input or an approval prompt.",
                  // Node runs strip --permission-mode, so the local-flag hint
                  // would be unfollowable advice there.
                  ...(nodePlacement
                    ? ["Check the node's Claude permission settings for pending prompts."]
                    : ["For Claude Code, prefer --permission-mode bypassPermissions --print."]),
                ].join(" ");
                const eventRouting = resolveEventSessionRoutingPolicy({
                  cfg: params.config,
                  sessionKey: params.sessionKey,
                  channel: params.messageProvider,
                  accountId: params.agentAccountId,
                });
                executeDeps.enqueueSystemEvent(stallNotice, {
                  sessionKey: resolveEventSessionKeyForPolicy(params.sessionKey, eventRouting),
                });
                executeDeps.requestHeartbeat(
                  scopedHeartbeatWakeOptionsForPolicy(
                    params.sessionKey,
                    {
                      source: "cli-watchdog",
                      intent: "event",
                      reason: "cli:watchdog:stall",
                    },
                    eventRouting,
                  ),
                );
              }
              throw new FailoverError(timeoutReason, {
                reason: "timeout",
                provider: params.provider,
                model: context.modelId,
                sessionId: params.sessionId,
                lane: params.lane,
                status: resolveFailoverStatus("timeout"),
                code: retryableNoOutputTimeout ? "cli_no_output_timeout" : undefined,
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
                code: "cli_overall_timeout",
              });
            }
            const errorCandidates = [stderr, stdout, stderrDiagnostic, stdoutDiagnostic].filter(
              (candidate) => candidate.length > 0,
            );
            const structuredError =
              errorCandidates.map((candidate) => extractCliErrorMessage(candidate)).find(Boolean) ??
              null;
            let classifiedErrorText = structuredError;
            let reason = structuredError
              ? classifyFailoverReason(structuredError, { provider: params.provider })
              : null;
            if (!reason) {
              for (const candidate of errorCandidates) {
                reason = classifyFailoverReason(candidate, { provider: params.provider });
                if (reason) {
                  classifiedErrorText = candidate;
                  break;
                }
              }
            }
            const err =
              structuredError || classifiedErrorText || errorCandidates[0] || "CLI failed.";
            reason = reason ?? "unknown";
            const status = resolveFailoverStatus(reason);
            const retryCode =
              reason === "context_overflow"
                ? "cli_context_overflow"
                : reason === "unknown" &&
                    result.reason === "exit" &&
                    errorCandidates.length === 0 &&
                    !observedCliActivity
                  ? "cli_unknown_empty_failure"
                  : undefined;
            throw new FailoverError(err, {
              reason,
              provider: params.provider,
              model: context.modelId,
              sessionId: params.sessionId,
              lane: params.lane,
              status,
              code: retryCode,
            });
          }

          if (stdoutParseExceeded && !streamedJsonlOutput) {
            throw new FailoverError(
              `CLI stdout exceeded ${CLI_RUNNER_OUTPUT_PARSE_BYTES} bytes; refusing to parse truncated output.`,
              {
                reason: "format",
                provider: params.provider,
                model: context.modelId,
                sessionId: params.sessionId,
                lane: params.lane,
                status: resolveFailoverStatus("format"),
              },
            );
          }

          const parsed =
            parsedStructuredOutput ??
            parseCliOutput({
              raw: stdout,
              backend,
              providerId: context.backendResolved.id,
              outputMode,
              fallbackSessionId: resolvedSessionId,
            });
          const parsedError = createCliOutputFailoverError({
            output: parsed,
            provider: params.provider,
            model: context.modelId,
            runId: params.runId,
            sessionId: params.sessionId,
            lane: params.lane,
          });
          if (parsedError) {
            throw parsedError;
          }
          const rawText = parsed.text;
          cliBackendLog.info(
            `cli turn: provider=${params.provider} model=${context.modelId} durationMs=${Date.now() - cliTurnStartedAt} ${formatCliBackendOutputDigest(rawText)}`,
          );
          runOutput = {
            ...parsed,
            diagnostics: {
              ...parsed.diagnostics,
              process: processDiagnostics,
            },
            rawText,
            finalPromptText: prompt,
            text: applyPluginTextReplacements(
              rawText,
              context.backendResolved.textTransforms?.output,
            ),
          };
        }
      } catch (error) {
        recordRunError(error);
      } finally {
        try {
          if (!gatewayCaptureKey && pendingMessagingCalls.size > 0) {
            const unresolvedJsonlMessagingCalls = Array.from(pendingMessagingCalls.values());
            const internalSourceReplyStates = await Promise.all(
              unresolvedJsonlMessagingCalls.map(isPreparedInternalSourceReply),
            );
            const hasPotentialVisibleSend = internalSourceReplyStates.some(
              (isInternalSourceReply) => !isInternalSourceReply,
            );
            if (hasPotentialVisibleSend) {
              // A JSONL start without a result may have delivered before the CLI exited.
              // Fail closed so retry/failover cannot duplicate a late visible send.
              didSendViaMessagingTool = true;
              recordRunError(
                new Error("CLI JSONL message tool call remained unresolved after exit"),
              );
            } else {
              recordRunError(
                new Error("CLI JSONL source reply call remained unresolved after exit"),
              );
            }
          }
          if (gatewayCaptureKey) {
            const captureBecameIdle = await waitForMcpLoopbackToolCallCaptureIdle(
              gatewayCaptureKey,
              {
                timeoutMs: CLI_MCP_DELIVERY_DRAIN_GRACE_MS,
                admissionGraceMs: CLI_MCP_REQUEST_ADMISSION_GRACE_MS,
              },
            );
            if (!captureBecameIdle) {
              if (useManagedClaudeLiveSession) {
                await rotateClaudeLiveMcpCaptureKeyForContext(context);
              }
              const unresolvedPreparedMessagingCalls = Array.from(inFlightPreparedMessagingCalls);
              const internalSourceReplyStates = await Promise.all(
                unresolvedPreparedMessagingCalls.map(isPreparedInternalSourceReply),
              );
              const internalSourceReplyCount = internalSourceReplyStates.filter(Boolean).length;
              const hasPotentialVisibleSend = inFlightMessagingToolCalls > internalSourceReplyCount;
              if (inFlightUnclassifiedMcpRequests > 0 || hasPotentialVisibleSend) {
                // An admitted request or send may complete after its CLI process exits.
                // Fail closed so retry/failover cannot duplicate a late visible send.
                didSendViaMessagingTool = true;
                recordRunError(new Error("CLI message tool call remained in flight after exit"));
              } else if (inFlightMessagingToolCalls > 0) {
                // Internal source replies are only result payloads; they have no external
                // side effect, so keep the failed turn retryable instead of dropping them.
                recordRunError(new Error("CLI source reply call remained in flight after exit"));
              }
            }
          }
        } catch (error) {
          if (
            pendingMessagingCalls.size > 0 ||
            inFlightUnclassifiedMcpRequests > 0 ||
            inFlightMessagingToolCalls > 0
          ) {
            // A failed drain/classification cannot prove an admitted messaging request harmless.
            didSendViaMessagingTool = true;
          }
          recordRunError(error);
        } finally {
          // Captured MCP calls may settle after the CLI process exits. Drain
          // first so finalization can use their trusted terminal outcomes.
          try {
            finalizeParsedTools();
          } finally {
            if (gatewayCaptureKey) {
              // Drain accepted work, then fence this exact grant generation before
              // clearing observers; otherwise a late request escapes accounting.
              try {
                context.preparedBackend.mcpClientGrantCapture?.deactivate(gatewayCaptureKey);
              } finally {
                clearMcpLoopbackToolCallCapture(gatewayCaptureKey);
              }
            }
          }
        }
        try {
          await cleanupMcpCaptureAttempt?.();
        } catch (error) {
          recordRunError(error);
        }
        try {
          restoreSkillEnv?.();
        } catch (error) {
          recordRunError(error);
        }
      }
      if (runFailed) {
        throw attachCliMessagingDeliveryEvidence(runError, {
          didSendViaMessagingTool,
          didDeliverSourceReplyViaMessageTool,
          messagingToolSentTexts,
          messagingToolSentMediaUrls,
          messagingToolSentTargets,
          messagingToolSourceReplyPayloads,
        });
      }
      if (!runOutput) {
        throw new Error("CLI run completed without output");
      }
      return withExecutionEvidence(runOutput);
    });
    if (completedOutput.sessionId) {
      observeForkSuccessor(completedOutput.sessionId);
    }
    await finishForkSuccessorPersistence();
    if (forkResumeClaimed && !forkSuccessorObserved) {
      await params.restoreCliSessionFork?.();
      forkResumeClaimed = false;
      throw new Error("forked CLI session did not report a successor session id");
    }
    return completedOutput;
  } catch (error) {
    executionError = error;
    let failure = error;
    try {
      await finishForkSuccessorPersistence();
    } catch (persistenceError) {
      failure = new AggregateError(
        [error, persistenceError],
        "CLI turn failed and its fork successor could not be persisted",
      );
    }
    if (forkResumeClaimed && !forkSuccessorObserved) {
      await params.restoreCliSessionFork?.();
    }
    throw failure;
  } finally {
    if (!fallbackClaudeSkillsPluginCleanupOwned) {
      await cleanupOuterResource(fallbackClaudeSkillsPlugin?.cleanup);
    }
    if (systemPromptFile) {
      await cleanupOuterResource(systemPromptFile.cleanup);
    }
    if (cleanupImages) {
      await cleanupOuterResource(cleanupImages);
    }
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

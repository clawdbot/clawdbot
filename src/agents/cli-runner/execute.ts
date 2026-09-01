/** Executes prepared CLI backend runs and owns their queue and resource lifecycle. */
import crypto from "node:crypto";
import { parse as parseSemver } from "semver";
import { assertAgentRunLifecycleGenerationCurrent } from "../../infra/agent-events.js";
import { isTruthyEnvValue } from "../../infra/env.js";
import { formatErrorMessage, toErrorObject } from "../../infra/errors.js";
import { sanitizeHostExecEnv } from "../../infra/host-env-security.js";
import {
  getInstallationTarget,
  installationTargetEnv,
  LOCAL_INSTALLATION_TARGET_UNSUPPORTED,
} from "../../infra/installation-target-context.js";
import { compareValidSemver } from "../../infra/semver.js";
import { getAgentScopedMediaLocalRoots } from "../../media/local-roots.js";
import type { CliBackendThinkingLevel } from "../../plugins/cli-backend.types.js";
import { applySkillEnvOverridesFromSnapshot } from "../../skills/runtime/env-overrides.js";
import {
  fingerprintCliRuntimeArtifact,
  resolveCliRuntimeOwnerFingerprint,
} from "../cli-auth-epoch.js";
import { resolveCliExecutableIdentity } from "../cli-executable-identity.js";
import { hashCliImageTurnEntryId } from "../cli-image-turn-correlation.js";
import type { CliOutput } from "../cli-output-contracts.js";
import {
  detectImageReferences,
  hasHydratableMediaImages,
} from "../embedded-agent-runner/run/images.js";
import type { MediaImageLayout } from "../embedded-agent-runner/run/prompt-image-metadata.js";
import { applyPluginTextReplacements } from "../plugin-text-transforms.js";
import { prepareCliBundleMcpCaptureAttempt } from "./bundle-mcp.js";
import {
  acceptsCliLiveSession,
  buildCliLiveOwnerKey,
  closeCliLiveSession,
} from "./cli-live-session-registry.js";
import { executeDeps } from "./execute-deps.js";
import { createCliEventHandlers } from "./execute-events.js";
import {
  buildCliExecLogLine,
  CLAUDE_SELECTED_AUTH_ENV_KEYS,
  CLI_BACKEND_PRESERVE_ENV,
  logCliInvocation,
  NODE_CLAUDE_FORWARD_ENV_KEYS,
  parseCliBackendPreserveEnv,
  resolveNodeClaudeAuthEnv,
} from "./execute-logging.js";
import { createCliAbortError, stripGatewayLocalClaudeArgs } from "./execute-node-claude.js";
import { executeCliProcess } from "./execute-process.js";
import { createCliToolTracking } from "./execute-tool-tracking.js";
import {
  buildCliArgs,
  enqueueCliRun,
  isClaudeCliBackendId,
  prepareCliPromptImagePayload,
  resolveCliNoOutputTimeoutMs,
  resolveCliRunQueueKey,
  resolveCliRunTimeoutOverrideMs,
  resolvePromptInput,
  resolveSessionIdToSend,
  resolveSystemPromptUsage,
} from "./helpers.js";
import {
  cliBackendLog,
  CLI_BACKEND_LOG_OUTPUT_ENV,
  LEGACY_CLAUDE_CLI_LOG_OUTPUT_ENV,
} from "./log.js";
import { createClaudeCliModelCallDiagnostics } from "./model-call-diagnostics.js";
import { composeCliPromptContext } from "./prompt-context.js";
import type { PreparedCliRunContext } from "./types.js";

function normalizeCliBackendThinkingLevel(
  level: PreparedCliRunContext["params"]["thinkLevel"],
): CliBackendThinkingLevel | undefined {
  return level === "ultra" ? "max" : level;
}

function exactToolAvailabilityError(params: {
  code: "unsupported" | "runtime-unavailable";
  isolatedCompletion: boolean;
  message: string;
}): Error {
  if (!params.isolatedCompletion) {
    return new Error(params.message);
  }
  const error = new Error(params.message) as Error & { code: typeof params.code };
  error.name = "IsolatedCompletionRuntimeError";
  error.code = params.code;
  return error;
}

function assertExactToolAvailabilityRuntimeVersion(params: {
  backendId: string;
  policy: NonNullable<
    PreparedCliRunContext["backendResolved"]["runtimeArtifact"]
  >["exactToolAvailabilityVersionPolicy"];
  executableIdentity: Awaited<ReturnType<typeof resolveCliExecutableIdentity>>;
  isolatedCompletion: boolean;
}): void {
  const artifact = params.executableIdentity?.runtimeArtifact;
  const packageVersion = artifact?.kind === "package-tree" ? artifact.packageVersion : undefined;
  const parsedVersion = packageVersion ? parseSemver(packageVersion) : null;
  const prereleaseChannel = parsedVersion?.prerelease[0];
  const minimumVersion =
    parsedVersion?.prerelease.length === 0
      ? params.policy?.stableMinimum
      : typeof prereleaseChannel === "string"
        ? params.policy?.prereleaseMinimums?.[prereleaseChannel]
        : undefined;
  const comparison =
    packageVersion && minimumVersion ? compareValidSemver(packageVersion, minimumVersion) : null;
  if (comparison !== null && comparison >= 0) {
    return;
  }
  throw exactToolAvailabilityError({
    code: "unsupported",
    isolatedCompletion: params.isolatedCompletion,
    message: `CLI backend ${params.backendId} requires a supported package version for exact per-run tool availability${minimumVersion ? ` (requires >=${minimumVersion}` : " (unsupported release line"}${packageVersion ? `; found ${packageVersion})` : ")"}`,
  });
}

type ExecutePreparedCliRunOptions = {
  onPhase?: (phase: "send" | "resolve" | "cleanup") => void;
};

type PreparedCliRunInternalParams = PreparedCliRunContext["params"] & {
  mediaImageLayout?: MediaImageLayout;
};

/** Executes a prepared CLI run context and returns normalized CLI output. */
export async function executePreparedCliRun(
  context: PreparedCliRunContext,
  cliSessionIdToUse?: string,
  options?: ExecutePreparedCliRunOptions,
): Promise<CliOutput> {
  const params = context.params as PreparedCliRunInternalParams;
  if (params.abortSignal?.aborted) {
    throw createCliAbortError();
  }
  const backend = context.preparedBackend.backend;
  const executionTarget = context.executionTarget;
  const localProcessEnv = installationTargetEnv(getInstallationTarget());
  if (localProcessEnv && executionTarget.kind === "node") {
    throw new Error(LOCAL_INSTALLATION_TARGET_UNSUPPORTED);
  }
  const nodePlacement = executionTarget.kind === "node" ? executionTarget.placement : null;
  const usePluginOwnedExecution = executionTarget.kind === "plugin";
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
  const shouldSendSystemPrompt =
    systemPromptArg &&
    (!useResume || backend.systemPromptWhen === "always" || resendSystemPromptForSoftResume);
  const systemPromptFile =
    !nodePlacement && !usePluginOwnedExecution && shouldSendSystemPrompt
      ? await executeDeps.writeCliSystemPromptFile({ backend, systemPrompt: systemPromptArg })
      : undefined;
  const nodeSystemPrompt = nodePlacement && shouldSendSystemPrompt ? systemPromptArg : undefined;

  const basePrompt = cliSessionIdToUse
    ? params.prompt
    : (context.openClawHistoryPrompt ?? params.prompt);
  let prompt =
    params.controlOperation !== undefined
      ? basePrompt
      : applyPluginTextReplacements(basePrompt, context.backendResolved.textTransforms?.input);
  const promptContext = context.promptContext
    ? {
        ...(context.promptContext.prependContext
          ? {
              prependContext: applyPluginTextReplacements(
                context.promptContext.prependContext,
                context.backendResolved.textTransforms?.input,
              ),
            }
          : {}),
        ...(context.promptContext.appendContext
          ? {
              appendContext: applyPluginTextReplacements(
                context.promptContext.appendContext,
                context.backendResolved.textTransforms?.input,
              ),
            }
          : {}),
      }
    : undefined;
  if (
    nodePlacement &&
    ((params.images?.length ?? 0) > 0 ||
      (params.mediaImageLayout
        ? params.mediaImageLayout.slots.length > 0
        : hasHydratableMediaImages(params.media)) ||
      (params.imagePrompt ? detectImageReferences(params.imagePrompt).length > 0 : false))
  ) {
    throw new Error("paired-node Claude CLI sessions do not support attachments or images");
  }
  const imageTurnEntryId = isClaudeCliBackendId(context.backendResolved.id)
    ? params.userTurnTranscriptRecorder?.getAdmissionReceipt()?.entryId
    : undefined;
  const imagePayload = nodePlacement
    ? { prompt, imagePaths: [] as string[], cleanupImages: async () => {} }
    : await prepareCliPromptImagePayload({
        backend,
        prompt,
        imagePrompt: params.imagePrompt,
        workspaceDir: context.workspaceDir,
        localRoots: getAgentScopedMediaLocalRoots(params.config ?? {}, params.agentId),
        images: params.images,
        imageOrder: params.imageOrder,
        mediaImageLayout: params.mediaImageLayout,
        media: params.media,
        ...(imageTurnEntryId ? { imageTurnKey: hashCliImageTurnEntryId(imageTurnEntryId) } : {}),
      });
  prompt = imagePayload.prompt;
  const promptInputBackend =
    params.controlOperation === "compact" && context.backendResolved.manualCompaction
      ? { ...backend, input: context.backendResolved.manualCompaction.input }
      : backend;
  const { argsPrompt, stdin } = resolvePromptInput({ backend: promptInputBackend, prompt });
  const baseArgs = useResume ? (backend.resumeArgs ?? backend.args ?? []) : (backend.args ?? []);
  const resolvedArgs = useResume
    ? baseArgs.map((entry) => entry.replaceAll("{sessionId}", resolvedSessionId ?? ""))
    : baseArgs;
  const baseArgsWithSkills =
    !nodePlacement && context.claudeSkillsPluginArgs.length > 0
      ? [...resolvedArgs, ...context.claudeSkillsPluginArgs]
      : resolvedArgs;
  const resolvedExecutionArgs = context.backendResolved.resolveExecutionArgs?.({
    config: params.config,
    workspaceDir: context.workspaceDir,
    provider: params.provider,
    modelId: context.modelId,
    authProfileId: context.effectiveAuthProfileId,
    thinkingLevel: normalizeCliBackendThinkingLevel(params.thinkLevel),
    executionMode: params.executionMode ?? "agent",
    // Node runs project the native subset only: gateway-loopback MCP tools do
    // not exist on the node, and auto-approval must not cross that boundary.
    toolAvailability:
      params.cliToolAvailability && nodePlacement
        ? { native: params.cliToolAvailability.native, openClaw: [] }
        : params.cliToolAvailability,
    useResume,
    baseArgs: baseArgsWithSkills,
  });
  if (
    params.cliToolAvailability &&
    context.backendResolved.toolAvailabilityEnforcement === "execution-args" &&
    !resolvedExecutionArgs
  ) {
    throw new Error(
      `CLI backend ${context.backendResolved.id} did not enforce exact per-run tool availability`,
    );
  }
  const executionBaseArgs = nodePlacement
    ? stripGatewayLocalClaudeArgs(resolvedExecutionArgs ?? baseArgsWithSkills)
    : (resolvedExecutionArgs ?? baseArgsWithSkills);
  const args = buildCliArgs({
    backend: nodePlacement
      ? { ...backend, systemPromptArg: undefined, systemPromptFileArg: undefined }
      : backend,
    baseArgs: Array.from(executionBaseArgs),
    modelId: context.normalizedModel,
    sessionId: resolvedSessionId,
    systemPrompt: nodePlacement || usePluginOwnedExecution ? undefined : systemPromptArg,
    systemPromptFilePath: systemPromptFile?.filePath,
    imagePaths: imagePayload.imagePaths,
    promptArg: argsPrompt,
    useResume,
    forkResume: params.forkCliSessionOnResume,
    resumeAt: params.cliSessionResumeAt,
    sendSystemPromptOnResume: resendSystemPromptForSoftResume,
  });

  const cliLiveOwnerKey = buildCliLiveOwnerKey({
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
    ownerKey: cliLiveOwnerKey,
  });
  // Plugin-owned transports own their child/session lifecycle; their MCP grant
  // still needs the per-turn capture key used by other non-live executions.
  const useManagedClaudeLiveSession =
    usePluginOwnedExecution && acceptsCliLiveSession(context) && !params.onSuccessfulAuthBinding;
  // Fresh-session retries invoke this function again. Keep one helper per
  // observable CLI attempt so every started call retains its own terminal event.
  const diagnostics = createClaudeCliModelCallDiagnostics({
    context,
    prompt: composeCliPromptContext(prompt, promptContext),
    systemPrompt: systemPromptArg ?? undefined,
    transport: nodePlacement
      ? "paired-node-cli"
      : useManagedClaudeLiveSession
        ? "stdio-live"
        : "stdio",
  });
  let completedOutput: CliOutput | undefined;
  let executionError: unknown;
  let outerCleanupError: Error | undefined;
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
      if (completedOutput?.didSendViaMessagingTool) {
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
  const executeAttempt = async (): Promise<CliOutput> => {
    await context.preparedBackend.beforeExecution?.();
    if (params.abortSignal?.aborted) {
      throw createCliAbortError();
    }
    const cliTurnStartedAt = Date.now();
    const restoreSkillEnv =
      params.skillsSnapshot && !params.controlOperation
        ? applySkillEnvOverridesFromSnapshot({
            snapshot: params.skillsSnapshot,
            config: params.config,
          })
        : undefined;
    let cleanupMcpCaptureAttempt: (() => Promise<void>) | undefined;
    let runOutput: CliOutput | undefined;
    let runError: unknown;
    let runFailed = false;
    const recordRunError = (error: unknown) => {
      if (!runFailed) {
        runFailed = true;
        runError = error;
      }
    };
    const toolTracking = createCliToolTracking(context);
    const events = createCliEventHandlers({
      context,
      toolTracking,
      getRunState: () => ({ failed: runFailed, error: runError }),
    });
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
      const initialGatewayCaptureKey =
        nodePlacement || !context.mcpDeliveryCapture ? undefined : crypto.randomUUID();
      const mcpCaptureAttempt = nodePlacement
        ? { env: {}, cleanup: undefined }
        : await prepareCliBundleMcpCaptureAttempt({
            mode: context.backendResolved.bundleMcpMode,
            backend,
            env: context.preparedBackend.env,
            captureKey: initialGatewayCaptureKey,
          });
      cleanupMcpCaptureAttempt = mcpCaptureAttempt.cleanup;
      const preparedBackendEnv = context.preparedBackend.env ?? {};
      const hasSelectedClaudeAuth =
        Boolean(context.preparedBackend.secretInput) ||
        [...CLAUDE_SELECTED_AUTH_ENV_KEYS].some((key) => Object.hasOwn(preparedBackendEnv, key));
      const selectedClaudeClearEnv = hasSelectedClaudeAuth
        ? new Set(backend.clearEnv ?? [])
        : undefined;
      const configuredBackendEnv = Object.fromEntries(
        Object.entries(backend.env ?? {}).filter(([key]) => !selectedClaudeClearEnv?.has(key)),
      );
      const backendEnv = { ...configuredBackendEnv, ...preparedBackendEnv };
      const nodeEnvEntries = Object.entries(preparedBackendEnv).filter(([key]) =>
        NODE_CLAUDE_FORWARD_ENV_KEYS.has(key),
      );
      const nodeEnv = nodePlacement
        ? {
            ...Object.fromEntries(nodeEnvEntries),
            ...resolveNodeClaudeAuthEnv(context),
          }
        : undefined;
      const nodeRuntimeClearEnv = nodePlacement
        ? [...NODE_CLAUDE_FORWARD_ENV_KEYS].filter((key) => backend.clearEnv?.includes(key))
        : [];
      const nodeClearEnv = [...(selectedClaudeClearEnv ?? []), ...nodeRuntimeClearEnv].filter(
        (key, index, values) => values.indexOf(key) === index,
      );
      const env = sanitizeHostExecEnv({ baseEnv: process.env, blockPathOverrides: true });
      const preservedEnv = parseCliBackendPreserveEnv(process.env[CLI_BACKEND_PRESERVE_ENV]);
      for (const key of backend.clearEnv ?? []) {
        if (!preservedEnv.has(key) || selectedClaudeClearEnv?.has(key)) {
          delete env[key];
        }
      }
      if (Object.keys(backendEnv).length > 0) {
        Object.assign(
          env,
          sanitizeHostExecEnv({
            baseEnv: {},
            overrides: backendEnv,
            blockPathOverrides: true,
          }),
        );
      }
      Object.assign(env, mcpCaptureAttempt.env, localProcessEnv);
      // Never mark Claude CLI as host-managed. That marker routes runs into
      // Anthropic's separate host-managed usage tier instead of normal CLI use.
      delete env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST;

      let executionCommand = backend.command;
      let executionLeadingArgv: readonly string[] = [];
      context.runtimeOwnerFingerprint = undefined;
      context.runtimeArtifactFingerprint = undefined;
      const exactToolAvailabilityVersionPolicy = params.cliToolAvailability
        ? context.backendResolved.runtimeArtifact?.exactToolAvailabilityVersionPolicy
        : undefined;
      if (exactToolAvailabilityVersionPolicy && nodePlacement) {
        throw exactToolAvailabilityError({
          code: "unsupported",
          isolatedCompletion: params.isolatedCompletion === true,
          message: `CLI backend ${context.backendResolved.id} cannot verify its exact tool-availability runtime on a paired node`,
        });
      }
      if (
        (params.onSuccessfulAuthBinding || exactToolAvailabilityVersionPolicy) &&
        !nodePlacement
      ) {
        const executableIdentity = await resolveCliExecutableIdentity({
          command: backend.command,
          cwd: context.cwd ?? context.workspaceDir,
          env,
          ...(context.backendResolved.runtimeArtifact
            ? { runtimeArtifact: context.backendResolved.runtimeArtifact }
            : {}),
        });
        if (!executableIdentity) {
          throw exactToolAvailabilityError({
            code: "runtime-unavailable",
            isolatedCompletion:
              params.isolatedCompletion === true &&
              exactToolAvailabilityVersionPolicy !== undefined,
            message: `CLI backend ${context.backendResolved.id} executable cannot be bound to one durable absolute owner`,
          });
        }
        if (exactToolAvailabilityVersionPolicy) {
          assertExactToolAvailabilityRuntimeVersion({
            backendId: context.backendResolved.id,
            policy: exactToolAvailabilityVersionPolicy,
            executableIdentity,
            isolatedCompletion: params.isolatedCompletion === true,
          });
        }
        executionCommand = executableIdentity.invocation.command;
        executionLeadingArgv = executableIdentity.invocation.leadingArgv;
        context.runtimeArtifactFingerprint = fingerprintCliRuntimeArtifact({
          provider: params.provider,
          backendId: context.backendResolved.id,
          executableIdentity,
        });
        if (params.onSuccessfulAuthBinding && !context.authBindingFingerprint) {
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
        logCliInvocation({
          args,
          command: executionCommand,
          env,
          systemPromptArg: backend.systemPromptArg,
          modelArg: backend.modelArg,
          imageArg: backend.imageArg,
          argsPrompt,
          log: (message) => cliBackendLog.info(message),
        });
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
        expectedQuiet: params.controlOperation === "compact",
        runTimeoutOverrideMs,
        useResume,
        trigger: params.trigger,
      });
      if (!useManagedClaudeLiveSession) {
        toolTracking.beginGatewayCapture(initialGatewayCaptureKey);
      }
      runOutput = await executeCliProcess({
        context,
        backend,
        deps: executeDeps,
        events,
        toolTracking,
        diagnostics,
        nodePlacement,
        nodeSystemPrompt,
        nodeEnv: nodeEnv && Object.keys(nodeEnv).length > 0 ? nodeEnv : undefined,
        nodeClearEnv: nodeClearEnv.length > 0 ? nodeClearEnv : undefined,
        useManagedClaudeLiveSession,
        usePluginOwnedExecution,
        initialGatewayCaptureKey,
        useResume,
        cliSessionIdToUse,
        resolvedSessionId,
        executionCommand,
        executionLeadingArgv,
        executionArgs: args,
        env,
        prompt,
        ...(promptContext ? { promptContext } : {}),
        argsPrompt,
        stdin,
        noOutputTimeoutMs,
        outputMode,
        logOutputText,
        cliTurnStartedAt,
        observeForkSuccessor,
        options,
      });
    } catch (error) {
      recordRunError(error);
    } finally {
      await toolTracking.finishDeliveryTracking({
        useManagedClaudeLiveSession,
        recordRunError,
      });
      toolTracking.finalizeCapture(events.finalizeParsedTools);
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
      throw toolTracking.attachDeliveryEvidence(runError);
    }
    if (!runOutput) {
      throw new Error("CLI run completed without output");
    }
    return toolTracking.withExecutionEvidence({
      ...runOutput,
      toolSummary: events.getToolSummary(),
    });
  };
  try {
    completedOutput = await enqueueCliRun(queueKey, async () => {
      if (params.abortSignal?.aborted) {
        throw createCliAbortError();
      }
      if (params.lifecycleGeneration) {
        assertAgentRunLifecycleGenerationCurrent(params.lifecycleGeneration);
      }
      diagnostics?.emitStarted();
      if (params.forkCliSessionOnResume && useResume) {
        if (!params.persistCliSessionForkSuccessor) {
          throw new Error("CLI session fork successor persistence is unavailable");
        }
        forkResumeClaimed = (await params.claimCliSessionFork?.()) === true;
        if (!forkResumeClaimed) {
          throw new Error("CLI session fork marker is no longer available");
        }
        // The fork argument only applies at process startup; a cached warm child
        // would run inside the source session. Force a fresh spawn.
        await closeCliLiveSession(context, "restart");
      }
      return await executeAttempt();
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
  } catch (error) {
    executionError = error;
    diagnostics?.emitError(error);
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
    try {
      await cleanupOuterResource(systemPromptFile?.cleanup);
      await cleanupOuterResource(imagePayload.cleanupImages);
    } catch (error) {
      outerCleanupError = toErrorObject(error, "CLI outer resource cleanup failed");
    }
  }
  if (outerCleanupError) {
    options?.onPhase?.("cleanup");
    diagnostics?.emitError(outerCleanupError);
    throw outerCleanupError;
  }
  if (!completedOutput) {
    const error = new Error("CLI run completed without output");
    diagnostics?.emitError(error);
    throw error;
  }
  // Success stays provisional until persistence and cleanup finish; otherwise
  // a rejected turn would be exported as completed.
  diagnostics?.emitCompleted(completedOutput);
  return completedOutput;
}

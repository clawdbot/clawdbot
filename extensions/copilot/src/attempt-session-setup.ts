import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  resolveAgentHarnessBeforePromptBuildResult,
  runAgentHarnessLlmInputHook,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { createSessionConfig, type resolvePoolAcquire } from "./attempt-config.js";
import { isRawCopilotModelRun } from "./attempt-mode.js";
import { assertCopilotAttemptHostCapabilities } from "./attempt-types.js";
import type {
  AttemptParamsLike,
  CopilotAgentEndHookParams,
  CopilotAttemptDeps,
  ModelRef,
} from "./attempt-types.js";
import { buildCopilotPromptGuidance } from "./prompt-guidance.js";
import type { ResolvedCopilotProvider } from "./provider-bridge.js";
import { shouldForceCopilotMessageTool, type createCopilotToolBridge } from "./tool-bridge.js";
import { createCopilotUserInputBridge } from "./user-input-bridge.js";
import { resolveCopilotWorkspaceBootstrapContext } from "./workspace-bootstrap.js";
export async function createCopilotSessionSetup(params: {
  attempt: AttemptParamsLike;
  byokProxy: Awaited<ReturnType<typeof import("./byok-proxy.js").createCopilotByokProxy>>;
  effectiveCwd: string | undefined;
  effectiveWorkspaceDir: string | undefined;
  hookContext: CopilotAgentEndHookParams["ctx"];
  modelRef: ModelRef;
  messages: AgentMessage[];
  operation: CopilotAttemptDeps["operation"];
  poolAcquire: ReturnType<typeof resolvePoolAcquire>;
  ringZeroSystemAgentRun: boolean;
  promptToolPolicy?: Awaited<ReturnType<typeof createCopilotToolBridge>>["promptToolPolicy"];
  sessionProvider: ResolvedCopilotProvider;
  settledToolFinalization: boolean;
  signal: AbortSignal | undefined;
}) {
  const {
    attempt: input,
    byokProxy,
    effectiveCwd,
    effectiveWorkspaceDir,
    hookContext,
    modelRef,
    messages,
    operation,
    poolAcquire,
    ringZeroSystemAgentRun,
    promptToolPolicy,
    sessionProvider,
    settledToolFinalization,
    signal,
  } = params;
  const ordinaryAttemptInput = settledToolFinalization
    ? undefined
    : (() => {
        assertCopilotAttemptHostCapabilities(input);
        return input;
      })();
  const workspaceBootstrap = ordinaryAttemptInput
    ? await resolveCopilotWorkspaceBootstrapContext({
        attempt: ordinaryAttemptInput,
        effectiveWorkspaceDir,
        warn: (message) => console.warn(message),
      })
    : { instructions: undefined };
  const forceToolNames =
    ordinaryAttemptInput && shouldForceCopilotMessageTool(ordinaryAttemptInput)
      ? (["message"] as const)
      : undefined;
  let promptPolicyResult: ReturnType<NonNullable<typeof promptToolPolicy>["apply"]> | undefined;
  let promptBuild: Awaited<ReturnType<typeof resolveAgentHarnessBeforePromptBuildResult>>;
  if (settledToolFinalization) {
    promptBuild = { prompt: input.prompt, developerInstructions: "" };
  } else if (isRawCopilotModelRun(input)) {
    promptPolicyResult = promptToolPolicy?.apply();
    promptBuild = { prompt: input.prompt, developerInstructions: "" };
  } else {
    if (!ordinaryAttemptInput) {
      throw new Error("Copilot ordinary attempt authority is unavailable.");
    }
    if (!promptToolPolicy) {
      throw new Error("Copilot ordinary attempts require a prompt tool policy.");
    }
    promptBuild = await resolveAgentHarnessBeforePromptBuildResult({
      prompt: input.prompt,
      developerInstructions: {
        build: ({ toolsAllow }) => {
          promptPolicyResult = promptToolPolicy.apply({ toolsAllow, forceToolNames });
          return buildCopilotPromptGuidance({
            attempt: input,
            callableToolNames: promptPolicyResult.callableToolNames,
            requireExplicitMessageTarget: promptToolPolicy.requireExplicitMessageTarget,
            workspaceBootstrapInstructions: workspaceBootstrap.instructions,
          });
        },
      },
      messages,
      ctx: hookContext,
      bootstrapContextRunKind: input.bootstrapContextRunKind,
      toolAuthority: {
        fingerprint: input.toolAuthorityFingerprint,
        activeToolNames: () => promptPolicyResult?.callableToolNames ?? [],
        assertActive: ordinaryAttemptInput.hostCapabilities.assertActive,
      },
    });
  }
  const attemptInput =
    promptBuild.prompt === input.prompt ? input : { ...input, prompt: promptBuild.prompt };
  const promptTools = promptPolicyResult?.tools ?? [];
  const finalDeveloperInstructions = promptBuild.developerInstructions;
  // Restricted turns may expose native ask_user only when its policy-filtered
  // OpenClaw equivalent survived the canonical tool catalog.
  const includeAskUser =
    !ringZeroSystemAgentRun &&
    (attemptInput.pluginHarnessToolPolicyRestricted !== true ||
      promptTools.some((tool) => tool.name === "ask_user"));
  let promptImagesCount = 0;
  const emitLlmInput = (prompt: string, additionalContext?: string) => {
    if (settledToolFinalization) {
      return;
    }
    runAgentHarnessLlmInputHook({
      event: {
        runId: input.runId,
        sessionId: input.sessionId,
        provider: modelRef.provider,
        model: modelRef.id,
        ...(finalDeveloperInstructions ? { systemPrompt: finalDeveloperInstructions } : {}),
        prompt: additionalContext ? `${prompt}\n\n${additionalContext}` : prompt,
        historyMessages: [],
        imagesCount: promptImagesCount,
        tools: promptTools,
      },
      ctx: hookContext,
    });
  };
  const hasNativePromptHook =
    !settledToolFinalization && Boolean(attemptInput.hooksConfig?.onUserPromptSubmitted);
  const userInputBridge = settledToolFinalization
    ? undefined
    : (() => {
        assertCopilotAttemptHostCapabilities(attemptInput);
        return createCopilotUserInputBridge({ paramsForRun: attemptInput, signal });
      })();
  const sessionConfig = createSessionConfig(
    attemptInput,
    modelRef.id,
    promptTools,
    poolAcquire.auth,
    sessionProvider,
    finalDeveloperInstructions || undefined,
    effectiveWorkspaceDir,
    effectiveCwd,
    userInputBridge?.onUserInputRequest,
    {
      hooksBridgeOptions: hasNativePromptHook
        ? {
            onUserPromptSubmitted: ({ additionalContext, prompt }) =>
              emitLlmInput(prompt, additionalContext),
          }
        : undefined,
      includeAskUser,
      operation: operation ?? "attempt",
    },
  );
  const compactionSessionConfig = byokProxy
    ? createSessionConfig(
        attemptInput,
        modelRef.id,
        promptTools,
        poolAcquire.auth,
        poolAcquire.provider,
        finalDeveloperInstructions || undefined,
        effectiveWorkspaceDir,
        effectiveCwd,
        userInputBridge?.onUserInputRequest,
        {
          hooksBridgeOptions: hasNativePromptHook
            ? {
                onUserPromptSubmitted: ({ additionalContext, prompt }) =>
                  emitLlmInput(prompt, additionalContext),
              }
            : undefined,
          includeAskUser,
          operation: operation ?? "attempt",
        },
      )
    : sessionConfig;
  return {
    attemptInput,
    compactionSessionConfig,
    emitLlmInput,
    hasNativePromptHook,
    sessionConfig,
    setPromptImagesCount: (count: number) => {
      promptImagesCount = count;
    },
    userInputBridge,
  };
}

import type { Tool as SdkTool } from "@github/copilot-sdk";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  resolveAgentHarnessBeforePromptBuildResult,
  runAgentHarnessLlmInputHook,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  createSessionConfig,
  createSystemMessageContent,
  isRawCopilotModelRun,
  type resolvePoolAcquire,
} from "./attempt-config.js";
import { assertCopilotAttemptHostCapabilities } from "./attempt-types.js";
import type {
  AttemptParamsLike,
  CopilotAgentEndHookParams,
  CopilotAttemptDeps,
  ModelRef,
} from "./attempt-types.js";
import type { ResolvedCopilotProvider } from "./provider-bridge.js";
import { filterCopilotToolsForAllowlist, shouldForceCopilotMessageTool } from "./tool-bridge.js";
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
  sdkTools: SdkTool[];
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
    sdkTools,
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
  const originalDeveloperInstructions = settledToolFinalization
    ? ""
    : (createSystemMessageContent(input, workspaceBootstrap.instructions) ?? "");
  const promptBuild =
    settledToolFinalization || isRawCopilotModelRun(input)
      ? {
          prompt: input.prompt,
          developerInstructions: originalDeveloperInstructions,
        }
      : await resolveAgentHarnessBeforePromptBuildResult({
          prompt: input.prompt,
          developerInstructions: originalDeveloperInstructions,
          messages,
          ctx: hookContext,
          bootstrapContextRunKind: input.bootstrapContextRunKind,
        });
  const attemptInput =
    promptBuild.prompt === input.prompt ? input : { ...input, prompt: promptBuild.prompt };
  const promptTools = filterCopilotToolsForAllowlist(
    sdkTools,
    promptBuild.toolsAllow,
    ordinaryAttemptInput && shouldForceCopilotMessageTool(ordinaryAttemptInput)
      ? { forceToolNames: ["message"] }
      : undefined,
  );
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
        ...(promptBuild.developerInstructions
          ? { systemPrompt: promptBuild.developerInstructions }
          : {}),
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
    promptBuild.developerInstructions || undefined,
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
        promptBuild.developerInstructions || undefined,
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

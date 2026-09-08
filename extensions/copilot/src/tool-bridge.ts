// Copilot plugin module implements tool bridge behavior.
import {
  convertMcpCallToolResult,
  type Tool as SdkTool,
  type ToolInvocation,
  type ToolResultObject,
} from "@github/copilot-sdk";
import type {
  AnyAgentTool,
  EmbeddedRunAttemptParamsV2,
  SandboxContext,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  applyEmbeddedAttemptToolsAllow,
  buildEmbeddedAttemptToolRunContext,
  extractToolErrorMessage,
  getPluginToolMeta,
  getPluginToolSideEffectOwnerKey,
  isSubagentSessionKey,
  isToolResultError,
  resolveEmbeddedAttemptToolConstructionPlan,
  resolveModelAuthMode,
  sanitizeToolResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { createAgentHarnessToolSurfaceRuntime } from "openclaw/plugin-sdk/agent-harness-tool-runtime";
import { toStringifiedError as toCopilotToolError } from "openclaw/plugin-sdk/error-runtime";
import { isRawCopilotModelRun } from "./attempt-mode.js";

type CreateOpenClawCodingTools =
  (typeof import("openclaw/plugin-sdk/agent-harness"))["createOpenClawCodingTools"];
type OpenClawCodingToolsOptions = NonNullable<Parameters<CreateOpenClawCodingTools>[0]>;
type CreateOpenClawCodingToolsForBridge = (
  options?: OpenClawCodingToolsOptions,
) => ReturnType<CreateOpenClawCodingTools> | Promise<ReturnType<CreateOpenClawCodingTools>>;
type AgentHarnessToolSurfaceRuntime = ReturnType<typeof createAgentHarnessToolSurfaceRuntime>;
type CatalogExecuteParams = Parameters<
  NonNullable<AgentHarnessToolSurfaceRuntime["toolSearchCatalogExecutor"]>
>[0];
type ScheduleToolExecution = (
  executionMode: AnyAgentTool["executionMode"],
  execute: () => Promise<ToolResultObject>,
) => Promise<ToolResultObject>;

/**
 * Mutable holder populated by `attempt.ts` *after* `client.createSession()`
 * (or `client.resumeSession()`) succeeds, so that the tool bridge — which is
 * constructed *before* the SDK session exists — can route `onYield` events
 * to the live session's `abort()` later in the run. Bridged tools cannot
 * execute before the SDK session is up, so reading `current === undefined`
 * inside `onYield` is a no-op by design.
 */
interface CopilotSessionHolder {
  current: { abort?: () => unknown } | undefined;
}

/**
 * Structural subset of `EmbeddedRunAttemptParamsV2` carried into the tool
 * bridge for PI-parity tool context (see
 * `src/agents/pi-embedded-runner/run/attempt.ts:1029-1117` — the
 * authoritative `createOpenClawCodingTools({...})` call shape).
 *
 * Declared from `EmbeddedRunAttemptParamsV2` (imported from the
 * `openclaw/plugin-sdk/agent-harness-runtime` boundary, *not* from
 * `attempt.ts` in this extension) to avoid an `attempt.ts` ↔
 * `tool-bridge.ts` import cycle while keeping the field shapes
 * authoritative. Production callers pass the live attempt params; test
 * fixtures can use the flat fields below for minimal-config wiring, but every
 * constructed tool surface still requires the host-bound capability.
 */
type CopilotToolAttemptParams = Partial<Omit<EmbeddedRunAttemptParamsV2, "hostCapabilities">> &
  Pick<EmbeddedRunAttemptParamsV2, "hostCapabilities">;

type CopilotToolCompletion = {
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
  result?: unknown;
  error?: string;
  startedAt: number;
};

interface CopilotToolBridgeInput {
  allowModelTools?: boolean;
  /** Invalidates screenshot-bound computer actions after context compaction. */
  computerContextEpoch?: {
    value: number;
    frameToolCallId?: string;
    frameImageIdentity?: string;
  };
  modelProvider: string;
  modelId: string;
  agentId: string;
  sessionId: string;
  sessionKey?: string;
  agentDir?: string;
  workspaceDir?: string;
  cwd?: string;
  /**
   * Sandbox context resolved by the caller (typically `attempt.ts` via
   * `resolveSandboxContext` from the plugin-sdk). When provided, wrapped
   * tools see the same sandbox-aware behavior PI provides. `null` (or
   * omitted) means sandbox is disabled.
   */
  sandbox?: SandboxContext | null;
  /**
   * Spawn workspace prepared by the attempt from the original workspace.
   * Undefined keeps normal workspace wiring for absent or rw sandboxes.
   */
  spawnWorkspaceDir: string | undefined;
  abortSignal?: AbortSignal;
  /**
   * Full PI-parity attempt parameters. When set, the bridge forwards
   * identity, channel, owner/policy, auth-profile, message-routing,
   * model, and run-trace fields to `createOpenClawCodingTools` so the
   * wrapped-tool enforcement layer
   * (`src/agents/pi-tools.before-tool-call.ts`) receives the same
   * context the in-tree PI runner provides. See
   * `src/agents/pi-embedded-runner/run/attempt.ts:1029-1117`.
   */
  attemptParams: CopilotToolAttemptParams;
  /**
   * Mutable session holder used to wire `onYield` to the live
   * `session.abort()` once the SDK session is established. See
   * {@link CopilotSessionHolder}.
   */
  sessionRef?: CopilotSessionHolder;
  /**
   * Invoked when a wrapped tool fires `sessions_yield`. The bridge
   * always also calls `sessionRef.current?.abort?.()` to interrupt
   * the in-flight SDK session; this callback lets the caller track
   * the yield so the final attempt result can carry
   * `yieldDetected: true` (the parent runner uses it to mark
   * liveness as paused and stop_reason as `end_turn`). Mirrors
   * the PI/codex contract — see
   * `src/agents/pi-embedded-runner/run/attempt.ts:1107-1113` and
   * `extensions/codex/src/app-server/run-attempt.ts:539-541`.
   */
  onYieldDetected?: (message?: string, acknowledgment?: string) => void;
  onToolCompleted?: (completion: CopilotToolCompletion) => void | Promise<void>;
  createOpenClawCodingTools?: CreateOpenClawCodingToolsForBridge;
  beforeExecute?: (ctx: {
    toolName: string;
    toolCallId: string;
    args: unknown;
    sourceTool: AnyAgentTool;
    invocation: ToolInvocation;
  }) => void | Promise<void>;
}

interface CopilotToolBridge {
  cleanup?: () => void;
  codeModeEngaged?: boolean;
  promptToolPolicy: {
    requireExplicitMessageTarget?: boolean;
    apply: (params?: { toolsAllow?: string[]; forceToolNames?: readonly string[] }) => {
      tools: SdkTool[];
      callableToolNames: string[];
    };
  };
  sourceTools: AnyAgentTool[];
}

const EMPTY_PROMPT_TOOL_POLICY: CopilotToolBridge["promptToolPolicy"] = {
  apply: () => ({ tools: [], callableToolNames: [] }),
};

const SUPPORTED_TOOL_PROVIDERS: ReadonlySet<string> = new Set(["github-copilot"]);
const BASE_COPILOT_CODING_TOOL_NAMES = new Set(["edit", "read", "write"]);
const SHELL_COPILOT_CODING_TOOL_NAMES = new Set(["apply_patch", "exec", "process"]);

export async function createCopilotToolBridge(
  input: CopilotToolBridgeInput,
): Promise<CopilotToolBridge> {
  if (!input.allowModelTools && !SUPPORTED_TOOL_PROVIDERS.has(input.modelProvider)) {
    return { codeModeEngaged: false, promptToolPolicy: EMPTY_PROMPT_TOOL_POLICY, sourceTools: [] };
  }

  const attemptParams = input.attemptParams;
  const toolPlan = resolveEmbeddedAttemptToolConstructionPlan({
    disableTools: attemptParams.disableTools,
    forceMessageTool: shouldForceCopilotMessageTool(attemptParams),
    isRawModelRun: isRawCopilotModelRun(attemptParams),
    toolsAllow: buildEmbeddedAttemptToolRunContext({
      ...attemptParams,
      forceMessageTool: shouldForceCopilotMessageTool(attemptParams),
    }).runtimeToolAllowlist,
  });
  if (!toolPlan.constructTools) {
    return { codeModeEngaged: false, promptToolPolicy: EMPTY_PROMPT_TOOL_POLICY, sourceTools: [] };
  }

  const createOpenClawCodingTools =
    input.createOpenClawCodingTools ??
    (await import("openclaw/plugin-sdk/agent-harness")).createOpenClawCodingTools;

  const toolSurfaceRuntime = createAgentHarnessToolSurfaceRuntime({
    abortSignal: input.abortSignal,
    agentId: attemptParams.sandboxAgentId ?? input.agentId,
    config: attemptParams.config,
    codeModeOverride: attemptParams.codeModeOverride,
    disableTools: attemptParams.disableTools,
    // Catalog calls are nested inside SDK controls; scheduling them again could
    // make a control wait for its own completion.
    executeTool: (toolParams) => executeCatalogTool(input, toolParams),
    forceMessageTool: shouldForceCopilotMessageTool(attemptParams),
    isRawModelRun: isRawCopilotModelRun(attemptParams),
    // Carries catalog compat so `tools.codeMode.enabled: "auto"` can resolve per model.
    model: attemptParams.model,
    contextTokenBudget: attemptParams.contextTokenBudget,
    modelId: input.modelId,
    modelProvider: input.modelProvider,
    modelToolsEnabled: true,
    prompt: attemptParams.prompt,
    runId: attemptParams.runId,
    runtimeToolAllowlist: toolPlan.runtimeToolAllowlist,
    sessionId: input.sessionId,
    sessionKey: attemptParams.sandboxSessionKey ?? attemptParams.sessionKey ?? input.sessionKey,
    scheduledToolPolicy: attemptParams.scheduledToolPolicy,
    sourceReplyDeliveryMode: attemptParams.sourceReplyDeliveryMode,
    toolsAllow: attemptParams.toolsAllow,
  });
  const toolOptions = buildOpenClawCodingToolsOptions(
    input,
    {
      ...toolPlan,
      runtimeToolAllowlist: toolSurfaceRuntime.runtimeToolAllowlist,
    },
    toolSurfaceRuntime,
  );

  let sourceTools: AnyAgentTool[];
  const boundSourceTools = new Set<AnyAgentTool>();
  const hostCapabilities = attemptParams.hostCapabilities;
  if (!hostCapabilities) {
    throw new Error("Copilot attempt tools require host-bound capabilities.");
  }
  const bindingCwd = toolOptions.cwd ?? toolOptions.workspaceDir;
  const bindingOptions = bindingCwd ? { cwd: bindingCwd } : undefined;
  try {
    const constructedTools = await createOpenClawCodingTools(toolOptions);
    if (!Array.isArray(constructedTools)) {
      throw new Error("createOpenClawCodingTools must return an array of tools");
    }
    const boundTools = hostCapabilities.bindToolSurface(constructedTools, bindingOptions);
    sourceTools = boundTools;
    for (const tool of boundTools) {
      boundSourceTools.add(tool);
    }
  } catch (error: unknown) {
    throw createError(
      `[copilot-tool-bridge] createOpenClawCodingTools failed: ${toCopilotToolError(error).message}`,
      error,
    );
  }

  const allowedSourceTools = applyEmbeddedAttemptToolsAllow(
    sourceTools,
    toolSurfaceRuntime.runtimeToolAllowlist,
    { toolMeta: (tool) => getPluginToolMeta(tool) ?? readInlinePluginToolMeta(tool) },
  );
  const plannedSourceTools = filterCopilotToolsForConstructionPlan(
    allowedSourceTools,
    toolPlan.codingToolConstructionPlan,
    { preserveToolNames: toolSurfaceRuntime.runtimeToolAllowlist },
  );
  const compactedTools = toolSurfaceRuntime.compactTools(plannedSourceTools, {
    localModelLeanApplied: true,
  });
  // The constructor output is bound before catalog compaction so hidden tools
  // cannot outlive the attempt. Bind only controls created by compaction here;
  // rebinding retained tools would stack the before-tool hook.
  const newlyConstructedTools = compactedTools.tools.filter((tool) => !boundSourceTools.has(tool));
  const boundNewlyConstructedTools =
    newlyConstructedTools.length > 0
      ? hostCapabilities.bindToolSurface(newlyConstructedTools, bindingOptions)
      : newlyConstructedTools;
  if (boundNewlyConstructedTools.length !== newlyConstructedTools.length) {
    throw new Error("Copilot host capability changed the tool surface length.");
  }
  const newlyBoundTools = new Map<AnyAgentTool, AnyAgentTool>();
  for (let index = 0; index < newlyConstructedTools.length; index += 1) {
    newlyBoundTools.set(newlyConstructedTools[index]!, boundNewlyConstructedTools[index]!);
  }
  const exposedTools = compactedTools.tools.map((tool) => newlyBoundTools.get(tool) ?? tool);

  // Run duplicate detection after filtering so a duplicate in a
  // suppressed tool does not fail a narrow run (PI parity: PI never
  // sees the duplicate either when the allowlist excludes it).
  const duplicateNames = findDuplicateToolNames(exposedTools);
  if (duplicateNames.length > 0) {
    throw new Error(`[copilot-tool-bridge] duplicate tool names: ${duplicateNames.join(", ")}`);
  }

  let sequentialBarrier = Promise.resolve();
  const pendingCalls = new Set<Promise<void>>();
  const scheduleToolExecution: ScheduleToolExecution = (executionMode, execute) => {
    // SDK handlers arrive independently. An exclusive call waits for earlier
    // work across the attempt and blocks later calls, regardless of tool name.
    const ready = executionMode === "sequential" ? Promise.all(pendingCalls) : sequentialBarrier;
    const run = ready.then(execute);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    pendingCalls.add(settled);
    void settled.then(() => pendingCalls.delete(settled));
    if (executionMode === "sequential") {
      sequentialBarrier = settled;
    }
    return run;
  };
  const sdkTools = exposedTools.map((sourceTool) =>
    convertOpenClawToolToSdkTool(sourceTool, input, scheduleToolExecution),
  );
  return {
    cleanup: toolSurfaceRuntime.cleanup,
    // Harness runs resolve `tools.codeMode: "auto"` inside the tool surface
    // bridge, so this is the only place that knows whether the turn actually
    // got code-mode controls. Without it the run reports `codeModeEngaged`
    // as unset and telemetry cannot tell "off" from "harness did not report".
    codeModeEngaged: toolSurfaceRuntime.codeModeControlsEnabled,
    promptToolPolicy: {
      requireExplicitMessageTarget: toolOptions.requireExplicitMessageTarget,
      apply: (params: { toolsAllow?: string[]; forceToolNames?: readonly string[] } = {}) => {
        const result = compactedTools.promptToolPolicy.apply({
          ...params,
          toolsAllow: buildEmbeddedAttemptToolRunContext({
            ...attemptParams,
            toolsAllow: params.toolsAllow,
            forceMessageTool: shouldForceCopilotMessageTool(attemptParams),
          }).runtimeToolAllowlist,
        });
        const directToolNames = new Set(result.tools.map((tool) => tool.name));
        return {
          tools: sdkTools.filter((tool) => directToolNames.has(tool.name)),
          callableToolNames: result.callableToolNames,
        };
      },
    },
    sourceTools: exposedTools,
  };
}

/**
 * Bridged tools skip SDK permission prompts, so host wrappers need the complete
 * attempt context and prepared sandbox/construction policy to enforce access.
 * Missing fields here silently weaken or misapply the native harness contract.
 */
function buildOpenClawCodingToolsOptions(
  input: CopilotToolBridgeInput,
  toolPlan: ReturnType<typeof resolveEmbeddedAttemptToolConstructionPlan>,
  toolSurfaceRuntime?: ReturnType<typeof createAgentHarnessToolSurfaceRuntime>,
): OpenClawCodingToolsOptions {
  const a = input.attemptParams;

  // Mirror PI's `sandboxSessionKey` derivation (attempt.ts:873-874) so
  // wrapped tools see the same policy key PI uses. When the attempt
  // exposes neither sandboxSessionKey nor sessionKey, fall back to the
  // flat input.sessionKey/sessionId.
  const sandboxSessionKey =
    a.sandboxSessionKey?.trim() || a.sessionKey?.trim() || input.sessionKey || input.sessionId;

  // When sandboxSessionKey differs from the real run session key (e.g.
  // Telegram direct peer key vs `agent:main:main`), pass the live key
  // so `session_status: "current"` resolves to the active run session,
  // not the stale sandbox key. Mirrors PI attempt.ts:1057-1060.
  const liveSessionKey = a.sessionKey ?? input.sessionKey;
  const runSessionKey =
    liveSessionKey && liveSessionKey !== sandboxSessionKey ? liveSessionKey : undefined;

  const workspaceDir = input.workspaceDir ?? a.workspaceDir;
  const cwd = input.cwd ?? a.cwd;
  const agentDir = input.agentDir ?? a.agentDir;
  // Sandbox and spawn workspace are prepared by the attempt owner.
  const sandbox = input.sandbox ?? undefined;

  const model = a.model;
  const modelHasVision = Array.isArray(model?.input) && model.input.includes("image");
  const modelCompat =
    model &&
    typeof model === "object" &&
    "compat" in model &&
    model.compat &&
    typeof model.compat === "object"
      ? (model.compat as OpenClawCodingToolsOptions["modelCompat"])
      : undefined;

  return {
    agentId: input.agentId,
    policyAgentId: a.sandboxAgentId ?? input.agentId,
    ...buildEmbeddedAttemptToolRunContext(a),
    exec: {
      ...a.execOverrides,
      elevated: a.bashElevated,
    },
    messageProvider: a.messageProvider ?? a.messageChannel,
    messageChannel: a.messageChannel,
    // Bridged tools are dispatched here, not through the embedded tool lifecycle,
    // so no tool-start handler reserves a blocking question's prompt for them.
    ...(a.onToolResult
      ? {
          questionPrompt: {
            send: a.onToolResult,
            ...(a.messageChannel ? { messageChannel: a.messageChannel } : {}),
          },
        }
      : {}),
    allowGatewaySubagentBinding: a.allowGatewaySubagentBinding,
    sessionKey: sandboxSessionKey,
    runSessionKey,
    sessionId: input.sessionId,
    runId: a.runId,
    agentDir,
    preparedModelRuntime: a.preparedModelRuntime,
    workspaceDir,
    cwd,
    sandbox,
    spawnWorkspaceDir: input.spawnWorkspaceDir,
    config: toolSurfaceRuntime?.config ?? a.config,
    abortSignal: input.abortSignal,
    modelProvider: input.modelProvider,
    modelId: input.modelId,
    includeCoreTools: toolPlan.includeCoreTools,
    includeToolSearchControls: toolSurfaceRuntime?.includeToolSearchControls,
    toolSearchCatalogRef: toolSurfaceRuntime?.toolSearchCatalogRef,
    toolSearchCatalogExecutor: toolSurfaceRuntime?.toolSearchCatalogExecutor,
    runtimeToolAllowlist: toolPlan.runtimeToolAllowlist,
    toolConstructionPlan: toolPlan.codingToolConstructionPlan,
    modelCompat,
    modelApi: model?.api,
    modelContextWindowTokens: a.contextTokenBudget ?? model?.contextWindow,
    delegationCapability: a.delegationCapability,
    modelAuthMode: resolveModelAuthMode(input.modelProvider, a.config, undefined, {
      workspaceDir,
    }),
    modelHasVision,
    requireExplicitMessageTarget:
      a.requireExplicitMessageTarget ?? isSubagentSessionKey(liveSessionKey),
    disableMessageTool: a.disableMessageTool,
    forceMessageTool: a.forceMessageTool,
    enableHeartbeatTool: a.enableHeartbeatTool,
    forceHeartbeatTool: a.forceHeartbeatTool,
    authProfileStore: a.toolAuthProfileStore ?? a.authProfileStore,
    computerContextEpoch: input.computerContextEpoch,
    // recordToolPrepStage intentionally omitted: copilot does not
    // surface attempt-stage telemetry yet. Codex omits this too.
    onToolOutcome: a.onToolOutcome,
    isTurnTainted: a.isTurnTainted,
    onYield: (message, acknowledgment) => {
      // Notify the caller first so the final attempt result can carry
      // yieldDetected even if the abort below races a concurrent
      // settle path. Errors thrown by the caller's handler must not
      // skip the abort, so wrap defensively. Mirrors PI (`attempt.ts`
      // sets `yieldDetected = true; yieldMessage = message;` before
      // calling abort) and codex (`onYieldDetected()` runs before the
      // run-abort controller fires).
      try {
        input.onYieldDetected?.(message, acknowledgment);
      } catch (error) {
        console.warn("[copilot-tool-bridge] onYieldDetected handler threw; continuing", error);
      }
      // The SDK session does not exist at bridge-construction time, so
      // we route yield events through a mutable holder populated by
      // attempt.ts immediately after `createSession()` /
      // `resumeSession()` resolves. Bridged tools cannot execute before
      // the SDK session is up, so a missing `current` is a no-op by
      // design (e.g. early aborts handled by the abortSignal path).
      const target = input.sessionRef?.current;
      void target?.abort?.();
    },
  };
}

function convertOpenClawToolToSdkTool(
  sourceTool: AnyAgentTool,
  input: CopilotToolBridgeInput,
  scheduleToolExecution: ScheduleToolExecution,
): SdkTool {
  if (typeof sourceTool.name !== "string" || sourceTool.name.trim().length === 0) {
    throw new Error("[copilot-tool-bridge] tool name must be a non-empty string");
  }

  if (typeof sourceTool.execute !== "function") {
    throw new Error(
      `[copilot-tool-bridge] tool '${sourceTool.name}' must define an execute function`,
    );
  }

  const ownerKey = getPluginToolSideEffectOwnerKey(sourceTool);
  const ownerMutation = ownerKey ? { ownerKey } : undefined;
  const notifyToolResult = (result: unknown, isError: boolean) => {
    try {
      input.attemptParams.onAgentToolResult?.({ toolName: sourceTool.name, result, isError });
    } catch (error) {
      console.warn("[copilot-tool-bridge] onAgentToolResult handler threw; continuing", error);
    }
  };
  const notifyToolCompleted = (completion: CopilotToolCompletion) => {
    try {
      void Promise.resolve(input.onToolCompleted?.(completion)).catch((error: unknown) => {
        console.warn("[copilot-tool-bridge] onToolCompleted handler threw; continuing", error);
      });
    } catch (error) {
      console.warn("[copilot-tool-bridge] onToolCompleted handler threw; continuing", error);
    }
  };
  const failureResult = (
    executedArgs: unknown,
    invocation: ToolInvocation,
    startedAt: number,
    message: string,
    error: unknown,
    executionStarted: boolean,
  ): ToolResultObject => {
    const errorMessage = toCopilotToolError(error).message;
    input.attemptParams.observeToolTerminal?.({
      toolCallId: invocation.toolCallId,
      toolName: sourceTool.name,
      result: error,
      arguments: executedArgs,
      executionStarted,
      outcome: "failure",
      failure: { error: errorMessage },
      ...(ownerMutation ? { ownerMutation } : {}),
    });
    notifyToolResult(
      sanitizeToolResult({
        content: [{ type: "text", text: message }],
        details: { status: "failed", error: errorMessage },
      }),
      true,
    );
    notifyToolCompleted({
      toolName: sourceTool.name,
      toolCallId: invocation.toolCallId,
      args: toToolStartArgs(executedArgs),
      error: errorMessage,
      startedAt,
    });
    return createFailureResult(message, error);
  };
  const executeOnce = async (
    args: unknown,
    invocation: ToolInvocation,
  ): Promise<ToolResultObject> => {
    const startedAt = Date.now();
    if (input.abortSignal?.aborted) {
      const error = new Error("[copilot-tool-bridge] aborted before execution");
      return failureResult(args, invocation, startedAt, error.message, error, false);
    }

    try {
      await input.beforeExecute?.({
        args,
        invocation,
        sourceTool,
        toolCallId: invocation.toolCallId,
        toolName: sourceTool.name,
      });
    } catch (error: unknown) {
      return failureResult(
        args,
        invocation,
        startedAt,
        `[copilot-tool-bridge] beforeExecute failed for tool '${sourceTool.name}': ${toCopilotToolError(error).message}`,
        error,
        false,
      );
    }

    let preparedArgs;
    try {
      preparedArgs = sourceTool.prepareArguments ? sourceTool.prepareArguments(args) : args;
    } catch (error: unknown) {
      return failureResult(
        args,
        invocation,
        startedAt,
        `[copilot-tool-bridge] prepareArguments failed for tool '${sourceTool.name}': ${toCopilotToolError(error).message}`,
        error,
        false,
      );
    }

    let result: Awaited<ReturnType<AnyAgentTool["execute"]>>;
    try {
      result = await sourceTool.execute(
        invocation.toolCallId,
        preparedArgs,
        input.abortSignal,
        undefined,
      );
    } catch (error: unknown) {
      return failureResult(
        preparedArgs,
        invocation,
        startedAt,
        `[copilot-tool-bridge] tool '${sourceTool.name}' failed: ${toCopilotToolError(error).message}`,
        error,
        true,
      );
    }

    const sanitizedResult = sanitizeToolResult(result);
    const resultIsError = isToolResultError(sanitizedResult);
    // The SDK only marks fulfilled tool results as failures when isError is forwarded.
    const sdkResult = convertMcpCallToolResult({
      content: result.content,
      isError: resultIsError,
    });
    const resultError = resultIsError ? extractToolErrorMessage(sanitizedResult) : undefined;
    input.attemptParams.observeToolTerminal?.({
      toolCallId: invocation.toolCallId,
      toolName: sourceTool.name,
      result,
      arguments: preparedArgs,
      executionStarted: true,
      outcome: resultIsError ? "failure" : "success",
      ...(resultIsError ? { failure: { error: resultError ?? "tool returned an error" } } : {}),
      ...(ownerMutation ? { ownerMutation } : {}),
    });
    notifyToolResult(sanitizedResult, resultIsError);
    notifyToolCompleted({
      toolName: sourceTool.name,
      toolCallId: invocation.toolCallId,
      args: toToolStartArgs(preparedArgs),
      result: sanitizedResult,
      ...(resultError ? { error: resultError } : {}),
      startedAt,
    });
    return sdkResult;
  };

  return {
    description: sourceTool.description,
    defer: sourceTool.catalogMode === "direct-only" ? "never" : undefined,
    handler: (args, invocation) =>
      scheduleToolExecution(sourceTool.executionMode, () => executeOnce(args, invocation)),
    name: sourceTool.name,
    // Copilot built-ins share coding-tool names. Explicit overrides keep calls
    // on OpenClaw's host-bound tools instead of rejecting registration.
    overridesBuiltInTool: true,
    parameters: sourceTool.parameters as Record<string, unknown> | undefined,
    // Host-bound tools enforce OpenClaw policy and approvals; an SDK custom-tool
    // prompt would apply a second, independent permission decision.
    skipPermission: true,
  };
}

async function executeCatalogTool(
  input: CopilotToolBridgeInput,
  params: CatalogExecuteParams,
): Promise<Awaited<ReturnType<AnyAgentTool["execute"]>>> {
  const sourceTool = params.tool as AnyAgentTool;
  const ownerKey = getPluginToolSideEffectOwnerKey(sourceTool);
  const ownerMutation = ownerKey ? { ownerKey } : undefined;
  const startedAt = Date.now();
  let preparedArgs: unknown = params.input;
  let executionStarted = false;
  let terminalObserved = false;
  try {
    preparedArgs = sourceTool.prepareArguments
      ? sourceTool.prepareArguments(params.input)
      : params.input;
    executionStarted = true;
    const result = await sourceTool.execute(
      params.toolCallId,
      preparedArgs,
      params.signal ?? input.abortSignal,
      params.onUpdate,
    );
    const sanitizedResult = sanitizeToolResult(result);
    const isError = isToolResultError(sanitizedResult);
    const error = isError
      ? (extractToolErrorMessage(sanitizedResult) ?? "tool returned an error")
      : undefined;
    terminalObserved = true;
    input.attemptParams?.observeToolTerminal?.({
      toolCallId: params.toolCallId,
      toolName: params.toolName,
      result,
      arguments: preparedArgs,
      executionStarted,
      outcome: isError ? "failure" : "success",
      ...(error ? { failure: { error } } : {}),
      ...(ownerMutation ? { ownerMutation } : {}),
    });
    input.attemptParams?.onAgentToolResult?.({
      toolName: params.toolName,
      result: sanitizedResult,
      isError,
    });
    await input.onToolCompleted?.({
      toolName: params.toolName,
      toolCallId: params.toolCallId,
      args: toToolStartArgs(preparedArgs),
      result: sanitizedResult,
      ...(error ? { error } : {}),
      startedAt,
    });
    return result;
  } catch (error: unknown) {
    const message = toCopilotToolError(error).message;
    // Completion hooks can throw after the tool terminal outcome. Do not
    // rewrite that recorded outcome as a second, contradictory tool failure.
    if (!terminalObserved) {
      input.attemptParams?.observeToolTerminal?.({
        toolCallId: params.toolCallId,
        toolName: params.toolName,
        result: error,
        arguments: preparedArgs,
        executionStarted,
        outcome: "failure",
        failure: { error: message },
        ...(ownerMutation ? { ownerMutation } : {}),
      });
    }
    const failure = sanitizeToolResult({
      content: [{ type: "text", text: message }],
      details: { status: "failed", error: message },
    });
    input.attemptParams?.onAgentToolResult?.({
      toolName: params.toolName,
      result: failure,
      isError: true,
    });
    await input.onToolCompleted?.({
      toolName: params.toolName,
      toolCallId: params.toolCallId,
      args: toToolStartArgs(preparedArgs),
      error: message,
      startedAt,
    });
    throw error;
  }
}

function toToolStartArgs(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : { value: args };
}

function createFailureResult(message: string, error: unknown): ToolResultObject {
  // ToolResultObject.error is typed as `string | undefined` in the SDK contract
  // (see `node_modules/@github/copilot-sdk/dist/types.d.ts`). Returning an
  // Error object would produce a non-serializable JSON-RPC payload, so we
  // surface the message string instead.
  return {
    error: toCopilotToolError(error).message,
    resultType: "failure",
    textResultForLlm: message,
  };
}

function createError(message: string, cause: unknown): Error {
  const error = new Error(message) as Error & { cause?: unknown };
  error.cause = cause;
  return error;
}

/**
 * Mirrors PI's `shouldForceMessageTool` semantics: a message tool is
 * forced when the caller asked for it explicitly or when the source
 * reply delivery mode is `message_tool_only`, but never when
 * `disableMessageTool` is set (the suppress flag always wins). Compare
 * `src/agents/pi-embedded-runner/run/attempt.ts:1361-1366` and the
 * codex equivalent at
 * `extensions/codex/src/app-server/run-attempt.ts:4253-4258`.
 */
export function shouldForceCopilotMessageTool(params: CopilotToolAttemptParams): boolean {
  if (params.disableMessageTool === true) {
    return false;
  }
  return params.forceMessageTool === true || params.sourceReplyDeliveryMode === "message_tool_only";
}

function filterCopilotToolsForConstructionPlan<T extends { name: string }>(
  tools: T[],
  plan: ReturnType<typeof resolveEmbeddedAttemptToolConstructionPlan>["codingToolConstructionPlan"],
  options: { preserveToolNames?: readonly string[] } = {},
): T[] {
  if (plan.includeBaseCodingTools && plan.includeShellTools) {
    return tools;
  }
  const preserveToolNames = new Set(options.preserveToolNames);
  return tools.filter((tool) => {
    if (preserveToolNames.has(tool.name)) {
      return true;
    }
    if (!plan.includeBaseCodingTools && BASE_COPILOT_CODING_TOOL_NAMES.has(tool.name)) {
      return false;
    }
    if (!plan.includeShellTools && SHELL_COPILOT_CODING_TOOL_NAMES.has(tool.name)) {
      return false;
    }
    return true;
  });
}

function readInlinePluginToolMeta(tool: { name: string }): { pluginId: string } | undefined {
  const pluginId = (tool as { pluginId?: unknown }).pluginId;
  return typeof pluginId === "string" && pluginId.trim() ? { pluginId } : undefined;
}

function findDuplicateToolNames(sourceTools: AnyAgentTool[]): string[] {
  const counts = new Map<string, number>();
  for (const sourceTool of sourceTools) {
    if (typeof sourceTool.name !== "string" || sourceTool.name.length === 0) {
      continue;
    }
    counts.set(sourceTool.name, (counts.get(sourceTool.name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([name]) => name)
    .toSorted();
}

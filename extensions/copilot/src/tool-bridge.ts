// Copilot plugin module implements tool bridge behavior.
import {
  convertMcpCallToolResult,
  type Tool as SdkTool,
  type ToolInvocation,
  type ToolResultObject,
} from "@github/copilot-sdk";
import type {
  AnyAgentTool,
  EmbeddedRunAttemptParams,
  SandboxContext,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  applyEmbeddedAttemptToolsAllow,
  buildEmbeddedAttemptToolRunContext,
  extractToolErrorMessage,
  getPluginToolMeta,
  isSubagentSessionKey,
  isToolResultError,
  resolveAttemptSpawnWorkspaceDir,
  resolveEmbeddedAttemptToolConstructionPlan,
  resolveModelAuthMode,
  sanitizeToolResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { createAgentHarnessToolSurfaceRuntime } from "openclaw/plugin-sdk/agent-harness-tool-runtime";

type CreateOpenClawCodingTools =
  (typeof import("openclaw/plugin-sdk/agent-harness"))["createOpenClawCodingTools"];
type OpenClawCodingToolsOptions = NonNullable<Parameters<CreateOpenClawCodingTools>[0]>;
type AgentHarnessToolSurfaceRuntime = ReturnType<typeof createAgentHarnessToolSurfaceRuntime>;
type CatalogExecuteParams = Parameters<
  NonNullable<AgentHarnessToolSurfaceRuntime["toolSearchCatalogExecutor"]>
>[0];

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
 * Structural subset of `EmbeddedRunAttemptParams` carried into the tool
 * bridge for PI-parity tool context (see
 * `src/agents/pi-embedded-runner/run/attempt.ts:1029-1117` — the
 * authoritative `createOpenClawCodingTools({...})` call shape).
 *
 * Declared as `Partial<EmbeddedRunAttemptParams>` (imported from the
 * `openclaw/plugin-sdk/agent-harness-runtime` boundary, *not* from
 * `attempt.ts` in this extension) to avoid an `attempt.ts` ↔
 * `tool-bridge.ts` import cycle while keeping the field shapes
 * authoritative. Production callers pass the live attempt params; test
 * fixtures may omit this field entirely and fall back to the flat
 * fields below for minimal-config wiring.
 */
type CopilotToolAttemptParams = Partial<EmbeddedRunAttemptParams>;
type CopilotToolTerminalObserver = CopilotToolAttemptParams["observeToolTerminal"];

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
   * Pre-computed `spawnWorkspaceDir` for subagent inheritance. The caller
   * derives this from the *original* workspace via
   * `resolveAttemptSpawnWorkspaceDir({ sandbox, resolvedWorkspace })`.
   * When omitted, the bridge falls back to computing it from the
   * (possibly sandbox-effective) `workspaceDir` it sees; production
   * callers should pass it explicitly so `ro`/`none` sandboxes are
   * handled correctly.
   */
  spawnWorkspaceDir?: string;
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
  attemptParams?: CopilotToolAttemptParams;
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
  onYieldDetected?: (message?: string) => void;
  onToolCompleted?: (completion: CopilotToolCompletion) => void | Promise<void>;
  createOpenClawCodingTools?: (opts: unknown) => AnyAgentTool[] | Promise<AnyAgentTool[]>;
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
  sdkTools: SdkTool[];
  sourceTools: AnyAgentTool[];
}

const SUPPORTED_TOOL_PROVIDERS: ReadonlySet<string> = new Set(["github-copilot"]);
const BASE_COPILOT_CODING_TOOL_NAMES = new Set(["edit", "read", "write"]);
const SHELL_COPILOT_CODING_TOOL_NAMES = new Set(["apply_patch", "exec", "process"]);

function supportsModelTools(modelProvider: string): boolean {
  return SUPPORTED_TOOL_PROVIDERS.has(modelProvider);
}

export async function createCopilotToolBridge(
  input: CopilotToolBridgeInput,
): Promise<CopilotToolBridge> {
  if (!input.allowModelTools && !supportsModelTools(input.modelProvider)) {
    return { sdkTools: [], sourceTools: [] };
  }

  const attemptParams = input.attemptParams ?? ({} as CopilotToolAttemptParams);
  const toolPlan = resolveEmbeddedAttemptToolConstructionPlan({
    disableTools: attemptParams.disableTools,
    forceMessageTool: shouldForceCopilotMessageTool(attemptParams),
    isRawModelRun: isCopilotRawModelRun(attemptParams),
    toolsAllow: attemptParams.toolsAllow,
  });
  const effectiveToolPlan = hasNonWildcardGlobAllowlist(toolPlan.runtimeToolAllowlist)
    ? {
        ...toolPlan,
        codingToolConstructionPlan: {
          includeBaseCodingTools: true,
          includeChannelTools: true,
          includeOpenClawTools: true,
          includePluginTools: true,
          includeShellTools: true,
        },
        constructTools: true,
        includeCoreTools: true,
      }
    : toolPlan;
  if (!effectiveToolPlan.constructTools) {
    return { sdkTools: [], sourceTools: [] };
  }

  const createOpenClawCodingTools =
    input.createOpenClawCodingTools ??
    (await import("openclaw/plugin-sdk/agent-harness")).createOpenClawCodingTools;

  const toolSurfaceRuntime = createAgentHarnessToolSurfaceRuntime({
    abortSignal: input.abortSignal,
    agentId: input.agentId,
    config: attemptParams.config,
    disableTools: attemptParams.disableTools,
    executeTool: (toolParams) => executeCatalogTool(input, toolParams),
    forceMessageTool: shouldForceCopilotMessageTool(attemptParams),
    isRawModelRun: isCopilotRawModelRun(attemptParams),
    modelId: input.modelId,
    modelProvider: input.modelProvider,
    modelToolsEnabled: true,
    prompt: attemptParams.prompt,
    runId: attemptParams.runId,
    runtimeToolAllowlist: effectiveToolPlan.runtimeToolAllowlist,
    sessionId: input.sessionId,
    sessionKey: attemptParams.sandboxSessionKey ?? attemptParams.sessionKey ?? input.sessionKey,
    scheduledToolPolicy: attemptParams.scheduledToolPolicy,
    sourceReplyDeliveryMode: attemptParams.sourceReplyDeliveryMode,
    toolsAllow: attemptParams.toolsAllow,
  });
  const toolOptions = buildOpenClawCodingToolsOptions(
    input,
    {
      ...effectiveToolPlan,
      runtimeToolAllowlist: toolSurfaceRuntime.runtimeToolAllowlist,
    },
    toolSurfaceRuntime,
  );

  let sourceTools: unknown;
  try {
    sourceTools = await createOpenClawCodingTools(toolOptions);
  } catch (error: unknown) {
    throw createError(
      `[copilot-tool-bridge] createOpenClawCodingTools failed: ${toError(error).message}`,
      error,
    );
  }

  if (!Array.isArray(sourceTools)) {
    throw new Error(
      "[copilot-tool-bridge] createOpenClawCodingTools must return an array of tools",
    );
  }

  const allowedSourceTools = filterCopilotToolsForAllowlist(
    sourceTools as AnyAgentTool[],
    toolSurfaceRuntime.runtimeToolAllowlist,
  );
  const compactedTools = toolSurfaceRuntime.compactTools(allowedSourceTools, {
    localModelLeanApplied: true,
  });
  const plannedTools = filterCopilotToolsForConstructionPlan(
    compactedTools.tools,
    effectiveToolPlan.codingToolConstructionPlan,
    { preserveToolNames: toolSurfaceRuntime.runtimeToolAllowlist },
  );
  const filteredTools = filterCopilotToolsForAllowlist(
    plannedTools,
    toolSurfaceRuntime.runtimeToolAllowlist,
  );

  // Run duplicate detection after filtering so a duplicate in a
  // suppressed tool does not fail a narrow run (PI parity: PI never
  // sees the duplicate either when the allowlist excludes it).
  const duplicateNames = findDuplicateToolNames(filteredTools);
  if (duplicateNames.length > 0) {
    throw new Error(`[copilot-tool-bridge] duplicate tool names: ${duplicateNames.join(", ")}`);
  }

  return {
    cleanup: toolSurfaceRuntime.cleanup,
    sdkTools: filteredTools.map((sourceTool) =>
      convertOpenClawToolToSdkTool(sourceTool, {
        abortSignal: input.abortSignal,
        beforeExecute: input.beforeExecute,
        onAgentToolResult: input.attemptParams?.onAgentToolResult,
        onToolCompleted: input.onToolCompleted,
        observeToolTerminal: input.attemptParams?.observeToolTerminal,
      }),
    ),
    sourceTools: filteredTools,
  };
}

/**
 * Builds the full `createOpenClawCodingTools` options bag mirroring the
 * PI in-tree call at `src/agents/pi-embedded-runner/run/attempt.ts:1029-1117`.
 *
 * Why PI parity matters: bridged OpenClaw tools register with the SDK
 * as `overridesBuiltInTool: true, skipPermission: true` (see
 * `convertOpenClawToolToSdkTool` below). That means the wrapped-tool
 * enforcement layer
 * (`src/agents/pi-tools.before-tool-call.ts → wrapToolWithBeforeToolCallHook`)
 * is the single gate for permission, owner-only allowlists, loop
 * detection, trusted-plugin policies, and two-phase plugin approvals.
 * That layer reads its context from the fields forwarded here; missing
 * fields silently degrade policy decisions. See docs/plugins/copilot.md.
 *
 * The shared embedded-runner tool plan is forwarded so the bridge does
 * not construct broad tool families only to filter them later. That
 * preserves PI allowlist semantics such as `write` not materializing
 * `apply_patch`.
 * Sandbox is forwarded via the explicit `sandbox` field on
 * {@link CopilotToolBridgeInput}; callers resolve it via
 * `resolveSandboxContext` before constructing the bridge.
 */
function buildOpenClawCodingToolsOptions(
  input: CopilotToolBridgeInput,
  toolPlan: ReturnType<typeof resolveEmbeddedAttemptToolConstructionPlan>,
  toolSurfaceRuntime?: ReturnType<typeof createAgentHarnessToolSurfaceRuntime>,
): OpenClawCodingToolsOptions {
  const a = input.attemptParams ?? ({} as CopilotToolAttemptParams);

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
  // Sandbox forwarded from the caller (attempt.ts derives it via
  // `resolveSandboxContext`). Wrapped tools that opt into sandbox-aware
  // behavior now see the same policy PI provides. Spawn workspace falls
  // through to the caller-provided value when supplied; otherwise we
  // derive it locally from the (possibly sandbox-effective) workspaceDir
  // — sufficient for legacy/test fixtures that didn't pre-compute it.
  const sandbox = input.sandbox ?? undefined;
  const spawnWorkspaceDir =
    input.spawnWorkspaceDir ??
    (workspaceDir
      ? resolveAttemptSpawnWorkspaceDir({
          sandbox,
          resolvedWorkspace: workspaceDir,
        })
      : undefined);

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
    ...buildEmbeddedAttemptToolRunContext({
      trigger: a.trigger,
      jobId: a.jobId,
      memoryFlushWritePath: a.memoryFlushWritePath,
      toolsAllow: a.toolsAllow,
    }),
    exec: {
      ...a.execOverrides,
      elevated: a.bashElevated,
    },
    messageProvider: a.messageProvider ?? a.messageChannel,
    chatType: a.chatType,
    agentAccountId: a.agentAccountId,
    messageTo: a.messageTo,
    messageThreadId: a.messageThreadId,
    nativeChannelId: a.chatId,
    messageActionTurnCapability: a.messageActionTurnCapability,
    groupId: a.groupId,
    groupChannel: a.groupChannel,
    groupSpace: a.groupSpace,
    memberRoleIds: a.memberRoleIds,
    spawnedBy: a.spawnedBy,
    senderId: a.senderId,
    senderName: a.senderName,
    senderUsername: a.senderUsername,
    senderE164: a.senderE164,
    senderIsOwner: a.senderIsOwner,
    scheduledToolPolicy: a.scheduledToolPolicy,
    allowGatewaySubagentBinding: a.allowGatewaySubagentBinding,
    sessionKey: sandboxSessionKey,
    runSessionKey,
    sessionId: input.sessionId,
    runId: a.runId,
    agentDir,
    workspaceDir,
    cwd,
    // Sandbox parity with PI
    // (`src/agents/pi-embedded-runner/run/attempt.ts:1238-1262`):
    // forwarded from the caller (attempt.ts derives it via
    // `resolveSandboxContext`).
    sandbox,
    spawnWorkspaceDir,
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
    modelContextWindowTokens: model?.contextWindow,
    delegationCapability: a.delegationCapability,
    modelAuthMode: resolveModelAuthMode(input.modelProvider, a.config, undefined, {
      workspaceDir,
    }),
    currentChannelId: a.currentChannelId,
    currentMessagingTarget: a.currentMessagingTarget,
    currentThreadTs: a.currentThreadTs,
    currentMessageId: a.currentMessageId,
    replyToMode: a.replyToMode,
    hasRepliedRef: a.hasRepliedRef,
    modelHasVision,
    requireExplicitMessageTarget:
      a.requireExplicitMessageTarget ?? isSubagentSessionKey(liveSessionKey),
    sourceReplyDeliveryMode: a.sourceReplyDeliveryMode,
    disableMessageTool: a.disableMessageTool,
    forceMessageTool: a.forceMessageTool,
    enableHeartbeatTool: a.enableHeartbeatTool,
    forceHeartbeatTool: a.forceHeartbeatTool,
    authProfileStore: a.toolAuthProfileStore ?? a.authProfileStore,
    computerContextEpoch: input.computerContextEpoch,
    // recordToolPrepStage intentionally omitted: copilot does not
    // surface attempt-stage telemetry yet. Codex omits this too.
    onToolOutcome: a.onToolOutcome,
    onYield: (message) => {
      // Notify the caller first so the final attempt result can carry
      // yieldDetected even if the abort below races a concurrent
      // settle path. Errors thrown by the caller's handler must not
      // skip the abort, so wrap defensively. Mirrors PI (`attempt.ts`
      // sets `yieldDetected = true; yieldMessage = message;` before
      // calling abort) and codex (`onYieldDetected()` runs before the
      // run-abort controller fires).
      try {
        input.onYieldDetected?.(message);
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
  ctx: {
    abortSignal?: AbortSignal;
    beforeExecute?: CopilotToolBridgeInput["beforeExecute"];
    onAgentToolResult?: CopilotToolAttemptParams["onAgentToolResult"];
    onToolCompleted?: CopilotToolBridgeInput["onToolCompleted"];
    observeToolTerminal?: CopilotToolTerminalObserver;
  },
): SdkTool {
  if (typeof sourceTool.name !== "string" || sourceTool.name.trim().length === 0) {
    throw new Error("[copilot-tool-bridge] tool name must be a non-empty string");
  }

  if (typeof sourceTool.execute !== "function") {
    throw new Error(
      `[copilot-tool-bridge] tool '${sourceTool.name}' must define an execute function`,
    );
  }

  let sequentialLock = Promise.resolve();
  const notifyToolResult = (result: unknown, isError: boolean) => {
    try {
      ctx.onAgentToolResult?.({ toolName: sourceTool.name, result, isError });
    } catch (error) {
      console.warn("[copilot-tool-bridge] onAgentToolResult handler threw; continuing", error);
    }
  };
  const notifyToolCompleted = (completion: CopilotToolCompletion) => {
    try {
      void Promise.resolve(ctx.onToolCompleted?.(completion)).catch((error: unknown) => {
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
    const errorMessage = toError(error).message;
    ctx.observeToolTerminal?.({
      toolCallId: invocation.toolCallId,
      toolName: sourceTool.name,
      arguments: executedArgs,
      executionStarted,
      outcome: "failure",
      failure: { error: errorMessage },
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
    if (ctx.abortSignal?.aborted) {
      const error = new Error("[copilot-tool-bridge] aborted before execution");
      return failureResult(args, invocation, startedAt, error.message, error, false);
    }

    try {
      await ctx.beforeExecute?.({
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
        `[copilot-tool-bridge] beforeExecute failed for tool '${sourceTool.name}': ${toError(error).message}`,
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
        `[copilot-tool-bridge] prepareArguments failed for tool '${sourceTool.name}': ${toError(error).message}`,
        error,
        false,
      );
    }

    let result: Awaited<ReturnType<AnyAgentTool["execute"]>>;
    try {
      result = await sourceTool.execute(
        invocation.toolCallId,
        preparedArgs,
        ctx.abortSignal,
        undefined,
      );
    } catch (error: unknown) {
      return failureResult(
        preparedArgs,
        invocation,
        startedAt,
        `[copilot-tool-bridge] tool '${sourceTool.name}' failed: ${toError(error).message}`,
        error,
        true,
      );
    }

    // OpenClaw tools throw for execution failures. Error-shaped details remain
    // lifecycle metadata; successful content uses the SDK's MCP converter.
    const sdkResult = convertMcpCallToolResult({ content: result.content });
    const sanitizedResult = sanitizeToolResult(result);
    const resultIsError = sdkResult.resultType === "failure" || isToolResultError(sanitizedResult);
    const resultError = resultIsError ? extractToolErrorMessage(sanitizedResult) : undefined;
    ctx.observeToolTerminal?.({
      toolCallId: invocation.toolCallId,
      toolName: sourceTool.name,
      arguments: preparedArgs,
      executionStarted: true,
      outcome: resultIsError ? "failure" : "success",
      ...(resultIsError ? { failure: { error: resultError ?? "tool returned an error" } } : {}),
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

  const handler =
    sourceTool.executionMode === "sequential"
      ? (args: unknown, invocation: ToolInvocation) => {
          const run = sequentialLock.then(
            () => executeOnce(args, invocation),
            () => executeOnce(args, invocation),
          );
          sequentialLock = run.then(
            () => undefined,
            () => undefined,
          );
          return run;
        }
      : executeOnce;

  return {
    description: sourceTool.description,
    handler,
    name: sourceTool.name,
    // OpenClaw owns its bridged tools by design (the harness docs:
    // "OpenClaw still owns ... OpenClaw dynamic tools (bridged)"). The bundled
    // Copilot CLI ships built-in tools whose names (edit, read, write, bash,
    // ...) collide with OpenClaw's coding-tool set. Mark every bridged tool as
    // an explicit override so the SDK accepts the registration rather than
    // throwing "External tool 'edit' conflicts with a built-in tool of the
    // same name." OpenClaw's tool layer is the source of truth for these
    // names within a copilot attempt.
    overridesBuiltInTool: true,
    parameters: sourceTool.parameters as Record<string, unknown> | undefined,
    // Bridged OpenClaw tools enforce their own permission/policy decisions
    // inside `wrapToolWithBeforeToolCallHook` (see
    // `src/agents/pi-tools.before-tool-call.ts` — the same hook PI itself
    // uses, providing loop detection, trusted plugin policies,
    // before-tool-call hooks, and two-phase plugin approvals via the
    // gateway). Asking the SDK to fire `onPermissionRequest` for
    // `kind: "custom-tool"` would either short-circuit OpenClaw's richer
    // enforcement (if we allow-all) or block every call (if we
    // reject-all) — neither matches PI parity. The in-tree codex harness
    // takes the same approach: bridged OpenClaw tools are wrapped with
    // `wrapToolWithBeforeToolCallHook` and the SDK gate is bypassed
    // (see `extensions/codex/src/app-server/dynamic-tools.ts`).
    skipPermission: true,
  };
}

async function executeCatalogTool(
  input: CopilotToolBridgeInput,
  params: CatalogExecuteParams,
): Promise<Awaited<ReturnType<AnyAgentTool["execute"]>>> {
  const sourceTool = params.tool as AnyAgentTool;
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
      arguments: preparedArgs,
      executionStarted,
      outcome: isError ? "failure" : "success",
      ...(error ? { failure: { error } } : {}),
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
    const message = toError(error).message;
    // Completion hooks can throw after the tool terminal outcome. Do not
    // rewrite that recorded outcome as a second, contradictory tool failure.
    if (!terminalObserved) {
      input.attemptParams?.observeToolTerminal?.({
        toolCallId: params.toolCallId,
        toolName: params.toolName,
        arguments: preparedArgs,
        executionStarted,
        outcome: "failure",
        failure: { error: message },
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
    error: toError(error).message,
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
 * Returns true when the attempt was launched as a raw-model run, which
 * suppresses tool construction in PI
 * (`src/agents/pi-embedded-runner/run/attempt.ts:1305-1310` and
 * `attempt-tool-construction-plan.ts:165-184`). A run is raw when the
 * caller explicitly sets `modelRun: true` or asks for no system prompt
 * via `promptMode: "none"`.
 */
function isCopilotRawModelRun(params: CopilotToolAttemptParams): boolean {
  return params.modelRun === true || params.promptMode === "none";
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
function shouldForceCopilotMessageTool(params: CopilotToolAttemptParams): boolean {
  if (params.disableMessageTool === true) {
    return false;
  }
  return params.forceMessageTool === true || params.sourceReplyDeliveryMode === "message_tool_only";
}

/**
 * Mirrors PI's `applyEmbeddedAttemptToolsAllow`
 * (`src/agents/embedded-agent-runner/run/attempt-tool-construction-plan.ts`)
 * so final filtering keeps aliases, groups, plugin policies, and glob
 * semantics identical to the in-tree embedded runner.
 */
function filterCopilotToolsForAllowlist<T extends { name: string }>(
  tools: T[],
  toolsAllow?: string[],
): T[] {
  return applyEmbeddedAttemptToolsAllow(tools, toolsAllow, {
    toolMeta: (tool) =>
      getPluginToolMeta(tool as unknown as AnyAgentTool) ?? readInlinePluginToolMeta(tool),
  });
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

function hasNonWildcardGlobAllowlist(toolsAllow: string[] | undefined): boolean {
  return (toolsAllow ?? []).some((entry) => {
    const trimmed = entry.trim();
    return trimmed !== "*" && trimmed.includes("*");
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

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

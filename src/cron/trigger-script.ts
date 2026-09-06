import crypto from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  resolveAdmittedRunActiveAssertion,
  type PreparedAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import {
  resolveAgentConfig,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import { bindAgentToolSourceExecutionGuard } from "../agents/agent-tool-source-execution-guard.js";
import { wrapToolWithAbortSignal } from "../agents/agent-tools.abort.js";
import {
  rewrapToolWithBeforeToolCallHook,
  type HookContext,
} from "../agents/agent-tools.before-tool-call.js";
import {
  createOpenClawCodingTools,
  resolveToolLoopDetectionConfig,
} from "../agents/agent-tools.js";
import { createHeadlessDeadlineScope } from "../agents/code-mode-headless.js";
import type {
  CodeModeNamespaceDescriptor,
  SerializedCodeModeNamespaceValue,
} from "../agents/code-mode-namespaces.js";
import {
  CodeModeHeadlessAbortError,
  CodeModeHeadlessTimeoutError,
  runCodeModeScriptHeadless,
  type CodeModeFailureCode,
  type CodeModeHeadlessResult,
} from "../agents/code-mode.js";
import {
  applyEmbeddedAttemptToolsAllow,
  resolveEmbeddedAttemptToolConstructionPlan,
} from "../agents/embedded-agent-runner/run/attempt-tool-construction-plan.js";
import type { loadPreparedInboundPluginRegistry } from "../agents/prepared-model-runtime.inbound-registry.js";
import { loadAgentRuntimePluginRegistryHandle } from "../agents/runtime-plugins.js";
import { resolveSandboxContext } from "../agents/sandbox.js";
import {
  resolveScheduledToolPolicyContext,
  type ScheduledToolPolicyContext,
} from "../agents/scheduled-tool-policy.js";
import {
  clearToolSearchCatalog,
  createToolSearchCatalogRef,
  registerHeadlessToolSearchCatalog,
  type ToolSearchToolContext,
} from "../agents/tool-search.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import { ensureAgentWorkspace } from "../agents/workspace.js";
import { parseDurationMs } from "../cli/parse-duration.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayContextResolver } from "../gateway/server-methods/types.js";
import { formatErrorMessageWithCode } from "../infra/errors.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import {
  bindGatewayContextResolver,
  withPluginRuntimeRegistryScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { getPluginToolMeta } from "../plugins/tool-metadata.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  resolveCronActiveRuntimeConfig,
  resolveCronAgentConfig,
} from "./isolated-agent/run-config.js";
import { resolveCronAgentSessionKey } from "./isolated-agent/session-key.js";
import { resolveCronScheduledToolPolicy } from "./scheduled-tool-policy.js";
import {
  DEFAULT_CRON_SCRIPT_TIMEOUT_SECONDS,
  DEFAULT_CRON_SCRIPT_TOOL_BUDGET,
  MAX_CRON_SCRIPT_TIMEOUT_SECONDS,
  MAX_CRON_SCRIPT_TOOL_BUDGET,
} from "./script-payload.js";
import type { CronServiceDeps } from "./service/state.js";
import type {
  CronToolsAllowExecTarget,
  CronTriggerEvaluationResult,
  CronTriggerFailureCode,
} from "./types.js";

const MAX_CONCURRENT_TRIGGER_EVALS = 3;
const MAX_TRIGGER_STATE_BYTES = 16 * 1024;
const MAX_CACHED_TRIGGER_RUNTIMES = 128;
const HEADLESS_TRIGGER_WALL_CLOCK_MS = 30_000;
const HEADLESS_TRIGGER_TOOL_BUDGET = 5;

let activeTriggerEvaluations = 0;

// Compile-time sync with the leaf contract in ./types.ts: a new code-mode
// failure code must be added to CronTriggerFailureCode or this line errors.
type AssertTriggerCodesCoverHeadless = [CodeModeFailureCode | "tool_budget_exceeded"] extends [
  CronTriggerFailureCode,
]
  ? true
  : never;
const assertTriggerCodesCoverHeadless: AssertTriggerCodesCoverHeadless = true;
void assertTriggerCodesCoverHeadless;

type PreparedTriggerRuntime = {
  tools: AnyAgentTool[];
  context: HookContext & { config: OpenClawConfig; agentId: string; sessionKey: string };
  pluginRegistry?: PluginRegistry;
};

type CronScriptInvocation = Parameters<NonNullable<CronServiceDeps["evaluateCronTrigger"]>>[0];

type PrepareTriggerRuntime = (params: {
  runtimeConfig: OpenClawConfig;
  jobId: string;
  agentId?: string;
  toolsAllow?: string[];
  scheduledToolPolicy?: ScheduledToolPolicyContext;
  execTarget?: CronToolsAllowExecTarget;
  signal?: AbortSignal;
}) => Promise<PreparedTriggerRuntime>;

type CronTriggerEvaluatorDeps = {
  config: OpenClawConfig;
  runHeadless?: typeof runCodeModeScriptHeadless;
  prepareRuntime?: PrepareTriggerRuntime;
  loadPluginRegistry?: typeof loadPreparedInboundPluginRegistry;
  resolveGatewayContext?: GatewayContextResolver;
};

type TriggerRuntimeCacheEntry = {
  promise: Promise<PreparedTriggerRuntime>;
  configEpoch: OpenClawConfig;
  agentId: string;
  toolsAllowKey: string;
};

function resolveTriggerAgentId(config: OpenClawConfig, agentId?: string): string {
  return agentId?.trim() ? normalizeAgentId(agentId) : resolveDefaultAgentId(config);
}

async function prepareTriggerRuntime(
  params: Parameters<PrepareTriggerRuntime>[0],
  loadPluginRegistry: typeof loadPreparedInboundPluginRegistry = loadAgentRuntimePluginRegistryHandle,
): Promise<PreparedTriggerRuntime> {
  params.signal?.throwIfAborted();
  const agentId = resolveTriggerAgentId(params.runtimeConfig, params.agentId);
  const selectedAgentConfig = resolveAgentConfig(params.runtimeConfig, agentId);
  const agentConfigOverride = params.agentId?.trim() ? selectedAgentConfig : undefined;
  const { agentDefaults, cfgWithAgentDefaults: config } = resolveCronAgentConfig({
    config: params.runtimeConfig,
    agentConfigOverride,
  });
  const workspaceDirRaw = resolveAgentWorkspaceDir(config, agentId);
  const agentDir = resolveAgentDir(config, agentId);
  const { resolveAcpAgentWorkspaceProvisioningForTurn } =
    await import("../agents/acp-workspace-provisioning.js");
  const workspaceProvisioning = await resolveAcpAgentWorkspaceProvisioningForTurn({
    cfg: config,
    agentId,
    workspaceDir: workspaceDirRaw,
  });
  const workspace = await ensureAgentWorkspace({
    dir: workspaceDirRaw,
    ensureBootstrapFiles: !agentDefaults.skipBootstrap,
    skipOptionalBootstrapFiles: agentDefaults.skipOptionalBootstrapFiles,
    provisioning: workspaceProvisioning,
  });
  params.signal?.throwIfAborted();
  const workspaceDir = workspace.dir;
  const pluginRegistry = loadPluginRegistry({
    config,
    workspaceDir,
    allowGatewaySubagentBinding: true,
  });

  const prepare = async (): Promise<PreparedTriggerRuntime> => {
    const rawSessionKey = `cron:${params.jobId}:trigger`;
    const sessionKey = resolveCronAgentSessionKey({
      sessionKey: rawSessionKey,
      agentId,
      mainKey: config.session?.mainKey,
      cfg: config,
    });
    const sandbox = await resolveSandboxContext({
      config,
      sessionKey,
      workspaceDir,
    });
    params.signal?.throwIfAborted();
    const effectiveWorkspace =
      sandbox?.enabled && sandbox.workspaceAccess !== "rw" ? sandbox.workspaceDir : workspaceDir;
    const toolPlan = resolveEmbeddedAttemptToolConstructionPlan({
      toolsEnabled: true,
      toolsAllow: params.toolsAllow,
    });
    // Bundle MCP tools are source:"mcp", which the headless bridge excludes.
    // LSP runtimes are session-scoped and intentionally outside trigger v1.
    const allTools = toolPlan.constructTools
      ? createOpenClawCodingTools({
          agentId,
          exec: { config },
          sandbox,
          sessionKey,
          trigger: "cron",
          jobId: params.jobId,
          agentDir,
          cwd: effectiveWorkspace,
          workspaceDir: effectiveWorkspace,
          spawnWorkspaceDir: workspaceDir,
          config,
          allowGatewaySubagentBinding: true,
          includeCoreTools: toolPlan.includeCoreTools,
          runtimeToolAllowlist: toolPlan.runtimeToolAllowlist,
          inheritRuntimeToolAllowlist: Boolean(toolPlan.runtimeToolAllowlist),
          scheduledToolPolicy: resolveScheduledToolPolicyContext({
            toolsAllow: params.toolsAllow,
            scheduledToolPolicy: params.scheduledToolPolicy,
            execTarget: params.execTarget,
          }),
          toolConstructionPlan: toolPlan.codingToolConstructionPlan,
        })
      : [];
    const tools = applyEmbeddedAttemptToolsAllow(allTools, params.toolsAllow, {
      toolMeta: (tool) => getPluginToolMeta(tool),
    });
    const context = {
      agentId,
      config,
      cwd: effectiveWorkspace,
      workspaceDir: effectiveWorkspace,
      sessionKey,
      loopDetection: resolveToolLoopDetectionConfig({ cfg: config, agentId }),
    };
    return {
      tools,
      context,
      ...(pluginRegistry ? { pluginRegistry } : {}),
    };
  };
  return await withPluginRuntimeRegistryScope(pluginRegistry, prepare);
}

function triggerStateNamespace(state: unknown, streamBatch?: string): CodeModeNamespaceDescriptor {
  const entries: Array<[string, SerializedCodeModeNamespaceValue]> = [
    ["state", { kind: "value", value: state }],
  ];
  if (streamBatch !== undefined) {
    entries.push(["streamBatch", { kind: "value", value: streamBatch }]);
  }
  return {
    id: "cron:trigger",
    globalName: "trigger",
    scope: {
      kind: "object",
      entries,
    },
  };
}

function scriptResultCandidate(
  result: Extract<CodeModeHeadlessResult, { status: "completed" }>,
  condition = false,
) {
  if (isRecord(result.value) && (!condition || typeof result.value.fire === "boolean")) {
    return result.value;
  }
  for (let index = result.output.length - 1; index >= 0; index -= 1) {
    const entry = result.output[index];
    if (isRecord(entry) && entry.type === "json") {
      return entry.value;
    }
  }
  return undefined;
}

function scriptFailure(
  error: string,
  code: CronTriggerFailureCode = "internal_error",
): Extract<CronTriggerEvaluationResult, { kind: "error" }> {
  return { kind: "error", code, error };
}

function parseTriggerResult(
  result: Extract<CodeModeHeadlessResult, { status: "completed" }>,
): CronTriggerEvaluationResult {
  const candidate = scriptResultCandidate(result, true);
  if (!isRecord(candidate) || typeof candidate.fire !== "boolean") {
    return scriptFailure("cron trigger script must return an object with boolean fire");
  }
  if (candidate.message !== undefined && typeof candidate.message !== "string") {
    return scriptFailure("cron trigger script message must be a string");
  }
  const state = validateCronState(candidate, "cron trigger");
  if (!state.ok) {
    return scriptFailure(state.error, state.code);
  }
  return {
    kind: "evaluated",
    fire: candidate.fire,
    ...(typeof candidate.message === "string" ? { message: candidate.message } : {}),
    ...(state.stateChanged ? { state: state.state } : {}),
  };
}

function createCronCodeModeRunner(deps: CronTriggerEvaluatorDeps) {
  const runHeadless = deps.runHeadless ?? runCodeModeScriptHeadless;
  const prepareRuntime =
    deps.prepareRuntime ?? ((params) => prepareTriggerRuntime(params, deps.loadPluginRegistry));
  // Config identity is the reload epoch; caching the preparation promise makes
  // concurrent cold evaluations for one job single-flight.
  const runtimeCache = new Map<string, TriggerRuntimeCacheEntry>();

  const resolveCachedRuntime = async (
    request: Parameters<PrepareTriggerRuntime>[0],
    scope: ReturnType<typeof createHeadlessDeadlineScope>,
  ): Promise<PreparedTriggerRuntime> => {
    const agentId = resolveTriggerAgentId(request.runtimeConfig, request.agentId);
    const toolsAllowKey = JSON.stringify([
      request.toolsAllow ?? null,
      request.scheduledToolPolicy ?? null,
      request.execTarget ?? null,
    ]);
    const cached = runtimeCache.get(request.jobId);
    if (
      cached &&
      cached.configEpoch === request.runtimeConfig &&
      cached.agentId === agentId &&
      cached.toolsAllowKey === toolsAllowKey
    ) {
      runtimeCache.delete(request.jobId);
      runtimeCache.set(request.jobId, cached);
      try {
        return await scope.wait(cached.promise);
      } catch (error) {
        const ownerCanceled =
          error instanceof CodeModeHeadlessAbortError ||
          error instanceof CodeModeHeadlessTimeoutError;
        if (ownerCanceled && !scope.signal.aborted) {
          // A different caller owned and ended the shared cold preparation.
          // Retry under this still-live caller instead of inheriting its abort.
          if (runtimeCache.get(request.jobId) === cached) {
            runtimeCache.delete(request.jobId);
          }
          return await resolveCachedRuntime(request, scope);
        }
        throw error;
      }
    }
    const promise = prepareRuntime({ ...request, signal: scope.signal });
    const entry: TriggerRuntimeCacheEntry = {
      promise,
      configEpoch: request.runtimeConfig,
      agentId,
      toolsAllowKey,
    };
    runtimeCache.delete(request.jobId);
    runtimeCache.set(request.jobId, entry);
    pruneMapToMaxSize(runtimeCache, MAX_CACHED_TRIGGER_RUNTIMES);
    // Failed preparations evict themselves so the next tick retries cold.
    void promise.catch(() => {
      if (runtimeCache.get(request.jobId) === entry) {
        runtimeCache.delete(request.jobId);
      }
    });
    return await scope.wait(entry.promise);
  };

  return async function runCronCodeModeScript(
    params: CronScriptInvocation & {
      wallClockMs: number;
      maxToolCalls: number;
      label: string;
      onExecutionStarted?: () => void;
    },
  ): Promise<
    | { kind: "completed"; result: Extract<CodeModeHeadlessResult, { status: "completed" }> }
    | { kind: "error"; code: CronTriggerFailureCode; error: string }
  > {
    const evaluationScope = createHeadlessDeadlineScope(
      params.abortSignal,
      params.wallClockMs,
      params.label,
    );
    const catalogRef = createToolSearchCatalogRef();
    let admission: PreparedAgentRunAdmission | undefined;
    try {
      const runtime = await resolveCachedRuntime(
        {
          runtimeConfig: resolveCronActiveRuntimeConfig(deps.config),
          jobId: params.job.id,
          agentId: params.job.agentId,
          toolsAllow: params.job.payload.toolsAllow,
          scheduledToolPolicy: resolveCronScheduledToolPolicy({
            toolsAllow: params.job.payload.toolsAllow,
            scheduledToolPolicy: params.job.scheduledToolPolicy,
            owner: params.job.owner,
          }),
          execTarget: params.job.toolsAllowExecTarget,
        },
        evaluationScope,
      );

      const runId = `cron-trigger:${params.job.id}:${crypto.randomUUID()}`;
      admission = prepareAgentRunAdmission({
        cfg: runtime.context.config,
        operationalRunInstance: createOperationalRunInstanceRef(runId),
        facts: {
          runId,
          agentId: runtime.context.agentId,
          ingress: params.executionIdentity?.ingress ?? {
            kind: "schedule",
            boundary: "cron.script",
            state: "present",
          },
          ...(params.executionIdentity?.invoker
            ? { invoker: params.executionIdentity.invoker }
            : {}),
        },
      });
      const admitted = await admission.admit("gateway");
      bindGatewayContextResolver(admitted, deps.resolveGatewayContext);
      params.executionIdentity?.onPostAdmission?.(admitted);
      const assertAdmitted = resolveAdmittedRunActiveAssertion(admitted, evaluationScope.signal);
      const caller = createAdmittedGatewayToolCallerIdentity({
        admittedRunContext: admitted,
        agentId: runtime.context.agentId,
        sessionKey: runtime.context.sessionKey,
        receiptAuthority: assertActive,
        approvalSignals: [evaluationScope.signal],
      });
      function assertActive() {
        if (
          !assertAdmitted ||
          !caller ||
          (caller.gatewayContextResolver && !caller.gatewayContextResolver())
        ) {
          throw new Error("cron script invocation is no longer active");
        }
        assertAdmitted();
      }
      const ctx: ToolSearchToolContext = {
        ...runtime.context,
        runtimeConfig: runtime.context.config,
        runId,
        catalogRef,
        abortSignal: evaluationScope.signal,
        executeTool: (call) =>
          withGatewayToolCallerIdentity(caller, async () => {
            assertActive();
            // Guard the final wrapper so catalog preparation cannot discard the invocation fence.
            const tool = wrapToolWithAbortSignal(
              rewrapToolWithBeforeToolCallHook(
                // SAFETY: Headless registration and preparation retain AnyAgentTool instances.
                bindAgentToolSourceExecutionGuard(call.tool as AnyAgentTool, assertActive),
              ),
              evaluationScope.signal,
            );
            const result = await tool.execute(
              call.toolCallId,
              call.input,
              call.signal,
              call.onUpdate,
            );
            assertActive();
            return await call.acceptResultBeforeProjection(result);
          }),
      };

      return await withPluginRuntimeRegistryScope(runtime.pluginRegistry, async () => {
        assertActive();
        registerHeadlessToolSearchCatalog({
          catalogRef,
          tools: runtime.tools,
          hookContext: { ...runtime.context, runId },
        });
        const remainingWallClockMs = Math.ceil(evaluationScope.deadline - performance.now());
        if (remainingWallClockMs <= 0) {
          throw new CodeModeHeadlessTimeoutError(`${params.label} timed out`);
        }
        params.onExecutionStarted?.();
        assertActive();
        const result = await runHeadless({
          ctx,
          code: params.script,
          wallClockMs: remainingWallClockMs,
          maxToolCalls: params.maxToolCalls,
          extraNamespaces: [triggerStateNamespace(params.state, params.streamBatch)],
          signal: evaluationScope.signal,
        });
        if (result.status === "failed") {
          return scriptFailure(result.error, result.code);
        }
        assertActive();
        return { kind: "completed" as const, result };
      });
    } catch (error) {
      return scriptFailure(
        formatErrorMessageWithCode(error),
        error instanceof CodeModeHeadlessTimeoutError
          ? "timeout"
          : error instanceof CodeModeHeadlessAbortError
            ? "aborted"
            : "internal_error",
      );
    } finally {
      admission?.close();
      clearToolSearchCatalog({ catalogRef });
      evaluationScope.cleanup();
    }
  };
}

type CronScriptPayloadExecutionResult =
  | {
      kind: "completed";
      notify?: string;
      wake?: "now" | "next-heartbeat";
      stateChanged: boolean;
      state?: unknown;
      nextCheck?: { delayMs: number };
    }
  | { kind: "error"; code: CronTriggerFailureCode; error: string };

function validateCronState(candidate: Record<string, unknown>, label: string) {
  if (!Object.hasOwn(candidate, "state")) {
    return { ok: true as const, stateChanged: false as const };
  }
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(candidate.state);
  } catch (error) {
    return {
      ok: false as const,
      code: "internal_error" as const,
      error: `${label} state is not JSON-serializable: ${formatErrorMessageWithCode(error)}`,
    };
  }
  if (serialized === undefined) {
    return {
      ok: false as const,
      code: "internal_error" as const,
      error: `${label} state is not JSON-serializable`,
    };
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_TRIGGER_STATE_BYTES) {
    return {
      ok: false as const,
      code: "output_limit_exceeded" as const,
      error: `${label} state exceeds the 16KB limit`,
    };
  }
  return {
    ok: true as const,
    stateChanged: true as const,
    state: JSON.parse(serialized) as unknown,
  };
}

function parseScriptPayloadResult(
  result: Extract<CodeModeHeadlessResult, { status: "completed" }>,
): CronScriptPayloadExecutionResult {
  const candidate = scriptResultCandidate(result);
  if (!isRecord(candidate)) {
    return scriptFailure("cron script payload must return an object");
  }
  if (candidate.notify !== undefined && typeof candidate.notify !== "string") {
    return scriptFailure("cron script payload notify must be a string");
  }
  if (
    candidate.wake !== undefined &&
    candidate.wake !== "now" &&
    candidate.wake !== "next-heartbeat"
  ) {
    return scriptFailure('cron script payload wake must be "now" or "next-heartbeat"');
  }
  let nextCheck: { delayMs: number } | undefined;
  if (candidate.nextCheck !== undefined) {
    if (typeof candidate.nextCheck !== "string") {
      return scriptFailure("cron script payload nextCheck must be a duration string");
    }
    try {
      const delayMs = parseDurationMs(candidate.nextCheck);
      if (delayMs <= 0) {
        throw new Error("duration must be positive");
      }
      nextCheck = { delayMs };
    } catch {
      return scriptFailure("cron script payload nextCheck must be a positive duration");
    }
  }
  const state = validateCronState(candidate, "cron script payload");
  if (!state.ok) {
    return scriptFailure(state.error, state.code);
  }
  return {
    kind: "completed",
    ...(candidate.notify !== undefined ? { notify: candidate.notify } : {}),
    ...(candidate.wake !== undefined ? { wake: candidate.wake } : {}),
    stateChanged: state.stateChanged,
    ...(state.stateChanged ? { state: state.state } : {}),
    ...(nextCheck ? { nextCheck } : {}),
  };
}

export function createCronScriptRuntime(deps: CronTriggerEvaluatorDeps) {
  const run = createCronCodeModeRunner(deps);
  return {
    evaluateTrigger: async (params: CronScriptInvocation): Promise<CronTriggerEvaluationResult> => {
      if (activeTriggerEvaluations >= MAX_CONCURRENT_TRIGGER_EVALS) {
        return { kind: "busy" };
      }
      activeTriggerEvaluations += 1;
      try {
        const outcome = await run({
          ...params,
          wallClockMs: HEADLESS_TRIGGER_WALL_CLOCK_MS,
          maxToolCalls: HEADLESS_TRIGGER_TOOL_BUDGET,
          label: "cron trigger evaluation",
        });
        return outcome.kind === "completed" ? parseTriggerResult(outcome.result) : outcome;
      } finally {
        activeTriggerEvaluations -= 1;
      }
    },
    executePayload: async (
      params: Parameters<NonNullable<CronServiceDeps["runScriptJob"]>>[0],
    ): Promise<CronScriptPayloadExecutionResult> => {
      const payload = params.job.payload;
      if (payload.kind !== "script") {
        return scriptFailure("cron script payload executor is unavailable", "runtime_unavailable");
      }
      const timeoutSeconds = Math.min(
        MAX_CRON_SCRIPT_TIMEOUT_SECONDS,
        Math.max(1, Math.floor(payload.timeoutSeconds ?? DEFAULT_CRON_SCRIPT_TIMEOUT_SECONDS)),
      );
      const toolBudget = Math.min(
        MAX_CRON_SCRIPT_TOOL_BUDGET,
        Math.max(1, Math.floor(payload.toolBudget ?? DEFAULT_CRON_SCRIPT_TOOL_BUDGET)),
      );
      const outcome = await run({
        ...params,
        script: payload.script,
        state: params.job.state.triggerState,
        wallClockMs: timeoutSeconds * 1000,
        maxToolCalls: toolBudget,
        label: "cron script payload",
        onExecutionStarted: params.executionIdentity?.onExecutionStarted,
      });
      return outcome.kind === "completed" ? parseScriptPayloadResult(outcome.result) : outcome;
    },
  };
}

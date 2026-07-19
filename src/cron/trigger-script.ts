import crypto from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  resolveAgentConfig,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import type { HookContext } from "../agents/agent-tools.before-tool-call.js";
import {
  createOpenClawCodingTools,
  resolveToolLoopDetectionConfig,
} from "../agents/agent-tools.js";
import type { CodeModeNamespaceDescriptor } from "../agents/code-mode-namespaces.js";
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
import { ensureRuntimePluginsLoaded } from "../agents/runtime-plugins.js";
import { resolveSandboxContext } from "../agents/sandbox.js";
import {
  createToolSearchCatalogRef,
  registerHeadlessToolSearchCatalog,
  type ToolSearchToolContext,
} from "../agents/tool-search.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { ensureAgentWorkspace } from "../agents/workspace.js";
import { parseDurationMs } from "../cli/parse-duration.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getPluginToolMeta } from "../plugins/tools.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  buildCronAgentDefaultsConfig,
  resolveCronActiveRuntimeConfig,
} from "./isolated-agent/run-config.js";
import { resolveCronAgentSessionKey } from "./isolated-agent/session-key.js";
import {
  DEFAULT_CRON_SCRIPT_TIMEOUT_SECONDS,
  DEFAULT_CRON_SCRIPT_TOOL_BUDGET,
  MAX_CRON_SCRIPT_TIMEOUT_SECONDS,
  MAX_CRON_SCRIPT_TOOL_BUDGET,
} from "./script-payload.js";
import type { CronTriggerEvaluationResult, CronTriggerFailureCode } from "./types.js";

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
  ctx: Omit<ToolSearchToolContext, "catalogRef">;
  hookContext: Omit<HookContext, "runId">;
};

type PrepareTriggerRuntime = (params: {
  runtimeConfig: OpenClawConfig;
  jobId: string;
  agentId?: string;
  toolsAllow?: string[];
  signal?: AbortSignal;
}) => Promise<PreparedTriggerRuntime>;

type CronTriggerEvaluatorDeps = {
  config: OpenClawConfig;
  runHeadless?: typeof runCodeModeScriptHeadless;
  prepareRuntime?: PrepareTriggerRuntime;
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

async function prepareTriggerRuntime(params: {
  runtimeConfig: OpenClawConfig;
  jobId: string;
  agentId?: string;
  toolsAllow?: string[];
  signal?: AbortSignal;
}): Promise<PreparedTriggerRuntime> {
  params.signal?.throwIfAborted();
  const agentId = resolveTriggerAgentId(params.runtimeConfig, params.agentId);
  const selectedAgentConfig = resolveAgentConfig(params.runtimeConfig, agentId);
  const agentConfigOverride = params.agentId?.trim() ? selectedAgentConfig : undefined;
  const agentDefaults = buildCronAgentDefaultsConfig({
    defaults: params.runtimeConfig.agents?.defaults,
    agentConfigOverride,
  });
  const config: OpenClawConfig = {
    ...params.runtimeConfig,
    agents: Object.assign({}, params.runtimeConfig.agents, { defaults: agentDefaults }),
  };
  const workspaceDirRaw = resolveAgentWorkspaceDir(config, agentId);
  const agentDir = resolveAgentDir(config, agentId);
  const workspace = await ensureAgentWorkspace({
    dir: workspaceDirRaw,
    ensureBootstrapFiles: !agentDefaults.skipBootstrap,
    skipOptionalBootstrapFiles: agentDefaults.skipOptionalBootstrapFiles,
  });
  params.signal?.throwIfAborted();
  const workspaceDir = workspace.dir;
  ensureRuntimePluginsLoaded({
    config,
    workspaceDir,
    allowGatewaySubagentBinding: true,
  });

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
        toolConstructionPlan: toolPlan.codingToolConstructionPlan,
      })
    : [];
  const tools = applyEmbeddedAttemptToolsAllow(allTools, params.toolsAllow, {
    toolMeta: (tool) => getPluginToolMeta(tool),
  });
  const hookContext: HookContext = {
    agentId,
    config,
    cwd: effectiveWorkspace,
    workspaceDir: effectiveWorkspace,
    sessionKey,
    loopDetection: resolveToolLoopDetectionConfig({ cfg: config, agentId }),
  };
  return {
    tools,
    hookContext,
    ctx: {
      config,
      runtimeConfig: config,
      agentId,
      sessionKey,
    },
  };
}

function triggerStateNamespace(state: unknown): CodeModeNamespaceDescriptor {
  return {
    id: "cron:trigger",
    globalName: "trigger",
    scope: {
      kind: "object",
      entries: [["state", { kind: "value", value: state }]],
    },
  };
}

function triggerResultCandidate(result: Extract<CodeModeHeadlessResult, { status: "completed" }>) {
  if (isRecord(result.value) && typeof result.value.fire === "boolean") {
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

function scriptPayloadResultCandidate(
  result: Extract<CodeModeHeadlessResult, { status: "completed" }>,
) {
  if (isRecord(result.value)) {
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

function parseTriggerResult(
  result: Extract<CodeModeHeadlessResult, { status: "completed" }>,
): CronTriggerEvaluationResult {
  const candidate = triggerResultCandidate(result);
  if (!isRecord(candidate) || typeof candidate.fire !== "boolean") {
    return {
      kind: "error",
      code: "internal_error",
      error: "cron trigger script must return an object with boolean fire",
    };
  }
  if (candidate.message !== undefined && typeof candidate.message !== "string") {
    return {
      kind: "error",
      code: "internal_error",
      error: "cron trigger script message must be a string",
    };
  }
  const state = validateCronState(candidate, "cron trigger");
  if (!state.ok) {
    return { kind: "error", code: state.code, error: state.error };
  }
  return {
    kind: "evaluated",
    fire: candidate.fire,
    ...(typeof candidate.message === "string" ? { message: candidate.message } : {}),
    ...(state.stateChanged ? { state: state.state } : {}),
  };
}

function createHeadlessDeadlineScope(params: {
  externalSignal?: AbortSignal;
  wallClockMs: number;
  label: string;
}) {
  const controller = new AbortController();
  const onExternalAbort = () =>
    controller.abort(new CodeModeHeadlessAbortError(`${params.label} aborted`));
  params.externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  if (params.externalSignal?.aborted) {
    onExternalAbort();
  }
  const timer = setTimeout(
    () => controller.abort(new CodeModeHeadlessTimeoutError(`${params.label} timed out`)),
    params.wallClockMs,
  );
  return {
    deadline: Date.now() + params.wallClockMs,
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      params.externalSignal?.removeEventListener("abort", onExternalAbort);
    },
  };
}

async function awaitTriggerSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new CodeModeHeadlessAbortError();
  }
  let onAbort: (() => void) | undefined;
  try {
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () =>
        reject(signal.reason instanceof Error ? signal.reason : new CodeModeHeadlessAbortError());
      signal.addEventListener("abort", onAbort, { once: true });
    });
    return await Promise.race([promise, aborted]);
  } finally {
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

function createCronCodeModeRunner(deps: CronTriggerEvaluatorDeps) {
  const runHeadless = deps.runHeadless ?? runCodeModeScriptHeadless;
  const prepareRuntime = deps.prepareRuntime ?? prepareTriggerRuntime;
  // Config identity is the reload epoch; caching the preparation promise makes
  // concurrent cold evaluations for one job single-flight.
  const runtimeCache = new Map<string, TriggerRuntimeCacheEntry>();

  const trimRuntimeCache = () => {
    while (runtimeCache.size > MAX_CACHED_TRIGGER_RUNTIMES) {
      const oldestJobId = runtimeCache.keys().next().value;
      if (oldestJobId === undefined) {
        return;
      }
      runtimeCache.delete(oldestJobId);
    }
  };
  const resolveCachedRuntime = async (request: {
    runtimeConfig: OpenClawConfig;
    jobId: string;
    requestedAgentId?: string;
    agentId: string;
    toolsAllow?: string[];
    toolsAllowKey: string;
    signal: AbortSignal;
  }): Promise<PreparedTriggerRuntime> => {
    const cached = runtimeCache.get(request.jobId);
    if (
      cached &&
      cached.configEpoch === request.runtimeConfig &&
      cached.agentId === request.agentId &&
      cached.toolsAllowKey === request.toolsAllowKey
    ) {
      runtimeCache.delete(request.jobId);
      runtimeCache.set(request.jobId, cached);
      try {
        return await awaitTriggerSignal(cached.promise, request.signal);
      } catch (error) {
        const ownerCanceled =
          error instanceof CodeModeHeadlessAbortError ||
          error instanceof CodeModeHeadlessTimeoutError;
        if (ownerCanceled && !request.signal.aborted) {
          // A different caller owned and ended the shared cold preparation.
          // Retry under this still-live caller instead of inheriting its abort.
          if (runtimeCache.get(request.jobId) === cached) {
            runtimeCache.delete(request.jobId);
          }
          return await resolveCachedRuntime(request);
        }
        throw error;
      }
    }
    const promise = prepareRuntime({
      runtimeConfig: request.runtimeConfig,
      jobId: request.jobId,
      agentId: request.requestedAgentId,
      toolsAllow: request.toolsAllow,
      signal: request.signal,
    });
    const entry: TriggerRuntimeCacheEntry = {
      promise,
      configEpoch: request.runtimeConfig,
      agentId: request.agentId,
      toolsAllowKey: request.toolsAllowKey,
    };
    runtimeCache.delete(request.jobId);
    runtimeCache.set(request.jobId, entry);
    trimRuntimeCache();
    // Failed preparations evict themselves so the next tick retries cold.
    void promise.catch(() => {
      if (runtimeCache.get(request.jobId) === entry) {
        runtimeCache.delete(request.jobId);
      }
    });
    return await awaitTriggerSignal(entry.promise, request.signal);
  };

  return async function runCronCodeModeScript(params: {
    jobId: string;
    agentId?: string;
    script: string;
    toolsAllow?: string[];
    abortSignal?: AbortSignal;
    wallClockMs: number;
    maxToolCalls: number;
    label: string;
    namespaces: CodeModeNamespaceDescriptor[];
  }): Promise<
    | { kind: "completed"; result: Extract<CodeModeHeadlessResult, { status: "completed" }> }
    | { kind: "error"; code: CronTriggerFailureCode; error: string }
  > {
    const evaluationScope = createHeadlessDeadlineScope({
      externalSignal: params.abortSignal,
      wallClockMs: params.wallClockMs,
      label: params.label,
    });
    try {
      const runtimeConfig = resolveCronActiveRuntimeConfig(deps.config);
      const agentId = resolveTriggerAgentId(runtimeConfig, params.agentId);
      const toolsAllowKey = JSON.stringify(params.toolsAllow ?? null);
      const runtime = await resolveCachedRuntime({
        runtimeConfig,
        jobId: params.jobId,
        requestedAgentId: params.agentId,
        agentId,
        toolsAllow: params.toolsAllow,
        toolsAllowKey,
        signal: evaluationScope.signal,
      });

      const catalogRef = createToolSearchCatalogRef();
      const runId = `cron-trigger:${params.jobId}:${crypto.randomUUID()}`;
      registerHeadlessToolSearchCatalog({
        catalogRef,
        tools: runtime.tools,
        hookContext: { ...runtime.hookContext, runId },
      });
      const remainingWallClockMs = evaluationScope.deadline - Date.now();
      if (remainingWallClockMs <= 0) {
        throw new CodeModeHeadlessTimeoutError(`${params.label} timed out`);
      }
      const result = await runHeadless({
        ctx: { ...runtime.ctx, catalogRef, abortSignal: evaluationScope.signal },
        code: params.script,
        wallClockMs: remainingWallClockMs,
        maxToolCalls: params.maxToolCalls,
        extraNamespaces: params.namespaces,
        signal: evaluationScope.signal,
      });
      if (result.status === "failed") {
        return { kind: "error", code: result.code, error: result.error };
      }
      return { kind: "completed", result };
    } catch (error) {
      return {
        kind: "error",
        code:
          error instanceof CodeModeHeadlessTimeoutError
            ? "timeout"
            : error instanceof CodeModeHeadlessAbortError
              ? "aborted"
              : "internal_error",
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
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
      error: `${label} state is not JSON-serializable: ${String(error)}`,
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
  const candidate = scriptPayloadResultCandidate(result);
  if (!isRecord(candidate)) {
    return {
      kind: "error",
      code: "internal_error",
      error: "cron script payload must return an object",
    };
  }
  if (candidate.notify !== undefined && typeof candidate.notify !== "string") {
    return {
      kind: "error",
      code: "internal_error",
      error: "cron script payload notify must be a string",
    };
  }
  if (
    candidate.wake !== undefined &&
    candidate.wake !== "now" &&
    candidate.wake !== "next-heartbeat"
  ) {
    return {
      kind: "error",
      code: "internal_error",
      error: 'cron script payload wake must be "now" or "next-heartbeat"',
    };
  }
  let nextCheck: { delayMs: number } | undefined;
  if (candidate.nextCheck !== undefined) {
    if (typeof candidate.nextCheck !== "string") {
      return {
        kind: "error",
        code: "internal_error",
        error: "cron script payload nextCheck must be a duration string",
      };
    }
    try {
      const delayMs = parseDurationMs(candidate.nextCheck);
      if (delayMs <= 0) {
        throw new Error("duration must be positive");
      }
      nextCheck = { delayMs };
    } catch {
      return {
        kind: "error",
        code: "internal_error",
        error: "cron script payload nextCheck must be a positive duration",
      };
    }
  }
  const state = validateCronState(candidate, "cron script payload");
  if (!state.ok) {
    return { kind: "error", code: state.code, error: state.error };
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
    evaluateTrigger: async (params: {
      jobId: string;
      agentId?: string;
      script: string;
      state: unknown;
      toolsAllow?: string[];
      abortSignal?: AbortSignal;
    }): Promise<CronTriggerEvaluationResult> => {
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
          namespaces: [triggerStateNamespace(params.state)],
        });
        return outcome.kind === "completed" ? parseTriggerResult(outcome.result) : outcome;
      } finally {
        activeTriggerEvaluations -= 1;
      }
    },
    executePayload: async (params: {
      jobId: string;
      agentId?: string;
      script: string;
      state: unknown;
      toolsAllow?: string[];
      timeoutSeconds?: number;
      toolBudget?: number;
      abortSignal?: AbortSignal;
    }): Promise<CronScriptPayloadExecutionResult> => {
      const timeoutSeconds = Math.min(
        MAX_CRON_SCRIPT_TIMEOUT_SECONDS,
        Math.max(1, Math.floor(params.timeoutSeconds ?? DEFAULT_CRON_SCRIPT_TIMEOUT_SECONDS)),
      );
      const toolBudget = Math.min(
        MAX_CRON_SCRIPT_TOOL_BUDGET,
        Math.max(1, Math.floor(params.toolBudget ?? DEFAULT_CRON_SCRIPT_TOOL_BUDGET)),
      );
      const outcome = await run({
        ...params,
        wallClockMs: timeoutSeconds * 1000,
        maxToolCalls: toolBudget,
        label: "cron script payload",
        namespaces: [triggerStateNamespace(params.state)],
      });
      return outcome.kind === "completed" ? parseScriptPayloadResult(outcome.result) : outcome;
    },
  };
}

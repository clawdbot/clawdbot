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
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getPluginToolMeta } from "../plugins/tools.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  buildCronAgentDefaultsConfig,
  resolveCronActiveRuntimeConfig,
} from "./isolated-agent/run-config.js";
import { resolveCronAgentSessionKey } from "./isolated-agent/session-key.js";
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
  const hasState = Object.hasOwn(candidate, "state");
  if (hasState) {
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(candidate.state);
    } catch (error) {
      return {
        kind: "error",
        code: "internal_error",
        error: `cron trigger state is not JSON-serializable: ${String(error)}`,
      };
    }
    if (serialized === undefined) {
      return {
        kind: "error",
        code: "internal_error",
        error: "cron trigger state is not JSON-serializable",
      };
    }
    if (Buffer.byteLength(serialized, "utf8") > MAX_TRIGGER_STATE_BYTES) {
      return {
        kind: "error",
        code: "output_limit_exceeded",
        error: "cron trigger state exceeds the 16KB limit",
      };
    }
  }
  return {
    kind: "evaluated",
    fire: candidate.fire,
    ...(typeof candidate.message === "string" ? { message: candidate.message } : {}),
    ...(hasState ? { state: candidate.state } : {}),
  };
}

function createTriggerDeadlineScope(externalSignal?: AbortSignal) {
  const controller = new AbortController();
  const onExternalAbort = () =>
    controller.abort(new CodeModeHeadlessAbortError("cron trigger evaluation aborted"));
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  if (externalSignal?.aborted) {
    onExternalAbort();
  }
  const timer = setTimeout(
    () => controller.abort(new CodeModeHeadlessTimeoutError("cron trigger evaluation timed out")),
    HEADLESS_TRIGGER_WALL_CLOCK_MS,
  );
  return {
    deadline: Date.now() + HEADLESS_TRIGGER_WALL_CLOCK_MS,
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onExternalAbort);
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

export function createCronTriggerEvaluator(deps: CronTriggerEvaluatorDeps) {
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

  return async function evaluateCronTrigger(params: {
    jobId: string;
    agentId?: string;
    script: string;
    state: unknown;
    toolsAllow?: string[];
    abortSignal?: AbortSignal;
  }): Promise<CronTriggerEvaluationResult> {
    if (activeTriggerEvaluations >= MAX_CONCURRENT_TRIGGER_EVALS) {
      return { kind: "busy" };
    }
    activeTriggerEvaluations += 1;
    const evaluationScope = createTriggerDeadlineScope(params.abortSignal);
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
        throw new CodeModeHeadlessTimeoutError("cron trigger evaluation timed out");
      }
      const result = await runHeadless({
        ctx: { ...runtime.ctx, catalogRef, abortSignal: evaluationScope.signal },
        code: params.script,
        wallClockMs: remainingWallClockMs,
        maxToolCalls: HEADLESS_TRIGGER_TOOL_BUDGET,
        extraNamespaces: [triggerStateNamespace(params.state)],
        signal: evaluationScope.signal,
      });
      if (result.status === "failed") {
        return { kind: "error", code: result.code, error: result.error };
      }
      return parseTriggerResult(result);
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
      activeTriggerEvaluations -= 1;
    }
  };
}

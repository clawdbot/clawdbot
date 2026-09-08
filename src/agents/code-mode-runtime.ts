import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
import { uniqueValues } from "@openclaw/normalization-core/string-normalization";
import { normalizeAgentModelRefForConfig } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { modelKey } from "../shared/model-key.js";
import { clampNumber } from "../utils.js";
import { resolveAgentConfig } from "./agent-scope-config.js";
import type { CodeModeOutputSource } from "./code-mode-json.js";
import type { CodeModeNamespaceRuntime } from "./code-mode-namespaces.js";
import {
  MAX_CODE_MODE_PENDING_TOOL_CALLS,
  type CodeModeConfig as CodeModeWorkerConfig,
  type CodeModeFailurePhase,
  type CodeModeLanguage,
  type CodeModeWorkerThreadResult,
} from "./code-mode-worker-types.js";
import type { ToolSearchConfig, ToolSearchToolContext } from "./tool-search.js";
import { asToolParamsRecord, ToolInputError } from "./tools/common.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_MAX_SNAPSHOT_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_PENDING_TOOL_CALLS = 16;
const DEFAULT_SNAPSHOT_TTL_SECONDS = 900;
const DEFAULT_SEARCH_LIMIT = 8;
const DEFAULT_MAX_SEARCH_LIMIT = 50;
export { CODE_MODE_WORKER_WATCHDOG_GRACE_MS } from "./code-mode-worker-types.js";
export const DEFAULT_HEADLESS_WALL_CLOCK_MS = 30_000;
// Cron script payloads persist caps of 900 seconds and 200 tool calls.
// The shared executor must not silently lower those accepted job limits.
export const MAX_HEADLESS_WALL_CLOCK_MS = 900_000;
export const DEFAULT_HEADLESS_TOOL_CALLS = 5;
export const MAX_HEADLESS_TOOL_CALLS = 200;

export type { CodeModeLanguage } from "./code-mode-worker-types.js";

/** Resolved Code Mode runtime limits and visible language options. */
export type CodeModeConfig = CodeModeWorkerConfig & {
  /** Effective activation policy; "auto" follows the model catalog flag. */
  enabled: boolean | "auto";
  runtime: "quickjs-wasi";
  mode: "only";
  snapshotTtlSeconds: number;
  searchDefaultLimit: number;
  maxSearchLimit: number;
};

export type {
  CodeModeSettlementMode,
  PendingBridgeRequest,
  SettledBridgeRequest,
} from "./code-mode-worker-types.js";

export type CodeModeFailureCode =
  | "aborted"
  | "invalid_input"
  | "runtime_unavailable"
  | "timeout"
  | "output_limit_exceeded"
  | "snapshot_limit_exceeded"
  | "internal_error";

export type CodeModeHeadlessResult =
  | {
      status: "completed";
      value: unknown;
      output: unknown[];
      toolCallCount: number;
    }
  | {
      status: "failed";
      code: CodeModeFailureCode | "tool_budget_exceeded";
      error: string;
      output: unknown[];
      toolCallCount: number;
    };

export type CodeModeWorkerResult =
  | Extract<CodeModeWorkerThreadResult, { status: "completed" | "waiting" }>
  | {
      status: "failed";
      error: string;
      code: CodeModeFailureCode;
      failurePhase: CodeModeFailurePhase;
      bridgeDispatchStarted: boolean;
      output: CodeModeOutputSource;
    };

function normalizeCodeModeRawConfig(value: unknown): Record<string, unknown> | undefined {
  const codeMode = value;
  if (codeMode === true) {
    return { enabled: true };
  }
  if (codeMode === false) {
    return { enabled: false };
  }
  if (codeMode === "auto") {
    return { enabled: "auto" };
  }
  return isRecord(codeMode) ? codeMode : undefined;
}

function readCodeModeRawConfig(
  config?: OpenClawConfig,
  agentId?: string,
  model?: { provider: string; modelId: string },
): Record<string, unknown> {
  const tools = isRecord(config?.tools) ? config.tools : undefined;
  const globalRaw = normalizeCodeModeRawConfig(tools?.codeMode) ?? {};
  const agent = config && agentId ? resolveAgentConfig(config, agentId) : undefined;
  const agentRaw = normalizeCodeModeRawConfig(agent?.tools?.codeMode);
  const key = model
    ? normalizeAgentModelRefForConfig(modelKey(model.provider, model.modelId))
    : undefined;
  // An options-only agent object inherits activation; it must not hide a model
  // override. Explicit false at either scope remains an authored choice.
  return {
    ...globalRaw,
    ...agentRaw,
    enabled:
      (key ? agent?.models?.[key]?.codeMode : undefined) ??
      agentRaw?.enabled ??
      (key ? config?.agents?.defaults?.models?.[key]?.codeMode : undefined) ??
      globalRaw.enabled,
  };
}

function readEnabled(value: unknown): boolean | "auto" {
  // Stable option-bearing objects made `enabled` optional and defaulted it off.
  // Automatic activation therefore requires an explicit `"auto"` selection.
  return typeof value === "boolean" || value === "auto" ? value : false;
}

export function readPositiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function readLanguages(value: unknown): CodeModeLanguage[] {
  if (!Array.isArray(value)) {
    return ["javascript", "typescript"];
  }
  const languages = value.filter(
    (entry): entry is CodeModeLanguage => entry === "javascript" || entry === "typescript",
  );
  return languages.length > 0 ? uniqueValues(languages) : ["javascript", "typescript"];
}

/** Resolves Code Mode runtime limits and language support from config. */
export function resolveCodeModeConfig(
  config?: OpenClawConfig,
  agentId?: string,
  model?: { provider: string; modelId: string },
): CodeModeConfig {
  const raw = readCodeModeRawConfig(config, agentId, model);
  const maxSearchLimit = clampNumber(
    readPositiveInteger(raw.maxSearchLimit, DEFAULT_MAX_SEARCH_LIMIT),
    1,
    DEFAULT_MAX_SEARCH_LIMIT,
  );
  return {
    enabled: readEnabled(raw.enabled),
    runtime: "quickjs-wasi",
    mode: "only",
    languages: readLanguages(raw.languages),
    timeoutMs: clampNumber(readPositiveInteger(raw.timeoutMs, DEFAULT_TIMEOUT_MS), 100, 60_000),
    memoryLimitBytes: clampNumber(
      readPositiveInteger(raw.memoryLimitBytes, DEFAULT_MEMORY_LIMIT_BYTES),
      1024 * 1024,
      1024 * 1024 * 1024,
    ),
    maxOutputBytes: clampNumber(
      readPositiveInteger(raw.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES),
      1024,
      10 * 1024 * 1024,
    ),
    maxSnapshotBytes: clampNumber(
      readPositiveInteger(raw.maxSnapshotBytes, DEFAULT_MAX_SNAPSHOT_BYTES),
      1024,
      256 * 1024 * 1024,
    ),
    maxPendingToolCalls: clampNumber(
      readPositiveInteger(raw.maxPendingToolCalls, DEFAULT_MAX_PENDING_TOOL_CALLS),
      1,
      MAX_CODE_MODE_PENDING_TOOL_CALLS,
    ),
    snapshotTtlSeconds: clampNumber(
      readPositiveInteger(raw.snapshotTtlSeconds, DEFAULT_SNAPSHOT_TTL_SECONDS),
      1,
      24 * 60 * 60,
    ),
    searchDefaultLimit: clampNumber(
      readPositiveInteger(raw.searchDefaultLimit, DEFAULT_SEARCH_LIMIT),
      1,
      maxSearchLimit,
    ),
    maxSearchLimit,
  };
}

/**
 * Resolves the effective activation policy against one model's catalog flag.
 * `true`/`false` are absolute; `"auto"` engages only for models whose catalog
 * compat declares `codeMode: "preferred"`. This gates the model-facing tool
 * surface only; runs that route to a provider-native harness (for example the
 * default OpenAI Codex surface) never reach this embedded-runtime gate.
 */
export function isCodeModeEngagedForModel(
  config: Pick<CodeModeConfig, "enabled">,
  model: { compat?: unknown } | undefined,
): boolean {
  if (config.enabled !== "auto") {
    return config.enabled;
  }
  const compat =
    model?.compat && typeof model.compat === "object"
      ? (model.compat as { codeMode?: unknown })
      : undefined;
  return compat?.codeMode === "preferred";
}

export function toToolSearchConfig(config: CodeModeConfig): ToolSearchConfig {
  return {
    enabled: true,
    mode: "tools",
    codeTimeoutMs: config.timeoutMs,
    searchDefaultLimit: config.searchDefaultLimit,
    maxSearchLimit: config.maxSearchLimit,
  };
}

export function resolveCodeModeHeadlessConfig(
  ctx: ToolSearchToolContext,
  overrides?: Partial<
    Pick<
      CodeModeConfig,
      | "timeoutMs"
      | "memoryLimitBytes"
      | "maxOutputBytes"
      | "maxSnapshotBytes"
      | "maxPendingToolCalls"
    >
  >,
): CodeModeConfig {
  const base = resolveCodeModeConfig(ctx.runtimeConfig ?? ctx.config, ctx.agentId);
  const definedOverrides = Object.fromEntries(
    Object.entries(overrides ?? {}).filter(([, value]) => value !== undefined),
  );
  return resolveCodeModeConfig({
    tools: { codeMode: { ...base, ...definedOverrides } },
  } as OpenClawConfig);
}

function isRuntimeInterruptedError(error: unknown): boolean {
  return (error instanceof Error ? error.message : error) === "interrupted";
}

export function codeModeFailureCode(error: unknown): CodeModeFailureCode {
  if (isRuntimeInterruptedError(error)) {
    return "timeout";
  }
  return error instanceof ToolInputError ? "invalid_input" : "internal_error";
}

export function codeModeFailureMessage(error: unknown): string {
  return isRuntimeInterruptedError(error)
    ? "code mode timeout exceeded"
    : formatErrorMessage(error);
}

export function readCode(args: unknown): {
  code: string;
  language?: CodeModeLanguage;
  restartSafe: boolean;
  typecheck: boolean;
} {
  const params = asToolParamsRecord(args);
  // Full-schema tool calls can materialize an unused alias as blank.
  // Only nonblank aliases participate in divergence checks.
  const codeAlias = readNonBlankString(params.code);
  const commandAlias = readNonBlankString(params.command);
  if (codeAlias !== undefined && commandAlias !== undefined && codeAlias !== commandAlias) {
    throw new ToolInputError("code and command must match when both are provided.");
  }
  const code = commandAlias ?? codeAlias;
  if (code === undefined) {
    throw new ToolInputError("code or command must be a non-empty string.");
  }
  const language = params.language;
  if (language !== undefined && language !== "javascript" && language !== "typescript") {
    throw new ToolInputError("language must be javascript or typescript.");
  }
  const restartSafe = params.restartSafe;
  if (restartSafe !== undefined && typeof restartSafe !== "boolean") {
    throw new ToolInputError("restartSafe must be a boolean.");
  }
  if (params.typecheck !== undefined && typeof params.typecheck !== "boolean") {
    throw new ToolInputError("typecheck must be a boolean.");
  }
  if (params.typecheck === true && language !== "typescript") {
    throw new ToolInputError("typecheck requires language: typescript.");
  }
  return {
    code,
    language,
    restartSafe: restartSafe === true,
    typecheck: params.typecheck === true,
  };
}

export function readRunId(args: unknown): string {
  const params = asToolParamsRecord(args);
  const runId = params.runId ?? params.run_id;
  if (typeof runId !== "string" || !runId.trim()) {
    throw new ToolInputError("runId must be a non-empty string.");
  }
  return runId.trim();
}

export function createCodeModeApiFilesForRun(
  namespaceRuntime: CodeModeNamespaceRuntime,
  swarmEnabled: boolean,
) {
  const { apiFiles: files } = namespaceRuntime;
  return swarmEnabled ? files : files.filter((file) => file.path !== "agents.d.ts");
}

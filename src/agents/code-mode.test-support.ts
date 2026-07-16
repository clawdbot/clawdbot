import "./code-mode.js";
import type { ToolSearchToolContext } from "./tool-search.js";

type CodeModeConfig = {
  enabled: boolean;
  runtime: "quickjs-wasi";
  mode: "only";
  languages: ("javascript" | "typescript")[];
  timeoutMs: number;
  memoryLimitBytes: number;
  maxOutputBytes: number;
  maxSnapshotBytes: number;
  maxPendingToolCalls: number;
  snapshotTtlSeconds: number;
  searchDefaultLimit: number;
  maxSearchLimit: number;
};

type CodeModeFailureCode =
  | "aborted"
  | "invalid_input"
  | "runtime_unavailable"
  | "timeout"
  | "output_limit_exceeded"
  | "snapshot_limit_exceeded"
  | "internal_error";

type CodeModeWorkerResult =
  | { status: "completed"; value: unknown; output: unknown[] }
  | {
      status: "waiting";
      snapshotBytes: Uint8Array;
      pendingRequests: Array<{ id: string; method: string; args: unknown[] }>;
      output: unknown[];
    }
  | { status: "failed"; error: string; code: CodeModeFailureCode; output: unknown[] };

type CodeModeTestApi = {
  activeRuns: Map<string, { config: CodeModeConfig; expiresAt: number }>;
  resumingRunIds: Set<string>;
  createHeadlessAbortScope(
    signal: AbortSignal | undefined,
    wallClockMs: number,
  ): { signal: AbortSignal; cleanup: () => void };
  normalizeCodeModeWorkerResult(result: CodeModeWorkerResult): CodeModeWorkerResult;
  runCodeModeWorker(
    workerData: unknown,
    timeoutMs: number,
    workerUrl?: URL,
    signal?: AbortSignal,
  ): Promise<CodeModeWorkerResult>;
  resolveCodeModeHeadlessConfig(
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
  ): CodeModeConfig;
  resolveCodeModeWorkerUrl(currentModuleUrl: string): URL;
  getTypescriptRuntimePromise(): Promise<typeof import("typescript")> | null;
  setTypescriptRuntimeForTest(runtime: typeof import("typescript") | null): void;
};

function getTestApi(): CodeModeTestApi {
  const api = (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.codeModeTestApi")];
  if (!api) {
    throw new Error("code mode test API is unavailable");
  }
  return api as CodeModeTestApi;
}

export const testing = getTestApi();

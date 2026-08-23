import { randomUUID } from "node:crypto";
import { clampNumber } from "../utils.js";
import { createCodeModeCatalogProjection } from "./code-mode-catalog.js";
import { awaitCodeModeDeadline } from "./code-mode-deadline.js";
import { boundCodeModeResult, toCodeModeJsonSafe } from "./code-mode-json.js";
import {
  createCodeModeNamespaceRuntime,
  type CodeModeNamespaceDescriptor,
  type SerializedCodeModeNamespaceValue,
} from "./code-mode-namespaces.js";
import {
  DEFAULT_HEADLESS_TOOL_CALLS,
  DEFAULT_HEADLESS_WALL_CLOCK_MS,
  CODE_MODE_WORKER_WATCHDOG_GRACE_MS,
  MAX_HEADLESS_TOOL_CALLS,
  MAX_HEADLESS_WALL_CLOCK_MS,
  codeModeFailureCode,
  codeModeFailureMessage,
  createCodeModeApiFilesForRun,
  boundOutputToLimit,
  enforceSnapshotPayloadLimits,
  prepareSource,
  readPositiveInteger,
  resolveCodeModeHeadlessConfig,
  toToolSearchConfig,
  type CodeModeConfig,
  type CodeModeFailureCode,
  type CodeModeHeadlessResult,
  type CodeModeWorkerResult,
} from "./code-mode-runtime.js";
import {
  cancelPendingBridgeStates,
  createCodeModeBridgeDispatchState,
  createPendingBridgeStates,
  pendingBridgeStatesForSettlement,
  settledBridgeRequestsInCompletionOrder,
  waitForPendingBridgeSettlement,
  type PendingBridgeState,
} from "./code-mode-state.js";
import {
  CodeModeHeadlessAbortError,
  CodeModeHeadlessTimeoutError,
  normalizeCodeModeWorkerResult,
  runCodeModeWorker,
} from "./code-mode-worker.js";
import { ToolSearchRuntime, type ToolSearchToolContext } from "./tool-search.js";
import { ToolInputError } from "./tools/common.js";

function createHeadlessAbortScope(
  signal: AbortSignal | undefined,
  wallClockMs: number,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) {
    onAbort();
  }
  const timer = setTimeout(() => controller.abort(new CodeModeHeadlessTimeoutError()), wallClockMs);
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

function headlessAbortError(
  signal: AbortSignal,
): CodeModeHeadlessAbortError | CodeModeHeadlessTimeoutError {
  return signal.reason instanceof CodeModeHeadlessTimeoutError
    ? signal.reason
    : signal.reason instanceof CodeModeHeadlessAbortError
      ? signal.reason
      : new CodeModeHeadlessAbortError();
}

function headlessFailure(params: {
  code: CodeModeFailureCode | "tool_budget_exceeded";
  error: string;
  output: unknown[];
  toolCallCount: number;
}): CodeModeHeadlessResult {
  return { status: "failed", ...params };
}

function remainingHeadlessMs(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new CodeModeHeadlessTimeoutError();
  }
  return remaining;
}

async function runHeadlessWorkerLeg(params: {
  input: Record<string, unknown>;
  config: CodeModeConfig;
  deadline: number;
  signal: AbortSignal;
}): Promise<CodeModeWorkerResult> {
  const remainingMs = remainingHeadlessMs(params.deadline);
  const timeoutMs = Math.max(1, Math.min(params.config.timeoutMs, remainingMs));
  // Let the headless abort scope own the wall-clock deadline. Capping the host
  // watchdog to the same deadline makes its internal timeout message race the scope.
  const workerTimeoutMs = timeoutMs + CODE_MODE_WORKER_WATCHDOG_GRACE_MS;
  return await runCodeModeWorker(
    {
      ...params.input,
      config: { ...params.config, timeoutMs },
    },
    workerTimeoutMs,
    undefined,
    params.signal,
  );
}

function normalizeHeadlessNamespaceValue(
  descriptor: SerializedCodeModeNamespaceValue,
): SerializedCodeModeNamespaceValue {
  if (descriptor.kind === "array") {
    return { kind: "array", items: descriptor.items.map(normalizeHeadlessNamespaceValue) };
  }
  if (descriptor.kind === "object") {
    return {
      kind: "object",
      entries: descriptor.entries.map(([key, value]) => {
        if (!key) {
          throw new ToolInputError("code mode namespace descriptor keys must not be empty");
        }
        return [key, normalizeHeadlessNamespaceValue(value)];
      }),
    };
  }
  if (descriptor.kind !== "value") {
    return descriptor;
  }
  return { kind: "value", value: toCodeModeJsonSafe(descriptor.value) };
}

function normalizeHeadlessNamespace(
  descriptor: CodeModeNamespaceDescriptor,
): CodeModeNamespaceDescriptor {
  return { ...descriptor, scope: normalizeHeadlessNamespaceValue(descriptor.scope) };
}

function mergeHeadlessNamespaces(
  registered: CodeModeNamespaceDescriptor[],
  extra: CodeModeNamespaceDescriptor[],
): CodeModeNamespaceDescriptor[] {
  const ids = new Set(registered.map((descriptor) => descriptor.id));
  const globalNames = new Set(registered.map((descriptor) => descriptor.globalName));
  const merged = [...registered];
  for (const descriptor of extra) {
    if (ids.has(descriptor.id) || globalNames.has(descriptor.globalName)) {
      throw new ToolInputError(
        `code mode namespace collision for ${descriptor.id} (${descriptor.globalName})`,
      );
    }
    ids.add(descriptor.id);
    globalNames.add(descriptor.globalName);
    merged.push(normalizeHeadlessNamespace(descriptor));
  }
  return merged;
}

function headlessNamespaceFreezePrelude(descriptors: CodeModeNamespaceDescriptor[]): string {
  const globalNames = JSON.stringify(descriptors.map((descriptor) => descriptor.globalName));
  return `;(() => {
    const seen = new WeakSet();
    const freeze = (value) => {
      if ((value === null || (typeof value !== "object" && typeof value !== "function")) || seen.has(value)) return value;
      seen.add(value);
      for (const key of Object.keys(value)) freeze(value[key]);
      return Object.freeze(value);
    };
    for (const name of ${globalNames}) freeze(globalThis[name]);
  })();\n`;
}

/** Run Code Mode to completion without publishing resumable snapshot state. */
export async function runCodeModeScriptHeadless(params: {
  ctx: ToolSearchToolContext;
  code: string;
  language?: "javascript" | "typescript";
  overrides?: Partial<
    Pick<
      CodeModeConfig,
      | "timeoutMs"
      | "memoryLimitBytes"
      | "maxOutputBytes"
      | "maxSnapshotBytes"
      | "maxPendingToolCalls"
    >
  >;
  wallClockMs?: number;
  maxToolCalls?: number;
  extraNamespaces?: CodeModeNamespaceDescriptor[];
  signal?: AbortSignal;
}): Promise<CodeModeHeadlessResult> {
  const config = resolveCodeModeHeadlessConfig(params.ctx, params.overrides);
  const wallClockMs = clampNumber(
    readPositiveInteger(params.wallClockMs, DEFAULT_HEADLESS_WALL_CLOCK_MS),
    1,
    MAX_HEADLESS_WALL_CLOCK_MS,
  );
  const maxToolCalls = clampNumber(
    readPositiveInteger(params.maxToolCalls, DEFAULT_HEADLESS_TOOL_CALLS),
    1,
    MAX_HEADLESS_TOOL_CALLS,
  );
  const deadline = Date.now() + wallClockMs;
  const abortScope = createHeadlessAbortScope(params.signal, wallClockMs);
  const output: unknown[] = [];
  let pending: PendingBridgeState[] = [];
  let toolCallCount = 0;
  try {
    // Headless runs publish no resumable snapshot/handle, so collector globals stay unavailable.
    const swarmEnabled = false;
    const codeModeRunId = `cm_headless_${randomUUID()}`;
    const runtime = new ToolSearchRuntime(params.ctx, toToolSearchConfig(config), {
      prepareInput: true,
    });
    const bridgeDispatch = createCodeModeBridgeDispatchState();
    const namespaceCatalog = runtime.namespaceEntries();
    const namespaceRuntime = createCodeModeNamespaceRuntime(namespaceCatalog);
    const preparedSource = await awaitCodeModeDeadline({
      operation: () => prepareSource({ code: params.code, language: params.language, config }),
      deadlineMs: deadline,
      signal: abortScope.signal,
      createTimeoutError: () => new CodeModeHeadlessTimeoutError(),
      createAbortError: headlessAbortError,
    });
    const namespaces = mergeHeadlessNamespaces(
      namespaceRuntime.descriptors,
      params.extraNamespaces ?? [],
    );
    const catalogProjection = createCodeModeCatalogProjection(runtime.all({ includeMcp: false }), {
      reservedNames: namespaces.map((descriptor) => descriptor.globalName),
    });
    const source = `${headlessNamespaceFreezePrelude(namespaces)}${preparedSource}`;
    const parentToolCallId = `headless:${randomUUID()}`;
    let result = normalizeCodeModeWorkerResult(
      await runHeadlessWorkerLeg({
        input: {
          kind: "exec",
          source,
          catalog: catalogProjection.guestBindings,
          apiFiles: createCodeModeApiFilesForRun(namespaceRuntime, swarmEnabled),
          namespaces,
          swarmEnabled,
        },
        config,
        deadline,
        signal: abortScope.signal,
      }),
    );

    while (true) {
      output.push(...result.output);
      boundOutputToLimit(output, config);
      if (result.status === "completed") {
        const bounded = boundCodeModeResult({
          output,
          value: result.value,
          maxOutputBytes: config.maxOutputBytes,
        });
        return {
          status: "completed",
          value: bounded.value,
          output: bounded.output,
          toolCallCount,
        };
      }
      if (result.status === "failed") {
        return headlessFailure({
          code: result.code,
          error: result.error,
          output,
          toolCallCount,
        });
      }

      enforceSnapshotPayloadLimits({ snapshotBytes: result.snapshotBytes, config });
      const pendingIds = new Set(pending.map((entry) => entry.id));
      const newRequests = result.pendingRequests.filter((request) => !pendingIds.has(request.id));
      // Node discovery invokes the generic nodes tool for live status too;
      // excluding list/get would bypass the same headless tool-call budget.
      const requestedToolCalls = newRequests.filter(
        (request) =>
          request.method === "callValue" ||
          request.method === "nodes" ||
          request.method === "namespace",
      ).length;
      toolCallCount += requestedToolCalls;
      if (toolCallCount > maxToolCalls) {
        return headlessFailure({
          code: "tool_budget_exceeded",
          error: `code mode headless tool budget exceeded (${maxToolCalls})`,
          output,
          toolCallCount,
        });
      }

      pending.push(
        ...createPendingBridgeStates({
          pendingRequests: newRequests,
          config,
          runtime,
          catalogProjection,
          namespaceRuntime,
          parentToolCallId,
          codeModeRunId,
          deadlineMs: deadline,
          ctx: params.ctx,
          signal: abortScope.signal,
          bridgeDispatch,
        }),
      );
      // Preserve the waiting frontier before the lazy deadline callback;
      // later worker legs replace the discriminated result entirely.
      const settlementMode = result.settlementMode;
      const frontierPending = pendingBridgeStatesForSettlement(pending, settlementMode);
      if (frontierPending.length === 0) {
        return headlessFailure({
          code: "internal_error",
          error: "code mode is waiting without pending bridge requests",
          output,
          toolCallCount,
        });
      }
      await awaitCodeModeDeadline({
        operation: () => waitForPendingBridgeSettlement(pending, settlementMode),
        deadlineMs: deadline,
        signal: abortScope.signal,
        createTimeoutError: () => new CodeModeHeadlessTimeoutError(),
        createAbortError: headlessAbortError,
      });
      const settledRequests = settledBridgeRequestsInCompletionOrder(pending);
      pending = pending.filter((entry) => !entry.settled);
      result = normalizeCodeModeWorkerResult(
        await runHeadlessWorkerLeg({
          input: {
            kind: "resume",
            snapshotBytes: result.snapshotBytes,
            settledRequests,
            pendingRequests: pending.map(({ id, method, args }) => ({ id, method, args })),
          },
          config,
          deadline,
          signal: abortScope.signal,
        }),
      );
    }
  } catch (error) {
    const timedOut = error instanceof CodeModeHeadlessTimeoutError;
    const aborted = error instanceof CodeModeHeadlessAbortError;
    return headlessFailure({
      code: timedOut ? "timeout" : aborted ? "aborted" : codeModeFailureCode(error),
      error: timedOut || aborted ? error.message : codeModeFailureMessage(error),
      output,
      toolCallCount,
    });
  } finally {
    cancelPendingBridgeStates(pending);
    abortScope.cleanup();
  }
}

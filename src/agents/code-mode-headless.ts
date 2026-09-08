import { randomUUID } from "node:crypto";
import { clampNumber } from "../utils.js";
import { createCodeModeCatalogProjection } from "./code-mode-catalog.js";
import { awaitCodeModeDeadline } from "./code-mode-deadline.js";
import { CodeModeOutputState, toCodeModeJsonSafe } from "./code-mode-json.js";
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
  cancelPendingBridgeStatesById,
  createCodeModeBridgeDispatchState,
  createCodeModeRunOwner,
  createPendingBridgeStates,
  pendingBridgeStatesForSettlement,
  takeSettledBridgeRequests,
  reserveActiveRunSlot,
  waitForPendingBridgeSettlement,
  type PendingBridgeState,
} from "./code-mode-state.js";
import {
  CodeModeHeadlessAbortError,
  CodeModeHeadlessTimeoutError,
  runCodeModeWorker,
  type CodeModeWorkerInlineHost,
} from "./code-mode-worker.js";
import { ToolSearchRuntime } from "./tool-search-runtime.js";
import type { ToolSearchToolContext } from "./tool-search-types.js";
import { ToolInputError } from "./tools/common.js";

/** Each invocation owns a deadline, including callers that prepare tools before starting a guest. */
export function createHeadlessDeadlineScope(
  signal: AbortSignal | undefined,
  wallClockMs: number,
  label?: string,
) {
  const controller = new AbortController();
  const onAbort = () =>
    controller.abort(label ? new CodeModeHeadlessAbortError(`${label} aborted`) : signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) {
    onAbort();
  }
  const timeoutError = () =>
    new CodeModeHeadlessTimeoutError(label ? `${label} timed out` : undefined);
  const timer = setTimeout(() => controller.abort(timeoutError()), wallClockMs);
  const deadline = performance.now() + wallClockMs;
  return {
    deadline,
    signal: controller.signal,
    wait: <T>(promise: Promise<T>) =>
      awaitCodeModeDeadline({
        operation: () => promise,
        remainingMs: Math.ceil(deadline - performance.now()),
        signal: controller.signal,
        createTimeoutError: timeoutError,
        createAbortError: headlessAbortError,
      }),
    cleanup: () => {
      controller.abort(new CodeModeHeadlessAbortError());
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
  output: CodeModeOutputState;
  toolCallCount: number;
}): CodeModeHeadlessResult {
  return {
    status: "failed",
    code: params.code,
    toolCallCount: params.toolCallCount,
    ...params.output.take({ error: params.error }),
  };
}

function remainingHeadlessMs(deadline: number): number {
  const remaining = Math.ceil(deadline - performance.now());
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
  inlineHost?: CodeModeWorkerInlineHost;
}): Promise<CodeModeWorkerResult> {
  const remainingMs = remainingHeadlessMs(params.deadline);
  const executionTimeoutMs = Math.max(1, Math.min(params.config.timeoutMs, remainingMs));
  // Initial source preparation uses the wall-clock allowance; the guest keeps
  // its separate CPU budget after compilation. Resumes need no preparation.
  const timeoutMs = params.input.kind === "exec" ? remainingMs : executionTimeoutMs;
  // Let the headless abort scope own the wall-clock deadline. Capping the host
  // watchdog to the same deadline makes its internal timeout message race the scope.
  const workerTimeoutMs = timeoutMs + CODE_MODE_WORKER_WATCHDOG_GRACE_MS;
  return await runCodeModeWorker(
    {
      ...params.input,
      executionTimeoutMs,
      config: { ...params.config, timeoutMs },
    },
    workerTimeoutMs,
    undefined,
    params.signal,
    params.inlineHost,
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
  const owner = createCodeModeRunOwner(params.ctx, config);
  const abortScope = createHeadlessDeadlineScope(owner.bindCall(params.signal), wallClockMs);
  const deadline = abortScope.deadline;
  const output = new CodeModeOutputState(config.maxOutputBytes);
  let pending: PendingBridgeState[] = [];
  let toolCallCount = 0;
  let releaseReservation: (() => void) | undefined;
  try {
    // Headless runs publish no resumable snapshot/handle, so collector globals stay unavailable.
    const swarmEnabled = false;
    const codeModeRunId = `cm_headless_${randomUUID()}`;
    const runtime = new ToolSearchRuntime(params.ctx, toToolSearchConfig(config), {
      prepareInput: true,
      validateInput: true,
    });
    const bridgeDispatch = createCodeModeBridgeDispatchState();
    const namespaceCatalog = runtime.namespaceEntries();
    const namespaceRuntime = createCodeModeNamespaceRuntime(namespaceCatalog);
    const namespaces = mergeHeadlessNamespaces(
      namespaceRuntime.descriptors,
      params.extraNamespaces ?? [],
    );
    const catalogProjection = createCodeModeCatalogProjection(runtime.all({ includeMcp: false }), {
      reservedNames: namespaces.map((descriptor) => descriptor.globalName),
    });
    const parentToolCallId = `headless:${randomUUID()}`;
    const dispatch = (
      boundary: Pick<
        Extract<CodeModeWorkerResult, { status: "waiting" }>,
        "pendingRequests" | "canceledRequestIds"
      >,
    ) => {
      cancelPendingBridgeStatesById(pending, boundary.canceledRequestIds);
      const pendingIds = new Set(pending.map((entry) => entry.id));
      const newRequests = boundary.pendingRequests.filter((request) => !pendingIds.has(request.id));
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
        throw new HeadlessToolBudgetError(
          `code mode headless tool budget exceeded (${maxToolCalls})`,
        );
      }

      releaseReservation ??= reserveActiveRunSlot();
      pending.push(
        ...createPendingBridgeStates(newRequests, {
          config,
          inbox: owner.inbox,
          runtime,
          catalogProjection,
          namespaceRuntime,
          parentToolCallId,
          codeModeRunId,
          remainingMs: remainingHeadlessMs(deadline),
          ctx: params.ctx,
          signal: abortScope.signal,
          bridgeDispatch,
        }),
      );
    };
    let boundaryFailure: Error | undefined;
    const inlineHost: CodeModeWorkerInlineHost = {
      onBoundary: async (boundary, context) => {
        output.append(boundary.output);
        cancelPendingBridgeStatesById(pending, boundary.canceledRequestIds);
        if (boundary.pendingRequests.some((request) => request.method === "yield")) {
          return { kind: "checkpoint" };
        }
        try {
          dispatch(boundary);
        } catch (error) {
          boundaryFailure =
            error instanceof Error ? error : new Error("headless bridge failed", { cause: error });
          throw boundaryFailure;
        }
        if (context.yieldSignal.aborted) {
          return { kind: "checkpoint" };
        }
        let onPressure: (() => void) | undefined;
        try {
          const ready = await abortScope.wait(
            Promise.race([
              waitForPendingBridgeSettlement(pending, boundary.settlementMode).then(() => true),
              new Promise<false>((resolve) => {
                onPressure = () => resolve(false);
                context.yieldSignal.addEventListener("abort", onPressure, { once: true });
              }),
            ]),
          );
          if (!ready || context.yieldSignal.aborted) {
            return { kind: "checkpoint" };
          }
          // Admission already charged worker queue/initialization time. Respect that
          // exact grant as well as the configured slice and the headless wall deadline.
          const timeoutMs = Math.min(
            context.maxTimeoutMs,
            config.timeoutMs,
            remainingHeadlessMs(deadline),
          );
          const delivery = takeSettledBridgeRequests(pending);
          pending = pending.filter((entry) => !entry.settled);
          return {
            kind: "continue",
            timeoutMs,
            settledRequests: delivery.requests,
            pendingRequests: pending.map(({ id, method, args }) => ({ id, method, args })),
            onConsumed: delivery.release,
          };
        } finally {
          if (onPressure) {
            context.yieldSignal.removeEventListener("abort", onPressure);
          }
        }
      },
    };
    let result = await runHeadlessWorkerLeg({
      input: {
        kind: "exec",
        source: params.code,
        language: params.language,
        prelude: headlessNamespaceFreezePrelude(namespaces),
        catalog: catalogProjection.guestBindings,
        apiFiles: createCodeModeApiFilesForRun(namespaceRuntime, swarmEnabled),
        namespaces,
        swarmEnabled,
      },
      config,
      deadline,
      signal: abortScope.signal,
      inlineHost,
    });

    while (true) {
      output.append(result.output);
      if (boundaryFailure) {
        throw boundaryFailure;
      }
      if (result.status === "completed") {
        const bounded = output.take({ value: result.value });
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

      dispatch(result);
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
      await abortScope.wait(waitForPendingBridgeSettlement(pending, settlementMode));
      const delivery = takeSettledBridgeRequests(pending);
      pending = pending.filter((entry) => !entry.settled);
      try {
        result = await runHeadlessWorkerLeg({
          input: {
            kind: "resume",
            snapshot: result.snapshot,
            settledRequests: delivery.requests,
            pendingRequests: pending.map(({ id, method, args }) => ({ id, method, args })),
          },
          config,
          deadline,
          signal: abortScope.signal,
          inlineHost: { ...inlineHost, onInputConsumed: delivery.release },
        });
      } finally {
        delivery.release();
      }
    }
  } catch (error) {
    const timedOut = error instanceof CodeModeHeadlessTimeoutError;
    const aborted = error instanceof CodeModeHeadlessAbortError;
    return headlessFailure({
      code:
        error instanceof HeadlessToolBudgetError
          ? "tool_budget_exceeded"
          : timedOut
            ? "timeout"
            : aborted
              ? "aborted"
              : codeModeFailureCode(error),
      error: timedOut || aborted ? error.message : codeModeFailureMessage(error),
      output,
      toolCallCount,
    });
  } finally {
    cancelPendingBridgeStates(pending);
    abortScope.cleanup();
    owner.close();
    releaseReservation?.();
  }
}

class HeadlessToolBudgetError extends Error {}

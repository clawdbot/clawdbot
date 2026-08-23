import { createAbortError } from "../infra/abort-signal.js";
/**
 * Abort-signal wrapping for agent tools.
 * Combines per-call cancellation with run-level aborts while preserving
 * identity-backed metadata on wrapped tools.
 */
import { copyAgentToolMetadata } from "./agent-tool-metadata.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import {
  attachInternalToolExecutionPreparer,
  getInternalToolExecutionPreparer,
} from "./runtime/internal-hooks.js";

function throwAbortError(): never {
  throw createAbortError("Aborted");
}

/**
 * Races a tool execute promise against the combined abort signal so an abort
 * settles the wrapped call immediately instead of awaiting the tool forever.
 * JavaScript cannot cancel a running promise: a tool that never observes the
 * signal keeps executing in the background and may settle later, but its late
 * settlement is detached here so the result never lands in an aborted run.
 * Tool settlements pass through untouched to preserve tool error semantics,
 * including non-Error rejections.
 */
function raceWithAbortSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  yieldRunSignal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      const reason = yieldRunSignal?.reason as
        | { code?: unknown; turnHandoff?: unknown }
        | undefined;
      // Only the initiating tool may finish its run owner's deliberate handoff;
      // caller-authored aborts and concurrent sibling tools must still cancel.
      if (
        yieldRunSignal?.aborted &&
        signal.reason === reason &&
        reason?.code === "sessions_yield" &&
        reason.turnHandoff === true
      ) {
        return;
      }
      reject(createAbortError("Aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        // Tool settlements pass through untouched, including non-Error rejections.
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors
        reject(error);
      },
    );
    if (signal.aborted) {
      onAbort();
    }
  });
}

/** Wrap a tool so every execute call observes the supplied run abort signal. */
export function wrapToolWithAbortSignal(
  tool: AnyAgentTool,
  abortSignal?: AbortSignal,
): AnyAgentTool {
  if (!abortSignal) {
    return tool;
  }
  const execute = tool.execute;
  if (!execute) {
    return tool;
  }
  const wrappedTool: AnyAgentTool = {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const combinedSignal = signal ? AbortSignal.any([signal, abortSignal]) : abortSignal;
      if (combinedSignal.aborted) {
        throwAbortError();
      }
      return await raceWithAbortSignal(
        execute(toolCallId, params, combinedSignal, onUpdate),
        combinedSignal,
        tool.name === "sessions_yield" ? abortSignal : undefined,
      );
    },
  };
  copyAgentToolMetadata(tool, wrappedTool);
  const sourcePreparer = getInternalToolExecutionPreparer(tool);
  if (sourcePreparer) {
    attachInternalToolExecutionPreparer(wrappedTool, async (params) => {
      const combinedSignal = params.signal
        ? AbortSignal.any([params.signal, abortSignal])
        : abortSignal;
      if (combinedSignal.aborted) {
        throwAbortError();
      }
      const yieldRunSignal = tool.name === "sessions_yield" ? abortSignal : undefined;
      const sourcePreparation = sourcePreparer({ ...params, signal: combinedSignal });
      let prepared;
      try {
        prepared = await raceWithAbortSignal(sourcePreparation, combinedSignal, yieldRunSignal);
      } catch (error) {
        void sourcePreparation.then(
          (latePreparation) => latePreparation.dispose(),
          () => undefined,
        );
        throw error;
      }
      if (prepared.kind === "immediate") {
        return prepared;
      }
      return {
        kind: "ready",
        args: prepared.args,
        execute: (onImplementationStart) => {
          if (combinedSignal.aborted) {
            throwAbortError();
          }
          return raceWithAbortSignal(
            prepared.execute(onImplementationStart),
            combinedSignal,
            yieldRunSignal,
          );
        },
        dispose: prepared.dispose,
      };
    });
  }
  return wrappedTool;
}

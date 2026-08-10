import { AsyncLocalStorage } from "node:async_hooks";
import { createAbortError } from "../infra/abort-signal.js";
/**
 * Abort-signal wrapping for agent tools.
 * Combines per-call cancellation with run-level aborts while preserving
 * identity-backed metadata on wrapped tools.
 */
import { copyAgentToolMetadata } from "./agent-tool-metadata.js";
import type { AnyAgentTool } from "./agent-tools.types.js";

type RawToolSettlementObserver = (settlement: Promise<unknown>) => void;

const activeRawToolSettlementObserver = new AsyncLocalStorage<RawToolSettlementObserver>();

function throwAbortError(): never {
  throw createAbortError("Aborted");
}

/**
 * Preserve caller-facing abort behavior while joining the underlying tool work
 * before the owning lifecycle reports terminal settlement.
 */
export async function runWithAbortWrappedToolSettlements<T>(run: () => Promise<T>): Promise<T> {
  const pending = new Set<Promise<void>>();
  const observe: RawToolSettlementObserver = (rawSettlement) => {
    const settlement = rawSettlement.then(
      () => undefined,
      () => undefined,
    );
    pending.add(settlement);
    void settlement.then(() => {
      pending.delete(settlement);
    });
  };
  return await activeRawToolSettlementObserver.run(observe, async () => {
    const outcome = await run().then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    while (pending.size > 0) {
      await Promise.all(pending);
    }
    if (!outcome.ok) {
      // Tool settlements pass through untouched, including non-Error rejections.
      throw outcome.error;
    }
    return outcome.value;
  });
}

/**
 * Races a tool execute promise against the combined abort signal so an abort
 * settles the wrapped call immediately instead of awaiting the tool forever.
 * JavaScript cannot cancel a running promise: a tool that never observes the
 * signal keeps executing in the background and may settle later, but its late
 * result stays detached from the aborted caller. Lifecycle owners may still
 * join the raw settlement through runWithAbortWrappedToolSettlements.
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
      const rawSettlement = execute(toolCallId, params, combinedSignal, onUpdate);
      activeRawToolSettlementObserver.getStore()?.(rawSettlement);
      return await raceWithAbortSignal(
        rawSettlement,
        combinedSignal,
        tool.name === "sessions_yield" ? abortSignal : undefined,
      );
    },
  };
  return copyAgentToolMetadata(tool, wrappedTool);
}

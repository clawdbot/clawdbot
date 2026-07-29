import { createAbortError } from "../infra/abort-signal.js";
/**
 * Abort-signal wrapping for agent tools.
 * Combines per-call cancellation with run-level aborts while preserving plugin,
 * channel, and before_tool_call metadata on wrapped tools.
 */
import { copyPluginToolMeta } from "../plugins/tools.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { copyBeforeToolCallHookMarker } from "./before-tool-call-metadata.js";
import { copyChannelAgentToolMeta } from "./channel-tools.js";
import { isSessionsYieldAbortReason } from "./embedded-agent-runner/run/attempt.sessions-yield.js";

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
  ignoreAbortReason?: (reason: unknown) => boolean,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      if (ignoreAbortReason?.(signal.reason)) {
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
  // sessions_yield ends the turn by aborting its own run from inside execute
  // (attempt.ts onYield). That handoff abort must not out-race the tool's own
  // {status:"yielded"} result, or every yield records as a failed tool call and
  // channels surface a spurious "⚠️ Yield … failed" warning. Real aborts don't
  // carry the sessions_yield reason and still reject.
  const ignoreAbortReason = tool.name === "sessions_yield" ? isSessionsYieldAbortReason : undefined;
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
        ignoreAbortReason,
      );
    },
  };
  copyPluginToolMeta(tool, wrappedTool);
  copyChannelAgentToolMeta(tool as never, wrappedTool as never);
  copyBeforeToolCallHookMarker(tool, wrappedTool);
  return wrappedTool;
}

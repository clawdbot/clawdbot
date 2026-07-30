/**
 * sessions_yield built-in tool.
 *
 * Ends the current turn after subagent spawning so completion events can resume the session later.
 */
import { Type } from "typebox";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const SessionsYieldToolSchema = Type.Object({
  message: Type.Optional(Type.String()),
});

export type SessionsYieldEvent = {
  hasExplicitMessage: boolean;
};

/** Creates the sessions_yield tool for runtimes that support yield callbacks. */
export function createSessionsYieldTool(opts?: {
  sessionId?: string;
  onBeforeYield?: () => Promise<void> | void;
  onYield?: (message: string, event: SessionsYieldEvent) => Promise<void> | void;
}): AnyAgentTool {
  return {
    label: "Yield",
    name: "sessions_yield",
    // Turn-lifecycle contract: spawn flows instruct the model to yield, so the
    // tool must stay visible even when tool search compacts the catalog.
    catalogMode: "direct-only",
    description: "End turn after subagent spawn; results arrive next message.",
    parameters: SessionsYieldToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const explicitMessage = readStringParam(params, "message");
      const message = explicitMessage || "Turn yielded.";
      if (!opts?.sessionId) {
        return jsonResult({ status: "error", error: "No session context" });
      }
      if (!opts?.onYield) {
        return jsonResult({ status: "error", error: "Yield not supported in this context" });
      }
      await opts.onBeforeYield?.();
      // The runtime owns the actual pause/end-turn behavior; this tool records intent.
      await opts.onYield(message, { hasExplicitMessage: explicitMessage !== undefined });
      return jsonResult({ status: "yielded", message });
    },
  };
}

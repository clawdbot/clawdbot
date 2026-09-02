/**
 * sessions_yield built-in tool.
 *
 * Ends the current turn after subagent spawning so completion events can resume the session later.
 */
import { Type } from "typebox";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readToolStringParam } from "./common.js";

const NO_PENDING_CHILD_COMPLETION_ERROR =
  "No pending child completion is owned by this turn. Continue working because independent background operations complete separately.";

const SessionsYieldToolSchema = Type.Object({
  message: Type.Optional(
    Type.String({ description: "Private context for the resumed turn; not sent to the user." }),
  ),
  acknowledgment: Type.Optional(
    Type.String({
      description: "Optional waiting reply for an otherwise-silent interactive parent turn.",
    }),
  ),
});

/** Creates the sessions_yield tool for runtimes that support yield callbacks. */
export function createSessionsYieldTool(opts?: {
  sessionId?: string;
  claimYield?: () => boolean | Promise<boolean>;
  onYield?: (message: string, acknowledgment?: string) => Promise<void> | void;
}): AnyAgentTool {
  return {
    label: "Yield",
    name: "sessions_yield",
    // Turn-lifecycle contract: spawn flows instruct the model to yield, so the
    // tool must stay visible even when tool search compacts the catalog.
    catalogMode: "direct-only",
    description:
      "End turn for announced child completion events. Collector runs require explicit collection instead. For an otherwise-silent interactive parent turn, acknowledgment can send a waiting reply.",
    parameters: SessionsYieldToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const message = readToolStringParam(params, "message") || "Turn yielded.";
      const acknowledgment = readToolStringParam(params, "acknowledgment") || undefined;
      if (!opts?.sessionId) {
        return jsonResult({ status: "error", error: "No session context" });
      }
      if (!opts?.onYield) {
        return jsonResult({ status: "error", error: "Yield not supported in this context" });
      }
      if (!(await opts.claimYield?.())) {
        return jsonResult({
          status: "error",
          error: NO_PENDING_CHILD_COMPLETION_ERROR,
        });
      }
      // The runtime owns the actual pause/end-turn behavior; this tool records intent.
      await opts.onYield(message, acknowledgment);
      return jsonResult({
        status: "yielded",
        message,
        ...(acknowledgment ? { acknowledgment } : {}),
      });
    },
  };
}

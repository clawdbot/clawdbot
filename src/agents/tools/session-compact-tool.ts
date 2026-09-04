/**
 * session_compact built-in tool.
 *
 * Lets the model request compaction of the current session when it judges the
 * conversation ready — for example after a topic concludes — instead of waiting
 * for the context limit. The tool records the request; the runtime owns the
 * actual compaction, which runs through the normal manual-compaction pipeline
 * after the current turn completes.
 */
import { Type } from "typebox";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readToolStringParam } from "./common.js";

const SessionCompactToolSchema = Type.Object({
  focus: Type.Optional(
    Type.String({
      description:
        "Guidance for the summary, e.g. the concluded topic and what matters about it. " +
        "Same semantics as the operator /compact focus text.",
    }),
  ),
});

export type SessionCompactRequest = {
  focus?: string;
};

/** Creates the session_compact tool for runtimes that can service compaction requests. */
export function createSessionCompactTool(opts?: {
  sessionId?: string;
  onRequestCompaction?: (request: SessionCompactRequest) => void;
}): AnyAgentTool {
  return {
    label: "Compact Session",
    name: "session_compact",
    displaySummary: "Request compaction of the current session",
    description:
      "Request compaction of this session's older history. Use when you judge the conversation " +
      "ready to be summarized — for example when the current topic concludes and a new one is " +
      "starting, or before context pressure builds. Provide focus to guide the summary. " +
      "Compaction runs after the current turn completes; recent turns and the full on-disk " +
      "history are preserved.",
    parameters: SessionCompactToolSchema,
    execute: async (_toolCallId, args) => {
      // SAFETY: model-facing tool args are untyped; readToolStringParam validates each field.
      const params = args as Record<string, unknown>;
      const focus = readToolStringParam(params, "focus");
      if (!opts?.sessionId) {
        return jsonResult({ status: "error", error: "No session context" });
      }
      if (!opts?.onRequestCompaction) {
        return jsonResult({
          status: "error",
          error: "Compaction cannot be requested in this context",
        });
      }
      opts.onRequestCompaction(focus ? { focus } : {});
      return jsonResult({
        status: "scheduled",
        ...(focus ? { focus } : {}),
        note: "Session compaction was requested and runs after this turn. Continue the conversation normally.",
      });
    },
  };
}

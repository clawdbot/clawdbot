import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Type } from "typebox";
import {
  clampDelayMs,
  resolveContinuationRuntimeConfig,
} from "../../auto-reply/continuation/config.js";
import type { ContinueWorkRequest } from "../../auto-reply/continuation/types.js";
import { formatActiveContinuationTraceparent } from "../../infra/continuation-tracer.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readToolStringParam, ToolInputError } from "./common.js";

const log = createSubsystemLogger("continuation/continue-work");

export type { ContinueWorkRequest } from "../../auto-reply/continuation/types.js";

const ContinueWorkToolSchema = Type.Object({
  reason: Type.String({
    description:
      "Why another turn is needed before you yield. Logged for diagnostics and continuation context.",
    maxLength: 1024,
  }),
  delaySeconds: Type.Optional(
    Type.Number({
      minimum: 0,
      description:
        "Seconds to wait before the next turn fires. 0 or omitted = immediate. " +
        "Positive delays are clamped to continuation.minDelayMs / maxDelayMs from config.",
    }),
  ),
});

type ContinueWorkToolOpts = {
  agentSessionKey?: string;
  requestContinuation: (request: ContinueWorkRequest) => void;
};

export function createContinueWorkTool(opts: ContinueWorkToolOpts): AnyAgentTool {
  return {
    label: "Continuation",
    name: "continue_work",
    description: [
      "Schedule another turn in this same session for concrete follow-up work that cannot finish in the current turn.",
      "Do not use continue_work to wait, yield, stand by, park, or keep the session alive after all tasks are complete.",
      "For waiting or parking, use sessions_yield when a deliberate yield is needed, or schedule no continuation.",
      "Use delaySeconds only when real follow-up work should run later; reason captures the specific remaining work for diagnostics.",
    ].join(" "),
    parameters: ContinueWorkToolSchema,
    execute: async (_toolCallId, args) => {
      if (!isRecord(args)) {
        throw new ToolInputError("continue_work arguments must be an object.");
      }
      const params = args;
      const sessionKey = opts.agentSessionKey;

      if (!sessionKey) {
        throw new ToolInputError(
          "continue_work requires an active session. Not available in sessionless contexts.",
        );
      }

      const reason = readToolStringParam(params, "reason", { required: true }).slice(0, 1024);
      const parsedDelaySeconds = readNumberParam(params, "delaySeconds", { strict: true });
      if (parsedDelaySeconds !== undefined && parsedDelaySeconds < 0) {
        throw new ToolInputError("delaySeconds must be a non-negative number.");
      }
      const delaySeconds = parsedDelaySeconds ?? 0;
      const traceparent = formatActiveContinuationTraceparent();
      const traceContextFields = traceparent ? { traceparent } : {};

      log.debug(
        `[continue_work:request] session=${sessionKey} delaySeconds=${delaySeconds} reason=${reason.slice(0, 80)}`,
      );
      opts.requestContinuation({
        reason,
        delaySeconds,
        ...traceContextFields,
      });

      // Report the resolved delay (post-clamp) so the model knows when its
      // next turn will actually fire, not just the raw input value.
      const continuationConfig = resolveContinuationRuntimeConfig();
      const resolvedDelayMs = clampDelayMs(delaySeconds * 1000, continuationConfig);
      const resolvedDelaySeconds = Math.round(resolvedDelayMs / 1000);

      return jsonResult({
        status: "scheduled",
        delaySeconds: resolvedDelaySeconds,
        ...(resolvedDelaySeconds !== delaySeconds
          ? {
              note: `Requested ${delaySeconds}s, clamped to ${resolvedDelaySeconds}s by continuation config.`,
            }
          : {}),
      });
    },
  };
}

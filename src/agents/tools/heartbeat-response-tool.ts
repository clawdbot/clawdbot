/**
 * Heartbeat response tool.
 *
 * Auto-reply heartbeat turns use this tool to record the agent's outcome,
 * notification decision, and next-check metadata exactly once per turn.
 */
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Type } from "typebox";
import {
  HEARTBEAT_RESPONSE_TOOL_NAME,
  HEARTBEAT_TOOL_OUTCOMES,
  HEARTBEAT_TOOL_PRIORITIES,
  normalizeHeartbeatToolResponse,
} from "../../auto-reply/heartbeat-tool-response.js";
import { assertCronJobScratchContent } from "../../cron/scratch-contract.js";
import { readSnakeCaseParamRaw } from "../../param-key.js";
import { optionalStringEnum, stringEnum } from "../schema/string-enum.js";
import type { AnyAgentTool } from "./common.js";
import { textResult, ToolInputError } from "./common.js";

const HeartbeatResponseToolSchema = Type.Object(
  {
    outcome: stringEnum(HEARTBEAT_TOOL_OUTCOMES),
    notify: Type.Boolean(),
    summary: Type.String(),
    notificationText: Type.Optional(Type.String()),
    reason: Type.Optional(Type.String()),
    priority: optionalStringEnum(HEARTBEAT_TOOL_PRIORITIES),
    nextCheck: Type.Optional(Type.String()),
    scratch: Type.Optional(
      Type.String({
        description:
          "Complete replacement for heartbeat monitor prose. Recurring schedules belong in cron jobs, not scratch.",
      }),
    ),
  },
  { additionalProperties: false },
);

function readRequiredBoolean(params: Record<string, unknown>, key: string): boolean {
  const raw = readSnakeCaseParamRaw(params, key);
  if (typeof raw !== "boolean") {
    throw new ToolInputError(`${key} required`);
  }
  return raw;
}

/** Creates the one-shot heartbeat response recording tool for an auto-reply turn. */
export function createHeartbeatResponseTool(): AnyAgentTool {
  let recorded = false;
  return {
    label: "Heartbeat",
    name: HEARTBEAT_RESPONSE_TOOL_NAME,
    displaySummary: "Record heartbeat outcome/notify choice.",
    description:
      "Record heartbeat result. `notify=false` no visible send. `notify=true` needs concise notificationText. Scratch is monitor prose only; manage recurring tasks with cron.",
    parameters: HeartbeatResponseToolSchema,
    execute: async (_toolCallId, args) => {
      if (!isRecord(args)) {
        throw new ToolInputError("Heartbeat response arguments required");
      }
      readRequiredBoolean(args, "notify");
      if (typeof args.scratch === "string") {
        try {
          assertCronJobScratchContent(args.scratch);
        } catch (error) {
          throw new ToolInputError(error instanceof Error ? error.message : String(error));
        }
      }
      const response = normalizeHeartbeatToolResponse(args);
      if (!response) {
        throw new ToolInputError(
          "Invalid heartbeat response. Provide outcome, notify, and non-empty summary.",
        );
      }
      if (recorded) {
        // One heartbeat turn should produce one decision; repeated calls can
        // otherwise overwrite the notify/no-notify choice.
        throw new ToolInputError("heartbeat_respond already recorded for this turn");
      }
      recorded = true;
      const { scratch, ...publicResponse } = response;
      const details = { status: "recorded" as const, ...publicResponse } as typeof response & {
        status: "recorded";
      };
      if (scratch !== undefined) {
        // Keep future prompt content out of model-visible tool output and logs;
        // the runner receives it through the internal result details only.
        Object.defineProperty(details, "scratch", { value: scratch, enumerable: false });
      }
      return textResult(
        JSON.stringify(
          {
            status: "recorded",
            ...publicResponse,
            ...(scratch !== undefined
              ? {
                  // Persistence is a runner-side CAS after the turn; do not claim
                  // success here. A lost race is logged and retryable next beat.
                  scratchPending: true,
                  scratchBytes: Buffer.byteLength(scratch, "utf8"),
                }
              : {}),
          },
          null,
          2,
        ),
        details,
      );
    },
  };
}

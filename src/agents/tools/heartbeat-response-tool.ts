import { Type } from "typebox";
import {
  HEARTBEAT_RESPONSE_TOOL_NAME,
  HEARTBEAT_TOOL_OUTCOMES,
  HEARTBEAT_TOOL_PRIORITIES,
  normalizeHeartbeatToolResponse,
} from "../../auto-reply/heartbeat-tool-response.js";
import { readSnakeCaseParamRaw } from "../../param-key.js";
import { optionalStringEnum, stringEnum } from "../schema/string-enum.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, ToolInputError } from "./common.js";

const HeartbeatResponseToolSchema = Type.Object(
  {
    outcome: stringEnum(HEARTBEAT_TOOL_OUTCOMES),
    notify: Type.Boolean(),
    summary: Type.String(),
    notificationText: Type.Optional(Type.String()),
    reason: Type.Optional(Type.String()),
    priority: optionalStringEnum(HEARTBEAT_TOOL_PRIORITIES),
    nextCheck: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readRequiredBoolean(params: Record<string, unknown>, key: string): boolean {
  const raw = readSnakeCaseParamRaw(params, key);
  if (typeof raw !== "boolean") {
    throw new ToolInputError(`${key} required`);
  }
  return raw;
}

export function createHeartbeatResponseTool(): AnyAgentTool {
  return {
    label: "Heartbeat",
    name: HEARTBEAT_RESPONSE_TOOL_NAME,
    displaySummary: "Record a heartbeat outcome and whether it should notify the user.",
    description:
      "Record the result of a heartbeat run. Use notify=false when nothing should be sent visibly. Use notify=true with notificationText when the user should receive a concise heartbeat alert.",
    parameters: HeartbeatResponseToolSchema,
    execute: async (_toolCallId, args) => {
      if (!isRecord(args)) {
        throw new ToolInputError("Heartbeat response arguments required");
      }
      readRequiredBoolean(args, "notify");
      const response = normalizeHeartbeatToolResponse(args);
      if (!response) {
        throw new ToolInputError(
          "Invalid heartbeat response. Provide outcome, notify, and non-empty summary.",
        );
      }
      return jsonResult({
        status: "recorded",
        ...response,
      });
    },
  };
}

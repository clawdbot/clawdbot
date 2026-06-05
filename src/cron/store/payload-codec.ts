/** SQLite column codec for cron payload variants. */
import type { CronPayload } from "../types.js";
import {
  booleanToInteger,
  integerToBoolean,
  normalizeNumber,
  parseJsonArray,
  parseJsonValue,
  serializeJson,
} from "./scalar-codec.js";
import type { CronJobInsert, CronJobRow } from "./schema.js";

function parseExternalContentSource(raw: string | null): "gmail" | "webhook" | undefined {
  const parsed = raw ? parseJsonValue<unknown>(raw, undefined) : undefined;
  return parsed === "gmail" || parsed === "webhook" ? parsed : undefined;
}

/** Maps cron payload variants into normalized SQLite columns. */
export function bindPayloadColumns(
  payload: CronPayload,
): Pick<
  CronJobInsert,
  | "payload_allow_unsafe_external_content"
  | "payload_external_content_source_json"
  | "payload_fallbacks_json"
  | "payload_kind"
  | "payload_light_context"
  | "payload_message"
  | "payload_model"
  | "payload_thinking"
  | "payload_timeout_seconds"
  | "payload_tools_allow_json"
> {
  if (payload.kind === "systemEvent") {
    return {
      payload_kind: "systemEvent",
      payload_message: payload.text,
      payload_model: null,
      payload_fallbacks_json: null,
      payload_thinking: null,
      payload_timeout_seconds: null,
      payload_allow_unsafe_external_content: null,
      payload_external_content_source_json: null,
      payload_light_context: null,
      payload_tools_allow_json: null,
    };
  }
  return {
    payload_kind: "agentTurn",
    payload_message: payload.message,
    payload_model: payload.model ?? null,
    payload_fallbacks_json: serializeJson(payload.fallbacks),
    payload_thinking: payload.thinking ?? null,
    payload_timeout_seconds: payload.timeoutSeconds ?? null,
    payload_allow_unsafe_external_content: booleanToInteger(payload.allowUnsafeExternalContent),
    payload_external_content_source_json: serializeJson(payload.externalContentSource),
    payload_light_context: booleanToInteger(payload.lightContext),
    payload_tools_allow_json: serializeJson(payload.toolsAllow),
  };
}

/** Reconstructs cron payload variants from SQLite columns, returning null for invalid rows. */
export function payloadFromRow(row: CronJobRow): CronPayload | null {
  if (row.payload_kind === "systemEvent") {
    return row.payload_message == null ? null : { kind: "systemEvent", text: row.payload_message };
  }
  if (row.payload_kind === "agentTurn") {
    if (row.payload_message == null) {
      return null;
    }
    const fallbacks = row.payload_fallbacks_json
      ? parseJsonArray(row.payload_fallbacks_json)
      : undefined;
    const timeoutSeconds = normalizeNumber(row.payload_timeout_seconds);
    const allowUnsafeExternalContent =
      row.payload_allow_unsafe_external_content != null
        ? integerToBoolean(row.payload_allow_unsafe_external_content)
        : undefined;
    const externalContentSource = parseExternalContentSource(
      row.payload_external_content_source_json,
    );
    const lightContext =
      row.payload_light_context != null ? integerToBoolean(row.payload_light_context) : undefined;
    const toolsAllow = row.payload_tools_allow_json
      ? parseJsonArray(row.payload_tools_allow_json)
      : undefined;
    return {
      kind: "agentTurn",
      message: row.payload_message,
      ...(row.payload_model ? { model: row.payload_model } : {}),
      ...(fallbacks ? { fallbacks } : {}),
      ...(row.payload_thinking ? { thinking: row.payload_thinking } : {}),
      ...(timeoutSeconds != null ? { timeoutSeconds } : {}),
      ...(allowUnsafeExternalContent != null ? { allowUnsafeExternalContent } : {}),
      ...(externalContentSource ? { externalContentSource } : {}),
      ...(lightContext != null ? { lightContext } : {}),
      ...(toolsAllow ? { toolsAllow } : {}),
    };
  }
  return null;
}

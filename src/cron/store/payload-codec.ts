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

type CronPayloadToolAllow = Pick<CronPayload, "toolsAllow" | "toolsAllowIsDefault">;
type CronPayloadToolAllowColumns = Pick<
  CronJobInsert,
  "payload_tools_allow_json" | "payload_tools_allow_is_default"
>;

function bindPayloadToolAllowColumns(payload: CronPayloadToolAllow): CronPayloadToolAllowColumns {
  return {
    payload_tools_allow_json: serializeJson(payload.toolsAllow),
    payload_tools_allow_is_default: payload.toolsAllow
      ? booleanToInteger(payload.toolsAllowIsDefault)
      : null,
  };
}

function payloadToolAllowFromRow(
  row: Pick<CronJobRow, "payload_tools_allow_json" | "payload_tools_allow_is_default">,
): CronPayloadToolAllow {
  const toolsAllow = parseJsonArray(row.payload_tools_allow_json);
  if (!toolsAllow) {
    return {};
  }
  const toolsAllowIsDefault = integerToBoolean(row.payload_tools_allow_is_default);
  return {
    toolsAllow,
    ...(toolsAllowIsDefault ? { toolsAllowIsDefault: true } : {}),
  };
}

function parseExternalContentSource(raw: string | null): "gmail" | "webhook" | undefined {
  const parsed = raw ? parseJsonValue<unknown>(raw, undefined) : undefined;
  return parsed === "gmail" || parsed === "webhook" ? parsed : undefined;
}

function parseCommandPayloadMessage(
  raw: string | null,
): Omit<Extract<CronPayload, { kind: "command" }>, "kind" | "timeoutSeconds"> | null {
  const parsed = raw ? parseJsonValue<unknown>(raw, undefined) : undefined;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (
    !Array.isArray(record.argv) ||
    record.argv.length === 0 ||
    record.argv.some((value) => typeof value !== "string" || value.length === 0)
  ) {
    return null;
  }
  const argv = record.argv.map((value) => String(value));
  const env =
    record.env && typeof record.env === "object" && !Array.isArray(record.env)
      ? Object.fromEntries(
          Object.entries(record.env as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : undefined;
  const rawNoOutputTimeoutSeconds =
    typeof record.noOutputTimeoutSeconds === "number" ||
    typeof record.noOutputTimeoutSeconds === "bigint"
      ? record.noOutputTimeoutSeconds
      : null;
  const rawOutputMaxBytes =
    typeof record.outputMaxBytes === "number" || typeof record.outputMaxBytes === "bigint"
      ? record.outputMaxBytes
      : null;
  const noOutputTimeoutSeconds = normalizeNumber(rawNoOutputTimeoutSeconds);
  const outputMaxBytes = normalizeNumber(rawOutputMaxBytes);
  return {
    argv,
    ...(typeof record.cwd === "string" && record.cwd.trim() ? { cwd: record.cwd } : {}),
    ...(env && Object.keys(env).length > 0 ? { env } : {}),
    ...(typeof record.input === "string" ? { input: record.input } : {}),
    ...(noOutputTimeoutSeconds != null ? { noOutputTimeoutSeconds } : {}),
    ...(outputMaxBytes != null && outputMaxBytes > 0 ? { outputMaxBytes } : {}),
  };
}

function parseScriptPayloadMessage(
  raw: string | null,
): Omit<Extract<CronPayload, { kind: "script" }>, "kind" | "timeoutSeconds"> | null {
  const parsed = raw ? parseJsonValue<unknown>(raw, undefined) : undefined;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.script !== "string" || !record.script.trim()) {
    return null;
  }
  const toolBudget = normalizeNumber(
    typeof record.toolBudget === "number" || typeof record.toolBudget === "bigint"
      ? record.toolBudget
      : null,
  );
  return {
    script: record.script,
    ...(toolBudget != null ? { toolBudget } : {}),
  };
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
  | "payload_tools_allow_is_default"
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
      ...bindPayloadToolAllowColumns(payload),
    };
  }
  if (payload.kind === "command") {
    const {
      timeoutSeconds: _timeoutSeconds,
      toolsAllow: _toolsAllow,
      toolsAllowIsDefault: _toolsAllowIsDefault,
      ...payloadMessage
    } = payload;
    return {
      payload_kind: "command",
      payload_message: serializeJson(payloadMessage),
      payload_model: null,
      payload_fallbacks_json: null,
      payload_thinking: null,
      payload_timeout_seconds: payload.timeoutSeconds ?? null,
      payload_allow_unsafe_external_content: null,
      payload_external_content_source_json: null,
      payload_light_context: null,
      ...bindPayloadToolAllowColumns(payload),
    };
  }
  if (payload.kind === "script") {
    const {
      timeoutSeconds: _timeoutSeconds,
      toolsAllow: _toolsAllow,
      toolsAllowIsDefault: _toolsAllowIsDefault,
      ...payloadMessage
    } = payload;
    return {
      payload_kind: "script",
      payload_message: serializeJson(payloadMessage),
      payload_model: null,
      payload_fallbacks_json: null,
      payload_thinking: null,
      payload_timeout_seconds: payload.timeoutSeconds ?? null,
      payload_allow_unsafe_external_content: null,
      payload_external_content_source_json: null,
      payload_light_context: null,
      ...bindPayloadToolAllowColumns(payload),
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
    ...bindPayloadToolAllowColumns(payload),
  };
}

/** Reconstructs cron payload variants from SQLite columns, returning null for invalid rows. */
export function payloadFromRow(row: CronJobRow): CronPayload | null {
  if (row.payload_kind === "systemEvent") {
    if (row.payload_message == null) {
      return null;
    }
    return {
      kind: "systemEvent",
      text: row.payload_message,
      ...payloadToolAllowFromRow(row),
    };
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
      ...payloadToolAllowFromRow(row),
    };
  }
  if (row.payload_kind === "command") {
    const command = parseCommandPayloadMessage(row.payload_message);
    if (!command) {
      return null;
    }
    const timeoutSeconds = normalizeNumber(row.payload_timeout_seconds);
    return {
      kind: "command",
      ...command,
      ...(timeoutSeconds != null ? { timeoutSeconds } : {}),
      ...payloadToolAllowFromRow(row),
    };
  }
  if (row.payload_kind === "script") {
    const script = parseScriptPayloadMessage(row.payload_message);
    if (!script) {
      return null;
    }
    const timeoutSeconds = normalizeNumber(row.payload_timeout_seconds);
    return {
      kind: "script",
      ...script,
      ...(timeoutSeconds != null ? { timeoutSeconds } : {}),
      ...payloadToolAllowFromRow(row),
    };
  }
  return null;
}

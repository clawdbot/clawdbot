/** SQLite column codec for cron payload variants. */
import { safeParseJson } from "@openclaw/normalization-core";
import { isSystemOwnedCronPayloadKind, type CronPayload } from "../types.js";
import {
  booleanToInteger,
  integerToBoolean,
  normalizeNumber,
  parseJsonArray,
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
  const parsed = raw ? safeParseJson(raw) : undefined;
  return parsed === "gmail" || parsed === "webhook" ? parsed : undefined;
}

function parseCommandPayloadMessage(
  raw: string | null,
): Omit<Extract<CronPayload, { kind: "command" }>, "kind" | "timeoutSeconds"> | null {
  const parsed = raw ? safeParseJson(raw) : undefined;
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
  const parsed = raw ? safeParseJson(raw) : undefined;
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
  const agentTurn = payload.kind === "agentTurn" ? payload : undefined;
  let payloadMessage: string | null;
  if (payload.kind === "systemEvent") {
    payloadMessage = payload.text;
  } else if (payload.kind === "agentTurn") {
    payloadMessage = payload.message;
  } else if (payload.kind === "command" || payload.kind === "script") {
    const {
      timeoutSeconds: _timeoutSeconds,
      toolsAllow: _toolsAllow,
      toolsAllowIsDefault: _toolsAllowIsDefault,
      ...serializedPayload
    } = payload;
    payloadMessage = serializeJson(serializedPayload);
  } else {
    payloadMessage = null;
  }

  return {
    payload_kind: payload.kind,
    payload_message: payloadMessage,
    payload_model: agentTurn?.model ?? null,
    payload_fallbacks_json: serializeJson(agentTurn?.fallbacks),
    payload_thinking: agentTurn?.thinking ?? null,
    payload_timeout_seconds:
      payload.kind === "agentTurn" || payload.kind === "command" || payload.kind === "script"
        ? (payload.timeoutSeconds ?? null)
        : null,
    payload_allow_unsafe_external_content: booleanToInteger(agentTurn?.allowUnsafeExternalContent),
    payload_external_content_source_json: serializeJson(agentTurn?.externalContentSource),
    payload_light_context: booleanToInteger(agentTurn?.lightContext),
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
  if (isSystemOwnedCronPayloadKind(row.payload_kind)) {
    return { kind: row.payload_kind };
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

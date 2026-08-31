import { sql, type Expression, type RawBuilder } from "kysely";
import {
  DEFAULT_MISSING_TOOL_RESULT_TEXT,
  SYNTHETIC_MISSING_TOOL_RESULT_DETAIL_KEY,
} from "../../../packages/agent-core/src/harness/session/tool-result-pairing.js";
import { MODEL_CONTEXT_PRIVATE_METADATA_KEYS } from "../../shared/model-context-message.js";

/** Exclude storage-only fields in SQLite, before a row's JSON crosses into JavaScript. */
export function projectModelContextEventSql(
  event: Expression<string>,
  omitCheckpoint: Expression<number>,
): RawBuilder<string> {
  const paths = MODEL_CONTEXT_PRIVATE_METADATA_KEYS.map((key) => `$.message.__openclaw.${key}`);
  const projected = /* kysely-allow-raw: query-time JSON projection preserves durable transcript bytes. */ sql<string>`json_remove(${event}, ${sql.join(paths)})`;
  const modelEvent = /* kysely-allow-raw: tool result details are not model input; other details can be runtime context. */ sql<string>`CASE WHEN json_extract(${event}, '$.message.role') = 'toolResult'
    THEN json_remove(${projected}, '$.message.details') ELSE ${projected} END`;
  // The context owner classifies invalidated prefix checkpoints using the transport
  // contract. Other replay state must survive, including checkpoints after the cut.
  return /* kysely-allow-raw: exclude invalidated replay before hydrating a retained prefix. */ sql<string>`CASE WHEN ${omitCheckpoint} = 1
    THEN json_remove(${modelEvent}, '$.message.providerReplay') ELSE ${modelEvent} END`;
}

function pickJsonObject(value: Expression<string>, keys: readonly string[]): RawBuilder<string> {
  // json_each distinguishes absent properties from explicit nulls. Preserve JSON
  // subtypes so booleans and nested navigation facts do not become strings/numbers.
  return /* kysely-allow-raw: narrow JSON member selection, with bound property names. */ sql<string>`(SELECT json_group_object(key, CASE type
    WHEN 'object' THEN json(value) WHEN 'array' THEN json(value)
    WHEN 'true' THEN json('true') WHEN 'false' THEN json('false')
    ELSE value END) FROM json_each(${value}) WHERE key IN (${sql.join(keys)}))`;
}

const TRANSCRIPT_NAVIGATION_KEYS = [
  "type",
  "id",
  "parentId",
  "targetId",
  "appendParentId",
  "appendMode",
] as const;

/** Cursor resolution needs only tree facts, even when a row has an opaque body. */
export function projectTranscriptNavigationSql(event: Expression<string>): RawBuilder<string> {
  return pickJsonObject(event, TRANSCRIPT_NAVIGATION_KEYS);
}

/** Lightweight tree/state records; these never serve as persisted transcript evidence. */
export function projectModelContextNavigationSql(event: Expression<string>): RawBuilder<string> {
  const entry = pickJsonObject(event, [
    ...TRANSCRIPT_NAVIGATION_KEYS,
    "timestamp",
    "version",
    "cwd",
    "firstKeptEntryId",
    "reason",
    "tokensBefore",
    "thinkingLevel",
    "provider",
    "modelId",
    "fromId",
    "customType",
    "display",
    "label",
    "name",
  ]);
  const message = /* kysely-allow-raw: JSON message metadata is selected without content or native replay payloads. */ sql<string>`json_extract(${event}, '$.message')`;
  const messageFacts = pickJsonObject(message, [
    "role",
    "provider",
    "model",
    "timestamp",
    "excludeFromContext",
    "toolCallId",
    "toolUseId",
    "tool_call_id",
    "tool_use_id",
    "callId",
    "call_id",
    "toolName",
    "isError",
    "stopReason",
    "customType",
    "display",
  ]);
  const calls = /* kysely-allow-raw: pairing needs call identities, never tool arguments or result bodies. */ sql<string>`(SELECT json_group_array(json_object(
    'type', json_extract(value, '$.type'), 'id', json_extract(value, '$.id'),
    'name', json_extract(value, '$.name')))
    FROM json_each(${event}, '$.message.content') WHERE type = 'object'
    AND json_extract(value, '$.type') IN ('toolCall', 'toolUse', 'functionCall'))`;
  const synthetic = /* kysely-allow-raw: pairing prefers real results over synthetic missing-result placeholders. */ sql<number>`COALESCE(json_extract(${event}, ${`$.message.details.${SYNTHETIC_MISSING_TOOL_RESULT_DETAIL_KEY}`}), 0) = 1 OR EXISTS (
    SELECT 1 FROM json_each(${event}, '$.message.content') WHERE type = 'object'
    AND json_extract(value, '$.type') = 'text' AND json_extract(value, '$.text') = ${DEFAULT_MISSING_TOOL_RESULT_TEXT})`;
  return /* kysely-allow-raw: retain readable empty bodies only for navigation outside the model window. */ sql<string>`CASE json_extract(${event}, '$.type')
    WHEN 'message' THEN json_set(${entry}, '$.message', json_set(${messageFacts},
      '$.content', json(${calls}), '$.command', '', '$.output', '',
      '$.providerReplay', json_object('type', json_extract(${event}, '$.message.providerReplay.type')),
      '$.details', json_object(${SYNTHETIC_MISSING_TOOL_RESULT_DETAIL_KEY}, json(CASE WHEN (${synthetic}) THEN 'true' ELSE 'false' END))))
    WHEN 'custom_message' THEN json_set(${entry}, '$.content', json('[]'))
    WHEN 'compaction' THEN json_set(${entry}, '$.summary', '')
    WHEN 'branch_summary' THEN json_set(${entry}, '$.summary', '')
    ELSE ${entry} END`;
}

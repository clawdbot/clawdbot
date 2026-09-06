import { DatabaseSync } from "node:sqlite";
import { sql } from "kysely";
import { expect, it } from "vitest";
import { DEFAULT_MISSING_TOOL_RESULT_TEXT } from "../../../packages/agent-core/src/harness/session/tool-result-pairing.js";
import {
  clearNodeSqliteKyselyCacheForDatabase,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { projectModelContextNavigationSql } from "./session-model-context-projection.js";

function project(eventJson: string): unknown {
  const database = new DatabaseSync(":memory:");
  try {
    const db = getNodeSqliteKysely<Record<string, never>>(database);
    const row = executeSqliteQueryTakeFirstSync(
      database,
      db.selectNoFrom(projectModelContextNavigationSql(sql.val(eventJson)).as("navigation")),
    );
    if (!row) {
      throw new Error("Missing navigation result");
    }
    return JSON.parse(row.navigation);
  } finally {
    clearNodeSqliteKyselyCacheForDatabase(database);
    database.close();
  }
}

it("preserves absent, null, boolean, and nested navigation facts without retaining bodies", () => {
  const event = {
    type: "message",
    id: "typed",
    parentId: null,
    display: false,
    label: { nested: [true, false, null, { text: "synthetic" }] },
    message: {
      role: "custom",
      customType: null,
      timestamp: 0,
      display: true,
      excludeFromContext: false,
      isError: null,
      content: [{ type: "text", text: "private body" }],
      providerReplay: { type: "synthetic-replay", data: "private replay" },
      details: { private: "private details" },
      __openclaw: { upstreamUserText: "private metadata" },
    },
  };
  expect(project(JSON.stringify(event))).toEqual({
    type: "message",
    id: "typed",
    parentId: null,
    display: false,
    label: { nested: [true, false, null, { text: "synthetic" }] },
    message: {
      role: "custom",
      customType: null,
      timestamp: 0,
      display: true,
      excludeFromContext: false,
      isError: null,
      content: [],
      command: "",
      output: "",
      providerReplay: { type: "synthetic-replay" },
      details: { openclawSyntheticMissingToolResult: false },
    },
  });
});

it.each([undefined, null, false, 0, [], {}])(
  "keeps empty navigation for a missing or non-object message (%j)",
  (message) => {
    expect(project(JSON.stringify({ type: "message", id: "empty", message }))).toEqual({
      type: "message",
      id: "empty",
      message: {
        content: [],
        command: "",
        output: "",
        providerReplay: { type: null },
        details: { openclawSyntheticMissingToolResult: false },
      },
    });
  },
);

it("retains call identities and result aliases without tool arguments or text", () => {
  expect(
    project(
      JSON.stringify({
        type: "message",
        id: "calls",
        message: {
          role: "assistant",
          toolCallId: "a",
          toolUseId: "b",
          tool_call_id: "c",
          tool_use_id: "d",
          callId: "e",
          call_id: "f",
          toolName: "read",
          stopReason: "toolUse",
          content: [
            { type: "toolCall", id: "a", name: "read", arguments: { secret: "body" } },
            { type: "text", text: "private text" },
            null,
            false,
            "scalar",
            { type: "toolUse", id: "b", name: "write", input: { secret: "body" } },
            { type: "functionCall", id: "c", name: "search", arguments: "private" },
            { type: "image", data: "private image" },
          ],
        },
      }),
    ),
  ).toEqual({
    type: "message",
    id: "calls",
    message: {
      role: "assistant",
      toolCallId: "a",
      toolUseId: "b",
      tool_call_id: "c",
      tool_use_id: "d",
      callId: "e",
      call_id: "f",
      toolName: "read",
      stopReason: "toolUse",
      content: [
        { type: "toolCall", id: "a", name: "read" },
        { type: "toolUse", id: "b", name: "write" },
        { type: "functionCall", id: "c", name: "search" },
      ],
      command: "",
      output: "",
      providerReplay: { type: null },
      details: { openclawSyntheticMissingToolResult: false },
    },
  });
});

it.each([
  { marker: true, text: "ordinary", synthetic: true },
  { marker: 1, text: "ordinary", synthetic: true },
  { marker: false, text: DEFAULT_MISSING_TOOL_RESULT_TEXT, synthetic: true },
  { marker: null, text: DEFAULT_MISSING_TOOL_RESULT_TEXT + " extra", synthetic: false },
  { marker: undefined, text: "ordinary", synthetic: false },
])("classifies synthetic tool results from $marker and $text", ({ marker, text, synthetic }) => {
  expect(
    project(
      JSON.stringify({
        type: "message",
        message: {
          role: "toolResult",
          content: [{ type: "text", text }],
          details: { openclawSyntheticMissingToolResult: marker },
        },
      }),
    ),
  ).toEqual({
    type: "message",
    message: {
      role: "toolResult",
      content: [],
      command: "",
      output: "",
      providerReplay: { type: null },
      details: { openclawSyntheticMissingToolResult: synthetic },
    },
  });
});

it.each([
  { type: "reset", body: {} },
  { type: "compaction", body: { summary: "" } },
  { type: "branch_summary", body: { summary: "" } },
  { type: "custom_message", body: { content: [] } },
  { type: "opaque-synthetic", body: {} },
])("keeps $type navigation without its opaque payload", ({ type, body }) => {
  expect(
    project(
      JSON.stringify({
        type,
        id: "boundary",
        parentId: "previous",
        firstKeptEntryId: "kept",
        reason: "new",
        tokensBefore: 123,
        targetId: "target",
        appendParentId: "side",
        appendMode: "side",
        summary: "private summary",
        content: "private content",
        data: { private: "opaque body" },
      }),
    ),
  ).toEqual({
    type,
    id: "boundary",
    parentId: "previous",
    firstKeptEntryId: "kept",
    reason: "new",
    tokensBefore: 123,
    targetId: "target",
    appendParentId: "side",
    appendMode: "side",
    ...body,
  });
});

it("preserves duplicate navigation members and numeric values from exact JSON", () => {
  // Exact imports can retain duplicate members and numeric spellings that a
  // JSON.stringify fixture would normalize before the SQLite reader sees them.
  expect(
    project(
      '{"type":"message","id":"first","id":"last","timestamp":1.25e3,"tokensBefore":9007199254740991,"message":{"role":"user","role":"assistant","timestamp":0.125,"content":[]}}',
    ),
  ).toEqual({
    type: "message",
    id: "last",
    timestamp: 1250,
    tokensBefore: 9007199254740991,
    message: {
      role: "assistant",
      timestamp: 0.125,
      content: [],
      command: "",
      output: "",
      providerReplay: { type: null },
      details: { openclawSyntheticMissingToolResult: false },
    },
  });
});

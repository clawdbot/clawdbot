import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  loadTranscriptEventsSync,
  replaceSessionEntrySync,
  replaceTranscriptEventsSync,
} from "../../config/sessions/session-accessor.js";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { SessionManager } from "./session-manager.js";

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
});

function setup(state: OpenClawTestState) {
  const scope = {
    agentId: "main",
    env: state.env,
    expectedLifecycleRevision: "original-lifecycle",
    expectedWriterRunId: "original-writer",
    sessionId: "keyed-tool-result",
    sessionKey: "agent:main:keyed-tool-result",
    storePath: path.join(state.sessionsDir(), "sessions.json"),
  };
  replaceSessionEntrySync(scope, {
    activeWriterRunId: scope.expectedWriterRunId,
    lifecycleRevision: scope.expectedLifecycleRevision,
    sessionId: scope.sessionId,
    updatedAt: 1,
  });
  const manager = SessionManager.open(scope, state.workspaceDir);
  const assistantId = manager.appendMessage(
    makeAgentAssistantMessage({
      content: [
        { type: "toolCall", id: "call-first", name: "wait", arguments: {} },
        { type: "toolCall", id: "call-second", name: "read", arguments: {} },
      ],
      stopReason: "toolUse",
    }),
  );
  const message = {
    role: "toolResult" as const,
    toolCallId: "call-first",
    toolName: "wait",
    content: [{ type: "text" as const, text: "waiting" }],
    idempotencyKey: "result:first",
    isError: false,
    timestamp: 1,
  };
  const first = manager.appendMessageWithTranscriptAnchor(message);
  return { scope, manager, assistantId, message, first };
}

function rawRows(scope: ReturnType<typeof setup>["scope"]) {
  return openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteTranscriptScope(scope)))
    .db.prepare("SELECT event_json, seq FROM transcript_events WHERE session_id = ? ORDER BY seq")
    .all(scope.sessionId);
}

it.each(["warm", "cold", "bounded"] as const)(
  "adopts the canonical keyed tool result without changing bytes or cursors (%s)",
  async (mode) => {
    await withOpenClawTestState({ label: `tool-result-${mode}` }, async (state) => {
      const { scope, manager: original, message, first } = setup(state);
      const before = loadTranscriptEventsSync(scope);
      const beforeRows = rawRows(scope);
      if (mode === "cold") {
        closeOpenClawAgentDatabasesForTest();
      }
      const manager =
        mode === "warm"
          ? original
          : mode === "bounded"
            ? SessionManager.openBounded(scope, { maxBytes: 100_000, maxEvents: 1 })
            : SessionManager.open(scope, state.workspaceDir);

      expect(manager.appendMessageWithTranscriptAnchor({ ...message, timestamp: 99 })).toEqual({
        ...first,
        appended: false,
      });
      expect(manager.getLeafId()).toBe(first.entryId);
      expect(manager.getAppendParentId()).toBe(first.entryId);
      expect(loadTranscriptEventsSync(scope)).toEqual(before);
      expect(rawRows(scope)).toEqual(beforeRows);
      expect(manager.getEntry(first.entryId)).toMatchObject({ message });
      expect(manager.getEntries()).toHaveLength(2);
    });
  },
);

it("replays an earlier parallel sibling without rewinding the active tail", async () => {
  await withOpenClawTestState({ label: "tool-result-sibling" }, async (state) => {
    const { scope, manager, message, first } = setup(state);
    const sibling = manager.appendMessage({
      ...message,
      toolCallId: "call-second",
      toolName: "read",
      idempotencyKey: "result:second",
      content: [{ type: "text", text: "read result" }],
    });
    const before = loadTranscriptEventsSync(scope);
    const beforeRows = rawRows(scope);

    expect(manager.appendMessageWithTranscriptAnchor(message)).toEqual({
      ...first,
      appended: false,
    });
    expect(manager.getLeafId()).toBe(sibling);
    expect(manager.getAppendParentId()).toBe(sibling);
    expect(loadTranscriptEventsSync(scope)).toEqual(before);
    expect(rawRows(scope)).toEqual(beforeRows);
    expect(manager.getEntries()).toHaveLength(3);
  });
});

it.each([
  { content: [{ type: "text" as const, text: "changed" }] },
  { toolCallId: "call-changed" },
  { toolName: "changed" },
])("rejects keyed tool-result payload or identity drift: %j", async (change) => {
  await withOpenClawTestState({ label: "tool-result-conflict" }, async (state) => {
    const { scope, manager, message, first } = setup(state);
    const before = loadTranscriptEventsSync(scope);

    expect(() => manager.appendMessage({ ...message, ...change })).toThrow(
      "conflicts with the admitted message",
    );
    expect(manager.getAppendParentId()).toBe(first.entryId);
    expect(loadTranscriptEventsSync(scope)).toEqual(before);
  });
});

it.each(["assistant", "user", "inactive", "selected-branch"] as const)(
  "rejects a keyed result outside its current assistant-result group (%s)",
  async (boundary) => {
    await withOpenClawTestState({ label: `tool-result-${boundary}` }, async (state) => {
      const { scope, manager, assistantId, message } = setup(state);
      if (boundary === "assistant") {
        manager.appendMessage(
          makeAgentAssistantMessage({
            content: [{ type: "toolCall", id: message.toolCallId, name: "wait", arguments: {} }],
            stopReason: "toolUse",
          }),
        );
      } else if (boundary === "user") {
        manager.appendMessage({ role: "user", content: "next", timestamp: 2 });
      } else {
        manager.branch(assistantId);
        if (boundary === "inactive") {
          manager.appendMessage({ role: "user", content: "other branch", timestamp: 2 });
        }
      }
      const tail = manager.getAppendParentId();
      const before = loadTranscriptEventsSync(scope);

      expect(() => manager.appendMessage(message)).toThrow(
        boundary === "inactive"
          ? "Session transcript anchor was not returned"
          : boundary === "selected-branch"
            ? "cannot change the selected branch"
            : "outside the current group",
      );
      expect(manager.getAppendParentId()).toBe(tail);
      expect(loadTranscriptEventsSync(scope)).toEqual(before);
    });
  },
);

it.each(["writer", "lifecycle"] as const)(
  "rejects an identical keyed replay after the admitted %s changes",
  async (change) => {
    await withOpenClawTestState({ label: `tool-result-${change}` }, async (state) => {
      const { scope, manager, message, first } = setup(state);
      replaceSessionEntrySync(scope, {
        activeWriterRunId: change === "writer" ? "replacement-writer" : scope.expectedWriterRunId,
        lifecycleRevision:
          change === "lifecycle" ? "replacement-lifecycle" : scope.expectedLifecycleRevision,
        sessionId: scope.sessionId,
        updatedAt: 2,
      });
      const before = loadTranscriptEventsSync(scope);

      expect(() => manager.appendMessage(message)).toThrow(
        "session writer claim changed before transcript persistence",
      );
      expect(manager.getAppendParentId()).toBe(first.entryId);
      expect(loadTranscriptEventsSync(scope)).toEqual(before);
    });
  },
);

it("rejects a generation change between the SQLite replay receipt and adoption", async () => {
  await withOpenClawTestState({ label: "tool-result-generation" }, async (state) => {
    const { scope, manager, message, first } = setup(state);
    const before = loadTranscriptEventsSync(scope);
    const reload = manager.reloadPersistedTranscript.bind(manager);
    vi.spyOn(manager, "reloadPersistedTranscript").mockImplementationOnce(() => {
      expect(replaceTranscriptEventsSync(scope, before)).toBe(true);
      reload();
    });

    expect(() => manager.appendMessage(message)).toThrow("outside the current group");
    expect(manager.getAppendParentId()).toBe(first.entryId);
    expect(loadTranscriptEventsSync(scope)).toEqual(before);
  });
});

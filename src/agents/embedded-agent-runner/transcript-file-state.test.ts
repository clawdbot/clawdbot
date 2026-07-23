// Transcript file state tests cover tolerant JSONL reads, malformed entries,
// branch leaf recovery, and repair-supported legacy payload shapes.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseSessionEntries, SessionManager } from "../sessions/index.js";
import { rewriteTranscriptEntriesInState } from "./transcript-rewrite.js";

const roots: string[] = [];

async function readTranscriptState(sessionFile: string): Promise<SessionManager> {
  return SessionManager.fromEntries(parseSessionEntries(await fs.readFile(sessionFile, "utf8")));
}

async function persistTranscriptStateMutation(params: {
  sessionFile: string;
  state: SessionManager;
  appendedEntries: unknown[];
}): Promise<void> {
  const entries = params.state.migrated
    ? params.state.getPersistedEntries()
    : params.appendedEntries;
  const content = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  if (params.state.migrated) {
    await fs.writeFile(params.sessionFile, content, "utf8");
  } else {
    await fs.appendFile(params.sessionFile, content, "utf8");
  }
}

async function makeRoot(prefix: string): Promise<string> {
  // Each file-state case writes a full JSONL transcript under its own root so
  // orphan/leaf behavior stays isolated.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("readTranscriptState", () => {
  it("normalizes appended session names to one line", async () => {
    const root = await makeRoot("openclaw-transcript-state-name-");
    const sessionFile = path.join(root, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "session-1",
        timestamp: "2026-07-16T00:00:00.000Z",
        cwd: root,
      })}\n`,
      "utf-8",
    );
    const state = await readTranscriptState(sessionFile);

    const entry = state.getEntry(state.appendSessionInfo("  first\nsecond\r\nthird  "))!;

    expect(entry).toMatchObject({ name: "first second third" });
    expect(state.getEntries().at(-1)).toMatchObject({ name: "first second third" });
  });

  it("skips malformed session entries without moving the active leaf", async () => {
    // Bad rows are ignored for branch construction, but valid legacy orphan
    // roots remain reachable so partial imports can still be replayed.
    const root = await makeRoot("openclaw-transcript-state-malformed-");
    const sessionFile = path.join(root, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "session-1",
          timestamp: "2026-05-16T00:00:00.000Z",
          cwd: root,
        }),
        JSON.stringify({
          type: "message",
          id: "user-1",
          parentId: null,
          timestamp: "2026-05-16T00:00:01.000Z",
          message: { role: "user", content: "hello" },
        }),
        JSON.stringify({
          type: "message",
          id: "assistant-1",
          parentId: "user-1",
          timestamp: "2026-05-16T00:00:02.000Z",
          message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
        }),
        JSON.stringify({
          type: "message",
          id: "bash-1",
          parentId: "assistant-1",
          timestamp: "2026-05-16T00:00:02.500Z",
          message: {
            role: "bashExecution",
            command: "echo ok",
            output: "ok\n",
            exitCode: 0,
            cancelled: false,
            truncated: false,
          },
        }),
        JSON.stringify({
          type: "message",
          id: "bad-message",
          parentId: "bash-1",
          timestamp: "2026-05-16T00:00:03.000Z",
          message: { content: "missing role" },
        }),
        JSON.stringify({
          type: "message",
          id: "bad-missing-content",
          parentId: "assistant-1",
          timestamp: "2026-05-16T00:00:03.500Z",
          message: { role: "user" },
        }),
        JSON.stringify({
          type: "message",
          id: "bad-unsupported-role",
          parentId: "assistant-1",
          timestamp: "2026-05-16T00:00:03.750Z",
          message: { role: "system", content: "not an agent message" },
        }),
        JSON.stringify({
          type: "label",
          parentId: "bad-message",
          timestamp: "2026-05-16T00:00:04.000Z",
          targetId: "user-1",
          label: "missing id",
        }),
        JSON.stringify({
          type: "future_poison",
          id: "unknown-type",
          parentId: "assistant-1",
          timestamp: "2026-05-16T00:00:05.000Z",
        }),
        JSON.stringify({
          type: "model_change",
          id: "orphan-model-change",
          parentId: "bad-message",
          timestamp: "2026-05-16T00:00:06.000Z",
          provider: "openai",
          modelId: "gpt-5.5",
        }),
        JSON.stringify({
          type: "message",
          id: "orphan-user-child",
          parentId: "bad-missing-content",
          timestamp: "2026-05-16T00:00:06.500Z",
          message: { role: "user", content: "child of malformed user content" },
        }),
        JSON.stringify({
          type: "message",
          id: "legacy-orphan",
          parentId: "missing-import-parent",
          timestamp: "2026-05-16T00:00:07.000Z",
          message: { role: "user", content: "partial import keeps this row" },
        }),
        JSON.stringify({
          type: "message",
          id: "legacy-orphan-child",
          parentId: "legacy-orphan",
          timestamp: "2026-05-16T00:00:08.000Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "still reachable from the orphan root" }],
          },
        }),
      ].join("\n"),
      "utf-8",
    );

    const state = await readTranscriptState(sessionFile);

    expect(state.getEntries().map((entry) => entry.id)).toEqual([
      "user-1",
      "assistant-1",
      "bash-1",
      "orphan-model-change",
      "orphan-user-child",
      "legacy-orphan",
      "legacy-orphan-child",
    ]);
    expect(state.getLeafId()).toBe("legacy-orphan-child");
    expect(state.getBranch().map((entry) => entry.id)).toEqual([
      "legacy-orphan",
      "legacy-orphan-child",
    ]);
  });

  it("keeps assistant rows with legacy string content", async () => {
    const root = await makeRoot("openclaw-transcript-state-assistant-string-");
    const sessionFile = path.join(root, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "session-1",
          timestamp: "2026-05-16T00:00:00.000Z",
          cwd: root,
        }),
        JSON.stringify({
          type: "message",
          id: "user-1",
          parentId: null,
          timestamp: "2026-05-16T00:00:01.000Z",
          message: { role: "user", content: "prompt" },
        }),
        JSON.stringify({
          type: "message",
          id: "assistant-string",
          parentId: "user-1",
          timestamp: "2026-05-16T00:00:02.000Z",
          message: { role: "assistant", content: "legacy reply" },
        }),
      ].join("\n"),
      "utf-8",
    );

    const state = await readTranscriptState(sessionFile);

    expect(state.getEntries().map((entry) => entry.id)).toEqual(["user-1", "assistant-string"]);
    expect(state.buildSessionContext().messages).toMatchObject([
      { role: "user", content: "prompt" },
      { role: "assistant", content: [{ type: "text", text: "legacy reply" }] },
    ]);
  });

  it("preserves repair-supported assistant tool call payload shapes", async () => {
    const root = await makeRoot("openclaw-transcript-state-tool-input-");
    const sessionFile = path.join(root, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "session-1",
          timestamp: "2026-05-16T00:00:00.000Z",
          cwd: root,
        }),
        JSON.stringify({
          type: "message",
          id: "user-1",
          parentId: null,
          timestamp: "2026-05-16T00:00:01.000Z",
          message: { role: "user", content: "read a file" },
        }),
        JSON.stringify({
          type: "message",
          id: "assistant-tool",
          parentId: "user-1",
          timestamp: "2026-05-16T00:00:02.000Z",
          message: {
            role: "assistant",
            content: [
              { type: "toolUse", id: "call-input", name: "read", input: { path: "README.md" } },
              { type: "toolCall", id: "call-args", name: "write", arguments: { path: "out" } },
              { type: "toolUse", id: "call-no-args", name: "list" },
              {
                type: "function_call",
                call_id: "call-legacy",
                name: "search",
                arguments: '{"query":"docs"}',
              },
              { type: "toolCall", id: "call-null-args", name: "noop", arguments: null },
            ],
          },
        }),
        JSON.stringify({
          type: "message",
          id: "tool-result",
          parentId: "assistant-tool",
          timestamp: "2026-05-16T00:00:03.000Z",
          message: {
            role: "toolResult",
            toolCallId: "call-input",
            toolName: "read",
            content: [{ type: "text", text: "contents" }],
            isError: false,
          },
        }),
      ].join("\n"),
      "utf-8",
    );

    const state = await readTranscriptState(sessionFile);

    expect(state.getEntries().map((entry) => entry.id)).toEqual([
      "user-1",
      "assistant-tool",
      "tool-result",
    ]);
    expect(state.getLeafId()).toBe("tool-result");
    expect(state.buildSessionContext().messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
    ]);
  });

  it("preserves OpenClaw-authored non-model content blocks", async () => {
    const root = await makeRoot("openclaw-transcript-state-openclaw-blocks-");
    const sessionFile = path.join(root, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "session-1",
          timestamp: "2026-05-16T00:00:00.000Z",
          cwd: root,
        }),
        JSON.stringify({
          type: "message",
          id: "user-1",
          parentId: null,
          timestamp: "2026-05-16T00:00:01.000Z",
          message: { role: "user", content: "read the injected blocks" },
        }),
        JSON.stringify({
          type: "message",
          id: "assistant-audio",
          parentId: "user-1",
          timestamp: "2026-05-16T00:00:02.000Z",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "voice reply" },
              { type: "audio", data: "UklGRg==", mimeType: "audio/wav" },
            ],
          },
        }),
        JSON.stringify({
          type: "message",
          id: "tool-result",
          parentId: "assistant-audio",
          timestamp: "2026-05-16T00:00:03.000Z",
          message: {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "codex_progress",
            content: [
              {
                type: "toolResult",
                id: "call-1",
                toolUseId: "call-1",
                content: "progress payload",
                text: "progress payload",
              },
            ],
            isError: false,
          },
        }),
      ].join("\n"),
      "utf-8",
    );

    const state = await readTranscriptState(sessionFile);
    const messages = state.buildSessionContext().messages;

    expect(state.getEntries().map((entry) => entry.id)).toEqual([
      "user-1",
      "assistant-audio",
      "tool-result",
    ]);
    expect(state.getLeafId()).toBe("tool-result");
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
    expect(messages[1]).toMatchObject({ content: [{ type: "text" }, { type: "audio" }] });
    expect(messages[2]).toMatchObject({ content: [{ type: "toolResult" }] });
  });

  it("preserves empty compaction summary entries as the active leaf", async () => {
    const root = await makeRoot("openclaw-transcript-state-empty-compaction-");
    const sessionFile = path.join(root, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "session-1",
          timestamp: "2026-05-16T00:00:00.000Z",
          cwd: root,
        }),
        JSON.stringify({
          type: "message",
          id: "user-1",
          parentId: null,
          timestamp: "2026-05-16T00:00:01.000Z",
          message: { role: "user", content: "fresh question" },
        }),
        JSON.stringify({
          type: "message",
          id: "assistant-1",
          parentId: "user-1",
          timestamp: "2026-05-16T00:00:02.000Z",
          message: { role: "assistant", content: [{ type: "text", text: "fresh answer" }] },
        }),
        JSON.stringify({
          type: "compaction",
          id: "compact-1",
          parentId: "assistant-1",
          timestamp: "2026-05-16T00:00:03.000Z",
          summary: "",
          firstKeptEntryId: "user-1",
          tokensBefore: 200,
        }),
      ].join("\n"),
      "utf-8",
    );

    const state = await readTranscriptState(sessionFile);

    expect(state.getEntries().map((entry) => entry.id)).toEqual([
      "user-1",
      "assistant-1",
      "compact-1",
    ]);
    expect(state.getLeafId()).toBe("compact-1");
  });

  it("skips JSON-valid non-object rows", async () => {
    const root = await makeRoot("openclaw-transcript-state-null-row-");
    const sessionFile = path.join(root, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "session-1",
          timestamp: "2026-05-16T00:00:00.000Z",
          cwd: root,
        }),
        "null",
        "false",
        JSON.stringify({
          type: "message",
          id: "user-1",
          parentId: null,
          timestamp: "2026-05-16T00:00:01.000Z",
          message: { role: "user", content: "still readable" },
        }),
      ].join("\n"),
      "utf-8",
    );

    const state = await readTranscriptState(sessionFile);

    expect(state.getEntries().map((entry) => entry.id)).toEqual(["user-1"]);
    expect(state.getLeafId()).toBe("user-1");
    expect(state.getBranch().map((entry) => entry.id)).toEqual(["user-1"]);
  });

  it("skips JSON-valid non-object rows before legacy migration", async () => {
    const root = await makeRoot("openclaw-transcript-state-v1-null-row-");
    const sessionFile = path.join(root, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({
          type: "session",
          version: 1,
          id: "session-1",
          timestamp: "2026-05-16T00:00:00.000Z",
          cwd: root,
        }),
        "null",
        JSON.stringify({
          type: "message",
          timestamp: "2026-05-16T00:00:01.000Z",
          message: { role: "user", content: "legacy prompt" },
        }),
        "false",
        JSON.stringify({
          type: "message",
          timestamp: "2026-05-16T00:00:02.000Z",
          message: { role: "assistant", content: [{ type: "text", text: "legacy reply" }] },
        }),
      ].join("\n"),
      "utf-8",
    );

    const state = await readTranscriptState(sessionFile);

    expect(state.migrated).toBe(true);
    expect(state.getEntries()).toHaveLength(2);
    expect(state.buildSessionContext().messages).toMatchObject([
      { role: "user", content: "legacy prompt" },
      { role: "assistant", content: [{ type: "text", text: "legacy reply" }] },
    ]);
  });

  it("canonicalizes opaque append parents before a legacy migration rewrite", async () => {
    const root = await makeRoot("openclaw-transcript-state-v1-opaque-parent-");
    const sessionFile = path.join(root, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        {
          type: "session",
          version: 1,
          id: "session-1",
          timestamp: "2026-06-15T00:00:00.000Z",
          cwd: root,
        },
        {
          type: "message",
          timestamp: "2026-06-15T00:00:01.000Z",
          message: { role: "assistant", content: "legacy active" },
        },
        {
          type: "metadata",
          id: "plugin-metadata",
          parentId: "missing-before-migration",
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
      "utf8",
    );

    const state = await readTranscriptState(sessionFile);
    const activeLeafId = state.getLeafId();
    const appended = state.getEntry(
      state.appendMessage({ role: "user", content: "continued", timestamp: Date.now() }),
    )!;
    await persistTranscriptStateMutation({
      sessionFile,
      state,
      appendedEntries: [appended],
    });

    expect(state.migrated).toBe(true);
    expect(appended.parentId).toBe(activeLeafId);
    const reopened = await readTranscriptState(sessionFile);
    expect(reopened.getBranch().map((entry) => entry.id)).toEqual([activeLeafId, appended.id]);
  });

  it("preserves legacy compaction keep indexes across JSON-valid non-object rows", async () => {
    const root = await makeRoot("openclaw-transcript-state-v1-compaction-null-row-");
    const sessionFile = path.join(root, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({
          type: "session",
          version: 1,
          id: "session-1",
          timestamp: "2026-05-16T00:00:00.000Z",
          cwd: root,
        }),
        JSON.stringify({
          type: "message",
          timestamp: "2026-05-16T00:00:01.000Z",
          message: { role: "user", content: "legacy prelude" },
        }),
        "null",
        JSON.stringify({
          type: "message",
          timestamp: "2026-05-16T00:00:02.000Z",
          message: { role: "user", content: "legacy kept suffix" },
        }),
        JSON.stringify({
          type: "compaction",
          timestamp: "2026-05-16T00:00:03.000Z",
          summary: "summary",
          firstKeptEntryIndex: 3,
          tokensBefore: 200,
        }),
      ].join("\n"),
      "utf-8",
    );

    const state = await readTranscriptState(sessionFile);
    const kept = state
      .getEntries()
      .find(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "user" &&
          entry.message.content === "legacy kept suffix",
      );
    const compaction = state.getEntries().find((entry) => entry.type === "compaction");

    expect(kept).toBeDefined();
    expect(compaction).toMatchObject({ firstKeptEntryId: kept?.id });
    expect(state.buildSessionContext().messages).toMatchObject([
      { role: "compactionSummary", summary: "summary" },
      { role: "user", content: "legacy kept suffix" },
    ]);
  });

  it("relinks valid current rows past malformed parents", async () => {
    const root = await makeRoot("openclaw-transcript-state-current-suffix-");
    const sessionFile = path.join(root, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "session-1",
          timestamp: "2026-05-16T00:00:00.000Z",
          cwd: root,
        }),
        JSON.stringify({
          type: "message",
          id: "user-1",
          parentId: null,
          timestamp: "2026-05-16T00:00:01.000Z",
          message: { role: "user", content: "before malformed row" },
        }),
        JSON.stringify({
          type: "message",
          id: "bad-message",
          parentId: "user-1",
          timestamp: "2026-05-16T00:00:02.000Z",
          message: { role: "user" },
        }),
        JSON.stringify({
          type: "message",
          id: "user-2",
          parentId: "bad-message",
          timestamp: "2026-05-16T00:00:03.000Z",
          message: { role: "user", content: "after malformed row" },
        }),
      ].join("\n"),
      "utf-8",
    );

    const state = await readTranscriptState(sessionFile);

    expect(state.getEntries().map((entry) => entry.id)).toEqual(["user-1", "user-2"]);
    expect(state.getLeafId()).toBe("user-2");
    expect(state.getBranch().map((entry) => entry.id)).toEqual(["user-1", "user-2"]);
  });

  it("remaps compaction keep markers past malformed rows", async () => {
    const root = await makeRoot("openclaw-transcript-state-compaction-marker-");
    const sessionFile = path.join(root, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "session-1",
          timestamp: "2026-05-16T00:00:00.000Z",
          cwd: root,
        }),
        JSON.stringify({
          type: "message",
          id: "user-1",
          parentId: null,
          timestamp: "2026-05-16T00:00:01.000Z",
          message: { role: "user", content: "before malformed row" },
        }),
        JSON.stringify({
          type: "message",
          id: "bad-message",
          parentId: "user-1",
          timestamp: "2026-05-16T00:00:02.000Z",
          message: { role: "user" },
        }),
        JSON.stringify({
          type: "message",
          id: "assistant-1",
          parentId: "bad-message",
          timestamp: "2026-05-16T00:00:03.000Z",
          message: { role: "assistant", content: [{ type: "text", text: "after malformed row" }] },
        }),
        JSON.stringify({
          type: "compaction",
          id: "compact-1",
          parentId: "assistant-1",
          timestamp: "2026-05-16T00:00:04.000Z",
          summary: "summary",
          firstKeptEntryId: "bad-message",
          tokensBefore: 200,
        }),
      ].join("\n"),
      "utf-8",
    );

    const state = await readTranscriptState(sessionFile);
    const compaction = state.getEntries().find((entry) => entry.type === "compaction");

    expect(compaction).toMatchObject({ firstKeptEntryId: "user-1" });
    expect(state.buildSessionContext().messages).toMatchObject([
      { role: "compactionSummary", summary: "summary" },
      { role: "user", content: "before malformed row" },
      { role: "assistant", content: [{ type: "text", text: "after malformed row" }] },
    ]);
  });

  it("keeps valid suffixes when a compaction marker points at a malformed root", async () => {
    const root = await makeRoot("openclaw-transcript-state-compaction-root-marker-");
    const sessionFile = path.join(root, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "session-1",
          timestamp: "2026-05-16T00:00:00.000Z",
          cwd: root,
        }),
        JSON.stringify({
          type: "message",
          id: "bad-message",
          parentId: null,
          timestamp: "2026-05-16T00:00:01.000Z",
          message: { role: "user" },
        }),
        JSON.stringify({
          type: "message",
          id: "user-1",
          parentId: "bad-message",
          timestamp: "2026-05-16T00:00:02.000Z",
          message: { role: "user", content: "first valid kept turn" },
        }),
        JSON.stringify({
          type: "message",
          id: "assistant-1",
          parentId: "user-1",
          timestamp: "2026-05-16T00:00:03.000Z",
          message: { role: "assistant", content: [{ type: "text", text: "valid reply" }] },
        }),
        JSON.stringify({
          type: "compaction",
          id: "compact-1",
          parentId: "assistant-1",
          timestamp: "2026-05-16T00:00:04.000Z",
          summary: "summary",
          firstKeptEntryId: "bad-message",
          tokensBefore: 200,
        }),
      ].join("\n"),
      "utf-8",
    );

    const state = await readTranscriptState(sessionFile);
    const compaction = state.getEntries().find((entry) => entry.type === "compaction");

    expect(compaction).toMatchObject({ firstKeptEntryId: "user-1" });
    expect(state.buildSessionContext().messages).toMatchObject([
      { role: "compactionSummary", summary: "summary" },
      { role: "user", content: "first valid kept turn" },
      { role: "assistant", content: [{ type: "text", text: "valid reply" }] },
    ]);
  });

  it("remaps compaction keep markers through consecutive malformed rows", async () => {
    const root = await makeRoot("openclaw-transcript-state-compaction-chain-marker-");
    const sessionFile = path.join(root, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "session-1",
          timestamp: "2026-05-16T00:00:00.000Z",
          cwd: root,
        }),
        JSON.stringify({
          type: "message",
          id: "bad-root",
          parentId: null,
          timestamp: "2026-05-16T00:00:01.000Z",
          message: { role: "user" },
        }),
        JSON.stringify({
          type: "message",
          id: "bad-child",
          parentId: "bad-root",
          timestamp: "2026-05-16T00:00:02.000Z",
          message: { role: "assistant" },
        }),
        JSON.stringify({
          type: "message",
          id: "user-1",
          parentId: "bad-child",
          timestamp: "2026-05-16T00:00:03.000Z",
          message: { role: "user", content: "first valid kept turn" },
        }),
        JSON.stringify({
          type: "message",
          id: "assistant-1",
          parentId: "user-1",
          timestamp: "2026-05-16T00:00:04.000Z",
          message: { role: "assistant", content: [{ type: "text", text: "valid reply" }] },
        }),
        JSON.stringify({
          type: "compaction",
          id: "compact-1",
          parentId: "assistant-1",
          timestamp: "2026-05-16T00:00:05.000Z",
          summary: "summary",
          firstKeptEntryId: "bad-root",
          tokensBefore: 200,
        }),
      ].join("\n"),
      "utf-8",
    );

    const state = await readTranscriptState(sessionFile);
    const compaction = state.getEntries().find((entry) => entry.type === "compaction");

    expect(compaction).toMatchObject({ firstKeptEntryId: "user-1" });
    expect(state.buildSessionContext().messages).toMatchObject([
      { role: "compactionSummary", summary: "summary" },
      { role: "user", content: "first valid kept turn" },
      { role: "assistant", content: [{ type: "text", text: "valid reply" }] },
    ]);
  });

  it("remaps malformed compaction markers to descendants on the active branch", async () => {
    const root = await makeRoot("openclaw-transcript-state-compaction-branch-marker-");
    const sessionFile = path.join(root, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "session-1",
          timestamp: "2026-05-16T00:00:00.000Z",
          cwd: root,
        }),
        JSON.stringify({
          type: "message",
          id: "bad-message",
          parentId: null,
          timestamp: "2026-05-16T00:00:01.000Z",
          message: { role: "user" },
        }),
        JSON.stringify({
          type: "message",
          id: "branch-a-user",
          parentId: "bad-message",
          timestamp: "2026-05-16T00:00:02.000Z",
          message: { role: "user", content: "other branch" },
        }),
        JSON.stringify({
          type: "message",
          id: "branch-b-user",
          parentId: "bad-message",
          timestamp: "2026-05-16T00:00:03.000Z",
          message: { role: "user", content: "active branch kept turn" },
        }),
        JSON.stringify({
          type: "message",
          id: "branch-b-assistant",
          parentId: "branch-b-user",
          timestamp: "2026-05-16T00:00:04.000Z",
          message: { role: "assistant", content: [{ type: "text", text: "active reply" }] },
        }),
        JSON.stringify({
          type: "compaction",
          id: "compact-1",
          parentId: "branch-b-assistant",
          timestamp: "2026-05-16T00:00:05.000Z",
          summary: "summary",
          firstKeptEntryId: "bad-message",
          tokensBefore: 200,
        }),
      ].join("\n"),
      "utf-8",
    );

    const state = await readTranscriptState(sessionFile);
    const compaction = state.getEntries().find((entry) => entry.type === "compaction");

    expect(compaction).toMatchObject({ firstKeptEntryId: "branch-b-user" });
    expect(state.buildSessionContext().messages).toMatchObject([
      { role: "compactionSummary", summary: "summary" },
      { role: "user", content: "active branch kept turn" },
      { role: "assistant", content: [{ type: "text", text: "active reply" }] },
    ]);
  });

  it("does not hang on rejected parent cycles", async () => {
    const root = await makeRoot("openclaw-transcript-state-rejected-cycle-");
    const sessionFile = path.join(root, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "session-1",
          timestamp: "2026-05-16T00:00:00.000Z",
          cwd: root,
        }),
        JSON.stringify({
          type: "message",
          id: "bad-message",
          parentId: "bad-message",
          timestamp: "2026-05-16T00:00:01.000Z",
          message: { role: "user" },
        }),
        JSON.stringify({
          type: "message",
          id: "user-1",
          parentId: "bad-message",
          timestamp: "2026-05-16T00:00:02.000Z",
          message: { role: "user", content: "kept after cycle" },
        }),
      ].join("\n"),
      "utf-8",
    );

    const state = await readTranscriptState(sessionFile);

    expect(state.getEntries().map((entry) => ({ id: entry.id, parentId: entry.parentId }))).toEqual(
      [{ id: "user-1", parentId: null }],
    );
    expect(state.getBranch().map((entry) => entry.id)).toEqual(["user-1"]);
  });

  it("breaks cycles between canonical and opaque rows", async () => {
    const root = await makeRoot("openclaw-transcript-state-canonical-opaque-cycle-");
    const sessionFile = path.join(root, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        {
          type: "session",
          version: 3,
          id: "session-1",
          timestamp: "2026-06-15T00:00:00.000Z",
          cwd: root,
        },
        {
          type: "message",
          id: "active-entry",
          parentId: "opaque-cycle",
          timestamp: "2026-06-15T00:00:01.000Z",
          message: { role: "user", content: "kept through cycle" },
        },
        {
          type: "metadata",
          id: "opaque-cycle",
          parentId: "active-entry",
          payload: { source: "plugin" },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
      "utf-8",
    );

    const state = await readTranscriptState(sessionFile);

    expect(state.getBranch().map((entry) => ({ id: entry.id, parentId: entry.parentId }))).toEqual([
      { id: "active-entry", parentId: null },
    ]);
    expect(state.buildSessionContext().messages).toMatchObject([
      { role: "user", content: "kept through cycle" },
    ]);
    const appended = state.getEntry(
      state.appendMessage({ role: "user", content: "continued", timestamp: Date.now() }),
    )!;
    expect(appended.parentId).toBe("active-entry");
    expect(state.getBranch().map((entry) => entry.id)).toEqual(["active-entry", appended.id]);
  });

  it("drops missing parents reached through rejected rows before rewrite replay", async () => {
    const root = await makeRoot("openclaw-transcript-state-rejected-missing-parent-");
    const sessionFile = path.join(root, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "session-1",
          timestamp: "2026-05-16T00:00:00.000Z",
          cwd: root,
        }),
        JSON.stringify({
          type: "message",
          id: "bad-message",
          parentId: "missing-parent",
          timestamp: "2026-05-16T00:00:01.000Z",
          message: { role: "user" },
        }),
        JSON.stringify({
          type: "message",
          id: "user-1",
          parentId: "bad-message",
          timestamp: "2026-05-16T00:00:02.000Z",
          message: { role: "user", content: "kept after missing malformed parent" },
        }),
      ].join("\n"),
      "utf-8",
    );

    const state = await readTranscriptState(sessionFile);

    expect(state.getEntries().map((entry) => ({ id: entry.id, parentId: entry.parentId }))).toEqual(
      [{ id: "user-1", parentId: null }],
    );
    expect(state.getBranch().map((entry) => entry.id)).toEqual(["user-1"]);
    expect(() =>
      rewriteTranscriptEntriesInState({
        state,
        replacements: [
          {
            entryId: "user-1",
            message: { role: "user", content: "replacement prompt", timestamp: 1 },
          },
        ],
      }),
    ).not.toThrow();
  });

  it("drops labels targeting rejected entries before transcript rewrite replay", async () => {
    const root = await makeRoot("openclaw-transcript-state-rejected-label-");
    const sessionFile = path.join(root, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "session-1",
          timestamp: "2026-05-16T00:00:00.000Z",
          cwd: root,
        }),
        JSON.stringify({
          type: "message",
          id: "user-1",
          parentId: null,
          timestamp: "2026-05-16T00:00:01.000Z",
          message: { role: "user", content: "before malformed row" },
        }),
        JSON.stringify({
          type: "message",
          id: "bad-message",
          parentId: "user-1",
          timestamp: "2026-05-16T00:00:02.000Z",
          message: { role: "user" },
        }),
        JSON.stringify({
          type: "message",
          id: "user-2",
          parentId: "bad-message",
          timestamp: "2026-05-16T00:00:03.000Z",
          message: { role: "user", content: "after malformed row" },
        }),
        JSON.stringify({
          type: "label",
          id: "label-1",
          parentId: "user-2",
          timestamp: "2026-05-16T00:00:04.000Z",
          targetId: "bad-message",
          label: "bad",
        }),
        JSON.stringify({
          type: "message",
          id: "user-3",
          parentId: "label-1",
          timestamp: "2026-05-16T00:00:05.000Z",
          message: { role: "user", content: "after poisoned label" },
        }),
      ].join("\n"),
      "utf-8",
    );

    const state = await readTranscriptState(sessionFile);

    expect(state.getEntries().map((entry) => ({ id: entry.id, parentId: entry.parentId }))).toEqual(
      [
        { id: "user-1", parentId: null },
        { id: "user-2", parentId: "user-1" },
        { id: "user-3", parentId: "user-2" },
      ],
    );
    expect(state.getLabel("bad-message")).toBeUndefined();
    expect(() =>
      rewriteTranscriptEntriesInState({
        state,
        replacements: [
          {
            entryId: "user-1",
            message: { role: "user", content: "replacement prompt", timestamp: 1 },
          },
        ],
      }),
    ).not.toThrow();
  });

  it("applies leaf controls to active state and marker-linked descendants", async () => {
    const root = await makeRoot("openclaw-transcript-state-leaf-");
    const sessionFile = path.join(root, "session.jsonl");
    const header = {
      type: "session",
      version: 3,
      id: "session-1",
      timestamp: "2026-05-16T00:00:00.000Z",
      cwd: root,
    };
    const rootEntry = {
      type: "message",
      id: "root-user",
      parentId: null,
      timestamp: "2026-05-16T00:00:01.000Z",
      message: { role: "user", content: "root question" },
    };
    const abandonedEntry = {
      type: "message",
      id: "abandoned-assistant",
      parentId: rootEntry.id,
      timestamp: "2026-05-16T00:00:02.000Z",
      message: { role: "assistant", content: "abandoned answer" },
    };
    const leafEntry = {
      type: "leaf",
      id: "leaf-1",
      parentId: abandonedEntry.id,
      timestamp: "2026-05-16T00:00:03.000Z",
      targetId: rootEntry.id,
    };
    await fs.writeFile(
      sessionFile,
      [header, rootEntry, abandonedEntry, leafEntry]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
      "utf8",
    );

    const selectedState = await readTranscriptState(sessionFile);
    expect(selectedState.getLeafId()).toBe(rootEntry.id);
    expect(selectedState.getBranch().map((entry) => entry.id)).toEqual([rootEntry.id]);

    const replacementEntry = {
      type: "message",
      id: "replacement-assistant",
      parentId: leafEntry.id,
      timestamp: "2026-05-16T00:00:04.000Z",
      message: { role: "assistant", content: "replacement answer" },
    };
    await fs.appendFile(sessionFile, `${JSON.stringify(replacementEntry)}\n`, "utf8");

    const reopened = await readTranscriptState(sessionFile);
    expect(reopened.getEntries().find((entry) => entry.id === replacementEntry.id)).toEqual(
      expect.objectContaining({ parentId: rootEntry.id }),
    );
    expect(reopened.getBranch().map((entry) => entry.id)).toEqual([
      rootEntry.id,
      replacementEntry.id,
    ]);
  });

  it("keeps parentless canonical ancestry through rewrite replay", async () => {
    const root = await makeRoot("openclaw-transcript-state-parentless-leaf-");
    const sessionFile = path.join(root, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        {
          type: "session",
          version: 3,
          id: "session-1",
          timestamp: "2026-06-15T00:00:00.000Z",
          cwd: root,
        },
        {
          type: "message",
          id: "user-1",
          timestamp: "2026-06-15T00:00:01.000Z",
          message: { role: "user", content: "question", timestamp: 1 },
        },
        {
          type: "message",
          id: "assistant-1",
          timestamp: "2026-06-15T00:00:02.000Z",
          message: { role: "assistant", content: "answer", timestamp: 2 },
        },
        {
          type: "leaf",
          id: "active-leaf",
          parentId: "assistant-1",
          timestamp: "2026-06-15T00:00:03.000Z",
          targetId: "assistant-1",
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
      "utf8",
    );

    const state = await readTranscriptState(sessionFile);
    expect(state.getBranch().map((entry) => entry.id)).toEqual(["user-1", "assistant-1"]);

    rewriteTranscriptEntriesInState({
      state,
      replacements: [
        {
          entryId: "user-1",
          message: { role: "user", content: "rewritten question", timestamp: 3 },
        },
      ],
    });

    expect(state.buildSessionContext().messages).toMatchObject([
      { role: "user", content: "rewritten question" },
      { role: "assistant", content: [{ type: "text", text: "answer" }] },
    ]);
  });

  it("preserves marked side ancestry without capturing the next active append", async () => {
    const root = await makeRoot("openclaw-transcript-state-side-append-");
    const sessionFile = path.join(root, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        {
          type: "session",
          version: 3,
          id: "session-1",
          timestamp: "2026-06-15T00:00:00.000Z",
          cwd: root,
        },
        {
          type: "message",
          id: "active-root",
          parentId: null,
          timestamp: "2026-06-15T00:00:01.000Z",
          message: { role: "assistant", content: "active" },
        },
        {
          type: "message",
          id: "side-one",
          parentId: "active-root",
          timestamp: "2026-06-15T00:00:02.000Z",
          message: { role: "assistant", content: "first side delivery" },
        },
        {
          type: "leaf",
          id: "first-leaf",
          parentId: "side-one",
          timestamp: "2026-06-15T00:00:03.000Z",
          targetId: "active-root",
          appendParentId: "side-one",
          appendMode: "side",
        },
        {
          type: "message",
          id: "side-two",
          parentId: "side-one",
          timestamp: "2026-06-15T00:00:04.000Z",
          appendMode: "side",
          message: { role: "assistant", content: "second side delivery" },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
      "utf8",
    );

    const state = await readTranscriptState(sessionFile);

    expect(state.getBranch("side-two").map((entry) => entry.id)).toEqual([
      "active-root",
      "side-one",
      "side-two",
    ]);
    expect(state.getBranch().map((entry) => entry.id)).toEqual(["active-root"]);
    expect(state.getLeafId()).toBe("active-root");
    expect(state.getAppendParentId()).toBe("side-two");
    expect(state.getAppendMode()).toBe("side");

    const nextUser = state.getEntry(
      state.appendMessage({ role: "user", content: "next question", timestamp: Date.now() }),
    )!;
    expect(state.getBranch(nextUser.id).map((entry) => entry.id)).toEqual([
      "active-root",
      nextUser.id,
    ]);
  });

  it("keeps a terminal leaf control's opaque append parent", async () => {
    const root = await makeRoot("openclaw-transcript-state-opaque-append-parent-");
    const sessionFile = path.join(root, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        {
          type: "session",
          version: 3,
          id: "session-1",
          timestamp: "2026-06-15T00:00:00.000Z",
          cwd: root,
        },
        {
          type: "message",
          id: "active-root",
          parentId: null,
          timestamp: "2026-06-15T00:00:01.000Z",
          message: { role: "assistant", content: "active" },
        },
        {
          type: "metadata",
          id: "plugin-metadata",
          parentId: null,
          payload: { source: "plugin" },
        },
        {
          type: "message",
          id: "side-delivery",
          parentId: "active-root",
          timestamp: "2026-06-15T00:00:02.000Z",
          message: { role: "assistant", content: "side delivery" },
        },
        {
          type: "leaf",
          id: "active-leaf",
          parentId: "side-delivery",
          timestamp: "2026-06-15T00:00:03.000Z",
          targetId: "active-root",
          appendParentId: "plugin-metadata",
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
      "utf8",
    );

    const state = await readTranscriptState(sessionFile);
    const appended = state.getEntry(
      state.appendMessage({ role: "user", content: "continued", timestamp: Date.now() }),
    )!;
    await persistTranscriptStateMutation({
      sessionFile,
      state,
      appendedEntries: [appended],
    });
    const persisted = (await fs.readFile(sessionFile, "utf8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(state.getLeafId()).toBe(appended.id);
    expect(appended.parentId).toBe("active-root");
    expect(state.getBranch().map((entry) => entry.id)).toEqual(["active-root", appended.id]);
    expect(persisted.at(-1)).toMatchObject({ id: appended.id, parentId: "active-root" });
  });

  it("ignores leaf controls with dangling target or append references", async () => {
    const root = await makeRoot("openclaw-transcript-state-invalid-leaf-");
    const sessionFile = path.join(root, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        {
          type: "session",
          version: 3,
          id: "session-1",
          timestamp: "2026-06-15T00:00:00.000Z",
          cwd: root,
        },
        {
          type: "message",
          id: "active-root",
          parentId: null,
          timestamp: "2026-06-15T00:00:01.000Z",
          message: { role: "assistant", content: "active" },
        },
        {
          type: "metadata",
          id: "plugin-metadata",
          parentId: "active-root",
          payload: { source: "plugin" },
        },
        {
          type: "leaf",
          id: "missing-target",
          parentId: "plugin-metadata",
          timestamp: "2026-06-15T00:00:02.000Z",
          targetId: "missing",
        },
        {
          type: "leaf",
          id: "missing-append",
          parentId: "missing-target",
          timestamp: "2026-06-15T00:00:03.000Z",
          targetId: "active-root",
          appendParentId: "missing",
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
      "utf8",
    );

    const state = await readTranscriptState(sessionFile);
    const appended = state.getEntry(
      state.appendMessage({ role: "user", content: "continued", timestamp: Date.now() }),
    )!;
    await persistTranscriptStateMutation({
      sessionFile,
      state,
      appendedEntries: [appended],
    });

    expect(appended.parentId).toBe("active-root");
    expect(state.getBranch().map((entry) => entry.id)).toEqual(["active-root", appended.id]);
    const reopened = await readTranscriptState(sessionFile);
    expect(reopened.getLeafId()).toBe(appended.id);
    expect(reopened.getBranch().map((entry) => entry.id)).toEqual(["active-root", appended.id]);
  });

  it("keeps legacy roots that are missing tree metadata", async () => {
    const root = await makeRoot("openclaw-transcript-state-legacy-root-");
    const sessionFile = path.join(root, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "session-1",
          timestamp: "2026-05-16T00:00:00.000Z",
          cwd: root,
        }),
        JSON.stringify({
          type: "message",
          id: "legacy-root",
          message: { role: "user", content: "legacy prompt" },
        }),
        JSON.stringify({
          type: "message",
          id: "tree-child",
          parentId: "legacy-root",
          timestamp: "2026-05-16T00:00:01.000Z",
          message: { role: "assistant", content: [{ type: "text", text: "tree reply" }] },
        }),
      ].join("\n"),
      "utf-8",
    );

    const state = await readTranscriptState(sessionFile);

    expect(state.getEntries().map((entry) => entry.id)).toEqual(["legacy-root", "tree-child"]);
    expect(state.getLeafId()).toBe("tree-child");
    expect(state.getBranch().map((entry) => entry.id)).toEqual(["legacy-root", "tree-child"]);
  });

  it("relinks migrated legacy suffixes past malformed rows", async () => {
    const root = await makeRoot("openclaw-transcript-state-legacy-suffix-");
    const sessionFile = path.join(root, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({
          type: "session",
          version: 1,
          id: "session-1",
          timestamp: "2026-05-16T00:00:00.000Z",
          cwd: root,
        }),
        JSON.stringify({
          type: "message",
          timestamp: "2026-05-16T00:00:01.000Z",
          message: { role: "user", content: "before malformed row" },
        }),
        JSON.stringify({
          type: "message",
          timestamp: "2026-05-16T00:00:02.000Z",
          message: { content: "missing role" },
        }),
        JSON.stringify({
          type: "message",
          timestamp: "2026-05-16T00:00:03.000Z",
          message: { role: "user", content: "after malformed row" },
        }),
      ].join("\n"),
      "utf-8",
    );

    const state = await readTranscriptState(sessionFile);

    const branchText = state.getBranch().map((entry) => {
      const message = entry.type === "message" ? entry.message : null;
      if (!message || message.role !== "user" || typeof message.content !== "string") {
        throw new Error("expected string message branch");
      }
      return message.content;
    });
    expect(branchText).toEqual(["before malformed row", "after malformed row"]);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

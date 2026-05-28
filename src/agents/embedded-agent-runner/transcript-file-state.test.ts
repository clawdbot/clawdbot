import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readTranscriptFileState } from "./transcript-file-state.js";
import { rewriteTranscriptEntriesInState } from "./transcript-rewrite.js";

const roots: string[] = [];

async function makeRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("readTranscriptFileState", () => {
  it("skips malformed session entries without moving the active leaf", async () => {
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

    const state = await readTranscriptFileState(sessionFile);

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

    const state = await readTranscriptFileState(sessionFile);

    expect(state.getEntries().map((entry) => entry.id)).toEqual(["user-1", "assistant-string"]);
    expect(state.buildSessionContext().messages).toMatchObject([
      { role: "user", content: "prompt" },
      { role: "assistant", content: "legacy reply" },
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

    const state = await readTranscriptFileState(sessionFile);

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

    const state = await readTranscriptFileState(sessionFile);
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

    const state = await readTranscriptFileState(sessionFile);

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

    const state = await readTranscriptFileState(sessionFile);

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

    const state = await readTranscriptFileState(sessionFile);

    expect(state.migrated).toBe(true);
    expect(state.getEntries()).toHaveLength(2);
    expect(state.buildSessionContext().messages).toMatchObject([
      { role: "user", content: "legacy prompt" },
      { role: "assistant", content: [{ type: "text", text: "legacy reply" }] },
    ]);
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

    const state = await readTranscriptFileState(sessionFile);
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

    const state = await readTranscriptFileState(sessionFile);

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

    const state = await readTranscriptFileState(sessionFile);
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

    const state = await readTranscriptFileState(sessionFile);
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

    const state = await readTranscriptFileState(sessionFile);
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

    const state = await readTranscriptFileState(sessionFile);
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

    const state = await readTranscriptFileState(sessionFile);

    expect(state.getEntries().map((entry) => ({ id: entry.id, parentId: entry.parentId }))).toEqual(
      [{ id: "user-1", parentId: null }],
    );
    expect(state.getBranch().map((entry) => entry.id)).toEqual(["user-1"]);
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

    const state = await readTranscriptFileState(sessionFile);

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

    const state = await readTranscriptFileState(sessionFile);

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

    const state = await readTranscriptFileState(sessionFile);

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

    const state = await readTranscriptFileState(sessionFile);

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

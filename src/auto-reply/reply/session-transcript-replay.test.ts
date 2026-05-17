import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_REPLAY_MAX_MESSAGES,
  replayRecentUserAssistantMessages,
} from "./session-transcript-replay.js";

const j = (obj: unknown): string => `${JSON.stringify(obj)}\n`;

function messageEntry(params: {
  id: string;
  role: "user" | "assistant";
  content: string;
  parentId?: string | null;
  timestamp?: string | number;
}): string {
  return j({
    type: "message",
    id: params.id,
    parentId: params.parentId ?? null,
    timestamp: params.timestamp ?? "2026-05-16T00:00:00.000Z",
    message: {
      role: params.role,
      content: params.content,
    },
  });
}

type ReplayRecord = {
  type?: string;
  id?: string;
  message?: {
    role?: string;
    content?: string;
  };
};

async function readJsonlRecords(filePath: string): Promise<ReplayRecord[]> {
  const records: ReplayRecord[] = [];
  const raw = await fs.readFile(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().length === 0) {
      continue;
    }
    records.push(JSON.parse(line) as ReplayRecord);
  }
  return records;
}

async function expectPathMissing(targetPath: string): Promise<void> {
  let statError: unknown;
  try {
    await fs.stat(targetPath);
  } catch (error) {
    statError = error;
  }
  if (statError === undefined) {
    throw new Error(`Expected ${targetPath} to be missing`);
  }
  if (!statError || typeof statError !== "object") {
    throw new Error("expected stat error object");
  }
  expect((statError as NodeJS.ErrnoException).code).toBe("ENOENT");
}

describe("replayRecentUserAssistantMessages", () => {
  let root = "";
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-replay-"));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const call = (source: string, target: string): Promise<number> =>
    replayRecentUserAssistantMessages({
      sourceTranscript: source,
      targetTranscript: target,
      newSessionId: "new-session",
    });

  it("replays only the user/assistant tail and skips tool/system/malformed records", async () => {
    const source = path.join(root, "prev.jsonl");
    const target = path.join(root, "next.jsonl");
    const lines: string[] = [j({ type: "session", id: "old" })];
    for (let i = 0; i < DEFAULT_REPLAY_MAX_MESSAGES + 4; i += 1) {
      lines.push(
        messageEntry({
          id: `entry-${i}`,
          role: i % 2 === 0 ? "user" : "assistant",
          content: `m${i}`,
          parentId: i > 0 ? `entry-${i - 1}` : null,
        }),
      );
    }
    lines.push(j({ type: "message", id: "tool", message: { role: "tool" } }));
    lines.push(j({ type: "compaction", timestamp: new Date().toISOString() }));
    lines.push("not-json-line\n");
    await fs.writeFile(source, lines.join(""), "utf8");

    expect(await call(source, target)).toBe(DEFAULT_REPLAY_MAX_MESSAGES);
    const records = await readJsonlRecords(target);
    expect(records[0]?.type).toBe("session");
    expect(records[0]?.id).toBe("new-session");
    expect(records).toHaveLength(1 + DEFAULT_REPLAY_MAX_MESSAGES);
    expect(records.slice(1).map((record) => record.message?.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(records.slice(1).map((record) => record.message?.content)).toEqual([
      "m4",
      "m5",
      "m6",
      "m7",
      "m8",
      "m9",
    ]);
    expect(await call(path.join(root, "missing.jsonl"), path.join(root, "out.jsonl"))).toBe(0);

    const assistantSource = path.join(root, "all-assistant.jsonl");
    const assistantTarget = path.join(root, "all-assistant-out.jsonl");
    const onlyAssistants = Array.from({ length: 3 }, (_, index) =>
      messageEntry({
        id: `assistant-${index}`,
        role: "assistant",
        content: "x",
        parentId: index > 0 ? `assistant-${index - 1}` : null,
      }),
    ).join("");
    await fs.writeFile(assistantSource, onlyAssistants, "utf8");
    expect(await call(assistantSource, assistantTarget)).toBe(0);
    await expectPathMissing(assistantTarget);
  });

  it("skips header for pre-existing targets and aligns the tail to a user turn", async () => {
    const source = path.join(root, "prev.jsonl");
    const target = path.join(root, "next.jsonl");
    await fs.writeFile(target, j({ type: "session", id: "existing" }), "utf8");
    const lines: string[] = [];
    for (let i = 0; i < DEFAULT_REPLAY_MAX_MESSAGES + 1; i += 1) {
      lines.push(
        messageEntry({
          id: `entry-${i}`,
          role: i % 2 === 0 ? "user" : "assistant",
          content: `m${i}`,
          parentId: i > 0 ? `entry-${i - 1}` : null,
        }),
      );
    }
    await fs.writeFile(source, lines.join(""), "utf8");

    expect(await call(source, target)).toBe(DEFAULT_REPLAY_MAX_MESSAGES - 1);
    const records = await readJsonlRecords(target);
    expect(records.reduce((count, r) => count + (r.type === "session" ? 1 : 0), 0)).toBe(1);
    expect(records[0]?.id).toBe("existing");
    expect(records[1].message?.role).toBe("user");
  });

  it("coalesces same-role runs so replayed records strictly alternate", async () => {
    const source = path.join(root, "prev.jsonl");
    const target = path.join(root, "next.jsonl");
    await fs.writeFile(
      source,
      [
        messageEntry({ id: "u1", role: "user", content: "older user" }),
        messageEntry({ id: "u2", role: "user", content: "latest user", parentId: "u1" }),
        messageEntry({
          id: "a1",
          role: "assistant",
          content: "older assistant",
          parentId: "u2",
        }),
        messageEntry({
          id: "a2",
          role: "assistant",
          content: "latest assistant",
          parentId: "a1",
        }),
        messageEntry({ id: "u3", role: "user", content: "follow-up", parentId: "a2" }),
        messageEntry({ id: "a3", role: "assistant", content: "answer", parentId: "u3" }),
      ].join(""),
      "utf8",
    );

    expect(await call(source, target)).toBe(4);
    const records = await readJsonlRecords(target);
    expect(records.slice(1).map((r) => r.message?.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(records.slice(1).map((r) => r.message?.content)).toEqual([
      "latest user",
      "latest assistant",
      "follow-up",
      "answer",
    ]);
  });

  it("skips malformed user and assistant-shaped rows without poisoning the target", async () => {
    const source = path.join(root, "prev.jsonl");
    const target = path.join(root, "next.jsonl");
    await fs.writeFile(
      source,
      [
        messageEntry({ id: "valid-user", role: "user", content: "keep user" }),
        j({ message: { role: "assistant", content: "missing type and id" } }),
        j({
          type: "message",
          id: "missing-timestamp",
          message: { role: "user", content: "missing timestamp" },
        }),
        j({
          type: "message",
          id: "bad-parent",
          parentId: 123,
          timestamp: "2026-05-16T00:00:01.000Z",
          message: { role: "assistant", content: "bad parent" },
        }),
        messageEntry({
          id: "valid-assistant",
          role: "assistant",
          content: "keep assistant",
          parentId: "valid-user",
          timestamp: "2026-05-16T00:00:02.000Z",
        }),
      ].join(""),
      "utf8",
    );

    expect(await call(source, target)).toBe(2);
    const records = await readJsonlRecords(target);
    expect(records.slice(1).map((record) => record.message?.content)).toEqual([
      "keep user",
      "keep assistant",
    ]);
    expect(records.slice(1).every((record) => record.type === "message")).toBe(true);
  });
});

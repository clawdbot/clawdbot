import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_REPLAY_MAX_MESSAGES,
  replayRecentUserAssistantMessages,
} from "./session-transcript-replay.js";

const j = (obj: unknown): string => `${JSON.stringify(obj)}\n`;

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
      lines.push(j({ message: { role: i % 2 === 0 ? "user" : "assistant", content: `m${i}` } }));
    }
    lines.push(j({ message: { role: "tool" } }));
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
    const onlyAssistants = Array.from({ length: 3 }, () =>
      j({ message: { role: "assistant", content: "x" } }),
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
      lines.push(j({ message: { role: i % 2 === 0 ? "user" : "assistant", content: `m${i}` } }));
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
        j({ message: { role: "user", content: "older user" } }),
        j({ message: { role: "user", content: "latest user" } }),
        j({ message: { role: "assistant", content: "older assistant" } }),
        j({ message: { role: "assistant", content: "latest assistant" } }),
        j({ message: { role: "user", content: "follow-up" } }),
        j({ message: { role: "assistant", content: "answer" } }),
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
});

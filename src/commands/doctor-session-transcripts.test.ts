import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const note = vi.hoisted(() => vi.fn());

vi.mock("../terminal/note.js", () => ({
  note,
}));

import {
  noteSessionTranscriptHealth,
  repairBrokenSessionTranscriptFile,
} from "./doctor-session-transcripts.js";

describe("doctor session transcript repair", () => {
  let root: string;

  beforeEach(async () => {
    note.mockClear();
    root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-transcripts-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function writeTranscript(entries: unknown[]): Promise<string> {
    const sessionsDir = path.join(root, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const filePath = path.join(sessionsDir, "session.jsonl");
    await fs.writeFile(filePath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    return filePath;
  }

  it("rewrites affected prompt-rewrite branches to the active branch", async () => {
    const filePath = await writeTranscript([
      { type: "session", version: 3, id: "session-1", timestamp: "2026-04-25T00:00:00Z" },
      {
        type: "message",
        id: "parent",
        parentId: null,
        message: { role: "assistant", content: "previous" },
      },
      {
        type: "message",
        id: "runtime-user",
        parentId: "parent",
        message: {
          role: "user",
          content: [
            "visible ask",
            "",
            "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
            "secret",
            "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
          ].join("\n"),
        },
      },
      {
        type: "message",
        id: "runtime-assistant",
        parentId: "runtime-user",
        message: { role: "assistant", content: "stale" },
      },
      {
        type: "message",
        id: "plain-user",
        parentId: "parent",
        message: { role: "user", content: "visible ask" },
      },
      {
        type: "message",
        id: "plain-assistant",
        parentId: "plain-user",
        message: { role: "assistant", content: "answer" },
      },
    ]);

    const result = await repairBrokenSessionTranscriptFile({ filePath, shouldRepair: true });

    expect(result).toMatchObject({
      broken: true,
      repaired: true,
      originalEntries: 6,
      activeEntries: 3,
    });
    expect(result.backupPath).toBeTruthy();
    await expect(fs.access(result.backupPath!)).resolves.toBeUndefined();
    const lines = (await fs.readFile(filePath, "utf-8")).trim().split(/\r?\n/);
    expect(lines).toHaveLength(4);
    expect(
      lines
        .map((line) => JSON.parse(line))
        .filter((entry) => entry.type !== "session")
        .map((entry) => entry.id),
    ).toEqual(["parent", "plain-user", "plain-assistant"]);
  });

  it("reports affected transcripts without rewriting outside repair mode", async () => {
    const filePath = await writeTranscript([
      { type: "session", version: 3, id: "session-1", timestamp: "2026-04-25T00:00:00Z" },
      {
        type: "message",
        id: "runtime-user",
        parentId: null,
        message: {
          role: "user",
          content:
            "visible ask\n\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nsecret\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
        },
      },
      {
        type: "message",
        id: "plain-user",
        parentId: null,
        message: { role: "user", content: "visible ask" },
      },
    ]);
    const sessionsDir = path.dirname(filePath);

    await noteSessionTranscriptHealth({ shouldRepair: false, sessionDirs: [sessionsDir] });

    expect(note).toHaveBeenCalledTimes(1);
    const [message, title] = note.mock.calls[0] as [string, string];
    expect(title).toBe("Session transcripts");
    expect(message).toContain("duplicated prompt-rewrite branches");
    expect(message).toContain('Run "openclaw doctor --fix"');
    expect((await fs.readFile(filePath, "utf-8")).split(/\r?\n/).filter(Boolean)).toHaveLength(3);
  });

  it("ignores ordinary branch history without internal runtime context", async () => {
    const filePath = await writeTranscript([
      { type: "session", version: 3, id: "session-1", timestamp: "2026-04-25T00:00:00Z" },
      {
        type: "message",
        id: "branch-a",
        parentId: null,
        message: { role: "user", content: "draft A" },
      },
      {
        type: "message",
        id: "branch-b",
        parentId: null,
        message: { role: "user", content: "draft B" },
      },
    ]);

    const result = await repairBrokenSessionTranscriptFile({ filePath, shouldRepair: true });

    expect(result.broken).toBe(false);
    expect((await fs.readFile(filePath, "utf-8")).split(/\r?\n/).filter(Boolean)).toHaveLength(3);
  });
});

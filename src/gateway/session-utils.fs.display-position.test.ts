import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { SessionTranscriptProjectionUnavailableError } from "../config/sessions/session-transcript-projection-error.js";
import { createNestedToolActivity } from "../sessions/nested-tool-activity.js";
import { ArchivedTranscriptReader } from "./session-utils.fs.js";

function activity(id: string, afterEntryId: string | null, startOrder: number) {
  return createNestedToolActivity({
    runId: "archive-run",
    scopeId: "archive-scope",
    afterEntryId,
    startOrder,
    toolCallId: id,
    toolName: "read",
    input: { file: "example.txt" },
    result: { content: [{ type: "text", text: "sanitized result" }] },
    isError: false,
    startedAt: 100 + startOrder,
    timestamp: 200 + startOrder,
  });
}

function entry(id: string, parentId: string | null, message: unknown) {
  return { type: "message", id, parentId, message };
}

function metadata(message: unknown) {
  return (message as { __openclaw: Record<string, unknown> })["__openclaw"];
}

function positions(messages: unknown[]) {
  return messages.map((message) => metadata(message).transcriptPosition);
}

describe("archive transcript display positions", () => {
  let dir: string;
  let storePath: string;
  const archiveOptions = { allowResetArchiveFallback: true, resetArchiveOnly: true };

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-archive-position-"));
    storePath = path.join(dir, "sessions.json");
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  function writeArchive(
    sessionId: string,
    records: unknown[],
    generation = "2026-08-28T00-00-00.000Z",
  ) {
    const file = path.join(dir, `${sessionId}.jsonl.reset.${generation}`);
    fs.writeFileSync(
      file,
      [{ type: "session", version: 3, id: sessionId }, ...records]
        .map((record) => JSON.stringify(record))
        .join("\n"),
    );
    return file;
  }

  test("keeps physical dispatch anchors across full, bounded recent, page, by-ID and around-ID reads", async () => {
    const sessionId = "nested-placement";
    writeArchive(sessionId, [
      entry("root", null, { role: "user", content: "prompt" }),
      entry("discarded", "root", { role: "assistant", content: "inactive branch" }),
      { type: "leaf", id: "dispatch-anchor", parentId: "discarded", targetId: "root" },
      entry("progress", "dispatch-anchor", { role: "assistant", content: "working" }),
      entry("fast", "progress", activity("fast", "dispatch-anchor", 1)),
      entry("slow", "fast", activity("slow", "dispatch-anchor", 0)),
      entry("later-progress", "slow", { role: "assistant", content: "still working" }),
      entry("later", "later-progress", activity("later", "fast", 2)),
      entry("unknown", "later", activity("unknown", "missing-anchor", 3)),
      entry("invalid", "unknown", {
        ...activity("invalid", "dispatch-anchor", 4),
        details: { ...activity("invalid", "dispatch-anchor", 4).details, startOrder: -1 },
      }),
      entry("missing", "invalid", {
        ...activity("missing", "dispatch-anchor", 5),
        details: { ...activity("missing", "dispatch-anchor", 5).details, afterEntryId: undefined },
      }),
      entry("final", "missing", { role: "assistant", content: "done" }),
    ]);
    const reader = new ArchivedTranscriptReader({ sessionId, storePath });
    const full = await reader.read({
      mode: "full",
      reason: "archive placement",
      ...archiveOptions,
    });
    const recentOptions = { maxMessages: 8, maxLines: 8, ...archiveOptions };
    const recent = await reader.readRecentWithStats(recentOptions);
    const bounded = await reader.read({ mode: "recent", ...recentOptions });
    const page = await reader.readPage({ offset: 0, maxMessages: 8, ...archiveOptions });
    const source = recent.displaySource;

    expect(source).toEqual(expect.any(String));
    expect(source).not.toContain(dir);
    expect(full.messages.map((message) => metadata(message).id)).toEqual([
      "root",
      "progress",
      "fast",
      "slow",
      "later-progress",
      "later",
      "unknown",
      "invalid",
      "missing",
      "final",
    ]);
    const expected = [
      { source, rawSeq: 2 },
      { source, rawSeq: 5 },
      { source, rawSeq: 6, activity: { afterRawSeq: 4, scopeId: "archive-scope", startOrder: 1 } },
      { source, rawSeq: 7, activity: { afterRawSeq: 4, scopeId: "archive-scope", startOrder: 0 } },
      { source, rawSeq: 8 },
      { source, rawSeq: 9, activity: { afterRawSeq: 6, scopeId: "archive-scope", startOrder: 2 } },
      { source, rawSeq: 10 },
      { source, rawSeq: 11 },
      { source, rawSeq: 12 },
      { source, rawSeq: 13 },
    ];
    expect(positions(full.messages)).toEqual(expected);
    for (const result of [recent, bounded, page]) {
      expect(positions(result.messages)).toEqual(expected.slice(2));
    }
    expect(recent.totalMessages).toBe(10);
    expect(page).toMatchObject({ totalMessages: 10, displaySource: source });
    for (const message of full.messages) {
      const id = metadata(message).id as string;
      const byId = await reader.readById(id, archiveOptions);
      const around = await reader.readAroundId({
        messageId: id,
        maxMessages: 2,
        ...archiveOptions,
      });
      expect(byId).toMatchObject({ found: true, oversized: false });
      expect(metadata(byId.message).transcriptPosition).toEqual(
        metadata(message).transcriptPosition,
      );
      expect(around).toMatchObject({ found: true, displaySource: source });
      expect(around.messages.find((row) => metadata(row).id === id)).toEqual(message);
    }
  });

  test("resolves a dispatch anchor before reset selection drops it and preserves a null anchor", async () => {
    const sessionId = "reset-placement";
    writeArchive(sessionId, [
      entry("old", null, { role: "user", content: "old prompt" }),
      { type: "reset", id: "reset", parentId: "old", timestamp: "2026-08-28T00:00:00.000Z" },
      entry("kept", "reset", activity("kept", "old", 0)),
      entry("beginning", "kept", activity("beginning", null, 1)),
    ]);
    const reader = new ArchivedTranscriptReader({ sessionId, storePath });
    const page = await reader.readPage({ offset: 0, maxMessages: 10, ...archiveOptions });
    const source = page.displaySource;
    expect(page.messages.map((message) => metadata(message).id)).toEqual([
      "reset",
      "kept",
      "beginning",
    ]);
    expect(positions(page.messages)).toEqual([
      { source, rawSeq: 3 },
      { source, rawSeq: 4, activity: { afterRawSeq: 2, scopeId: "archive-scope", startOrder: 0 } },
      {
        source,
        rawSeq: 5,
        activity: { afterRawSeq: null, scopeId: "archive-scope", startOrder: 1 },
      },
    ]);
  });

  test.each([
    { phase: "index scan", suffix: "10" },
    { phase: "tail open", suffix: "11" },
    { phase: "tail read", suffix: "12" },
  ] as const)(
    "rejects archive generation changes during $phase without mixing payload and placement",
    async ({ phase, suffix }) => {
      const sessionId = `00000000-0000-4000-8000-0000000000${suffix}`;
      const root = entry("root", null, { role: "user", content: "a".repeat(70_000) });
      const control = { type: "metadata", id: "control", parentId: "root" };
      const nested = entry("nested", "root", activity("nested", "root", 0));
      const file = writeArchive(sessionId, [root, control, nested]);
      fs.utimesSync(file, 1_700_000_000, 1_700_000_000);
      const reader = new ArchivedTranscriptReader({ sessionId, storePath });
      const readPage = () => reader.readPage({ offset: 0, maxMessages: 10, ...archiveOptions });
      if (phase !== "index scan") {
        await readPage();
      }
      const initialStat = fs.statSync(file);
      const replacement = [{ type: "session", version: 3, id: sessionId }, control, root, nested]
        .map((record) => JSON.stringify(record))
        .join("\n");
      let rewritten = false;
      const rewrite = () => {
        if (rewritten) {
          return;
        }
        rewritten = true;
        if (phase === "tail open") {
          fs.writeFileSync(`${file}.replacement`, replacement);
          fs.renameSync(`${file}.replacement`, file);
          fs.utimesSync(file, initialStat.atime, initialStat.mtime);
        } else {
          fs.writeFileSync(file, replacement);
        }
      };
      const opened: Awaited<ReturnType<typeof fs.promises.open>>[] = [];
      const realOpen = fs.promises.open.bind(fs.promises);
      const openSpy = vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
        if (args[0] === file && phase === "tail open") {
          rewrite();
        }
        const handle = await realOpen(...args);
        opened.push(handle);
        if (args[0] !== file || phase !== "tail read") {
          return handle;
        }
        const read = handle.read.bind(handle);
        return new Proxy(handle, {
          get(target, property, receiver) {
            if (property !== "read") {
              return Reflect.get(target, property, receiver);
            }
            return async (
              buffer: Buffer,
              offset: number,
              length: number,
              position: number | null,
            ) => {
              const result = await read(buffer, offset, Math.min(length, 16), position);
              rewrite();
              return result;
            };
          },
        });
      });
      const realStream = fs.createReadStream.bind(fs);
      const streamSpy = vi.spyOn(fs, "createReadStream").mockImplementation((...args) => {
        const stream = realStream(...args);
        if (args[0] === file && phase === "index scan") {
          stream.once("data", rewrite);
        }
        return stream;
      });
      try {
        const result =
          phase === "index scan"
            ? readPage()
            : reader.readRecentWithStats({ maxMessages: 10, ...archiveOptions });
        const failure = await result.then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(rewritten).toBe(true);
        expect(failure).toBeInstanceOf(SessionTranscriptProjectionUnavailableError);
        expect(failure).toMatchObject({ sessionId });
        expect(opened.every((handle) => handle.fd === -1)).toBe(true);
      } finally {
        openSpy.mockRestore();
        streamSpy.mockRestore();
      }
      const recovered = await readPage();
      expect(recovered.messages).toHaveLength(2);
      expect(metadata(recovered.messages[1]).transcriptPosition).toMatchObject({
        rawSeq: 4,
        activity: { afterRawSeq: 3 },
      });
    },
  );

  test("returns an opaque generation source on empty reads and separates archive replacements", async () => {
    const sessionId = "archive-generations";
    const records = [entry("root", null, { role: "user", content: "prompt" })];
    const file = writeArchive(sessionId, records);
    const reader = new ArchivedTranscriptReader({ sessionId, storePath });
    const initial = await reader.readPage({ offset: 0, maxMessages: 1, ...archiveOptions });
    const source = initial.displaySource;
    expect(source).toEqual(expect.any(String));
    for (const result of [
      await reader.readPage({ offset: 1, maxMessages: 1, ...archiveOptions }),
      await reader.readRecentWithStats({ maxMessages: 0, ...archiveOptions }),
      await reader.readAroundId({ messageId: "absent", maxMessages: 1, ...archiveOptions }),
    ]) {
      expect(result).toMatchObject({ messages: [], displaySource: source });
    }

    fs.appendFileSync(
      file,
      `\n${JSON.stringify(entry("new", "root", { role: "assistant", content: "new" }))}`,
    );
    const replaced = await reader.readPage({ offset: 0, maxMessages: 1, ...archiveOptions });
    expect(replaced).toMatchObject({ displaySource: expect.any(String) });
    expect(replaced.displaySource).not.toBe(source);

    const otherDir = path.join(dir, "other");
    fs.mkdirSync(otherDir);
    const copy = path.join(otherDir, path.basename(file));
    fs.copyFileSync(file, copy);
    for (const archive of [file, copy]) {
      fs.utimesSync(archive, 1_700_000_000, 1_700_000_000);
    }
    const current = await reader.readPage({ offset: 0, maxMessages: 1, ...archiveOptions });
    const other = await new ArchivedTranscriptReader({
      sessionId,
      storePath: path.join(otherDir, "sessions.json"),
    }).readPage({ offset: 0, maxMessages: 1, ...archiveOptions });
    expect(other.displaySource).toEqual(expect.any(String));
    expect(other.displaySource).not.toBe(current.displaySource);
  });
});

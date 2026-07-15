// Covers transcript readers when positional reads return short (POSIX allows
// fewer bytes than requested); bounded windows must not drop or corrupt data.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, afterEach, describe, expect, test, vi } from "vitest";
import {
  readRecentSessionUsageFromTranscript,
  readSessionPreviewItemsFromTranscript,
  readSessionTitleFieldsFromTranscript,
  readSessionTitleFieldsFromTranscriptAsync,
} from "./session-utils.fs.js";

const SHORT_READ_CAP_BYTES = 16;

let tmpDir = "";
let storePath = "";
beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-short-read-"));
  storePath = path.join(tmpDir, "sessions.json");
});
afterAll(() => {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
afterEach(() => {
  vi.restoreAllMocks();
});

function writeTranscript(sessionId: string, lines: unknown[]): string {
  const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
  fs.writeFileSync(transcriptPath, lines.map((line) => JSON.stringify(line)).join("\n"), "utf-8");
  return transcriptPath;
}

function capSyncReads() {
  const realReadSync = fs.readSync.bind(fs);
  const cappedReadSync = (
    fd: number,
    buffer: NodeJS.ArrayBufferView,
    offset: number,
    length: number,
    position: fs.ReadPosition | null,
  ): number => realReadSync(fd, buffer, offset, Math.min(length, SHORT_READ_CAP_BYTES), position);
  vi.spyOn(fs, "readSync").mockImplementation(cappedReadSync as typeof fs.readSync);
}

function capAsyncReads() {
  const realOpen = fs.promises.open.bind(fs.promises);
  vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
    const handle = await realOpen(...(args as Parameters<typeof realOpen>));
    const realRead = handle.read.bind(handle);
    return new Proxy(handle, {
      get(target, prop, receiver) {
        if (prop === "read") {
          return (
            buffer: NodeJS.ArrayBufferView,
            offset: number,
            length: number,
            position: number | null,
          ) => realRead(buffer, offset, Math.min(length, SHORT_READ_CAP_BYTES), position);
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  });
}

function basicTranscript(sessionId: string): unknown[] {
  return [
    { type: "session", version: 1, id: sessionId },
    { message: { role: "user", content: "first user message" } },
    { message: { role: "assistant", content: "middle reply" } },
    { message: { role: "assistant", content: "final preview text" } },
  ];
}

describe("transcript readers with short positional reads", () => {
  test("sync title fields keep the real last message preview", () => {
    const sessionId = "short-read-title-sync";
    writeTranscript(sessionId, basicTranscript(sessionId));
    capSyncReads();

    const fields = readSessionTitleFieldsFromTranscript(sessionId, storePath);

    expect(fields.firstUserMessage).toBe("first user message");
    expect(fields.lastMessagePreview).toBe("final preview text");
  });

  test("async title fields keep the real last message preview", async () => {
    const sessionId = "short-read-title-async";
    writeTranscript(sessionId, basicTranscript(sessionId));
    capAsyncReads();

    const fields = await readSessionTitleFieldsFromTranscriptAsync(sessionId, storePath);

    expect(fields.firstUserMessage).toBe("first user message");
    expect(fields.lastMessagePreview).toBe("final preview text");
  });

  test("preview items deliver the transcript tail", () => {
    const sessionId = "short-read-preview-items";
    writeTranscript(sessionId, basicTranscript(sessionId));
    capSyncReads();

    const items = readSessionPreviewItemsFromTranscript(
      sessionId,
      storePath,
      undefined,
      undefined,
      3,
      120,
    );

    expect(items.map((item) => item.text)).toContain("final preview text");
  });

  test("recent usage snapshot still finds the trailing usage line", () => {
    const sessionId = "short-read-usage";
    writeTranscript(sessionId, [
      { type: "session", version: 1, id: sessionId },
      { message: { role: "user", content: `filler ${"x".repeat(256)}` } },
      {
        message: {
          role: "assistant",
          provider: "openai",
          model: "gpt-5.4",
          usage: { input: 900, output: 100, cost: { total: 0.003 } },
        },
      },
    ]);
    capSyncReads();

    const usage = readRecentSessionUsageFromTranscript(
      sessionId,
      storePath,
      undefined,
      undefined,
      64 * 1024,
    );

    expect(usage).toMatchObject({ modelProvider: "openai", inputTokens: 900, outputTokens: 100 });
  });
});

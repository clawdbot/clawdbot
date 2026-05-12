import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  streamSessionTranscriptLines,
  streamSessionTranscriptLinesReverse,
} from "./transcript-stream.js";

// Regression coverage for #54296: the transcript readers must stay correct and
// memory-bounded as session files grow into the multi-MB / 100s of MB range.
// The previous implementations called `fs.readFile` and split on newlines,
// which made memory usage scale with file size. These tests exercise the
// shared streaming helpers that replace those whole-file reads.

let tempDir = "";
let transcriptPath = "";

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-stream-"));
  transcriptPath = path.join(tempDir, "session.jsonl");
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function collect(iter: AsyncGenerator<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const value of iter) {
    out.push(value);
  }
  return out;
}

describe("streamSessionTranscriptLines", () => {
  it("yields trimmed non-empty lines in file order", async () => {
    fs.writeFileSync(transcriptPath, "  alpha  \n\nbeta\n  \r\ngamma\n", "utf-8");

    const lines = await collect(streamSessionTranscriptLines(transcriptPath));

    expect(lines).toEqual(["alpha", "beta", "gamma"]);
  });

  it("returns an empty iterator when the file does not exist", async () => {
    const lines = await collect(streamSessionTranscriptLines(path.join(tempDir, "missing.jsonl")));

    expect(lines).toEqual([]);
  });

  it("returns an empty iterator for an empty file", async () => {
    fs.writeFileSync(transcriptPath, "", "utf-8");

    const lines = await collect(streamSessionTranscriptLines(transcriptPath));

    expect(lines).toEqual([]);
  });

  it("forwards malformed JSON lines as raw text so callers can choose to skip them", async () => {
    fs.writeFileSync(
      transcriptPath,
      `${JSON.stringify({ id: "a" })}\nnot-json\n${JSON.stringify({ id: "b" })}\n`,
      "utf-8",
    );

    const lines = await collect(streamSessionTranscriptLines(transcriptPath));

    expect(lines).toEqual([JSON.stringify({ id: "a" }), "not-json", JSON.stringify({ id: "b" })]);
  });

  it("honours an abort signal between lines", async () => {
    fs.writeFileSync(transcriptPath, "one\ntwo\nthree\n", "utf-8");
    const controller = new AbortController();

    const out: string[] = [];
    for await (const line of streamSessionTranscriptLines(transcriptPath, {
      signal: controller.signal,
    })) {
      out.push(line);
      if (line === "one") {
        controller.abort();
      }
    }

    expect(out).toEqual(["one"]);
  });

  it("preserves long lines without truncation", async () => {
    const longLine = "x".repeat(64 * 1024 + 7);
    fs.writeFileSync(transcriptPath, `${longLine}\nshort\n`, "utf-8");

    const lines = await collect(streamSessionTranscriptLines(transcriptPath));

    expect(lines).toEqual([longLine, "short"]);
  });
});

describe("streamSessionTranscriptLinesReverse", () => {
  it("yields trimmed non-empty lines in reverse order for short files", async () => {
    fs.writeFileSync(transcriptPath, "first\nsecond\nthird\n", "utf-8");

    const lines = await collect(streamSessionTranscriptLinesReverse(transcriptPath));

    expect(lines).toEqual(["third", "second", "first"]);
  });

  it("returns an empty iterator when the file cannot be opened", async () => {
    const lines = await collect(
      streamSessionTranscriptLinesReverse(path.join(tempDir, "missing.jsonl")),
    );

    expect(lines).toEqual([]);
  });

  it("returns an empty iterator for an empty file", async () => {
    fs.writeFileSync(transcriptPath, "", "utf-8");

    const lines = await collect(streamSessionTranscriptLinesReverse(transcriptPath));

    expect(lines).toEqual([]);
  });

  it("preserves complete lines across chunk boundaries", async () => {
    const longLine = "x".repeat(2048);
    fs.writeFileSync(transcriptPath, `${longLine}\nbeta\ngamma\n`, "utf-8");

    const lines = await collect(
      streamSessionTranscriptLinesReverse(transcriptPath, {
        chunkBytes: 1024,
      }),
    );

    expect(lines).toEqual(["gamma", "beta", longLine]);
  });

  it("preserves multibyte UTF-8 across chunk boundaries", async () => {
    const firstLine = `${"a".repeat(1100)}🌊`;
    const secondLine = `${"b".repeat(1100)}✅`;
    fs.writeFileSync(transcriptPath, `${firstLine}\n${secondLine}\n`, "utf-8");

    const lines = await collect(
      streamSessionTranscriptLinesReverse(transcriptPath, {
        chunkBytes: 1024,
      }),
    );

    expect(lines).toEqual([secondLine, firstLine]);
  });

  it("honours an abort signal between reverse lines", async () => {
    fs.writeFileSync(transcriptPath, "one\ntwo\nthree\n", "utf-8");
    const controller = new AbortController();

    const out: string[] = [];
    for await (const line of streamSessionTranscriptLinesReverse(transcriptPath, {
      signal: controller.signal,
    })) {
      out.push(line);
      if (line === "three") {
        controller.abort();
      }
    }

    expect(out).toEqual(["three"]);
  });

  it("clamps a sub-minimum chunk size without dropping older lines", async () => {
    fs.writeFileSync(transcriptPath, "alpha\nbeta\ngamma\n", "utf-8");

    const lines = await collect(
      streamSessionTranscriptLinesReverse(transcriptPath, {
        chunkBytes: 16,
      }),
    );

    expect(lines).toEqual(["gamma", "beta", "alpha"]);
  });

  it("does not emit a partial prefix until the full first line is available", async () => {
    const firstLine = "prefix".repeat(400);
    fs.writeFileSync(transcriptPath, `${firstLine}\nbeta\ngamma`, "utf-8");

    const lines = await collect(
      streamSessionTranscriptLinesReverse(transcriptPath, {
        chunkBytes: 1024,
      }),
    );

    expect(lines).toEqual(["gamma", "beta", firstLine]);
  });

  it("preserves JSONL line ordering so reverse scans hit the newest match first", async () => {
    fs.writeFileSync(
      transcriptPath,
      [
        JSON.stringify({ id: "first", role: "user" }),
        JSON.stringify({ id: "second", role: "assistant", text: "hi" }),
        JSON.stringify({ id: "third", role: "assistant", text: "bye" }),
      ].join("\n") + "\n",
      "utf-8",
    );

    const lines = await collect(streamSessionTranscriptLinesReverse(transcriptPath));
    const parsed = lines.map((line) => JSON.parse(line) as { id: string });

    expect(parsed.map((entry) => entry.id)).toEqual(["third", "second", "first"]);
  });
});

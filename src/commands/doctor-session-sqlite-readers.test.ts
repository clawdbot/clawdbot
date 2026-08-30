import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  countTranscriptEventsForPath,
  createTranscriptEventReader,
} from "./doctor-session-sqlite-readers.js";

describe("legacy transcript row classification", () => {
  let directory: string;
  let transcriptPath: string;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-reader-classification-"));
    transcriptPath = path.join(directory, "session.jsonl");
  });
  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  it.each([1, 2, 3])("preserves records when UTF-8 splits after byte %s", (splitAfter) => {
    const header = '\uFEFF{"type":"session","version":3}\r\n \t\r\n';
    const prefix = '{"type":"plugin_state","payload":"';
    const padding = "x".repeat(65_536 - Buffer.byteLength(header + prefix) - splitAfter);
    const firstLine = `${prefix}${padding}🦞"}`;
    const giant = { type: "plugin_state", payload: "λ".repeat(100_000) };
    const tail = { type: "plugin_state", payload: "final unterminated row" };
    fs.writeFileSync(
      transcriptPath,
      `${header}${firstLine}\r\n\n${JSON.stringify(giant)}\r\n${JSON.stringify(tail)}`,
    );

    const events: unknown[] = [];
    const validate = createTranscriptEventReader(
      transcriptPath,
      "target",
    )((event) => events.push(event));
    validate();

    expect(events[0]).toEqual({
      type: "session",
      version: 3,
      id: "target",
      timestamp: "",
      cwd: "",
    });
    expect(events.slice(1)).toEqual([JSON.parse(firstLine), giant, tail]);
    expect(countTranscriptEventsForPath(transcriptPath)).toEqual({ status: "ok", events: 4 });
  });

  it.each([1, 2, 3, 4])("preserves recognized and opaque rows from version %s", (version) => {
    const unindexedHook = { type: "message", message: { role: "custom", content: "context" } };
    const legacyMetadata = { type: "thinking_level_change", thinkingLevel: "low" };
    const opaqueRows = [
      { type: "session", id: "later-header", version: 1 },
      { type: "plugin_state", id: "opaque", payload: { keep: "exact" } },
      { type: "message", id: "malformed", message: { role: "user" } },
    ];
    const rows = [
      { type: "session", version, sessionId: "legacy-header" },
      { ...unindexedHook, id: "hook", parentId: null },
      unindexedHook,
      legacyMetadata,
      ...opaqueRows,
    ];
    fs.writeFileSync(transcriptPath, rows.map((row) => JSON.stringify(row)).join("\n"));
    const events: unknown[] = [];
    const validate = createTranscriptEventReader(
      transcriptPath,
      "target-session",
    )((event) => {
      events.push(event);
    });
    validate();

    expect(events).toHaveLength(rows.length);
    expect(events[0]).toEqual({
      type: "session",
      id: "target-session",
      version: Math.max(version, 3),
      timestamp: "",
      cwd: "",
    });
    expect(events[1]).toMatchObject({
      id: version === 1 ? expect.stringMatching(/^[a-f0-9]{16}-1$/) : "hook",
      message: { role: "custom", customType: "hook", content: "context" },
    });
    if (version < 3) {
      expect(events[2]).toMatchObject({
        message: { role: "custom", customType: "hook", content: "context" },
      });
    } else {
      expect(events[2]).toEqual(unindexedHook);
    }
    expect(events[3]).toEqual(
      version === 1
        ? {
            ...legacyMetadata,
            id: expect.stringMatching(/^[a-f0-9]{16}-3$/),
            parentId: expect.stringMatching(/^[a-f0-9]{16}-2$/),
          }
        : legacyMetadata,
    );
    expect(events.slice(4)).toEqual(opaqueRows);
  });

  it.each([1, 3])("enforces the target limit even during v%s prefix recovery", (version) => {
    const rows = Array.from({ length: 100_001 }, (_, index) =>
      JSON.stringify({
        type: "compaction",
        id: `c-${index}`,
        summary: "kept",
        tokensBefore: 0,
        firstKeptEntryId: "kept",
        firstKeptEntryIndex: index,
      }),
    );
    fs.writeFileSync(
      transcriptPath,
      `${JSON.stringify({ type: "session", version })}\n${rows.join("\n")}`,
    );
    expect(() => createTranscriptEventReader(transcriptPath, "target", true)(() => {})).toThrow(
      "more than 100000 legacy compaction targets",
    );
  });

  it.each([false, true])("handles malformed tails with prefix recovery %s", (allowPrefix) => {
    const rows = [
      { type: "session", version: 3, id: "target" },
      { type: "message", id: "kept", message: { role: "user", content: "x".repeat(70_000) } },
    ];
    fs.writeFileSync(
      transcriptPath,
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n{malformed`,
    );
    const events: unknown[] = [];
    const read = () =>
      createTranscriptEventReader(
        transcriptPath,
        "target",
        allowPrefix,
      )((event) => events.push(event));
    if (allowPrefix) {
      read()();
      expect(events).toHaveLength(2);
      expect(events[1]).toEqual(rows[1]);
    } else {
      expect(read).toThrow();
    }
  });
});

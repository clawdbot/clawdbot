import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { afterEach, expect, test, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { SessionTranscriptProjectionUnavailableError } from "../config/sessions/session-transcript-projection-error.js";
import * as fileReads from "../infra/file-read.js";
import { createNestedToolActivity } from "../sessions/nested-tool-activity.js";
import { isVisibleTranscriptRecord } from "../sessions/transcript-visible-record.js";
import {
  readIndexedTranscriptEntries,
  readSessionTranscriptIndex,
  selectArchiveTranscriptEntries,
} from "./session-transcript-index.fs.js";
import {
  parseTranscriptRecord,
  type TranscriptRecord,
} from "./session-transcript-record-parser.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

async function fixture(bytes: string | Buffer) {
  const file = path.join(dirs.make("archive-index-"), "session.jsonl");
  await fs.promises.writeFile(file, bytes);
  return file;
}

function message(id: string | undefined, text: string) {
  return JSON.stringify({ type: "message", id, message: { role: "user", content: text } });
}

test("keeps exact physical ranges across newline dialects and malformed UTF8", async () => {
  const file = await fixture(
    Buffer.concat([
      Buffer.from(` \r\n${message("first", "α🦞".repeat(18000))}\r`),
      Buffer.from('{"type":"message","id":"invalid-utf8","message":{"role":"user","content":"'),
      Buffer.from([0xff]),
      Buffer.from(
        `"}}\n{malformed\r\n${message("", "blank raw id")}\n${message(undefined, "no id")}`,
      ),
    ]),
  );
  const records: TranscriptRecord[] = [];
  const lines = readline.createInterface({
    input: fs.createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    const parsed = parseTranscriptRecord(line);
    if (parsed) {
      records.push(parsed);
    }
  }
  const expected = selectArchiveTranscriptEntries(records).filter((entry) =>
    isVisibleTranscriptRecord(entry.record),
  );
  const index = await readSessionTranscriptIndex(file, "test");
  expect(index).not.toBeNull();
  const materialized = await readIndexedTranscriptEntries(file, index!, index!.entries, "test");
  expect(materialized.map(({ record, byteLength, id }) => ({ record, byteLength, id }))).toEqual(
    expected.map(({ record, byteLength, id }) => ({ record, byteLength, id })),
  );
  expect(index!.entries.map((entry) => entry.rawId)).toEqual([
    "first",
    "invalid-utf8",
    "",
    undefined,
  ]);
});

test("retains duplicate order, last by-ID selection and oversized image recovery", async () => {
  const image = JSON.stringify({
    type: "message",
    id: "image",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "caption" },
        { type: "image", mimeType: "image/png", data: Buffer.alloc(300000).toString("base64") },
      ],
    },
  });
  const file = await fixture(
    [message("same", "first"), image, message("same", "last")].join("\r\n"),
  );
  const index = (await readSessionTranscriptIndex(file, "test"))!;
  const records = await readIndexedTranscriptEntries(file, index, index.entries, "test");
  expect(records.map((entry) => entry.record.message)).toMatchObject([
    { content: "first" },
    { content: [{ text: "caption" }, { type: "image", omitted: true, bytes: 300000 }] },
    { content: "last" },
  ]);
  expect(records[1]?.recoveredImageData).toBe(true);
  expect(records[1]!.byteLength).toBeGreaterThan(256 * 1024);
  const last = await readIndexedTranscriptEntries(file, index, [index.byId.get("same")!], "test");
  expect(last[0]?.record.message).toMatchObject({ content: "last" });
  expect(index.entries.find((entry) => entry.id === "same")?.seq).toBe(1);
});

test("keeps CRLF across chunk boundaries and physical duplicate-anchor cuts", async () => {
  const first = message("anchor", "x".repeat(65_535 - Buffer.byteLength(message("anchor", ""))));
  const activity = createNestedToolActivity({
    runId: "run",
    scopeId: "scope",
    afterEntryId: "anchor",
    startOrder: 1,
    toolCallId: "tool",
    toolName: "exec",
    input: "retained input",
    result: { content: [{ type: "text", text: "retained output" }] },
    isError: false,
    startedAt: 0,
    timestamp: 1,
  });
  const file = await fixture(
    [
      first,
      JSON.stringify({ type: "custom_message", id: "early", message: activity }),
      message("anchor", "last anchor"),
      JSON.stringify({ type: "custom_message", id: "late", message: activity }),
    ].join("\r\n"),
  );
  const index = (await readSessionTranscriptIndex(file, "test"))!;
  const entries = await readIndexedTranscriptEntries(file, index, index.entries, "test");
  expect(entries).toHaveLength(4);
  expect(entries[1]?.record.message).toEqual(activity);
  expect(entries[1]?.transcriptPosition.activity).toBeUndefined();
  expect(entries[3]?.transcriptPosition.activity).toEqual({
    afterRawSeq: 3,
    scopeId: "scope",
    startOrder: 1,
  });
});

test("batches a page and rejects a rewrite while its pinned descriptor is being read", async () => {
  const file = await fixture(
    Array.from({ length: 40 }, (_, i) => message(String(i), "body")).join("\n"),
  );
  let index = (await readSessionTranscriptIndex(file, "test"))!;
  const actual = fileReads.readFileWindowFully;
  const reads = vi.spyOn(fileReads, "readFileWindowFully");
  await expect(
    readIndexedTranscriptEntries(file, index, index.entries, "test"),
  ).resolves.toHaveLength(40);
  expect(reads).toHaveBeenCalledTimes(1);
  reads.mockImplementationOnce(async (handle, buffer, position) => {
    const bytes = await actual(handle, buffer, position);
    await fs.promises.appendFile(file, "\n" + message("new", "rewritten"));
    return bytes;
  });
  await expect(
    readIndexedTranscriptEntries(file, index, index.entries, "test"),
  ).rejects.toBeInstanceOf(SessionTranscriptProjectionUnavailableError);
  index = (await readSessionTranscriptIndex(file, "test"))!;
  await expect(
    readIndexedTranscriptEntries(file, index, [index.entries.at(-1)!], "test"),
  ).resolves.toMatchObject([{ record: { id: "new" } }]);
});

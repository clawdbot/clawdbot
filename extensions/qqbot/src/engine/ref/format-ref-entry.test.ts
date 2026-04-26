import { describe, expect, it } from "vitest";
import { formatRefEntryForAgent } from "./format-ref-entry.js";
import type { RefIndexEntry } from "./types.js";

function makeEntry(overrides: Partial<RefIndexEntry> = {}): RefIndexEntry {
  return {
    content: "hello",
    senderId: "user-1",
    timestamp: 1,
    ...overrides,
  };
}

describe("engine/ref/format-ref-entry", () => {
  it("formats text and attachment hints for model context", () => {
    const formatted = formatRefEntryForAgent(
      makeEntry({
        content: "see these",
        attachments: [
          {
            type: "image",
            filename: "photo.png",
            localPath: "/tmp/photo.png",
          },
          {
            type: "voice",
            transcript: "spoken words",
            transcriptSource: "asr",
            url: "https://example.test/voice.amr",
          },
          {
            type: "file",
            filename: "notes.txt",
          },
        ],
      }),
    );

    expect(formatted).toBe(
      'see these [image: photo.png (/tmp/photo.png)] [voice message (content: "spoken words" - platform ASR) (https://example.test/voice.amr)] [file: notes.txt]',
    );
  });

  it("keeps voice attachments visible when no transcript exists", () => {
    expect(
      formatRefEntryForAgent(
        makeEntry({
          content: "",
          attachments: [{ type: "voice", localPath: "/tmp/voice.wav" }],
        }),
      ),
    ).toBe("[voice message (/tmp/voice.wav)]");
  });

  it("returns an explicit empty marker for blank entries", () => {
    expect(formatRefEntryForAgent(makeEntry({ content: "  ", attachments: [] }))).toBe(
      "[empty message]",
    );
  });
});

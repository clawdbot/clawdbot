import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  extractTranscriptStemFromSessionsMemoryHit,
  resolveTranscriptStemToSessionKeys,
} from "./session-transcript-hit.js";

describe("extractTranscriptStemFromSessionsMemoryHit", () => {
  it("strips sessions/ and .jsonl for builtin paths", () => {
    expect(extractTranscriptStemFromSessionsMemoryHit("sessions/abc-uuid.jsonl")).toBe("abc-uuid");
  });

  it("handles plain basename jsonl", () => {
    expect(extractTranscriptStemFromSessionsMemoryHit("def-topic-thread.jsonl")).toBe(
      "def-topic-thread",
    );
  });

  it("uses .md basename for QMD exports", () => {
    expect(extractTranscriptStemFromSessionsMemoryHit("qmd/sessions/x/y/z.md")).toBe("z");
  });
});

describe("resolveTranscriptStemToSessionKeys", () => {
  const baseEntry = (overrides: Partial<SessionEntry> = {}): SessionEntry => ({
    sessionId: "stem-a",
    updatedAt: 1,
    ...overrides,
  });

  it("returns keys for every agent whose store entry matches the stem", () => {
    const store: Record<string, SessionEntry> = {
      "agent:main:s1": baseEntry({
        sessionFile: "/data/sessions/stem-a.jsonl",
      }),
      "agent:peer:s2": baseEntry({
        sessionFile: "/other/volume/stem-a.jsonl",
      }),
    };
    const keys = resolveTranscriptStemToSessionKeys({ store, stem: "stem-a" }).toSorted();
    expect(keys).toEqual(["agent:main:s1", "agent:peer:s2"]);
  });
});

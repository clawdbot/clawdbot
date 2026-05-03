import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  extractTranscriptIdentityFromSessionsMemoryHit,
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

  it("strips .jsonl.reset.<iso> archive suffix so rotated transcripts resolve to the live stem", () => {
    expect(
      extractTranscriptStemFromSessionsMemoryHit(
        "sessions/abc-uuid.jsonl.reset.2026-02-16T22-26-33.000Z",
      ),
    ).toBe("abc-uuid");
  });

  it("strips .jsonl.deleted.<iso> archive suffix the same way", () => {
    expect(
      extractTranscriptStemFromSessionsMemoryHit(
        "sessions/def-uuid.jsonl.deleted.2026-02-16T22-27-33.000Z",
      ),
    ).toBe("def-uuid");
  });

  it("handles archive suffix on bare basenames without the sessions/ prefix", () => {
    expect(
      extractTranscriptStemFromSessionsMemoryHit("ghi-thread.jsonl.reset.2026-02-16T22-28-33.000Z"),
    ).toBe("ghi-thread");
  });

  it("does not mistake arbitrary suffixes containing .jsonl. for archives", () => {
    // Not a real archive pattern: suffix after .jsonl. must be `reset` or `deleted`.
    expect(
      extractTranscriptStemFromSessionsMemoryHit("sessions/weird.jsonl.backup.2026-01-01.zst"),
    ).toBeNull();
  });
});

describe("extractTranscriptIdentityFromSessionsMemoryHit", () => {
  it("extracts owner metadata from agent-scoped session archive paths", () => {
    expect(
      extractTranscriptIdentityFromSessionsMemoryHit(
        "sessions/main/deleted-uuid.jsonl.deleted.2026-02-16T22-27-33.000Z",
      ),
    ).toEqual({
      stem: "deleted-uuid",
      ownerAgentId: "main",
      archived: true,
    });
  });

  it("does not invent owner metadata for legacy basename-only paths", () => {
    expect(extractTranscriptIdentityFromSessionsMemoryHit("sessions/abc-uuid.jsonl")).toEqual({
      stem: "abc-uuid",
      archived: false,
    });
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

  it("falls back to archived owner metadata when deleted archives are gone from the live store", () => {
    const keys = resolveTranscriptStemToSessionKeys({
      store: {},
      stem: "deleted-stem",
      archivedOwnerAgentId: "main",
    });

    expect(keys).toEqual(["agent:main:deleted-stem"]);
  });
});

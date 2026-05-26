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

  it("recognizes QMD-normalized archived reset transcript .md stems", () => {
    expect(
      extractTranscriptStemFromSessionsMemoryHit(
        "qmd/sessions-main/abc-uuid-jsonl-reset-2026-02-16T22-26-33.000Z.md",
      ),
    ).toBe("abc-uuid");
  });

  it("recognizes QMD-normalized archived deleted transcript .md stems", () => {
    expect(
      extractTranscriptStemFromSessionsMemoryHit(
        "qmd/sessions-main/def-uuid-jsonl-deleted-2026-02-16T22-27-33.000Z.md",
      ),
    ).toBe("def-uuid");
  });

  it("recognizes real QMD-slugified archived reset transcript .md stems", () => {
    expect(
      extractTranscriptStemFromSessionsMemoryHit(
        "qmd/sessions-main/abc-uuid-jsonl-reset-2026-02-16t22-26-33-000z.md",
      ),
    ).toBe("abc-uuid");
  });

  it("returns non-archived identity for QMD .md stems that are not archive patterns", () => {
    const identity = extractTranscriptIdentityFromSessionsMemoryHit(
      "qmd/sessions-main/normal-session.md",
    );
    expect(identity).toEqual({ stem: "normal-session", archived: false });
  });

  it("returns archived identity for QMD-normalized reset .md stems", () => {
    const identity = extractTranscriptIdentityFromSessionsMemoryHit(
      "qmd/sessions-main/abc-uuid-jsonl-reset-2026-02-16T22-26-33.000Z.md",
    );
    expect(identity).toEqual({
      stem: "abc-uuid",
      liveStem: "abc-uuid-jsonl-reset-2026-02-16T22-26-33.000Z",
      archived: true,
    });
  });

  it("recognizes QMD-exported dot-form archived reset .md paths", () => {
    expect(
      extractTranscriptStemFromSessionsMemoryHit(
        "qmd/sessions-main/abc-uuid.jsonl.reset.2026-02-16T22-26-33.000Z.md",
      ),
    ).toBe("abc-uuid");
  });

  it("recognizes QMD-exported dot-form archived deleted .md paths", () => {
    expect(
      extractTranscriptStemFromSessionsMemoryHit(
        "qmd/sessions-main/def-uuid.jsonl.deleted.2026-02-16T22-27-33.000Z.md",
      ),
    ).toBe("def-uuid");
  });

  it("returns archived identity for QMD-exported dot-form reset .md paths", () => {
    const identity = extractTranscriptIdentityFromSessionsMemoryHit(
      "qmd/sessions-main/abc-uuid.jsonl.reset.2026-02-16T22-26-33.000Z.md",
    );
    expect(identity).toEqual({
      stem: "abc-uuid",
      liveStem: "abc-uuid.jsonl.reset.2026-02-16T22-26-33.000Z",
      archived: true,
    });
  });

  it("does not treat QMD .md names with invalid archive timestamps as archives", () => {
    const identity = extractTranscriptIdentityFromSessionsMemoryHit(
      "qmd/sessions-main/abc.jsonl.reset.not-a-timestamp.md",
    );
    expect(identity).toEqual({
      stem: "abc.jsonl.reset.not-a-timestamp",
      archived: false,
    });
  });

  it("does not treat non-QMD .md names with archive-looking timestamps as archives", () => {
    const identity = extractTranscriptIdentityFromSessionsMemoryHit(
      "abc-uuid-jsonl-reset-2026-02-16t22-26-33-000z.md",
    );
    expect(identity).toEqual({
      stem: "abc-uuid-jsonl-reset-2026-02-16t22-26-33-000z",
      archived: false,
    });
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

  it("does not derive owner metadata from lossy QMD session collection names", () => {
    expect(
      extractTranscriptIdentityFromSessionsMemoryHit(
        "qmd/sessions-main/deleted-uuid-jsonl-deleted-2026-02-16t22-27-33-000z.md",
      ),
    ).toEqual({
      stem: "deleted-uuid",
      liveStem: "deleted-uuid-jsonl-deleted-2026-02-16t22-27-33-000z",
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

  it("matches QMD-slugified stems to unique session ids with safe punctuation", () => {
    const store: Record<string, SessionEntry> = {
      "agent:main:s1": baseEntry({ sessionId: "foo_bar.v1" }),
    };

    expect(
      resolveTranscriptStemToSessionKeys({
        store,
        stem: "foo-bar-v1",
        allowQmdSlugFallback: true,
      }),
    ).toEqual(["agent:main:s1"]);
  });

  it("ignores store entries without session ids during QMD-slugified fallback", () => {
    const store: Record<string, SessionEntry> = {
      "agent:main:non-session": {
        updatedAt: 1,
      } as SessionEntry,
      "agent:main:s1": baseEntry({ sessionId: "foo_bar.v1" }),
    };

    expect(
      resolveTranscriptStemToSessionKeys({
        store,
        stem: "foo-bar-v1",
        allowQmdSlugFallback: true,
      }),
    ).toEqual(["agent:main:s1"]);
  });

  it("does not use QMD-slugified fallback unless requested", () => {
    const store: Record<string, SessionEntry> = {
      "agent:main:s1": baseEntry({ sessionId: "foo_bar.v1" }),
    };

    expect(resolveTranscriptStemToSessionKeys({ store, stem: "foo-bar-v1" })).toEqual([]);
  });

  it("prefers exact stem matches before QMD-slugified fallback matches", () => {
    const store: Record<string, SessionEntry> = {
      "agent:main:exact": baseEntry({ sessionId: "foo-bar" }),
      "agent:main:slug": baseEntry({ sessionId: "foo_bar" }),
    };

    expect(
      resolveTranscriptStemToSessionKeys({
        store,
        stem: "foo-bar",
        allowQmdSlugFallback: true,
      }),
    ).toEqual(["agent:main:exact"]);
  });

  it("does not guess when QMD-slugified fallback matches multiple sessions", () => {
    const store: Record<string, SessionEntry> = {
      "agent:main:dot": baseEntry({ sessionId: "foo.bar" }),
      "agent:main:underscore": baseEntry({ sessionId: "foo_bar" }),
    };

    expect(
      resolveTranscriptStemToSessionKeys({
        store,
        stem: "foo-bar",
        allowQmdSlugFallback: true,
      }),
    ).toEqual([]);
  });
});

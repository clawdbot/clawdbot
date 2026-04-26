import { describe, expect, it } from "vitest";
import {
  formatSessionArchiveTimestamp,
  isCompactionCheckpointTranscriptFileName,
  isPrimarySessionTranscriptFileName,
  isSessionArchiveArtifactName,
  isUsageCountedSessionTranscriptFileName,
  parseCompactionCheckpointTranscriptFileName,
  parseUsageCountedSessionIdFromFileName,
  parseSessionArchiveTimestamp,
} from "./artifacts.js";

describe("session artifact helpers", () => {
  it("classifies archived artifact file names", () => {
    expect(isSessionArchiveArtifactName("abc.jsonl.deleted.2026-01-01T00-00-00.000Z")).toBe(true);
    expect(isSessionArchiveArtifactName("abc.jsonl.reset.2026-01-01T00-00-00.000Z")).toBe(true);
    expect(isSessionArchiveArtifactName("abc.jsonl.bak.2026-01-01T00-00-00.000Z")).toBe(true);
    expect(isSessionArchiveArtifactName("sessions.json.bak.1737420882")).toBe(true);
    expect(isSessionArchiveArtifactName("keep.deleted.keep.jsonl")).toBe(false);
    expect(isSessionArchiveArtifactName("abc.jsonl")).toBe(false);
  });

  it("classifies primary transcript files", () => {
    expect(isPrimarySessionTranscriptFileName("abc.jsonl")).toBe(true);
    expect(isPrimarySessionTranscriptFileName("keep.deleted.keep.jsonl")).toBe(true);
    expect(
      isPrimarySessionTranscriptFileName(
        "abc.checkpoint.11111111-1111-4111-8111-111111111111.jsonl",
      ),
    ).toBe(false);
    expect(isPrimarySessionTranscriptFileName("abc.jsonl.deleted.2026-01-01T00-00-00.000Z")).toBe(
      false,
    );
    expect(isPrimarySessionTranscriptFileName("sessions.json")).toBe(false);
  });

  it("classifies usage-counted transcript files", () => {
    expect(isUsageCountedSessionTranscriptFileName("abc.jsonl")).toBe(true);
    expect(
      isUsageCountedSessionTranscriptFileName("abc.jsonl.reset.2026-01-01T00-00-00.000Z"),
    ).toBe(true);
    expect(
      isUsageCountedSessionTranscriptFileName("abc.jsonl.deleted.2026-01-01T00-00-00.000Z"),
    ).toBe(true);
    expect(isUsageCountedSessionTranscriptFileName("abc.jsonl.bak.2026-01-01T00-00-00.000Z")).toBe(
      false,
    );
    expect(
      isUsageCountedSessionTranscriptFileName(
        "abc.checkpoint.11111111-1111-4111-8111-111111111111.jsonl",
      ),
    ).toBe(false);
  });

  it("parses usage-counted session ids from file names", () => {
    expect(parseUsageCountedSessionIdFromFileName("abc.jsonl")).toBe("abc");
    expect(parseUsageCountedSessionIdFromFileName("abc.jsonl.reset.2026-01-01T00-00-00.000Z")).toBe(
      "abc",
    );
    expect(
      parseUsageCountedSessionIdFromFileName("abc.jsonl.deleted.2026-01-01T00-00-00.000Z"),
    ).toBe("abc");
    expect(parseUsageCountedSessionIdFromFileName("abc.jsonl.bak.2026-01-01T00-00-00.000Z")).toBe(
      null,
    );
    expect(
      parseUsageCountedSessionIdFromFileName(
        "abc.checkpoint.11111111-1111-4111-8111-111111111111.jsonl",
      ),
    ).toBeNull();
  });

  it("parses exact compaction checkpoint transcript file names", () => {
    expect(
      parseCompactionCheckpointTranscriptFileName(
        "abc.checkpoint.11111111-1111-4111-8111-111111111111.jsonl",
      ),
    ).toEqual({
      sessionId: "abc",
      checkpointId: "11111111-1111-4111-8111-111111111111",
    });
    expect(isCompactionCheckpointTranscriptFileName("abc.checkpoint.not-a-uuid.jsonl")).toBe(false);
    expect(
      isCompactionCheckpointTranscriptFileName(
        "abc.checkpoint.11111111-1111-4111-8111-111111111111.jsonl.deleted.2026-01-01T00-00-00.000Z",
      ),
    ).toBe(false);
  });

  it("formats and parses archive timestamps", () => {
    const now = Date.parse("2026-02-23T12:34:56.000Z");
    const stamp = formatSessionArchiveTimestamp(now);
    expect(stamp).toBe("2026-02-23T12-34-56.000Z");

    const file = `abc.jsonl.deleted.${stamp}`;
    expect(parseSessionArchiveTimestamp(file, "deleted")).toBe(now);
    expect(parseSessionArchiveTimestamp(file, "reset")).toBeNull();
    expect(parseSessionArchiveTimestamp("keep.deleted.keep.jsonl", "deleted")).toBeNull();
  });
});

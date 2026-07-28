// QA Lab Matrix tests cover scenario runtime shared plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildMatrixNoticeArtifact,
  buildMatrixReplyArtifact,
  resolveMatrixQaNoReplyWindowMs,
  truncateMatrixQaPreview,
} from "./scenario-runtime-shared.js";

describe("matrix scenario runtime shared", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("normalizes the Matrix QA no-reply window env", () => {
    expect(resolveMatrixQaNoReplyWindowMs(30_000)).toBe(8_000);

    vi.stubEnv("OPENCLAW_QA_MATRIX_NO_REPLY_WINDOW_MS", "12000");
    expect(resolveMatrixQaNoReplyWindowMs(30_000)).toBe(12_000);
    expect(resolveMatrixQaNoReplyWindowMs(5_000)).toBe(5_000);

    for (const value of ["1e3", "0x1000", "1.5", "nope"]) {
      vi.stubEnv("OPENCLAW_QA_MATRIX_NO_REPLY_WINDOW_MS", value);
      expect(resolveMatrixQaNoReplyWindowMs(30_000)).toBe(8_000);
    }
  });
  it("keeps every shared Matrix preview UTF-16 safe", () => {
    const prefix = "a".repeat(199);
    const event = {
      kind: "message" as const,
      roomId: "!room:matrix-qa.test",
      eventId: "$event",
      sender: "@sut:matrix-qa.test",
      type: "m.room.message",
    };
    expect(truncateMatrixQaPreview(`${prefix}😀tail`)).toBe(prefix);
    expect(buildMatrixReplyArtifact({ ...event, body: `${prefix}😀tail` }).bodyPreview).toBe(
      prefix,
    );
    expect(buildMatrixNoticeArtifact({ ...event, body: `${prefix}😀tail` }).bodyPreview).toBe(
      prefix,
    );
    expect(buildMatrixReplyArtifact({ ...event, body: " " }).bodyPreview).toBe("");
  });
});

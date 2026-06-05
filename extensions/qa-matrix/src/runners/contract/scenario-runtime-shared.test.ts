// Qa Matrix tests cover scenario runtime shared plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveMatrixQaNoReplyWindowMs } from "./scenario-runtime-shared.js";

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
});

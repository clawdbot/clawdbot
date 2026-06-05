// Memory Host SDK tests cover batch status behavior.
import { describe, expect, it } from "vitest";
import {
  resolveBatchCompletionFromStatus,
  resolveCompletedBatchResult,
  throwIfBatchTerminalFailure,
} from "./batch-status.js";

describe("batch-status helpers", () => {
  it("resolves completion payload from completed status", () => {
    expect(
      resolveBatchCompletionFromStatus({
        provider: "openai",
        batchId: "b1",
        status: {
          output_file_id: "out-1",
          error_file_id: "err-1",
        },
      }),
    ).toEqual({
      outputFileId: "out-1",
      errorFileId: "err-1",
    });
  });

  it("throws for terminal failure states", async () => {
    await expect(
      throwIfBatchTerminalFailure({
        provider: "voyage",
        status: { id: "b2", status: "failed", error_file_id: "err-file" },
        readError: async () => "bad input",
      }),
    ).rejects.toThrow("voyage batch b2 failed: bad input");
  });

  it("returns completed result directly without waiting", async () => {
    const waitForBatch = async () => ({ outputFileId: "out-2" });
    const result = await resolveCompletedBatchResult({
      provider: "openai",
      status: {
        id: "b3",
        status: "completed",
        output_file_id: "out-3",
      },
      wait: false,
      waitForBatch,
    });
    expect(result).toEqual({ outputFileId: "out-3", errorFileId: undefined });
  });

  it("throws when wait disabled and batch is not complete", async () => {
    await expect(
      resolveCompletedBatchResult({
        provider: "openai",
        status: { id: "b4", status: "pending" },
        wait: false,
        waitForBatch: async () => ({ outputFileId: "out" }),
      }),
    ).rejects.toThrow("openai batch b4 submitted; enable remote.batch.wait to await completion");
  });
});

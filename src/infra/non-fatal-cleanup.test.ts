// Covers best-effort cleanup error swallowing.
import { describe, expect, it, vi } from "vitest";
import { runBestEffortCleanup } from "./non-fatal-cleanup.js";

describe("runBestEffortCleanup", () => {
  it("returns the cleanup result when the cleanup succeeds", async () => {
    await expect(
      runBestEffortCleanup({
        cleanup: async () => 7,
      }),
    ).resolves.toBe(7);
  });

  it("swallows cleanup failures and reports them through onError", async () => {
    const onError = vi.fn();
    const error = new Error("cleanup failed");

    await expect(
      runBestEffortCleanup({
        cleanup: async () => {
          throw error;
        },
        onError,
      }),
    ).resolves.toBeUndefined();

    expect(onError).toHaveBeenCalledWith(error);
  });
});

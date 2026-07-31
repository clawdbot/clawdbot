import { describe, expect, it, vi } from "vitest";
import { createMemoryWriteProvenanceObserver } from "./memory-write-provenance.js";

describe("memory write provenance", () => {
  it("rolls provenance back when the filesystem write fails", async () => {
    let provenance = "before";
    const observer = createMemoryWriteProvenanceObserver({
      mutationRoot: process.cwd(),
      workspaceDir: process.cwd(),
      plan: {
        recordWriteProvenance: async () => {
          provenance = "predicted";
          return async () => {
            provenance = "before";
          };
        },
      },
      resolveOriginClass: () => "untrusted",
      now: () => 1,
    });
    const commit = vi.fn(async () => {
      throw new Error("disk full");
    });

    await expect(
      observer?.write({
        absolutePath: `${process.cwd()}/MEMORY.md`,
        contentBefore: "before",
        contentAfter: "after",
        commit,
      }),
    ).rejects.toThrow("disk full");
    expect(provenance).toBe("before");
    expect(commit).toHaveBeenCalledOnce();
  });
});

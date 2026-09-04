import { afterEach, describe, expect, it, vi } from "vitest";
import { readMemoryArtifactProvenance } from "../memory/memory-artifact-provenance.js";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { createMemoryWriteProvenanceObserver } from "./memory-write-provenance.js";

afterEach(() => {
  resetPluginStateStoreForTests();
});

describe("memory write provenance", () => {
  it("rolls provenance back when the filesystem write fails", async () => {
    await withStateDirEnv("openclaw-memory-provenance-", async ({ tempRoot }) => {
      const observer = createMemoryWriteProvenanceObserver({
        mutationRoot: tempRoot,
        workspaceDir: tempRoot,
        resolveOriginClass: () => "untrusted",
        now: () => 1,
      });
      const commit = vi.fn(async () => {
        throw new Error("disk full");
      });

      await expect(
        observer.write({
          absolutePath: `${tempRoot}/MEMORY.md`,
          contentBefore: "before",
          contentAfter: "after",
          commit,
        }),
      ).rejects.toThrow("disk full");
      await expect(
        readMemoryArtifactProvenance({ workspaceDir: tempRoot, relativePath: "MEMORY.md" }),
      ).resolves.toBeUndefined();
      expect(commit).toHaveBeenCalledOnce();
    });
  });
});

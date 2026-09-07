import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readMemoryArtifactProvenance } from "../memory/memory-artifact-provenance.js";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import {
  createMemoryWriteProvenanceObserver,
  withMemoryWriteProvenance,
} from "./memory-write-provenance.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

afterEach(() => {
  resetPluginStateStoreForTests();
});

describe("memory write provenance", () => {
  it.each(
    (["write-classification", "write-observer", "remove-classification"] as const).flatMap(
      (phase) => [false, true].map((revoke) => ({ phase, revoke })),
    ),
  )("preserves caller authority across $phase (revoke=$revoke)", async ({ phase, revoke }) => {
    await withStateDirEnv("openclaw-memory-source-authority-", async ({ tempRoot }) => {
      const target = `${tempRoot}/MEMORY.md`;
      await fs.writeFile(target, "before");
      let active = true;
      const operations = withMemoryWriteProvenance(
        {
          readFile: (file: string) => fs.readFile(file),
          writeFile: (file: string, content: string) => fs.writeFile(file, content),
          remove: (file: string) => fs.rm(file),
        },
        {
          classifies: async () => {
            if (phase !== "write-observer" && revoke) {
              active = false;
            }
            return true;
          },
          write: async ({ commit }) => {
            if (phase === "write-observer" && revoke) {
              active = false;
            }
            await commit();
          },
          clearAfterDelete: async () => {},
        },
      );
      const pending = withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:memory-authority",
          receiptAuthority: () => active,
        },
        () =>
          phase === "remove-classification"
            ? operations.remove(target)
            : operations.writeFile(target, "after"),
      );
      if (revoke) {
        await expect(pending).rejects.toThrow("authority is no longer active");
        expect(await fs.readFile(target, "utf8")).toBe("before");
      } else {
        await pending;
        if (phase === "remove-classification") {
          await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
        } else {
          expect(await fs.readFile(target, "utf8")).toBe("after");
        }
      }
    });
  });

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

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { assertNoHardlinkedFinalPath } from "./fs-safe-advanced.js";

async function withHardlinkFixture(
  cb: (context: { root: string; source: string; linked: string; dirPath: string }) => Promise<void>,
): Promise<void> {
  await withTempDir({ prefix: "openclaw-hardlink-guards-" }, async (root) => {
    const dirPath = path.join(root, "dir");
    const source = path.join(root, "source.txt");
    const linked = path.join(root, "linked.txt");
    await fs.mkdir(dirPath);
    await fs.writeFile(source, "hello", "utf8");
    await fs.link(source, linked);
    await cb({ root, source, linked, dirPath });
  });
}

describe("assertNoHardlinkedFinalPath", () => {
  it.each([
    {
      name: "allows missing paths",
      filePath: ({ root }: { root: string }) => path.join(root, "missing.txt"),
      opts: {},
    },
    {
      name: "allows directories",
      filePath: ({ dirPath }: { dirPath: string }) => dirPath,
      opts: {},
    },
    {
      name: "allows explicit unlink opt-in",
      filePath: ({ linked }: { linked: string }) => linked,
      opts: { allowFinalHardlinkForUnlink: true },
    },
  ])("$name", async ({ filePath, opts }) => {
    await withHardlinkFixture(async (context) => {
      await expect(
        assertNoHardlinkedFinalPath({
          filePath: filePath(context),
          root: context.root,
          boundaryLabel: "workspace",
          ...opts,
        }),
      ).resolves.toBeUndefined();
    });
  });

  it("rejects hardlinked files and shortens home-relative paths in the error", async () => {
    await withHardlinkFixture(async ({ root, linked }) => {
      const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(root);
      const expectedLinkedPath = path.join("~", "linked.txt");

      try {
        await expect(
          assertNoHardlinkedFinalPath({
            filePath: linked,
            root,
            boundaryLabel: "workspace",
          }),
        ).rejects.toThrow(
          `Hardlinked path is not allowed under workspace (~): ${expectedLinkedPath}`,
        );
      } finally {
        homedirSpy.mockRestore();
      }
    });
  });
});

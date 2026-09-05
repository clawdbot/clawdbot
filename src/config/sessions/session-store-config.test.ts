import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tryResolvePathCaseInsensitive } from "../../infra/path-case.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { isSameFixedSessionStoreConfig } from "./session-store-config.js";

describe("fixed session store identity", () => {
  it.runIf(process.platform !== "win32")(
    "canonicalizes dangling leaf and ancestor aliases for a missing owned store",
    async () => {
      await withTestDir({ prefix: "openclaw-fixed-store-alias-" }, async (root) => {
        const ownedStore = path.join(root, "future", "sessions.sqlite");
        const leafAlias = path.join(root, "leaf-alias.sqlite");
        const ancestorAlias = path.join(root, "ancestor-alias");
        await fs.symlink(ownedStore, leafAlias);
        await fs.symlink(path.dirname(ownedStore), ancestorAlias);

        expect(isSameFixedSessionStoreConfig(ownedStore, leafAlias, process.env)).toBe(true);
        expect(
          isSameFixedSessionStoreConfig(
            ownedStore,
            path.join(ancestorAlias, path.basename(ownedStore)),
            process.env,
          ),
        ).toBe(true);
        expect(
          isSameFixedSessionStoreConfig(
            ownedStore,
            path.join(root, "unrelated", "sessions.sqlite"),
            process.env,
          ),
        ).toBe(false);
      });
    },
  );

  it("treats pre-creation case variants as owned on case-insensitive filesystems", async () => {
    await withTestDir({ prefix: "openclaw-fixed-store-case-" }, async (root) => {
      const ownedStore = path.join(root, "Future", "Sessions.sqlite");
      const caseVariantStore = path.join(root, "future", "sessions.sqlite");
      await expect(fs.stat(ownedStore)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(caseVariantStore)).rejects.toMatchObject({ code: "ENOENT" });
      if (tryResolvePathCaseInsensitive(ownedStore) !== true) {
        return;
      }

      expect(isSameFixedSessionStoreConfig(ownedStore, caseVariantStore, process.env)).toBe(true);
      await expect(fs.stat(ownedStore)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(caseVariantStore)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});

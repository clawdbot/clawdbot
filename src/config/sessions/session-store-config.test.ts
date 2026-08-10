import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import { isSameFixedSessionStoreConfig } from "./session-store-config.js";

describe("fixed session store identity", () => {
  it.runIf(process.platform !== "win32")(
    "canonicalizes dangling leaf and ancestor aliases for a missing owned store",
    async () => {
      await withTempDir({ prefix: "openclaw-fixed-store-alias-" }, async (root) => {
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
});

import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { expectNoReaddirSyncDuring } from "../../test-utils/fs-scan-assertions.js";
import { listFlatRootArchiveEntries } from "./archive-fixtures.js";
import { createSuiteTempRootTracker } from "./fs-fixtures.js";

const suiteTempRootTracker = createSuiteTempRootTracker("openclaw-plugin-archive-fixtures");

afterAll(() => {
  suiteTempRootTracker.cleanup();
});

describe("archive fixture helpers", () => {
  it.runIf(process.platform !== "win32")(
    "lists flat archive entries without scanning package dirs in-process",
    () => {
      const pkgDir = suiteTempRootTracker.makeTempDir();
      fs.writeFileSync(path.join(pkgDir, "package.json"), "{}\n");
      fs.mkdirSync(path.join(pkgDir, "dist"));
      fs.writeFileSync(path.join(pkgDir, "dist", "index.js"), "export {}\n");

      expectNoReaddirSyncDuring(() => {
        expect(listFlatRootArchiveEntries(pkgDir)).toEqual(["dist", "package.json"]);
      });
    },
  );
});

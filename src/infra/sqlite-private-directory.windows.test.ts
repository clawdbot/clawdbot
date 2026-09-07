import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createPrivateSqliteDirectory } from "./sqlite-private-directory.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("private SQLite directory creation on Windows", () => {
  it.runIf(process.platform === "win32")(
    "surfaces native stderr without exposing the encoded command",
    async () => {
      const root = tempDirs.make("openclaw-sqlite-private-directory-");
      const regularFile = path.join(root, "parent-file");
      await fs.writeFile(regularFile, "not a directory");

      const error = await createPrivateSqliteDirectory(path.join(regularFile, "child")).catch(
        (cause: unknown) => cause,
      );
      expect(error).toBeInstanceOf(Error);
      const child = (error as Error & { cause?: unknown }).cause;
      expect(child).toBeInstanceOf(Error);
      expect((child as Error).message).toMatch(/\bexit=1\b/u);
      expect((child as Error).message).toContain("stderr:");
      expect((child as Error).message).not.toContain("EncodedCommand");
    },
  );
});

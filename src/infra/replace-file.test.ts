import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { movePathWithCopyFallback } from "./replace-file.js";

describe("movePathWithCopyFallback", () => {
  it.runIf(process.platform !== "win32")(
    "rejects hardlinked source files when requested",
    async () => {
      await withTempDir({ prefix: "openclaw-replace-file-" }, async (root) => {
        const sourceDir = path.join(root, "source");
        const targetDir = path.join(root, "target");
        const sourceFile = path.join(sourceDir, "file.txt");
        const linkedFile = path.join(root, "linked.txt");
        await fs.mkdir(sourceDir);
        await fs.writeFile(sourceFile, "hello", "utf8");
        await fs.link(sourceFile, linkedFile);

        await expect(
          movePathWithCopyFallback({
            from: sourceDir,
            sourceHardlinks: "reject",
            to: targetDir,
          }),
        ).rejects.toThrow("Hardlinked source file is not allowed");

        await expect(fs.readFile(sourceFile, "utf8")).resolves.toBe("hello");
        let statError: NodeJS.ErrnoException | undefined;
        try {
          await fs.stat(targetDir);
        } catch (error) {
          statError = error as NodeJS.ErrnoException;
        }
        expect(statError).toBeInstanceOf(Error);
        expect(statError?.code).toBe("ENOENT");
        expect(statError?.path).toBe(targetDir);
        expect(statError?.syscall).toBe("stat");
      });
    },
  );
});

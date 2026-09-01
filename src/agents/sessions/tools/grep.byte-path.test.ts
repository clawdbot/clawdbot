import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { createGrepToolDefinition } from "./grep.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.skipIf(process.platform !== "linux")(
  "retains distinct byte filenames through real ripgrep context",
  async () => {
    const cwd = tempDirs.make("openclaw-grep-byte-files-");
    const paths = [0x80, 0x81].map((byte) =>
      Buffer.concat([
        Buffer.from(path.join(cwd, "report-")),
        Buffer.from([byte]),
        Buffer.from(".txt"),
      ]),
    );
    try {
      for (const [index, filePath] of paths.entries()) {
        await fs.writeFile(filePath, `before ${index}\nneedle ${index}\nafter ${index}\n`);
      }
      const result = await createGrepToolDefinition(cwd).execute(
        "byte-files",
        { pattern: "needle", context: 1 },
        undefined,
        undefined,
        {} as never,
      );
      const text = result.content
        .filter((entry) => entry.type === "text")
        .map((entry) => entry.text)
        .join("\n");
      expect(text.split("\n")).toHaveLength(6);
      for (let index = 0; index < paths.length; index += 1) {
        expect(text).toContain(
          `report-�.txt-1- before ${index}\nreport-�.txt:2: needle ${index}\nreport-�.txt-3- after ${index}`,
        );
      }
      expect(result.details).toBeUndefined();
    } finally {
      // Cleanup uses the same lossless paths that created the synthetic files.
      await Promise.all(paths.map((filePath) => fs.rm(filePath, { force: true })));
    }
  },
);

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyPatch } from "./apply-patch.test-support.js";

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-patch-context-"));
  try {
    return await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("applyPatch context byte preservation", () => {
  it.each([
    {
      name: "an end-of-file replacement",
      files: { "source.txt": "head\nlast context  \nold\n" },
      patch: `*** Begin Patch
*** Update File: source.txt
@@
 last context
-old
+new
*** End of File
*** End Patch`,
      expected: { "source.txt": "head\nlast context  \nnew\n" },
      missing: [],
    },
    {
      name: "multiple chunks with repeated context",
      files: {
        "source.txt": "anchor  \nold one\nmarker  \nanchor  \nold two\nmarker  \n",
      },
      patch: `*** Begin Patch
*** Update File: source.txt
@@
 anchor
-old one
+new one
 marker
@@
 anchor
-old two
+new two
 marker
*** End Patch`,
      expected: {
        "source.txt": "anchor  \nnew one\nmarker  \nanchor  \nnew two\nmarker  \n",
      },
      missing: [],
    },
    {
      name: "a move",
      files: { "source.txt": "It\u2019s here\nold\n" },
      patch: `*** Begin Patch
*** Update File: source.txt
*** Move to: destination.txt
@@
 It's here
-old
+new
*** End Patch`,
      expected: { "destination.txt": "It\u2019s here\nnew\n" },
      missing: ["source.txt"],
    },
    {
      name: "a pure insertion after fuzzy context",
      files: { "source.txt": "anchor  \ntail\n" },
      patch: `*** Begin Patch
*** Update File: source.txt
@@ anchor
+inserted
*** End Patch`,
      expected: { "source.txt": "anchor  \ninserted\ntail\n" },
      missing: [],
    },
    {
      name: "a CRLF replacement",
      files: { "source.txt": "\tcontext\r\nold\r\n" },
      patch: `*** Begin Patch
*** Update File: source.txt
@@
    context
-old
+new
*** End Patch`,
      expected: { "source.txt": "\tcontext\r\nnew\r\n" },
      missing: [],
    },
    {
      name: "a mixed-ending replacement",
      files: { "source.txt": "before  \r\nold\nIt\u2019s after\r\n" },
      patch: `*** Begin Patch
*** Update File: source.txt
@@
 before
-old
+new
 It's after
*** End Patch`,
      expected: { "source.txt": "before  \r\nnew\nIt\u2019s after\r\n" },
      missing: [],
    },
  ])("keeps context bytes through $name", async ({ files, patch, expected, missing }) => {
    await withTempDir(async (dir) => {
      await Promise.all(
        Object.entries(files).map(([filePath, contents]) =>
          fs.writeFile(path.join(dir, filePath), contents, "utf8"),
        ),
      );

      await applyPatch(patch, { cwd: dir });

      for (const [filePath, contents] of Object.entries(expected)) {
        await expect(fs.readFile(path.join(dir, filePath), "utf8")).resolves.toBe(contents);
      }
      for (const filePath of missing) {
        await expect(fs.stat(path.join(dir, filePath))).rejects.toMatchObject({ code: "ENOENT" });
      }
    });
  });
});

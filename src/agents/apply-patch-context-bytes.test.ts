import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyPatch, createMemoryPatchSandbox } from "./apply-patch.test-support.js";

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

  it("preserves line endings and EOF state for no-op update hunks", async () => {
    const patch = `*** Begin Patch
*** Update File: source.txt
@@
 foo
-bar
+bar
*** End Patch`;
    for (const initial of ["foo\r\nbar\r\n", "foo\nbar"]) {
      const memory = createMemoryPatchSandbox({ "source.txt": initial });

      const result = await applyPatch(patch, memory.options);

      expect(result.noOp).toBe(true);
      expect(memory.files.get("/sandbox/source.txt")).toBe(initial);
      expect(memory.writeFile.mock.calls).toHaveLength(0);
    }
  });

  it("preserves CRLF line endings for changed and context lines", async () => {
    const initial =
      'class Program {\r\n  static void Main() {\r\n    Console.WriteLine("hello");\r\n  }\r\n}\r\n';
    const memory = createMemoryPatchSandbox({ "source.txt": initial });
    const patch = `*** Begin Patch
*** Update File: source.txt
@@
   static void Main() {
-    Console.WriteLine("hello");
+    Console.WriteLine("world");
   }
*** End Patch`;

    const result = await applyPatch(patch, memory.options);

    expect(result.noOp).toBeUndefined();
    expect(memory.files.get("/sandbox/source.txt")).toBe(
      'class Program {\r\n  static void Main() {\r\n    Console.WriteLine("world");\r\n  }\r\n}\r\n',
    );
  });

  it("preserves CRLF line endings when the hunk spans the whole file", async () => {
    const memory = createMemoryPatchSandbox({ "source.txt": "foo\r\nbar\r\n" });
    const patch = `*** Begin Patch
*** Update File: source.txt
@@
 foo
-bar
+baz
*** End Patch`;

    await applyPatch(patch, memory.options);

    expect(memory.files.get("/sandbox/source.txt")).toBe("foo\r\nbaz\r\n");
  });

  it("preserves CRLF line endings for inserted lines", async () => {
    const memory = createMemoryPatchSandbox({ "source.txt": "foo\r\nbar\r\n" });
    const patch = `*** Begin Patch
*** Update File: source.txt
@@ foo
+middle
*** End Patch`;

    await applyPatch(patch, memory.options);

    expect(memory.files.get("/sandbox/source.txt")).toBe("foo\r\nmiddle\r\nbar\r\n");
  });

  it("keeps LF files on LF after a real update hunk", async () => {
    const memory = createMemoryPatchSandbox({ "source.txt": "foo\nbar\n" });
    const patch = `*** Begin Patch
*** Update File: source.txt
@@
 foo
-bar
+baz
*** End Patch`;

    await applyPatch(patch, memory.options);

    expect(memory.files.get("/sandbox/source.txt")).toBe("foo\nbaz\n");
  });

  it("keeps context line bytes when the hunk drops trailing whitespace", async () => {
    const memory = createMemoryPatchSandbox({
      "notes.md": "# Notes\nfirst line  \nsecond line  \nold value\ntail\n",
    });
    const patch = `*** Begin Patch
*** Update File: notes.md
@@
 first line
 second line
-old value
+new value
 tail
*** End Patch`;

    await applyPatch(patch, memory.options);

    expect(memory.files.get("/sandbox/notes.md")).toBe(
      "# Notes\nfirst line  \nsecond line  \nnew value\ntail\n",
    );
  });

  it.each([
    {
      title: "keeps context line punctuation when the hunk uses normalized quotes",
      fileName: "notes.md",
      initialContent: "It\u2019s done\nold value\n",
      patchText: `*** Begin Patch
*** Update File: notes.md
@@
 It's done
-old value
+new value
*** End Patch`,
      expectedPath: "/sandbox/notes.md",
      expectedContent: "It\u2019s done\nnew value\n",
    },
    {
      title: "does not normalize mixed line endings outside the changed hunk",
      fileName: "source.txt",
      initialContent: "first\r\nsecond\nthird\r\n",
      patchText: `*** Begin Patch
*** Update File: source.txt
@@
-second
+changed
*** End Patch`,
      expectedPath: "/sandbox/source.txt",
      expectedContent: "first\r\nchanged\nthird\r\n",
    },
    {
      title: "applies context-only insertions at the requested context",
      fileName: "source.txt",
      initialContent: "alpha\nanchor\nomega\n",
      patchText: `*** Begin Patch
*** Update File: source.txt
@@ anchor
+inserted
*** End Patch`,
      expectedPath: "/sandbox/source.txt",
      expectedContent: "alpha\nanchor\ninserted\nomega\n",
    },
    {
      title: "keeps later insertion contexts in original file coordinates",
      fileName: "source.txt",
      initialContent: "a\nb\nc\n",
      patchText: `*** Begin Patch
*** Update File: source.txt
@@ a
+after-a
@@ b
+after-b
*** End Patch`,
      expectedPath: "/sandbox/source.txt",
      expectedContent: "a\nafter-a\nb\nafter-b\nc\n",
    },
    {
      title: "supports end-of-file inserts",
      fileName: "end.txt",
      initialContent: "line1\n",
      patchText: `*** Begin Patch
*** Update File: end.txt
@@
+line2
*** End of File
*** End Patch`,
      expectedPath: "/sandbox/end.txt",
      expectedContent: "line1\nline2\n",
    },
  ])("$title", async ({ fileName, initialContent, patchText, expectedPath, expectedContent }) => {
    const memory = createMemoryPatchSandbox({
      [fileName]: initialContent,
    });
    const patch = patchText;

    await applyPatch(patch, memory.options);

    expect(memory.files.get(expectedPath)).toBe(expectedContent);
  });

  it("keeps tab indentation on context lines when the hunk uses spaces", async () => {
    const memory = createMemoryPatchSandbox({
      "run.py":
        "def run(x):\n\tif x:\n\t\tprepare()\n\t\tvalue = 1\n\t\treturn value\n\treturn 0\n",
    });
    const patch = `*** Begin Patch
*** Update File: run.py
@@
     if x:
         prepare()
-        value = 1
+        value = 2
         return value
*** End Patch`;

    await applyPatch(patch, memory.options);

    expect(memory.files.get("/sandbox/run.py")).toBe(
      "def run(x):\n\tif x:\n\t\tprepare()\n        value = 2\n\t\treturn value\n\treturn 0\n",
    );
  });

  it("applies a real deletion of the sole blank line", async () => {
    const memory = createMemoryPatchSandbox({ "source.txt": "\n" });
    const patch = `*** Begin Patch
*** Update File: source.txt
@@
-
*** End Patch`;

    const result = await applyPatch(patch, memory.options);

    expect(result.noOp).toBeUndefined();
    expect(memory.files.get("/sandbox/source.txt")).toBe("");
    expect(memory.writeFile.mock.calls).toHaveLength(1);
  });

  it("preserves formatting for same-path move no-op hunks", async () => {
    const patch = `*** Begin Patch
*** Update File: source.txt
*** Move to: ./source.txt
@@
 foo
-bar
+bar
*** End Patch`;
    for (const initial of ["foo\r\nbar\r\n", "foo\nbar"]) {
      const memory = createMemoryPatchSandbox({ "source.txt": initial });

      const result = await applyPatch(patch, memory.options);

      expect(result.noOp).toBe(true);
      expect(memory.files.get("/sandbox/source.txt")).toBe(initial);
      expect(memory.writeFile.mock.calls).toHaveLength(0);
    }
  });
});

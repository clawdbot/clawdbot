import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApplyPatchTool } from "./apply-patch.js";

const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all([...tempDirs].map((dir) => fs.rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
});

type UpdateCase = {
  title: string;
  file?: string;
  initial: string;
  changes: string[];
  expected: string;
};

async function runUpdate(testCase: UpdateCase): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-apply-patch-update-"));
  tempDirs.add(dir);
  const file = testCase.file ?? "source.txt";
  const filePath = path.join(dir, file);
  await fs.writeFile(filePath, testCase.initial);
  const patch = [
    "*** Begin Patch",
    `*** Update File: ${file}`,
    ...testCase.changes,
    "*** End Patch",
  ].join("\n");

  await createApplyPatchTool({ cwd: dir }).execute("test", { input: patch }, undefined);

  return fs.readFile(filePath, "utf8");
}

describe("apply_patch update byte preservation", () => {
  it.each<UpdateCase>([
    {
      title: "preserves changed and context CRLF lines",
      initial:
        'class Program {\r\n  static void Main() {\r\n    Console.WriteLine("hello");\r\n  }\r\n}\r\n',
      changes: [
        "@@",
        "  static void Main() {",
        '-    Console.WriteLine("hello");',
        '+    Console.WriteLine("world");',
        "  }",
      ],
      expected:
        'class Program {\r\n  static void Main() {\r\n    Console.WriteLine("world");\r\n  }\r\n}\r\n',
    },
    {
      title: "preserves CRLF across a whole-file hunk",
      initial: "foo\r\nbar\r\n",
      changes: ["@@", " foo", "-bar", "+baz"],
      expected: "foo\r\nbaz\r\n",
    },
    {
      title: "uses CRLF for inserted lines",
      initial: "foo\r\nbar\r\n",
      changes: ["@@ foo", "+middle"],
      expected: "foo\r\nmiddle\r\nbar\r\n",
    },
    {
      title: "keeps LF files on LF",
      initial: "foo\nbar\n",
      changes: ["@@", " foo", "-bar", "+baz"],
      expected: "foo\nbaz\n",
    },
    {
      title: "adds the first line to an empty file",
      initial: "",
      changes: ["@@", "+first"],
      expected: "first\n",
    },
    {
      title: "preserves trailing whitespace on context lines",
      file: "notes.md",
      initial: "# Notes\nfirst line  \nsecond line  \nold value\ntail\n",
      changes: ["@@", " first line", " second line", "-old value", "+new value", " tail"],
      expected: "# Notes\nfirst line  \nsecond line  \nnew value\ntail\n",
    },
    {
      title: "preserves punctuation on fuzzy context lines",
      file: "notes.md",
      initial: "It’s done\nold value\n",
      changes: ["@@", " It's done", "-old value", "+new value"],
      expected: "It’s done\nnew value\n",
    },
    {
      title: "preserves mixed endings outside the changed hunk",
      initial: "first\r\nsecond\nthird\r\n",
      changes: ["@@", "-second", "+changed"],
      expected: "first\r\nchanged\nthird\r\n",
    },
    {
      title: "preserves a replaced line ending in a mixed file",
      initial: "first\r\nsecond\r\nthird\n",
      changes: ["@@", " first", "-second", "+changed", " third"],
      expected: "first\r\nchanged\r\nthird\n",
    },
    {
      title: "preserves a UTF-8 BOM when replacing the first line",
      initial: "\uFEFFheading\nkeep\n",
      changes: ["@@", "-heading", "+title", " keep"],
      expected: "\uFEFFtitle\nkeep\n",
    },
    {
      title: "preserves a missing final newline",
      initial: "foo\nbar",
      changes: ["@@", " foo", "-bar", "+baz"],
      expected: "foo\nbaz",
    },
    {
      title: "preserves final-newline state when one line expands",
      initial: "head\r\nold",
      changes: ["@@", " head", "-old", "+new one", "+new two"],
      expected: "head\r\nnew one\r\nnew two",
    },
    {
      title: "keeps the predecessor terminator when deleting an unterminated final line",
      initial: "first\nlast",
      changes: ["@@", " first", "-last"],
      expected: "first\n",
    },
    {
      title: "inserts at the requested context",
      initial: "alpha\nanchor\nomega\n",
      changes: ["@@ anchor", "+inserted"],
      expected: "alpha\nanchor\ninserted\nomega\n",
    },
    {
      title: "keeps later insertion contexts in source coordinates",
      initial: "a\nb\nc\n",
      changes: ["@@ a", "+after-a", "@@ b", "+after-b"],
      expected: "a\nafter-a\nb\nafter-b\nc\n",
    },
    {
      title: "inserts at the end of a file",
      initial: "line1\n",
      changes: ["@@", "+line2", "*** End of File"],
      expected: "line1\nline2\n",
    },
    {
      title: "preserves a missing final newline after an end-of-file insertion",
      initial: "line1",
      changes: ["@@", "+line2", "*** End of File"],
      expected: "line1\nline2",
    },
    // Fuzzy whitespace matching locates source lines; replacement content stays literal.
    {
      title: "writes replacement lines literally inside a tab-indented block",
      file: "run.py",
      initial: "def run(x):\n\tif x:\n\t\tprepare()\n\t\tvalue = 1\n\t\treturn value\n\treturn 0\n",
      changes: [
        "@@",
        "     if x:",
        "         prepare()",
        "-        value = 1",
        "+        value = 2",
        "         return value",
      ],
      expected:
        "def run(x):\n\tif x:\n\t\tprepare()\n        value = 2\n\t\treturn value\n\treturn 0\n",
    },
    {
      title: "keeps an explicit replacement indentation change",
      file: "run.py",
      initial: "def run(x):\n\tif x:\n\t\tvalue = 1\n",
      changes: ["@@", "     if x:", "-        value = 1", "+    value = 2"],
      expected: "def run(x):\n\tif x:\n    value = 2\n",
    },
  ])("$title", async (testCase) => {
    expect(await runUpdate(testCase)).toBe(testCase.expected);
  });
});

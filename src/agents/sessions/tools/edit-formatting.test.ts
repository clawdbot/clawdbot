import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyPatch } from "diff";
import { afterEach, beforeEach, expect, it } from "vitest";
import { computeEditsDiff } from "./edit-diff.js";
import { createEditTool } from "./edit.js";
import type { EditToolDetails } from "./tool-contracts.js";

let tmpDir = "";
beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-edit-formatting-"));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

it.each([
  { name: "trailing spaces", oldText: "alpha  ", newText: "alpha" },
  { name: "smart quotes", oldText: "say “hello”", newText: 'say "hello"' },
  { name: "Unicode dash", oldText: "first—last", newText: "first-last" },
  { name: "non-breaking space", oldText: "first\u00a0last", newText: "first last" },
  { name: "compatibility characters", oldText: "count: ３", newText: "count: 3" },
])("applies exact $name replacements in execution and preview", async ({ oldText, newText }) => {
  const original = `${oldText}\nkeep  \n`;
  const expected = `${newText}\nkeep  \n`;
  const filePath = path.join(tmpDir, "example.txt");
  await fs.writeFile(filePath, original);
  const edits = [{ oldText, newText }];

  const preview = await computeEditsDiff(filePath, edits, tmpDir);
  const result = await createEditTool(tmpDir).execute(
    "formatting",
    { path: filePath, edits },
    undefined,
  );

  expect(result.terminate).not.toBe(true);
  await expect(fs.readFile(filePath, "utf8")).resolves.toBe(expected);
  const details = result.details as EditToolDetails;
  expect(details.changed).toBe(true);
  if (!details.changed) {
    throw new Error("Expected a formatting edit to change the file.");
  }
  expect(applyPatch(original, details.patch)).toBe(expected);
  expect(preview).toEqual({ diff: details.diff, firstChangedLine: details.firstChangedLine });
});

it("preserves a disjoint change beside an actual fuzzy net no-op", async () => {
  const original = "alpha\nbeta\n";
  const expected = "alpha\nBETA\n";
  const filePath = path.join(tmpDir, "example.txt");
  await fs.writeFile(filePath, original);
  const edits = [
    { oldText: "alpha \n", newText: "alpha\n" },
    { oldText: "beta", newText: "BETA" },
  ];

  const preview = await computeEditsDiff(filePath, edits, tmpDir);
  const result = await createEditTool(tmpDir).execute(
    "mixed",
    { path: filePath, edits },
    undefined,
  );

  expect(result.terminate).not.toBe(true);
  await expect(fs.readFile(filePath, "utf8")).resolves.toBe(expected);
  const details = result.details as EditToolDetails;
  expect(details.changed).toBe(true);
  if (!details.changed) {
    throw new Error("Expected the disjoint replacement to change the file.");
  }
  expect(applyPatch(original, details.patch)).toBe(expected);
  expect(preview).toEqual({ diff: details.diff, firstChangedLine: details.firstChangedLine });
});

it.each([
  { name: "empty replacement list", edits: [], error: "at least one replacement" },
  {
    name: "empty old text",
    edits: [{ oldText: "", newText: "" }],
    error: "oldText must not be empty",
  },
])("rejects $name without changing the file", async ({ edits, error }) => {
  const filePath = path.join(tmpDir, "example.txt");
  await fs.writeFile(filePath, "original\n");
  await expect(
    createEditTool(tmpDir).execute("invalid", { path: filePath, edits }, undefined),
  ).rejects.toThrow(error);
  await expect(fs.readFile(filePath, "utf8")).resolves.toBe("original\n");
});

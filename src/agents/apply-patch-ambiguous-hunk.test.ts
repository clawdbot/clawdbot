import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { applyUpdateHunk } from "./apply-patch-update.js";
import { applyPatch } from "./apply-patch.test-support.js";

type Chunk = Parameters<typeof applyUpdateHunk>[1][number];
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function chunk(overrides: Partial<Chunk>): Chunk {
  return {
    oldLines: [],
    newLines: [],
    contextOldIndexes: [],
    isEndOfFile: false,
    ...overrides,
  };
}

async function applyTo(source: string, chunks: Chunk[]): Promise<string> {
  return applyUpdateHunk("source.txt", chunks, { readFile: async () => source });
}

describe("apply_patch ambiguous hunk matching", () => {
  it.each([
    {
      tier: "exact",
      source: "before\ntarget\ntarget\nafter\n",
      pattern: "target",
    },
    {
      tier: "trim-end",
      source: "before\ntarget  \ntarget\t\nafter\n",
      pattern: "target",
    },
    {
      tier: "trim",
      source: "before\n  target\n\ttarget\nafter\n",
      pattern: "target",
    },
    {
      tier: "punctuation",
      source: "before\nIt\u2019s done\nIt\u2018s done\nafter\n",
      pattern: "It's done",
    },
  ])("refuses duplicate matches at the $tier tier", async ({ source, pattern }) => {
    await expect(applyTo(source, [chunk({ oldLines: [pattern] })])).rejects.toThrow(
      /Found 2 occurrences.*include more surrounding lines/s,
    );
  });

  it("refuses an exact duplicate @@ context", async () => {
    const source = [
      "function target() {",
      "  return 1;",
      "}",
      "function target() {",
      "  return 2;",
      "}",
      "",
    ].join("\n");

    await expect(
      applyTo(source, [
        chunk({
          changeContext: "function target() {",
          oldLines: ["  return 2;"],
          newLines: ["  return 3;"],
          contextOldIndexes: [undefined],
        }),
      ]),
    ).rejects.toThrow(/Found 2 occurrences of context.*more specific @@ context line/s);
  });

  it.each([
    {
      tier: "exact",
      source: "before\ntarget\nafter\n",
      pattern: "target",
      expected: "before\nafter\n",
    },
    {
      tier: "trim-end",
      source: "before\ntarget  \nafter\n",
      pattern: "target",
      expected: "before\nafter\n",
    },
    {
      tier: "trim",
      source: "before\n  target\nafter\n",
      pattern: "target",
      expected: "before\nafter\n",
    },
    {
      tier: "punctuation",
      source: "before\nIt\u2019s done\nafter\n",
      pattern: "It's done",
      expected: "before\nafter\n",
    },
  ])("applies a unique match at the $tier tier", async ({ source, pattern, expected }) => {
    await expect(applyTo(source, [chunk({ oldLines: [pattern] })])).resolves.toBe(expected);
  });

  it("prefers a unique exact match over broader tolerant lookalikes", async () => {
    const source = " target\ntarget\n\ttarget\n";

    await expect(applyTo(source, [chunk({ oldLines: ["target"] })])).resolves.toBe(
      " target\n\ttarget\n",
    );
  });

  it("uses a unique @@ context to disambiguate repeated exact hunk text", async () => {
    const source = [
      "function first() {",
      "  return 1;",
      "}",
      "function second() {",
      "  return 1;",
      "}",
      "",
    ].join("\n");

    await expect(
      applyTo(source, [
        chunk({
          changeContext: "function second() {",
          oldLines: ["  return 1;"],
          newLines: ["  return 2;"],
          contextOldIndexes: [undefined],
        }),
      ]),
    ).resolves.toBe(
      [
        "function first() {",
        "  return 1;",
        "}",
        "function second() {",
        "  return 2;",
        "}",
        "",
      ].join("\n"),
    );
  });

  it("keeps sequential hunk searches after the prior match", async () => {
    const source = "marker\ntarget\nmiddle\ntarget\n";

    await expect(
      applyTo(source, [
        chunk({
          oldLines: ["marker", "target"],
          newLines: ["marker", "first"],
          contextOldIndexes: [undefined, undefined],
        }),
        chunk({
          oldLines: ["target"],
          newLines: ["second"],
          contextOldIndexes: [undefined],
        }),
      ]),
    ).resolves.toBe("marker\nfirst\nmiddle\nsecond\n");
  });

  it("keeps end-of-file matching anchored to the final candidate", async () => {
    const source = "\ttarget\nmiddle\n\ttarget\n";

    await expect(
      applyTo(source, [
        chunk({
          oldLines: ["  target"],
          newLines: ["done"],
          contextOldIndexes: [undefined],
          isEndOfFile: true,
        }),
      ]),
    ).resolves.toBe("\ttarget\nmiddle\ndone\n");
  });

  it("leaves the file byte-identical when an ambiguous patch is refused", async () => {
    const dir = tempDirs.make("openclaw-patch-amb-");
    const file = path.join(dir, "source.txt");
    const source = "before\ntarget\ntarget\nafter\n";
    await fs.writeFile(file, source);

    const patch = `*** Begin Patch
*** Update File: source.txt
@@
-target
*** End Patch`;

    await expect(applyPatch(patch, { cwd: dir })).rejects.toThrow(/Found 2 occurrences/);
    await expect(fs.readFile(file, "utf8")).resolves.toBe(source);
  });
});

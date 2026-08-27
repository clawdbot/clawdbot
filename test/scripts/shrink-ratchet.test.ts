import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compareRatchetCounts,
  compareRatchetSets,
  enforceRatchetScalar,
  formatRatchetMessage,
  loadRatchetReference,
  loadRatchetSnapshot,
  parseRatchetCounts,
  parseRatchetPaths,
  parseRatchetScalar,
} from "../../scripts/lib/shrink-ratchet.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("shrink-ratchet", () => {
  it.each([
    {
      expected: ["src/b.ts", "src/a.ts"],
      file: "paths.txt",
      parse: (source: string) => [...parseRatchetPaths(source)],
      source: "# grandfathered files\nsrc/b.ts\nsrc/a.ts\n",
    },
    {
      expected: [
        ["src/b.ts", 2],
        ["src/a.ts", 1],
      ],
      file: "counts.txt",
      parse: (source: string) => [...parseRatchetCounts(source, "counts.txt")],
      source: "# per-file debt\nsrc/b.ts\t2\nsrc/a.ts\t1\n",
    },
    {
      expected: 2,
      file: "scalar.txt",
      parse: (source: string) => parseRatchetScalar(source, "scalar.txt"),
      source: "# total debt\n2\n",
    },
  ])("loads the existing $file baseline format", ({ expected, file, parse, source }) => {
    const root = tempDirs.make("openclaw-shrink-ratchet-");
    fs.writeFileSync(path.join(root, file), source);

    expect(loadRatchetSnapshot<unknown>(root, file, false, parse)).toEqual(expected);
  });

  it("loads worktree, index, and reference snapshots", () => {
    const root = tempDirs.make("openclaw-shrink-ratchet-git-");
    const baselinePath = "baseline.txt";
    const absolutePath = path.join(root, baselinePath);
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    fs.writeFileSync(absolutePath, "1\n");
    execFileSync("git", ["add", baselinePath], { cwd: root, stdio: "ignore" });
    execFileSync(
      "git",
      ["-c", "user.name=OpenClaw", "-c", "user.email=test@openclaw.local", "commit", "-m", "base"],
      { cwd: root, stdio: "ignore" },
    );
    fs.writeFileSync(absolutePath, "2\n");
    execFileSync("git", ["add", baselinePath], { cwd: root, stdio: "ignore" });
    fs.writeFileSync(absolutePath, "3\n");
    const parse = (source: string) => parseRatchetScalar(source, baselinePath);

    expect(loadRatchetSnapshot(root, baselinePath, false, parse)).toBe(3);
    expect(loadRatchetSnapshot(root, baselinePath, true, parse)).toBe(2);
    expect(loadRatchetReference(root, "HEAD", baselinePath, parse)).toBe(1);
    expect(loadRatchetReference(root, "HEAD", "missing.txt", parse)).toBeNull();
  });

  it.each([
    () => parseRatchetCounts("src/a.ts\t0\n", "counts.txt"),
    () => parseRatchetCounts("src/a.ts\t1\nsrc/a.ts\t2\n", "counts.txt"),
    () => parseRatchetCounts("src/a.ts\t1.5\n", "counts.txt"),
  ])("rejects malformed count-map baselines", (parse) => {
    expect(parse).toThrow(/Invalid counts\.txt entry/u);
  });

  it.each([
    () => parseRatchetScalar("1\n2\n", "scalar.txt"),
    () => parseRatchetScalar("-1\n", "scalar.txt"),
    () => parseRatchetScalar("many\n", "scalar.txt"),
  ])("rejects malformed scalar baselines", (parse) => {
    expect(parse).toThrow(/exactly one non-negative integer/u);
  });

  it.each([
    {
      compare: () =>
        compareRatchetSets(
          ["src/z.ts", "src/b.ts", "src/c.ts", "src/y.ts"],
          new Set(["src/x.ts", "src/a.ts", "src/b.ts", "src/w.ts"]),
        ),
      expected: {
        added: ["src/c.ts", "src/y.ts", "src/z.ts"],
        removed: ["src/a.ts", "src/w.ts", "src/x.ts"],
      },
      name: "path sets",
    },
    {
      compare: () =>
        compareRatchetCounts(
          new Map([
            ["src/z.ts", 1],
            ["src/b.ts", 1],
            ["src/c.ts", 1],
          ]),
          new Map([
            ["src/x.ts", 1],
            ["src/a.ts", 1],
            ["src/b.ts", 2],
          ]),
        ),
      expected: {
        decreased: [
          { allowed: 1, current: 0, entry: "src/a.ts" },
          { allowed: 2, current: 1, entry: "src/b.ts" },
          { allowed: 1, current: 0, entry: "src/x.ts" },
        ],
        increased: [
          { allowed: 0, current: 1, entry: "src/c.ts" },
          { allowed: 0, current: 1, entry: "src/z.ts" },
        ],
      },
      name: "per-entry counts",
    },
  ])("compares $name without permitting growth", ({ compare, expected }) => {
    expect(compare()).toEqual(expected);
  });

  it.each([
    { current: 3, message: "budget grew", messages: { increased: "budget grew" } },
    { current: 2, message: undefined, messages: {} },
    { current: 1, message: "shrink the budget", messages: { decreased: "shrink the budget" } },
  ])("preserves scalar failure messaging", ({ current, message, messages }) => {
    const enforce = () => enforceRatchetScalar(current, 2, messages);
    if (message) {
      expect(enforce).toThrow(message);
    } else {
      expect(enforce).not.toThrow();
    }
  });

  it("formats shrink guidance", () => {
    expect(
      formatRatchetMessage("Shrink baseline entries:", ["src/a.ts: 1 < 2", "src/b.ts: 0 < 1"]),
    ).toBe("Shrink baseline entries:\n  src/a.ts: 1 < 2\n  src/b.ts: 0 < 1");
  });
});

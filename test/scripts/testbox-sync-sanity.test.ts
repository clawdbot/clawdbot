import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  evaluateTestboxSyncSanity,
  parseGitShortStatus,
} from "../../scripts/testbox-sync-sanity.mjs";

describe("testbox sync sanity", () => {
  it("parses tracked deletions from git short status", () => {
    expect(
      parseGitShortStatus(
        " D pnpm-lock.yaml\nD  package.json\n?? scratch.txt\nR  old.ts -> new.ts\n",
      ),
    ).toEqual([
      {
        line: " D pnpm-lock.yaml",
        path: "pnpm-lock.yaml",
        status: " D",
        trackedDeletion: true,
      },
      {
        line: "D  package.json",
        path: "package.json",
        status: "D ",
        trackedDeletion: true,
      },
      {
        line: "?? scratch.txt",
        path: "scratch.txt",
        status: "??",
        trackedDeletion: false,
      },
      {
        line: "R  old.ts -> new.ts",
        path: "new.ts",
        status: "R ",
        trackedDeletion: false,
      },
    ]);
  });

  it("fails before a gate when critical repo files disappeared", () => {
    const result = evaluateTestboxSyncSanity({
      cwd: "/repo",
      statusRaw: "",
      exists: (file) => path.basename(file) !== "pnpm-lock.yaml",
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toContain("missing required root files: pnpm-lock.yaml");
  });

  it("fails on mass tracked deletions unless explicitly allowed", () => {
    const statusRaw = Array.from({ length: 3 }, (_, index) => ` D file-${index}.ts`).join("\n");
    const result = evaluateTestboxSyncSanity({
      cwd: "/repo",
      statusRaw,
      deletionThreshold: 3,
      exists: () => true,
    });

    expect(result.ok).toBe(false);
    expect(result.trackedDeletionCount).toBe(3);
    expect(result.problems[0]).toContain("remote git status has 3 tracked deletions");

    expect(
      evaluateTestboxSyncSanity({
        cwd: "/repo",
        statusRaw,
        deletionThreshold: 3,
        allowMassDeletions: true,
        exists: () => true,
      }).ok,
    ).toBe(true);
  });
});

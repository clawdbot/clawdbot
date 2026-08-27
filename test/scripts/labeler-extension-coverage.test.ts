import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type LabelerRule = Array<{
  "changed-files"?: Array<{
    "any-glob-to-any-file"?: string[];
  }>;
}>;

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const labelerPath = path.join(repoRoot, ".github/labeler.yml");

const extensionDirectories = [
  ...new Set(
    execFileSync("git", ["ls-files", "--", "extensions"], {
      cwd: repoRoot,
      encoding: "utf8",
    })
      .split("\n")
      .flatMap((file) => file.match(/^extensions\/([^/]+)\//)?.[1] ?? []),
  ),
].toSorted();
const extensionDirectorySet = new Set(extensionDirectories);
const labeler = parse(readFileSync(labelerPath, "utf8")) as Record<string, LabelerRule>;
const extensionGlobDirectories = Object.values(labeler)
  .flat()
  .flatMap((rule) => rule["changed-files"] ?? [])
  .flatMap((changedFiles) => changedFiles["any-glob-to-any-file"] ?? [])
  .flatMap((glob) => glob.match(/^extensions\/([^/]+)\//)?.[1] ?? []);
const coveredExtensionDirectories = new Set(extensionGlobDirectories);

describe("labeler extension coverage", () => {
  it("covers every extension directory", () => {
    expect(extensionDirectories.filter((dir) => !coveredExtensionDirectories.has(dir))).toEqual([]);
  });

  it("references only existing extension directories", () => {
    expect(extensionGlobDirectories.filter((dir) => !extensionDirectorySet.has(dir))).toEqual([]);
  });
});

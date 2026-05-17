import { spawnSync } from "node:child_process";
import fs, { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { expectNoReaddirSyncDuring } from "../test-utils/fs-scan-assertions.js";
import { listGitTrackedFiles } from "../test-utils/repo-files.js";

const toolsDir = new URL("./", import.meta.url);
const toolsDirPath = fileURLToPath(toolsDir);
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const moduleReferencePattern =
  /\b(?:import|export)\s+(?:type\s+)?(?:[^"'`]*?\s+from\s+)?["']([^"']+)["']/gu;

function collectStaticModuleReferences(
  source: string,
): readonly { line: number; specifier: string }[] {
  const references: { line: number; specifier: string }[] = [];
  const lines = source.split("\n");
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//")) {
      continue;
    }
    for (const match of line.matchAll(moduleReferencePattern)) {
      const specifier = match[1];
      if (specifier) {
        references.push({ line: index + 1, specifier });
      }
    }
  }
  return references;
}

function listProductionToolModuleFiles(): string[] {
  const externalFiles = listExternalProductionToolModuleFiles();
  if (externalFiles) {
    return externalFiles;
  }
  return fs
    .readdirSync(toolsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .toSorted();
}

function listExternalProductionToolModuleFiles(): string[] | null {
  return listGitProductionToolModuleFiles() ?? listFindProductionToolModuleFiles();
}

function listGitProductionToolModuleFiles(): string[] | null {
  const files = listGitTrackedFiles({ repoRoot, pathspecs: "src/tools/*.ts" });
  if (!files) {
    return null;
  }
  return files
    .filter((line) => line.startsWith("src/tools/"))
    .map((line) => line.slice("src/tools/".length))
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .filter((name) => fs.existsSync(new URL(name, toolsDir)))
    .toSorted();
}

function listFindProductionToolModuleFiles(): string[] | null {
  const result = spawnSync(
    "find",
    [toolsDirPath, "-maxdepth", "1", "-type", "f", "-name", "*.ts"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  if (result.status !== 0) {
    return null;
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) =>
      line.slice(toolsDirPath.endsWith("/") ? toolsDirPath.length : toolsDirPath.length + 1),
    )
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .toSorted();
}

describe("tool system boundary", () => {
  it("lists production tool modules without scanning the tools directory in-process", () => {
    expectNoReaddirSyncDuring(() => {
      const files = listProductionToolModuleFiles();

      expect(files.length).toBeGreaterThan(0);
      expect(files.every((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))).toBe(true);
    });
  });

  it("keeps production tool modules independent from OpenClaw subsystems", () => {
    const violations = listProductionToolModuleFiles().flatMap((fileName) => {
      const source = readFileSync(new URL(fileName, toolsDir), "utf8");
      return collectStaticModuleReferences(source)
        .filter(
          (reference) =>
            !reference.specifier.startsWith("./") && !reference.specifier.startsWith("node:"),
        )
        .map((reference) => `${fileName}:${reference.line} ${reference.specifier}`);
    });

    expect(violations).toStrictEqual([]);
  });
});

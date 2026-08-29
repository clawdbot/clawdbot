import { spawnSync } from "node:child_process";
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  DEFAULT_EXTENSION_TEST_SHARD_COUNT,
  createExtensionTestShards,
  listExtensionTestFilesForRoots,
  splitExtensionTestJobTargets,
} from "../../scripts/lib/extension-test-plan.mts";
import { createVitestRunSpecs } from "../../scripts/test-projects.test-support.mts";
import { createExtensionTelegramVitestConfig } from "../vitest/vitest.extension-telegram.config.ts";

type WorkflowStep = {
  env?: Record<string, string>;
  name?: string;
  run?: string;
};

type PluginPrereleaseMatrixRow = {
  check_name: string;
  extensions_csv: string;
  includePatterns: string[];
  task: string;
};

function readPluginPrereleaseWorkflow() {
  return parse(readFileSync(".github/workflows/plugin-prerelease.yml", "utf8"));
}

function listTelegramRunnableTestFiles() {
  const testConfig = createExtensionTelegramVitestConfig({}).test ?? {};
  const dir = testConfig.dir ?? process.cwd();
  const exclude = (testConfig.exclude ?? []).map((pattern) =>
    path.isAbsolute(pattern) ? path.relative(dir, pattern).replaceAll("\\", "/") : pattern,
  );
  return globSync(testConfig.include ?? [], { cwd: dir, exclude })
    .map((file) => path.relative(process.cwd(), path.resolve(dir, file)).replaceAll("\\", "/"))
    .toSorted((left, right) => left.localeCompare(right));
}

function runPluginPrereleaseManifest(cwd = process.cwd()) {
  const workflow = readPluginPrereleaseWorkflow();
  const manifestStep = workflow.jobs.preflight.steps.find(
    (step: WorkflowStep) => step.name === "Build plugin prerelease manifest",
  );
  if (!manifestStep?.run) {
    throw new Error("Missing plugin prerelease manifest step");
  }
  const source = manifestStep.run.match(
    /node --import tsx --input-type=module <<'EOF'\n([\s\S]*?)\nEOF/u,
  )?.[1];
  if (!source) {
    throw new Error("Missing plugin prerelease manifest source");
  }

  const root = mkdtempSync(join(tmpdir(), "openclaw-plugin-prerelease-telegram-shards-"));
  const outputPath = join(root, "github-output");
  try {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      EXPECTED_SHA: "",
      FULL_RELEASE_VALIDATION: "false",
      GITHUB_OUTPUT: outputPath,
    };
    delete env.OPENCLAW_VITEST_INCLUDE_FILE;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module"], {
      cwd,
      encoding: "utf8",
      env,
      input: source,
    });
    expect(result.status, result.stderr).toBe(0);
    const output = new Map(
      readFileSync(outputPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => {
          const separator = line.indexOf("=");
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );
    return JSON.parse(output.get("plugin_prerelease_extension_matrix") ?? "{}") as {
      include: PluginPrereleaseMatrixRow[];
    };
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

describe("plugin prerelease Telegram extension shards", () => {
  it("preserves target-native batches when a frozen planner has no job splitter", () => {
    const fixtureRoot = path.resolve("test/fixtures/plugin-prerelease-frozen-target");
    const matrix = runPluginPrereleaseManifest(fixtureRoot);
    const batchRows = matrix.include.filter((row) => row.task === "extensions-batch");

    expect(matrix.include.every((row) => row.task !== "extension-file-shard")).toBe(true);
    expect(batchRows.map((row) => row.check_name)).toEqual([
      "checks-node-extensions-shard-1",
      "checks-node-extensions-shard-2",
    ]);
    expect(batchRows.map((row) => row.extensions_csv)).toEqual(["alpha,telegram", "zeta"]);
    expect(
      batchRows
        .flatMap((row) => row.extensions_csv.split(","))
        .filter((extensionId) => extensionId === "telegram"),
    ).toEqual(["telegram"]);
  });

  it("keeps Telegram out of balanced batches and covers every extension exactly once", () => {
    const allShards = createExtensionTestShards({
      cwd: process.cwd(),
      shardCount: DEFAULT_EXTENSION_TEST_SHARD_COUNT,
    });
    const allExtensionIds = allShards.flatMap((shard) => shard.extensionIds);
    const genericExtensionIds = allExtensionIds.filter((extensionId) => extensionId !== "telegram");
    const genericShards = createExtensionTestShards({
      cwd: process.cwd(),
      extensionIds: genericExtensionIds,
      shardCount: DEFAULT_EXTENSION_TEST_SHARD_COUNT,
    });

    expect(genericShards).toHaveLength(DEFAULT_EXTENSION_TEST_SHARD_COUNT);
    expect(genericShards.flatMap((shard) => shard.extensionIds)).not.toContain("telegram");
    expect(
      genericShards
        .flatMap((shard) => shard.extensionIds)
        .toSorted((left, right) => left.localeCompare(right)),
    ).toEqual(genericExtensionIds.toSorted((left, right) => left.localeCompare(right)));
    expect(allExtensionIds.filter((extensionId) => extensionId === "telegram")).toEqual([
      "telegram",
    ]);
    expect(
      allShards
        .flatMap((shard) => shard.planGroups)
        .find((group) => group.extensionIds.includes("telegram")),
    ).toMatchObject({
      config: "test/vitest/vitest.extension-telegram.config.ts",
      extensionIds: ["telegram"],
      roots: ["extensions/telegram"],
    });
    expect(new Set(genericShards.flatMap((shard) => shard.extensionIds)).size).toBe(
      genericExtensionIds.length,
    );
  });

  it("keeps dedicated Telegram shards inside the existing aggregate job contract", () => {
    const workflow = readPluginPrereleaseWorkflow();
    const extensionJob = workflow.jobs["plugin-prerelease-extension-shard"];
    const runStep = extensionJob.steps.find(
      (step: WorkflowStep) => step.name === "Run extension shard",
    );
    const suite = workflow.jobs["plugin-prerelease-suite"];
    const matrix = runPluginPrereleaseManifest();
    const genericRows = matrix.include.filter((row) => row.task === "extensions-batch");
    const telegramRows = matrix.include.filter((row) => row.task === "extension-file-shard");
    const allTelegramTestFiles = listExtensionTestFilesForRoots(["extensions/telegram"]);
    const runnableTelegramTestFiles = listTelegramRunnableTestFiles();

    expect(genericRows).toHaveLength(DEFAULT_EXTENSION_TEST_SHARD_COUNT);
    expect(genericRows.some((row) => row.extensions_csv.split(",").includes("telegram"))).toBe(
      false,
    );
    const telegramConfig = "test/vitest/vitest.extension-telegram.config.ts";
    const expectedTelegramPartitions = splitExtensionTestJobTargets(
      telegramConfig,
      runnableTelegramTestFiles,
    );
    expect(telegramRows).toHaveLength(expectedTelegramPartitions.length);
    expect(telegramRows).toEqual(
      expectedTelegramPartitions.map((includePatterns, index) =>
        expect.objectContaining({
          check_name: `checks-node-extensions-telegram-shard-${index + 1}`,
          extensions_csv: "telegram",
          includePatterns,
          runner: "blacksmith-8vcpu-ubuntu-2404",
          vitest_config: telegramConfig,
        }),
      ),
    );
    const telegramPartitions = telegramRows.map((row) => {
      expect(row.includePatterns).toBeInstanceOf(Array);
      return row.includePatterns;
    });
    expect(telegramPartitions.every((partition) => partition.length > 0)).toBe(true);
    expect(telegramPartitions.flat().toSorted((left, right) => left.localeCompare(right))).toEqual(
      runnableTelegramTestFiles,
    );
    expect(new Set(telegramPartitions.flat()).size).toBe(runnableTelegramTestFiles.length);
    expect(telegramPartitions.every((partition) => partition.length <= 10)).toBe(true);
    expect(Math.max(...telegramPartitions.map((partition) => partition.length))).toBe(10);
    expect(
      allTelegramTestFiles.filter((file) => !runnableTelegramTestFiles.includes(file)).length,
    ).toBeGreaterThan(0);

    const tempDir = mkdtempSync(join(tmpdir(), "openclaw-plugin-prerelease-telegram-specs-"));
    try {
      for (const [index, partition] of telegramPartitions.entries()) {
        const includeFile = join(tempDir, `telegram-shard-${index + 1}.json`);
        writeFileSync(includeFile, JSON.stringify(partition));
        const specs = createVitestRunSpecs(["test/vitest/vitest.extension-telegram.config.ts"], {
          baseEnv: {
            OPENCLAW_TEST_PROJECTS_PARALLEL: "2",
            OPENCLAW_VITEST_INCLUDE_FILE: includeFile,
          },
        });

        expect(specs).toHaveLength(partition.length);
        expect(specs.map((spec) => spec.includePatterns)).toEqual(partition.map((file) => [file]));
        expect(new Set(specs.map((spec) => spec.env.OPENCLAW_VITEST_INCLUDE_FILE)).size).toBe(
          partition.length,
        );
        expect(specs.every((spec) => spec.env.OPENCLAW_VITEST_INCLUDE_FILE !== includeFile)).toBe(
          true,
        );
      }
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }

    expect(extensionJob.strategy["fail-fast"]).toBe(false);
    expect(extensionJob.strategy["max-parallel"]).toBe(12);
    expect(extensionJob["timeout-minutes"]).toBe(60);
    expect(extensionJob.strategy.matrix).toBe(
      "${{ fromJson(needs.preflight.outputs.plugin_prerelease_extension_matrix) }}",
    );
    expect(runStep?.env).toMatchObject({
      OPENCLAW_EXTENSION_INCLUDE_PATTERNS_JSON: "${{ toJson(matrix.includePatterns) }}",
      OPENCLAW_EXTENSION_TASK: "${{ matrix.task }}",
      OPENCLAW_EXTENSION_VITEST_CONFIG: "${{ matrix.vitest_config }}",
    });
    expect(runStep?.run).toContain("extension-file-shard)");
    expect(runStep?.run).toContain("OPENCLAW_TEST_PROJECTS_PARALLEL=2");
    expect(runStep?.run).toContain('OPENCLAW_VITEST_INCLUDE_FILE="$include_file"');
    expect(runStep?.run).toContain('pnpm test -- "$OPENCLAW_EXTENSION_VITEST_CONFIG"');
    const shellCheck = spawnSync("bash", ["-n"], {
      encoding: "utf8",
      input: runStep?.run,
    });
    expect(shellCheck.status, shellCheck.stderr).toBe(0);
    expect(runStep?.run?.match(/extension-file-shard\)([\s\S]*?)\n\s*;;/u)?.[1]).not.toContain(
      "--retry",
    );
    expect(suite.needs).toContain("plugin-prerelease-extension-shard");
    expect(
      suite.steps.find((step: WorkflowStep) => step.name === "Verify plugin prerelease suite").run,
    ).toContain(
      'check_required "plugin-prerelease-extensions" "$RUN_EXTENSIONS" "$EXTENSIONS_RESULT"',
    );
  });
});

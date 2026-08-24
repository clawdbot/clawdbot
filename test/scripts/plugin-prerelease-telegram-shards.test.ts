import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  DEFAULT_EXTENSION_TEST_SHARD_COUNT,
  createExtensionTestShards,
} from "../../scripts/lib/extension-test-plan.mts";

type WorkflowStep = {
  env?: Record<string, string>;
  name?: string;
  run?: string;
};

function readPluginPrereleaseWorkflow() {
  return parse(readFileSync(".github/workflows/plugin-prerelease.yml", "utf8"));
}

function runPluginPrereleaseManifest() {
  const workflow = readPluginPrereleaseWorkflow();
  const manifestStep = workflow.jobs.preflight.steps.find(
    (step: WorkflowStep) => step.name === "Build plugin prerelease manifest",
  );
  if (!manifestStep?.run) {
    throw new Error("Missing plugin prerelease manifest step");
  }

  const root = mkdtempSync(join(tmpdir(), "openclaw-plugin-prerelease-telegram-shards-"));
  const outputPath = join(root, "github-output");
  try {
    const result = spawnSync("bash", ["-c", manifestStep.run], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        EXPECTED_SHA: "",
        FULL_RELEASE_VALIDATION: "false",
        GITHUB_OUTPUT: outputPath,
      },
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
    return JSON.parse(output.get("plugin_prerelease_extension_matrix") ?? "{}");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

describe("plugin prerelease Telegram extension shards", () => {
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

  it("keeps native Telegram shards inside the existing aggregate job contract", () => {
    const workflow = readPluginPrereleaseWorkflow();
    const preflight = workflow.jobs.preflight;
    const manifestStep = preflight.steps.find(
      (step: WorkflowStep) => step.name === "Build plugin prerelease manifest",
    );
    const extensionJob = workflow.jobs["plugin-prerelease-extension-shard"];
    const runStep = extensionJob.steps.find(
      (step: WorkflowStep) => step.name === "Run extension shard",
    );
    const suite = workflow.jobs["plugin-prerelease-suite"];
    const matrix = runPluginPrereleaseManifest();
    const genericRows = matrix.include.filter(
      (row: Record<string, unknown>) => row.task === "extensions-batch",
    );
    const telegramRows = matrix.include.filter(
      (row: Record<string, unknown>) => row.task === "extension-file-shard",
    );

    expect(manifestStep?.run).toContain('extensionId !== "telegram"');
    expect(manifestStep?.run).toContain("const telegramShardCount = 2");
    expect(manifestStep?.run).toContain(
      "check_name: `checks-node-extensions-telegram-shard-${index + 1}`",
    );
    expect(manifestStep?.run).toContain("vitest_shard: `${index + 1}/${telegramShardCount}`");
    expect(manifestStep?.run).not.toContain("createExtensionTestFileShards");
    expect(genericRows).toHaveLength(DEFAULT_EXTENSION_TEST_SHARD_COUNT);
    expect(
      genericRows.some((row: Record<string, unknown>) =>
        String(row.extensions_csv).split(",").includes("telegram"),
      ),
    ).toBe(false);
    expect(telegramRows).toEqual([
      expect.objectContaining({
        check_name: "checks-node-extensions-telegram-shard-1",
        extensions_csv: "telegram",
        runner: "blacksmith-8vcpu-ubuntu-2404",
        vitest_config: "test/vitest/vitest.extension-telegram.config.ts",
        vitest_shard: "1/2",
      }),
      expect.objectContaining({
        check_name: "checks-node-extensions-telegram-shard-2",
        extensions_csv: "telegram",
        runner: "blacksmith-8vcpu-ubuntu-2404",
        vitest_config: "test/vitest/vitest.extension-telegram.config.ts",
        vitest_shard: "2/2",
      }),
    ]);
    expect(extensionJob.strategy["fail-fast"]).toBe(false);
    expect(extensionJob["timeout-minutes"]).toBe(60);
    expect(extensionJob.strategy.matrix).toBe(
      "${{ fromJson(needs.preflight.outputs.plugin_prerelease_extension_matrix) }}",
    );
    expect(runStep?.env).toMatchObject({
      OPENCLAW_EXTENSION_TASK: "${{ matrix.task }}",
      OPENCLAW_EXTENSION_VITEST_CONFIG: "${{ matrix.vitest_config }}",
      OPENCLAW_EXTENSION_VITEST_SHARD: "${{ matrix.vitest_shard }}",
    });
    expect(runStep?.run).toContain("extension-file-shard)");
    expect(runStep?.run).toContain("node scripts/run-vitest.mjs");
    expect(runStep?.run).toContain('--shard "$OPENCLAW_EXTENSION_VITEST_SHARD"');
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

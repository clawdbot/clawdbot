// Test Extension tests cover test extension script behavior.
/* oxlint-disable typescript/no-unnecessary-type-parameters -- explicit call-site result types keep mock tuple extraction precise. */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { bundledPluginFile, bundledPluginRoot } from "openclaw/plugin-sdk/test-fixtures";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  detectChangedExtensionIds,
  listAvailableExtensionIds,
  listChangedExtensionIds,
} from "../../scripts/lib/changed-extensions.mjs";
import {
  DEFAULT_EXTENSION_TEST_SHARD_COUNT,
  createExtensionTestProcessTargetChunks,
  createExtensionTestShards,
  listExtensionTestFilesForRoots,
  listTrackedTestFilesForRoots,
  resolveExtensionBatchPlan,
  resolveExtensionTestConfig,
  resolveExtensionTestPlan,
} from "../../scripts/lib/extension-test-plan.mjs";
import { relativizeExtensionVitestArgs } from "../../scripts/lib/extension-vitest-paths.mjs";
import type { VitestBatchRunParams } from "../../scripts/lib/vitest-batch-runner.mjs";
import { buildVitestBatchPnpmArgs } from "../../scripts/lib/vitest-batch-runner.mjs";
import {
  parseExtensionIds,
  parseExactVitestExcludePaths,
  resolveExtensionBatchParallelism,
  runExtensionBatchPlan,
} from "../../scripts/test-extension-batch.mjs";
import { expectNoNodeFsScans } from "../../src/test-utils/fs-scan-assertions.js";
import { extensionCatchAllExcludedTestRoots } from "../vitest/vitest.extensions.config.ts";

const scriptPath = path.join(process.cwd(), "scripts", "test-extension.mjs");
const posixIt = process.platform === "win32" ? it.skip : it;

type RunGroupParams = VitestBatchRunParams;

function createConcurrentExtensionBatchPlan() {
  const groups = [
    ["light", 10, "one", 1],
    ["heavy", 30, "two", 3],
    ["middle", 20, "three", 2],
  ] as const;
  return {
    extensionCount: groups.length,
    extensionIds: groups.map((group) => group[2]),
    estimatedCost: 60,
    hasTests: true,
    planGroups: groups.map(([config, estimatedCost, extensionId, testFileCount]) => ({
      config,
      estimatedCost,
      extensionIds: [extensionId],
      roots: [`extensions/${extensionId}`],
      testFileCount,
    })),
    testFileCount: 6,
  };
}

function runScriptResult(args: string[], cwd = process.cwd()) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    encoding: "utf8",
  });
}

function requireFirstMockArg<T>(mock: { mock: { calls: readonly (readonly unknown[])[] } }): T {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error("expected first mock call argument");
  }
  const [arg] = call;
  if (arg === undefined) {
    throw new Error("expected first mock call argument");
  }
  return arg as T;
}

function findExtensionWithoutTests() {
  const extensionId = listAvailableExtensionIds().find(
    (candidate) => !resolveExtensionTestPlan({ targetArg: candidate, cwd: process.cwd() }).hasTests,
  );

  if (!extensionId) {
    throw new Error("Expected at least one extension without tests");
  }
  return extensionId;
}

function listExtensionTestFiles(extensionId: string): string[] {
  return listTrackedTestFilesForRoots([bundledPluginRoot(extensionId)]);
}

function expectPositiveIntegerMetric(value: number) {
  expect(Number.isInteger(value)).toBe(true);
  expect(value).toBeGreaterThan(0);
}

describe("scripts/test-extension.mjs", () => {
  let balancedExtensionShards: ReturnType<typeof createExtensionTestShards>;
  let balancedExpectedExtensionIds: string[];

  beforeAll(() => {
    balancedExtensionShards = createExtensionTestShards({
      cwd: process.cwd(),
      shardCount: DEFAULT_EXTENSION_TEST_SHARD_COUNT,
    });
    balancedExpectedExtensionIds = listAvailableExtensionIds().filter(
      (extensionId) =>
        resolveExtensionTestPlan({ cwd: process.cwd(), targetArg: extensionId }).hasTests,
    );
  });

  it.each(extensionCatchAllExcludedTestRoots)(
    "routes catch-all-excluded extension root %s to a dedicated config",
    (root) => {
      expect(resolveExtensionTestConfig(root)).not.toBe("test/vitest/vitest.extensions.config.ts");
    },
  );

  it("resolves split channel extensions onto their own vitest configs", () => {
    const plan = resolveExtensionTestPlan({ targetArg: "slack", cwd: process.cwd() });

    expect(plan.extensionId).toBe("slack");
    expect(plan.extensionDir).toBe(bundledPluginRoot("slack"));
    expect(plan.config).toBe("test/vitest/vitest.extension-slack.config.ts");
    expect(plan.roots).toContain(bundledPluginRoot("slack"));
    expect(plan.hasTests).toBe(true);
  });

  it("resolves acpx onto the acpx vitest config", () => {
    const plan = resolveExtensionTestPlan({ targetArg: "acpx", cwd: process.cwd() });

    expect(plan.extensionId).toBe("acpx");
    expect(plan.config).toBe("test/vitest/vitest.extension-acpx.config.ts");
    expect(plan.roots).toContain(bundledPluginRoot("acpx"));
    expect(plan.hasTests).toBe(true);
  });

  it("resolves diffs onto the diffs vitest config", () => {
    const plan = resolveExtensionTestPlan({ targetArg: "diffs", cwd: process.cwd() });

    expect(plan.extensionId).toBe("diffs");
    expect(plan.config).toBe("test/vitest/vitest.extension-diffs.config.ts");
    expect(plan.roots).toContain(bundledPluginRoot("diffs"));
    expect(plan.hasTests).toBe(true);
  });

  it("resolves feishu onto the feishu vitest config", () => {
    const plan = resolveExtensionTestPlan({ targetArg: "feishu", cwd: process.cwd() });

    expect(plan.extensionId).toBe("feishu");
    expect(plan.config).toBe("test/vitest/vitest.extension-feishu.config.ts");
    expect(plan.roots).toContain(bundledPluginRoot("feishu"));
    expect(plan.hasTests).toBe(true);
  });

  it("resolves OpenAI onto its own provider vitest config", () => {
    const plan = resolveExtensionTestPlan({ targetArg: "openai", cwd: process.cwd() });

    expect(plan.extensionId).toBe("openai");
    expect(plan.config).toBe("test/vitest/vitest.extension-provider-openai.config.ts");
    expect(plan.roots).toContain(bundledPluginRoot("openai"));
    expect(plan.hasTests).toBe(true);
  });

  it("resolves matrix onto the matrix vitest config", () => {
    const plan = resolveExtensionTestPlan({ targetArg: "matrix", cwd: process.cwd() });

    expect(plan.extensionId).toBe("matrix");
    expect(plan.config).toBe("test/vitest/vitest.extension-matrix.config.ts");
    expect(plan.roots).toContain(bundledPluginRoot("matrix"));
    expect(plan.hasTests).toBe(true);
  });

  it("bounds Matrix test files across balanced process lifetimes", () => {
    const config = "test/vitest/vitest.extension-matrix.config.ts";
    const roots = [bundledPluginRoot("matrix")];
    const expectedFiles = listExtensionTestFilesForRoots(roots);
    const chunks = createExtensionTestProcessTargetChunks(config, roots);

    expect(chunks).toHaveLength(3);
    expect(chunks.every((chunk) => chunk.length <= 40)).toBe(true);
    expect(Math.max(...chunks.map((chunk) => chunk.length))).toBeLessThanOrEqual(
      Math.min(...chunks.map((chunk) => chunk.length)) + 1,
    );
    expect(chunks.flat()).toEqual(expectedFiles);
    expect(new Set(chunks.flat()).size).toBe(expectedFiles.length);
  });

  it("includes newly authored Matrix tests in bounded process targets", () => {
    const root = mkdtempSync(path.join(process.cwd(), "extensions", ".extension-test-plan-"));
    const relativeRoot = path.relative(process.cwd(), root);
    const testFile = path.join(root, "newly-authored.test.ts");
    writeFileSync(testFile, "export {};\n");
    try {
      const chunks = createExtensionTestProcessTargetChunks(
        "test/vitest/vitest.extension-matrix.config.ts",
        [relativeRoot],
      );

      expect(chunks.flat()).toEqual([
        path.relative(process.cwd(), testFile).split(path.sep).join("/"),
      ]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it.each([
    ["watch", ["--watch"]],
    ["short watch", ["-w"]],
    ["coverage", ["--coverage"]],
    ["reporter", ["--reporter=json"]],
    ["output file", ["--outputFile=results.json"]],
    ["shard", ["--shard=1/2"]],
    ["bail", ["--bail=2"]],
    ["changed", ["--changed=origin/main"]],
    ["exclude", ["--exclude=extensions/matrix/src/**"]],
    ["retry", ["--retry=1"]],
  ])("keeps Matrix %s runs in one process", (_name, vitestArgs) => {
    const root = bundledPluginRoot("matrix");

    expect(
      createExtensionTestProcessTargetChunks(
        "test/vitest/vitest.extension-matrix.config.ts",
        [root],
        vitestArgs,
      ),
    ).toEqual([[root]]);
  });

  it("resolves telegram onto the telegram vitest config", () => {
    const plan = resolveExtensionTestPlan({ targetArg: "telegram", cwd: process.cwd() });

    expect(plan.extensionId).toBe("telegram");
    expect(plan.config).toBe("test/vitest/vitest.extension-telegram.config.ts");
    expect(plan.roots).toContain(bundledPluginRoot("telegram"));
    expect(plan.hasTests).toBe(true);
  });

  it("resolves whatsapp onto the whatsapp vitest config", () => {
    const plan = resolveExtensionTestPlan({ targetArg: "whatsapp", cwd: process.cwd() });

    expect(plan.extensionId).toBe("whatsapp");
    expect(plan.config).toBe("test/vitest/vitest.extension-whatsapp.config.ts");
    expect(plan.roots).toContain(bundledPluginRoot("whatsapp"));
    expect(plan.hasTests).toBe(true);
  });

  it("resolves voice-call onto the voice-call vitest config", () => {
    const plan = resolveExtensionTestPlan({ targetArg: "voice-call", cwd: process.cwd() });

    expect(plan.extensionId).toBe("voice-call");
    expect(plan.config).toBe("test/vitest/vitest.extension-voice-call.config.ts");
    expect(plan.roots).toContain(bundledPluginRoot("voice-call"));
    expect(plan.hasTests).toBe(true);
  });

  it("resolves mattermost onto the mattermost vitest config", () => {
    const plan = resolveExtensionTestPlan({ targetArg: "mattermost", cwd: process.cwd() });

    expect(plan.extensionId).toBe("mattermost");
    expect(plan.config).toBe("test/vitest/vitest.extension-mattermost.config.ts");
    expect(plan.roots).toContain(bundledPluginRoot("mattermost"));
    expect(plan.hasTests).toBe(true);
  });

  it("resolves irc onto the irc vitest config", () => {
    const plan = resolveExtensionTestPlan({ targetArg: "irc", cwd: process.cwd() });

    expect(plan.extensionId).toBe("irc");
    expect(plan.config).toBe("test/vitest/vitest.extension-irc.config.ts");
    expect(plan.roots).toContain(bundledPluginRoot("irc"));
    expect(plan.hasTests).toBe(true);
  });

  it("resolves zalo onto the zalo vitest config", () => {
    const plan = resolveExtensionTestPlan({ targetArg: "zalo", cwd: process.cwd() });

    expect(plan.extensionId).toBe("zalo");
    expect(plan.config).toBe("test/vitest/vitest.extension-zalo.config.ts");
    expect(plan.roots).toContain(bundledPluginRoot("zalo"));
    expect(plan.hasTests).toBe(true);
  });

  it("resolves memory extensions onto the memory vitest config", () => {
    const plan = resolveExtensionTestPlan({ targetArg: "memory-core", cwd: process.cwd() });

    expect(plan.extensionId).toBe("memory-core");
    expect(plan.config).toBe("test/vitest/vitest.extension-memory.config.ts");
    expect(plan.roots).toContain(bundledPluginRoot("memory-core"));
    expect(plan.hasTests).toBe(true);
  });

  it("resolves msteams onto the msteams vitest config", () => {
    const plan = resolveExtensionTestPlan({ targetArg: "msteams", cwd: process.cwd() });

    expect(plan.extensionId).toBe("msteams");
    expect(plan.config).toBe("test/vitest/vitest.extension-msteams.config.ts");
    expect(plan.roots).toContain(bundledPluginRoot("msteams"));
    expect(plan.hasTests).toBe(true);
  });

  it("resolves broad dedicated extension groups onto their narrow vitest configs", () => {
    expect(resolveExtensionTestPlan({ targetArg: "browser", cwd: process.cwd() }).config).toBe(
      "test/vitest/vitest.extension-browser.config.ts",
    );
    expect(resolveExtensionTestPlan({ targetArg: "qa-lab", cwd: process.cwd() }).config).toBe(
      "test/vitest/vitest.extension-qa.config.ts",
    );
    expect(resolveExtensionTestPlan({ targetArg: "vydra", cwd: process.cwd() }).config).toBe(
      "test/vitest/vitest.extension-media.config.ts",
    );
    expect(resolveExtensionTestPlan({ targetArg: "firecrawl", cwd: process.cwd() }).config).toBe(
      "test/vitest/vitest.extension-misc.config.ts",
    );
  });

  it("resolves codex onto the codex vitest config", () => {
    const plan = resolveExtensionTestPlan({ targetArg: "codex", cwd: process.cwd() });

    expect(plan.extensionId).toBe("codex");
    expect(plan.config).toBe("test/vitest/vitest.extension-codex.config.ts");
    expect(plan.roots).toContain(bundledPluginRoot("codex"));
    expect(plan.hasTests).toBe(true);
  });

  it("omits src/<extension> when no paired core root exists", () => {
    const plan = resolveExtensionTestPlan({ targetArg: "line", cwd: process.cwd() });

    expect(plan.roots).toContain(bundledPluginRoot("line"));
    expect(plan.roots).not.toContain("src/line");
    expect(plan.config).toBe("test/vitest/vitest.extension-line.config.ts");
    expect(plan.hasTests).toBe(true);
  });

  it("infers the extension from the current working directory", () => {
    const cwd = path.join(process.cwd(), "extensions", "slack");
    const plan = resolveExtensionTestPlan({ cwd });

    expect(plan.extensionId).toBe("slack");
    expect(plan.extensionDir).toBe(bundledPluginRoot("slack"));
  });

  it("maps changed paths back to extension ids", () => {
    const extensionIds = detectChangedExtensionIds([
      bundledPluginFile("slack", "src/channel.ts"),
      "src/line/message.test.ts",
      bundledPluginFile("firecrawl", "package.json"),
      "src/not-a-plugin/file.ts",
    ]);

    expect(extensionIds).toEqual(["firecrawl", "line", "slack"]);
  });

  it("lists available extension ids", () => {
    const extensionIds = listAvailableExtensionIds();

    expect(extensionIds).toContain("slack");
    expect(extensionIds).toContain("firecrawl");
    expect(extensionIds).toEqual(
      [...extensionIds].toSorted((left, right) => left.localeCompare(right)),
    );
  });

  it("lists available extension ids from git without reading extension directories", () => {
    const payload = expectNoNodeFsScans<{
      changed: string[];
      ids: number;
    }>(`
      const { detectChangedExtensionIds, listAvailableExtensionIds } =
        await import("./scripts/lib/changed-extensions.mjs");
      const ids = listAvailableExtensionIds();
      const changed = detectChangedExtensionIds([
        "extensions/slack/src/channel.ts",
        "src/line/message.test.ts",
        "extensions/not-real/package.json",
      ]);
      return { changed, ids: ids.length };
    `);
    expect(payload.changed).toEqual(["line", "slack"]);
    expect(payload.ids).toBeGreaterThan(0);
  });

  it("can fail safe to all extensions when the base revision is unavailable", () => {
    const extensionIds = listChangedExtensionIds({
      base: "refs/heads/openclaw-test-missing-base",
      unavailableBaseBehavior: "all",
    });

    expect(extensionIds).toEqual(listAvailableExtensionIds());
  });

  it("resolves a plan for extensions without tests", () => {
    const extensionId = findExtensionWithoutTests();
    const plan = resolveExtensionTestPlan({ cwd: process.cwd(), targetArg: extensionId });

    expect(plan.extensionId).toBe(extensionId);
    expect(plan.hasTests).toBe(false);
    expect(plan.testFileCount).toBe(0);
  });

  it("batches extensions into config-specific vitest invocations", () => {
    const batch = resolveExtensionBatchPlan({
      cwd: process.cwd(),
      extensionIds: [
        "slack",
        "firecrawl",
        "line",
        "openai",
        "matrix",
        "telegram",
        "mattermost",
        "voice-call",
        "whatsapp",
        "zalo",
        "zalouser",
        "memory-core",
        "msteams",
        "feishu",
        "irc",
        "acpx",
        "diffs",
        "browser",
        "qa-lab",
        "vydra",
      ],
    });

    expect(batch.extensionIds).toEqual([
      "acpx",
      "browser",
      "diffs",
      "feishu",
      "firecrawl",
      "irc",
      "line",
      "matrix",
      "mattermost",
      "memory-core",
      "msteams",
      "openai",
      "qa-lab",
      "slack",
      "telegram",
      "voice-call",
      "vydra",
      "whatsapp",
      "zalo",
      "zalouser",
    ]);
    const stablePlanGroups = batch.planGroups.map(({ estimatedCost, testFileCount, ...group }) => {
      expectPositiveIntegerMetric(estimatedCost);
      expectPositiveIntegerMetric(testFileCount);
      return group;
    });

    expect(stablePlanGroups).toEqual([
      {
        config: "test/vitest/vitest.extension-acpx.config.ts",
        extensionIds: ["acpx"],
        roots: [bundledPluginRoot("acpx")],
      },
      {
        config: "test/vitest/vitest.extension-browser.config.ts",
        extensionIds: ["browser"],
        roots: [bundledPluginRoot("browser")],
      },
      {
        config: "test/vitest/vitest.extension-diffs.config.ts",
        extensionIds: ["diffs"],
        roots: [bundledPluginRoot("diffs")],
      },
      {
        config: "test/vitest/vitest.extension-feishu.config.ts",
        extensionIds: ["feishu"],
        roots: [bundledPluginRoot("feishu")],
      },
      {
        config: "test/vitest/vitest.extension-irc.config.ts",
        extensionIds: ["irc"],
        roots: [bundledPluginRoot("irc")],
      },
      {
        config: "test/vitest/vitest.extension-line.config.ts",
        extensionIds: ["line"],
        roots: [bundledPluginRoot("line")],
      },
      {
        config: "test/vitest/vitest.extension-matrix.config.ts",
        extensionIds: ["matrix"],
        roots: [bundledPluginRoot("matrix")],
      },
      {
        config: "test/vitest/vitest.extension-mattermost.config.ts",
        extensionIds: ["mattermost"],
        roots: [bundledPluginRoot("mattermost")],
      },
      {
        config: "test/vitest/vitest.extension-media.config.ts",
        extensionIds: ["vydra"],
        roots: [bundledPluginRoot("vydra")],
      },
      {
        config: "test/vitest/vitest.extension-memory.config.ts",
        extensionIds: ["memory-core"],
        roots: [bundledPluginRoot("memory-core")],
      },
      {
        config: "test/vitest/vitest.extension-misc.config.ts",
        extensionIds: ["firecrawl"],
        roots: [bundledPluginRoot("firecrawl")],
      },
      {
        config: "test/vitest/vitest.extension-msteams.config.ts",
        extensionIds: ["msteams"],
        roots: [bundledPluginRoot("msteams")],
      },
      {
        config: "test/vitest/vitest.extension-provider-openai.config.ts",
        extensionIds: ["openai"],
        roots: [bundledPluginRoot("openai")],
      },
      {
        config: "test/vitest/vitest.extension-qa.config.ts",
        extensionIds: ["qa-lab"],
        roots: [bundledPluginRoot("qa-lab")],
      },
      {
        config: "test/vitest/vitest.extension-slack.config.ts",
        extensionIds: ["slack"],
        roots: [bundledPluginRoot("slack")],
      },
      {
        config: "test/vitest/vitest.extension-telegram.config.ts",
        extensionIds: ["telegram"],
        roots: [bundledPluginRoot("telegram")],
      },
      {
        config: "test/vitest/vitest.extension-voice-call.config.ts",
        extensionIds: ["voice-call"],
        roots: [bundledPluginRoot("voice-call")],
      },
      {
        config: "test/vitest/vitest.extension-whatsapp.config.ts",
        extensionIds: ["whatsapp"],
        roots: [bundledPluginRoot("whatsapp")],
      },
      {
        config: "test/vitest/vitest.extension-zalo.config.ts",
        extensionIds: ["zalo", "zalouser"],
        roots: [bundledPluginRoot("zalo"), bundledPluginRoot("zalouser")],
      },
    ]);
  });

  it("keeps explicitly requested extensions without tests in batch plans", () => {
    const extensionId = findExtensionWithoutTests();
    const testedExtensionId = "firecrawl";
    const testedExtensionFiles = listExtensionTestFiles(testedExtensionId);
    const batch = resolveExtensionBatchPlan({
      cwd: process.cwd(),
      extensionIds: [extensionId, testedExtensionId],
    });

    expect(batch.extensionIds).toEqual(
      [extensionId, testedExtensionId].toSorted((left, right) => left.localeCompare(right)),
    );
    expect(batch.extensionCount).toBe(2);
    expect(batch.noTestExtensionIds).toEqual([extensionId]);
    expect(batch.hasTests).toBe(true);
    expect(batch.testFileCount).toBe(testedExtensionFiles.length);
    expect(batch.planGroups.flatMap((group) => group.extensionIds)).toEqual([testedExtensionId]);
  });

  it("counts tracked extension tests without walking extension directories", () => {
    const payload = expectNoNodeFsScans<{
      batchTests: number;
      shards: number;
      shardTests: number;
    }>(
      `
        const { createExtensionTestShards, resolveExtensionBatchPlan } =
          await import("./scripts/lib/extension-test-plan.mjs");
        const extensionIds = ["matrix", "openai", "slack", "telegram"];
        const batch = resolveExtensionBatchPlan({ cwd: process.cwd(), extensionIds });
        const shards = createExtensionTestShards({ cwd: process.cwd(), extensionIds, shardCount: 2 });
        return {
          batchTests: batch.testFileCount,
          shards: shards.length,
          shardTests: shards.reduce((total, shard) => total + shard.testFileCount, 0),
        };
      `,
      { counters: ["readdirSync"] },
    );
    expect(payload.batchTests).toBeGreaterThan(0);
    expect(payload.shards).toBe(2);
    expect(payload.shardTests).toBe(payload.batchTests);
  });

  it("balances extension test shards by estimated CI cost", () => {
    const shards = balancedExtensionShards;

    expect(shards).toHaveLength(DEFAULT_EXTENSION_TEST_SHARD_COUNT);
    expect(shards.map((shard) => shard.checkName)).toEqual(
      shards.map((_shard, index) => `checks-node-extensions-shard-${index + 1}`),
    );

    const assigned = shards.flatMap((shard) => shard.extensionIds);
    const uniqueAssigned = [...new Set(assigned)];

    expect(uniqueAssigned.toSorted((left, right) => left.localeCompare(right))).toEqual(
      balancedExpectedExtensionIds.toSorted((left, right) => left.localeCompare(right)),
    );
    expect(assigned).toHaveLength(balancedExpectedExtensionIds.length);

    const totals = shards.map((shard) => shard.estimatedCost);
    expect(Math.max(...totals) - Math.min(...totals)).toBeLessThanOrEqual(1);

    for (const shard of shards) {
      expect(shard.extensionIds.length).toBeGreaterThan(0);
    }
  });

  it("rejects malformed extension shard counts", () => {
    expect(() =>
      createExtensionTestShards({
        cwd: process.cwd(),
        extensionIds: ["matrix", "openai"],
        shardCount: "2x",
      }),
    ).toThrow("shardCount must be a positive integer");
  });

  it("runs extension batch config groups concurrently when requested", async () => {
    const started: string[] = [];
    const resolvers: Array<() => void> = [];
    const runGroup = vi.fn((params: RunGroupParams) => {
      started.push(params.config);
      return new Promise<number>((resolve) => {
        resolvers.push(() => resolve(0));
      });
    });
    const runPromise = runExtensionBatchPlan(createConcurrentExtensionBatchPlan(), {
      env: { OPENCLAW_EXTENSION_BATCH_PARALLEL: "2" },
      runGroup: runGroup as NonNullable<
        NonNullable<Parameters<typeof runExtensionBatchPlan>[1]>["runGroup"]
      >,
      vitestArgs: ["--reporter=dot"],
    });

    await vi.waitFor(() => {
      expect(started).toEqual(["heavy", "middle"]);
    });
    resolvers.shift()?.();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(started).toEqual(["heavy", "middle", "light"]);
    while (resolvers.length > 0) {
      resolvers.shift()?.();
    }
    await expect(runPromise).resolves.toBe(0);
    expect(runGroup).toHaveBeenCalledTimes(3);
    const firstRunGroupParams = requireFirstMockArg<RunGroupParams>(runGroup);
    expect(firstRunGroupParams).toEqual({
      args: ["--reporter=dot"],
      config: "heavy",
      env: {
        OPENCLAW_EXTENSION_BATCH_PARALLEL: "2",
        OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: path.join(
          process.cwd(),
          "node_modules",
          ".experimental-vitest-cache",
          "extension-batch",
          "0-heavy",
        ),
      },
      targets: ["two"],
    });
  });

  it("stops admitting extension batch groups after a parallel failure", async () => {
    const started: string[] = [];
    let resolveHeavy: ((code: number) => void) | undefined;
    let resolveMiddle: ((code: number) => void) | undefined;
    const runGroup = vi.fn((params: RunGroupParams) => {
      started.push(params.config);
      return new Promise<number>((resolve) => {
        if (params.config === "heavy") {
          resolveHeavy = resolve;
        } else if (params.config === "middle") {
          resolveMiddle = resolve;
        }
      });
    });
    const runPromise = runExtensionBatchPlan(createConcurrentExtensionBatchPlan(), {
      env: { OPENCLAW_EXTENSION_BATCH_PARALLEL: "2" },
      runGroup: runGroup as NonNullable<
        NonNullable<Parameters<typeof runExtensionBatchPlan>[1]>["runGroup"]
      >,
    });

    await vi.waitFor(() => {
      expect(started).toEqual(["heavy", "middle"]);
    });
    resolveHeavy?.(7);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(started).toEqual(["heavy", "middle"]);
    resolveMiddle?.(0);
    await expect(runPromise).resolves.toBe(7);
    expect(runGroup).toHaveBeenCalledTimes(2);
  });

  it("keeps extension batch parallelism bounded by group count", () => {
    expect(resolveExtensionBatchParallelism(3, { OPENCLAW_EXTENSION_BATCH_PARALLEL: "2" })).toBe(2);
    expect(resolveExtensionBatchParallelism(1, { OPENCLAW_EXTENSION_BATCH_PARALLEL: "4" })).toBe(1);
    expect(resolveExtensionBatchParallelism(3, {})).toBe(1);
  });

  it("rejects malformed extension batch parallelism", () => {
    for (const value of ["nope", "2x", "0"]) {
      expect(() =>
        resolveExtensionBatchParallelism(3, { OPENCLAW_EXTENSION_BATCH_PARALLEL: value }),
      ).toThrow("OPENCLAW_EXTENSION_BATCH_PARALLEL must be a positive integer");
    }
  });

  it("preserves positional Vitest args after the extension batch separator", () => {
    expect(
      parseExtensionIds([
        "telegram",
        "--coverage",
        "--",
        "extensions/telegram/src/index.test.ts",
        "--run",
      ]),
    ).toEqual({
      extensionIds: ["telegram"],
      passthroughArgs: ["--coverage", "extensions/telegram/src/index.test.ts", "--run"],
    });
  });

  it("places Vitest passthrough options before batch target roots", () => {
    expect(
      buildVitestBatchPnpmArgs({
        args: ["--exclude", "codex/src/app-server/run-attempt.test.ts"],
        config: "test/vitest/vitest.extensions.config.ts",
        targets: ["codex"],
      }),
    ).toEqual([
      "exec",
      "vitest",
      "run",
      "--config",
      "test/vitest/vitest.extensions.config.ts",
      "--exclude",
      "codex/src/app-server/run-attempt.test.ts",
      "codex",
    ]);
  });

  it("relativizes extension Vitest path args to the scoped extensions dir", () => {
    expect(
      relativizeExtensionVitestArgs([
        "--exclude",
        "extensions/codex/src/app-server/run-attempt.test.ts",
        "--outputFile",
        "extensions/codex/report.json",
        "-c",
        "./vitest.local.ts",
        "-r",
        ".",
        "--exclude=extensions/codex/src/app-server/client.test.ts",
        "extensions/codex/src/app-server/models.test.ts",
        "--reporter=dot",
      ]),
    ).toEqual([
      "--exclude",
      "codex/src/app-server/run-attempt.test.ts",
      "--outputFile",
      "extensions/codex/report.json",
      "-c",
      "./vitest.local.ts",
      "-r",
      ".",
      "--exclude=codex/src/app-server/client.test.ts",
      "codex/src/app-server/models.test.ts",
      "--reporter=dot",
    ]);
  });

  posixIt("relativizes single-extension Vitest paths from extension cwd", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-test-extension-args-"));
    const fakePnpmPath = path.join(root, "pnpm");
    const argsPath = path.join(root, "args.json");
    const extensionCwd = path.join(process.cwd(), "extensions", "codex");

    writeFakePnpm(fakePnpmPath);
    try {
      const result = spawnSync(
        process.execPath,
        [
          scriptPath,
          "codex",
          "--exclude",
          path.join(extensionCwd, "src", "app-server", "run-attempt.test.ts"),
          path.join(extensionCwd, "src", "app-server", "client.test.ts"),
        ],
        {
          cwd: extensionCwd,
          encoding: "utf8",
          env: {
            ...process.env,
            OPENCLAW_FAKE_PNPM_ARGS_PATH: argsPath,
            npm_execpath: fakePnpmPath,
          },
        },
      );

      expect(result.status).toBe(0);
      expect(JSON.parse(readFileSync(argsPath, "utf8"))).toEqual([
        "exec",
        "vitest",
        "run",
        "--config",
        "test/vitest/vitest.extension-codex.config.ts",
        "--exclude",
        "codex/src/app-server/run-attempt.test.ts",
        "codex/src/app-server/client.test.ts",
        "codex",
      ]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  posixIt("runs every single-extension Matrix chunk after an earlier chunk fails", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-test-extension-chunks-"));
    const fakePnpmPath = path.join(root, "pnpm");
    const countPath = path.join(root, "count");

    writeFakePnpm(fakePnpmPath);
    try {
      const result = spawnSync(process.execPath, [scriptPath, "matrix"], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_FAKE_PNPM_CALL_COUNT_PATH: countPath,
          OPENCLAW_FAKE_PNPM_EXIT_CODES: "1,0,0",
          npm_execpath: fakePnpmPath,
        },
      });

      expect(result.status).toBe(1);
      expect(readFileSync(countPath, "utf8")).toBe("3");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  posixIt(
    "preserves wrapper termination when the pnpm child exits cleanly after SIGTERM",
    async () => {
      const root = mkdtempSync(path.join(tmpdir(), "openclaw-test-extension-signal-"));
      const fakePnpmPath = path.join(root, "pnpm");
      const childPidPath = path.join(root, "child.pid");
      const descendantPidPath = path.join(root, "descendant.pid");
      const signaledPath = path.join(root, "signaled");

      writeFakePnpm(fakePnpmPath);
      const runner = spawn(process.execPath, [scriptPath, "firecrawl"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          OPENCLAW_FAKE_PNPM_DESCENDANT_PID_PATH: descendantPidPath,
          OPENCLAW_FAKE_PNPM_PID_PATH: childPidPath,
          OPENCLAW_FAKE_PNPM_SIGNALED_PATH: signaledPath,
          npm_execpath: fakePnpmPath,
        },
        stdio: "ignore",
      });
      let childPid = 0;
      let descendantPid = 0;

      try {
        await waitFor(() => fileExists(childPidPath), 5_000);
        await waitFor(() => fileExists(descendantPidPath), 5_000);
        childPid = Number(readFileSync(childPidPath, "utf8"));
        descendantPid = Number(readFileSync(descendantPidPath, "utf8"));
        expect(Number.isInteger(childPid)).toBe(true);
        expect(Number.isInteger(descendantPid)).toBe(true);

        expect(runner.pid).toBeGreaterThan(0);
        process.kill(runner.pid!, "SIGTERM");
        const result = await waitForClose(runner);

        expect(result).toEqual({ code: null, signal: "SIGTERM" });
        await waitFor(() => fileExists(signaledPath), 5_000);
        expect(readFileSync(signaledPath, "utf8")).toBe("SIGTERM");
        await waitFor(() => !isProcessAlive(childPid), 5_000);
        await waitFor(() => !isProcessAlive(descendantPid), 5_000);
      } finally {
        if (runner.pid && isProcessAlive(runner.pid)) {
          process.kill(runner.pid, "SIGKILL");
        }
        if (childPid && isProcessAlive(childPid)) {
          process.kill(childPid, "SIGKILL");
        }
        if (descendantPid && isProcessAlive(descendantPid)) {
          process.kill(descendantPid, "SIGKILL");
        }
        rmSync(root, { force: true, recursive: true });
      }
    },
  );

  it("expands extension batch roots before applying exact Vitest excludes", async () => {
    const runGroup = vi.fn<() => Promise<number>>().mockResolvedValue(0);
    await runExtensionBatchPlan(
      {
        extensionCount: 1,
        extensionIds: ["codex"],
        estimatedCost: 1,
        hasTests: true,
        planGroups: [
          {
            config: "test/vitest/vitest.extensions.config.ts",
            estimatedCost: 1,
            extensionIds: ["codex"],
            roots: [bundledPluginRoot("codex")],
            testFileCount: 1,
          },
        ],
        testFileCount: 1,
      },
      {
        runGroup,
        vitestArgs: ["--exclude", "extensions/codex/src/app-server/run-attempt.test.ts"],
      },
    );

    const runParams = requireFirstMockArg<RunGroupParams>(runGroup);
    expect(runParams.targets).not.toContain("extensions/codex/src/app-server/run-attempt.test.ts");
    expect(runParams.targets).not.toContain("codex/src/app-server/run-attempt.test.ts");
    expect(runParams.targets).toContain("codex/src/app-server/client.test.ts");
  });

  it("runs Matrix extension batches in bounded sequential processes", async () => {
    const runGroup = vi.fn<(params: RunGroupParams) => Promise<number>>().mockResolvedValue(0);
    const expectedFiles = listExtensionTestFilesForRoots([bundledPluginRoot("matrix")]).map(
      (file) => file.replace(/^extensions\//u, ""),
    );

    const result = await runExtensionBatchPlan(
      resolveExtensionBatchPlan({ cwd: process.cwd(), extensionIds: ["matrix"] }),
      { runGroup },
    );

    expect(result).toBe(0);
    expect(runGroup).toHaveBeenCalledTimes(3);
    const calls = runGroup.mock.calls.map(([params]) => params as RunGroupParams);
    expect(calls.every((call) => call.targets.length <= 40)).toBe(true);
    expect(calls.flatMap((call) => call.targets)).toEqual(expectedFiles);
  });

  it("runs every Matrix process chunk after an earlier chunk fails", async () => {
    const runGroup = vi
      .fn<(params: RunGroupParams) => Promise<number>>()
      .mockResolvedValueOnce(1)
      .mockResolvedValue(0);

    const result = await runExtensionBatchPlan(
      resolveExtensionBatchPlan({ cwd: process.cwd(), extensionIds: ["matrix"] }),
      { runGroup },
    );

    expect(result).toBe(1);
    expect(runGroup).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["--watch"],
    ["--coverage"],
    ["--reporter=json"],
    ["--outputFile=results.json"],
    ["--bail=2"],
    ["--changed=origin/main"],
    ["--exclude=extensions/matrix/src/**"],
    ["--retry=1"],
  ])("keeps Matrix extension batch mode %s in one process", async (vitestArg) => {
    const runGroup = vi.fn<() => Promise<number>>().mockResolvedValue(0);

    const result = await runExtensionBatchPlan(
      resolveExtensionBatchPlan({ cwd: process.cwd(), extensionIds: ["matrix"] }),
      { runGroup, vitestArgs: [vitestArg] },
    );

    expect(result).toBe(0);
    expect(runGroup).toHaveBeenCalledOnce();
    expect(requireFirstMockArg<RunGroupParams>(runGroup).targets).toEqual(["matrix"]);
  });

  it("fails extension batch groups when exact excludes remove every test", async () => {
    const runGroup = vi.fn<() => Promise<number>>().mockResolvedValue(0);
    const firecrawlTestFiles = listExtensionTestFiles("firecrawl");
    const result = await runExtensionBatchPlan(
      resolveExtensionBatchPlan({ cwd: process.cwd(), extensionIds: ["firecrawl"] }),
      {
        runGroup,
        vitestArgs: firecrawlTestFiles.flatMap((testFile) => ["--exclude", testFile]),
      },
    );

    expect(result).toBe(1);
    expect(runGroup).not.toHaveBeenCalled();
  });

  it("fails extension batch groups when dir-relative exact excludes remove every test", async () => {
    const runGroup = vi.fn<() => Promise<number>>().mockResolvedValue(0);
    const firecrawlTestFiles = listExtensionTestFiles("firecrawl");
    const result = await runExtensionBatchPlan(
      resolveExtensionBatchPlan({ cwd: process.cwd(), extensionIds: ["firecrawl"] }),
      {
        runGroup,
        vitestArgs: firecrawlTestFiles.flatMap((testFile) => [
          "--exclude",
          testFile.replace(/^extensions\//u, ""),
        ]),
      },
    );

    expect(result).toBe(1);
    expect(runGroup).not.toHaveBeenCalled();
  });

  it("allows extension batch groups to opt into empty exact excludes", async () => {
    const runGroup = vi.fn<() => Promise<number>>().mockResolvedValue(0);
    const firecrawlTestFiles = listExtensionTestFiles("firecrawl");
    const result = await runExtensionBatchPlan(
      resolveExtensionBatchPlan({ cwd: process.cwd(), extensionIds: ["firecrawl"] }),
      {
        allowEmptyAfterExclude: true,
        runGroup,
        vitestArgs: firecrawlTestFiles.flatMap((testFile) => ["--exclude", testFile]),
      },
    );

    expect(result).toBe(0);
    expect(runGroup).not.toHaveBeenCalled();
  });

  it("detects exact Vitest excludes in extension batch args", () => {
    expect([
      ...parseExactVitestExcludePaths([
        "--exclude",
        "extensions/codex/src/app-server/run-attempt.test.ts",
      ]),
    ]).toEqual(["extensions/codex/src/app-server/run-attempt.test.ts"]);
    expect([...parseExactVitestExcludePaths(["--exclude=extensions/**/*.test.ts"])]).toEqual([]);
  });

  it("accepts pnpm's leading argument separator before extension ids", () => {
    expect(parseExtensionIds(["--", "telegram,slack", "--run"])).toEqual({
      extensionIds: ["telegram", "slack"],
      passthroughArgs: ["--run"],
    });
  });

  it("fails explicitly requested extensions without tests by default", () => {
    const extensionId = findExtensionWithoutTests();
    const result = runScriptResult([extensionId]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`No tests found for ${bundledPluginRoot(extensionId)}.`);
  });

  it("allows explicitly requested extensions without tests when requested", () => {
    const extensionId = findExtensionWithoutTests();
    const result = runScriptResult([extensionId, "--allow-no-tests"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(`No tests found for ${bundledPluginRoot(extensionId)}.`);
  });
});

function writeFakePnpm(filePath: string): void {
  writeFileSync(
    filePath,
    [
      "#!/usr/bin/env node",
      'const { spawn } = require("node:child_process");',
      'const fs = require("node:fs");',
      "if (process.env.OPENCLAW_FAKE_PNPM_EXIT_CODES) {",
      "  const countPath = process.env.OPENCLAW_FAKE_PNPM_CALL_COUNT_PATH;",
      "  const count = fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, 'utf8')) : 0;",
      "  const exitCodes = process.env.OPENCLAW_FAKE_PNPM_EXIT_CODES.split(',').map(Number);",
      "  fs.writeFileSync(countPath, String(count + 1));",
      "  process.exit(exitCodes[count] || 0);",
      "}",
      "if (process.env.OPENCLAW_FAKE_PNPM_ARGS_PATH) {",
      "  fs.writeFileSync(process.env.OPENCLAW_FAKE_PNPM_ARGS_PATH, JSON.stringify(process.argv.slice(2)));",
      "  process.exit(0);",
      "}",
      'process.on("SIGTERM", () => {',
      '  fs.writeFileSync(process.env.OPENCLAW_FAKE_PNPM_SIGNALED_PATH, "SIGTERM");',
      "  process.exit(0);",
      "});",
      "if (process.env.OPENCLAW_FAKE_PNPM_DESCENDANT_PID_PATH) {",
      "  const child = spawn(process.execPath, [",
      '    "-e",',
      "    \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\",",
      "  ], { stdio: 'ignore' });",
      "  fs.writeFileSync(process.env.OPENCLAW_FAKE_PNPM_DESCENDANT_PID_PATH, String(child.pid));",
      "}",
      "// Publishing the PID marks the fixture ready for SIGTERM delivery.",
      "fs.writeFileSync(process.env.OPENCLAW_FAKE_PNPM_PID_PATH, String(process.pid));",
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"),
  );
  chmodSync(filePath, 0o755);
}

async function waitFor(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await delay(5);
  }
}

async function waitForClose(
  child: ReturnType<typeof spawn>,
  timeoutMs = 5_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return await Promise.race([
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("close", (code, signal) => resolve({ code, signal }));
    }),
    delay(timeoutMs, undefined, { ref: false }).then(() => {
      throw new Error("timed out waiting for child close");
    }),
  ]);
}

function fileExists(filePath: string): boolean {
  try {
    readFileSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

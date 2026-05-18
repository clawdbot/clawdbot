import { execFileSync } from "node:child_process";
import path from "node:path";
import { bundledPluginFile, bundledPluginRoot } from "openclaw/plugin-sdk/test-fixtures";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  detectChangedExtensionIds,
  listAvailableExtensionIds,
  listChangedExtensionIds,
} from "../../scripts/lib/changed-extensions.mjs";
import {
  DEFAULT_EXTENSION_TEST_SHARD_COUNT,
  createExtensionTestShards,
  resolveExtensionBatchPlan,
  resolveExtensionTestPlan,
} from "../../scripts/lib/extension-test-plan.mjs";
import {
  resolveExtensionBatchParallelism,
  runExtensionBatchPlan,
} from "../../scripts/test-extension-batch.mjs";
import { expectNoNodeFsScans } from "../../src/test-utils/fs-scan-assertions.js";

const scriptPath = path.join(process.cwd(), "scripts", "test-extension.mjs");

type RunGroupParams = {
  args: string[];
  config: string;
  env: Record<string, string | undefined>;
  targets: string[];
};

function runScript(args: string[], cwd = process.cwd()) {
  return execFileSync(process.execPath, [scriptPath, ...args], {
    cwd,
    encoding: "utf8",
  });
}

function requireFirstMockArg<T>(mock: { mock: { calls: Array<[T, ...unknown[]]> } }): T {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error("expected first mock call argument");
  }
  const [arg] = call;
  if (arg === undefined) {
    throw new Error("expected first mock call argument");
  }
  return arg;
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

  it("keeps unmatched non-provider extensions on the shared extensions vitest config", () => {
    const plan = resolveExtensionTestPlan({ targetArg: "codex", cwd: process.cwd() });

    expect(plan.extensionId).toBe("codex");
    expect(plan.config).toBe("test/vitest/vitest.extensions.config.ts");
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
      shards.map((shard, index) => `checks-node-extensions-shard-${index + 1}`),
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

  it("runs extension batch config groups concurrently when requested", async () => {
    const started: string[] = [];
    const resolvers: Array<() => void> = [];
    const runGroup = vi.fn((params: RunGroupParams) => {
      started.push(params.config);
      return new Promise<number>((resolve) => {
        resolvers.push(() => resolve(0));
      });
    });
    const runPromise = runExtensionBatchPlan(
      {
        extensionCount: 3,
        extensionIds: ["one", "two", "three"],
        estimatedCost: 60,
        hasTests: true,
        planGroups: [
          {
            config: "light",
            estimatedCost: 10,
            extensionIds: ["one"],
            roots: ["extensions/one"],
            testFileCount: 1,
          },
          {
            config: "heavy",
            estimatedCost: 30,
            extensionIds: ["two"],
            roots: ["extensions/two"],
            testFileCount: 3,
          },
          {
            config: "middle",
            estimatedCost: 20,
            extensionIds: ["three"],
            roots: ["extensions/three"],
            testFileCount: 2,
          },
        ],
        testFileCount: 6,
      },
      {
        env: { OPENCLAW_EXTENSION_BATCH_PARALLEL: "2" },
        runGroup,
        vitestArgs: ["--reporter=dot"],
      },
    );

    await Promise.resolve();
    expect(started).toEqual(["heavy", "middle"]);
    resolvers.shift()?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
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
      targets: ["extensions/two"],
    });
  });

  it("keeps extension batch parallelism bounded by group count", () => {
    expect(resolveExtensionBatchParallelism(3, { OPENCLAW_EXTENSION_BATCH_PARALLEL: "2" })).toBe(2);
    expect(resolveExtensionBatchParallelism(1, { OPENCLAW_EXTENSION_BATCH_PARALLEL: "4" })).toBe(1);
    expect(resolveExtensionBatchParallelism(3, { OPENCLAW_EXTENSION_BATCH_PARALLEL: "nope" })).toBe(
      1,
    );
  });

  it("treats extensions without tests as a no-op by default", () => {
    const extensionId = findExtensionWithoutTests();
    const stdout = runScript([extensionId]);

    expect(stdout).toContain(`No tests found for ${bundledPluginRoot(extensionId)}.`);
    expect(stdout).toContain("Skipping.");
  });
});

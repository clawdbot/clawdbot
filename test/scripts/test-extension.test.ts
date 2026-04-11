import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
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
import { bundledPluginFile, bundledPluginRoot } from "../helpers/bundled-plugin-paths.js";

const scriptPath = path.join(process.cwd(), "scripts", "test-extension.mjs");

function runScript(args: string[], cwd = process.cwd()) {
  return execFileSync(process.execPath, [scriptPath, ...args], {
    cwd,
    encoding: "utf8",
  });
}

function findExtensionWithoutTests() {
  const extensionId = listAvailableExtensionIds().find(
    (candidate) => !resolveExtensionTestPlan({ targetArg: candidate, cwd: process.cwd() }).hasTests,
  );

  expect(extensionId).toBeDefined();
  return extensionId ?? "missing-no-test-extension";
}

describe("scripts/test-extension.mjs", () => {
  it("resolves channel-root extensions onto the channel vitest config", () => {
    const plan = resolveExtensionTestPlan({ targetArg: "slack", cwd: process.cwd() });

    expect(plan.extensionId).toBe("slack");
    expect(plan.extensionDir).toBe(bundledPluginRoot("slack"));
    expect(plan.config).toBe("test/vitest/vitest.extension-channels.config.ts");
    expect(plan.roots).toContain(bundledPluginRoot("slack"));
    expect(plan.hasTests).toBe(true);
  });

  it("resolves bluebubbles onto the bluebubbles vitest config", () => {
    const plan = resolveExtensionTestPlan({ targetArg: "bluebubbles", cwd: process.cwd() });

    expect(plan.extensionId).toBe("bluebubbles");
    expect(plan.config).toBe("test/vitest/vitest.extension-bluebubbles.config.ts");
    expect(plan.roots).toContain(bundledPluginRoot("bluebubbles"));
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

  it("resolves provider extensions onto the provider vitest config", () => {
    const plan = resolveExtensionTestPlan({ targetArg: "openai", cwd: process.cwd() });

    expect(plan.extensionId).toBe("openai");
    expect(plan.config).toBe("test/vitest/vitest.extension-providers.config.ts");
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

  it("keeps non-provider extensions on the shared extensions vitest config", () => {
    const plan = resolveExtensionTestPlan({ targetArg: "firecrawl", cwd: process.cwd() });

    expect(plan.extensionId).toBe("firecrawl");
    expect(plan.config).toBe("test/vitest/vitest.extensions.config.ts");
    expect(plan.roots).toContain(bundledPluginRoot("firecrawl"));
    expect(plan.hasTests).toBe(true);
  });

  it("omits src/<extension> when no paired core root exists", () => {
    const plan = resolveExtensionTestPlan({ targetArg: "line", cwd: process.cwd() });

    expect(plan.roots).toContain(bundledPluginRoot("line"));
    expect(plan.roots).not.toContain("src/line");
    expect(plan.config).toBe("test/vitest/vitest.extension-channels.config.ts");
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

  it("can fail safe to all extensions when the base revision is unavailable", () => {
    const extensionIds = listChangedExtensionIds({
      base: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
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
        "bluebubbles",
        "acpx",
        "diffs",
      ],
    });

    expect(batch.extensionIds).toEqual([
      "acpx",
      "bluebubbles",
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
      "slack",
      "telegram",
      "voice-call",
      "whatsapp",
      "zalo",
      "zalouser",
    ]);
    expect(batch.planGroups).toEqual([
      {
        config: "test/vitest/vitest.extension-acpx.config.ts",
        extensionIds: ["acpx"],
        roots: [bundledPluginRoot("acpx")],
        testFileCount: expect.any(Number),
      },
      {
        config: "test/vitest/vitest.extension-bluebubbles.config.ts",
        extensionIds: ["bluebubbles"],
        roots: [bundledPluginRoot("bluebubbles")],
        testFileCount: expect.any(Number),
      },
      {
        config: "test/vitest/vitest.extension-channels.config.ts",
        extensionIds: ["line", "slack"],
        roots: [bundledPluginRoot("slack"), bundledPluginRoot("line")],
        testFileCount: expect.any(Number),
      },
      {
        config: "test/vitest/vitest.extension-diffs.config.ts",
        extensionIds: ["diffs"],
        roots: [bundledPluginRoot("diffs")],
        testFileCount: expect.any(Number),
      },
      {
        config: "test/vitest/vitest.extension-feishu.config.ts",
        extensionIds: ["feishu"],
        roots: [bundledPluginRoot("feishu")],
        testFileCount: expect.any(Number),
      },
      {
        config: "test/vitest/vitest.extension-irc.config.ts",
        extensionIds: ["irc"],
        roots: [bundledPluginRoot("irc")],
        testFileCount: expect.any(Number),
      },
      {
        config: "test/vitest/vitest.extension-matrix.config.ts",
        extensionIds: ["matrix"],
        roots: [bundledPluginRoot("matrix")],
        testFileCount: expect.any(Number),
      },
      {
        config: "test/vitest/vitest.extension-mattermost.config.ts",
        extensionIds: ["mattermost"],
        roots: [bundledPluginRoot("mattermost")],
        testFileCount: expect.any(Number),
      },
      {
        config: "test/vitest/vitest.extension-memory.config.ts",
        extensionIds: ["memory-core"],
        roots: [bundledPluginRoot("memory-core")],
        testFileCount: expect.any(Number),
      },
      {
        config: "test/vitest/vitest.extension-msteams.config.ts",
        extensionIds: ["msteams"],
        roots: [bundledPluginRoot("msteams")],
        testFileCount: expect.any(Number),
      },
      {
        config: "test/vitest/vitest.extension-providers.config.ts",
        extensionIds: ["openai"],
        roots: [bundledPluginRoot("openai")],
        testFileCount: expect.any(Number),
      },
      {
        config: "test/vitest/vitest.extension-telegram.config.ts",
        extensionIds: ["telegram"],
        roots: [bundledPluginRoot("telegram")],
        testFileCount: expect.any(Number),
      },
      {
        config: "test/vitest/vitest.extension-voice-call.config.ts",
        extensionIds: ["voice-call"],
        roots: [bundledPluginRoot("voice-call")],
        testFileCount: expect.any(Number),
      },
      {
        config: "test/vitest/vitest.extension-whatsapp.config.ts",
        extensionIds: ["whatsapp"],
        roots: [bundledPluginRoot("whatsapp")],
        testFileCount: expect.any(Number),
      },
      {
        config: "test/vitest/vitest.extension-zalo.config.ts",
        extensionIds: ["zalo", "zalouser"],
        roots: [bundledPluginRoot("zalo"), bundledPluginRoot("zalouser")],
        testFileCount: expect.any(Number),
      },
      {
        config: "test/vitest/vitest.extensions.config.ts",
        extensionIds: ["firecrawl"],
        roots: [bundledPluginRoot("firecrawl")],
        testFileCount: expect.any(Number),
      },
    ]);
  });

  it("balances extension test shards by test file count", () => {
    const shards = createExtensionTestShards({
      cwd: process.cwd(),
      shardCount: DEFAULT_EXTENSION_TEST_SHARD_COUNT,
    });

    expect(shards).toHaveLength(DEFAULT_EXTENSION_TEST_SHARD_COUNT);
    expect(shards.map((shard) => shard.checkName)).toEqual(
      shards.map((shard, index) => `checks-node-extensions-shard-${index + 1}`),
    );

    const assigned = shards.flatMap((shard) => shard.extensionIds);
    const uniqueAssigned = [...new Set(assigned)];
    const expected = listAvailableExtensionIds().filter(
      (extensionId) =>
        resolveExtensionTestPlan({ cwd: process.cwd(), targetArg: extensionId }).hasTests,
    );

    expect(uniqueAssigned.toSorted((left, right) => left.localeCompare(right))).toEqual(
      expected.toSorted((left, right) => left.localeCompare(right)),
    );
    expect(assigned).toHaveLength(expected.length);

    const totals = shards.map((shard) => shard.testFileCount);
    expect(Math.max(...totals) - Math.min(...totals)).toBeLessThanOrEqual(1);
  });

  it("treats extensions without tests as a no-op by default", () => {
    const extensionId = findExtensionWithoutTests();
    const stdout = runScript([extensionId]);

    expect(stdout).toContain(`No tests found for ${bundledPluginRoot(extensionId)}.`);
    expect(stdout).toContain("Skipping.");
  });
});

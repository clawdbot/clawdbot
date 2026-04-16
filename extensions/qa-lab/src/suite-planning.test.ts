import { lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultQaSuiteConcurrencyForTransport } from "./qa-transport-registry.js";
import {
  collectQaSuiteGatewayConfigPatch,
  collectQaSuiteGatewayRuntimeOptions,
  collectQaSuitePluginIds,
  mapQaSuiteWithConcurrency,
  normalizeQaSuiteConcurrency,
  resolveQaSuiteOutputDir,
  scenarioRequiresControlUi,
  selectQaSuiteScenarios,
} from "./suite-planning.js";
import { makeQaSuiteTestScenario } from "./suite-test-helpers.js";

describe("qa suite planning helpers", () => {
  it("normalizes suite concurrency to a bounded integer", () => {
    const previous = process.env.OPENCLAW_QA_SUITE_CONCURRENCY;
    delete process.env.OPENCLAW_QA_SUITE_CONCURRENCY;
    try {
      expect(normalizeQaSuiteConcurrency(undefined, 10)).toBe(10);
      expect(normalizeQaSuiteConcurrency(undefined, 80)).toBe(64);
      expect(
        normalizeQaSuiteConcurrency(
          undefined,
          80,
          defaultQaSuiteConcurrencyForTransport("qa-channel"),
        ),
      ).toBe(4);
      expect(normalizeQaSuiteConcurrency(2.8, 10)).toBe(2);
      expect(normalizeQaSuiteConcurrency(20, 3)).toBe(3);
      expect(normalizeQaSuiteConcurrency(0, 3)).toBe(1);
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_QA_SUITE_CONCURRENCY;
      } else {
        process.env.OPENCLAW_QA_SUITE_CONCURRENCY = previous;
      }
    }
  });

  it("keeps programmatic suite output dirs within the repo root", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "qa-suite-existing-root-"));
    try {
      await expect(
        resolveQaSuiteOutputDir(repoRoot, path.join(repoRoot, ".artifacts", "qa-e2e", "custom")),
      ).resolves.toBe(path.join(repoRoot, ".artifacts", "qa-e2e", "custom"));
      await expect(
        lstat(path.join(repoRoot, ".artifacts", "qa-e2e", "custom")).then((stats) =>
          stats.isDirectory(),
        ),
      ).resolves.toBe(true);
      await expect(resolveQaSuiteOutputDir(repoRoot, "/tmp/outside")).rejects.toThrow(
        "QA suite outputDir must stay within the repo root.",
      );
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("rejects symlinked suite output dirs that escape the repo root", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "qa-suite-root-"));
    const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "qa-suite-outside-"));
    try {
      await mkdir(path.join(repoRoot, ".artifacts"), { recursive: true });
      await symlink(outsideRoot, path.join(repoRoot, ".artifacts", "qa-e2e"), "dir");

      await expect(resolveQaSuiteOutputDir(repoRoot, ".artifacts/qa-e2e/custom")).rejects.toThrow(
        "QA suite outputDir must not traverse symlinks.",
      );
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it("maps suite work with bounded concurrency while preserving order", async () => {
    let active = 0;
    let maxActive = 0;
    const result = await mapQaSuiteWithConcurrency([1, 2, 3, 4], 2, async (item) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return item * 10;
    });

    expect(maxActive).toBe(2);
    expect(result).toEqual([10, 20, 30, 40]);
  });

  it("keeps explicitly requested provider-specific scenarios", () => {
    const scenarios = [
      makeQaSuiteTestScenario("generic"),
      makeQaSuiteTestScenario("anthropic-only", {
        config: {
          requiredProvider: "anthropic",
          requiredModel: "claude-opus-4-6",
        },
      }),
    ];

    expect(
      selectQaSuiteScenarios({
        scenarios,
        scenarioIds: ["anthropic-only"],
        providerMode: "live-frontier",
        primaryModel: "openai/gpt-5.4",
      }).map((scenario) => scenario.id),
    ).toEqual(["anthropic-only"]);
  });

  it("collects unique scenario-declared bundled plugins in encounter order", () => {
    const scenarios = [
      makeQaSuiteTestScenario("generic", { plugins: ["active-memory", "memory-wiki"] }),
      makeQaSuiteTestScenario("other", { plugins: ["memory-wiki", "openai"] }),
      makeQaSuiteTestScenario("plain"),
    ];

    expect(collectQaSuitePluginIds(scenarios)).toEqual(["active-memory", "memory-wiki", "openai"]);
  });

  it("merge-patches scenario startup config in encounter order", () => {
    const scenarios = [
      makeQaSuiteTestScenario("active-memory", {
        plugins: ["active-memory"],
        gatewayConfigPatch: {
          plugins: {
            entries: {
              "active-memory": {
                config: {
                  enabled: true,
                  agents: ["qa"],
                },
              },
            },
          },
        },
      }),
      makeQaSuiteTestScenario("live-defaults", {
        gatewayConfigPatch: {
          agents: {
            defaults: {
              thinkingDefault: "minimal",
            },
          },
          plugins: {
            entries: {
              "active-memory": {
                config: {
                  transcriptDir: "qa-memory-e2e",
                },
              },
            },
          },
        },
      }),
    ];

    expect(collectQaSuiteGatewayConfigPatch(scenarios)).toEqual({
      agents: {
        defaults: {
          thinkingDefault: "minimal",
        },
      },
      plugins: {
        entries: {
          "active-memory": {
            config: {
              enabled: true,
              agents: ["qa"],
              transcriptDir: "qa-memory-e2e",
            },
          },
        },
      },
    });
  });

  it("ignores prototype-mutating keys in scenario startup config patches", () => {
    const scenarios = [
      makeQaSuiteTestScenario("polluted", {
        gatewayConfigPatch: JSON.parse(
          `{"plugins":{"entries":{}},"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}`,
        ) as Record<string, unknown>,
      }),
    ];

    const patch = collectQaSuiteGatewayConfigPatch(scenarios);

    expect(patch).toEqual({ plugins: { entries: {} } });
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("collects gateway runtime options across selected scenarios", () => {
    const scenarios = [
      makeQaSuiteTestScenario("plain"),
      makeQaSuiteTestScenario("browser-ui", {
        plugins: ["browser"],
        gatewayRuntime: { forwardHostHome: true },
      }),
    ];

    expect(collectQaSuiteGatewayRuntimeOptions(scenarios)).toEqual({
      forwardHostHome: true,
    });
  });

  it("enables Control UI only for Control UI scenario workers", () => {
    expect(
      scenarioRequiresControlUi(
        makeQaSuiteTestScenario("control-ui", {
          surface: "control-ui",
        }),
      ),
    ).toBe(true);
    expect(scenarioRequiresControlUi(makeQaSuiteTestScenario("plain"))).toBe(false);
  });

  it("filters provider-specific scenarios from an implicit live lane", () => {
    const scenarios = [
      makeQaSuiteTestScenario("generic"),
      makeQaSuiteTestScenario("openai-only", {
        config: { requiredProvider: "openai", requiredModel: "gpt-5.4" },
      }),
      makeQaSuiteTestScenario("anthropic-only", {
        config: { requiredProvider: "anthropic", requiredModel: "claude-opus-4-6" },
      }),
      makeQaSuiteTestScenario("claude-subscription", {
        config: { requiredProvider: "claude-cli", authMode: "subscription" },
      }),
    ];

    expect(
      selectQaSuiteScenarios({
        scenarios,
        providerMode: "live-frontier",
        primaryModel: "openai/gpt-5.4",
      }).map((scenario) => scenario.id),
    ).toEqual(["generic", "openai-only"]);

    expect(
      selectQaSuiteScenarios({
        scenarios,
        providerMode: "live-frontier",
        primaryModel: "claude-cli/claude-sonnet-4-6",
        claudeCliAuthMode: "subscription",
      }).map((scenario) => scenario.id),
    ).toEqual(["generic", "claude-subscription"]);
  });
});

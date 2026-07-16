// Qa Lab tests cover suite planning plugin behavior.
import { lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { defaultQaSuiteConcurrencyForTransport } from "./qa-transport-registry.js";
import { readQaScenarioById } from "./scenario-catalog.js";
import {
  collectQaSuiteGatewayConfigPatch,
  collectQaSuiteGatewayRuntimeOptions,
  collectQaSuitePluginIds,
  collectQaSuiteTransportPolicy,
  mapQaSuiteWithConcurrency,
  normalizeQaSuiteConcurrency,
  normalizeQaSuiteScenarioChannel,
  resolveQaSuiteScenarioChannel,
  resolveQaSuiteScenarioChannels,
  resolveQaSuiteWorkerStartStaggerMs,
  resolveQaSuiteOutputDir,
  scenarioRequiresControlUi,
  scenarioRequiresIsolatedQaSuiteWorker,
  selectQaFlowSuiteScenarios,
  shouldUseIsolatedQaSuiteScenarioWorkers,
} from "./suite-planning.js";
import { makeQaSuiteTestScenario } from "./suite-test-helpers.js";

function makePlaywrightQaSuiteTestScenario(id: string): ReturnType<typeof makeQaSuiteTestScenario> {
  return {
    ...makeQaSuiteTestScenario(id),
    execution: {
      kind: "playwright",
      path: `ui/src/e2e/${id}.e2e.test.ts`,
    },
  };
}

function makeMatrixFlowQaSuiteTestScenario(
  id: string,
  providerMode?: "live-frontier" | "mock-openai",
): ReturnType<typeof makeQaSuiteTestScenario> {
  return {
    ...makeQaSuiteTestScenario(id),
    execution: {
      kind: "flow",
      channel: "matrix",
      timeoutMs: 60_000,
      retryCount: 0,
      ...(providerMode ? { providerMode } : {}),
    },
  };
}

describe("qa suite planning helpers", () => {
  it("normalizes blank scenario channels as unpinned", () => {
    expect(
      normalizeQaSuiteScenarioChannel(makeQaSuiteTestScenario("blank-channel", { channel: "   " })),
    ).toBeUndefined();
    expect(
      normalizeQaSuiteScenarioChannel(
        makeQaSuiteTestScenario("matrix-channel", { channel: " Matrix " }),
      ),
    ).toBe("matrix");
  });

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

      process.env.OPENCLAW_QA_SUITE_CONCURRENCY = "3";
      expect(normalizeQaSuiteConcurrency(undefined, 10)).toBe(3);

      process.env.OPENCLAW_QA_SUITE_CONCURRENCY = "0";
      expect(normalizeQaSuiteConcurrency(undefined, 10)).toBe(1);

      for (const value of ["0x10", "1e2", "2.5"]) {
        process.env.OPENCLAW_QA_SUITE_CONCURRENCY = value;
        expect(normalizeQaSuiteConcurrency(undefined, 10)).toBe(10);
      }
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

  it("creates unique default suite output dirs inside the repo root", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "qa-suite-default-root-"));
    try {
      const firstDir = await resolveQaSuiteOutputDir(repoRoot);
      const secondDir = await resolveQaSuiteOutputDir(repoRoot);

      expect(path.dirname(firstDir)).toBe(path.join(repoRoot, ".artifacts", "qa-e2e"));
      expect(path.basename(firstDir)).toMatch(/^suite-[a-z0-9]+-[a-f0-9]{8}$/u);
      expect(secondDir).not.toBe(firstDir);
      await expect(lstat(firstDir).then((stats) => stats.isDirectory())).resolves.toBe(true);
      await expect(lstat(secondDir).then((stats) => stats.isDirectory())).resolves.toBe(true);
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
    let releaseStartedTasks = false;
    let resolveBothStarted: () => void = () => {};
    const bothStarted = new Promise<void>((resolve) => {
      resolveBothStarted = resolve;
    });
    const taskReleases: Array<() => void> = [];
    const releaseQueuedTasks = () => {
      if (!releaseStartedTasks) {
        return;
      }
      let releaseTask: (() => void) | undefined;
      while ((releaseTask = taskReleases.shift())) {
        releaseTask();
      }
    };

    const resultPromise = mapQaSuiteWithConcurrency([1, 2, 3, 4], 2, async (item) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (active === 2) {
        resolveBothStarted();
      }
      await new Promise<void>((resolve) => {
        taskReleases.push(resolve);
        releaseQueuedTasks();
      });
      active -= 1;
      return item * 10;
    });

    await bothStarted;
    expect(maxActive).toBe(2);
    releaseStartedTasks = true;
    releaseQueuedTasks();
    const result = await resultPromise;
    expect(result).toEqual([10, 20, 30, 40]);
  });

  it("stops sequential suite work after the first matching result", async () => {
    const started: number[] = [];
    const result = await mapQaSuiteWithConcurrency(
      [1, 2, 3, 4],
      1,
      async (item) => {
        started.push(item);
        return { item, failed: item === 2 };
      },
      { shouldStop: (entry) => entry.failed },
    );

    expect(started).toEqual([1, 2]);
    expect(result).toEqual([
      { item: 1, failed: false },
      { item: 2, failed: true },
    ]);
  });

  it("staggers scenario starts without reducing mapped concurrency", async () => {
    const sleeps: number[] = [];
    const releaseSleeps: Array<() => void> = [];
    const started: number[] = [];
    const waitForStarted = async (expected: number[]) => {
      await vi.waitFor(() => {
        expect(started).toEqual(expected);
      });
    };
    const resultPromise = mapQaSuiteWithConcurrency(
      [1, 2, 3, 4],
      3,
      async (item) => {
        started.push(item);
        return item;
      },
      {
        startStaggerMs: 25,
        sleepImpl: async (ms) => {
          sleeps.push(ms);
          await new Promise<void>((resolve) => {
            releaseSleeps.push(resolve);
          });
        },
      },
    );

    await waitForStarted([1]);
    releaseSleeps.shift()?.();
    await waitForStarted([1, 2]);
    releaseSleeps.shift()?.();
    await waitForStarted([1, 2, 3]);
    releaseSleeps.shift()?.();
    await waitForStarted([1, 2, 3, 4]);

    const result = await resultPromise;
    expect(result).toEqual([1, 2, 3, 4]);
    expect(sleeps).toEqual([25, 25, 25]);
  });

  it("resolves a default worker startup stagger for concurrent suite workers", () => {
    expect(resolveQaSuiteWorkerStartStaggerMs(1, {})).toBe(0);
    expect(resolveQaSuiteWorkerStartStaggerMs(4, {})).toBe(1500);
    expect(
      resolveQaSuiteWorkerStartStaggerMs(4, {
        OPENCLAW_QA_SUITE_WORKER_START_STAGGER_MS: "0",
      }),
    ).toBe(0);
    expect(
      resolveQaSuiteWorkerStartStaggerMs(4, {
        OPENCLAW_QA_SUITE_WORKER_START_STAGGER_MS: "25",
      }),
    ).toBe(25);
    for (const value of ["0x10", "1e3", "10.5"]) {
      expect(
        resolveQaSuiteWorkerStartStaggerMs(4, {
          OPENCLAW_QA_SUITE_WORKER_START_STAGGER_MS: value,
        }),
      ).toBe(1500);
    }
    expect(resolveQaSuiteWorkerStartStaggerMs(4, {}, 500)).toBe(500);
    expect(
      resolveQaSuiteWorkerStartStaggerMs(
        4,
        {
          OPENCLAW_QA_SUITE_WORKER_START_STAGGER_MS: "25",
        },
        500,
      ),
    ).toBe(25);
  });

  it("rejects an explicitly requested scenario for the wrong provider", () => {
    const scenarios = [
      makeQaSuiteTestScenario("generic"),
      makeQaSuiteTestScenario("anthropic-only", {
        config: {
          requiredProvider: "anthropic",
        },
      }),
    ];

    expect(() =>
      selectQaFlowSuiteScenarios({
        scenarios,
        scenarioIds: ["anthropic-only"],
        providerMode: "live-frontier",
        primaryModel: "openai/gpt-5.6-luna",
      }),
    ).toThrow(
      "selected QA scenario(s) do not match the current QA lane: anthropic-only (provider=anthropic)",
    );
  });

  it("rejects an explicitly requested scenario for the wrong provider mode", () => {
    const scenarios = [
      makeQaSuiteTestScenario("mock-only", {
        config: { requiredProviderMode: "mock-openai" },
      }),
    ];

    expect(() =>
      selectQaFlowSuiteScenarios({
        scenarios,
        scenarioIds: ["mock-only"],
        providerMode: "live-frontier",
        primaryModel: "openai/gpt-5.6-luna",
      }),
    ).toThrow(
      "selected QA scenario(s) do not match the current QA lane: mock-only (providerMode=mock-openai)",
    );
  });

  it("rejects an explicitly requested scenario for the wrong model", () => {
    const scenarios = [
      makeQaSuiteTestScenario("openai-model", {
        config: {
          requiredProvider: "openai",
          requiredModel: "gpt-5.6-luna",
        },
      }),
    ];

    expect(() =>
      selectQaFlowSuiteScenarios({
        scenarios,
        scenarioIds: ["openai-model"],
        providerMode: "live-frontier",
        primaryModel: "openai/gpt-5.6-terra",
      }),
    ).toThrow(
      "selected QA scenario(s) do not match the current QA lane: openai-model (model=gpt-5.6-luna)",
    );
  });

  it("rejects an explicitly requested scenario for the wrong auth mode", () => {
    const scenarios = [
      makeQaSuiteTestScenario("claude-subscription", {
        config: {
          requiredProvider: "claude-cli",
          authMode: "subscription",
        },
      }),
    ];

    expect(() =>
      selectQaFlowSuiteScenarios({
        scenarios,
        scenarioIds: ["claude-subscription"],
        providerMode: "live-frontier",
        primaryModel: "claude-cli/claude-sonnet-4-6",
        claudeCliAuthMode: "api-key",
      }),
    ).toThrow(
      "selected QA scenario(s) do not match the current QA lane: claude-subscription (authMode=subscription)",
    );
  });

  it("keeps an explicitly requested scenario when every lane contract matches", () => {
    const scenarios = [
      makeQaSuiteTestScenario("strict-live-lane", {
        channel: "matrix",
        runtimeParityTier: "live-only",
        config: {
          requiredProviderMode: "live-frontier",
          requiredProvider: "claude-cli",
          requiredModel: "claude-sonnet-4-6",
          authMode: "subscription",
        },
      }),
    ];

    expect(
      selectQaFlowSuiteScenarios({
        scenarios,
        scenarioIds: ["strict-live-lane"],
        providerMode: "live-frontier",
        primaryModel: "claude-cli/claude-sonnet-4-6",
        claudeCliAuthMode: "subscription",
        channelDriver: "live",
        channel: "matrix",
      }).map((scenario) => scenario.id),
    ).toEqual(["strict-live-lane"]);
  });

  it("keeps explicitly requested scenarios in request order", () => {
    const scenarios = [
      makeQaSuiteTestScenario("first"),
      makeQaSuiteTestScenario("second"),
      makeQaSuiteTestScenario("third"),
    ];

    expect(
      selectQaFlowSuiteScenarios({
        scenarios,
        scenarioIds: ["third", "first"],
        providerMode: "live-frontier",
        primaryModel: "openai/gpt-5.6-luna",
      }).map((scenario) => scenario.id),
    ).toEqual(["third", "first"]);
  });

  it("applies the same lane contract to explicit and implicit selection", () => {
    const scenarios = [
      makeQaSuiteTestScenario("generic"),
      makeQaSuiteTestScenario("openai-only", {
        config: { requiredProvider: "openai", requiredModel: "gpt-5.6-luna" },
      }),
      makeQaSuiteTestScenario("anthropic-only", {
        config: { requiredProvider: "anthropic", requiredModel: "claude-opus-4-8" },
      }),
    ];
    const lane = {
      scenarios,
      providerMode: "live-frontier" as const,
      primaryModel: "openai/gpt-5.6-luna",
    };

    expect(selectQaFlowSuiteScenarios(lane).map((scenario) => scenario.id)).toEqual([
      "generic",
      "openai-only",
    ]);
    expect(
      selectQaFlowSuiteScenarios({ ...lane, scenarioIds: ["openai-only"] }).map(
        (scenario) => scenario.id,
      ),
    ).toEqual(["openai-only"]);
    expect(() => selectQaFlowSuiteScenarios({ ...lane, scenarioIds: ["anthropic-only"] })).toThrow(
      "selected QA scenario(s) do not match the current QA lane: anthropic-only (provider=anthropic, model=claude-opus-4-8)",
    );
  });

  it("resolves driver channels from scenario execution with explicit and default fallbacks", () => {
    expect(
      resolveQaSuiteScenarioChannel({
        defaultChannel: "telegram",
        scenarios: [makeQaSuiteTestScenario("plain")],
      }),
    ).toBe("telegram");
    expect(
      resolveQaSuiteScenarioChannel({
        defaultChannel: "telegram",
        scenarios: [
          makeQaSuiteTestScenario("plain"),
          makeQaSuiteTestScenario("slack-flow", { channel: "slack" }),
        ],
      }),
    ).toBe("slack");
    expect(
      resolveQaSuiteScenarioChannel({
        defaultChannel: "telegram",
        explicitChannel: "slack",
        scenarios: [makeQaSuiteTestScenario("slack-flow", { channel: "slack" })],
      }),
    ).toBe("slack");
    expect(() =>
      resolveQaSuiteScenarioChannel({
        defaultChannel: "telegram",
        explicitChannel: "telegram",
        scenarios: [makeQaSuiteTestScenario("slack-flow", { channel: "slack" })],
      }),
    ).toThrow("--channel telegram conflicts with selected scenario execution.channel slack.");
    expect(() =>
      resolveQaSuiteScenarioChannel({
        defaultChannel: "telegram",
        scenarios: [
          makeQaSuiteTestScenario("slack-flow", { channel: "slack" }),
          makeQaSuiteTestScenario("telegram-flow", { channel: "telegram" }),
        ],
      }),
    ).toThrow("Selected QA scenarios require multiple channels");
    expect(
      resolveQaSuiteScenarioChannels({
        defaultChannel: "telegram",
        scenarios: [
          makeQaSuiteTestScenario("plain"),
          makeQaSuiteTestScenario("matrix-flow", { channel: "matrix" }),
          makeQaSuiteTestScenario("slack-flow", { channel: "slack" }),
        ],
      }),
    ).toEqual(["telegram", "matrix", "slack"]);
  });

  it("isolates flow scenarios with explicit suite isolation metadata", () => {
    expect(
      scenarioRequiresIsolatedQaSuiteWorker(
        makeQaSuiteTestScenario("explicit-isolated", { suiteIsolation: "isolated" }),
      ),
    ).toBe(true);
    expect(scenarioRequiresIsolatedQaSuiteWorker(makeQaSuiteTestScenario("plain"))).toBe(false);
  });

  it("isolates and collects scenario-declared transport policy", () => {
    const scenario = makeQaSuiteTestScenario("sender-policy", {
      transportPolicy: {
        requireGroupMention: true,
        senderAllowlist: ["driver"],
      },
    });

    expect(scenarioRequiresIsolatedQaSuiteWorker(scenario)).toBe(true);
    expect(collectQaSuiteTransportPolicy([scenario])).toEqual({
      requireGroupMention: true,
      senderAllowlist: ["driver"],
    });
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

  it("targets the selected adapter account in scenario startup config patches", () => {
    const scenarios = [readQaScenarioById("thread-reply-override")];

    expect(collectQaSuiteGatewayConfigPatch(scenarios, "matrix-alt")).toEqual({
      channels: {
        matrix: {
          accounts: {
            "matrix-alt": {
              threadReplies: "always",
            },
          },
        },
      },
    });
  });

  it("collects gateway runtime options across selected scenarios", () => {
    const scenarios = [
      makeQaSuiteTestScenario("plain"),
      makeQaSuiteTestScenario("browser-ui", {
        plugins: ["browser"],
        gatewayRuntime: { forwardHostHome: true },
      }),
      makeQaSuiteTestScenario("otel-stdout", {
        plugins: ["diagnostics-otel"],
        gatewayRuntime: { preserveDebugArtifacts: true },
      }),
    ];

    expect(collectQaSuiteGatewayRuntimeOptions(scenarios)).toEqual({
      forwardHostHome: true,
      preserveDebugArtifacts: true,
    });
  });

  it("isolates multi-scenario serial runs when a scenario needs startup config", () => {
    const scenarios = [
      makeQaSuiteTestScenario("baseline"),
      makeQaSuiteTestScenario("message-tool-mode", {
        gatewayConfigPatch: {
          messages: {
            groupChat: {
              visibleReplies: "message_tool",
            },
          },
        },
      }),
    ];

    expect(
      shouldUseIsolatedQaSuiteScenarioWorkers({
        scenarios,
        concurrency: 1,
      }),
    ).toBe(true);
  });

  it("does not isolate plain serial scenario runs", () => {
    expect(
      shouldUseIsolatedQaSuiteScenarioWorkers({
        scenarios: [makeQaSuiteTestScenario("first"), makeQaSuiteTestScenario("second")],
        concurrency: 1,
      }),
    ).toBe(false);
  });

  it("isolates serial runs when a flow scenario changes provider mode", () => {
    expect(
      shouldUseIsolatedQaSuiteScenarioWorkers({
        scenarios: [
          makeMatrixFlowQaSuiteTestScenario("default"),
          makeMatrixFlowQaSuiteTestScenario("live-override", "live-frontier"),
        ],
        concurrency: 1,
      }),
    ).toBe(true);
  });

  it("isolates serial runs when transport policy would leak into another scenario", () => {
    expect(
      shouldUseIsolatedQaSuiteScenarioWorkers({
        scenarios: [
          makeQaSuiteTestScenario("dm-baseline"),
          makeQaSuiteTestScenario("sender-policy", {
            transportPolicy: { senderAllowlist: ["driver"] },
          }),
        ],
        concurrency: 1,
      }),
    ).toBe(true);
  });

  it("keeps concurrent runs on isolated workers", () => {
    expect(
      shouldUseIsolatedQaSuiteScenarioWorkers({
        scenarios: [makeQaSuiteTestScenario("first"), makeQaSuiteTestScenario("second")],
        concurrency: 2,
      }),
    ).toBe(true);
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
        config: { requiredProvider: "openai", requiredModel: "gpt-5.6-luna" },
      }),
      makeQaSuiteTestScenario("anthropic-only", {
        config: { requiredProvider: "anthropic", requiredModel: "claude-opus-4-8" },
      }),
      makeQaSuiteTestScenario("claude-subscription", {
        config: { requiredProvider: "claude-cli", authMode: "subscription" },
      }),
    ];

    expect(
      selectQaFlowSuiteScenarios({
        scenarios,
        providerMode: "live-frontier",
        primaryModel: "openai/gpt-5.6-luna",
      }).map((scenario) => scenario.id),
    ).toEqual(["generic", "openai-only"]);

    expect(
      selectQaFlowSuiteScenarios({
        scenarios,
        providerMode: "live-frontier",
        primaryModel: "claude-cli/claude-sonnet-4-6",
        claudeCliAuthMode: "subscription",
      }).map((scenario) => scenario.id),
    ).toEqual(["generic", "claude-subscription"]);
  });

  it("keeps Playwright scenarios out of implicit flow suite selections", () => {
    const scenarios = [
      makeQaSuiteTestScenario("flow"),
      makePlaywrightQaSuiteTestScenario("playwright"),
    ];

    expect(
      selectQaFlowSuiteScenarios({
        scenarios,
        providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.6-luna",
      }).map((scenario) => scenario.id),
    ).toEqual(["flow"]);
  });

  it("rejects explicit Playwright scenarios in the flow suite selector", () => {
    const scenarios = [
      makeQaSuiteTestScenario("flow"),
      makePlaywrightQaSuiteTestScenario("playwright"),
    ];

    expect(() =>
      selectQaFlowSuiteScenarios({
        scenarios,
        scenarioIds: ["playwright"],
        providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.6-luna",
      }),
    ).toThrow(
      "suite execution requires flow scenarios; unsupported scenario(s): playwright (playwright)",
    );
  });

  it("filters provider-mode-specific scenarios from implicit suite selections", () => {
    const scenarios = [
      makeQaSuiteTestScenario("generic"),
      makeQaSuiteTestScenario("live-only", {
        config: { requiredProviderMode: "live-frontier" },
      }),
      makeQaSuiteTestScenario("mock-only", {
        config: { requiredProviderMode: "mock-openai" },
      }),
    ];

    expect(
      selectQaFlowSuiteScenarios({
        scenarios,
        providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.6-luna",
      }).map((scenario) => scenario.id),
    ).toEqual(["generic", "mock-only"]);

    expect(
      selectQaFlowSuiteScenarios({
        scenarios,
        providerMode: "live-frontier",
        primaryModel: "openai/gpt-5.6-luna",
      }).map((scenario) => scenario.id),
    ).toEqual(["generic", "live-only"]);
  });

  it("keeps implicit scenario membership identical across channel drivers", () => {
    const scenarios = [
      makeQaSuiteTestScenario("generic"),
      makeQaSuiteTestScenario("telegram", {
        channel: "telegram",
      }),
      makeQaSuiteTestScenario("matrix", {
        channel: "matrix",
      }),
    ];

    const selectForDriver = (channelDriver: "crabline" | "live") =>
      selectQaFlowSuiteScenarios({
        scenarios,
        providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.6-luna",
        channelDriver,
        channel: "telegram",
      }).map((scenario) => scenario.id);

    expect(selectForDriver("crabline")).toEqual(["generic", "telegram"]);
    expect(selectForDriver("live")).toEqual(selectForDriver("crabline"));
  });

  it("rejects explicitly requested scenarios that do not match the current lane", () => {
    const scenarios = [
      makeQaSuiteTestScenario("generic"),
      makeQaSuiteTestScenario("qa-channel-only", {
        channel: "qa-channel",
      }),
    ];

    expect(() =>
      selectQaFlowSuiteScenarios({
        scenarios,
        scenarioIds: ["qa-channel-only"],
        providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.6-luna",
        channelDriver: "crabline",
        channel: "telegram",
      }),
    ).toThrow(
      "selected QA scenario(s) do not match the current QA lane: qa-channel-only (channel=qa-channel)",
    );

    expect(
      selectQaFlowSuiteScenarios({
        scenarios,
        scenarioIds: ["qa-channel-only"],
        providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.6-luna",
      }).map((scenario) => scenario.id),
    ).toEqual(["qa-channel-only"]);
  });

  it("requires an external lane matching a channel-specific scenario", () => {
    const scenarios = [
      makeQaSuiteTestScenario("matrix-transport", {
        channel: "matrix",
      }),
    ];

    expect(() =>
      selectQaFlowSuiteScenarios({
        scenarios,
        scenarioIds: ["matrix-transport"],
        providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.5",
      }),
    ).toThrow(
      "selected QA scenario(s) do not match the current QA lane: matrix-transport (channel=matrix)",
    );

    expect(
      selectQaFlowSuiteScenarios({
        scenarios,
        scenarioIds: ["matrix-transport"],
        providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.5",
        channelDriver: "crabline",
        channel: "matrix",
      }).map((scenario) => scenario.id),
    ).toEqual(["matrix-transport"]);

    expect(
      selectQaFlowSuiteScenarios({
        scenarios,
        scenarioIds: ["matrix-transport"],
        providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.5",
        channelDriver: "live",
        channel: "matrix",
      }).map((scenario) => scenario.id),
    ).toEqual(["matrix-transport"]);
  });

  it("keeps live-only runtime parity scenarios out of every mock selection", () => {
    const scenarios = [
      makeQaSuiteTestScenario("generic"),
      makeQaSuiteTestScenario("live-runtime", {
        runtimeParityTier: "live-only",
      }),
    ];

    expect(
      selectQaFlowSuiteScenarios({
        scenarios,
        providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.6-luna",
      }).map((scenario) => scenario.id),
    ).toEqual(["generic"]);

    expect(() =>
      selectQaFlowSuiteScenarios({
        scenarios,
        scenarioIds: ["live-runtime"],
        providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.6-luna",
      }),
    ).toThrow(
      "selected QA scenario(s) do not match the current QA lane: live-runtime (live provider mode)",
    );
  });
});

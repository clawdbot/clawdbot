import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { crablineRuntimeLoads, runQaFlowSuite, runQaTestFileScenarios } = vi.hoisted(() => ({
  crablineRuntimeLoads: vi.fn(),
  runQaFlowSuite: vi.fn(),
  runQaTestFileScenarios: vi.fn(),
}));

vi.mock("@openclaw/crabline", async (importOriginal) => {
  crablineRuntimeLoads();
  return await importOriginal<typeof import("@openclaw/crabline")>();
});

vi.mock("./suite.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./suite.js")>()),
  runQaFlowSuite,
}));

vi.mock("./test-file-scenario-runner.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./test-file-scenario-runner.js")>()),
  runQaTestFileScenarios,
}));

import { runQaSuite } from "./suite-launch.runtime.js";

const tempRoots: string[] = [];

async function makeTempRepo(prefix: string) {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(repoRoot);
  return repoRoot;
}

async function writeEvidence(pathLocal: string, writeFile = true) {
  const evidence = {
    kind: "openclaw.qa.evidence-summary",
    schemaVersion: 2,
    generatedAt: "2026-06-14T00:00:00.000Z",
    evidenceMode: "full",
    entries: [],
  };
  if (writeFile) {
    await fs.mkdir(path.dirname(pathLocal), { recursive: true });
    await fs.writeFile(pathLocal, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  }
  return evidence;
}

function trackMaxActiveFlowRuns() {
  const run = runQaFlowSuite.getMockImplementation();
  if (!run) {
    throw new Error("expected default QA flow suite mock implementation");
  }
  let active = 0;
  let maxActive = 0;
  runQaFlowSuite.mockImplementation(async (params) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1);
    });
    try {
      return await run(params);
    } finally {
      active -= 1;
    }
  });
  return () => maxActive;
}

describe("qa suite runtime launcher", () => {
  beforeEach(() => {
    runQaFlowSuite.mockReset();
    runQaTestFileScenarios.mockReset();
    runQaFlowSuite.mockImplementation(
      async (
        params:
          | { outputDir?: string; scenarioIds?: string[]; writeEvidenceFile?: boolean }
          | undefined,
      ) => {
        const outputDir = params?.outputDir ?? "/tmp/qa-flow";
        const evidencePath = path.join(outputDir, "qa-evidence.json");
        const evidence = await writeEvidence(evidencePath, params?.writeEvidenceFile);
        const scenarioIds = params?.scenarioIds ?? ["channel-chat-baseline"];
        return {
          evidence,
          outputDir,
          evidencePath,
          reportPath: path.join(outputDir, "qa-suite-report.md"),
          summaryPath: path.join(outputDir, "qa-suite-summary.json"),
          report: "# QA Suite Report\n",
          scenarios: scenarioIds.map((scenarioId) => ({
            name: scenarioId,
            status: "pass",
            steps: [],
          })),
          watchUrl: "http://127.0.0.1:43124",
        };
      },
    );
    runQaTestFileScenarios.mockImplementation(
      async (params: {
        outputDir: string;
        scenarios: Array<{ id: string; execution: { kind: "script" | "vitest" | "playwright" } }>;
        writeEvidenceFile?: boolean;
      }) => {
        const [scenario] = params.scenarios;
        if (!scenario) {
          throw new Error("expected scenario");
        }
        const evidencePath = path.join(params.outputDir, "qa-evidence.json");
        const evidence = await writeEvidence(evidencePath, params.writeEvidenceFile);
        return {
          evidence,
          outputDir: params.outputDir,
          executionKind: scenario.execution.kind,
          evidencePath,
          results: params.scenarios.map((scenarioItem) => ({
            durationMs: 1,
            logPath: path.join(params.outputDir, `${scenarioItem.id}.log`),
            scenario: scenarioItem,
            status: "pass",
          })),
        };
      },
    );
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(
      tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
    );
  });

  it("keeps Crabline out of unrelated live transport startup", async () => {
    expect(crablineRuntimeLoads).not.toHaveBeenCalled();

    await runQaSuite({
      repoRoot: process.cwd(),
      providerMode: "mock-openai",
      channelDriver: "live",
      channelId: "telegram",
      scenarioIds: ["channel-chat-baseline"],
    });

    expect(crablineRuntimeLoads).not.toHaveBeenCalled();
  });

  it("routes selected flow scenarios to the flow suite engine", async () => {
    const result = await runQaSuite({
      repoRoot: process.cwd(),
      providerMode: "mock-openai",
      scenarioIds: ["channel-chat-baseline"],
    });

    expect(result).toMatchObject({
      executionKind: "flow",
      result: {
        summaryPath: "/tmp/qa-flow/qa-suite-summary.json",
      },
    });
    expect(runQaFlowSuite).toHaveBeenCalledTimes(1);
    expect(runQaFlowSuite).toHaveBeenCalledWith(
      expect.objectContaining({
        repoRoot: process.cwd(),
        providerMode: "mock-openai",
        scenarioIds: ["channel-chat-baseline"],
      }),
    );
    expect(runQaTestFileScenarios).not.toHaveBeenCalled();
  });

  it("partitions flow-only suites that request isolated workers", async () => {
    const repoRoot = await makeTempRepo("qa-suite-flow-only-isolated-");
    const result = await runQaSuite({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/flow-only-isolated",
      concurrency: 1,
      runtimePair: ["openclaw", "codex"],
      scenarioIds: ["channel-chat-baseline", "matrix-allowlist-hot-reload"],
    });

    expect(result.executionKind).toBe("suite");
    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "flow-only-isolated");
    expect(runQaFlowSuite).toHaveBeenCalledTimes(2);
    expect(runQaFlowSuite).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        outputDir: path.join(outputDir, "flow", "isolated-1"),
        concurrency: 1,
        runtimePair: ["openclaw", "codex"],
        scenarioIds: ["channel-chat-baseline"],
      }),
    );
    expect(runQaFlowSuite).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        outputDir: path.join(outputDir, "flow", "isolated-2"),
        concurrency: 1,
        runtimePair: ["openclaw", "codex"],
        scenarioIds: ["matrix-allowlist-hot-reload"],
      }),
    );
    expect(runQaTestFileScenarios).not.toHaveBeenCalled();
  });

  it("runs runtime-specific channel scenarios in dedicated workers", async () => {
    const repoRoot = await makeTempRepo("qa-suite-live-runtime-");
    await runQaSuite({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/live-runtime",
      channelDriver: "live",
      channelId: "slack",
      concurrency: 4,
      scenarioIds: ["slack-canary", "slack-codex-approval-exec-native"],
    });

    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "live-runtime", "flow");
    expect(runQaFlowSuite).toHaveBeenCalledTimes(2);
    expect(runQaFlowSuite).toHaveBeenCalledWith(
      expect.objectContaining({
        outputDir: path.join(outputDir, "isolated"),
        forcedRuntime: undefined,
        scenarioIds: ["slack-canary"],
      }),
    );
    expect(runQaFlowSuite).toHaveBeenCalledWith(
      expect.objectContaining({
        outputDir: path.join(outputDir, "runtime-codex-1"),
        forcedRuntime: "codex",
        scenarioIds: ["slack-codex-approval-exec-native"],
      }),
    );
  });

  it("partitions portable scenarios by channel for a pluggable driver", async () => {
    const repoRoot = await makeTempRepo("qa-suite-pluggable-channels-");
    const adapterFactories = [
      {
        id: "portable-driver",
        matches: vi.fn(),
        create: vi.fn(),
      },
    ];

    await runQaSuite({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/pluggable-channels",
      providerMode: "mock-openai",
      channelDriver: "live",
      adapterFactories,
      scenarioIds: ["channel-chat-baseline", "telegram-help-command", "matrix-restart-resume"],
    });

    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "pluggable-channels");
    expect(runQaFlowSuite).toHaveBeenCalledTimes(3);
    expect(runQaFlowSuite).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterFactories,
        channelId: undefined,
        outputDir: path.join(outputDir, "flow"),
        scenarioIds: ["channel-chat-baseline"],
      }),
    );
    expect(runQaFlowSuite).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterFactories,
        channelId: "telegram",
        outputDir: path.join(outputDir, "flow", "telegram"),
        scenarioIds: ["telegram-help-command"],
      }),
    );
    expect(runQaFlowSuite).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterFactories,
        channelId: "matrix",
        outputDir: path.join(outputDir, "flow", "matrix"),
        scenarioIds: ["matrix-restart-resume"],
      }),
    );
  });

  it("runs distinct pluggable-driver channels within the global concurrency budget", async () => {
    const repoRoot = await makeTempRepo("qa-suite-pluggable-channel-concurrency-");
    const maxActive = trackMaxActiveFlowRuns();

    await runQaSuite({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/pluggable-channel-concurrency",
      providerMode: "mock-openai",
      channelDriver: "live",
      adapterFactories: [{ id: "portable-driver", matches: vi.fn(), create: vi.fn() }],
      concurrency: 2,
      scenarioIds: ["telegram-help-command", "matrix-restart-resume"],
    });

    expect(maxActive()).toBe(2);
  });

  it("runs isolated same-channel adapter instances at suite concurrency", async () => {
    const repoRoot = await makeTempRepo("qa-suite-pluggable-same-channel-concurrency-");
    const maxActive = trackMaxActiveFlowRuns();

    const scenarioIds = [
      "matrix-approval-channel-target-both",
      "matrix-approval-deny-reaction",
      "matrix-approval-exec-metadata-chunked",
      "matrix-approval-exec-metadata-single-event",
      "matrix-approval-plugin-metadata-single-event",
      "matrix-approval-thread-target",
    ];
    await runQaSuite({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/pluggable-same-channel-concurrency",
      providerMode: "mock-openai",
      channelDriver: "live",
      adapterFactories: [
        {
          id: "matrix",
          isolatesInstances: true,
          matches: ({ channelId, driver }) => driver === "live" && channelId === "matrix",
          create: vi.fn(),
        },
      ],
      concurrency: 6,
      scenarioIds,
    });

    expect(runQaFlowSuite).toHaveBeenCalledTimes(6);
    expect(runQaFlowSuite.mock.calls.map(([params]) => params?.scenarioIds)).toEqual(
      scenarioIds.map((scenarioId) => [scenarioId]),
    );
    expect(maxActive()).toBe(6);
  });

  it("binds one portable channel scenario without an explicit channel override", async () => {
    const adapterFactories = [
      {
        id: "portable-driver",
        matches: vi.fn(),
        create: vi.fn(),
      },
    ];

    const result = await runQaSuite({
      repoRoot: process.cwd(),
      providerMode: "mock-openai",
      channelDriver: "live",
      adapterFactories,
      scenarioIds: ["telegram-help-command"],
    });

    expect(result.executionKind).toBe("suite");
    expect(runQaFlowSuite).toHaveBeenCalledTimes(1);
    expect(runQaFlowSuite).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterFactories,
        channelId: "telegram",
        scenarioIds: ["telegram-help-command"],
      }),
    );
  });

  it("partitions mixed Crabline flow channels into one aggregate suite", async () => {
    const repoRoot = await makeTempRepo("qa-suite-crabline-channels-");
    const defaultFlowImplementation = runQaFlowSuite.getMockImplementation();
    if (!defaultFlowImplementation) {
      throw new Error("expected default QA flow suite mock implementation");
    }
    runQaFlowSuite.mockImplementation(async (params) => {
      const result = await defaultFlowImplementation(params);
      const scenarioIds: readonly string[] = params?.scenarioIds ?? [];
      result.evidence = {
        kind: "openclaw.qa.evidence-summary",
        schemaVersion: 2,
        generatedAt: "2026-06-14T00:00:00.000Z",
        evidenceMode: "full",
        entries: scenarioIds.map((scenarioId) => ({
          test: {
            kind: "qa-scenario",
            id: scenarioId,
            title: scenarioId,
          },
          coverage: [],
          execution: {
            runner: "host",
            environment: {
              ref: null,
              os: "linux",
              nodeVersion: "v24.0.0",
            },
            provider: {
              id: "mock-openai",
              live: false,
              model: {
                name: "gpt-5.6-luna",
                ref: "mock-openai/gpt-5.6-luna",
              },
              fixture: "mock-openai",
            },
            channel: {
              id: params?.channelDriverSelection?.channel ?? "qa-channel",
              live: false,
              driver: "crabline",
            },
            packageSource: {
              kind: "source-checkout",
            },
            artifacts: [
              {
                kind: "report",
                path: "qa-suite-report.md",
                source: "qa-suite",
              },
            ],
          },
          result: {
            status: "pass",
          },
        })),
      };
      return result;
    });
    const result = await runQaSuite({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/crabline-channels",
      providerMode: "mock-openai",
      channelDriver: "crabline",
      scenarioIds: ["telegram-help-command", "matrix-restart-resume"],
    });

    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "crabline-channels");
    expect(result).toMatchObject({
      executionKind: "suite",
      result: {
        evidencePath: path.join(outputDir, "qa-evidence.json"),
        summaryPath: path.join(outputDir, "qa-suite-summary.json"),
      },
    });
    expect(runQaFlowSuite).toHaveBeenCalledTimes(2);
    expect(runQaFlowSuite).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        outputDir: path.join(outputDir, "flow", "telegram"),
        channelDriverSelection: expect.objectContaining({ channel: "telegram" }),
        scenarioIds: ["telegram-help-command"],
      }),
    );
    expect(runQaFlowSuite).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        outputDir: path.join(outputDir, "flow", "matrix"),
        channelDriverSelection: expect.objectContaining({ channel: "matrix" }),
        scenarioIds: ["matrix-restart-resume"],
      }),
    );
    const summary = JSON.parse(
      await fs.readFile(path.join(outputDir, "qa-suite-summary.json"), "utf8"),
    ) as { run?: { channel?: unknown; channelDriver?: unknown; scenarioIds?: unknown } };
    expect(summary.run?.channelDriver).toBe("crabline");
    expect(summary.run?.channel).toBeNull();
    expect(summary.run?.scenarioIds).toEqual(["telegram-help-command", "matrix-restart-resume"]);
    const evidence = JSON.parse(
      await fs.readFile(path.join(outputDir, "qa-evidence.json"), "utf8"),
    ) as {
      entries?: Array<{ execution?: { artifacts?: Array<{ path?: unknown }> } }>;
    };
    expect(evidence.entries?.map((entry) => entry.execution?.artifacts?.[0]?.path)).toEqual([
      ".artifacts/qa-e2e/crabline-channels/flow/telegram/qa-suite-report.md",
      ".artifacts/qa-e2e/crabline-channels/flow/matrix/qa-suite-report.md",
    ]);
  });

  it("preserves runtime parity options across mixed Crabline flow channels", async () => {
    const repoRoot = await makeTempRepo("qa-suite-crabline-runtime-pair-");
    await runQaSuite({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/crabline-runtime-pair",
      providerMode: "mock-openai",
      channelDriver: "crabline",
      runtimePair: ["openclaw", "codex"],
      scenarioIds: ["telegram-help-command", "matrix-restart-resume"],
    });

    expect(runQaFlowSuite).toHaveBeenCalledTimes(2);
    for (const call of runQaFlowSuite.mock.calls) {
      expect(call[0]).toEqual(
        expect.objectContaining({
          runtimePair: ["openclaw", "codex"],
        }),
      );
    }
    const summary = JSON.parse(
      await fs.readFile(
        path.join(
          repoRoot,
          ".artifacts",
          "qa-e2e",
          "crabline-runtime-pair",
          "qa-suite-summary.json",
        ),
        "utf8",
      ),
    ) as { run?: { runtimePair?: unknown } };
    expect(summary.run?.runtimePair).toEqual(["openclaw", "codex"]);
    await expect(
      fs.access(
        path.join(
          repoRoot,
          ".artifacts",
          "qa-e2e",
          "crabline-runtime-pair",
          "flow",
          "telegram",
          "qa-evidence.json",
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.access(
        path.join(
          repoRoot,
          ".artifacts",
          "qa-e2e",
          "crabline-runtime-pair",
          "flow",
          "matrix",
          "qa-evidence.json",
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("routes selected Playwright scenarios to the Playwright scenario runner", async () => {
    const repoRoot = await makeTempRepo("qa-suite-launch-");
    const result = await runQaSuite({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/scenario-test",
      scenarioIds: ["control-ui-chat-flow-playwright"],
    });

    expect(result).toMatchObject({
      executionKind: "suite",
      result: {
        evidencePath: path.join(
          repoRoot,
          ".artifacts",
          "qa-e2e",
          "scenario-test",
          "qa-evidence.json",
        ),
        summaryPath: path.join(
          repoRoot,
          ".artifacts",
          "qa-e2e",
          "scenario-test",
          "qa-suite-summary.json",
        ),
      },
    });
    expect(runQaFlowSuite).not.toHaveBeenCalled();
    expect(runQaTestFileScenarios).toHaveBeenCalledTimes(1);
    const [call] = runQaTestFileScenarios.mock.calls[0] ?? [];
    expect(call).toMatchObject({
      repoRoot,
      outputDir: path.join(repoRoot, ".artifacts", "qa-e2e", "scenario-test", "playwright"),
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.6-luna",
    });
    expect(
      call.scenarios.map((scenario: { id: string; execution: { kind: string } }) => ({
        id: scenario.id,
        kind: scenario.execution.kind,
      })),
    ).toEqual([{ id: "control-ui-chat-flow-playwright", kind: "playwright" }]);
  });

  it("serializes test-file runner partitions in one checkout", async () => {
    const repoRoot = await makeTempRepo("qa-suite-test-file-serial-");
    let releaseVitest!: () => void;
    let markVitestStarted!: () => void;
    const vitestStarted = new Promise<void>((resolve) => {
      markVitestStarted = resolve;
    });
    const vitestBlocked = new Promise<void>((resolve) => {
      releaseVitest = resolve;
    });
    runQaTestFileScenarios.mockImplementationOnce(
      async (params: {
        outputDir: string;
        scenarios: Array<{ id: string; execution: { kind: "script" | "vitest" | "playwright" } }>;
      }) => {
        markVitestStarted();
        await vitestBlocked;
        const evidencePath = path.join(params.outputDir, "qa-evidence.json");
        await writeEvidence(evidencePath);
        const scenario = params.scenarios[0];
        if (!scenario) {
          throw new Error("expected scenario");
        }
        return {
          outputDir: params.outputDir,
          executionKind: scenario.execution.kind,
          evidencePath,
          results: params.scenarios.map((scenarioItem) => ({
            durationMs: 1,
            logPath: path.join(params.outputDir, `${scenarioItem.id}.log`),
            scenario: scenarioItem,
            status: "pass",
          })),
        };
      },
    );

    const runPromise = runQaSuite({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/test-file-serial",
      concurrency: 8,
      scenarioIds: ["gateway-smoke", "control-ui-chat-flow-playwright"],
    });
    await vitestStarted;
    await Promise.resolve();

    expect(runQaTestFileScenarios).toHaveBeenCalledTimes(1);

    releaseVitest();
    await runPromise;

    expect(runQaTestFileScenarios).toHaveBeenCalledTimes(2);
  });

  it("runs mixed flow and Vitest/Playwright scenarios as one suite", async () => {
    const repoRoot = await makeTempRepo("qa-suite-mixed-");
    const result = await runQaSuite({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/mixed",
      scenarioIds: ["channel-chat-baseline", "control-ui-chat-flow-playwright"],
    });

    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "mixed");
    expect(result).toMatchObject({
      executionKind: "suite",
      result: {
        evidencePath: path.join(outputDir, "qa-evidence.json"),
        summaryPath: path.join(outputDir, "qa-suite-summary.json"),
      },
    });
    expect(runQaFlowSuite).toHaveBeenCalledWith(
      expect.objectContaining({
        outputDir: path.join(outputDir, "flow"),
        scenarioIds: ["channel-chat-baseline"],
        writeEvidenceFile: false,
      }),
    );
    expect(runQaTestFileScenarios).toHaveBeenCalledWith(
      expect.objectContaining({
        outputDir: path.join(outputDir, "playwright"),
        writeEvidenceFile: false,
      }),
    );
    await expect(fs.access(path.join(outputDir, "qa-suite-summary.json"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(outputDir, "qa-evidence.json"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(outputDir, "flow", "qa-evidence.json"))).rejects.toMatchObject(
      {
        code: "ENOENT",
      },
    );
    await expect(
      fs.access(path.join(outputDir, "playwright", "qa-evidence.json")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    const summary = JSON.parse(
      await fs.readFile(path.join(outputDir, "qa-suite-summary.json"), "utf8"),
    ) as {
      run?: { scenarioIds?: unknown };
      scenarios?: Array<{ details?: unknown; name?: unknown; status?: unknown }>;
    };
    expect(summary.run?.scenarioIds).toEqual([
      "channel-chat-baseline",
      "control-ui-chat-flow-playwright",
    ]);
    expect(summary.scenarios).toMatchObject([
      { name: "channel-chat-baseline", status: "pass" },
      { name: "Control UI chat flow Playwright coverage", status: "pass" },
    ]);
    expect(JSON.stringify(summary)).not.toContain(repoRoot);
    expect(summary.scenarios?.[1]?.details).toContain(
      "log=.artifacts/qa-e2e/mixed/playwright/control-ui-chat-flow-playwright.log",
    );
  });

  it("keeps channel-driver unified flow partitions serial by default", async () => {
    const repoRoot = await makeTempRepo("qa-suite-crabline-serial-");
    await runQaSuite({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/crabline-serial",
      channelDriverSelection: {
        capabilityMatrixPath: "crabline-fake-provider-capabilities.json",
        channel: "telegram",
        channelDriver: "crabline",
        smokeArtifactPath: "crabline-fake-provider-smoke.json",
      },
      scenarioIds: ["telegram-help-command", "dm-chat-baseline", "control-ui-chat-flow-playwright"],
    });

    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "crabline-serial");
    expect(runQaFlowSuite).toHaveBeenCalledTimes(1);
    expect(runQaFlowSuite).toHaveBeenCalledWith(
      expect.objectContaining({
        outputDir: path.join(outputDir, "flow"),
        concurrency: 1,
        scenarioIds: ["telegram-help-command", "dm-chat-baseline"],
      }),
    );
    expect(runQaTestFileScenarios).toHaveBeenCalledTimes(1);
  });

  it("serializes channel-driver isolated flow workers under explicit concurrency", async () => {
    const repoRoot = await makeTempRepo("qa-suite-crabline-isolated-");
    const defaultFlowImplementation = runQaFlowSuite.getMockImplementation();
    if (!defaultFlowImplementation) {
      throw new Error("expected default QA flow suite mock implementation");
    }
    const isolatedScenarioIds = new Set([
      "runtime-tool-image-generate",
      "runtime-inventory-drift-check",
      "session-memory-ranking",
    ]);
    let activeIsolatedWorkers = 0;
    let maxActiveIsolatedWorkers = 0;
    runQaFlowSuite.mockImplementation(
      async (
        params:
          | { outputDir?: string; scenarioIds?: string[]; writeEvidenceFile?: boolean }
          | undefined,
      ) => {
        const scenarioIds = params?.scenarioIds ?? [];
        const isolatedWorker = scenarioIds.some((scenarioId) =>
          isolatedScenarioIds.has(scenarioId),
        );
        if (!isolatedWorker) {
          return await defaultFlowImplementation(params);
        }
        activeIsolatedWorkers += 1;
        maxActiveIsolatedWorkers = Math.max(maxActiveIsolatedWorkers, activeIsolatedWorkers);
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 1);
        });
        try {
          return await defaultFlowImplementation(params);
        } finally {
          activeIsolatedWorkers -= 1;
        }
      },
    );

    await runQaSuite({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/crabline-isolated",
      channelDriverSelection: {
        capabilityMatrixPath: "crabline-fake-provider-capabilities.json",
        channel: "telegram",
        channelDriver: "crabline",
        smokeArtifactPath: "crabline-fake-provider-smoke.json",
      },
      concurrency: 8,
      scenarioIds: [
        "dm-chat-baseline",
        "runtime-tool-image-generate",
        "runtime-inventory-drift-check",
        "session-memory-ranking",
        "control-ui-chat-flow-playwright",
      ],
    });

    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "crabline-isolated");
    expect(runQaFlowSuite).toHaveBeenCalledTimes(4);
    expect(runQaFlowSuite).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        outputDir: path.join(outputDir, "flow", "shared"),
        concurrency: 1,
        scenarioIds: ["dm-chat-baseline"],
      }),
    );
    for (const [index, scenarioId] of [
      "runtime-tool-image-generate",
      "runtime-inventory-drift-check",
      "session-memory-ranking",
    ].entries()) {
      expect(runQaFlowSuite).toHaveBeenNthCalledWith(
        index + 2,
        expect.objectContaining({
          outputDir: path.join(outputDir, "flow", `isolated-${index + 1}`),
          concurrency: 1,
          scenarioIds: [scenarioId],
        }),
      );
    }
    expect(runQaTestFileScenarios).toHaveBeenCalledTimes(1);
    expect(maxActiveIsolatedWorkers).toBe(1);
  });

  it("respects serial concurrency across unified suite partitions", async () => {
    const repoRoot = await makeTempRepo("qa-suite-serial-");
    let releaseFlow!: () => void;
    let markFlowStarted!: () => void;
    const flowStarted = new Promise<void>((resolve) => {
      markFlowStarted = resolve;
    });
    const flowBlocked = new Promise<void>((resolve) => {
      releaseFlow = resolve;
    });
    runQaFlowSuite.mockImplementationOnce(
      async (params: { outputDir?: string; scenarioIds?: string[] } | undefined) => {
        markFlowStarted();
        await flowBlocked;
        const outputDir = params?.outputDir ?? "/tmp/qa-flow";
        const evidencePath = path.join(outputDir, "qa-evidence.json");
        await writeEvidence(evidencePath);
        const scenarioIds = params?.scenarioIds ?? ["channel-chat-baseline"];
        return {
          outputDir,
          evidencePath,
          reportPath: path.join(outputDir, "qa-suite-report.md"),
          summaryPath: path.join(outputDir, "qa-suite-summary.json"),
          report: "# QA Suite Report\n",
          scenarios: scenarioIds.map((scenarioId) => ({
            name: scenarioId,
            status: "pass",
            steps: [],
          })),
          watchUrl: "http://127.0.0.1:43124",
        };
      },
    );

    const runPromise = runQaSuite({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/serial",
      concurrency: 1,
      scenarioIds: [
        "dm-chat-baseline",
        "group-visible-reply-tool",
        "control-ui-chat-flow-playwright",
      ],
    });
    await flowStarted;
    await Promise.resolve();

    expect(runQaFlowSuite).toHaveBeenCalledTimes(1);
    expect(runQaTestFileScenarios).not.toHaveBeenCalled();

    releaseFlow();
    await runPromise;

    expect(runQaFlowSuite).toHaveBeenCalledTimes(2);
    expect(runQaTestFileScenarios).toHaveBeenCalledTimes(1);
  });

  it("runs script scenarios after flow Gateways stop without serializing Playwright", async () => {
    const repoRoot = await makeTempRepo("qa-suite-script-isolation-");
    let releaseFlow!: () => void;
    let markFlowStarted!: () => void;
    const flowStarted = new Promise<void>((resolve) => {
      markFlowStarted = resolve;
    });
    const flowBlocked = new Promise<void>((resolve) => {
      releaseFlow = resolve;
    });
    runQaFlowSuite.mockImplementationOnce(
      async (params: { outputDir?: string; scenarioIds?: string[] } | undefined) => {
        markFlowStarted();
        await flowBlocked;
        const outputDir = params?.outputDir ?? "/tmp/qa-flow";
        const evidencePath = path.join(outputDir, "qa-evidence.json");
        await writeEvidence(evidencePath);
        const scenarioIds = params?.scenarioIds ?? ["channel-chat-baseline"];
        return {
          outputDir,
          evidencePath,
          reportPath: path.join(outputDir, "qa-suite-report.md"),
          summaryPath: path.join(outputDir, "qa-suite-summary.json"),
          report: "# QA Suite Report\n",
          scenarios: scenarioIds.map((scenarioId) => ({
            name: scenarioId,
            status: "pass",
            steps: [],
          })),
          watchUrl: "http://127.0.0.1:43124",
        };
      },
    );

    const runPromise = runQaSuite({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/script-isolation",
      concurrency: 8,
      scenarioIds: [
        "dm-chat-baseline",
        "control-ui-chat-flow-playwright",
        "docker-npm-onboard-channel-agent",
      ],
    });
    await flowStarted;
    await vi.waitFor(() => {
      expect(runQaTestFileScenarios).toHaveBeenCalledTimes(1);
    });

    expect(runQaTestFileScenarios).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        scenarios: [
          expect.objectContaining({ execution: expect.objectContaining({ kind: "playwright" }) }),
        ],
      }),
    );

    releaseFlow();
    await runPromise;

    expect(runQaTestFileScenarios).toHaveBeenCalledTimes(2);
    expect(runQaTestFileScenarios).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        scenarios: [
          expect.objectContaining({ execution: expect.objectContaining({ kind: "script" }) }),
        ],
      }),
    );
  });

  it("keeps multiple isolated flow scenarios in separate serial partitions", async () => {
    const repoRoot = await makeTempRepo("qa-suite-serial-isolated-");
    await runQaSuite({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/serial-isolated",
      concurrency: 1,
      scenarioIds: [
        "group-visible-reply-tool",
        "runtime-tool-image-generate",
        "control-ui-chat-flow-playwright",
      ],
    });

    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "serial-isolated");
    expect(runQaFlowSuite).toHaveBeenCalledTimes(2);
    expect(runQaFlowSuite).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        outputDir: path.join(outputDir, "flow", "isolated-1"),
        concurrency: 1,
        workerStartStaggerMs: 0,
        scenarioIds: ["group-visible-reply-tool"],
      }),
    );
    expect(runQaFlowSuite).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        outputDir: path.join(outputDir, "flow", "isolated-2"),
        concurrency: 1,
        workerStartStaggerMs: 0,
        scenarioIds: ["runtime-tool-image-generate"],
      }),
    );
    expect(runQaTestFileScenarios).toHaveBeenCalledTimes(1);
  });

  it("accounts for isolated flow worker weight in unified suite concurrency", async () => {
    const repoRoot = await makeTempRepo("qa-suite-weighted-");
    let releaseShared!: () => void;
    let markSharedStarted!: () => void;
    const sharedStarted = new Promise<void>((resolve) => {
      markSharedStarted = resolve;
    });
    const sharedBlocked = new Promise<void>((resolve) => {
      releaseShared = resolve;
    });
    runQaFlowSuite.mockImplementationOnce(
      async (params: { outputDir?: string; scenarioIds?: string[] } | undefined) => {
        markSharedStarted();
        await sharedBlocked;
        const outputDir = params?.outputDir ?? "/tmp/qa-flow";
        const evidencePath = path.join(outputDir, "qa-evidence.json");
        await writeEvidence(evidencePath);
        const scenarioIds = params?.scenarioIds ?? ["channel-chat-baseline"];
        return {
          outputDir,
          evidencePath,
          reportPath: path.join(outputDir, "qa-suite-report.md"),
          summaryPath: path.join(outputDir, "qa-suite-summary.json"),
          report: "# QA Suite Report\n",
          scenarios: scenarioIds.map((scenarioId) => ({
            name: scenarioId,
            status: "pass",
            steps: [],
          })),
          watchUrl: "http://127.0.0.1:43124",
        };
      },
    );

    const runPromise = runQaSuite({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/weighted",
      concurrency: 3,
      scenarioIds: [
        "dm-chat-baseline",
        "group-visible-reply-tool",
        "control-ui-chat-flow-playwright",
      ],
    });
    await sharedStarted;
    await Promise.resolve();

    expect(runQaFlowSuite).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => {
      expect(runQaTestFileScenarios).toHaveBeenCalledTimes(1);
    });

    releaseShared();
    await runPromise;

    expect(runQaFlowSuite).toHaveBeenCalledTimes(2);
    expect(runQaTestFileScenarios).toHaveBeenCalledTimes(1);
  });

  it("starts native suite proof before isolated flow work fills the weighted queue", async () => {
    const repoRoot = await makeTempRepo("qa-suite-native-before-isolated-");
    let releaseShared!: () => void;
    let markSharedStarted!: () => void;
    const sharedStarted = new Promise<void>((resolve) => {
      markSharedStarted = resolve;
    });
    const sharedBlocked = new Promise<void>((resolve) => {
      releaseShared = resolve;
    });
    let releaseTestFile!: () => void;
    let markTestFileStarted!: () => void;
    const testFileStarted = new Promise<void>((resolve) => {
      markTestFileStarted = resolve;
    });
    const testFileBlocked = new Promise<void>((resolve) => {
      releaseTestFile = resolve;
    });
    runQaFlowSuite.mockImplementationOnce(
      async (params: { outputDir?: string; scenarioIds?: string[] } | undefined) => {
        markSharedStarted();
        await sharedBlocked;
        const outputDir = params?.outputDir ?? "/tmp/qa-flow";
        const evidencePath = path.join(outputDir, "qa-evidence.json");
        await writeEvidence(evidencePath);
        const scenarioIds = params?.scenarioIds ?? ["channel-chat-baseline"];
        return {
          outputDir,
          evidencePath,
          reportPath: path.join(outputDir, "qa-suite-report.md"),
          summaryPath: path.join(outputDir, "qa-suite-summary.json"),
          report: "# QA Suite Report\n",
          scenarios: scenarioIds.map((scenarioId) => ({
            name: scenarioId,
            status: "pass",
            steps: [],
          })),
          watchUrl: "http://127.0.0.1:43124",
        };
      },
    );
    runQaTestFileScenarios.mockImplementationOnce(
      async (params: {
        outputDir: string;
        scenarios: Array<{ id: string; execution: { kind: "script" | "vitest" | "playwright" } }>;
      }) => {
        markTestFileStarted();
        await testFileBlocked;
        const evidencePath = path.join(params.outputDir, "qa-evidence.json");
        await writeEvidence(evidencePath);
        return {
          outputDir: params.outputDir,
          executionKind: params.scenarios[0]?.execution.kind ?? "playwright",
          evidencePath,
          results: params.scenarios.map((scenarioItem) => ({
            durationMs: 1,
            logPath: path.join(params.outputDir, `${scenarioItem.id}.log`),
            scenario: scenarioItem,
            status: "pass",
          })),
        };
      },
    );

    const runPromise = runQaSuite({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/native-before-isolated",
      concurrency: 2,
      scenarioIds: [
        "dm-chat-baseline",
        "group-visible-reply-tool",
        "control-ui-chat-flow-playwright",
      ],
    });
    await sharedStarted;
    await testFileStarted;
    await Promise.resolve();

    expect(runQaFlowSuite).toHaveBeenCalledTimes(1);
    expect(runQaTestFileScenarios).toHaveBeenCalledTimes(1);

    releaseTestFile();
    releaseShared();
    await runPromise;

    expect(runQaFlowSuite).toHaveBeenCalledTimes(2);
  });

  it("waits for already-started partitions before rejecting a unified suite", async () => {
    const repoRoot = await makeTempRepo("qa-suite-reject-settle-");
    let releaseTestFile!: () => void;
    let markTestFileStarted!: () => void;
    const testFileStarted = new Promise<void>((resolve) => {
      markTestFileStarted = resolve;
    });
    const testFileBlocked = new Promise<void>((resolve) => {
      releaseTestFile = resolve;
    });
    runQaFlowSuite.mockRejectedValueOnce(
      new Error("flow partition failed", {
        cause: Object.assign(new Error("unrelated capacity failure"), {
          code: "POOL_EXHAUSTED",
        }),
      }),
    );
    runQaTestFileScenarios.mockImplementationOnce(
      async (params: {
        outputDir: string;
        scenarios: Array<{ id: string; execution: { kind: "script" | "vitest" | "playwright" } }>;
      }) => {
        markTestFileStarted();
        await testFileBlocked;
        const evidencePath = path.join(params.outputDir, "qa-evidence.json");
        await writeEvidence(evidencePath);
        return {
          outputDir: params.outputDir,
          executionKind: params.scenarios[0]?.execution.kind ?? "playwright",
          evidencePath,
          results: params.scenarios.map((scenarioItem) => ({
            durationMs: 1,
            logPath: path.join(params.outputDir, `${scenarioItem.id}.log`),
            scenario: scenarioItem,
            status: "pass",
          })),
        };
      },
    );

    const runPromise = runQaSuite({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/reject-settle",
      concurrency: 2,
      scenarioIds: ["channel-chat-baseline", "control-ui-chat-flow-playwright"],
    });
    let rejected = false;
    void runPromise.catch(() => {
      rejected = true;
    });
    await testFileStarted;
    await Promise.resolve();

    expect(rejected).toBe(false);

    releaseTestFile();
    await expect(runPromise).rejects.toThrow("flow partition failed");
    expect(rejected).toBe(true);
  });

  it("reuses unavailable channel credential evidence across serial partitions", async () => {
    const repoRoot = await makeTempRepo("qa-suite-credential-unavailable-");
    const poolError = Object.assign(new Error("no WhatsApp credential is available"), {
      code: "POOL_EXHAUSTED",
    });
    runQaFlowSuite.mockRejectedValueOnce(
      new Error("failed to create QA transport live:whatsapp: credential acquire failed", {
        cause: new Error("credential acquire timed out", { cause: poolError }),
      }),
    );

    const result = await runQaSuite({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/credential-unavailable",
      providerMode: "mock-openai",
      channelDriver: "live",
      adapterFactories: [{ id: "whatsapp", matches: () => true, create: vi.fn() }],
      scenarioIds: [
        "whatsapp-status-command",
        "whatsapp-access-control-dm-open",
        "control-ui-chat-flow-playwright",
      ],
    });

    expect(result.executionKind).toBe("suite");
    if (result.executionKind !== "suite") {
      throw new Error("expected unified suite result");
    }
    expect(runQaFlowSuite).toHaveBeenCalledTimes(1);
    expect(result.result.scenarios.slice(0, 2)).toMatchObject([
      { status: "fail", details: expect.stringContaining("channel credential unavailable") },
      { status: "fail", details: expect.stringContaining("channel credential unavailable") },
    ]);
    const evidence = JSON.parse(await fs.readFile(result.result.evidencePath, "utf8")) as {
      entries?: Array<{
        execution?: { channel?: { id?: string } };
        result?: { status?: string };
        test?: { id?: string };
      }>;
    };
    for (const scenarioId of ["whatsapp-status-command", "whatsapp-access-control-dm-open"]) {
      const blocked = evidence.entries?.find((entry) => entry.test?.id === scenarioId);
      expect(blocked).toMatchObject({
        execution: { channel: { id: "whatsapp" } },
        result: { status: "blocked" },
      });
    }
  });

  it("shares ordinary flow scenarios and isolates flow scenarios with config patches", async () => {
    const repoRoot = await makeTempRepo("qa-suite-partition-");
    const result = await runQaSuite({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/smoke",
      concurrency: 8,
      scenarioIds: [
        "dm-chat-baseline",
        "group-visible-reply-tool",
        "control-ui-chat-flow-playwright",
      ],
    });

    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "smoke");
    expect(result.executionKind).toBe("suite");
    expect(runQaFlowSuite).toHaveBeenCalledTimes(2);
    expect(runQaFlowSuite).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        outputDir: path.join(outputDir, "flow", "shared"),
        concurrency: 1,
        scenarioIds: ["dm-chat-baseline"],
      }),
    );
    expect(runQaFlowSuite).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        outputDir: path.join(outputDir, "flow", "isolated"),
        concurrency: 1,
        workerStartStaggerMs: 0,
        scenarioIds: ["group-visible-reply-tool"],
      }),
    );
    const summary = JSON.parse(
      await fs.readFile(path.join(outputDir, "qa-suite-summary.json"), "utf8"),
    ) as {
      scenarios?: Array<{ name?: unknown; status?: unknown }>;
    };
    expect(summary.scenarios).toMatchObject([
      { name: "dm-chat-baseline", status: "pass" },
      { name: "group-visible-reply-tool", status: "pass" },
      { name: "Control UI chat flow Playwright coverage", status: "pass" },
    ]);
  });

  it("spreads ordinary flow scenarios across bounded shared batches", async () => {
    const repoRoot = await makeTempRepo("qa-suite-shared-batches-");
    await runQaSuite({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/smoke",
      concurrency: 8,
      scenarioIds: [
        "telegram-help-command",
        "dm-chat-baseline",
        "thread-follow-up",
        "control-ui-chat-flow-playwright",
      ],
    });

    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "smoke");
    expect(runQaFlowSuite).toHaveBeenCalledTimes(3);
    expect(runQaFlowSuite).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        outputDir: path.join(outputDir, "flow", "shared-1"),
        concurrency: 1,
        scenarioIds: ["telegram-help-command"],
      }),
    );
    expect(runQaFlowSuite).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        outputDir: path.join(outputDir, "flow", "shared-2"),
        concurrency: 1,
        scenarioIds: ["dm-chat-baseline"],
      }),
    );
    expect(runQaFlowSuite).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        outputDir: path.join(outputDir, "flow", "shared-3"),
        concurrency: 1,
        scenarioIds: ["thread-follow-up"],
      }),
    );
  });

  it("isolates flow scenarios that mutate shared runtime state", async () => {
    const repoRoot = await makeTempRepo("qa-suite-shared-state-");
    await runQaSuite({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/smoke",
      concurrency: 8,
      scenarioIds: [
        "dm-chat-baseline",
        "runtime-tool-image-generate",
        "runtime-inventory-drift-check",
        "session-memory-ranking",
        "control-ui-chat-flow-playwright",
      ],
    });

    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "smoke");
    expect(runQaFlowSuite).toHaveBeenCalledTimes(2);
    expect(runQaFlowSuite).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        outputDir: path.join(outputDir, "flow", "shared"),
        concurrency: 1,
        scenarioIds: ["dm-chat-baseline"],
      }),
    );
    expect(runQaFlowSuite).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        outputDir: path.join(outputDir, "flow", "isolated"),
        concurrency: 3,
        workerStartStaggerMs: 1_500,
        scenarioIds: [
          "runtime-tool-image-generate",
          "runtime-inventory-drift-check",
          "session-memory-ranking",
        ],
      }),
    );
  });

  it("isolates flow scenarios that restart after state mutations", async () => {
    const repoRoot = await makeTempRepo("qa-suite-gateway-state-");
    await runQaSuite({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/gateway-state",
      concurrency: 8,
      scenarioIds: [
        "dm-chat-baseline",
        "subagent-stale-child-links",
        "control-ui-chat-flow-playwright",
      ],
    });

    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "gateway-state");
    expect(runQaFlowSuite).toHaveBeenCalledTimes(2);
    expect(runQaFlowSuite).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        outputDir: path.join(outputDir, "flow", "shared"),
        scenarioIds: ["dm-chat-baseline"],
      }),
    );
    expect(runQaFlowSuite).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        outputDir: path.join(outputDir, "flow", "isolated"),
        scenarioIds: ["subagent-stale-child-links"],
      }),
    );
  });

  it("preserves configured isolated worker start stagger overrides", async () => {
    vi.stubEnv("OPENCLAW_QA_SUITE_WORKER_START_STAGGER_MS", "2500");
    const repoRoot = await makeTempRepo("qa-suite-stagger-env-");
    await runQaSuite({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/stagger-env",
      concurrency: 8,
      scenarioIds: [
        "runtime-tool-image-generate",
        "runtime-inventory-drift-check",
        "session-memory-ranking",
        "control-ui-chat-flow-playwright",
      ],
    });

    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "stagger-env");
    expect(runQaFlowSuite).toHaveBeenCalledWith(
      expect.objectContaining({
        outputDir: path.join(outputDir, "flow"),
        concurrency: 3,
        workerStartStaggerMs: 2500,
        scenarioIds: [
          "runtime-tool-image-generate",
          "runtime-inventory-drift-check",
          "session-memory-ranking",
        ],
      }),
    );
  });

  it("rejects runtime-pair requests for Vitest/Playwright scenarios", async () => {
    await expect(
      runQaSuite({
        repoRoot: process.cwd(),
        runtimePair: ["openclaw", "codex"],
        scenarioIds: ["control-ui-chat-flow-playwright"],
      }),
    ).rejects.toThrow("--runtime-pair requires execution.kind: flow scenarios");

    expect(runQaFlowSuite).not.toHaveBeenCalled();
    expect(runQaTestFileScenarios).not.toHaveBeenCalled();
  });

  it("rejects repo-local symlink output directories before running Vitest/Playwright scenarios", async () => {
    const repoRoot = await makeTempRepo("qa-suite-symlink-root-");
    const outsideRoot = await makeTempRepo("qa-suite-symlink-outside-");
    await fs.symlink(outsideRoot, path.join(repoRoot, "artifacts-link"));

    await expect(
      runQaSuite({
        repoRoot,
        outputDir: "artifacts-link/qa-out",
        scenarioIds: ["control-ui-chat-flow-playwright"],
      }),
    ).rejects.toThrow("QA suite outputDir must not traverse symlinks");

    expect(runQaFlowSuite).not.toHaveBeenCalled();
    expect(runQaTestFileScenarios).not.toHaveBeenCalled();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

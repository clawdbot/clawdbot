import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QaSuiteInfraError } from "./errors.js";
import type { QaLabServerHandle } from "./lab-server.types.js";
import type { QaTransportAdapter } from "./qa-transport.js";
import { writeQaSuiteArtifacts } from "./suite-artifacts.js";
import { makeQaSuiteTestScenario } from "./suite-test-helpers.js";
import type { QaSuiteRunParams, QaSuiteScenarioResult } from "./suite.js";
import { throwQaSuiteCleanupErrors } from "./suite.js";
import type {
  QaTestFileScenario,
  QaTestFileScenarioRunResult,
} from "./test-file-scenario-runner.js";

const {
  crablineRuntimeLoads,
  prepareDockerE2eEnvironment,
  replaceFileAtomicMock,
  runQaFlowSuite,
  runQaTestFileScenarios,
} = vi.hoisted(() => ({
  crablineRuntimeLoads: vi.fn(),
  prepareDockerE2eEnvironment: vi.fn(),
  replaceFileAtomicMock: vi.fn(),
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

vi.mock("./test-file-scenario-docker-batch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./test-file-scenario-docker-batch.js")>()),
  prepareDockerE2eEnvironment,
}));

vi.mock("openclaw/plugin-sdk/security-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/security-runtime")>();
  replaceFileAtomicMock.mockImplementation(actual.replaceFileAtomic);
  return { ...actual, replaceFileAtomic: replaceFileAtomicMock };
});

import { runQaSuite, runQaSuiteWithInfraRetry } from "./suite-launch.runtime.js";

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

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function requireDefaultQaFlowSuiteImplementation() {
  const implementation = runQaFlowSuite.getMockImplementation();
  if (!implementation) {
    throw new Error("expected default QA flow suite mock implementation");
  }
  return implementation;
}

function requireDefaultQaTestFileImplementation() {
  const implementation = runQaTestFileScenarios.getMockImplementation();
  if (!implementation) {
    throw new Error("expected default QA test-file mock implementation");
  }
  return implementation;
}

function blockNextQaFlowSuite() {
  const implementation = requireDefaultQaFlowSuiteImplementation();
  const started = createDeferred();
  const blocked = createDeferred();
  runQaFlowSuite.mockImplementationOnce(async (params) => {
    started.resolve();
    await blocked.promise;
    return await implementation(params);
  });
  return { started: started.promise, release: blocked.resolve };
}

function blockNextQaTestFileRun() {
  const implementation = requireDefaultQaTestFileImplementation();
  const started = createDeferred();
  const blocked = createDeferred();
  runQaTestFileScenarios.mockImplementationOnce(async (params) => {
    started.resolve();
    await blocked.promise;
    return await implementation(params);
  });
  return { started: started.promise, release: blocked.resolve };
}

async function runFailFastQaSuite(label: string, overrides: QaSuiteRunParams = {}) {
  return await runQaSuite({
    repoRoot: await makeTempRepo(`qa-suite-${label}-`),
    outputDir: `.artifacts/qa-e2e/${label}`,
    concurrency: 8,
    failFast: true,
    scenarioIds: [
      "dm-chat-baseline",
      "group-visible-reply-tool",
      "control-ui-chat-flow-playwright",
      "docker-npm-onboard-channel-agent",
    ],
    ...overrides,
  });
}

function trackMaxActiveFlowRuns() {
  const run = requireDefaultQaFlowSuiteImplementation();
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

function mockFlowPartitionFailures(failuresByScenarioId: ReadonlyMap<string, readonly Error[]>) {
  const run = requireDefaultQaFlowSuiteImplementation();
  const attempts = new Map<string, number>();
  runQaFlowSuite.mockImplementation(async (params) => {
    const scenarioId = params?.scenarioIds?.[0];
    if (!scenarioId) {
      throw new Error("expected one scenario per flow partition");
    }
    const attempt = (attempts.get(scenarioId) ?? 0) + 1;
    attempts.set(scenarioId, attempt);
    const failure = failuresByScenarioId.get(scenarioId)?.[attempt - 1];
    if (failure) {
      throw failure;
    }
    return await run(params);
  });
  return attempts;
}

async function expectArtifactPublicationFailurePreservesPrior(params: {
  canonicalFileNames: readonly string[];
  failedFileName: string;
  outputDir: string;
  publish: () => Promise<unknown>;
}) {
  const sentinels = new Map(
    params.canonicalFileNames.map((fileName) => [fileName, `prior ${fileName}\n`]),
  );
  await fs.mkdir(params.outputDir, { recursive: true, mode: 0o750 });
  await fs.chmod(params.outputDir, 0o750);
  for (const [fileName, sentinel] of sentinels) {
    const finalPath = path.join(params.outputDir, fileName);
    await fs.writeFile(finalPath, sentinel, { encoding: "utf8", mode: 0o640 });
    await fs.chmod(finalPath, 0o640);
  }
  const actualSecurityRuntime = await vi.importActual<
    typeof import("openclaw/plugin-sdk/security-runtime")
  >("openclaw/plugin-sdk/security-runtime");
  const publicationOrder: string[] = [];
  const failSelectedArtifact = async (options: Parameters<typeof replaceFileAtomicMock>[0]) => {
    publicationOrder.push(path.basename(options.filePath));
    return await actualSecurityRuntime.replaceFileAtomic({
      ...options,
      ...(path.basename(options.filePath) === params.failedFileName
        ? {
            beforeRename: async ({ tempPath }: { tempPath: string }) => {
              await fs.writeFile(tempPath, "partial replacement\n", "utf8");
              throw Object.assign(new Error("injected QA artifact publication failure"), {
                code: "EIO",
              });
            },
          }
        : {}),
    });
  };

  await replaceFileAtomicMock.withImplementation(failSelectedArtifact, async () => {
    await expect(params.publish()).rejects.toMatchObject({ code: "EIO" });
  });

  const selectedPath = path.join(params.outputDir, params.failedFileName);
  await expect(fs.readFile(selectedPath, "utf8")).resolves.toBe(
    sentinels.get(params.failedFileName),
  );
  if (process.platform !== "win32") {
    expect((await fs.stat(selectedPath)).mode & 0o777).toBe(0o640);
    expect((await fs.stat(params.outputDir)).mode & 0o7777).toBe(0o750);
  }
  const selectedIndex = params.canonicalFileNames.indexOf(params.failedFileName);
  expect(publicationOrder).toEqual(params.canonicalFileNames.slice(0, selectedIndex + 1));
  expect(
    (await fs.readdir(params.outputDir)).filter((entry) =>
      entry.startsWith(`${params.failedFileName}.qa-artifact.`),
    ),
  ).toEqual([]);
}

describe("qa suite runtime launcher", () => {
  beforeEach(() => {
    replaceFileAtomicMock.mockClear();
    runQaFlowSuite.mockReset();
    runQaTestFileScenarios.mockReset();
    prepareDockerE2eEnvironment.mockReset();
    prepareDockerE2eEnvironment.mockResolvedValue(undefined);
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
          startedScenarioIds: scenarioIds,
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

  it("forces the declared runtime for a single runtime-specific flow scenario", async () => {
    const repoRoot = await makeTempRepo("qa-suite-single-codex-runtime-");
    const result = await runQaSuite({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/single-codex-runtime",
      providerMode: "live-frontier",
      scenarioIds: ["long-context-progress-watchdog"],
    });

    expect(result.executionKind).toBe("suite");
    expect(runQaFlowSuite).toHaveBeenCalledTimes(1);
    expect(runQaFlowSuite).toHaveBeenCalledWith(
      expect.objectContaining({
        forcedRuntime: "codex",
        scenarioIds: ["long-context-progress-watchdog"],
      }),
    );
    expect(runQaTestFileScenarios).not.toHaveBeenCalled();
  });

  it("retries a flow-only suite once for retryable infrastructure failures", async () => {
    const attempts = mockFlowPartitionFailures(
      new Map([
        [
          "channel-chat-baseline",
          [new QaSuiteInfraError("agent_wait_failed", "agent.wait failed")],
        ],
      ]),
    );
    const stderrWrite = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    try {
      const result = await runQaSuite({
        repoRoot: process.cwd(),
        providerMode: "mock-openai",
        scenarioIds: ["channel-chat-baseline"],
      });

      expect(result.executionKind).toBe("flow");
      expect(attempts.get("channel-chat-baseline")).toBe(2);
      expect(stderrWrite.mock.calls.flat().join("")).toContain(
        "[qa-suite] infra retry 1/1: agent.wait failed",
      );
    } finally {
      stderrWrite.mockRestore();
    }
  });

  it("retries a cleanup-only ECONNRESET through its preserved cause", async () => {
    const cleanupError = Object.assign(new Error("cleanup socket reset"), {
      code: "ECONNRESET",
    });
    const stderrWrite = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    let attempts = 0;

    try {
      const result = await runQaSuiteWithInfraRetry(async () => {
        attempts += 1;
        if (attempts === 1) {
          throwQaSuiteCleanupErrors({
            cleanupFailures: [{ phase: "lab stop", error: cleanupError }],
            runFailed: false,
            runError: undefined,
          });
        }
        return "retried";
      }, 1);

      expect(result).toBe("retried");
      expect(attempts).toBe(2);
      expect(stderrWrite.mock.calls.flat().join("")).toContain("[qa-suite] infra retry 1/1:");
    } finally {
      stderrWrite.mockRestore();
    }
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

  it("expands profile scenarios across every eligible pluggable channel", async () => {
    const repoRoot = await makeTempRepo("qa-suite-pluggable-channels-");
    const defaultFlowImplementation = requireDefaultQaFlowSuiteImplementation();
    runQaFlowSuite.mockImplementation(async (params) => {
      const result = await defaultFlowImplementation(params);
      if (params?.channelId === "matrix" && params.scenarioIds?.includes("thread-isolation")) {
        result.scenarios[0] = {
          ...result.scenarios[0],
          status: "fail",
        };
      }
      return result;
    });
    const adapterFactories = [
      {
        id: "portable-driver",
        matches: vi.fn(({ channelId }) => ["matrix", "slack", "telegram"].includes(channelId)),
        create: vi.fn(),
      },
    ];

    const result = await runQaSuite({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/pluggable-channels",
      providerMode: "mock-openai",
      channelDriver: "live",
      adapterFactories,
      expandScenarioChannels: true,
      scenarioIds: [
        "channel-chat-baseline",
        "telegram-help-command",
        "matrix-restart-resume",
        "thread-isolation",
      ],
    });

    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "pluggable-channels");
    expect(runQaFlowSuite).toHaveBeenCalledTimes(5);
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
        outputDir: path.join(outputDir, "flow", "matrix-isolated-1"),
        scenarioIds: ["matrix-restart-resume"],
      }),
    );
    expect(runQaFlowSuite).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterFactories,
        channelId: "slack",
        scenarioIds: ["thread-isolation"],
      }),
    );
    expect(runQaFlowSuite).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterFactories,
        channelId: "matrix",
        outputDir: path.join(outputDir, "flow", "matrix-isolated-2"),
        scenarioIds: ["thread-isolation"],
      }),
    );
    expect(result.executionKind).toBe("suite");
    if (result.executionKind !== "suite") {
      throw new Error("expected unified suite result");
    }
    expect(result.result.scenarios.map((scenario) => scenario.name)).toContain(
      "thread-isolation [slack]",
    );
    expect(result.result.scenarios.map((scenario) => scenario.name)).toContain(
      "thread-isolation [matrix]",
    );
    expect(
      result.result.scenarios.find((scenario) => scenario.name === "thread-isolation [slack]"),
    ).toMatchObject({ status: "pass" });
    expect(
      result.result.scenarios.find((scenario) => scenario.name === "thread-isolation [matrix]"),
    ).toMatchObject({ status: "fail" });
    expect(result.observedCells).toEqual(
      expect.arrayContaining([
        { scenarioId: "channel-chat-baseline", executionKind: "flow", channel: null },
        { scenarioId: "telegram-help-command", executionKind: "flow", channel: "telegram" },
        { scenarioId: "matrix-restart-resume", executionKind: "flow", channel: "matrix" },
        { scenarioId: "thread-isolation", executionKind: "flow", channel: "slack" },
        { scenarioId: "thread-isolation", executionKind: "flow", channel: "matrix" },
      ]),
    );
  });

  it("uses one eligible channel outside profile execution", async () => {
    const repoRoot = await makeTempRepo("qa-suite-portable-channel-");

    await runQaSuite({
      repoRoot,
      providerMode: "mock-openai",
      channelDriver: "live",
      adapterFactories: [
        {
          id: "portable-driver",
          matches: ({ channelId }) => channelId === "slack" || channelId === "matrix",
          create: vi.fn(),
        },
      ],
      scenarioIds: ["thread-isolation"],
    });

    expect(runQaFlowSuite).toHaveBeenCalledTimes(1);
    expect(runQaFlowSuite).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "slack",
        scenarioIds: ["thread-isolation"],
      }),
    );
  });

  it("retries only the failed channel partition in a mixed-channel suite", async () => {
    const repoRoot = await makeTempRepo("qa-suite-partition-retry-");
    const attempts = mockFlowPartitionFailures(
      new Map([
        [
          "whatsapp-status-command",
          [new QaSuiteInfraError("transport_ready_timeout", "WhatsApp readiness timed out")],
        ],
      ]),
    );

    const result = await runQaSuite({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/partition-retry",
      providerMode: "mock-openai",
      channelDriver: "live",
      adapterFactories: [{ id: "portable-driver", matches: () => true, create: vi.fn() }],
      concurrency: 4,
      scenarioIds: [
        "telegram-help-command",
        "matrix-restart-resume",
        "slack-canary",
        "whatsapp-status-command",
      ],
    });

    expect(result.executionKind).toBe("suite");
    expect(Object.fromEntries(attempts)).toEqual({
      "telegram-help-command": 1,
      "matrix-restart-resume": 1,
      "slack-canary": 1,
      "whatsapp-status-command": 2,
    });
    expect(result.result.scenarios).toHaveLength(4);
    expect(new Set(result.result.scenarios.map((scenario) => scenario.name))).toEqual(
      new Set([
        "telegram-help-command",
        "matrix-restart-resume",
        "slack-canary",
        "whatsapp-status-command",
      ]),
    );
  });

  it("records generic partition failures without retrying or discarding sibling artifacts", async () => {
    const repoRoot = await makeTempRepo("qa-suite-partition-generic-timeout-");
    const attempts = mockFlowPartitionFailures(
      new Map([
        [
          "whatsapp-status-command",
          [new Error("approval-turn timed out waiting for post-approval read")],
        ],
      ]),
    );

    const result = await runQaSuite({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/partition-generic-timeout",
      providerMode: "mock-openai",
      channelDriver: "live",
      adapterFactories: [{ id: "portable-driver", matches: () => true, create: vi.fn() }],
      concurrency: 2,
      scenarioIds: ["telegram-help-command", "whatsapp-status-command"],
    });

    expect(attempts.get("telegram-help-command")).toBe(1);
    expect(attempts.get("whatsapp-status-command")).toBe(1);
    expect(result.executionKind).toBe("suite");
    if (result.executionKind !== "suite") {
      throw new Error("expected unified suite result");
    }
    expect(result.result.scenarios).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "telegram-help-command", status: "pass" }),
        expect.objectContaining({
          status: "fail",
          details: "suite partition failed: approval-turn timed out waiting for post-approval read",
        }),
      ]),
    );
    const summary = JSON.parse(await fs.readFile(result.result.summaryPath, "utf8")) as {
      counts: { failed: number; passed: number; total: number };
    };
    expect(summary.counts).toMatchObject({ total: 2, passed: 1, failed: 1 });
    const evidence = JSON.parse(await fs.readFile(result.result.evidencePath, "utf8")) as {
      entries: Array<{
        test: { id: string };
        result: { status: string; failure?: { reason: string } };
      }>;
    };
    expect(evidence.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          test: expect.objectContaining({ id: "whatsapp-status-command" }),
          result: expect.objectContaining({
            status: "fail",
            failure: {
              reason:
                "suite partition failed: approval-turn timed out waiting for post-approval read",
            },
          }),
        }),
      ]),
    );
    await expect(fs.access(result.result.reportPath)).resolves.toBeUndefined();
  });

  it("preserves completed partitions when a retryable channel fails twice", async () => {
    const repoRoot = await makeTempRepo("qa-suite-partition-retry-exhausted-");
    const attempts = mockFlowPartitionFailures(
      new Map([
        [
          "whatsapp-status-command",
          [
            new QaSuiteInfraError("transport_ready_timeout", "WhatsApp readiness timed out"),
            new QaSuiteInfraError("transport_ready_timeout", "WhatsApp readiness timed out again"),
          ],
        ],
      ]),
    );

    const result = await runQaSuite({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/partition-retry-exhausted",
      providerMode: "mock-openai",
      channelDriver: "live",
      adapterFactories: [{ id: "portable-driver", matches: () => true, create: vi.fn() }],
      concurrency: 2,
      scenarioIds: ["telegram-help-command", "whatsapp-status-command"],
    });

    expect(attempts.get("telegram-help-command")).toBe(1);
    expect(attempts.get("whatsapp-status-command")).toBe(2);
    expect(result.executionKind).toBe("suite");
    if (result.executionKind !== "suite") {
      throw new Error("expected unified suite result");
    }
    expect(result.result.scenarios).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "telegram-help-command", status: "pass" }),
        expect.objectContaining({
          status: "fail",
          details: "suite partition failed: WhatsApp readiness timed out again",
        }),
      ]),
    );
    const summary = JSON.parse(await fs.readFile(result.result.summaryPath, "utf8")) as {
      counts: { failed: number; passed: number; total: number };
    };
    expect(summary.counts).toMatchObject({ total: 2, passed: 1, failed: 1 });
    const evidence = JSON.parse(await fs.readFile(result.result.evidencePath, "utf8")) as {
      entries: Array<{
        test: { id: string };
        result: { status: string; failure?: { reason: string } };
      }>;
    };
    expect(evidence.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          test: expect.objectContaining({ id: "whatsapp-status-command" }),
          result: expect.objectContaining({
            status: "fail",
            failure: { reason: "suite partition failed: WhatsApp readiness timed out again" },
          }),
        }),
      ]),
    );
    await expect(fs.access(result.result.reportPath)).resolves.toBeUndefined();
  });

  it("records an exhausted fail-fast partition without starting later partitions", async () => {
    const repoRoot = await makeTempRepo("qa-suite-fail-fast-retry-exhausted-");
    const attempts = mockFlowPartitionFailures(
      new Map([
        [
          "whatsapp-status-command",
          [
            new QaSuiteInfraError("transport_ready_timeout", "WhatsApp readiness timed out"),
            new QaSuiteInfraError("transport_ready_timeout", "WhatsApp readiness timed out again"),
          ],
        ],
      ]),
    );

    const result = await runQaSuite({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/fail-fast-retry-exhausted",
      providerMode: "mock-openai",
      channelDriver: "live",
      adapterFactories: [{ id: "portable-driver", matches: () => true, create: vi.fn() }],
      concurrency: 2,
      failFast: true,
      scenarioIds: [
        "whatsapp-status-command",
        "telegram-help-command",
        "control-ui-chat-flow-playwright",
      ],
    });

    expect(attempts.get("whatsapp-status-command")).toBe(2);
    expect(attempts.has("telegram-help-command")).toBe(false);
    expect(runQaTestFileScenarios).not.toHaveBeenCalled();
    expect(result.executionKind).toBe("suite");
    if (result.executionKind !== "suite") {
      throw new Error("expected unified suite result");
    }
    expect(result.result.scenarios).toMatchObject([
      {
        status: "fail",
        details: "suite partition failed: WhatsApp readiness timed out again",
      },
    ]);
    const summary = JSON.parse(await fs.readFile(result.result.summaryPath, "utf8")) as {
      counts: { failed: number; total: number };
    };
    expect(summary.counts).toMatchObject({ total: 1, failed: 1 });
    const evidence = JSON.parse(await fs.readFile(result.result.evidencePath, "utf8")) as {
      entries: Array<{ test: { id: string }; result: { status: string } }>;
    };
    expect(evidence.entries).toMatchObject([
      { test: { id: "whatsapp-status-command" }, result: { status: "fail" } },
    ]);
    expect(result.observedCells).toEqual([]);
    await expect(fs.access(result.result.reportPath)).resolves.toBeUndefined();
  });

  it("attributes an exhausted fail-fast retry to the later scenario that actually started", async () => {
    const repoRoot = await makeTempRepo("qa-suite-fail-fast-later-partition-failure-");
    const attempts = mockFlowPartitionFailures(
      new Map([
        [
          "thread-follow-up",
          [
            new QaSuiteInfraError("transport_ready_timeout", "second scenario readiness timed out"),
            new QaSuiteInfraError(
              "transport_ready_timeout",
              "second scenario readiness timed out again",
            ),
          ],
        ],
      ]),
    );

    const result = await runQaSuite({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/fail-fast-later-partition-failure",
      providerMode: "mock-openai",
      concurrency: 2,
      failFast: true,
      scenarioIds: ["dm-chat-baseline", "thread-follow-up", "control-ui-chat-flow-playwright"],
    });

    expect(Object.fromEntries(attempts)).toEqual({
      "dm-chat-baseline": 1,
      "thread-follow-up": 2,
    });
    expect(runQaFlowSuite.mock.calls.map(([params]) => params?.scenarioIds)).toEqual([
      ["dm-chat-baseline"],
      ["thread-follow-up"],
      ["thread-follow-up"],
    ]);
    expect(runQaTestFileScenarios).not.toHaveBeenCalled();
    expect(result.executionKind).toBe("suite");
    if (result.executionKind !== "suite") {
      throw new Error("expected unified suite result");
    }
    expect(result.result.scenarios).toMatchObject([
      { name: "dm-chat-baseline", status: "pass" },
      {
        status: "fail",
        details: "suite partition failed: second scenario readiness timed out again",
      },
    ]);
    const summary = JSON.parse(await fs.readFile(result.result.summaryPath, "utf8")) as {
      counts: { failed: number; passed: number; total: number };
    };
    expect(summary.counts).toMatchObject({ total: 2, passed: 1, failed: 1 });
    const evidence = JSON.parse(await fs.readFile(result.result.evidencePath, "utf8")) as {
      entries: Array<{
        test: { id: string };
        result: { status: string; failure?: { reason: string } };
      }>;
    };
    expect(evidence.entries).toMatchObject([
      {
        test: { id: "thread-follow-up" },
        result: {
          status: "fail",
          failure: { reason: "suite partition failed: second scenario readiness timed out again" },
        },
      },
    ]);
    await expect(fs.access(result.result.reportPath)).resolves.toBeUndefined();
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

    const isolatedScenarioId = "matrix-approval-channel-target-both";
    const sharedScenarioIds = [
      "matrix-approval-deny-reaction",
      "matrix-approval-exec-metadata-chunked",
      "matrix-approval-exec-metadata-single-event",
      "matrix-approval-plugin-metadata-single-event",
      "matrix-approval-thread-target",
    ];
    const scenarioIds = [isolatedScenarioId, ...sharedScenarioIds];
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
    expect(runQaFlowSuite.mock.calls.map(([params]) => params?.scenarioIds)).toEqual([
      ...sharedScenarioIds.map((scenarioId) => [scenarioId]),
      [isolatedScenarioId],
    ]);
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
    const defaultFlowImplementation = requireDefaultQaFlowSuiteImplementation();
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
    const setScenarioRun = vi.fn<QaLabServerHandle["setScenarioRun"]>();
    const lab = {
      baseUrl: "http://127.0.0.1:43124",
      listenUrl: "http://127.0.0.1:43124",
      runSelfCheck: vi.fn(),
      setControlUi: vi.fn(),
      setLatestReport: vi.fn(),
      setScenarioRun,
      state: {} as QaLabServerHandle["state"],
      stop: vi.fn(),
    } satisfies QaLabServerHandle;
    const result = await runQaSuite({
      lab,
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
    expect(setScenarioRun).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: "completed",
        scenarios: [
          expect.objectContaining({ id: "control-ui-chat-flow-playwright", status: "pass" }),
        ],
      }),
    );
  });

  it("projects a skipped native producer as a skipped unified scenario", async () => {
    const repoRoot = await makeTempRepo("qa-suite-native-skip-");
    const defaultImplementation = requireDefaultQaTestFileImplementation();
    runQaTestFileScenarios.mockImplementationOnce(async (params) => {
      const result = await defaultImplementation(params);
      return {
        ...result,
        results: result.results.map(
          (scenarioResult: QaTestFileScenarioRunResult["results"][number]) =>
            Object.assign({}, scenarioResult, { status: "skipped" as const }),
        ),
      };
    });

    const result = await runQaSuite({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/native-skip",
      scenarioIds: ["control-ui-chat-flow-playwright"],
    });
    if (result.executionKind !== "suite") {
      throw new Error("expected unified suite result");
    }
    expect(result.result.scenarios).toMatchObject([
      { name: "Control UI chat flow Playwright coverage", status: "skip" },
    ]);
    const summary = JSON.parse(await fs.readFile(result.result.summaryPath, "utf8")) as {
      counts: { failed: number; skipped: number };
    };
    expect(summary.counts).toMatchObject({ failed: 0, skipped: 1 });
  });

  it("serializes test-file runner partitions in one checkout", async () => {
    const repoRoot = await makeTempRepo("qa-suite-test-file-serial-");
    const vitest = blockNextQaTestFileRun();

    const runPromise = runQaSuite({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/test-file-serial",
      concurrency: 8,
      scenarioIds: ["gateway-smoke", "control-ui-chat-flow-playwright"],
    });
    await vitest.started;
    await Promise.resolve();

    expect(runQaTestFileScenarios).toHaveBeenCalledTimes(1);

    vitest.release();
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

  it.each([
    { kind: "report", fileName: "qa-suite-report.md" },
    { kind: "evidence", fileName: "qa-evidence.json" },
    { kind: "summary", fileName: "qa-suite-summary.json" },
  ])(
    "preserves the prior standard $kind artifact when atomic publication fails",
    async ({ fileName }) => {
      const outputDir = await makeTempRepo("qa-suite-standard-artifact-atomic-");
      await expectArtifactPublicationFailurePreservesPrior({
        canonicalFileNames: ["qa-suite-report.md", "qa-evidence.json", "qa-suite-summary.json"],
        failedFileName: fileName,
        outputDir,
        publish: async () =>
          await writeQaSuiteArtifacts({
            outputDir,
            startedAt: new Date("2026-08-12T00:00:00.000Z"),
            finishedAt: new Date("2026-08-12T00:01:00.000Z"),
            scenarios: [{ name: "Atomic publication", status: "pass", steps: [] }],
            scenarioDefinitions: [makeQaSuiteTestScenario("channel-chat-baseline")],
            transport: {
              id: "qa-channel",
              createReportNotes: () => [],
            } as unknown as QaTransportAdapter,
            providerMode: "mock-openai",
            primaryModel: "mock-openai/gpt-5.6-luna",
            alternateModel: "mock-openai/gpt-5.6-luna-alt",
            fastMode: true,
            concurrency: 1,
          }),
      });
    },
  );

  it("aggregates mixed-kind progress through the parent lab", async () => {
    const repoRoot = await makeTempRepo("qa-suite-mixed-progress-");
    const scenarioRuns: Array<Parameters<QaLabServerHandle["setScenarioRun"]>[0]> = [];
    const lab = {
      baseUrl: "http://127.0.0.1:43124",
      listenUrl: "http://127.0.0.1:43124",
      runSelfCheck: vi.fn(),
      setControlUi: vi.fn(),
      setLatestReport: vi.fn(),
      setScenarioRun: vi.fn((run) => scenarioRuns.push(run)),
      state: {} as QaLabServerHandle["state"],
      stop: vi.fn(),
    } satisfies QaLabServerHandle;
    const defaultFlowImplementation = requireDefaultQaFlowSuiteImplementation();
    runQaFlowSuite.mockImplementationOnce(async (params) => {
      params?.lab?.setScenarioRun({
        kind: "suite",
        status: "running",
        startedAt: "2026-07-23T00:00:00.000Z",
        scenarios: [
          { id: "channel-chat-baseline", name: "channel-chat-baseline", status: "running" },
        ],
      });
      params?.lab?.setScenarioRun({
        kind: "suite",
        status: "running",
        startedAt: "2026-07-23T00:00:00.000Z",
        scenarios: [
          { id: "not-a-selected-scenario", name: "channel-chat-baseline", status: "fail" },
        ],
      });
      const result = await defaultFlowImplementation(params);
      params?.lab?.setScenarioRun({
        kind: "suite",
        status: "completed",
        startedAt: "2026-07-23T00:00:00.000Z",
        finishedAt: "2026-07-23T00:00:01.000Z",
        scenarios: [{ id: "channel-chat-baseline", name: "channel-chat-baseline", status: "pass" }],
      });
      return result;
    });

    await runQaSuite({
      lab,
      repoRoot,
      outputDir: ".artifacts/qa-e2e/mixed-progress",
      scenarioIds: ["channel-chat-baseline", "control-ui-chat-flow-playwright"],
    });

    expect(
      scenarioRuns.some(
        (run) =>
          run?.status === "running" &&
          run.scenarios.some(
            (scenario) => scenario.id === "channel-chat-baseline" && scenario.status === "running",
          ),
      ),
    ).toBe(true);
    expect(
      scenarioRuns.some((run) =>
        run?.scenarios.some(
          (scenario) => scenario.id === "channel-chat-baseline" && scenario.status === "fail",
        ),
      ),
    ).toBe(false);
    expect(
      scenarioRuns.some(
        (run) =>
          run?.status === "running" &&
          run.scenarios.some(
            (scenario) =>
              scenario.id === "control-ui-chat-flow-playwright" && scenario.status === "running",
          ),
      ),
    ).toBe(true);
    expect(scenarioRuns.at(-1)).toMatchObject({
      status: "completed",
      scenarios: [
        { id: "channel-chat-baseline", status: "pass" },
        { id: "control-ui-chat-flow-playwright", status: "pass" },
      ],
    });
    expect(lab.setLatestReport).toHaveBeenCalledWith(
      expect.objectContaining({ outputPath: expect.stringMatching(/qa-suite-report\.md$/u) }),
    );
  });

  it("keeps channel-driver unified flow partitions serial by default", async () => {
    const repoRoot = await makeTempRepo("qa-suite-crabline-serial-");
    await runQaSuite({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/crabline-serial",
      channelDriverSelection: {
        capabilityMatrixPath: "crabline-channel-driver-capabilities.json",
        channel: "telegram",
        channelDriver: "crabline",
        providerReadinessArtifactPath: "crabline-provider-readiness.json",
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
    const defaultFlowImplementation = requireDefaultQaFlowSuiteImplementation();
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
        capabilityMatrixPath: "crabline-channel-driver-capabilities.json",
        channel: "telegram",
        channelDriver: "crabline",
        providerReadinessArtifactPath: "crabline-provider-readiness.json",
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
    const flow = blockNextQaFlowSuite();

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
    await flow.started;
    await Promise.resolve();

    expect(runQaFlowSuite).toHaveBeenCalledTimes(1);
    expect(runQaTestFileScenarios).not.toHaveBeenCalled();

    flow.release();
    await runPromise;

    expect(runQaFlowSuite).toHaveBeenCalledTimes(2);
    expect(runQaTestFileScenarios).toHaveBeenCalledTimes(1);
  });

  it("stops unified suite partitions after the first failed flow scenario", async () => {
    const scenarioRuns: Array<Parameters<QaLabServerHandle["setScenarioRun"]>[0]> = [];
    const lab = {
      baseUrl: "http://127.0.0.1:43124",
      listenUrl: "http://127.0.0.1:43124",
      runSelfCheck: vi.fn(),
      setControlUi: vi.fn(),
      setLatestReport: vi.fn(),
      setScenarioRun: vi.fn((run) => scenarioRuns.push(run)),
      state: {} as QaLabServerHandle["state"],
      stop: vi.fn(),
    } satisfies QaLabServerHandle;
    const defaultFlowImplementation = requireDefaultQaFlowSuiteImplementation();
    runQaFlowSuite.mockImplementationOnce(async (params) => {
      const result = await defaultFlowImplementation(params);
      return {
        ...result,
        scenarios: result.scenarios.map((scenario: QaSuiteScenarioResult) =>
          Object.assign({}, scenario, {
            status: "fail" as const,
            details: "first scenario failed",
          }),
        ),
      };
    });

    const result = await runFailFastQaSuite("fail-fast-flow", { lab });

    expect(result.executionKind).toBe("suite");
    if (result.executionKind !== "suite") {
      throw new Error("expected unified suite result");
    }
    expect(runQaFlowSuite).toHaveBeenCalledTimes(1);
    expect(runQaFlowSuite).toHaveBeenCalledWith(
      expect.objectContaining({
        concurrency: 1,
        failFast: true,
        scenarioIds: ["dm-chat-baseline"],
      }),
    );
    expect(runQaTestFileScenarios).not.toHaveBeenCalled();
    expect(result.result.scenarios).toMatchObject([
      { name: "dm-chat-baseline", status: "fail", details: "first scenario failed" },
    ]);
    const summary = JSON.parse(await fs.readFile(result.result.summaryPath, "utf8")) as {
      run?: { concurrency?: number; scenarioIds?: string[] };
      scenarios?: Array<{ name?: string; status?: string }>;
    };
    expect(summary.run?.concurrency).toBe(1);
    expect(summary.run?.scenarioIds).toEqual([
      "dm-chat-baseline",
      "group-visible-reply-tool",
      "control-ui-chat-flow-playwright",
      "docker-npm-onboard-channel-agent",
    ]);
    expect(summary.scenarios).toMatchObject([{ name: "dm-chat-baseline", status: "fail" }]);
    expect(scenarioRuns.at(-1)).toMatchObject({
      status: "completed",
      scenarios: [
        { id: "dm-chat-baseline", status: "fail" },
        { id: "group-visible-reply-tool", status: "pending" },
        { id: "control-ui-chat-flow-playwright", status: "pending" },
        { id: "docker-npm-onboard-channel-agent", status: "pending" },
      ],
    });
  });

  it("stops pending flow and script partitions after a native scenario fails", async () => {
    const defaultTestFileImplementation = requireDefaultQaTestFileImplementation();
    runQaTestFileScenarios.mockImplementationOnce(async (params) => {
      const result = await defaultTestFileImplementation(params);
      return {
        ...result,
        results: result.results.map((scenario: QaTestFileScenarioRunResult["results"][number]) =>
          Object.assign({}, scenario, {
            status: "fail" as const,
            failureMessage: "native scenario failed",
          }),
        ),
      };
    });

    const result = await runFailFastQaSuite("fail-fast-native");

    expect(result.executionKind).toBe("suite");
    if (result.executionKind !== "suite") {
      throw new Error("expected unified suite result");
    }
    expect(runQaFlowSuite).toHaveBeenCalledTimes(1);
    expect(runQaTestFileScenarios).toHaveBeenCalledTimes(1);
    expect(runQaTestFileScenarios).toHaveBeenCalledWith(
      expect.objectContaining({
        failFast: true,
        scenarios: [expect.objectContaining({ id: "control-ui-chat-flow-playwright" })],
      }),
    );
    expect(result.result.scenarios).toMatchObject([
      { name: "dm-chat-baseline", status: "pass" },
      { name: "Control UI chat flow Playwright coverage", status: "fail" },
    ]);
  });

  it("fails and stops when a started flow partition omits its scenario result", async () => {
    const defaultFlowImplementation = requireDefaultQaFlowSuiteImplementation();
    runQaFlowSuite.mockImplementationOnce(async (params) => ({
      ...(await defaultFlowImplementation(params)),
      scenarios: [],
    }));

    const result = await runFailFastQaSuite("fail-fast-missing-flow");

    expect(result.executionKind).toBe("suite");
    if (result.executionKind !== "suite") {
      throw new Error("expected unified suite result");
    }
    expect(runQaFlowSuite).toHaveBeenCalledTimes(1);
    expect(runQaTestFileScenarios).not.toHaveBeenCalled();
    expect(result.result.scenarios).toMatchObject([
      {
        name: "DM baseline conversation",
        status: "fail",
        details: "suite partition returned no scenario result",
      },
    ]);
    const summary = JSON.parse(await fs.readFile(result.result.summaryPath, "utf8")) as {
      scenarios?: Array<{ details?: string; name?: string; status?: string }>;
    };
    expect(summary.scenarios).toMatchObject([
      {
        name: "DM baseline conversation",
        status: "fail",
        details: "suite partition returned no scenario result",
      },
    ]);
    const evidence = JSON.parse(await fs.readFile(result.result.evidencePath, "utf8")) as {
      entries?: Array<{
        result?: { failure?: { reason?: string }; status?: string };
        test?: { id?: string };
      }>;
    };
    expect(evidence.entries).toMatchObject([
      {
        test: { id: "dm-chat-baseline" },
        result: {
          status: "fail",
          failure: { reason: "suite partition returned no scenario result" },
        },
      },
    ]);
  });

  it("fails and stops when a started native partition omits its scenario result", async () => {
    const defaultTestFileImplementation = requireDefaultQaTestFileImplementation();
    runQaTestFileScenarios.mockImplementationOnce(async (params) => ({
      ...(await defaultTestFileImplementation(params)),
      results: [],
    }));

    const result = await runFailFastQaSuite("fail-fast-missing-native");

    expect(result.executionKind).toBe("suite");
    if (result.executionKind !== "suite") {
      throw new Error("expected unified suite result");
    }
    expect(runQaFlowSuite).toHaveBeenCalledTimes(1);
    expect(runQaTestFileScenarios).toHaveBeenCalledTimes(1);
    expect(result.result.scenarios).toMatchObject([
      { name: "dm-chat-baseline", status: "pass" },
      {
        name: "Control UI chat flow Playwright coverage",
        status: "fail",
        details: "suite partition returned no scenario result",
      },
    ]);
    const evidence = JSON.parse(await fs.readFile(result.result.evidencePath, "utf8")) as {
      entries?: Array<{
        result?: { failure?: { reason?: string }; status?: string };
        test?: { id?: string };
      }>;
    };
    expect(evidence.entries).toMatchObject([
      {
        test: { id: "control-ui-chat-flow-playwright" },
        result: {
          status: "fail",
          failure: { reason: "suite partition returned no scenario result" },
        },
      },
    ]);
  });

  it("stops later native execution kinds after a started kind omits its result", async () => {
    const defaultTestFileImplementation = requireDefaultQaTestFileImplementation();
    runQaTestFileScenarios.mockImplementationOnce(async (params) => ({
      ...(await defaultTestFileImplementation(params)),
      results: [],
    }));

    const scenarioIds = [
      "dm-chat-baseline",
      "control-ui-assistant-media-tickets",
      "control-ui-chat-flow-playwright",
      "docker-npm-onboard-channel-agent",
    ];
    const result = await runFailFastQaSuite("fail-fast-missing-native-kind", { scenarioIds });

    expect(result.executionKind).toBe("suite");
    if (result.executionKind !== "suite") {
      throw new Error("expected unified suite result");
    }
    expect(runQaFlowSuite).toHaveBeenCalledTimes(1);
    expect(runQaTestFileScenarios).toHaveBeenCalledTimes(1);
    expect(runQaTestFileScenarios).toHaveBeenCalledWith(
      expect.objectContaining({
        failFast: true,
        scenarios: [expect.objectContaining({ id: "control-ui-assistant-media-tickets" })],
      }),
    );
    expect(result.result.scenarios).toMatchObject([
      { name: "dm-chat-baseline", status: "pass" },
      {
        name: "Control UI assistant media ticket evidence",
        status: "fail",
        details: "suite partition returned no scenario result",
      },
    ]);
    const summary = JSON.parse(await fs.readFile(result.result.summaryPath, "utf8")) as {
      run?: { scenarioIds?: string[] };
      scenarios?: Array<{ details?: string; name?: string; status?: string }>;
    };
    expect(summary.run?.scenarioIds).toEqual(scenarioIds);
    expect(summary.scenarios).toMatchObject([
      { name: "dm-chat-baseline", status: "pass" },
      {
        name: "Control UI assistant media ticket evidence",
        status: "fail",
        details: "suite partition returned no scenario result",
      },
    ]);
  });

  it("omits a native fail-fast tail after the first missing scenario result", async () => {
    const repoRoot = await makeTempRepo("qa-suite-fail-fast-missing-native-tail-");
    const defaultTestFileImplementation = runQaTestFileScenarios.getMockImplementation();
    if (!defaultTestFileImplementation) {
      throw new Error("expected default QA test-file scenario mock implementation");
    }
    runQaTestFileScenarios.mockImplementation(async (params) => {
      const result = await defaultTestFileImplementation(params);
      return {
        ...result,
        evidence: {
          ...result.evidence,
          entries: params.scenarios.map((scenario: QaTestFileScenario) => ({
            test: {
              kind: "qa-scenario",
              id: scenario.id,
              title: scenario.title,
            },
            coverage: [],
            result: { status: "pass" as const },
          })),
        },
        results:
          params.scenarios[0]?.id === "auth-profile-doctor-migration-safety" ? [] : result.results,
      };
    });

    const result = await runQaSuite({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/fail-fast-missing-native-tail",
      concurrency: 8,
      failFast: true,
      scenarioIds: [
        "dm-chat-baseline",
        "control-ui-assistant-media-tickets",
        "auth-profile-doctor-migration-safety",
        "auth-profile-codex-mixed-profiles",
        "control-ui-chat-flow-playwright",
      ],
    });

    expect(result.executionKind).toBe("suite");
    if (result.executionKind !== "suite") {
      throw new Error("expected unified suite result");
    }
    expect(runQaFlowSuite).toHaveBeenCalledTimes(1);
    expect(runQaTestFileScenarios).toHaveBeenCalledTimes(2);
    expect(result.result.scenarios).toMatchObject([
      { name: "dm-chat-baseline", status: "pass" },
      { name: "Control UI assistant media ticket evidence", status: "pass" },
      {
        name: "Codex doctor migration safety matrix",
        status: "fail",
        details: "suite partition returned no scenario result",
      },
    ]);
    expect(result.result.scenarios).toHaveLength(3);
    const evidence = JSON.parse(await fs.readFile(result.result.evidencePath, "utf8")) as {
      entries?: Array<{
        result?: { failure?: { reason?: string }; status?: string };
        test?: { id?: string };
      }>;
    };
    expect(evidence.entries).toMatchObject([
      { test: { id: "control-ui-assistant-media-tickets" }, result: { status: "pass" } },
      {
        test: { id: "auth-profile-doctor-migration-safety" },
        result: {
          status: "fail",
          failure: { reason: "suite partition returned no scenario result" },
        },
      },
    ]);
  });

  it("continues every unified partition after a failure when fail-fast is disabled", async () => {
    const repoRoot = await makeTempRepo("qa-suite-continue-after-failure-");
    const defaultFlowImplementation = requireDefaultQaFlowSuiteImplementation();
    runQaFlowSuite.mockImplementationOnce(async (params) => {
      const result = await defaultFlowImplementation(params);
      return {
        ...result,
        scenarios: result.scenarios.map((scenario: QaSuiteScenarioResult) =>
          Object.assign({}, scenario, {
            status: "fail" as const,
          }),
        ),
      };
    });

    const result = await runQaSuite({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/continue-after-failure",
      concurrency: 1,
      scenarioIds: [
        "dm-chat-baseline",
        "group-visible-reply-tool",
        "control-ui-chat-flow-playwright",
        "docker-npm-onboard-channel-agent",
      ],
    });

    expect(result.executionKind).toBe("suite");
    if (result.executionKind !== "suite") {
      throw new Error("expected unified suite result");
    }
    expect(runQaFlowSuite).toHaveBeenCalledTimes(2);
    expect(runQaTestFileScenarios).toHaveBeenCalledTimes(2);
    expect(result.result.scenarios.map((scenario) => scenario.status)).toEqual([
      "fail",
      "pass",
      "pass",
      "pass",
    ]);
  });

  it("runs script scenarios after flow Gateways stop without serializing Playwright", async () => {
    const repoRoot = await makeTempRepo("qa-suite-script-isolation-");
    vi.stubEnv("OPENCLAW_QA_SUITE_PROGRESS", "1");
    const flow = blockNextQaFlowSuite();

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
    await flow.started;
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

    flow.release();
    await runPromise;

    expect(runQaTestFileScenarios).toHaveBeenCalledTimes(2);
    expect(runQaTestFileScenarios).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        progress: expect.any(Function),
        scenarios: [
          expect.objectContaining({ execution: expect.objectContaining({ kind: "script" }) }),
        ],
      }),
    );
  });

  it("streams native owner progress without exposing child output to CI", async () => {
    const repoRoot = await makeTempRepo("qa-suite-safe-native-progress-");
    vi.stubEnv("OPENCLAW_QA_SUITE_PROGRESS", "1");
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderrWrite = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const defaultTestFileImplementation = requireDefaultQaTestFileImplementation();
    runQaTestFileScenarios.mockImplementationOnce(async (params) => {
      params.progress?.("native docker-batch start scenarios=1 timeoutMs=60000");
      expect(stderrWrite).toHaveBeenCalledWith(
        expect.stringContaining("[qa-suite] native docker-batch start"),
      );
      const childOutput = Buffer.from(
        [
          "OPENAI_API_KEY=synthetic-provider-secret",
          'warning: invalid value " channels.buzz.authTag:',
          "[",
          '  "synthetic-auth-secret"',
          "]",
          "::stop-commands::synthetic-runner-attack",
          "##[error]synthetic-runner-attack",
        ].join("\n"),
      );
      params.onCommandOutput?.("stdout", childOutput);
      params.onCommandOutput?.("stderr", childOutput);
      return await defaultTestFileImplementation(params);
    });

    try {
      await runQaSuite({
        repoRoot,
        outputDir: ".artifacts/qa-e2e/safe-native-progress",
        scenarioIds: ["docker-npm-onboard-channel-agent"],
      });

      const runnerParams = runQaTestFileScenarios.mock.calls[0]?.[0];
      expect(runnerParams?.progress).toEqual(expect.any(Function));
      expect(runnerParams).not.toHaveProperty("onCommandOutput");
      const output = [...stdoutWrite.mock.calls, ...stderrWrite.mock.calls]
        .map(([chunk]) => String(chunk))
        .join("");
      expect(output).toContain("[qa-suite] native docker-batch start");
      expect(output).not.toContain("synthetic-provider-secret");
      expect(output).not.toContain("synthetic-auth-secret");
      expect(output).not.toContain("::stop-commands::");
      expect(output).not.toContain("##[error]");
    } finally {
      stdoutWrite.mockRestore();
      stderrWrite.mockRestore();
    }
  });

  it("settles flow and native work, then runs serial scripts before a bounded parallel tail", async () => {
    const repoRoot = await makeTempRepo("qa-suite-parallel-scripts-");
    const defaultFlowImplementation = requireDefaultQaFlowSuiteImplementation();
    const defaultTestFileImplementation = requireDefaultQaTestFileImplementation();
    const flow = createDeferred();
    const native = createDeferred();
    const serial = createDeferred();
    const parallel = createDeferred();
    const started: string[] = [];
    const preparedEnv = Object.freeze({ OPENCLAW_CURRENT_PACKAGE_TGZ: "/tmp/candidate.tgz" });
    const scriptEnvs: unknown[] = [];
    const parallelScriptIds: string[] = [];
    let activeParallelScripts = 0;
    let maxActiveParallelScripts = 0;
    runQaFlowSuite.mockImplementationOnce(async (params) => {
      started.push("flow");
      await flow.promise;
      return await defaultFlowImplementation(params);
    });
    prepareDockerE2eEnvironment.mockImplementationOnce(async () => {
      started.push("prep");
      return preparedEnv;
    });
    runQaTestFileScenarios.mockImplementation(async (params) => {
      const scenarioIds = params.scenarios.map((scenario: QaTestFileScenario) => scenario.id);
      const kind = params.scenarios[0]?.execution.kind;
      if (kind === "playwright") {
        started.push("native");
        await native.promise;
      } else if (scenarioIds.includes("docker-npm-onboard-channel-agent")) {
        scriptEnvs.push(params.env);
        started.push("serial");
        await serial.promise;
      } else {
        scriptEnvs.push(params.env);
        parallelScriptIds.push(...scenarioIds);
        activeParallelScripts += 1;
        maxActiveParallelScripts = Math.max(maxActiveParallelScripts, activeParallelScripts);
        try {
          await parallel.promise;
        } finally {
          activeParallelScripts -= 1;
        }
      }
      return await defaultTestFileImplementation(params);
    });

    const runPromise = runQaSuite({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/parallel-scripts",
      concurrency: 8,
      scenarioIds: [
        "dm-chat-baseline",
        "control-ui-chat-flow-playwright",
        "docker-npm-onboard-channel-agent",
        "remote-log-tailing",
        "gateway-smoke",
        "logging-file-boundary",
        "diagnostic-events-boundary",
      ],
    });
    await vi.waitFor(() => expect(started).toEqual(["flow", "native"]));

    flow.resolve();
    await Promise.resolve();
    expect(started).toEqual(["flow", "native"]);

    native.resolve();
    await vi.waitFor(() => expect(started).toContain("serial"));
    expect(started.slice(0, 4)).toEqual(["flow", "native", "prep", "serial"]);
    expect(parallelScriptIds).toEqual([]);

    serial.resolve();
    await vi.waitFor(() => expect(parallelScriptIds).toHaveLength(3));
    expect(maxActiveParallelScripts).toBe(3);
    expect(parallelScriptIds).not.toContain("diagnostic-events-boundary");

    parallel.resolve();
    await runPromise;
    expect(prepareDockerE2eEnvironment).toHaveBeenCalledTimes(1);
    expect(scriptEnvs.every((env) => env === preparedEnv)).toBe(true);
    expect(parallelScriptIds.slice(0, 3)).toEqual(
      expect.arrayContaining(["remote-log-tailing", "gateway-smoke", "logging-file-boundary"]),
    );
    expect(parallelScriptIds[3]).toBe("diagnostic-events-boundary");
    expect(maxActiveParallelScripts).toBe(3);
  });

  it("records Docker preparation failure without starting a script partition", async () => {
    const repoRoot = await makeTempRepo("qa-suite-docker-prep-failure-");
    prepareDockerE2eEnvironment.mockRejectedValueOnce(new Error("candidate pack failed"));
    const result = await runQaSuite({
      repoRoot,
      scenarioIds: ["docker-npm-onboard-channel-agent", "gateway-smoke"],
    });

    expect(runQaTestFileScenarios).not.toHaveBeenCalled();
    expect(result.result.scenarios).toHaveLength(2);
    expect(result.result.scenarios).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "fail",
          details: expect.stringContaining("candidate pack failed"),
        }),
      ]),
    );
  });

  it("reuses the prepared Docker env object when a script partition retries", async () => {
    const repoRoot = await makeTempRepo("qa-suite-docker-prep-retry-");
    const preparedEnv = Object.freeze({ OPENCLAW_CURRENT_PACKAGE_TGZ: "/tmp/candidate.tgz" });
    const defaultImplementation = requireDefaultQaTestFileImplementation();
    prepareDockerE2eEnvironment.mockResolvedValueOnce(preparedEnv);
    runQaTestFileScenarios
      .mockRejectedValueOnce(new QaSuiteInfraError("transport_ready_timeout", "retry"))
      .mockImplementationOnce(defaultImplementation);

    await runQaSuite({ repoRoot, scenarioIds: ["docker-npm-onboard-channel-agent"] });

    expect(runQaTestFileScenarios).toHaveBeenCalledTimes(2);
    expect(runQaTestFileScenarios.mock.calls.map(([params]) => params.env)).toEqual([
      preparedEnv,
      preparedEnv,
    ]);
  });

  it("skips Docker preparation after a fail-fast concurrent failure", async () => {
    const repoRoot = await makeTempRepo("qa-suite-docker-prep-fail-fast-");
    runQaFlowSuite.mockRejectedValueOnce(new Error("flow failed"));
    await runQaSuite({
      repoRoot,
      failFast: true,
      scenarioIds: ["channel-chat-baseline", "docker-npm-onboard-channel-agent"],
    });

    expect(prepareDockerE2eEnvironment).not.toHaveBeenCalled();
    expect(runQaTestFileScenarios).not.toHaveBeenCalled();
  });

  it("does not prepare a Docker candidate for ordinary scripts", async () => {
    const repoRoot = await makeTempRepo("qa-suite-no-docker-prep-");
    await runQaSuite({ repoRoot, scenarioIds: ["gateway-smoke"] });

    expect(prepareDockerE2eEnvironment).not.toHaveBeenCalled();
    expect(runQaTestFileScenarios).toHaveBeenCalledTimes(1);
  });

  it("keeps selected evidence order and successful siblings when a parallel script rejects", async () => {
    const repoRoot = await makeTempRepo("qa-suite-parallel-script-rejection-");
    const defaultTestFileImplementation = requireDefaultQaTestFileImplementation();
    const first = createDeferred();
    runQaTestFileScenarios.mockImplementation(async (params) => {
      const scenario = params.scenarios[0] as QaTestFileScenario | undefined;
      if (!scenario) {
        throw new Error("expected one script scenario");
      }
      if (scenario.id === "gateway-smoke") {
        throw new Error("audited producer rejected");
      }
      if (scenario.id === "remote-log-tailing") {
        await first.promise;
      }
      const result = await defaultTestFileImplementation(params);
      return {
        ...result,
        evidence: {
          ...result.evidence,
          entries: [
            {
              test: { kind: "qa-scenario", id: scenario.id, title: scenario.title },
              coverage: [],
              result: { status: "pass" as const },
            },
          ],
        },
      };
    });

    const runPromise = runQaSuite({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/parallel-script-rejection",
      concurrency: 3,
      scenarioIds: ["remote-log-tailing", "gateway-smoke", "logging-file-boundary"],
    });
    await vi.waitFor(() => expect(runQaTestFileScenarios).toHaveBeenCalledTimes(3));
    first.resolve();
    const result = await runPromise;

    expect(result.executionKind).toBe("suite");
    if (result.executionKind !== "suite") {
      throw new Error("expected unified suite result");
    }
    const evidence = JSON.parse(await fs.readFile(result.result.evidencePath, "utf8")) as {
      entries: Array<{
        result: { failure?: { reason?: string }; status: string };
        test: { id: string };
      }>;
    };
    expect(evidence.entries.map((entry) => entry.test.id)).toEqual([
      "remote-log-tailing",
      "gateway-smoke",
      "logging-file-boundary",
    ]);
    expect(evidence.entries[1]).toMatchObject({
      result: {
        failure: { reason: "suite partition failed: audited producer rejected" },
        status: "fail",
      },
    });
  });

  it("serializes every fail-fast script and stops before post-failure work", async () => {
    const repoRoot = await makeTempRepo("qa-suite-fail-fast-scripts-");
    const defaultTestFileImplementation = requireDefaultQaTestFileImplementation();
    const first = createDeferred();
    const preparedEnv = Object.freeze({ OPENCLAW_CURRENT_PACKAGE_TGZ: "/tmp/candidate.tgz" });
    const started: string[] = [];
    let active = 0;
    let maxActive = 0;
    prepareDockerE2eEnvironment.mockResolvedValueOnce(preparedEnv);
    runQaTestFileScenarios.mockImplementation(async (params) => {
      const scenario = params.scenarios[0] as QaTestFileScenario | undefined;
      if (!scenario) {
        throw new Error("expected one script scenario");
      }
      started.push(scenario.id);
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        if (scenario.id === "remote-log-tailing") {
          await first.promise;
        }
        const result = await defaultTestFileImplementation(params);
        if (scenario.id !== "docker-npm-onboard-channel-agent") {
          return result;
        }
        return {
          ...result,
          results: result.results.map((scenarioResult: QaTestFileScenarioRunResult) =>
            Object.assign({}, scenarioResult, {
              status: "fail" as const,
              failureMessage: "serial owner failed",
            }),
          ),
        };
      } finally {
        active -= 1;
      }
    });

    const runPromise = runQaSuite({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/fail-fast-scripts",
      concurrency: 8,
      failFast: true,
      scenarioIds: ["remote-log-tailing", "docker-npm-onboard-channel-agent", "gateway-smoke"],
    });
    await vi.waitFor(() => expect(started).toEqual(["remote-log-tailing"]));
    expect(maxActive).toBe(1);

    first.resolve();
    await runPromise;
    expect(started).toEqual(["remote-log-tailing", "docker-npm-onboard-channel-agent"]);
    expect(maxActive).toBe(1);
    expect(runQaTestFileScenarios).toHaveBeenCalledTimes(2);
    expect(runQaTestFileScenarios.mock.calls.every(([params]) => params.env === preparedEnv)).toBe(
      true,
    );
    expect(runQaTestFileScenarios).toHaveBeenLastCalledWith(
      expect.objectContaining({ failFast: true }),
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
    const shared = blockNextQaFlowSuite();

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
    await shared.started;
    await Promise.resolve();

    expect(runQaFlowSuite).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => {
      expect(runQaTestFileScenarios).toHaveBeenCalledTimes(1);
    });

    shared.release();
    await runPromise;

    expect(runQaFlowSuite).toHaveBeenCalledTimes(2);
    expect(runQaTestFileScenarios).toHaveBeenCalledTimes(1);
  });

  it("starts native suite proof before isolated flow work fills the weighted queue", async () => {
    const repoRoot = await makeTempRepo("qa-suite-native-before-isolated-");
    const shared = blockNextQaFlowSuite();
    const testFile = blockNextQaTestFileRun();

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
    await shared.started;
    await testFile.started;
    await Promise.resolve();

    expect(runQaFlowSuite).toHaveBeenCalledTimes(1);
    expect(runQaTestFileScenarios).toHaveBeenCalledTimes(1);

    testFile.release();
    shared.release();
    await runPromise;

    expect(runQaFlowSuite).toHaveBeenCalledTimes(2);
  });

  it("waits for already-started partitions before recording a unified failure", async () => {
    const repoRoot = await makeTempRepo("qa-suite-reject-settle-");
    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "reject-settle");
    const priorArtifactPaths = [
      path.join(outputDir, "qa-suite-summary.json"),
      path.join(outputDir, "qa-evidence.json"),
      path.join(outputDir, "qa-suite-report.md"),
    ];
    await fs.mkdir(outputDir, { recursive: true });
    await Promise.all(
      priorArtifactPaths.map((artifactPath) => fs.writeFile(artifactPath, "stale")),
    );
    const testFile = blockNextQaTestFileRun();
    runQaFlowSuite.mockRejectedValueOnce(
      new Error("flow partition failed", {
        cause: Object.assign(new Error("unrelated capacity failure"), {
          code: "POOL_EXHAUSTED",
        }),
      }),
    );
    const runPromise = runQaSuite({
      repoRoot,
      outputDir: ".artifacts/qa-e2e/reject-settle",
      concurrency: 2,
      scenarioIds: ["channel-chat-baseline", "control-ui-chat-flow-playwright"],
    });
    let completed = false;
    void runPromise.then(() => {
      completed = true;
    });
    await testFile.started;
    await Promise.resolve();

    expect(completed).toBe(false);
    for (const artifactPath of priorArtifactPaths) {
      await expect(fs.access(artifactPath)).rejects.toMatchObject({ code: "ENOENT" });
    }

    testFile.release();
    const result = await runPromise;
    expect(completed).toBe(true);
    expect(result.executionKind).toBe("suite");
    if (result.executionKind !== "suite") {
      throw new Error("expected unified suite result");
    }
    expect(result.result.scenarios).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "fail",
          details: expect.stringContaining("suite partition failed: flow partition failed"),
        }),
        expect.objectContaining({ status: "pass" }),
      ]),
    );
    const summary = JSON.parse(await fs.readFile(result.result.summaryPath, "utf8")) as {
      counts: { failed: number; passed: number; total: number };
    };
    expect(summary.counts).toMatchObject({ total: 2, passed: 1, failed: 1 });
    await expect(fs.access(result.result.evidencePath)).resolves.toBeUndefined();
    await expect(fs.access(result.result.reportPath)).resolves.toBeUndefined();
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
        execution?: { channel?: { driver?: string; id?: string; live?: boolean } };
        result?: { status?: string };
        test?: { id?: string };
      }>;
    };
    for (const scenarioId of ["whatsapp-status-command", "whatsapp-access-control-dm-open"]) {
      const blocked = evidence.entries?.find((entry) => entry.test?.id === scenarioId);
      expect(blocked).toMatchObject({
        execution: { channel: { id: "whatsapp", live: false } },
        result: { status: "blocked" },
      });
      expect(blocked?.execution?.channel?.driver).toBeUndefined();
    }
    expect(result.observedCells).not.toEqual(
      expect.arrayContaining([
        { scenarioId: "whatsapp-status-command", executionKind: "flow", channel: "whatsapp" },
        {
          scenarioId: "whatsapp-access-control-dm-open",
          executionKind: "flow",
          channel: "whatsapp",
        },
      ]),
    );
  });

  it("omits later credential failures after the first failed flow scenario", async () => {
    const repoRoot = await makeTempRepo("qa-suite-fail-fast-credential-unavailable-");
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
      outputDir: ".artifacts/qa-e2e/fail-fast-credential-unavailable",
      providerMode: "mock-openai",
      channelDriver: "live",
      adapterFactories: [{ id: "whatsapp", matches: () => true, create: vi.fn() }],
      failFast: true,
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
    expect(runQaTestFileScenarios).not.toHaveBeenCalled();
    expect(result.result.scenarios).toHaveLength(1);
    expect(result.result.scenarios).toMatchObject([
      { status: "fail", details: expect.stringContaining("channel credential unavailable") },
    ]);
    const evidence = JSON.parse(await fs.readFile(result.result.evidencePath, "utf8")) as {
      entries?: Array<{ test?: { id?: string } }>;
    };
    expect(evidence.entries?.map((entry) => entry.test?.id)).toEqual(["whatsapp-status-command"]);
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

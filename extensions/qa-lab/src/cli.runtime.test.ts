// Qa Lab tests cover cli plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { QaScenarioPack } from "./scenario-catalog.js";

const {
  runQaManualLane,
  runQaFlowSuiteFromRuntime,
  runQaSuite,
  runQaCharacterEval,
  runQaMultipass,
  runCanonicalLiveScenarios,
  listLiveTransportQaAdapterFactories,
  listTelegramQaScenarioCatalog,
  runTelegramQaLive,
  startQaLabServer,
  writeQaDockerHarnessFiles,
  buildQaDockerHarnessImage,
  runQaDockerUp,
  defaultQaRuntimeModelForMode,
  readQaScenarioPack,
} = vi.hoisted(() => ({
  runQaManualLane: vi.fn(),
  runQaFlowSuiteFromRuntime: vi.fn(),
  runQaSuite: vi.fn(),
  runQaCharacterEval: vi.fn(),
  runQaMultipass: vi.fn(),
  runCanonicalLiveScenarios: vi.fn(),
  listLiveTransportQaAdapterFactories: vi.fn(),
  listTelegramQaScenarioCatalog: vi.fn(),
  runTelegramQaLive: vi.fn(),
  startQaLabServer: vi.fn(),
  writeQaDockerHarnessFiles: vi.fn(),
  buildQaDockerHarnessImage: vi.fn(),
  runQaDockerUp: vi.fn(),
  defaultQaRuntimeModelForMode:
    vi.fn<(mode: string, options?: { alternate?: boolean }) => string>(),
  readQaScenarioPack: vi.fn<() => QaScenarioPack>(),
}));

vi.mock("./manual-lane.runtime.js", () => ({
  runQaManualLane,
}));

vi.mock("./suite-launch.runtime.js", () => ({
  runQaFlowSuiteFromRuntime,
  runQaSuite,
}));

vi.mock("./character-eval.js", () => ({
  runQaCharacterEval,
}));

vi.mock("./multipass.runtime.js", () => ({
  runQaMultipass,
}));

vi.mock("./live-transports/cli.js", () => ({
  listLiveTransportQaAdapterFactories,
}));

vi.mock("./live-transports/shared/canonical-scenarios.js", async (importOriginal) => ({
  ...(await importOriginal()),
  runCanonicalLiveScenarios,
}));

vi.mock("./live-transports/telegram/adapter.runtime.js", () => ({
  createTelegramQaTransportAdapter: vi.fn(),
}));

vi.mock("./live-transports/telegram/telegram-live.runtime.js", () => ({
  listTelegramQaScenarioCatalog,
  runTelegramQaLive,
}));

vi.mock("./lab-server.js", () => ({
  startQaLabServer,
}));

vi.mock("./docker-harness.js", () => ({
  writeQaDockerHarnessFiles,
  buildQaDockerHarnessImage,
}));

vi.mock("./docker-up.runtime.js", () => ({
  runQaDockerUp,
}));

vi.mock("./model-selection.runtime.js", () => ({
  defaultQaRuntimeModelForMode,
}));

vi.mock("./scenario-catalog.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./scenario-catalog.js")>();
  readQaScenarioPack.mockImplementation(actual.readQaScenarioPack);
  return {
    ...actual,
    readQaScenarioPack,
  };
});

import { resolveRepoRelativeOutputDir } from "./cli-paths.js";
import {
  runQaLabSelfCheckCommand,
  runQaCredentialsAddCommand,
  runQaDockerBuildImageCommand,
  runQaDockerScaffoldCommand,
  runQaDockerUpCommand,
  runQaCharacterEvalCommand,
  runQaCoverageReportCommand,
  runQaJsonlReplayCommand,
  runQaManualLaneCommand,
  runQaParityReportCommand,
  runQaProfileCommand,
  runQaSuiteCommand,
} from "./cli.runtime.js";
import { QaSuiteInfraError } from "./errors.js";
import { QA_EVIDENCE_FILENAME } from "./evidence-summary.js";
import { loadNonYamlScenarioRefs } from "./live-transports/shared/live-transport-scenarios.js";
import { runQaTelegramCommand } from "./live-transports/telegram/cli.runtime.js";
import { defaultQaModelForMode as defaultQaProviderModelForMode } from "./model-selection.js";
import type { QaProviderModeInput } from "./run-config.js";

const DEFAULT_LIVE_FRONTIER_MODEL = defaultQaProviderModelForMode("live-frontier");

function mockFirstObjectArg(mock: unknown): Record<string, unknown> {
  const calls = (mock as { mock?: { calls?: Array<Array<unknown>> } }).mock?.calls ?? [];
  const [arg] = calls[0] ?? [];
  if (!arg || typeof arg !== "object") {
    throw new Error("expected first mock object argument");
  }
  return arg as Record<string, unknown>;
}

function expectFields(value: unknown, expected: Record<string, unknown>): void {
  if (!value || typeof value !== "object") {
    throw new Error("expected fields object");
  }
  const record = value as Record<string, unknown>;
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key], key).toEqual(expectedValue);
  }
}

function expectWriteContains(mock: unknown, fragment: string): void {
  const calls = (mock as { mock?: { calls?: Array<Array<unknown>> } }).mock?.calls ?? [];
  expect(
    calls.some(([value]) => String(value).includes(fragment)),
    `write contains ${fragment}`,
  ).toBe(true);
}

function makeQaEvidence(entries: unknown[] = []) {
  return {
    kind: "openclaw.qa.evidence-summary",
    schemaVersion: 2,
    generatedAt: "2026-06-14T00:00:00.000Z",
    evidenceMode: "full",
    entries,
  };
}

function flowSuiteRuntimeResult(params: {
  evidencePath?: string;
  reportPath: string;
  summaryPath: string;
  scenarios?: unknown[];
}) {
  return {
    executionKind: "flow",
    result: {
      outputDir: path.dirname(params.reportPath),
      evidencePath:
        params.evidencePath ?? path.join(path.dirname(params.reportPath), "qa-evidence.json"),
      reportPath: params.reportPath,
      summaryPath: params.summaryPath,
      report: "# QA Suite Report\n",
      scenarios: params.scenarios ?? [],
      watchUrl: "http://127.0.0.1:43124",
    },
  };
}

function unifiedSuiteRuntimeResult(params: {
  evidencePath: string;
  outputDir: string;
  reportPath: string;
  summaryPath: string;
  scenarios?: unknown[];
}) {
  return {
    executionKind: "suite",
    result: {
      outputDir: params.outputDir,
      reportPath: params.reportPath,
      evidencePath: params.evidencePath,
      summaryPath: params.summaryPath,
      report: "# QA Suite Report\n",
      scenarios: params.scenarios ?? [],
    },
  };
}

describe("qa cli runtime", () => {
  let stdoutWrite: ReturnType<typeof vi.spyOn>;
  let stderrWrite: ReturnType<typeof vi.spyOn>;
  let suiteArtifactsDir: string;
  let suiteEvidencePath: string;
  let suiteReportPath: string;
  let suiteSummaryPath: string;
  let telegramArtifactsDir: string;
  let telegramSummaryPath: string;

  beforeEach(async () => {
    suiteArtifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "qa-suite-runtime-"));
    suiteEvidencePath = path.join(suiteArtifactsDir, "qa-evidence.json");
    suiteReportPath = path.join(suiteArtifactsDir, "qa-suite-report.md");
    suiteSummaryPath = path.join(suiteArtifactsDir, "qa-suite-summary.json");
    telegramArtifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "qa-telegram-runtime-"));
    telegramSummaryPath = path.join(telegramArtifactsDir, QA_EVIDENCE_FILENAME);
    await fs.writeFile(suiteReportPath, "# QA Suite Report\n", "utf8");
    await fs.writeFile(suiteEvidencePath, JSON.stringify(makeQaEvidence()), "utf8");
    await fs.writeFile(
      suiteSummaryPath,
      JSON.stringify({
        counts: {
          total: 1,
          passed: 1,
          failed: 0,
        },
        scenarios: [],
      }),
      "utf8",
    );
    await fs.writeFile(
      telegramSummaryPath,
      JSON.stringify({
        counts: {
          total: 0,
          passed: 0,
          failed: 0,
        },
        scenarios: [],
      }),
      "utf8",
    );
    stdoutWrite = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    stderrWrite = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    runQaFlowSuiteFromRuntime.mockReset();
    runQaSuite.mockReset();
    runQaCharacterEval.mockReset();
    runQaManualLane.mockReset();
    runQaMultipass.mockReset();
    runCanonicalLiveScenarios.mockReset();
    listLiveTransportQaAdapterFactories.mockReset();
    listTelegramQaScenarioCatalog.mockReset();
    runTelegramQaLive.mockReset();
    startQaLabServer.mockReset();
    writeQaDockerHarnessFiles.mockReset();
    buildQaDockerHarnessImage.mockReset();
    runQaDockerUp.mockReset();
    defaultQaRuntimeModelForMode.mockImplementation(
      (mode: string, options?: { alternate?: boolean }) =>
        defaultQaProviderModelForMode(mode as QaProviderModeInput, options),
    );
    readQaScenarioPack.mockClear();
    runQaSuite.mockResolvedValue(
      flowSuiteRuntimeResult({
        reportPath: suiteReportPath,
        summaryPath: suiteSummaryPath,
      }),
    );
    runQaFlowSuiteFromRuntime.mockResolvedValue({
      outputDir: suiteArtifactsDir,
      evidencePath: suiteEvidencePath,
      watchUrl: "http://127.0.0.1:43124",
      reportPath: suiteReportPath,
      summaryPath: suiteSummaryPath,
      scenarios: [],
    });
    runQaCharacterEval.mockResolvedValue({
      reportPath: "/tmp/character-report.md",
      summaryPath: "/tmp/character-summary.json",
    });
    runQaManualLane.mockResolvedValue({
      model: "openai/gpt-5.6-luna",
      waited: { status: "ok" },
      reply: "done",
      watchUrl: "http://127.0.0.1:43124",
    });
    runQaMultipass.mockResolvedValue({
      outputDir: "/tmp/multipass",
      reportPath: "/tmp/multipass/qa-suite-report.md",
      summaryPath: "/tmp/multipass/qa-suite-summary.json",
      hostLogPath: "/tmp/multipass/multipass-host.log",
      bootstrapLogPath: "/tmp/multipass/multipass-guest-bootstrap.log",
      guestScriptPath: "/tmp/multipass/multipass-guest-run.sh",
      vmName: "openclaw-qa-test",
      scenarioIds: ["channel-chat-baseline"],
    });
    runTelegramQaLive.mockResolvedValue({
      outputDir: telegramArtifactsDir,
      reportPath: path.join(telegramArtifactsDir, "report.md"),
      summaryPath: telegramSummaryPath,
      observedMessagesPath: path.join(telegramArtifactsDir, "observed.json"),
      scenarios: [],
    });
    runCanonicalLiveScenarios.mockResolvedValue({
      outputDir: telegramArtifactsDir,
      reportPath: path.join(telegramArtifactsDir, "canonical-report.md"),
      summaryPath: telegramSummaryPath,
      scenarios: [],
    });
    listTelegramQaScenarioCatalog.mockReturnValue([
      {
        id: "telegram-stream-final-single-message",
        title: "Telegram streamed final reply",
        defaultEnabled: false,
        rationale: "stream rationale",
        regressionRefs: [],
      },
    ]);
    listLiveTransportQaAdapterFactories.mockReturnValue([
      {
        id: "telegram",
        scenarioIds: ["channel-chat-baseline"],
        matches: vi.fn(),
        create: vi.fn(),
      },
    ]);
    startQaLabServer.mockResolvedValue({
      baseUrl: "http://127.0.0.1:58000",
      runSelfCheck: vi.fn().mockResolvedValue({
        outputPath: "/tmp/report.md",
        report: "",
        checks: [{ name: "QA self-check scenario", status: "pass" }],
        scenarioResult: {
          name: "QA self-check scenario",
          status: "pass",
          steps: [],
        },
      }),
      stop: vi.fn(),
    });
    writeQaDockerHarnessFiles.mockResolvedValue({
      outputDir: "/tmp/openclaw-repo/.artifacts/qa-docker",
    });
    buildQaDockerHarnessImage.mockResolvedValue({
      imageName: "openclaw:qa-local-prebaked",
    });
    runQaDockerUp.mockResolvedValue({
      outputDir: "/tmp/openclaw-repo/.artifacts/qa-docker",
      qaLabUrl: "http://127.0.0.1:43124",
      gatewayUrl: "http://127.0.0.1:18789/",
      stopCommand: "docker compose down",
    });
  });

  afterEach(async () => {
    stdoutWrite.mockRestore();
    stderrWrite.mockRestore();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    await fs.rm(suiteArtifactsDir, { recursive: true, force: true });
    await fs.rm(telegramArtifactsDir, { recursive: true, force: true });
  });

  it("runs selected Playwright scenarios through the suite command", async () => {
    const evidencePath = path.join(suiteArtifactsDir, "qa-evidence.json");
    await fs.writeFile(evidencePath, JSON.stringify(makeQaEvidence()), "utf8");
    runQaSuite.mockResolvedValueOnce(
      unifiedSuiteRuntimeResult({
        outputDir: suiteArtifactsDir,
        reportPath: suiteReportPath,
        summaryPath: suiteSummaryPath,
        evidencePath,
      }),
    );

    await runQaSuiteCommand({
      repoRoot: process.cwd(),
      outputDir: ".artifacts/qa-e2e/scenario-test",
      primaryModel: "mock-openai/gpt-5.6-luna",
      scenarioIds: ["control-ui-chat-flow-playwright"],
    });

    expect(runQaSuite).toHaveBeenCalledWith({
      repoRoot: process.cwd(),
      outputDir: path.join(process.cwd(), ".artifacts", "qa-e2e", "scenario-test"),
      transportId: "qa-channel",
      channelDriver: undefined,
      channelDriverSelection: undefined,
      primaryModel: "mock-openai/gpt-5.6-luna",
      alternateModel: undefined,
      fastMode: undefined,
      scenarioIds: ["control-ui-chat-flow-playwright"],
    });
    expectWriteContains(stdoutWrite, `QA suite evidence: ${evidencePath}`);
    expectWriteContains(stdoutWrite, `QA suite summary: ${suiteSummaryPath}`);
  });

  it("rejects host-only resource options for Playwright scenarios", async () => {
    await expect(
      runQaSuiteCommand({
        repoRoot: process.cwd(),
        image: "lts",
        scenarioIds: ["control-ui-chat-flow-playwright"],
      }),
    ).rejects.toThrow("--image, --cpus, --memory, and --disk require --runner multipass");

    expect(runQaSuite).not.toHaveBeenCalled();
  });

  it("dispatches a taxonomy-backed profile category through the suite runner", async () => {
    const previousProfile = process.env.OPENCLAW_QA_PROFILE;
    process.env.OPENCLAW_QA_PROFILE = "release";
    try {
      runQaSuite.mockImplementationOnce(async () => {
        expect(process.env.OPENCLAW_QA_PROFILE).toBe("smoke-ci");
        await fs.writeFile(
          suiteEvidencePath,
          JSON.stringify(
            makeQaEvidence([
              {
                test: {
                  kind: "qa-scenario",
                  id: "dm-chat-baseline",
                  title: "DM baseline conversation",
                  source: {
                    path: "qa/scenarios/channels/dm-chat-baseline.yaml",
                  },
                },
                coverage: [
                  {
                    id: "channels.dm",
                    role: "primary",
                  },
                ],
                execution: {
                  runner: "host",
                  environment: {
                    ref: null,
                    os: process.platform,
                    nodeVersion: process.version,
                  },
                  provider: {
                    id: "openai",
                    live: false,
                    model: {
                      name: "gpt-5.6-luna",
                      ref: "mock-openai/gpt-5.6-luna",
                    },
                    fixture: "mock-openai",
                  },
                  channel: {
                    id: "qa-channel",
                    live: false,
                  },
                  packageSource: {
                    kind: "source-checkout",
                  },
                  artifacts: [],
                },
                result: {
                  status: "pass",
                },
              },
            ]),
          ),
          "utf8",
        );
        return flowSuiteRuntimeResult({
          reportPath: suiteReportPath,
          summaryPath: suiteSummaryPath,
        });
      });

      await runQaProfileCommand({
        repoRoot: "/tmp/openclaw-repo",
        outputDir: ".artifacts/qa-e2e/smoke-ci",
        profile: "smoke-ci",
        surface: "channel-framework",
        category: "channel-framework.conversation-routing-and-delivery",
        scenarioIds: ["dm-chat-baseline"],
        transportId: "qa-channel",
        fastMode: true,
        concurrency: 2,
        allowFailures: true,
      });

      const suiteArgs = mockFirstObjectArg(runQaSuite);
      expectFields(suiteArgs, {
        repoRoot: path.resolve("/tmp/openclaw-repo"),
        outputDir: path.resolve("/tmp/openclaw-repo", ".artifacts/qa-e2e/smoke-ci"),
        transportId: "qa-channel",
        channelDriver: "crabline",
        providerMode: "mock-openai",
        fastMode: true,
        concurrency: 2,
      });
      expect(suiteArgs.channelDriverSelection).toMatchObject({
        channel: "telegram",
        channelDriver: "crabline",
      });
      expect(suiteArgs.scenarioIds).toEqual(["dm-chat-baseline"]);
      expect(process.env.OPENCLAW_QA_PROFILE).toBe("release");
      const evidence = JSON.parse(await fs.readFile(suiteEvidencePath, "utf8")) as {
        evidenceMode?: unknown;
        entries?: unknown[];
        profile?: unknown;
        scorecard?: {
          run?: { evidenceEntryCount?: unknown };
          coverageIds?: { fulfilled?: unknown };
          categoryReports?: Array<{
            id?: unknown;
            coverageIds?: { fulfilled?: unknown };
            missingCoverageIds?: unknown;
          }>;
        };
      };
      expect(evidence.profile).toBe("smoke-ci");
      expect(evidence.evidenceMode).toBe("slim");
      expect(evidence.scorecard).toMatchObject({
        run: {
          evidenceEntryCount: 1,
        },
      });
      expect(evidence.scorecard).not.toHaveProperty("kind");
      expect(evidence.scorecard).not.toHaveProperty("taxonomy");
      expect(evidence.scorecard).not.toHaveProperty("profile");
      expect(evidence.scorecard?.coverageIds?.fulfilled).toBe(1);
      expect(evidence.scorecard?.categoryReports?.[0]).toMatchObject({
        id: "channel-framework.conversation-routing-and-delivery",
        coverageIds: {
          fulfilled: 1,
        },
      });
      expect(evidence.entries?.[0]).not.toHaveProperty("execution");
      expect(JSON.stringify(evidence.scorecard)).not.toContain("dm-chat-baseline");
      expectWriteContains(stdoutWrite, "QA run profile: smoke-ci; categories: 1; scenarios:");
      expectWriteContains(stdoutWrite, `QA profile scorecard: ${suiteEvidencePath}`);
    } finally {
      if (previousProfile === undefined) {
        delete process.env.OPENCLAW_QA_PROFILE;
      } else {
        process.env.OPENCLAW_QA_PROFILE = previousProfile;
      }
    }
  });

  it("passes non-Crabline profile channel drivers as declarative suite metadata", async () => {
    await runQaProfileCommand({
      repoRoot: "/tmp/openclaw-repo",
      profile: "release",
      surface: "agent-runtime-and-provider-execution",
      category: "agent-runtime-and-provider-execution.agent-turn-execution",
      providerMode: "mock-openai",
    });

    const suiteArgs = mockFirstObjectArg(runQaSuite);
    expect(suiteArgs.channelDriver).toBe("live");
    expect(suiteArgs.channelDriverSelection).toBeUndefined();
  });

  it("runs the all profile through the live taxonomy profile path", async () => {
    await runQaProfileCommand({
      repoRoot: "/tmp/openclaw-repo",
      profile: "all",
      surface: "agent-runtime-and-provider-execution",
      category: "agent-runtime-and-provider-execution.agent-turn-execution",
      providerMode: "mock-openai",
    });

    const suiteArgs = mockFirstObjectArg(runQaSuite);
    expectFields(suiteArgs, {
      providerMode: "mock-openai",
      channelDriver: "live",
    });
    expect(suiteArgs.channelDriverSelection).toBeUndefined();
    expectWriteContains(stdoutWrite, "QA run profile: all; categories: 1; scenarios:");
  });

  it("filters QA-channel-pinned scenarios from the Crabline smoke profile", async () => {
    runQaSuite.mockImplementationOnce(async () => {
      await fs.writeFile(suiteEvidencePath, JSON.stringify(makeQaEvidence()), "utf8");
      return flowSuiteRuntimeResult({
        reportPath: suiteReportPath,
        summaryPath: suiteSummaryPath,
      });
    });

    await runQaProfileCommand({
      repoRoot: "/tmp/openclaw-repo",
      profile: "smoke-ci",
      scenarioIds: ["dm-chat-baseline", "instruction-followthrough-repo-contract"],
    });

    const suiteArgs = mockFirstObjectArg(runQaSuite);
    expect(suiteArgs.channelDriver).toBe("crabline");
    expect(suiteArgs.scenarioIds).toEqual(["dm-chat-baseline"]);
    expect(suiteArgs.scenarioIds).not.toEqual(
      expect.arrayContaining([
        "instruction-followthrough-repo-contract",
        "subagent-forked-context",
        "subagent-handoff",
        "group-message-tool-unavailable-fallback",
        "qa-channel-reconnect-dedupe",
        "reaction-edit-delete",
        "claude-cli-provider-capabilities",
        "claude-cli-provider-capabilities-subscription",
        "image-generation-roundtrip",
        "image-understanding-attachment",
        "native-image-generation",
        "active-memory-preprompt-recall",
        "memory-recall",
        "session-memory-ranking",
        "thread-memory-isolation",
        "personal-channel-thread-reply",
        "personal-memory-preference-recall",
        "personal-reminder-roundtrip",
        "cron-natural-fire-no-duplicate",
        "cron-one-minute-ping",
        "cron-single-run-no-duplicate",
        "control-ui-qa-channel-image-roundtrip",
        "config-apply-restart-wakeup",
      ]),
    );
  });

  it("rejects qa profile runs that do not match taxonomy categories", async () => {
    await expect(
      runQaProfileCommand({
        repoRoot: "/tmp/openclaw-repo",
        profile: "smoke-ci",
        surface: "unknown-surface",
      }),
    ).rejects.toThrow(
      "qa run did not find taxonomy categories for --qa-profile smoke-ci --surface unknown-surface.",
    );
    expect(runQaSuite).not.toHaveBeenCalled();
  });

  it("rejects qa profile scenario filters outside the selected taxonomy categories", async () => {
    await expect(
      runQaProfileCommand({
        repoRoot: "/tmp/openclaw-repo",
        profile: "smoke-ci",
        category: "channel-framework.conversation-routing-and-delivery",
        scenarioIds: ["not-a-real-scenario"],
      }),
    ).rejects.toThrow(
      "qa run did not find taxonomy scenarios for --qa-profile smoke-ci --category channel-framework.conversation-routing-and-delivery --scenario not-a-real-scenario.",
    );
    expect(runQaSuite).not.toHaveBeenCalled();
  });

  it("rejects qa profile runs whose profile is not declared in taxonomy.yaml", async () => {
    await expect(
      runQaProfileCommand({
        repoRoot: "/tmp/openclaw-repo",
        profile: "nightly",
      }),
    ).rejects.toThrow('--qa-profile must be one of smoke-ci, release, all, got "nightly".');
    expect(runQaSuite).not.toHaveBeenCalled();
  });

  it("resolves suite repo-root-relative paths before dispatching", async () => {
    await runQaSuiteCommand({
      repoRoot: "/tmp/openclaw-repo",
      outputDir: ".artifacts/qa/frontier",
      providerMode: "live-frontier",
      primaryModel: "openai/gpt-5.6-luna",
      alternateModel: "anthropic/claude-sonnet-4-6",
      fastMode: true,
      thinking: "medium",
      scenarioIds: ["approval-turn-tool-followthrough"],
    });

    expect(runQaSuite).toHaveBeenCalledWith({
      repoRoot: path.resolve("/tmp/openclaw-repo"),
      outputDir: path.resolve("/tmp/openclaw-repo", ".artifacts/qa/frontier"),
      transportId: "qa-channel",
      channelDriver: undefined,
      channelDriverSelection: undefined,
      providerMode: "live-frontier",
      primaryModel: "openai/gpt-5.6-luna",
      alternateModel: "anthropic/claude-sonnet-4-6",
      fastMode: true,
      thinkingDefault: "medium",
      scenarioIds: ["approval-turn-tool-followthrough"],
    });
  });

  it("runs canonical scenarios through a discovered live adapter factory", async () => {
    await runQaSuiteCommand({
      repoRoot: "/tmp/openclaw-repo",
      outputDir: ".artifacts/qa/telegram-live",
      channelDriver: "live",
      channel: "telegram",
      providerMode: "mock-openai",
      scenarioIds: ["channel-chat-baseline"],
    });

    expect(runQaSuite).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterFactories: listLiveTransportQaAdapterFactories.mock.results[0]?.value,
        channelDriver: "live",
        channelId: "telegram",
        concurrency: 1,
        adapterOptions: expect.objectContaining({
          repoRoot: path.resolve("/tmp/openclaw-repo"),
        }),
        scenarioIds: ["channel-chat-baseline"],
      }),
    );
  });

  it("uses the selected live adapter's declared scenarios by default", async () => {
    await runQaSuiteCommand({
      channelDriver: "live",
      channel: "telegram",
    });

    expect(runQaSuite).toHaveBeenCalledWith(
      expect.objectContaining({
        scenarioIds: ["channel-chat-baseline"],
      }),
    );
  });

  it("rejects live adapter selection under Multipass", async () => {
    await expect(
      runQaSuiteCommand({
        runner: "multipass",
        channelDriver: "live",
        channel: "telegram",
        scenarioIds: ["channel-chat-baseline"],
      }),
    ).rejects.toThrow("--channel-driver live with --channel requires --runner host.");
    expect(runQaMultipass).not.toHaveBeenCalled();
  });

  it("rejects runtime-pair execution for live adapters", async () => {
    await expect(
      runQaSuiteCommand({
        channelDriver: "live",
        channel: "telegram",
        runtimePair: "openclaw,codex",
      }),
    ).rejects.toThrow("--runtime-pair is not supported with a live QA adapter.");
    expect(runQaSuite).not.toHaveBeenCalled();
  });

  it("keeps live taxonomy metadata unchanged without an explicit adapter channel", async () => {
    await runQaSuiteCommand({
      channelDriver: "live",
      scenarioIds: ["channel-chat-baseline"],
    });

    expect(runQaSuite).toHaveBeenCalledWith(
      expect.not.objectContaining({ adapterFactories: expect.anything() }),
    );
  });

  it("uses the Crabline default channel when selected scenarios do not request one", async () => {
    await runQaSuiteCommand({
      repoRoot: "/tmp/openclaw-repo",
      outputDir: ".artifacts/qa/multipass-telegram",
      providerMode: "mock-openai",
      channelDriver: "crabline",
      scenarioIds: ["channel-chat-baseline"],
    });

    expect(runQaSuite).toHaveBeenCalledWith({
      repoRoot: path.resolve("/tmp/openclaw-repo"),
      outputDir: path.resolve("/tmp/openclaw-repo", ".artifacts/qa/multipass-telegram"),
      transportId: "qa-channel",
      channelDriver: "crabline",
      channelDriverSelection: {
        capabilityMatrixPath: "crabline-fake-provider-capabilities.json",
        channel: "telegram",
        channelDriver: "crabline",
        smokeArtifactPath: "crabline-fake-provider-smoke.json",
      },
      providerMode: "mock-openai",
      primaryModel: undefined,
      alternateModel: undefined,
      fastMode: undefined,
      scenarioIds: ["channel-chat-baseline"],
    });
  });

  it("defers mixed Crabline channels to the host suite launcher", async () => {
    await runQaSuiteCommand({
      repoRoot: "/tmp/openclaw-repo",
      providerMode: "mock-openai",
      channelDriver: "crabline",
      scenarioIds: ["telegram-help-command", "matrix-restart-resume"],
    });

    expect(runQaSuite).toHaveBeenCalledWith(
      expect.objectContaining({
        channelDriver: "crabline",
        channelDriverSelection: undefined,
        scenarioIds: ["telegram-help-command", "matrix-restart-resume"],
      }),
    );
  });

  it("forwards resolved catalog scenarios for automatic mixed-channel host runs", async () => {
    await runQaSuiteCommand({
      providerMode: "mock-openai",
      channelDriver: "crabline",
    });

    const suiteArgs = mockFirstObjectArg(runQaSuite);
    expect(suiteArgs.channelDriverSelection).toBeUndefined();
    expect(suiteArgs.scenarioIds).toEqual(
      expect.arrayContaining(["telegram-help-command", "matrix-restart-resume"]),
    );
    const scenarioById = new Map(
      readQaScenarioPack().scenarios.map((scenario) => [scenario.id, scenario]),
    );
    expect(
      (suiteArgs.scenarioIds as string[]).every(
        (scenarioId) => scenarioById.get(scenarioId)?.execution.kind === "flow",
      ),
    ).toBe(true);
  });

  it("keeps mixed Crabline channels unsupported on the Multipass runner", async () => {
    await expect(
      runQaSuiteCommand({
        providerMode: "mock-openai",
        channelDriver: "crabline",
        runner: "multipass",
        scenarioIds: ["telegram-help-command", "matrix-restart-resume"],
      }),
    ).rejects.toThrow("Selected QA scenarios require multiple channels (telegram, matrix)");
    expect(runQaMultipass).not.toHaveBeenCalled();
  });

  it("passes Crabline channel-driver selection through to the multipass runner", async () => {
    await runQaSuiteCommand({
      repoRoot: "/tmp/openclaw-repo",
      providerMode: "mock-openai",
      channelDriver: "crabline",
      channel: "telegram",
      runner: "multipass",
      scenarioIds: ["channel-chat-baseline"],
      allowFailures: true,
    });

    expect(runQaMultipass).toHaveBeenCalledWith(
      expect.objectContaining({
        channelDriverSelection: {
          capabilityMatrixPath: "crabline-fake-provider-capabilities.json",
          channel: "telegram",
          channelDriver: "crabline",
          smokeArtifactPath: "crabline-fake-provider-smoke.json",
        },
      }),
    );
    expect(runQaSuite).not.toHaveBeenCalled();
  });

  it("passes explicit suite plugin enablements into the host gateway run", async () => {
    await runQaSuiteCommand({
      repoRoot: "/tmp/openclaw-repo",
      providerMode: "mock-openai",
      scenarioIds: ["channel-chat-baseline"],
      enabledPluginIds: ["browser", "memory-core"],
    });

    expect(runQaSuite).toHaveBeenCalledWith({
      repoRoot: path.resolve("/tmp/openclaw-repo"),
      outputDir: undefined,
      transportId: "qa-channel",
      channelDriver: undefined,
      channelDriverSelection: undefined,
      providerMode: "mock-openai",
      primaryModel: undefined,
      alternateModel: undefined,
      fastMode: undefined,
      scenarioIds: ["channel-chat-baseline"],
      enabledPluginIds: ["browser", "memory-core"],
    });
  });

  it("passes explicit suite plugin enablements through to the multipass runner", async () => {
    await runQaSuiteCommand({
      repoRoot: "/tmp/openclaw-repo",
      runner: "multipass",
      providerMode: "mock-openai",
      scenarioIds: ["channel-chat-baseline"],
      enabledPluginIds: ["browser", "memory-core"],
      allowFailures: true,
    });

    expect(runQaMultipass).toHaveBeenCalledWith(
      expect.objectContaining({
        enabledPluginIds: ["browser", "memory-core"],
      }),
    );
    expect(runQaSuite).not.toHaveBeenCalled();
  });

  it("passes runtime-pair suite selection through to the host runner", async () => {
    await runQaSuiteCommand({
      repoRoot: "/tmp/openclaw-repo",
      providerMode: "mock-openai",
      scenarioIds: ["approval-turn-tool-followthrough"],
      runtimePair: "openclaw,codex",
    });

    expect(runQaSuite).toHaveBeenCalledWith({
      repoRoot: path.resolve("/tmp/openclaw-repo"),
      outputDir: undefined,
      transportId: "qa-channel",
      channelDriver: undefined,
      channelDriverSelection: undefined,
      providerMode: "mock-openai",
      primaryModel: undefined,
      alternateModel: undefined,
      fastMode: undefined,
      scenarioIds: ["approval-turn-tool-followthrough"],
      runtimePair: ["openclaw", "codex"],
    });
  });

  it("rejects unknown runtime-pair ids at the CLI boundary", async () => {
    await expect(
      runQaSuiteCommand({
        repoRoot: "/tmp/openclaw-repo",
        providerMode: "mock-openai",
        scenarioIds: ["approval-turn-tool-followthrough"],
        runtimePair: "legacy-runtime,codex",
      }),
    ).rejects.toThrow('--runtime-pair only supports "openclaw" and "codex".');
    expect(runQaSuite).not.toHaveBeenCalled();
  });

  it("accepts legacy pi as a runtime-pair suite alias", async () => {
    await runQaSuiteCommand({
      repoRoot: "/tmp/openclaw-repo",
      providerMode: "mock-openai",
      scenarioIds: ["approval-turn-tool-followthrough"],
      runtimePair: "pi,codex",
    });

    expect(runQaSuite).toHaveBeenCalledWith(
      expect.objectContaining({
        repoRoot: path.resolve("/tmp/openclaw-repo"),
        runtimePair: ["openclaw", "codex"],
      }),
    );
  });

  it("drops blank suite model refs so provider defaults apply", async () => {
    await runQaSuiteCommand({
      repoRoot: "/tmp/openclaw-repo",
      providerMode: "mock-openai",
      primaryModel: " ",
      alternateModel: "",
      scenarioIds: ["thread-memory-isolation"],
    });

    expect(runQaSuite).toHaveBeenCalledWith({
      repoRoot: path.resolve("/tmp/openclaw-repo"),
      outputDir: undefined,
      transportId: "qa-channel",
      channelDriver: undefined,
      channelDriverSelection: undefined,
      providerMode: "mock-openai",
      primaryModel: undefined,
      alternateModel: undefined,
      fastMode: undefined,
      scenarioIds: ["thread-memory-isolation"],
    });
  });

  it("resolves telegram qa repo-root-relative paths before dispatching", async () => {
    await runQaTelegramCommand({
      repoRoot: "/tmp/openclaw-repo",
      outputDir: ".artifacts/qa/telegram",
      providerMode: "live-frontier",
      primaryModel: "openai/gpt-5.6-luna",
      alternateModel: "openai/gpt-5.6-luna",
      fastMode: true,
      scenarioIds: ["telegram-help-command"],
      sutAccountId: "sut-live",
    });

    expect(runCanonicalLiveScenarios).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "telegram",
        options: expect.objectContaining({
          repoRoot: path.resolve("/tmp/openclaw-repo"),
          outputDir: path.resolve("/tmp/openclaw-repo", ".artifacts/qa/telegram"),
          providerMode: "live-frontier",
          primaryModel: "openai/gpt-5.6-luna",
          alternateModel: "openai/gpt-5.6-luna",
          fastMode: true,
          sutAccountId: "sut-live",
        }),
        scenarioIds: ["telegram-help-command"],
      }),
    );
    expect(runTelegramQaLive).not.toHaveBeenCalled();
  });

  it("rejects output dirs that escape the repo root", () => {
    expect(() => resolveRepoRelativeOutputDir("/tmp/openclaw-repo", "../outside")).toThrow(
      "--output-dir must stay within the repo root.",
    );
    expect(() => resolveRepoRelativeOutputDir("/tmp/openclaw-repo", "/tmp/outside")).toThrow(
      "--output-dir must be a relative path inside the repo root.",
    );
  });

  it("defaults telegram qa runs onto the live provider lane", async () => {
    await runQaTelegramCommand({
      repoRoot: "/tmp/openclaw-repo",
      scenarioIds: ["telegram-help-command"],
    });

    expect(runCanonicalLiveScenarios).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          repoRoot: path.resolve("/tmp/openclaw-repo"),
          providerMode: "live-frontier",
          allowFailures: undefined,
        }),
      }),
    );
    expect(runTelegramQaLive).not.toHaveBeenCalled();
  });

  it("keeps remaining Telegram defaults when Commander supplies an empty scenario list", async () => {
    await runQaTelegramCommand({
      repoRoot: "/tmp/openclaw-repo",
      scenarioIds: [],
    });

    expect(runCanonicalLiveScenarios).toHaveBeenCalled();
    expect(runTelegramQaLive).toHaveBeenCalledWith(
      expect.objectContaining({ scenarioIds: undefined }),
    );
  });

  it("uses the trusted Telegram launcher for canonical and legacy gateways", async () => {
    const candidateRoot = path.join(telegramArtifactsDir, "candidate");
    const boundaryDir = path.join(telegramArtifactsDir, "boundary");
    const launcherPath = path.join(telegramArtifactsDir, "openclaw-telegram-sut-launcher");
    const runtimeRoot = path.join(telegramArtifactsDir, "runtime");
    const runtimeTempParent = path.join(runtimeRoot, "tmp");
    const preloadPath = path.join(runtimeRoot, "openclaw-telegram-preentry.mjs");
    const runtimeEntryPath = path.join(candidateRoot, "dist", "index.js");
    await fs.mkdir(path.dirname(runtimeEntryPath), { recursive: true });
    await fs.mkdir(boundaryDir);
    await fs.mkdir(runtimeTempParent, { recursive: true });
    await fs.writeFile(launcherPath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await fs.writeFile(preloadPath, "export {};\n", { mode: 0o600 });
    await fs.writeFile(runtimeEntryPath, "export {};\n", { mode: 0o600 });
    vi.stubEnv("OPENCLAW_QA_TELEGRAM_SUT_FORWARDED_ENV_KEYS", "HOME,PATH");
    vi.stubEnv("OPENCLAW_QA_TELEGRAM_SUT_CLEANUP_TIMEOUT_MS", "60000");
    vi.stubEnv("OPENCLAW_QA_TELEGRAM_SUT_GID", "1002");
    vi.stubEnv("OPENCLAW_QA_TELEGRAM_SUT_OPENCLAW_COMMAND", launcherPath);
    vi.stubEnv("OPENCLAW_QA_TELEGRAM_SUT_PRELOAD_PATH", preloadPath);
    vi.stubEnv("OPENCLAW_QA_TELEGRAM_SUT_PROCESS_BOUNDARY_DIR", boundaryDir);
    vi.stubEnv("OPENCLAW_QA_TELEGRAM_SUT_RUNTIME_EXECUTABLE", process.execPath);
    vi.stubEnv("OPENCLAW_QA_TELEGRAM_SUT_UID", "1001");
    await runQaTelegramCommand({
      repoRoot: candidateRoot,
      scenarioIds: ["telegram-help-command", "telegram-stream-final-single-message"],
    });

    const sutOpenClawCommand = {
      executablePath: launcherPath,
      tempParentDir: runtimeTempParent,
      usePackagedPlugins: true,
      processBoundary: {
        kind: "linux-proc-v1",
        evidenceDir: boundaryDir,
        expectedUid: 1001,
        expectedGid: 1002,
        forwardedEnvKeys: ["HOME", "PATH"],
        runtimeExecutablePath: process.execPath,
        runtimeArgsPrefix: ["--import", preloadPath, runtimeEntryPath],
        terminationRetryTimeoutMs: 60_000,
      },
    };
    expect(runCanonicalLiveScenarios).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ sutOpenClawCommand }),
      }),
    );
    expect(runTelegramQaLive).toHaveBeenCalledWith(expect.objectContaining({ sutOpenClawCommand }));
  });

  it("rejects relative Telegram launcher paths before starting a gateway", async () => {
    vi.stubEnv("OPENCLAW_QA_TELEGRAM_SUT_OPENCLAW_COMMAND", "relative-launcher");
    await expect(
      runQaTelegramCommand({
        repoRoot: "/tmp/openclaw-repo",
        scenarioIds: ["telegram-help-command"],
      }),
    ).rejects.toThrow("OPENCLAW_QA_TELEGRAM_SUT_OPENCLAW_COMMAND must be an absolute file path.");

    expect(runCanonicalLiveScenarios).not.toHaveBeenCalled();
    expect(runTelegramQaLive).not.toHaveBeenCalled();
  });

  it("rejects non-executable Telegram launcher files before starting a gateway", async () => {
    const launcherPath = path.join(telegramArtifactsDir, "non-executable-launcher");
    await fs.writeFile(launcherPath, "#!/bin/sh\nexit 0\n", { mode: 0o600 });
    vi.stubEnv("OPENCLAW_QA_TELEGRAM_SUT_OPENCLAW_COMMAND", launcherPath);
    await expect(
      runQaTelegramCommand({
        repoRoot: "/tmp/openclaw-repo",
        scenarioIds: ["telegram-help-command"],
      }),
    ).rejects.toThrow(
      `OPENCLAW_QA_TELEGRAM_SUT_OPENCLAW_COMMAND must point to an executable regular file: ${launcherPath}`,
    );

    expect(runCanonicalLiveScenarios).not.toHaveBeenCalled();
    expect(runTelegramQaLive).not.toHaveBeenCalled();
  });

  it("rejects unknown mixed Telegram selections before resolving the SUT launcher", async () => {
    vi.stubEnv("OPENCLAW_QA_TELEGRAM_SUT_OPENCLAW_COMMAND", "relative-launcher");
    await expect(
      runQaTelegramCommand({
        repoRoot: "/tmp/openclaw-repo",
        scenarioIds: ["telegram-help-command", "missing-telegram-scenario"],
      }),
    ).rejects.toThrow("unknown Telegram QA scenario id(s): missing-telegram-scenario");

    expect(runCanonicalLiveScenarios).not.toHaveBeenCalled();
    expect(runTelegramQaLive).not.toHaveBeenCalled();
  });

  it("prints telegram scenario catalog without resolving the SUT launcher", async () => {
    vi.stubEnv("OPENCLAW_QA_TELEGRAM_SUT_OPENCLAW_COMMAND", "relative-launcher");
    await runQaTelegramCommand({
      repoRoot: "/tmp/openclaw-repo",
      providerMode: "mock-openai",
      listScenarios: true,
    });

    expect(listTelegramQaScenarioCatalog).toHaveBeenCalledWith("mock-openai");
    expect(runCanonicalLiveScenarios).not.toHaveBeenCalled();
    expect(runTelegramQaLive).not.toHaveBeenCalled();
    expectWriteContains(
      stdoutWrite,
      "telegram-status-command\tdefault\tTelegram status command reply\tVerify Telegram status returns model, session, and activation details. refs=openclaw/openclaw#74698",
    );
  });

  it("sets a failing exit code when the telegram summary reports failures", async () => {
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    await fs.writeFile(
      telegramSummaryPath,
      JSON.stringify({
        counts: { total: 1, passed: 1, failed: 0 },
        scenarios: [{ status: "fail" }],
      }),
      "utf8",
    );
    runTelegramQaLive.mockResolvedValueOnce({
      outputDir: telegramArtifactsDir,
      reportPath: path.join(telegramArtifactsDir, "report.md"),
      summaryPath: telegramSummaryPath,
      observedMessagesPath: path.join(telegramArtifactsDir, "observed.json"),
      scenarios: [],
    });

    try {
      await runQaTelegramCommand({
        repoRoot: "/tmp/openclaw-repo",
      });
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = priorExitCode;
    }
  });

  it("keeps telegram exit code clear when --allow-failures is set", async () => {
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    await fs.writeFile(
      telegramSummaryPath,
      JSON.stringify({
        counts: { total: 1, passed: 0, failed: 1 },
        scenarios: [{ status: "fail" }],
      }),
      "utf8",
    );
    runTelegramQaLive.mockResolvedValueOnce({
      outputDir: telegramArtifactsDir,
      reportPath: path.join(telegramArtifactsDir, "report.md"),
      summaryPath: telegramSummaryPath,
      observedMessagesPath: path.join(telegramArtifactsDir, "observed.json"),
      scenarios: [
        {
          id: "telegram-help-command",
          title: "Telegram help command reply",
          status: "fail",
          details: "missing expected text",
        },
      ],
    });

    try {
      await runQaTelegramCommand({
        repoRoot: "/tmp/openclaw-repo",
        allowFailures: true,
      });
      expect(process.exitCode).toBeUndefined();
    } finally {
      process.exitCode = priorExitCode;
    }
  });

  it("passes host suite concurrency through", async () => {
    await runQaSuiteCommand({
      repoRoot: "/tmp/openclaw-repo",
      scenarioIds: ["channel-chat-baseline", "thread-follow-up"],
      concurrency: 3,
    });

    expectFields(mockFirstObjectArg(runQaSuite), {
      repoRoot: path.resolve("/tmp/openclaw-repo"),
      transportId: "qa-channel",
      scenarioIds: ["channel-chat-baseline", "thread-follow-up"],
      concurrency: 3,
    });
    expectWriteContains(stdoutWrite, `QA suite evidence: ${suiteEvidencePath}`);
  });

  it("rejects fractional suite concurrency from programmatic callers", async () => {
    await expect(
      runQaSuiteCommand({
        repoRoot: "/tmp/openclaw-repo",
        scenarioIds: ["channel-chat-baseline"],
        concurrency: 1.5,
      }),
    ).rejects.toThrow("--concurrency must be a positive integer");
    expect(runQaSuite).not.toHaveBeenCalled();
  });

  it("sets a failing exit code when host suite scenarios fail", async () => {
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    await fs.writeFile(
      suiteSummaryPath,
      JSON.stringify({
        counts: {
          total: 1,
          passed: 0,
          failed: 1,
        },
        scenarios: [{ name: "channel chat baseline", status: "fail" }],
      }),
      "utf8",
    );
    runQaSuite.mockResolvedValueOnce(
      flowSuiteRuntimeResult({
        reportPath: suiteReportPath,
        summaryPath: suiteSummaryPath,
      }),
    );

    try {
      await runQaSuiteCommand({
        repoRoot: "/tmp/openclaw-repo",
      });
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = priorExitCode;
    }
  });

  it("sets a failing exit code when host suite scenarios are skipped", async () => {
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    await fs.writeFile(
      suiteSummaryPath,
      JSON.stringify({
        counts: {
          total: 1,
          passed: 0,
          failed: 0,
          skipped: 1,
        },
        scenarios: [{ name: "channel chat baseline", status: "skip" }],
      }),
      "utf8",
    );
    runQaSuite.mockResolvedValueOnce(
      flowSuiteRuntimeResult({
        reportPath: suiteReportPath,
        summaryPath: suiteSummaryPath,
      }),
    );

    try {
      await runQaSuiteCommand({
        repoRoot: "/tmp/openclaw-repo",
      });
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = priorExitCode;
    }
  });

  it("keeps host suite exit code clear when --allow-failures is set", async () => {
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    await fs.writeFile(
      suiteSummaryPath,
      JSON.stringify({
        counts: {
          total: 1,
          passed: 0,
          failed: 1,
        },
        scenarios: [{ name: "channel chat baseline", status: "fail" }],
      }),
      "utf8",
    );
    runQaSuite.mockResolvedValueOnce(
      flowSuiteRuntimeResult({
        reportPath: suiteReportPath,
        summaryPath: suiteSummaryPath,
        scenarios: [
          {
            name: "channel chat baseline",
            status: "fail",
            steps: [],
          },
        ],
      }),
    );

    try {
      await runQaSuiteCommand({
        repoRoot: "/tmp/openclaw-repo",
        allowFailures: true,
      });
      expect(process.exitCode).toBeUndefined();
    } finally {
      process.exitCode = priorExitCode;
    }
  });

  it("retries host suite runs once for retryable infra failures", async () => {
    runQaSuite
      .mockRejectedValueOnce(
        new QaSuiteInfraError("agent_wait_failed", "agent.wait failed: gateway call timed out"),
      )
      .mockResolvedValueOnce(
        flowSuiteRuntimeResult({
          reportPath: suiteReportPath,
          summaryPath: suiteSummaryPath,
        }),
      );

    await runQaSuiteCommand({
      repoRoot: "/tmp/openclaw-repo",
    });

    expect(runQaSuite).toHaveBeenCalledTimes(2);
    expectWriteContains(stderrWrite, "[qa-suite] infra retry 1/1: agent.wait failed");
  });

  it("retries host suite runs once for qa-channel readiness timeouts", async () => {
    runQaSuite
      .mockRejectedValueOnce(
        new QaSuiteInfraError(
          "transport_ready_timeout",
          "timed out after 180000ms waiting for qa-channel ready; last status: no qa-channel accounts reported",
        ),
      )
      .mockResolvedValueOnce(
        flowSuiteRuntimeResult({
          reportPath: suiteReportPath,
          summaryPath: suiteSummaryPath,
        }),
      );

    await runQaSuiteCommand({
      repoRoot: "/tmp/openclaw-repo",
    });

    expect(runQaSuite).toHaveBeenCalledTimes(2);
    expectWriteContains(
      stderrWrite,
      "[qa-suite] infra retry 1/1: timed out after 180000ms waiting for qa-channel ready",
    );
  });

  it("does not retry host suite runs for generic timeout wording", async () => {
    runQaSuite.mockRejectedValueOnce(
      new Error("approval-turn timed out waiting for post-approval read"),
    );

    await expect(
      runQaSuiteCommand({
        repoRoot: "/tmp/openclaw-repo",
      }),
    ).rejects.toThrow("approval-turn timed out waiting for post-approval read");

    expect(runQaSuite).toHaveBeenCalledTimes(1);
  });

  it("does not retry host suite runs for semantic failures", async () => {
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    await fs.writeFile(
      suiteSummaryPath,
      JSON.stringify({
        counts: {
          total: 1,
          passed: 0,
          failed: 1,
        },
        scenarios: [{ name: "channel chat baseline", status: "fail" }],
      }),
      "utf8",
    );
    runQaSuite.mockResolvedValueOnce(
      flowSuiteRuntimeResult({
        reportPath: suiteReportPath,
        summaryPath: suiteSummaryPath,
        scenarios: [
          {
            name: "channel chat baseline",
            status: "fail",
            steps: [],
          },
        ],
      }),
    );

    try {
      await runQaSuiteCommand({
        repoRoot: "/tmp/openclaw-repo",
      });
      expect(runQaSuite).toHaveBeenCalledTimes(1);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = priorExitCode;
    }
  });

  it("runs a host-only parity preflight against the sentinel scenario", async () => {
    const repoRoot = path.resolve("/tmp/openclaw-repo");
    await runQaSuiteCommand({
      repoRoot: "/tmp/openclaw-repo",
      providerMode: "mock-openai",
      primaryModel: "openai/gpt-5.6-luna",
      alternateModel: "anthropic/claude-opus-4-8",
      preflight: true,
    });

    const preflightArgs = mockFirstObjectArg(runQaFlowSuiteFromRuntime);
    expectFields(preflightArgs, {
      repoRoot,
      transportId: "qa-channel",
      providerMode: "mock-openai",
      primaryModel: "openai/gpt-5.6-luna",
      alternateModel: "anthropic/claude-opus-4-8",
      scenarioIds: ["approval-turn-tool-followthrough"],
      concurrency: 1,
    });
    expect(String(preflightArgs.outputDir)).toContain(
      path.join(repoRoot, ".artifacts", "qa-e2e", "preflight", "suite-"),
    );
    expectWriteContains(stdoutWrite, "QA parity preflight summary:");
  });

  it("throws when parity preflight finds a failing sentinel scenario", async () => {
    await fs.writeFile(
      suiteSummaryPath,
      JSON.stringify({
        counts: {
          total: 1,
          passed: 0,
          failed: 1,
        },
        scenarios: [{ name: "approval turn tool followthrough", status: "fail" }],
      }),
      "utf8",
    );
    runQaFlowSuiteFromRuntime.mockResolvedValueOnce({
      outputDir: suiteArtifactsDir,
      evidencePath: suiteEvidencePath,
      watchUrl: "http://127.0.0.1:43124",
      reportPath: suiteReportPath,
      summaryPath: suiteSummaryPath,
      scenarios: [{ name: "approval turn tool followthrough", status: "fail", steps: [] }],
    });

    await expect(
      runQaSuiteCommand({
        repoRoot: "/tmp/openclaw-repo",
        preflight: true,
      }),
    ).rejects.toThrow("QA parity preflight failed with 1 failing or skipped scenario.");
  });

  it("keeps parity preflight exit code clear when --allow-failures is set", async () => {
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    await fs.writeFile(
      suiteSummaryPath,
      JSON.stringify({
        counts: {
          total: 1,
          passed: 0,
          failed: 1,
        },
        scenarios: [{ name: "approval turn tool followthrough", status: "fail" }],
      }),
      "utf8",
    );
    runQaFlowSuiteFromRuntime.mockResolvedValueOnce({
      outputDir: suiteArtifactsDir,
      evidencePath: suiteEvidencePath,
      watchUrl: "http://127.0.0.1:43124",
      reportPath: suiteReportPath,
      summaryPath: suiteSummaryPath,
      scenarios: [{ name: "approval turn tool followthrough", status: "fail", steps: [] }],
    });

    try {
      await runQaSuiteCommand({
        repoRoot: "/tmp/openclaw-repo",
        preflight: true,
        allowFailures: true,
      });
      expect(process.exitCode).toBeUndefined();
    } finally {
      process.exitCode = priorExitCode;
    }
  });

  it("rejects preflight on the multipass runner", async () => {
    await expect(
      runQaSuiteCommand({
        repoRoot: "/tmp/openclaw-repo",
        runner: "multipass",
        preflight: true,
      }),
    ).rejects.toThrow("--preflight requires --runner host.");
  });

  it("passes host suite CLI auth mode through", async () => {
    await runQaSuiteCommand({
      repoRoot: "/tmp/openclaw-repo",
      providerMode: "live-frontier",
      primaryModel: "claude-cli/claude-sonnet-4-6",
      alternateModel: "claude-cli/claude-sonnet-4-6",
      cliAuthMode: "subscription",
      scenarioIds: ["claude-cli-provider-capabilities-subscription"],
    });

    expectFields(mockFirstObjectArg(runQaSuite), {
      repoRoot: path.resolve("/tmp/openclaw-repo"),
      providerMode: "live-frontier",
      primaryModel: "claude-cli/claude-sonnet-4-6",
      alternateModel: "claude-cli/claude-sonnet-4-6",
      claudeCliAuthMode: "subscription",
      scenarioIds: ["claude-cli-provider-capabilities-subscription"],
    });
  });

  it("expands the agentic parity pack onto the suite scenario list", async () => {
    await runQaSuiteCommand({
      repoRoot: "/tmp/openclaw-repo",
      parityPack: "agentic",
      scenarioIds: ["channel-chat-baseline"],
    });

    expectFields(mockFirstObjectArg(runQaSuite), {
      repoRoot: path.resolve("/tmp/openclaw-repo"),
      scenarioIds: [
        "channel-chat-baseline",
        "approval-turn-tool-followthrough",
        "model-switch-tool-continuity",
        "source-docs-discovery-report",
        "image-understanding-attachment",
        "compaction-retry-mutating-tool",
        "subagent-handoff",
        "subagent-fanout-synthesis",
        "subagent-stale-child-links",
        "memory-recall",
        "thread-memory-isolation",
        "config-restart-capability-flip",
        "instruction-followthrough-repo-contract",
      ],
    });
  });

  it("expands the personal-agent pack onto the suite scenario list", async () => {
    await runQaSuiteCommand({
      repoRoot: "/tmp/openclaw-repo",
      pack: "personal-agent",
      scenarioIds: ["channel-chat-baseline"],
    });

    expectFields(mockFirstObjectArg(runQaSuite), {
      repoRoot: path.resolve("/tmp/openclaw-repo"),
      scenarioIds: [
        "channel-chat-baseline",
        "personal-reminder-roundtrip",
        "personal-channel-thread-reply",
        "personal-memory-preference-recall",
        "personal-redaction-no-secret-leak",
        "personal-tool-safety-followthrough",
        "personal-approval-denial-stop",
        "personal-task-followthrough-status",
        "personal-share-safe-diagnostics-artifact",
        "personal-no-fake-progress",
        "personal-failure-recovery",
      ],
    });
  });

  it("expands runtime parity tier selections onto the suite scenario list", async () => {
    await runQaSuiteCommand({
      repoRoot: "/tmp/openclaw-repo",
      runtimeParityTier: ["standard"],
      scenarioIds: ["channel-chat-baseline", "runtime-tool-bash"],
    });

    expectFields(mockFirstObjectArg(runQaSuite), {
      repoRoot: path.resolve("/tmp/openclaw-repo"),
      scenarioIds: [
        "channel-chat-baseline",
        "runtime-tool-bash",
        "auth-profile-codex-mixed-profiles",
        "auth-profile-doctor-migration-safety",
        "codex-plugin-cold-install",
        "codex-plugin-install-race",
        "codex-plugin-pinned-new",
        "codex-plugin-pinned-old",
        "runtime-first-hour-20-turn",
        "runtime-tool-apply-patch",
        "runtime-tool-edit",
        "runtime-tool-exec",
        "runtime-tool-fs-list",
        "runtime-tool-fs-read",
        "runtime-tool-fs-write",
        "runtime-tool-grep",
        "runtime-tool-session-status",
        "runtime-tool-sessions-spawn",
        "runtime-tool-web-fetch",
        "runtime-tool-web-search",
      ],
    });
  });

  it("accepts comma-separated runtime parity tier filters", async () => {
    await runQaSuiteCommand({
      repoRoot: "/tmp/openclaw-repo",
      runtimeParityTier: ["optional,soak"],
    });

    expectFields(mockFirstObjectArg(runQaSuite), {
      scenarioIds: [
        "runtime-long-context-cache-stability",
        "runtime-soak-100-turn",
        "runtime-tool-memory-add",
        "runtime-tool-memory-recall",
        "runtime-tool-message-tool",
        "runtime-tool-skill-invocation",
        "runtime-tool-tavily-extract",
        "runtime-tool-tavily-search",
        "runtime-tool-tts",
      ],
    });
    expectWriteContains(
      stderrWrite,
      "excluded lane-incompatible scenario(s): runtime-tool-image-generate",
    );
  });

  it("keeps runtime-pair tier selection on flow scenarios and reports exclusions", async () => {
    await runQaSuiteCommand({
      repoRoot: "/tmp/openclaw-repo",
      runtimePair: "openclaw,codex",
      runtimeParityTier: ["standard", "live-only"],
    });

    const scenarioIds = mockFirstObjectArg(runQaSuite).scenarioIds as string[];
    expect(scenarioIds).toContain("runtime-first-hour-20-turn");
    expect(scenarioIds).toContain("streaming-final-integrity");
    expect(scenarioIds).not.toContain("gateway-restart-inflight-run");
    expect(scenarioIds).not.toContain("hosted-image-generation-providers-live");
    expect(scenarioIds).not.toContain("hosted-video-generation-providers-live");
    expectFields(mockFirstObjectArg(runQaSuite), {
      runtimePair: ["openclaw", "codex"],
    });
    expectWriteContains(
      stderrWrite,
      "excluded incompatible non-flow scenario(s): hosted-image-generation-providers-live (script), hosted-video-generation-providers-live (script)",
    );
    expectWriteContains(
      stderrWrite,
      "excluded lane-incompatible scenario(s): gateway-restart-inflight-run",
    );
  });

  it("rejects explicit runtime-pair scenarios with no compatible flow execution", async () => {
    await expect(
      runQaSuiteCommand({
        repoRoot: "/tmp/openclaw-repo",
        runtimePair: "openclaw,codex",
        scenarioIds: ["hosted-image-generation-providers-live"],
      }),
    ).rejects.toThrow(
      "--runtime-pair requires execution.kind: flow scenarios; unsupported scenario(s): hosted-image-generation-providers-live (script)",
    );

    expect(runQaSuite).not.toHaveBeenCalled();
  });

  it("rejects runtime-pair tiers with no compatible flow scenarios", async () => {
    const catalog = readQaScenarioPack();
    const hostedImageScenario = catalog.scenarios.find(
      (scenario) => scenario.id === "hosted-image-generation-providers-live",
    );
    if (!hostedImageScenario) {
      throw new Error("missing hosted image scenario fixture");
    }
    readQaScenarioPack.mockReturnValueOnce({
      ...catalog,
      scenarios: [hostedImageScenario],
    });

    await expect(
      runQaSuiteCommand({
        repoRoot: "/tmp/openclaw-repo",
        runtimePair: "openclaw,codex",
        runtimeParityTier: ["live-only"],
      }),
    ).rejects.toThrow(
      "--runtime-parity-tier matched no execution.kind: flow scenarios for live-only; incompatible scenario(s): hosted-image-generation-providers-live (script).",
    );

    expect(runQaSuite).not.toHaveBeenCalled();
  });

  it("rejects unknown runtime parity tier filters", async () => {
    await expect(
      runQaSuiteCommand({
        repoRoot: "/tmp/openclaw-repo",
        runtimeParityTier: ["standardish"],
      }),
    ).rejects.toThrow(
      '--runtime-parity-tier must be one of standard, optional, live-only, soak, got "standardish".',
    );
  });

  it("rejects unknown suite packs", async () => {
    await expect(
      runQaSuiteCommand({
        repoRoot: "/tmp/openclaw-repo",
        pack: "personal-admin",
      }),
    ).rejects.toThrow('--pack must be one of personal-agent, observability, got "personal-admin"');
  });

  it("rejects unknown suite CLI auth modes", async () => {
    await expect(
      runQaSuiteCommand({
        repoRoot: "/tmp/openclaw-repo",
        cliAuthMode: "magic",
      }),
    ).rejects.toThrow("--cli-auth-mode must be one of auto, api-key, subscription");
  });

  it("sets a failing exit code when the parity gate fails", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "qa-parity-"));
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      await fs.writeFile(
        path.join(repoRoot, "candidate.json"),
        JSON.stringify({
          scenarios: [{ name: "Approval turn tool followthrough", status: "pass" }],
        }),
        "utf8",
      );
      await fs.writeFile(
        path.join(repoRoot, "baseline.json"),
        JSON.stringify({
          scenarios: [{ name: "Approval turn tool followthrough", status: "pass" }],
        }),
        "utf8",
      );

      await runQaParityReportCommand({
        repoRoot,
        candidateSummary: "candidate.json",
        baselineSummary: "baseline.json",
      });

      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = priorExitCode;
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("writes a runtime-axis parity report from one summary", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "qa-runtime-parity-"));
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      await fs.writeFile(
        path.join(repoRoot, "runtime-summary.json"),
        JSON.stringify({
          scenarios: [
            {
              name: "Approval turn tool followthrough",
              status: "fail",
              steps: [],
              runtimeParity: {
                scenarioId: "approval-turn-tool-followthrough",
                drift: "tool-call-shape",
                driftDetails: "tool call 1 differs",
                cells: {
                  openclaw: {
                    runtime: "openclaw",
                    transcriptBytes: '{"role":"assistant"}\n',
                    toolCalls: [{ tool: "read_file", argsHash: "a", resultHash: "r" }],
                    finalText: "done",
                    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                    wallClockMs: 10,
                    bootStateLines: [],
                  },
                  codex: {
                    runtime: "codex",
                    transcriptBytes: '{"role":"assistant"}\n',
                    toolCalls: [{ tool: "read_file", argsHash: "b", resultHash: "r" }],
                    finalText: "done",
                    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                    wallClockMs: 10,
                    runtimeErrorClass: "tool-error",
                    bootStateLines: [],
                  },
                },
              },
            },
          ],
          counts: { total: 1, passed: 1, failed: 0 },
          run: {
            providerMode: "mock-openai",
            primaryModel: "openai/gpt-5.6-luna",
            runtimePair: ["openclaw", "codex"],
          },
        }),
        "utf8",
      );

      await runQaParityReportCommand({
        repoRoot,
        runtimeAxis: true,
        summary: "runtime-summary.json",
      });

      expect(process.exitCode).toBeUndefined();
      expect(stdoutWrite).toHaveBeenCalledWith(
        expect.stringContaining("QA runtime parity report:"),
      );
      expect(stdoutWrite).toHaveBeenCalledWith(
        expect.stringContaining("QA runtime parity verdict: pass"),
      );
    } finally {
      process.exitCode = priorExitCode;
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("writes a runtime-axis token-efficiency report when requested", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "qa-runtime-token-efficiency-"));
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      await fs.writeFile(
        path.join(repoRoot, "runtime-summary.json"),
        JSON.stringify({
          scenarios: [
            {
              name: "runtime-tool-fs-read",
              status: "pass",
              steps: [],
              runtimeParity: {
                scenarioId: "runtime-tool-fs-read",
                drift: "none",
                cells: {
                  openclaw: {
                    runtime: "openclaw",
                    transcriptBytes: '{"role":"assistant"}\n',
                    toolCalls: [{ tool: "fs.read", argsHash: "a", resultHash: "r" }],
                    finalText: "done",
                    usage: { inputTokens: 72_000, outputTokens: 381, totalTokens: 72_381 },
                    wallClockMs: 10,
                    bootStateLines: [],
                  },
                  codex: {
                    runtime: "codex",
                    transcriptBytes: '{"role":"assistant"}\n',
                    toolCalls: Array.from({ length: 40 }, (_, index) => ({
                      tool: "fs.read",
                      argsHash: `a-${index}`,
                      resultHash: `r-${index}`,
                    })),
                    finalText: "done",
                    usage: { inputTokens: 118_000, outputTokens: 1_489, totalTokens: 119_489 },
                    wallClockMs: 10,
                    bootStateLines: [],
                  },
                },
              },
            },
          ],
          counts: { total: 1, passed: 1, failed: 0 },
          run: {
            providerMode: "live-frontier",
            primaryModel: "openai/gpt-5.6-luna",
            runtimePair: ["openclaw", "codex"],
          },
        }),
        "utf8",
      );

      await runQaParityReportCommand({
        repoRoot,
        runtimeAxis: true,
        summary: "runtime-summary.json",
        tokenEfficiency: true,
      });

      expect(process.exitCode).toBe(1);
      expect(stdoutWrite).toHaveBeenCalledWith(
        expect.stringContaining("QA runtime parity verdict: pass"),
      );
      expect(stdoutWrite).toHaveBeenCalledWith(
        expect.stringContaining("QA runtime token efficiency report:"),
      );
      expect(stdoutWrite).toHaveBeenCalledWith(
        expect.stringContaining("QA runtime token efficiency verdict: fail"),
      );
      const [artifactDir] = await fs.readdir(path.join(repoRoot, ".artifacts", "qa-e2e"));
      const tokenSummary = JSON.parse(
        await fs.readFile(
          path.join(
            repoRoot,
            ".artifacts",
            "qa-e2e",
            artifactDir ?? "",
            "qa-runtime-token-efficiency-summary.json",
          ),
          "utf8",
        ),
      ) as { aggregate?: { flaggedScenarios?: string[] } };
      expect(tokenSummary.aggregate?.flaggedScenarios).toEqual(["runtime-tool-fs-read"]);
    } finally {
      process.exitCode = priorExitCode;
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("rejects token-efficiency without runtime-axis mode", async () => {
    await expect(
      runQaParityReportCommand({
        repoRoot: process.cwd(),
        candidateSummary: "candidate.json",
        baselineSummary: "baseline.json",
        tokenEfficiency: true,
      }),
    ).rejects.toThrow("--token-efficiency requires --runtime-axis.");
  });

  describe("coverage inventory command", () => {
    beforeAll(async () => {
      listTelegramQaScenarioCatalog.mockReturnValue([]);
      await loadNonYamlScenarioRefs();
    });

    it("prints a markdown report from scenario metadata", async () => {
      await runQaCoverageReportCommand({ repoRoot: process.cwd() });

      expectWriteContains(stdoutWrite, "# QA Coverage Inventory");
      expectWriteContains(stdoutWrite, "memory.recall");
    });
  });

  it("prints a focused scenario match report from coverage metadata", async () => {
    await runQaCoverageReportCommand({
      repoRoot: process.cwd(),
      match: ["image roundtrip"],
    });

    expectWriteContains(stdoutWrite, "# QA Scenario Matches");
    expectWriteContains(stdoutWrite, "image-generation-roundtrip");
    expectWriteContains(stdoutWrite, "--scenario image-generation-roundtrip");
    expect(stdoutWrite.mock.calls.flat().join("")).not.toContain("memory-recall");
  });

  it("rejects scenario match queries for tool coverage reports", async () => {
    await expect(
      runQaCoverageReportCommand({
        repoRoot: process.cwd(),
        tools: true,
        match: ["runtime"],
      }),
    ).rejects.toThrow("--match cannot be combined with --tools.");
  });

  it("prints a markdown tool coverage report from runtime tool fixtures", async () => {
    await runQaCoverageReportCommand({ repoRoot: process.cwd(), tools: true });

    expectWriteContains(stdoutWrite, "# OpenClaw Runtime Tool Coverage");
    expectWriteContains(stdoutWrite, "codex-native-workspace");
  });

  it("writes a curated mock JSONL replay report and summary", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "qa-jsonl-replay-cli-"));
    try {
      await runQaJsonlReplayCommand({
        repoRoot,
        transcripts: path.resolve("qa/scenarios/jsonl-replay"),
        outputDir: "jsonl-output",
        runtimePair: "openclaw,codex",
      });

      const report = await fs.readFile(
        path.join(repoRoot, "jsonl-output", "qa-jsonl-replay-report.md"),
        "utf8",
      );
      const summary = JSON.parse(
        await fs.readFile(
          path.join(repoRoot, "jsonl-output", "qa-jsonl-replay-summary.json"),
          "utf8",
        ),
      ) as { transcripts?: Array<{ userTurnCount?: number }> };

      expect(report).toContain("# OpenClaw JSONL Replay Report - openclaw vs codex");
      expect(report).toContain("| plan-mode-boundaries.jsonl | 3 |  | none, none, none |");
      expect(summary.transcripts).toHaveLength(7);
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("keeps JSONL replay mock-only until real runtime cell replay is wired", async () => {
    await expect(
      runQaJsonlReplayCommand({
        repoRoot: process.cwd(),
        providerMode: "live-frontier",
      }),
    ).rejects.toThrow("qa jsonl-replay currently supports mock-openai curated fixtures only.");
  });

  it("exits nonzero when tool coverage summary is missing a required runtime tool call", async () => {
    const priorExitCode = process.exitCode;
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "qa-tool-coverage-"));
    try {
      await fs.writeFile(
        path.join(repoRoot, "runtime-summary.json"),
        JSON.stringify({
          scenarios: [
            {
              name: "runtime-tool-web-search",
              status: "fail",
              runtimeParity: {
                scenarioId: "runtime-tool-web-search",
                drift: "tool-call-shape",
                driftDetails: "Codex emitted no web_search call",
                cells: {
                  openclaw: {
                    runtime: "openclaw",
                    transcriptBytes: "",
                    toolCalls: [{ tool: "web_search", argsHash: "a", resultHash: "r" }],
                    finalText: "",
                    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
                    wallClockMs: 1,
                    bootStateLines: [],
                  },
                  codex: {
                    runtime: "codex",
                    transcriptBytes: "",
                    toolCalls: [],
                    finalText: "",
                    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
                    wallClockMs: 1,
                    bootStateLines: [],
                  },
                },
              },
            },
          ],
          run: { runtimePair: ["openclaw", "codex"] },
        }),
        "utf8",
      );

      await runQaCoverageReportCommand({
        repoRoot,
        tools: true,
        summary: "runtime-summary.json",
      });

      expect(process.exitCode).toBe(1);
      expectWriteContains(stdoutWrite, "- Verdict: fail");
      expectWriteContains(stdoutWrite, "web_search missing codex tool call web_search");
    } finally {
      process.exitCode = priorExitCode;
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("resolves character eval paths and passes model refs through", async () => {
    await runQaCharacterEvalCommand({
      repoRoot: "/tmp/openclaw-repo",
      outputDir: ".artifacts/qa/character",
      model: [
        "openai/gpt-5.6-luna,thinking=xhigh,fast=false",
        "codex-cli/test-model,thinking=high,fast",
      ],
      scenario: "character-vibes-gollum",
      fast: true,
      thinking: "medium",
      modelThinking: ["codex-cli/test-model=medium"],
      judgeModel: [
        "openai/gpt-5.6-luna,thinking=xhigh,fast",
        "anthropic/claude-opus-4-8,thinking=high",
      ],
      judgeTimeoutMs: 180_000,
      blindJudgeModels: true,
      concurrency: 4,
      judgeConcurrency: 3,
    });

    const characterEvalArgs = mockFirstObjectArg(runQaCharacterEval);
    expect(typeof characterEvalArgs.progress).toBe("function");
    expectFields(characterEvalArgs, {
      repoRoot: path.resolve("/tmp/openclaw-repo"),
      outputDir: path.resolve("/tmp/openclaw-repo", ".artifacts/qa/character"),
      models: ["openai/gpt-5.6-luna", "codex-cli/test-model"],
      scenarioId: "character-vibes-gollum",
      candidateFastMode: true,
      candidateThinkingDefault: "medium",
      candidateThinkingByModel: { "codex-cli/test-model": "medium" },
      candidateModelOptions: {
        "openai/gpt-5.6-luna": { thinkingDefault: "xhigh", fastMode: false },
        "codex-cli/test-model": { thinkingDefault: "high", fastMode: true },
      },
      judgeModels: ["openai/gpt-5.6-luna", "anthropic/claude-opus-4-8"],
      judgeModelOptions: {
        "openai/gpt-5.6-luna": { thinkingDefault: "xhigh", fastMode: true },
        "anthropic/claude-opus-4-8": { thinkingDefault: "high" },
      },
      judgeTimeoutMs: 180_000,
      judgeBlindModels: true,
      candidateConcurrency: 4,
      judgeConcurrency: 3,
    });
  });

  it("lets character eval auto-select candidate fast mode when --fast is omitted", async () => {
    await runQaCharacterEvalCommand({
      repoRoot: "/tmp/openclaw-repo",
      model: ["openai/gpt-5.6-luna"],
    });

    const characterEvalArgs = mockFirstObjectArg(runQaCharacterEval);
    expect(typeof characterEvalArgs.progress).toBe("function");
    expectFields(characterEvalArgs, {
      repoRoot: path.resolve("/tmp/openclaw-repo"),
      outputDir: undefined,
      models: ["openai/gpt-5.6-luna"],
      scenarioId: undefined,
      candidateFastMode: undefined,
      candidateThinkingDefault: undefined,
      candidateThinkingByModel: undefined,
      candidateModelOptions: undefined,
      judgeModels: undefined,
      judgeModelOptions: undefined,
      judgeTimeoutMs: undefined,
      judgeBlindModels: undefined,
      candidateConcurrency: undefined,
      judgeConcurrency: undefined,
    });
  });

  it("rejects invalid character eval thinking levels", async () => {
    await expect(
      runQaCharacterEvalCommand({
        repoRoot: "/tmp/openclaw-repo",
        model: ["openai/gpt-5.6-luna"],
        thinking: "enormous",
      }),
    ).rejects.toThrow("--thinking must be one of");

    await expect(
      runQaCharacterEvalCommand({
        repoRoot: "/tmp/openclaw-repo",
        model: ["openai/gpt-5.6-luna,thinking=galaxy"],
      }),
    ).rejects.toThrow("--model thinking must be one of");

    await expect(
      runQaCharacterEvalCommand({
        repoRoot: "/tmp/openclaw-repo",
        model: ["openai/gpt-5.6-luna,warp"],
      }),
    ).rejects.toThrow("--model options must be thinking=<level>");

    await expect(
      runQaCharacterEvalCommand({
        repoRoot: "/tmp/openclaw-repo",
        model: ["openai/gpt-5.6-luna"],
        modelThinking: ["openai/gpt-5.6-luna"],
      }),
    ).rejects.toThrow("--model-thinking must use provider/model=level");
  });

  it("passes the explicit repo root into manual runs", async () => {
    await runQaManualLaneCommand({
      repoRoot: "/tmp/openclaw-repo",
      providerMode: "live-frontier",
      primaryModel: "openai/gpt-5.6-luna",
      alternateModel: "openai/gpt-5.6-luna",
      fastMode: true,
      message: "read qa kickoff and reply short",
      timeoutMs: 45_000,
    });

    expect(runQaManualLane).toHaveBeenCalledWith({
      repoRoot: path.resolve("/tmp/openclaw-repo"),
      transportId: "qa-channel",
      providerMode: "live-frontier",
      primaryModel: "openai/gpt-5.6-luna",
      alternateModel: "openai/gpt-5.6-luna",
      fastMode: true,
      message: "read qa kickoff and reply short",
      timeoutMs: 45_000,
    });
  });

  it("routes suite runs through multipass when the runner is selected", async () => {
    await runQaSuiteCommand({
      repoRoot: "/tmp/openclaw-repo",
      outputDir: ".artifacts/qa-multipass",
      runner: "multipass",
      providerMode: "mock-openai",
      scenarioIds: ["channel-chat-baseline"],
      allowFailures: true,
      concurrency: 3,
      image: "lts",
      cpus: 2,
      memory: "4G",
      disk: "24G",
    });

    expect(runQaMultipass).toHaveBeenCalledWith({
      repoRoot: path.resolve("/tmp/openclaw-repo"),
      outputDir: path.resolve("/tmp/openclaw-repo", ".artifacts/qa-multipass"),
      transportId: "qa-channel",
      providerMode: "mock-openai",
      primaryModel: undefined,
      alternateModel: undefined,
      fastMode: undefined,
      allowFailures: true,
      scenarioIds: ["channel-chat-baseline"],
      concurrency: 3,
      image: "lts",
      cpus: 2,
      memory: "4G",
      disk: "24G",
    });
    expect(runQaSuite).not.toHaveBeenCalled();
  });

  it("rejects Vitest and Playwright scenarios on the multipass runner", async () => {
    await expect(
      runQaSuiteCommand({
        repoRoot: "/tmp/openclaw-repo",
        runner: "multipass",
        scenarioIds: ["control-ui-chat-flow-playwright"],
      }),
    ).rejects.toThrow(
      "--runner multipass requires execution.kind: flow scenarios; unsupported scenario(s): control-ui-chat-flow-playwright (playwright)",
    );

    expect(runQaMultipass).not.toHaveBeenCalled();
  });

  it("passes runtime-pair suite selection through to the multipass runner", async () => {
    await runQaSuiteCommand({
      repoRoot: "/tmp/openclaw-repo",
      runner: "multipass",
      providerMode: "mock-openai",
      scenarioIds: ["approval-turn-tool-followthrough"],
      runtimePair: "codex,openclaw",
      allowFailures: true,
    });

    expect(runQaMultipass).toHaveBeenCalledWith(
      expect.objectContaining({
        repoRoot: path.resolve("/tmp/openclaw-repo"),
        runtimePair: ["openclaw", "codex"],
      }),
    );
  });

  it("passes live suite selection through to the multipass runner", async () => {
    await runQaSuiteCommand({
      repoRoot: "/tmp/openclaw-repo",
      runner: "multipass",
      providerMode: "live-frontier",
      primaryModel: "openai/gpt-5.6-luna",
      alternateModel: "openai/gpt-5.6-luna",
      fastMode: true,
      allowFailures: true,
      scenarioIds: ["channel-chat-baseline"],
    });

    expectFields(mockFirstObjectArg(runQaMultipass), {
      repoRoot: path.resolve("/tmp/openclaw-repo"),
      transportId: "qa-channel",
      providerMode: "live-frontier",
      primaryModel: "openai/gpt-5.6-luna",
      alternateModel: "openai/gpt-5.6-luna",
      fastMode: true,
      allowFailures: true,
      scenarioIds: ["channel-chat-baseline"],
    });
  });

  it("sets a failing exit code when multipass summary reports failed scenarios", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "qa-multipass-summary-"));
    const summaryPath = path.join(repoRoot, "qa-suite-summary.json");
    await fs.writeFile(
      summaryPath,
      JSON.stringify({
        counts: {
          total: 2,
          passed: 1,
          failed: 1,
        },
      }),
      "utf8",
    );
    runQaMultipass.mockResolvedValueOnce({
      outputDir: repoRoot,
      reportPath: path.join(repoRoot, "qa-suite-report.md"),
      summaryPath,
      hostLogPath: path.join(repoRoot, "multipass-host.log"),
      bootstrapLogPath: path.join(repoRoot, "multipass-guest-bootstrap.log"),
      guestScriptPath: path.join(repoRoot, "multipass-guest-run.sh"),
      vmName: "openclaw-qa-test",
      scenarioIds: ["channel-chat-baseline"],
    });
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      await runQaSuiteCommand({
        repoRoot: "/tmp/openclaw-repo",
        runner: "multipass",
      });
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = priorExitCode;
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("sets a failing exit code when multipass summary reports skipped scenarios", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "qa-multipass-summary-"));
    const summaryPath = path.join(repoRoot, "qa-suite-summary.json");
    await fs.writeFile(
      summaryPath,
      JSON.stringify({
        counts: {
          total: 2,
          passed: 1,
          failed: 0,
          skipped: 1,
        },
      }),
      "utf8",
    );
    runQaMultipass.mockResolvedValueOnce({
      outputDir: repoRoot,
      reportPath: path.join(repoRoot, "qa-suite-report.md"),
      summaryPath,
      hostLogPath: path.join(repoRoot, "multipass-host.log"),
      bootstrapLogPath: path.join(repoRoot, "multipass-guest-bootstrap.log"),
      guestScriptPath: path.join(repoRoot, "multipass-guest-run.sh"),
      vmName: "openclaw-qa-test",
      scenarioIds: ["channel-chat-baseline"],
    });
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      await runQaSuiteCommand({
        repoRoot: "/tmp/openclaw-repo",
        runner: "multipass",
      });
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = priorExitCode;
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("rejects malformed multipass summary JSON", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "qa-multipass-summary-"));
    const summaryPath = path.join(repoRoot, "qa-suite-summary.json");
    await fs.writeFile(summaryPath, "{not-json", "utf8");
    runQaMultipass.mockResolvedValueOnce({
      outputDir: repoRoot,
      reportPath: path.join(repoRoot, "qa-suite-report.md"),
      summaryPath,
      hostLogPath: path.join(repoRoot, "multipass-host.log"),
      bootstrapLogPath: path.join(repoRoot, "multipass-guest-bootstrap.log"),
      guestScriptPath: path.join(repoRoot, "multipass-guest-run.sh"),
      vmName: "openclaw-qa-test",
      scenarioIds: ["channel-chat-baseline"],
    });

    try {
      await expect(
        runQaSuiteCommand({
          repoRoot: "/tmp/openclaw-repo",
          runner: "multipass",
        }),
      ).rejects.toThrow("Could not parse QA summary JSON");
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("rejects unreadable multipass summary JSON with read/parse wording", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "qa-multipass-summary-"));
    const summaryPath = path.join(repoRoot, "qa-suite-summary.json");
    runQaMultipass.mockResolvedValueOnce({
      outputDir: repoRoot,
      reportPath: path.join(repoRoot, "qa-suite-report.md"),
      summaryPath,
      hostLogPath: path.join(repoRoot, "multipass-host.log"),
      bootstrapLogPath: path.join(repoRoot, "multipass-guest-bootstrap.log"),
      guestScriptPath: path.join(repoRoot, "multipass-guest-run.sh"),
      vmName: "openclaw-qa-test",
      scenarioIds: ["channel-chat-baseline"],
    });

    try {
      await expect(
        runQaSuiteCommand({
          repoRoot: "/tmp/openclaw-repo",
          runner: "multipass",
        }),
      ).rejects.toThrow("Could not read QA summary JSON");
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("rejects partial multipass summary JSON without failure fields", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "qa-multipass-summary-"));
    const summaryPath = path.join(repoRoot, "qa-suite-summary.json");
    await fs.writeFile(summaryPath, JSON.stringify({ counts: { total: 2, passed: 2 } }), "utf8");
    runQaMultipass.mockResolvedValueOnce({
      outputDir: repoRoot,
      reportPath: path.join(repoRoot, "qa-suite-report.md"),
      summaryPath,
      hostLogPath: path.join(repoRoot, "multipass-host.log"),
      bootstrapLogPath: path.join(repoRoot, "multipass-guest-bootstrap.log"),
      guestScriptPath: path.join(repoRoot, "multipass-guest-run.sh"),
      vmName: "openclaw-qa-test",
      scenarioIds: ["channel-chat-baseline"],
    });

    try {
      await expect(
        runQaSuiteCommand({
          repoRoot: "/tmp/openclaw-repo",
          runner: "multipass",
        }),
      ).rejects.toThrow(
        "did not include counts.failed, counts.skipped, scenarios[].status, or entries[].result.status",
      );
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("keeps multipass exit code clear when --allow-failures is set", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "qa-multipass-summary-"));
    const summaryPath = path.join(repoRoot, "qa-suite-summary.json");
    await fs.writeFile(
      summaryPath,
      JSON.stringify({
        counts: {
          total: 2,
          passed: 1,
          failed: 1,
        },
      }),
      "utf8",
    );
    runQaMultipass.mockResolvedValueOnce({
      outputDir: repoRoot,
      reportPath: path.join(repoRoot, "qa-suite-report.md"),
      summaryPath,
      hostLogPath: path.join(repoRoot, "multipass-host.log"),
      bootstrapLogPath: path.join(repoRoot, "multipass-guest-bootstrap.log"),
      guestScriptPath: path.join(repoRoot, "multipass-guest-run.sh"),
      vmName: "openclaw-qa-test",
      scenarioIds: ["channel-chat-baseline"],
    });
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      await runQaSuiteCommand({
        repoRoot: "/tmp/openclaw-repo",
        runner: "multipass",
        allowFailures: true,
      });
      expect(process.exitCode).toBeUndefined();
    } finally {
      process.exitCode = priorExitCode;
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("passes provider-qualified mock parity suite selection through to the host runner", async () => {
    await runQaSuiteCommand({
      repoRoot: "/tmp/openclaw-repo",
      providerMode: "mock-openai",
      parityPack: "agentic",
      primaryModel: "openai/gpt-5.6-luna",
      alternateModel: "anthropic/claude-opus-4-8",
    });

    expect(runQaSuite).toHaveBeenCalledWith({
      repoRoot: path.resolve("/tmp/openclaw-repo"),
      outputDir: undefined,
      transportId: "qa-channel",
      channelDriver: undefined,
      channelDriverSelection: undefined,
      providerMode: "mock-openai",
      primaryModel: "openai/gpt-5.6-luna",
      alternateModel: "anthropic/claude-opus-4-8",
      fastMode: undefined,
      scenarioIds: [
        "approval-turn-tool-followthrough",
        "model-switch-tool-continuity",
        "source-docs-discovery-report",
        "image-understanding-attachment",
        "compaction-retry-mutating-tool",
        "subagent-handoff",
        "subagent-fanout-synthesis",
        "subagent-stale-child-links",
        "memory-recall",
        "thread-memory-isolation",
        "config-restart-capability-flip",
        "instruction-followthrough-repo-contract",
      ],
    });
  });

  it("rejects multipass-only suite flags on the host runner", async () => {
    await expect(
      runQaSuiteCommand({
        repoRoot: "/tmp/openclaw-repo",
        runner: "host",
        image: "lts",
      }),
    ).rejects.toThrow("--image, --cpus, --memory, and --disk require --runner multipass.");
  });

  it("defaults manual mock runs onto the mock-openai model lane", async () => {
    await runQaManualLaneCommand({
      repoRoot: "/tmp/openclaw-repo",
      providerMode: "mock-openai",
      message: "read qa kickoff and reply short",
    });

    expect(runQaManualLane).toHaveBeenCalledWith({
      repoRoot: path.resolve("/tmp/openclaw-repo"),
      transportId: "qa-channel",
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.6-luna",
      alternateModel: "mock-openai/gpt-5.6-luna-alt",
      fastMode: undefined,
      message: "read qa kickoff and reply short",
      timeoutMs: undefined,
    });
  });

  it("defaults manual aimock runs onto the aimock model lane", async () => {
    await runQaManualLaneCommand({
      repoRoot: "/tmp/openclaw-repo",
      providerMode: "aimock",
      message: "read qa kickoff and reply short",
    });

    expect(runQaManualLane).toHaveBeenCalledWith({
      repoRoot: path.resolve("/tmp/openclaw-repo"),
      transportId: "qa-channel",
      providerMode: "aimock",
      primaryModel: "aimock/gpt-5.6-luna",
      alternateModel: "aimock/gpt-5.6-luna-alt",
      fastMode: undefined,
      message: "read qa kickoff and reply short",
      timeoutMs: undefined,
    });
  });

  it("defaults manual frontier runs onto the frontier model lane", async () => {
    await runQaManualLaneCommand({
      repoRoot: "/tmp/openclaw-repo",
      message: "read qa kickoff and reply short",
    });

    expect(runQaManualLane).toHaveBeenCalledWith({
      repoRoot: path.resolve("/tmp/openclaw-repo"),
      transportId: "qa-channel",
      providerMode: "live-frontier",
      primaryModel: DEFAULT_LIVE_FRONTIER_MODEL,
      alternateModel: DEFAULT_LIVE_FRONTIER_MODEL,
      fastMode: undefined,
      message: "read qa kickoff and reply short",
      timeoutMs: undefined,
    });
  });

  it("keeps an explicit manual primary model as the alternate default", async () => {
    await runQaManualLaneCommand({
      repoRoot: "/tmp/openclaw-repo",
      providerMode: "live-frontier",
      primaryModel: "anthropic/claude-sonnet-4-6",
      message: "read qa kickoff and reply short",
    });

    expect(runQaManualLane).toHaveBeenCalledWith({
      repoRoot: path.resolve("/tmp/openclaw-repo"),
      transportId: "qa-channel",
      providerMode: "live-frontier",
      primaryModel: "anthropic/claude-sonnet-4-6",
      alternateModel: "anthropic/claude-sonnet-4-6",
      fastMode: undefined,
      message: "read qa kickoff and reply short",
      timeoutMs: undefined,
    });
  });

  it("defaults manual frontier runs onto Codex OAuth when the runtime resolver prefers it", async () => {
    defaultQaRuntimeModelForMode.mockImplementation((mode, options) =>
      mode === "live-frontier"
        ? "openai/gpt-5.6-luna"
        : defaultQaProviderModelForMode(mode as QaProviderModeInput, options),
    );

    await runQaManualLaneCommand({
      repoRoot: "/tmp/openclaw-repo",
      message: "read qa kickoff and reply short",
    });

    expect(runQaManualLane).toHaveBeenCalledWith({
      repoRoot: path.resolve("/tmp/openclaw-repo"),
      transportId: "qa-channel",
      providerMode: "live-frontier",
      primaryModel: "openai/gpt-5.6-luna",
      alternateModel: "openai/gpt-5.6-luna",
      fastMode: undefined,
      message: "read qa kickoff and reply short",
      timeoutMs: undefined,
    });
  });

  it("resolves self-check repo-root-relative paths before starting the lab server", async () => {
    await runQaLabSelfCheckCommand({
      repoRoot: "/tmp/openclaw-repo",
      output: ".artifacts/qa/self-check.md",
    });

    expect(startQaLabServer).toHaveBeenCalledWith({
      repoRoot: path.resolve("/tmp/openclaw-repo"),
      outputPath: path.resolve("/tmp/openclaw-repo", ".artifacts/qa/self-check.md"),
    });
  });

  it("fails unsuccessful self-checks after stopping the lab server", async () => {
    const stop = vi.fn();
    startQaLabServer.mockResolvedValueOnce({
      baseUrl: "http://127.0.0.1:58000",
      runSelfCheck: vi.fn().mockResolvedValue({
        outputPath: "/tmp/failed-report.md",
        report: "",
        checks: [{ name: "QA self-check scenario", status: "fail" }],
        scenarioResult: {
          name: "QA self-check scenario",
          status: "fail",
          steps: [],
        },
      }),
      stop,
    });

    await expect(
      runQaLabSelfCheckCommand({
        repoRoot: "/tmp/openclaw-repo",
      }),
    ).rejects.toThrow("QA self-check failed. See /tmp/failed-report.md.");

    expect(stop).toHaveBeenCalledOnce();
    expectWriteContains(stdoutWrite, "QA self-check report: /tmp/failed-report.md");
  });

  it("rejects oversized credential payload files before broker setup", async () => {
    const previousMaxBytes = process.env.OPENCLAW_QA_CREDENTIAL_PAYLOAD_MAX_BYTES;
    const payloadPath = path.join(suiteArtifactsDir, "oversized-credential.json");
    await fs.writeFile(payloadPath, JSON.stringify({ blob: "x".repeat(64) }), "utf8");
    process.env.OPENCLAW_QA_CREDENTIAL_PAYLOAD_MAX_BYTES = "32";

    try {
      await expect(
        runQaCredentialsAddCommand({
          kind: "telegram",
          payloadFile: payloadPath,
        }),
      ).rejects.toThrow(
        "Payload file exceeds OPENCLAW_QA_CREDENTIAL_PAYLOAD_MAX_BYTES (32 bytes).",
      );
    } finally {
      if (previousMaxBytes === undefined) {
        delete process.env.OPENCLAW_QA_CREDENTIAL_PAYLOAD_MAX_BYTES;
      } else {
        process.env.OPENCLAW_QA_CREDENTIAL_PAYLOAD_MAX_BYTES = previousMaxBytes;
      }
    }
  });

  it("resolves docker scaffold paths relative to the explicit repo root", async () => {
    await runQaDockerScaffoldCommand({
      repoRoot: "/tmp/openclaw-repo",
      outputDir: ".artifacts/qa-docker",
      providerBaseUrl: "http://127.0.0.1:44080/v1",
      usePrebuiltImage: true,
    });

    expect(writeQaDockerHarnessFiles).toHaveBeenCalledWith({
      outputDir: path.resolve("/tmp/openclaw-repo", ".artifacts/qa-docker"),
      repoRoot: path.resolve("/tmp/openclaw-repo"),
      gatewayPort: undefined,
      qaLabPort: undefined,
      providerBaseUrl: "http://127.0.0.1:44080/v1",
      imageName: undefined,
      usePrebuiltImage: true,
    });
  });

  it("passes the explicit repo root into docker image builds", async () => {
    await runQaDockerBuildImageCommand({
      repoRoot: "/tmp/openclaw-repo",
      image: "openclaw:qa-local-prebaked",
    });

    expect(buildQaDockerHarnessImage).toHaveBeenCalledWith({
      repoRoot: path.resolve("/tmp/openclaw-repo"),
      imageName: "openclaw:qa-local-prebaked",
    });
  });

  it("resolves docker up paths relative to the explicit repo root", async () => {
    await runQaDockerUpCommand({
      repoRoot: "/tmp/openclaw-repo",
      outputDir: ".artifacts/qa-up",
      usePrebuiltImage: true,
      skipUiBuild: true,
    });

    expect(runQaDockerUp).toHaveBeenCalledWith({
      repoRoot: path.resolve("/tmp/openclaw-repo"),
      outputDir: path.resolve("/tmp/openclaw-repo", ".artifacts/qa-up"),
      gatewayPort: undefined,
      qaLabPort: undefined,
      providerBaseUrl: undefined,
      image: undefined,
      usePrebuiltImage: true,
      skipUiBuild: true,
    });
  });
});

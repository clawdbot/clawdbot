import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  runQaManualLane,
  runQaSuiteFromRuntime,
  runQaCharacterEval,
  runQaMultipass,
  runTelegramQaLive,
  startQaLabServer,
  writeQaDockerHarnessFiles,
  buildQaDockerHarnessImage,
  runQaDockerUp,
  defaultQaRuntimeModelForMode,
} = vi.hoisted(() => ({
  runQaManualLane: vi.fn(),
  runQaSuiteFromRuntime: vi.fn(),
  runQaCharacterEval: vi.fn(),
  runQaMultipass: vi.fn(),
  runTelegramQaLive: vi.fn(),
  startQaLabServer: vi.fn(),
  writeQaDockerHarnessFiles: vi.fn(),
  buildQaDockerHarnessImage: vi.fn(),
  runQaDockerUp: vi.fn(),
  defaultQaRuntimeModelForMode:
    vi.fn<(mode: string, options?: { alternate?: boolean }) => string>(),
}));

vi.mock("./manual-lane.runtime.js", () => ({
  runQaManualLane,
}));

vi.mock("./suite-launch.runtime.js", () => ({
  runQaSuiteFromRuntime,
}));

vi.mock("./character-eval.js", () => ({
  runQaCharacterEval,
}));

vi.mock("./multipass.runtime.js", () => ({
  runQaMultipass,
}));

vi.mock("./live-transports/telegram/telegram-live.runtime.js", () => ({
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

import { resolveRepoRelativeOutputDir } from "./cli-paths.js";
import {
  runQaLabSelfCheckCommand,
  runQaDockerBuildImageCommand,
  runQaDockerScaffoldCommand,
  runQaDockerUpCommand,
  runQaCharacterEvalCommand,
  runQaCoverageReportCommand,
  runQaManualLaneCommand,
  runQaParityReportCommand,
  runQaSuiteCommand,
} from "./cli.runtime.js";
import { runQaTelegramCommand } from "./live-transports/telegram/cli.runtime.js";
import { defaultQaModelForMode as defaultQaProviderModelForMode } from "./model-selection.js";
import type { QaProviderModeInput } from "./run-config.js";

describe("qa cli runtime", () => {
  let stdoutWrite: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutWrite = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    runQaSuiteFromRuntime.mockReset();
    runQaCharacterEval.mockReset();
    runQaManualLane.mockReset();
    runQaMultipass.mockReset();
    runTelegramQaLive.mockReset();
    startQaLabServer.mockReset();
    writeQaDockerHarnessFiles.mockReset();
    buildQaDockerHarnessImage.mockReset();
    runQaDockerUp.mockReset();
    defaultQaRuntimeModelForMode.mockImplementation(
      (mode: string, options?: { alternate?: boolean }) =>
        defaultQaProviderModelForMode(mode as QaProviderModeInput, options),
    );
    runQaSuiteFromRuntime.mockResolvedValue({
      watchUrl: "http://127.0.0.1:43124",
      reportPath: "/tmp/report.md",
      summaryPath: "/tmp/summary.json",
    });
    runQaCharacterEval.mockResolvedValue({
      reportPath: "/tmp/character-report.md",
      summaryPath: "/tmp/character-summary.json",
    });
    runQaManualLane.mockResolvedValue({
      model: "openai/gpt-5.4",
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
      outputDir: "/tmp/telegram",
      reportPath: "/tmp/telegram/report.md",
      summaryPath: "/tmp/telegram/summary.json",
      observedMessagesPath: "/tmp/telegram/observed.json",
      scenarios: [],
    });
    startQaLabServer.mockResolvedValue({
      baseUrl: "http://127.0.0.1:58000",
      runSelfCheck: vi.fn().mockResolvedValue({
        outputPath: "/tmp/report.md",
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

  afterEach(() => {
    stdoutWrite.mockRestore();
    vi.clearAllMocks();
  });

  it("resolves suite repo-root-relative paths before dispatching", async () => {
    await runQaSuiteCommand({
      repoRoot: "/tmp/openclaw-repo",
      outputDir: ".artifacts/qa/frontier",
      providerMode: "live-frontier",
      primaryModel: "openai/gpt-5.4",
      alternateModel: "anthropic/claude-sonnet-4-6",
      fastMode: true,
      scenarioIds: ["approval-turn-tool-followthrough"],
    });

    expect(runQaSuiteFromRuntime).toHaveBeenCalledWith({
      repoRoot: path.resolve("/tmp/openclaw-repo"),
      outputDir: path.resolve("/tmp/openclaw-repo", ".artifacts/qa/frontier"),
      transportId: "qa-channel",
      providerMode: "live-frontier",
      primaryModel: "openai/gpt-5.4",
      alternateModel: "anthropic/claude-sonnet-4-6",
      fastMode: true,
      scenarioIds: ["approval-turn-tool-followthrough"],
    });
  });

  it("resolves telegram qa repo-root-relative paths before dispatching", async () => {
    await runQaTelegramCommand({
      repoRoot: "/tmp/openclaw-repo",
      outputDir: ".artifacts/qa/telegram",
      providerMode: "live-frontier",
      primaryModel: "openai/gpt-5.4",
      alternateModel: "openai/gpt-5.4",
      fastMode: true,
      scenarioIds: ["telegram-help-command"],
      sutAccountId: "sut-live",
    });

    expect(runTelegramQaLive).toHaveBeenCalledWith({
      repoRoot: path.resolve("/tmp/openclaw-repo"),
      outputDir: path.resolve("/tmp/openclaw-repo", ".artifacts/qa/telegram"),
      providerMode: "live-frontier",
      primaryModel: "openai/gpt-5.4",
      alternateModel: "openai/gpt-5.4",
      fastMode: true,
      scenarioIds: ["telegram-help-command"],
      sutAccountId: "sut-live",
    });
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

    expect(runTelegramQaLive).toHaveBeenCalledWith(
      expect.objectContaining({
        repoRoot: path.resolve("/tmp/openclaw-repo"),
        providerMode: "live-frontier",
      }),
    );
  });

  it("passes host suite concurrency through", async () => {
    await runQaSuiteCommand({
      repoRoot: "/tmp/openclaw-repo",
      scenarioIds: ["channel-chat-baseline", "thread-follow-up"],
      concurrency: 3,
    });

    expect(runQaSuiteFromRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        repoRoot: path.resolve("/tmp/openclaw-repo"),
        transportId: "qa-channel",
        scenarioIds: ["channel-chat-baseline", "thread-follow-up"],
        concurrency: 3,
      }),
    );
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

    expect(runQaSuiteFromRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        repoRoot: path.resolve("/tmp/openclaw-repo"),
        providerMode: "live-frontier",
        primaryModel: "claude-cli/claude-sonnet-4-6",
        alternateModel: "claude-cli/claude-sonnet-4-6",
        claudeCliAuthMode: "subscription",
        scenarioIds: ["claude-cli-provider-capabilities-subscription"],
      }),
    );
  });

  it("expands the agentic parity pack onto the suite scenario list", async () => {
    await runQaSuiteCommand({
      repoRoot: "/tmp/openclaw-repo",
      parityPack: "agentic",
      scenarioIds: ["channel-chat-baseline"],
    });

    expect(runQaSuiteFromRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
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
          "memory-recall",
          "thread-memory-isolation",
          "config-restart-capability-flip",
          "instruction-followthrough-repo-contract",
        ],
      }),
    );
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

  it("prints a markdown coverage report from scenario metadata", async () => {
    await runQaCoverageReportCommand({ repoRoot: process.cwd() });

    expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining("# QA Coverage Inventory"));
    expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining("memory.recall"));
  });

  it("resolves character eval paths and passes model refs through", async () => {
    await runQaCharacterEvalCommand({
      repoRoot: "/tmp/openclaw-repo",
      outputDir: ".artifacts/qa/character",
      model: [
        "openai/gpt-5.4,thinking=xhigh,fast=false",
        "codex-cli/test-model,thinking=high,fast",
      ],
      scenario: "character-vibes-gollum",
      fast: true,
      thinking: "medium",
      modelThinking: ["codex-cli/test-model=medium"],
      judgeModel: ["openai/gpt-5.4,thinking=xhigh,fast", "anthropic/claude-opus-4-6,thinking=high"],
      judgeTimeoutMs: 180_000,
      blindJudgeModels: true,
      concurrency: 4,
      judgeConcurrency: 3,
    });

    expect(runQaCharacterEval).toHaveBeenCalledWith({
      repoRoot: path.resolve("/tmp/openclaw-repo"),
      outputDir: path.resolve("/tmp/openclaw-repo", ".artifacts/qa/character"),
      models: ["openai/gpt-5.4", "codex-cli/test-model"],
      scenarioId: "character-vibes-gollum",
      candidateFastMode: true,
      candidateThinkingDefault: "medium",
      candidateThinkingByModel: { "codex-cli/test-model": "medium" },
      candidateModelOptions: {
        "openai/gpt-5.4": { thinkingDefault: "xhigh", fastMode: false },
        "codex-cli/test-model": { thinkingDefault: "high", fastMode: true },
      },
      judgeModels: ["openai/gpt-5.4", "anthropic/claude-opus-4-6"],
      judgeModelOptions: {
        "openai/gpt-5.4": { thinkingDefault: "xhigh", fastMode: true },
        "anthropic/claude-opus-4-6": { thinkingDefault: "high" },
      },
      judgeTimeoutMs: 180_000,
      judgeBlindModels: true,
      candidateConcurrency: 4,
      judgeConcurrency: 3,
      progress: expect.any(Function),
    });
  });

  it("lets character eval auto-select candidate fast mode when --fast is omitted", async () => {
    await runQaCharacterEvalCommand({
      repoRoot: "/tmp/openclaw-repo",
      model: ["openai/gpt-5.4"],
    });

    expect(runQaCharacterEval).toHaveBeenCalledWith({
      repoRoot: path.resolve("/tmp/openclaw-repo"),
      outputDir: undefined,
      models: ["openai/gpt-5.4"],
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
      progress: expect.any(Function),
    });
  });

  it("rejects invalid character eval thinking levels", async () => {
    await expect(
      runQaCharacterEvalCommand({
        repoRoot: "/tmp/openclaw-repo",
        model: ["openai/gpt-5.4"],
        thinking: "enormous",
      }),
    ).rejects.toThrow("--thinking must be one of");

    await expect(
      runQaCharacterEvalCommand({
        repoRoot: "/tmp/openclaw-repo",
        model: ["openai/gpt-5.4,thinking=galaxy"],
      }),
    ).rejects.toThrow("--model thinking must be one of");

    await expect(
      runQaCharacterEvalCommand({
        repoRoot: "/tmp/openclaw-repo",
        model: ["openai/gpt-5.4,warp"],
      }),
    ).rejects.toThrow("--model options must be thinking=<level>");

    await expect(
      runQaCharacterEvalCommand({
        repoRoot: "/tmp/openclaw-repo",
        model: ["openai/gpt-5.4"],
        modelThinking: ["openai/gpt-5.4"],
      }),
    ).rejects.toThrow("--model-thinking must use provider/model=level");
  });

  it("passes the explicit repo root into manual runs", async () => {
    await runQaManualLaneCommand({
      repoRoot: "/tmp/openclaw-repo",
      providerMode: "live-frontier",
      primaryModel: "openai/gpt-5.4",
      alternateModel: "openai/gpt-5.4",
      fastMode: true,
      message: "read qa kickoff and reply short",
      timeoutMs: 45_000,
    });

    expect(runQaManualLane).toHaveBeenCalledWith({
      repoRoot: path.resolve("/tmp/openclaw-repo"),
      transportId: "qa-channel",
      providerMode: "live-frontier",
      primaryModel: "openai/gpt-5.4",
      alternateModel: "openai/gpt-5.4",
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
      scenarioIds: ["channel-chat-baseline"],
      concurrency: 3,
      image: "lts",
      cpus: 2,
      memory: "4G",
      disk: "24G",
    });
    expect(runQaSuiteFromRuntime).not.toHaveBeenCalled();
  });

  it("passes live suite selection through to the multipass runner", async () => {
    await runQaSuiteCommand({
      repoRoot: "/tmp/openclaw-repo",
      runner: "multipass",
      providerMode: "live-frontier",
      primaryModel: "openai/gpt-5.4",
      alternateModel: "openai/gpt-5.4",
      fastMode: true,
      scenarioIds: ["channel-chat-baseline"],
    });

    expect(runQaMultipass).toHaveBeenCalledWith(
      expect.objectContaining({
        repoRoot: path.resolve("/tmp/openclaw-repo"),
        transportId: "qa-channel",
        providerMode: "live-frontier",
        primaryModel: "openai/gpt-5.4",
        alternateModel: "openai/gpt-5.4",
        fastMode: true,
        scenarioIds: ["channel-chat-baseline"],
      }),
    );
  });

  it("passes provider-qualified mock parity suite selection through to the host runner", async () => {
    await runQaSuiteCommand({
      repoRoot: "/tmp/openclaw-repo",
      providerMode: "mock-openai",
      parityPack: "agentic",
      primaryModel: "openai/gpt-5.4",
      alternateModel: "anthropic/claude-opus-4-6",
    });

    expect(runQaSuiteFromRuntime).toHaveBeenCalledWith({
      repoRoot: path.resolve("/tmp/openclaw-repo"),
      outputDir: undefined,
      transportId: "qa-channel",
      providerMode: "mock-openai",
      primaryModel: "openai/gpt-5.4",
      alternateModel: "anthropic/claude-opus-4-6",
      fastMode: undefined,
      scenarioIds: [
        "approval-turn-tool-followthrough",
        "model-switch-tool-continuity",
        "source-docs-discovery-report",
        "image-understanding-attachment",
        "compaction-retry-mutating-tool",
        "subagent-handoff",
        "subagent-fanout-synthesis",
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
      primaryModel: "mock-openai/gpt-5.4",
      alternateModel: "mock-openai/gpt-5.4-alt",
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
      primaryModel: "aimock/gpt-5.4",
      alternateModel: "aimock/gpt-5.4-alt",
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
      primaryModel: "openai/gpt-5.4",
      alternateModel: "openai/gpt-5.4",
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
        ? "openai-codex/gpt-5.4"
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
      primaryModel: "openai-codex/gpt-5.4",
      alternateModel: "openai-codex/gpt-5.4",
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

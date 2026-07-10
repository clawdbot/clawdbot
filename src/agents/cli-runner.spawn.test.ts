/** Tests CLI runner process spawning, logging, diagnostics, and live-session paths. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  testing as replyRunTesting,
  createReplyOperation,
  replyRunRegistry,
} from "../auto-reply/reply/reply-run-registry.js";
import {
  markMcpLoopbackToolCallFinished,
  markMcpLoopbackToolCallStarted,
  recordMcpLoopbackToolCallResult,
} from "../gateway/mcp-http.loopback-runtime.js";
import { onAgentEvent, resetAgentEventsForTest } from "../infra/agent-events.js";
import {
  onInternalDiagnosticEvent,
  onTrustedToolExecutionEvent,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import {
  getDiagnosticSessionActivitySnapshot,
  resetDiagnosticRunActivityForTest,
} from "../logging/diagnostic-run-activity.js";
import type { getProcessSupervisor } from "../process/supervisor/index.js";
import type { RunExit } from "../process/supervisor/types.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  makeBootstrapWarn as realMakeBootstrapWarn,
  resolveBootstrapContextForRun as realResolveBootstrapContextForRun,
} from "./bootstrap-files.js";
import {
  createManagedRun,
  mockSuccessfulCliRun,
  restoreCliRunnerPrepareTestDeps,
  supervisorSpawnMock,
} from "./cli-runner.test-support.js";
import {
  buildClaudeLiveArgs,
  getClaudeLiveSessionGenerationForOwner,
  resetClaudeLiveSessionsForTest,
  runClaudeLiveSessionTurn,
} from "./cli-runner/claude-live-session.js";
import {
  attachCliMessagingDeliveryEvidence,
  getCliMessagingDeliveryEvidence,
} from "./cli-runner/delivery-evidence.js";
import {
  buildCliEnvAuthLog,
  buildCliExecLogLine,
  executePreparedCliRun,
  setCliRunnerExecuteTestDeps,
} from "./cli-runner/execute.js";
import { buildCliAgentSystemPrompt, writeCliSystemPromptFile } from "./cli-runner/helpers.js";
import { cliBackendLog, formatCliBackendOutputDigest } from "./cli-runner/log.js";
import { setCliRunnerPrepareTestDeps } from "./cli-runner/prepare.js";
import type { PreparedCliRunContext } from "./cli-runner/types.js";
import { createClaudeApiErrorFixture } from "./test-helpers/claude-api-error-fixture.js";

vi.mock("../plugin-sdk/anthropic-cli.js", () => ({
  CLAUDE_CLI_BACKEND_ID: "claude-cli",
  isClaudeCliProvider: (providerId: string) => providerId === "claude-cli",
}));

type ProcessSupervisor = ReturnType<typeof getProcessSupervisor>;
type SupervisorSpawnFn = ProcessSupervisor["spawn"];

beforeEach(() => {
  setDiagnosticsEnabledForProcess(true);
  resetAgentEventsForTest();
  resetDiagnosticRunActivityForTest();
  resetClaudeLiveSessionsForTest();
  replyRunTesting.resetReplyRunRegistry();
  restoreCliRunnerPrepareTestDeps();
  setCliRunnerExecuteTestDeps({ writeCliSystemPromptFile });
  supervisorSpawnMock.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  resetDiagnosticRunActivityForTest();
  resetClaudeLiveSessionsForTest();
  replyRunTesting.resetReplyRunRegistry();
});

const CLAUDE_OK_JSONL = `${JSON.stringify({ type: "result", result: "ok" })}\n`;

function mockSuccessfulClaudeJsonlRun() {
  supervisorSpawnMock.mockResolvedValueOnce(
    createManagedRun({
      reason: "exit",
      exitCode: 0,
      exitSignal: null,
      durationMs: 50,
      stdout: CLAUDE_OK_JSONL,
      stderr: "",
      timedOut: false,
      noOutputTimedOut: false,
    }),
  );
}

function buildPreparedCliRunContext(params: {
  provider: "claude-cli" | "codex-cli" | "google-gemini-cli";
  model: string;
  runId: string;
  prompt?: string;
  sessionId?: string;
  sessionKey?: string;
  sessionEntry?: PreparedCliRunContext["params"]["sessionEntry"];
  agentId?: string;
  backend?: Partial<PreparedCliRunContext["preparedBackend"]["backend"]>;
  preparedEnv?: PreparedCliRunContext["preparedBackend"]["env"];
  resolveExecutionArgs?: PreparedCliRunContext["backendResolved"]["resolveExecutionArgs"];
  config?: PreparedCliRunContext["params"]["config"];
  mcpConfigHash?: string;
  mcpDeliveryCapture?: boolean;
  skillsSnapshot?: PreparedCliRunContext["params"]["skillsSnapshot"];
  thinkLevel?: PreparedCliRunContext["params"]["thinkLevel"];
  executionMode?: PreparedCliRunContext["params"]["executionMode"];
  emitCommentaryText?: boolean;
  workspaceDir?: string;
  timeoutMs?: number;
}): PreparedCliRunContext {
  // Produces a prepared context without invoking prepare.runtime, keeping spawn
  // assertions focused on execute/runtime behavior.
  const workspaceDir = params.workspaceDir ?? "/tmp";
  const baseBackend = (() => {
    if (params.provider === "claude-cli") {
      return {
        command: "claude",
        args: ["-p", "--output-format", "stream-json"],
        output: "jsonl" as const,
        input: "stdin" as const,
        modelArg: "--model",
        sessionArg: "--session-id",
        sessionMode: "always" as const,
        systemPromptFileArg: "--append-system-prompt-file",
        systemPromptWhen: "first" as const,
        serialize: true,
      };
    }
    if (params.provider === "google-gemini-cli") {
      return {
        command: "gemini",
        args: [
          "--skip-trust",
          "--approval-mode",
          "auto_edit",
          "--output-format",
          "stream-json",
          "--prompt",
          "{prompt}",
        ],
        output: "jsonl" as const,
        jsonlDialect: "gemini-stream-json" as const,
        input: "arg" as const,
        modelArg: "--model",
        sessionMode: "existing" as const,
        serialize: true,
      };
    }
    return {
      command: "codex",
      args: ["exec", "--json"],
      resumeArgs: ["exec", "resume", "{sessionId}", "--skip-git-repo-check"],
      output: "text" as const,
      input: "arg" as const,
      modelArg: "--model",
      sessionMode: "existing" as const,
      systemPromptFileConfigArg: "-c",
      systemPromptFileConfigKey: "model_instructions_file",
      systemPromptWhen: "first" as const,
      serialize: true,
    };
  })();
  const backend = { ...baseBackend, ...params.backend };
  return {
    params: {
      sessionId: params.sessionId ?? "s1",
      sessionKey: params.sessionKey,
      sessionEntry: params.sessionEntry,
      agentId: params.agentId,
      sessionFile: "/tmp/session.jsonl",
      workspaceDir,
      config: params.config,
      prompt: params.prompt ?? "hi",
      provider: params.provider,
      model: params.model,
      thinkLevel: params.thinkLevel,
      executionMode: params.executionMode,
      emitCommentaryText: params.emitCommentaryText,
      timeoutMs: params.timeoutMs ?? 1_000,
      runId: params.runId,
      skillsSnapshot: params.skillsSnapshot,
    },
    started: Date.now(),
    workspaceDir,
    backendResolved: {
      id: params.provider,
      config: backend,
      bundleMcp: params.provider === "claude-cli",
      pluginId:
        params.provider === "claude-cli"
          ? "anthropic"
          : params.provider === "google-gemini-cli"
            ? "google"
            : "openai",
      resolveExecutionArgs: params.resolveExecutionArgs,
    },
    preparedBackend: {
      backend,
      env: params.preparedEnv ?? {},
      ...(params.mcpConfigHash ? { mcpConfigHash: params.mcpConfigHash } : {}),
    },
    reusableCliSession: { mode: "none" },
    hadSessionFile: false,
    contextEngineConfig: {},
    modelId: params.model,
    normalizedModel: params.model,
    systemPrompt: "You are a helpful assistant.",
    systemPromptReport: {} as PreparedCliRunContext["systemPromptReport"],
    bootstrapPromptWarningLines: [],
    authEpochVersion: 2,
    ...(params.mcpDeliveryCapture ? { mcpDeliveryCapture: true } : {}),
  };
}

function requireArgAfter(argv: string[] | undefined, flag: string): string {
  const index = argv?.indexOf(flag) ?? -1;
  if (index < 0) {
    throw new Error(`expected CLI arg ${flag}`);
  }
  const value = argv?.[index + 1]?.trim();
  if (!value) {
    throw new Error(`expected value after CLI arg ${flag}`);
  }
  return value;
}

function requireRegexMatch(value: string, pattern: RegExp): RegExpExecArray {
  const match = pattern.exec(value);
  if (!match) {
    throw new Error(`expected ${value} to match ${pattern}`);
  }
  return match;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label} to be an object`);
  }
  return value as Record<string, unknown>;
}

function mockCallArg(mock: ReturnType<typeof vi.fn>, callIndex = 0, argIndex = 0): unknown {
  const call = mock.mock.calls[callIndex] as unknown[] | undefined;
  if (!call) {
    throw new Error(`expected mock call ${callIndex}`);
  }
  return call[argIndex];
}

async function expectRejectsWithFields(
  promise: Promise<unknown>,
  expected: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // Failover errors carry structured fields; this helper verifies them while
  // preserving the original object for deeper assertions.
  try {
    await promise;
  } catch (error) {
    const actual = requireRecord(error, "rejection");
    for (const [key, value] of Object.entries(expected)) {
      expect(actual[key]).toBe(value);
    }
    return actual;
  }
  throw new Error("expected promise to reject");
}

async function expectPathMissing(targetPath: string): Promise<void> {
  try {
    await fs.access(targetPath);
  } catch (error) {
    expect(requireRecord(error, "filesystem error").code).toBe("ENOENT");
    return;
  }
  throw new Error(`expected ${targetPath} to be missing`);
}

async function withTempExecApprovalsFile(
  file: Record<string, unknown>,
  run: () => Promise<void>,
): Promise<void> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-exec-approvals-"));
  await fs.mkdir(path.join(home, ".openclaw"), { recursive: true });
  await fs.writeFile(
    path.join(home, ".openclaw", "exec-approvals.json"),
    `${JSON.stringify(file)}\n`,
    "utf-8",
  );
  try {
    await withEnvAsync({ HOME: home }, run);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

async function withTempOpenClawHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-home-"));
  try {
    await withEnvAsync({ OPENCLAW_HOME: home }, async () => run(home));
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

describe("runCliAgent spawn path", () => {
  it("formats output digests without logging response content", () => {
    expect(formatCliBackendOutputDigest("one")).toBe("outBytes=3 outHash=7692c3ad3540");
    expect(formatCliBackendOutputDigest("∑")).toBe("outBytes=3 outHash=be27c7179a61");
  });

  it("formats redacted CLI resume diagnostics without exposing raw session ids", () => {
    const logLine = buildCliExecLogLine({
      provider: "claude-cli",
      model: "claude-opus-4-7",
      promptChars: 42,
      trigger: "heartbeat",
      useResume: true,
      cliSessionId: "claude-session-secret",
      resolvedSessionId: "claude-session-secret",
      reusableSession: { mode: "reuse", sessionId: "claude-session-secret" },
      hasHistoryPrompt: false,
    });

    expect(logLine).toContain("trigger=heartbeat");
    expect(logLine).toContain("useResume=true");
    expect(logLine).toContain("session=present");
    expect(logLine).toContain("reuse=reusable");
    expect(logLine).toContain("historyPrompt=none");
    expect(logLine).not.toContain("claude-session-secret");
  });

  it("formats soft-resume drift in CLI resume diagnostics", () => {
    const logLine = buildCliExecLogLine({
      provider: "claude-cli",
      model: "claude-opus-4-7",
      promptChars: 42,
      trigger: "user",
      useResume: true,
      cliSessionId: "claude-session-secret",
      resolvedSessionId: "claude-session-secret",
      reusableSession: {
        mode: "reuse-with-drift",
        sessionId: "claude-session-secret",
        drift: { reasons: ["system-prompt"] },
      },
      hasHistoryPrompt: false,
    });

    expect(logLine).toContain("reuse=reusable-drift:system-prompt");
    expect(logLine).not.toContain("claude-session-secret");
  });

  it("does not inject hardcoded 'Tools are disabled' text into CLI arguments", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: CLAUDE_OK_JSONL,
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    const backendConfig = {
      command: "claude",
      args: ["-p", "--output-format", "stream-json"],
      output: "jsonl" as const,
      input: "stdin" as const,
      modelArg: "--model",
      sessionArg: "--session-id",
      systemPromptArg: "--append-system-prompt",
      systemPromptWhen: "first" as const,
      serialize: true,
    };
    const context: PreparedCliRunContext = {
      params: {
        sessionId: "s1",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        prompt: "Run: node script.mjs",
        provider: "claude-cli",
        model: "sonnet",
        timeoutMs: 1_000,
        runId: "run-no-tools-disabled",
        extraSystemPrompt: "You are a helpful assistant.",
      },
      started: Date.now(),
      workspaceDir: "/tmp",
      backendResolved: {
        id: "claude-cli",
        config: backendConfig,
        bundleMcp: true,
        pluginId: "anthropic",
      },
      preparedBackend: {
        backend: backendConfig,
        env: {},
      },
      reusableCliSession: { mode: "none" },
      hadSessionFile: false,
      contextEngineConfig: {},
      modelId: "sonnet",
      normalizedModel: "sonnet",
      systemPrompt: "You are a helpful assistant.",
      systemPromptReport: {} as PreparedCliRunContext["systemPromptReport"],
      bootstrapPromptWarningLines: [],
      authEpochVersion: 2,
    };
    await executePreparedCliRun(context);

    const input = mockCallArg(supervisorSpawnMock) as { argv?: string[] };
    const allArgs = (input.argv ?? []).join("\n");
    expect(allArgs).not.toContain("Tools are disabled in this session");
    expect(allArgs).toContain("You are a helpful assistant.");
  });

  it("includes the OpenClaw skills prompt in CLI system prompts", () => {
    const systemPrompt = buildCliAgentSystemPrompt({
      workspaceDir: "/tmp",
      modelDisplay: "claude-cli/sonnet",
      tools: [],
      skillsPrompt: [
        "<available_skills>",
        "  <skill>",
        "    <name>weather</name>",
        "    <description>Use weather tools.</description>",
        "    <location>/tmp/skills/weather/SKILL.md</location>",
        "  </skill>",
        "</available_skills>",
      ].join("\n"),
    });

    expect(systemPrompt).toContain("## Skills");
    expect(systemPrompt).toContain("<name>weather</name>");
    expect(systemPrompt).toContain("/tmp/skills/weather/SKILL.md");
  });

  it("pipes Claude prompts over stdin instead of argv", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: CLAUDE_OK_JSONL,
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    await executePreparedCliRun(
      buildPreparedCliRunContext({
        provider: "claude-cli",
        model: "sonnet",
        runId: "run-stdin-claude",
        prompt: "Explain this diff",
      }),
    );

    const input = mockCallArg(supervisorSpawnMock) as {
      argv?: string[];
      input?: string;
    };
    expect(input.input).toContain("Explain this diff");
    expect(input.argv).not.toContain("Explain this diff");
  });

  it("passes Claude system prompts through a file instead of argv", async () => {
    let systemPromptPath = "";
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = (args[0] ?? {}) as { argv?: string[] };
      systemPromptPath = requireArgAfter(input.argv, "--append-system-prompt-file");
      expect(systemPromptPath).toContain("openclaw-cli-system-prompt-");
      await expect(fs.readFile(systemPromptPath, "utf-8")).resolves.toBe(
        "You are a helpful assistant.",
      );
      expect(input.argv).not.toContain("You are a helpful assistant.");
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: CLAUDE_OK_JSONL,
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    await executePreparedCliRun(
      buildPreparedCliRunContext({
        provider: "claude-cli",
        model: "sonnet",
        runId: "run-claude-system-prompt-file",
      }),
    );

    await expectPathMissing(systemPromptPath);
  });

  it("resends system prompts through a file for soft-resumed prompt-tool drift", async () => {
    const writeSoftResumeSystemPromptFile = vi.fn(async () => ({
      filePath: "/tmp/openclaw-soft-resume-system-prompt.md",
      cleanup: async () => {},
    }));
    setCliRunnerExecuteTestDeps({
      writeCliSystemPromptFile: writeSoftResumeSystemPromptFile,
    });
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = (args[0] ?? {}) as { argv?: string[] };
      expect(input.argv).toContain("resume");
      expect(input.argv).toContain("soft-cli-session");
      expect(input.argv?.join(" ")).toContain("/tmp/openclaw-soft-resume-system-prompt.md");
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "ok",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });
    const context = buildPreparedCliRunContext({
      provider: "codex-cli",
      model: "gpt-5.4",
      runId: "run-soft-resume-system-prompt-file",
    });
    context.reusableCliSession = {
      mode: "reuse-with-drift",
      sessionId: "soft-cli-session",
      drift: { reasons: ["prompt-tools"] },
    };

    await executePreparedCliRun(context, "soft-cli-session");

    expect(writeSoftResumeSystemPromptFile).toHaveBeenCalledWith({
      backend: context.preparedBackend.backend,
      systemPrompt: "You are a helpful assistant.",
    });
  });

  it("passes --session-id for new Claude sessions", async () => {
    mockSuccessfulClaudeJsonlRun();

    await executePreparedCliRun(
      buildPreparedCliRunContext({
        provider: "claude-cli",
        model: "sonnet",
        runId: "run-claude-session-id",
      }),
    );

    const input = mockCallArg(supervisorSpawnMock) as {
      argv?: string[];
      input?: string;
      mode?: string;
    };
    expect(input.mode).toBe("child");
    expect(input.argv).toContain("claude");
    expect(requireArgAfter(input.argv, "--session-id")).not.toBe("");
    expect(input.input).toContain("hi");
    expect(input.argv).not.toContain("hi");
  });

  it("does not pass a Claude session id for side-question runs", async () => {
    mockSuccessfulClaudeJsonlRun();
    const resolveExecutionArgs = vi.fn(({ baseArgs }) => [...baseArgs, "--max-turns", "1"]);

    await executePreparedCliRun(
      buildPreparedCliRunContext({
        provider: "claude-cli",
        model: "sonnet",
        runId: "run-claude-side-question",
        executionMode: "side-question",
        backend: { sessionMode: "none" },
        resolveExecutionArgs,
      }),
    );

    const resolveArgsInput = requireRecord(mockCallArg(resolveExecutionArgs), "resolved args");
    expect(resolveArgsInput.executionMode).toBe("side-question");
    expect(resolveArgsInput.useResume).toBe(false);
    const input = mockCallArg(supervisorSpawnMock) as { argv?: string[]; input?: string };
    expect(input.argv).not.toContain("--session-id");
    expect(input.argv).toContain("--max-turns");
    expect(input.input).toContain("hi");
  });

  it("applies backend-owned per-run args before spawning", async () => {
    mockSuccessfulClaudeJsonlRun();
    const resolveExecutionArgs = vi.fn(({ baseArgs }) => [...baseArgs, "--effort", "high"]);

    await executePreparedCliRun(
      buildPreparedCliRunContext({
        provider: "claude-cli",
        model: "sonnet",
        runId: "run-claude-thinking-args",
        thinkLevel: "high",
        resolveExecutionArgs,
      }),
    );

    const resolveArgsInput = requireRecord(mockCallArg(resolveExecutionArgs), "resolved args");
    expect(resolveArgsInput.provider).toBe("claude-cli");
    expect(resolveArgsInput.modelId).toBe("sonnet");
    expect(resolveArgsInput.thinkingLevel).toBe("high");
    expect(resolveArgsInput.useResume).toBe(false);
    expect(resolveArgsInput.baseArgs).toEqual(["-p", "--output-format", "stream-json"]);
    const input = mockCallArg(supervisorSpawnMock) as { argv?: string[] };
    expect(requireArgAfter(input.argv, "--effort")).toBe("high");
  });

  it("passes prepared backend env to the spawned CLI process", async () => {
    mockSuccessfulCliRun();

    await executePreparedCliRun(
      buildPreparedCliRunContext({
        provider: "codex-cli",
        model: "gpt-5.5",
        runId: "run-prepared-env",
        backend: {
          env: {
            GEMINI_CLI_HOME: "/ignored/static-home",
            STATIC_BACKEND_FLAG: "set",
          },
        },
        preparedEnv: {
          GEMINI_CLI_HOME: "/tmp/openclaw-gemini-profile-home",
          GEMINI_CLI_SYSTEM_SETTINGS_PATH: "/tmp/openclaw-gemini-system-settings.json",
        },
      }),
    );

    const input = mockCallArg(supervisorSpawnMock) as { env?: Record<string, string> };
    expect(input.env?.STATIC_BACKEND_FLAG).toBe("set");
    expect(input.env?.GEMINI_CLI_HOME).toBe("/tmp/openclaw-gemini-profile-home");
    expect(input.env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH).toBe(
      "/tmp/openclaw-gemini-system-settings.json",
    );
  });

  it("passes OpenClaw skills to Claude as a session plugin", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-skills-"));
    const skillDir = path.join(workspaceDir, "skills", "weather");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      [
        "---",
        "name: weather",
        "description: Use weather tools for forecasts.",
        "---",
        "",
        "Read forecast data before replying.",
      ].join("\n"),
      "utf-8",
    );

    let pluginDir = "";
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = (args[0] ?? {}) as { argv?: string[] };
      pluginDir = requireArgAfter(input.argv, "--plugin-dir");
      const manifest = JSON.parse(
        await fs.readFile(path.join(pluginDir, ".claude-plugin", "plugin.json"), "utf-8"),
      ) as { name?: string; skills?: string };
      expect(manifest.name).toBe("openclaw-skills");
      expect(manifest.skills).toBe("./skills");
      await expect(
        fs.readFile(path.join(pluginDir, "skills", "weather", "SKILL.md"), "utf-8"),
      ).resolves.toContain("Read forecast data before replying.");
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: CLAUDE_OK_JSONL,
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    try {
      await executePreparedCliRun(
        buildPreparedCliRunContext({
          provider: "claude-cli",
          model: "sonnet",
          runId: "run-claude-skills-plugin",
          workspaceDir,
          skillsSnapshot: {
            prompt: "",
            skills: [{ name: "weather" }],
            resolvedSkills: [
              {
                name: "weather",
                description: "Use weather tools for forecasts.",
                filePath: path.join(skillDir, "SKILL.md"),
                baseDir: skillDir,
                source: "test",
                sourceInfo: {
                  path: skillDir,
                  source: "test",
                  scope: "project",
                  origin: "top-level",
                  baseDir: skillDir,
                },
                disableModelInvocation: false,
              },
            ],
          },
        }),
      );
      let accessError: unknown;
      try {
        await fs.access(pluginDir);
      } catch (error) {
        accessError = error;
      }
      expect((accessError as NodeJS.ErrnoException | undefined)?.code).toBe("ENOENT");
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("injects skill env overrides into CLI child env and restores host env", async () => {
    const previousEnvValue = process.env.CLI_SKILL_API_KEY;
    delete process.env.CLI_SKILL_API_KEY;
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = (args[0] ?? {}) as { env?: Record<string, string> };
      expect(input.env?.CLI_SKILL_API_KEY).toBe("skill-secret");
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: CLAUDE_OK_JSONL,
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    try {
      await executePreparedCliRun(
        buildPreparedCliRunContext({
          provider: "claude-cli",
          model: "sonnet",
          runId: "run-claude-skill-env",
          config: {
            skills: {
              entries: {
                envskill: { apiKey: "skill-secret" }, // pragma: allowlist secret
              },
            },
          },
          skillsSnapshot: {
            prompt: "",
            skills: [{ name: "envskill", primaryEnv: "CLI_SKILL_API_KEY" }],
          },
        }),
      );
      expect(process.env.CLI_SKILL_API_KEY).toBeUndefined();
    } finally {
      if (previousEnvValue === undefined) {
        delete process.env.CLI_SKILL_API_KEY;
      } else {
        process.env.CLI_SKILL_API_KEY = previousEnvValue;
      }
    }
  });

  it("runs CLI through supervisor and returns payload", async () => {
    const logInfoSpy = vi.spyOn(cliBackendLog, "info").mockImplementation(() => undefined);
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "ok",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    const context = buildPreparedCliRunContext({
      provider: "codex-cli",
      model: "gpt-5.4",
      runId: "run-1",
    });
    context.reusableCliSession = { mode: "reuse", sessionId: "thread-123" };

    try {
      const result = await executePreparedCliRun(context, "thread-123");

      expect(result.text).toBe("ok");
      const input = mockCallArg(supervisorSpawnMock) as {
        argv?: string[];
        mode?: string;
        timeoutMs?: number;
        noOutputTimeoutMs?: number;
        replaceExistingScope?: boolean;
        scopeKey?: string;
      };
      expect(input.mode).toBe("child");
      expect(input.argv).toEqual([
        "codex",
        "exec",
        "resume",
        "thread-123",
        "--skip-git-repo-check",
        "--model",
        "gpt-5.4",
        "hi",
      ]);
      expect(input.timeoutMs).toBe(1_000);
      expect(input.noOutputTimeoutMs).toBeGreaterThanOrEqual(1_000);
      expect(input.replaceExistingScope).toBe(true);
      expect(input.scopeKey).toContain("thread-123");

      const turnLog = logInfoSpy.mock.calls
        .map(([message]) => message)
        .find((message) => message.startsWith("cli turn:"));
      expect(turnLog).toContain("provider=codex-cli");
      expect(turnLog).toContain("model=gpt-5.4");
      expect(turnLog).toContain("outBytes=2 outHash=2689367b205c");
      expect(turnLog).not.toContain("ok");
    } finally {
      logInfoSpy.mockRestore();
    }
  });

  it("returns process diagnostics with byte counts and bounded output hashes", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 75,
        stdout: "ok",
        stderr: "warn\n",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    const result = await executePreparedCliRun(
      buildPreparedCliRunContext({
        provider: "codex-cli",
        model: "gpt-5.4",
        runId: "run-process-diagnostics",
      }),
    );

    expect(result.diagnostics?.process).toEqual({
      backendId: "codex-cli",
      processReason: "exit",
      exitCode: 0,
      exitSignal: null,
      durationMs: 75,
      stdoutBytes: 2,
      stdoutHash: "2689367b205c",
      stderrBytes: 5,
      stderrHash: "7597e6b3a377",
      useResume: false,
    });
  });

  it("rejects Gemini stream-json error results emitted with a zero exit code", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout:
          [
            JSON.stringify({
              type: "message",
              role: "assistant",
              content: "partial text",
              delta: true,
            }),
            JSON.stringify({
              type: "result",
              status: "error",
              error: {
                message: "Gemini stream failed",
              },
            }),
          ].join("\n") + "\n",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    await expectRejectsWithFields(
      executePreparedCliRun(
        buildPreparedCliRunContext({
          provider: "google-gemini-cli",
          model: "gemini-3.1-pro-preview",
          runId: "run-gemini-stream-json-error",
        }),
      ),
      {
        name: "FailoverError",
        message: "Gemini stream failed",
        reason: "unknown",
      },
    );
  });

  it("passes Codex system prompts through model_instructions_file", async () => {
    let promptFileText = "";
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = (args[0] ?? {}) as { argv?: string[] };
      const configArg = requireArgAfter(input.argv, "-c");
      const match = requireRegexMatch(configArg, /^model_instructions_file="(.+)"$/);
      promptFileText = await fs.readFile(match[1], "utf-8");
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "ok",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    await executePreparedCliRun(
      buildPreparedCliRunContext({
        provider: "codex-cli",
        model: "gpt-5.4",
        runId: "run-codex-system-prompt-file",
      }),
    );

    expect(promptFileText).toBe("You are a helpful assistant.");
  });

  it("cancels the managed CLI run when the abort signal fires", async () => {
    const abortController = new AbortController();
    let resolveWait:
      | ((value: {
          reason:
            | "manual-cancel"
            | "overall-timeout"
            | "no-output-timeout"
            | "spawn-error"
            | "signal"
            | "exit";
          exitCode: number | null;
          exitSignal: NodeJS.Signals | number | null;
          durationMs: number;
          stdout: string;
          stderr: string;
          timedOut: boolean;
          noOutputTimedOut: boolean;
        }) => void)
      | undefined;
    const cancel = vi.fn((reason?: string) => {
      if (!resolveWait) {
        throw new Error("Expected managed CLI wait resolver to be initialized");
      }
      resolveWait({
        reason: reason === "manual-cancel" ? "manual-cancel" : "signal",
        exitCode: null,
        exitSignal: null,
        durationMs: 50,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });
    supervisorSpawnMock.mockResolvedValueOnce({
      runId: "run-supervisor",
      pid: 1234,
      startedAtMs: Date.now(),
      stdin: undefined,
      wait: vi.fn(
        async () =>
          await new Promise((resolve) => {
            resolveWait = resolve;
          }),
      ),
      cancel,
    });

    const context = buildPreparedCliRunContext({
      provider: "codex-cli",
      model: "gpt-5.4",
      runId: "run-abort",
    });
    context.params.abortSignal = abortController.signal;

    const runPromise = executePreparedCliRun(context);

    await vi.waitFor(() => {
      expect(supervisorSpawnMock).toHaveBeenCalledTimes(1);
    });
    abortController.abort();

    await expectRejectsWithFields(runPromise, { name: "AbortError" });
    expect(cancel).toHaveBeenCalledWith("manual-cancel");
  });

  it("streams Claude text deltas from stream-json stdout", async () => {
    const agentEvents: Array<{ stream: string; text?: string; delta?: string }> = [];
    const stop = onAgentEvent((evt) => {
      agentEvents.push({
        stream: evt.stream,
        text: typeof evt.data.text === "string" ? evt.data.text : undefined,
        delta: typeof evt.data.delta === "string" ? evt.data.delta : undefined,
      });
    });
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = (args[0] ?? {}) as { onStdout?: (chunk: string) => void };
      input.onStdout?.(
        [
          JSON.stringify({ type: "init", session_id: "session-123" }),
          JSON.stringify({
            type: "stream_event",
            event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } },
          }),
        ].join("\n") + "\n",
      );
      input.onStdout?.(
        JSON.stringify({
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: " world" } },
        }) + "\n",
      );
      input.onStdout?.(
        JSON.stringify({
          type: "result",
          session_id: "session-123",
          result: "Hello world",
        }) + "\n",
      );
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    try {
      const result = await executePreparedCliRun(
        buildPreparedCliRunContext({
          provider: "claude-cli",
          model: "sonnet",
          runId: "run-claude-stream-json",
        }),
      );

      expect(result.text).toBe("Hello world");
      expect(agentEvents).toEqual([
        { stream: "assistant", text: "Hello", delta: "Hello" },
        { stream: "assistant", text: "Hello world", delta: " world" },
      ]);
    } finally {
      stop();
    }
  });

  it("suppresses Claude text delta events for side-question runs", async () => {
    const agentEvents: Array<{ stream: string; text?: string; delta?: string }> = [];
    const stop = onAgentEvent((evt) => {
      agentEvents.push({
        stream: evt.stream,
        text: typeof evt.data.text === "string" ? evt.data.text : undefined,
        delta: typeof evt.data.delta === "string" ? evt.data.delta : undefined,
      });
    });
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = (args[0] ?? {}) as { onStdout?: (chunk: string) => void };
      input.onStdout?.(
        [
          JSON.stringify({ type: "init", session_id: "session-123" }),
          JSON.stringify({
            type: "stream_event",
            event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } },
          }),
          JSON.stringify({
            type: "result",
            session_id: "session-123",
            result: "Hello",
          }),
        ].join("\n") + "\n",
      );
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    try {
      const result = await executePreparedCliRun(
        buildPreparedCliRunContext({
          provider: "claude-cli",
          model: "sonnet",
          runId: "run-claude-side-question-stream-json",
          executionMode: "side-question",
          backend: { sessionMode: "none" },
        }),
      );

      expect(result.text).toBe("Hello");
      expect(agentEvents).toEqual([]);
    } finally {
      stop();
    }
  });

  it("reuses a Claude live session process across turns", async () => {
    const logInfoSpy = vi.spyOn(cliBackendLog, "info").mockImplementation(() => undefined);
    const agentEvents: unknown[] = [];
    const stop = onAgentEvent((evt) => {
      if (evt.stream === "assistant") {
        agentEvents.push(evt.data);
      }
    });
    const writes: string[] = [];
    let stdoutListener: ((chunk: string) => void) | undefined;
    const stdin = {
      write: vi.fn((data: string, cb?: (err?: Error | null) => void) => {
        writes.push(data);
        const prompt = (JSON.parse(data) as { message: { content: string } }).message.content;
        const text = prompt === "first" ? "one" : "two";
        stdoutListener?.(
          [
            JSON.stringify({ type: "system", subtype: "init", session_id: "live-session-1" }),
            JSON.stringify({
              type: "stream_event",
              event: {
                type: "content_block_delta",
                delta: { type: "text_delta", text },
              },
            }),
            JSON.stringify({
              type: "result",
              session_id: "live-session-1",
              result: text,
            }),
          ].join("\n") + "\n",
        );
        cb?.();
      }),
      end: vi.fn(),
    };
    supervisorSpawnMock.mockImplementation(async (...args: unknown[]) => {
      const input = (args[0] ?? {}) as { onStdout?: (chunk: string) => void };
      stdoutListener = input.onStdout;
      return {
        runId: "live-run",
        pid: 2345,
        startedAtMs: Date.now(),
        stdin,
        wait: vi.fn(() => new Promise(() => {})),
        cancel: vi.fn(),
      };
    });

    try {
      const firstContext = buildPreparedCliRunContext({
        provider: "claude-cli",
        model: "sonnet",
        runId: "run-live-1",
        prompt: "first",
        backend: {
          args: ["-p", "--strict-mcp-config", "--mcp-config", "/tmp/mcp-one.json"],
          resumeArgs: [
            "-p",
            "--resume",
            "{sessionId}",
            "--strict-mcp-config",
            "--mcp-config",
            "/tmp/mcp-one.json",
          ],
          liveSession: "claude-stdio",
        },
        mcpConfigHash: "same-mcp-config",
      });
      const first = await executePreparedCliRun(firstContext);
      const liveGeneration = getClaudeLiveSessionGenerationForOwner({
        backendId: "claude-cli",
        sessionId: "s1",
      });
      expect(liveGeneration).toBeDefined();
      const secondContext = buildPreparedCliRunContext({
        provider: "claude-cli",
        model: "sonnet",
        runId: "run-live-2",
        prompt: "second",
        backend: {
          args: ["-p", "--strict-mcp-config", "--mcp-config", "/tmp/mcp-two.json"],
          resumeArgs: [
            "-p",
            "--resume",
            "{sessionId}",
            "--strict-mcp-config",
            "--mcp-config",
            "/tmp/mcp-two.json",
          ],
          liveSession: "claude-stdio",
        },
        mcpConfigHash: "same-mcp-config",
      });
      secondContext.requiredClaudeLiveSessionGeneration = liveGeneration;
      const second = await executePreparedCliRun(secondContext, "live-session-1");

      const changedContext = buildPreparedCliRunContext({
        provider: "claude-cli",
        model: "opus",
        runId: "run-live-changed",
        prompt: "changed",
        backend: {
          args: ["-p"],
          resumeArgs: ["-p", "--resume", "{sessionId}"],
          liveSession: "claude-stdio",
        },
        mcpConfigHash: "same-mcp-config",
      });
      changedContext.requiredClaudeLiveSessionGeneration = liveGeneration;
      await expect(executePreparedCliRun(changedContext, "live-session-1")).rejects.toMatchObject({
        reason: "session_expired",
        code: "cli_live_session_changed",
      });

      const spawnInput = mockCallArg(supervisorSpawnMock) as {
        argv?: string[];
        stdinMode?: string;
      };
      expect(first.text).toBe("one");
      expect(second.text).toBe("two");
      expect(supervisorSpawnMock).toHaveBeenCalledOnce();
      expect(spawnInput.stdinMode).toBe("pipe-open");
      expect(spawnInput.argv).toContain("--input-format");
      expect(spawnInput.argv).toContain("--output-format");
      expect(spawnInput.argv).toContain("stream-json");
      expect(spawnInput.argv).toContain("--replay-user-messages");
      expect(spawnInput.argv).not.toContain("--session-id");
      expect(spawnInput.argv).toContain("/tmp/mcp-one.json");
      expect(
        writes.map(
          (entry) => (JSON.parse(entry) as { message: { content: string } }).message.content,
        ),
      ).toEqual(["first", "second"]);
      expect(agentEvents).toEqual([
        { text: "one", delta: "one" },
        { text: "two", delta: "two" },
      ]);
      const turnLogs = logInfoSpy.mock.calls
        .map(([message]) => message)
        .filter((message) => message.startsWith("claude live session turn:"));
      expect(turnLogs).toHaveLength(2);
      expect(turnLogs[0]).toContain("outBytes=3 outHash=7692c3ad3540");
      expect(turnLogs[1]).toContain("outBytes=3 outHash=3fc4ccfe7458");
      expect(turnLogs.join("\n")).not.toContain("one");
      expect(turnLogs.join("\n")).not.toContain("two");
    } finally {
      logInfoSpy.mockRestore();
      stop();
    }
  });

  it("requires the exact warm Claude process even without native resume args", async () => {
    let stdoutListener: ((chunk: string) => void) | undefined;
    const writes: string[] = [];
    const stdin = {
      write: vi.fn((data: string, cb?: (err?: Error | null) => void) => {
        writes.push(data);
        stdoutListener?.(
          [
            JSON.stringify({ type: "system", subtype: "init", session_id: "live-session-1" }),
            JSON.stringify({ type: "result", session_id: "live-session-1", result: "one" }),
          ].join("\n") + "\n",
        );
        cb?.();
      }),
      end: vi.fn(),
    };
    supervisorSpawnMock.mockImplementation(async (...args: unknown[]) => {
      const input = (args[0] ?? {}) as { onStdout?: (chunk: string) => void };
      stdoutListener = input.onStdout;
      return {
        runId: "live-run-no-resume",
        pid: 2346,
        startedAtMs: Date.now(),
        stdin,
        wait: vi.fn(() => new Promise(() => {})),
        cancel: vi.fn(),
      };
    });

    const firstContext = buildPreparedCliRunContext({
      provider: "claude-cli",
      model: "sonnet",
      runId: "run-live-no-resume-1",
      prompt: "first",
      backend: { args: ["-p"], resumeArgs: [], liveSession: "claude-stdio" },
    });
    expect((await executePreparedCliRun(firstContext)).text).toBe("one");
    const liveGeneration = getClaudeLiveSessionGenerationForOwner({
      backendId: "claude-cli",
      sessionId: "s1",
    });
    expect(liveGeneration).toBeDefined();

    resetClaudeLiveSessionsForTest();
    const missingContext = buildPreparedCliRunContext({
      provider: "claude-cli",
      model: "sonnet",
      runId: "run-live-no-resume-2",
      prompt: "second",
      backend: { args: ["-p"], resumeArgs: [], liveSession: "claude-stdio" },
    });
    missingContext.requiredClaudeLiveSessionGeneration = liveGeneration;

    await expect(executePreparedCliRun(missingContext, "live-session-1")).rejects.toMatchObject({
      reason: "session_expired",
      code: "cli_live_session_missing",
    });

    const replacementContext = buildPreparedCliRunContext({
      provider: "claude-cli",
      model: "sonnet",
      runId: "run-live-no-resume-replacement",
      prompt: "replacement",
      backend: { args: ["-p"], resumeArgs: [], liveSession: "claude-stdio" },
    });
    expect((await executePreparedCliRun(replacementContext)).text).toBe("one");
    await expect(executePreparedCliRun(missingContext, "live-session-1")).rejects.toMatchObject({
      reason: "session_expired",
      code: "cli_live_session_changed",
    });
    missingContext.openClawHistoryPrompt = "bounded OpenClaw history\n\nsecond";
    expect((await executePreparedCliRun(missingContext)).text).toBe("one");
    expect(supervisorSpawnMock).toHaveBeenCalledTimes(3);
    expect(
      (JSON.parse(writes.at(-1) ?? "") as { message: { content: string } }).message.content,
    ).toBe("bounded OpenClaw history\n\nsecond");
  });

  it("keeps pre-tool commentary out of an empty-result Claude live reply", async () => {
    const agentEvents: Array<{ stream: string; data: unknown }> = [];
    const stop = onAgentEvent((event) => {
      agentEvents.push({ stream: event.stream, data: event.data });
    });
    let stdoutListener: ((chunk: string) => void) | undefined;
    const stdin = {
      write: vi.fn((_data: string, callback?: (error?: Error | null) => void) => {
        stdoutListener?.(
          [
            JSON.stringify({ type: "system", subtype: "init", session_id: "live-empty-result" }),
            JSON.stringify({
              type: "stream_event",
              event: {
                type: "content_block_delta",
                delta: { type: "text_delta", text: "Let me check." },
              },
            }),
            JSON.stringify({
              type: "stream_event",
              event: {
                type: "content_block_start",
                index: 1,
                content_block: { type: "tool_use", id: "tool-1", name: "Read", input: {} },
              },
            }),
            JSON.stringify({
              type: "stream_event",
              event: {
                type: "content_block_delta",
                delta: { type: "text_delta", text: "Final answer." },
              },
            }),
            JSON.stringify({
              type: "result",
              session_id: "live-empty-result",
              result: "",
            }),
          ].join("\n") + "\n",
        );
        callback?.();
      }),
      end: vi.fn(),
    };
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = (args[0] ?? {}) as { onStdout?: (chunk: string) => void };
      stdoutListener = input.onStdout;
      return {
        runId: "live-empty-result-run",
        pid: 2345,
        startedAtMs: Date.now(),
        stdin,
        wait: vi.fn(() => new Promise(() => {})),
        cancel: vi.fn(),
      };
    });

    try {
      const result = await executePreparedCliRun(
        buildPreparedCliRunContext({
          provider: "claude-cli",
          model: "sonnet",
          runId: "run-live-empty-result",
          emitCommentaryText: true,
          backend: { liveSession: "claude-stdio" },
        }),
      );

      expect(result.text).toBe("Final answer.");
      expect(agentEvents).toContainEqual({
        stream: "item",
        data: expect.objectContaining({
          kind: "preamble",
          progressText: "Let me check.",
        }),
      });
      expect(agentEvents).toContainEqual({
        stream: "assistant",
        data: { text: "Final answer.", delta: "Final answer." },
      });
    } finally {
      stop();
    }
  });

  it("extends the live no-output watchdog to the blocked-tool floor while a tool is outstanding", async () => {
    const toolErrorEvents: Array<Record<string, unknown>> = [];
    const stopDiagnostics = onTrustedToolExecutionEvent((event) => {
      if (event.type === "tool.execution.error") {
        toolErrorEvents.push(event as unknown as Record<string, unknown>);
      }
    });
    let stdoutListener: ((chunk: string) => void) | undefined;
    const cancel = vi.fn();
    const stdin = {
      write: vi.fn((_data: string, callback?: (error?: Error | null) => void) => {
        stdoutListener?.(
          [
            JSON.stringify({ type: "system", subtype: "init", session_id: "live-quiet-tool" }),
            JSON.stringify({
              type: "assistant",
              message: {
                content: [{ type: "tool_use", id: "tool-quiet-1", name: "Bash", input: {} }],
              },
            }),
          ].join("\n") + "\n",
        );
        callback?.();
      }),
      end: vi.fn(),
    };
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = (args[0] ?? {}) as { onStdout?: (chunk: string) => void };
      stdoutListener = input.onStdout;
      return {
        runId: "live-quiet-tool-run",
        pid: 2345,
        startedAtMs: Date.now(),
        stdin,
        wait: vi.fn(() => new Promise(() => {})),
        cancel,
      };
    });

    const run = executePreparedCliRun(
      buildPreparedCliRunContext({
        provider: "claude-cli",
        model: "sonnet",
        runId: "run-live-quiet-tool",
        backend: { liveSession: "claude-stdio" },
        timeoutMs: 3_600_000,
      }),
    );
    const rejection = expect(run).rejects.toThrow(/produced no output for 900s/);
    await vi.waitFor(() => {
      expect(stdin.write).toHaveBeenCalledOnce();
    });

    // Fake the clock only after the spawn path settled, then emit one more
    // stdout line so the watchdog re-arms on the faked setTimeout/Date.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    stdoutListener?.(
      `${JSON.stringify({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "running" } },
      })}\n`,
    );

    // Base watchdog (600s cap for a 1h budget) must not kill the quiet tool.
    await vi.advanceTimersByTimeAsync(650_000);
    expect(cancel).not.toHaveBeenCalled();

    // The blocked-tool floor (15min of quiet) still terminates a wedged tool.
    try {
      await vi.advanceTimersByTimeAsync(300_000);
      expect(cancel).toHaveBeenCalledWith("manual-cancel");
      await rejection;
      // Watchdog-killed turns must keep timeout provenance for active tools.
      expect(toolErrorEvents).toContainEqual(
        expect.objectContaining({
          toolCallId: "tool-quiet-1",
          terminalReason: "timed_out",
        }),
      );
    } finally {
      stopDiagnostics();
    }
  });

  it("keeps non-capture live prepared backend cleanup with the whole-run owner", async () => {
    let stdoutListener: ((chunk: string) => void) | undefined;
    const stdin = {
      write: vi.fn((dataValue: string, cb?: (err?: Error | null) => void) => {
        stdoutListener?.(
          [
            JSON.stringify({ type: "system", subtype: "init", session_id: "live-session-cleanup" }),
            JSON.stringify({
              type: "result",
              session_id: "live-session-cleanup",
              result: "ok",
            }),
          ].join("\n") + "\n",
        );
        cb?.();
      }),
      end: vi.fn(),
    };
    supervisorSpawnMock.mockImplementation(async (...args: unknown[]) => {
      const input = (args[0] ?? {}) as { onStdout?: (chunk: string) => void };
      stdoutListener = input.onStdout;
      return {
        runId: "live-cleanup-run",
        pid: 2346,
        startedAtMs: Date.now(),
        stdin,
        wait: vi.fn(() => new Promise(() => {})),
        cancel: vi.fn(),
      };
    });
    const preparedBackendCleanup = vi.fn(async () => {});
    const context = buildPreparedCliRunContext({
      provider: "claude-cli",
      model: "sonnet",
      runId: "run-live-cleanup",
      prompt: "first",
      backend: {
        args: ["-p", "--strict-mcp-config", "--mcp-config", "/tmp/mcp-cleanup.json"],
        liveSession: "claude-stdio",
      },
      mcpConfigHash: "cleanup-mcp-config",
    });
    context.preparedBackend.cleanup = preparedBackendCleanup;

    const result = await executePreparedCliRun(context);

    expect(result.text).toBe("ok");
    expect(context.preparedBackend.cleanup).toBe(preparedBackendCleanup);
    expect(preparedBackendCleanup).not.toHaveBeenCalled();

    resetClaudeLiveSessionsForTest();
    expect(preparedBackendCleanup).not.toHaveBeenCalled();
    await context.preparedBackend.cleanup?.();
    expect(preparedBackendCleanup).toHaveBeenCalledOnce();
  });

  it("keeps captured live prepared backend cleanup with the whole-run owner", async () => {
    const mcpConfigDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-cli-captured-mcp-config-"),
    );
    const mcpConfigPath = path.join(mcpConfigDir, "mcp.json");
    await fs.writeFile(
      mcpConfigPath,
      `${JSON.stringify(
        {
          mcpServers: {
            openclaw: {
              type: "http",
              url: "http://127.0.0.1:23119/mcp",
              headers: {},
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    try {
      let stdoutListener: ((chunk: string) => void) | undefined;
      let resolveExit: ((exit: RunExit) => void) | undefined;
      const exited = new Promise<RunExit>((resolve) => {
        resolveExit = resolve;
      });
      supervisorSpawnMock.mockImplementation(async (...args: unknown[]) => {
        const input = (args[0] ?? {}) as { onStdout?: (chunk: string) => void };
        stdoutListener = input.onStdout;
        return {
          runId: "captured-live-cleanup-run",
          pid: 2347,
          startedAtMs: Date.now(),
          stdin: {
            write: vi.fn((dataValue: string, cb?: (err?: Error | null) => void) => {
              stdoutListener?.(
                [
                  JSON.stringify({
                    type: "system",
                    subtype: "init",
                    session_id: "captured-live-cleanup",
                  }),
                  JSON.stringify({
                    type: "result",
                    session_id: "captured-live-cleanup",
                    result: "ok",
                  }),
                ].join("\n") + "\n",
              );
              cb?.();
            }),
            end: vi.fn(),
          },
          wait: vi.fn(() => exited),
          cancel: vi.fn(() =>
            resolveExit?.({
              reason: "manual-cancel",
              exitCode: null,
              exitSignal: null,
              durationMs: 1,
              stdout: "",
              stderr: "",
              timedOut: false,
              noOutputTimedOut: false,
            }),
          ),
        };
      });
      const preparedBackendCleanup = vi.fn(async () => {});
      const context = buildPreparedCliRunContext({
        provider: "claude-cli",
        model: "sonnet",
        runId: "run-captured-live-cleanup",
        prompt: "first",
        backend: {
          args: ["-p", "--strict-mcp-config", "--mcp-config", mcpConfigPath],
          liveSession: "claude-stdio",
        },
        mcpConfigHash: "captured-cleanup-mcp-config",
        mcpDeliveryCapture: true,
      });
      context.preparedBackend.cleanup = preparedBackendCleanup;

      const result = await executePreparedCliRun(context);

      expect(result.text).toBe("ok");
      expect(context.preparedBackend.cleanup).toBe(preparedBackendCleanup);
      expect(preparedBackendCleanup).not.toHaveBeenCalled();

      await context.preparedBackend.cleanup?.();
      expect(preparedBackendCleanup).toHaveBeenCalledOnce();
    } finally {
      await fs.rm(mcpConfigDir, { recursive: true, force: true });
    }
  });

  it("preserves completed output when system prompt cleanup fails after delivery", async () => {
    const cleanupError = new Error("system prompt cleanup failed");
    const logWarnSpy = vi.spyOn(cliBackendLog, "warn").mockImplementation(() => undefined);
    setCliRunnerExecuteTestDeps({
      writeCliSystemPromptFile: async () => ({
        filePath: "/tmp/system-prompt.md",
        cleanup: async () => {
          throw cleanupError;
        },
      }),
    });
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as Parameters<ReturnType<typeof getProcessSupervisor>["spawn"]>[0];
      const captureHandle = markMcpLoopbackToolCallStarted({
        captureKey: input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "",
        toolName: "message",
        args: { action: "send", target: "chat123", message: "done" },
      });
      if (!captureHandle) {
        throw new Error("Expected message delivery capture");
      }
      recordMcpLoopbackToolCallResult({
        captureHandle,
        toolName: "message",
        args: { action: "send", target: "chat123", message: "done" },
        result: { status: "sent" },
        outcome: "completed",
      });
      markMcpLoopbackToolCallFinished(captureHandle);
      input.onStdout?.("done");
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });
    const context = buildPreparedCliRunContext({
      provider: "codex-cli",
      model: "gpt-5.4",
      runId: "run-cleanup-delivery-evidence",
      mcpDeliveryCapture: true,
    });

    const result = await executePreparedCliRun(context);
    setCliRunnerExecuteTestDeps({ writeCliSystemPromptFile });

    expect(result.text).toBe("done");
    expect(result.didSendViaMessagingTool).toBe(true);
    expect(logWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("outer resource cleanup failed after confirmed message delivery"),
    );
  });

  it("wraps primitive and frozen failures to preserve delivery evidence", () => {
    const evidence = { didSendViaMessagingTool: true };
    const primitive = attachCliMessagingDeliveryEvidence("failed", evidence);
    const frozen = attachCliMessagingDeliveryEvidence(Object.freeze(new Error("frozen")), evidence);

    expect(primitive).toBeInstanceOf(Error);
    expect(frozen).toBeInstanceOf(Error);
    expect(getCliMessagingDeliveryEvidence(primitive)?.didSendViaMessagingTool).toBe(true);
    expect(getCliMessagingDeliveryEvidence(frozen)?.didSendViaMessagingTool).toBe(true);
  });

  it("accepts Claude live stream-json lines larger than 256 KiB", async () => {
    const largeText = "x".repeat(270 * 1024);
    let stdoutListener: ((chunk: string) => void) | undefined;
    const stdin = {
      write: vi.fn((dataValue: string, cb?: (err?: Error | null) => void) => {
        stdoutListener?.(
          JSON.stringify({
            type: "result",
            session_id: "live-session-large",
            result: largeText,
          }) + "\n",
        );
        cb?.();
      }),
      end: vi.fn(),
    };
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = (args[0] ?? {}) as { onStdout?: (chunk: string) => void };
      stdoutListener = input.onStdout;
      return {
        runId: "live-run-large",
        pid: 2345,
        startedAtMs: Date.now(),
        stdin,
        wait: vi.fn(() => new Promise(() => {})),
        cancel: vi.fn(),
      };
    });

    const result = await executePreparedCliRun(
      buildPreparedCliRunContext({
        provider: "claude-cli",
        model: "sonnet",
        runId: "run-live-large-line",
        backend: {
          liveSession: "claude-stdio",
        },
      }),
    );

    expect(result.text).toHaveLength(largeText.length);
    expect(result.text).toBe(largeText);
  });

  it("honors configured Claude live stream-json raw turn limits", async () => {
    const largeText = "x".repeat(1500);
    let stdoutListener: ((chunk: string) => void) | undefined;
    const stdin = {
      write: vi.fn((dataValue: string, cb?: (err?: Error | null) => void) => {
        stdoutListener?.(
          JSON.stringify({
            type: "result",
            session_id: "live-session-tight-output-limit",
            result: largeText,
          }) + "\n",
        );
        cb?.();
      }),
      end: vi.fn(),
    };
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = (args[0] ?? {}) as { onStdout?: (chunk: string) => void };
      stdoutListener = input.onStdout;
      return {
        runId: "live-run-tight-output-limit",
        pid: 2345,
        startedAtMs: Date.now(),
        stdin,
        wait: vi.fn(() => new Promise(() => {})),
        cancel: vi.fn(),
      };
    });

    await expectRejectsWithFields(
      executePreparedCliRun(
        buildPreparedCliRunContext({
          provider: "claude-cli",
          model: "sonnet",
          runId: "run-live-tight-output-limit",
          backend: {
            liveSession: "claude-stdio",
            reliability: {
              outputLimits: {
                maxTurnRawChars: 1024,
              },
            },
          },
        }),
      ),
      {
        name: "FailoverError",
        message: "Claude CLI JSONL line exceeded output limit.",
      },
    );
  });

  it("accepts operator-raised Claude live stream-json raw turn limits", async () => {
    const largeText = "x".repeat(1500);
    let stdoutListener: ((chunk: string) => void) | undefined;
    const stdin = {
      write: vi.fn((dataValue: string, cb?: (err?: Error | null) => void) => {
        stdoutListener?.(
          JSON.stringify({
            type: "result",
            session_id: "live-session-raised-output-limit",
            result: largeText,
          }) + "\n",
        );
        cb?.();
      }),
      end: vi.fn(),
    };
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = (args[0] ?? {}) as { onStdout?: (chunk: string) => void };
      stdoutListener = input.onStdout;
      return {
        runId: "live-run-raised-output-limit",
        pid: 2345,
        startedAtMs: Date.now(),
        stdin,
        wait: vi.fn(() => new Promise(() => {})),
        cancel: vi.fn(),
      };
    });

    const result = await executePreparedCliRun(
      buildPreparedCliRunContext({
        provider: "claude-cli",
        model: "sonnet",
        runId: "run-live-raised-output-limit",
        backend: {
          liveSession: "claude-stdio",
          reliability: {
            outputLimits: {
              maxTurnRawChars: 4096,
            },
          },
        },
      }),
    );

    expect(result.text).toHaveLength(largeText.length);
    expect(result.text).toBe(largeText);
  });

  it("reports Claude live session reply backends as streaming until the turn finishes", async () => {
    let stdoutListener: ((chunk: string) => void) | undefined;
    let markWriteReady: (() => void) | undefined;
    const writeReady = new Promise<void>((resolve) => {
      markWriteReady = resolve;
    });
    const stdin = {
      write: vi.fn((dataValue: string, cb?: (err?: Error | null) => void) => {
        markWriteReady?.();
        cb?.();
      }),
      end: vi.fn(),
    };
    supervisorSpawnMock.mockImplementation(async (...args: unknown[]) => {
      const input = (args[0] ?? {}) as { onStdout?: (chunk: string) => void };
      stdoutListener = input.onStdout;
      return {
        runId: "live-run",
        pid: 2345,
        startedAtMs: Date.now(),
        stdin,
        wait: vi.fn(() => new Promise(() => {})),
        cancel: vi.fn(),
      };
    });
    const operation = createReplyOperation({
      sessionKey: "agent:main:main",
      sessionId: "live-session-reply",
      resetTriggered: false,
    });
    operation.setPhase("running");
    const context = buildPreparedCliRunContext({
      provider: "claude-cli",
      model: "sonnet",
      runId: "run-live-reply-streaming",
      sessionId: "live-session-reply",
      sessionKey: "agent:main:main",
      prompt: "hello",
      backend: {
        liveSession: "claude-stdio",
      },
    });

    const run = executePreparedCliRun({
      ...context,
      params: {
        ...context.params,
        replyOperation: operation,
      },
    });

    await writeReady;
    expect(replyRunRegistry.isStreaming("agent:main:main")).toBe(true);

    stdoutListener?.(
      [
        JSON.stringify({ type: "system", subtype: "init", session_id: "live-session-reply" }),
        JSON.stringify({
          type: "result",
          session_id: "live-session-reply",
          result: "done",
        }),
      ].join("\n") + "\n",
    );

    const result = await run;
    expect(result.text).toBe("done");
    expect(replyRunRegistry.isStreaming("agent:main:main")).toBe(false);
    operation.complete();
  });

  it("reuses a Claude live session when resumed turns omit the system prompt arg", async () => {
    let stdoutListener: ((chunk: string) => void) | undefined;
    let turn = 0;
    const stdin = {
      write: vi.fn((dataValue: string, cb?: (err?: Error | null) => void) => {
        turn += 1;
        stdoutListener?.(
          [
            JSON.stringify({ type: "system", subtype: "init", session_id: "live-system" }),
            JSON.stringify({
              type: "result",
              session_id: "live-system",
              result: turn === 1 ? "one" : "two",
            }),
          ].join("\n") + "\n",
        );
        cb?.();
      }),
      end: vi.fn(),
    };
    supervisorSpawnMock.mockImplementation(async (...args: unknown[]) => {
      const input = (args[0] ?? {}) as { onStdout?: (chunk: string) => void };
      stdoutListener = input.onStdout;
      return {
        runId: "live-run",
        pid: 2345,
        startedAtMs: Date.now(),
        stdin,
        wait: vi.fn(() => new Promise(() => {})),
        cancel: vi.fn(),
      };
    });

    const backend = {
      resumeArgs: ["-p", "--output-format", "stream-json", "--resume={sessionId}"],
      liveSession: "claude-stdio" as const,
    };
    const first = await executePreparedCliRun(
      buildPreparedCliRunContext({
        provider: "claude-cli",
        model: "sonnet",
        runId: "run-live-system-1",
        prompt: "first",
        backend,
      }),
    );
    const second = await executePreparedCliRun(
      buildPreparedCliRunContext({
        provider: "claude-cli",
        model: "sonnet",
        runId: "run-live-system-2",
        prompt: "second",
        backend,
      }),
      "live-system",
    );

    expect(first.text).toBe("one");
    expect(second.text).toBe("two");
    expect(supervisorSpawnMock).toHaveBeenCalledOnce();
  });

  it("serializes concurrent Claude live session creation for the same key", async () => {
    let stdoutListener: ((chunk: string) => void) | undefined;
    let releaseSpawn: (() => void) | undefined;
    let turn = 0;
    const spawnReady = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });
    const stdin = {
      write: vi.fn((dataValue: string, cb?: (err?: Error | null) => void) => {
        turn += 1;
        stdoutListener?.(
          [
            JSON.stringify({ type: "system", subtype: "init", session_id: "live-concurrent" }),
            JSON.stringify({
              type: "result",
              session_id: "live-concurrent",
              result: turn === 1 ? "one" : "two",
            }),
          ].join("\n") + "\n",
        );
        cb?.();
      }),
      end: vi.fn(),
    };
    supervisorSpawnMock.mockImplementation(async (...args: unknown[]) => {
      const input = (args[0] ?? {}) as { onStdout?: (chunk: string) => void };
      stdoutListener = input.onStdout;
      await spawnReady;
      return {
        runId: "live-run",
        pid: 2345,
        startedAtMs: Date.now(),
        stdin,
        wait: vi.fn(() => new Promise(() => {})),
        cancel: vi.fn(),
      };
    });

    const backend = {
      liveSession: "claude-stdio" as const,
    };
    const first = executePreparedCliRun(
      buildPreparedCliRunContext({
        provider: "claude-cli",
        model: "sonnet",
        runId: "run-live-concurrent-1",
        prompt: "first",
        backend,
      }),
    );
    const second = executePreparedCliRun(
      buildPreparedCliRunContext({
        provider: "claude-cli",
        model: "sonnet",
        runId: "run-live-concurrent-2",
        prompt: "second",
        backend,
      }),
    );
    await vi.waitFor(() => expect(supervisorSpawnMock).toHaveBeenCalledOnce());
    releaseSpawn?.();

    const results = await Promise.all([first, second]);
    expect(results.map((result) => result.text).toSorted()).toEqual(["one", "two"]);
    expect(stdin.write).toHaveBeenCalledTimes(2);
    expect(supervisorSpawnMock).toHaveBeenCalledOnce();
  });

  it("recovers when a required warm Claude process exits during reuse cleanup", async () => {
    let stdoutListener: ((chunk: string) => void) | undefined;
    let resolveExit: ((exit: RunExit) => void) | undefined;
    const exited = new Promise<RunExit>((resolve) => {
      resolveExit = resolve;
    });
    let turn = 0;
    const stdin = {
      write: vi.fn((_data: string, cb?: (err?: Error | null) => void) => {
        turn += 1;
        stdoutListener?.(
          [
            JSON.stringify({ type: "system", subtype: "init", session_id: "live-race" }),
            JSON.stringify({ type: "result", session_id: "live-race", result: `turn-${turn}` }),
          ].join("\n") + "\n",
        );
        cb?.();
      }),
      end: vi.fn(),
    };
    supervisorSpawnMock.mockImplementation(async (...args: unknown[]) => {
      const input = (args[0] ?? {}) as { onStdout?: (chunk: string) => void };
      stdoutListener = input.onStdout;
      return {
        runId: "live-race-run",
        pid: 2350,
        startedAtMs: Date.now(),
        stdin,
        wait: vi.fn(() => exited),
        cancel: vi.fn(),
      };
    });
    const context = buildPreparedCliRunContext({
      provider: "claude-cli",
      model: "sonnet",
      runId: "run-live-race",
      prompt: "first",
      backend: { args: ["-p"], resumeArgs: [], liveSession: "claude-stdio" },
    });
    const getProcessSupervisorForTest = () => ({
      spawn: (params: Parameters<SupervisorSpawnFn>[0]) =>
        supervisorSpawnMock(params) as ReturnType<SupervisorSpawnFn>,
      cancel: vi.fn(),
      cancelScope: vi.fn(),
      getRecord: vi.fn(),
    });
    const first = await runClaudeLiveSessionTurn({
      context,
      args: context.preparedBackend.backend.args ?? [],
      env: {},
      prompt: "first",
      useResume: false,
      noOutputTimeoutMs: 1_000,
      getProcessSupervisor: getProcessSupervisorForTest,
      onAssistantDelta: () => {},
      cleanup: async () => {},
    });
    expect(first.output.text).toBe("turn-1");
    const generation = getClaudeLiveSessionGenerationForOwner({
      backendId: "claude-cli",
      sessionId: "s1",
    });
    expect(generation).toBeDefined();

    let markCleanupStarted: (() => void) | undefined;
    const cleanupStarted = new Promise<void>((resolve) => {
      markCleanupStarted = resolve;
    });
    let releaseCleanup: (() => void) | undefined;
    const cleanupReleased = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const reuse = runClaudeLiveSessionTurn({
      context,
      args: context.preparedBackend.backend.args ?? [],
      env: {},
      prompt: "second",
      useResume: false,
      requiredSessionGeneration: generation,
      noOutputTimeoutMs: 1_000,
      getProcessSupervisor: getProcessSupervisorForTest,
      onAssistantDelta: () => {},
      cleanup: async () => {
        markCleanupStarted?.();
        await cleanupReleased;
      },
    });
    await cleanupStarted;
    resolveExit?.({
      reason: "exit",
      exitCode: 0,
      exitSignal: null,
      durationMs: 1,
      stdout: "",
      stderr: "",
      timedOut: false,
      noOutputTimedOut: false,
    });
    await vi.waitFor(() =>
      expect(
        getClaudeLiveSessionGenerationForOwner({ backendId: "claude-cli", sessionId: "s1" }),
      ).toBeUndefined(),
    );
    releaseCleanup?.();

    await expect(reuse).rejects.toMatchObject({
      reason: "session_expired",
      code: "cli_live_session_missing",
    });
    expect(stdin.write).toHaveBeenCalledOnce();
  });

  it("counts pending Claude live session creates against the session cap", async () => {
    let releaseSpawn: (() => void) | undefined;
    const spawnReady = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });
    supervisorSpawnMock.mockImplementation(async (...args: unknown[]) => {
      const input = (args[0] ?? {}) as { onStdout?: (chunk: string) => void };
      const spawnIndex = supervisorSpawnMock.mock.calls.length;
      await spawnReady;
      const stdin = {
        write: vi.fn((dataValue: string, cb?: (err?: Error | null) => void) => {
          input.onStdout?.(
            [
              JSON.stringify({
                type: "system",
                subtype: "init",
                session_id: `live-cap-${spawnIndex}`,
              }),
              JSON.stringify({
                type: "result",
                session_id: `live-cap-${spawnIndex}`,
                result: `ok-${spawnIndex}`,
              }),
            ].join("\n") + "\n",
          );
          cb?.();
        }),
        end: vi.fn(),
      };
      return {
        runId: `live-run-${spawnIndex}`,
        pid: 2300 + spawnIndex,
        startedAtMs: Date.now(),
        stdin,
        wait: vi.fn(() => new Promise(() => {})),
        cancel: vi.fn(),
      };
    });

    const backend = {
      liveSession: "claude-stdio" as const,
    };
    const runs = Array.from({ length: 17 }, (_, index) =>
      (() => {
        const context = buildPreparedCliRunContext({
          provider: "claude-cli",
          model: "sonnet",
          runId: `run-live-cap-${index}`,
          prompt: `prompt ${index}`,
          sessionId: `session-${index}`,
          backend,
        });
        return runClaudeLiveSessionTurn({
          context,
          args: context.preparedBackend.backend.args ?? [],
          env: {},
          prompt: `prompt ${index}`,
          useResume: false,
          noOutputTimeoutMs: 1_000,
          getProcessSupervisor: () => ({
            spawn: (params: Parameters<SupervisorSpawnFn>[0]) =>
              supervisorSpawnMock(params) as ReturnType<SupervisorSpawnFn>,
            cancel: vi.fn(),
            cancelScope: vi.fn(),
            getRecord: vi.fn(),
          }),
          onAssistantDelta: () => {},
          cleanup: async () => {},
        });
      })(),
    );
    const rejectedRun = runs[16];
    const rejectedRunExpectation = expect(rejectedRun).rejects.toThrow(
      "Too many Claude CLI live sessions are active.",
    );

    await vi.waitFor(() => expect(supervisorSpawnMock).toHaveBeenCalledTimes(16));
    await rejectedRunExpectation;
    releaseSpawn?.();
    await expect(Promise.all(runs.slice(0, 16))).resolves.toHaveLength(16);
    expect(supervisorSpawnMock).toHaveBeenCalledTimes(16);
  });

  it("preserves Claude resume args when building live session argv", () => {
    const backend: PreparedCliRunContext["preparedBackend"]["backend"] = {
      command: "claude",
      args: ["-p", "--output-format", "stream-json"],
      output: "jsonl",
      input: "stdin",
      sessionArg: "--session-id",
      systemPromptArg: "--append-system-prompt",
      systemPromptFileArg: "--append-system-prompt-file",
    };

    const args = buildClaudeLiveArgs({
      args: [
        "-p",
        "--output-format",
        "stream-json",
        "--resume",
        "claude-session",
        "--session-id",
        "openclaw-session",
        "--append-system-prompt",
        "old prompt",
        "--append-system-prompt-file",
        "/tmp/system-prompt.md",
      ],
      backend,
      systemPrompt: "current prompt",
      useResume: true,
    });

    expect(args).toContain("--resume");
    expect(args).toContain("claude-session");
    expect(args).not.toContain("--session-id");
    expect(args).not.toContain("openclaw-session");
    expect(args).not.toContain("--append-system-prompt-file");
    expect(args).not.toContain("/tmp/system-prompt.md");
    expect(args).not.toContain("--append-system-prompt");
    expect(args).not.toContain("old prompt");
    expect(args).not.toContain("current prompt");
  });

  it("adds Claude stream-json output format when building live session argv", () => {
    const backend: PreparedCliRunContext["preparedBackend"]["backend"] = {
      command: "claude",
      args: ["-p"],
      output: "jsonl",
      input: "stdin",
      sessionArg: "--session-id",
      systemPromptArg: "--append-system-prompt",
      systemPromptFileArg: "--append-system-prompt-file",
    };

    const args = buildClaudeLiveArgs({
      args: ["-p"],
      backend,
      systemPrompt: "current prompt",
      useResume: false,
    });

    expect(requireArgAfter(args, "--input-format")).toBe("stream-json");
    expect(requireArgAfter(args, "--output-format")).toBe("stream-json");
    expect(requireArgAfter(args, "--permission-prompt-tool")).toBe("stdio");
  });

  it("answers Claude live control_request can_use_tool with allow when exec policy is full/no-ask", async () => {
    let stdoutListener: ((chunk: string) => void) | undefined;
    const writes: string[] = [];
    const stdin = {
      write: vi.fn((data: string, cb?: (err?: Error | null) => void) => {
        writes.push(data);
        if (writes.length === 1) {
          stdoutListener?.(
            `${JSON.stringify({
              type: "control_request",
              request_id: "req-allow",
              request: {
                subtype: "can_use_tool",
                tool_name: "Bash",
                tool_use_id: "tool-allow-1",
                input: { command: "ls" },
              },
            })}
${JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: "live-control-allow",
})}
${JSON.stringify({
  type: "result",
  session_id: "live-control-allow",
  result: "ok",
})}
`,
          );
        }
        cb?.();
      }),
      end: vi.fn(),
    };
    supervisorSpawnMock.mockImplementation(async (...args: unknown[]) => {
      const input = (args[0] ?? {}) as { onStdout?: (chunk: string) => void };
      stdoutListener = input.onStdout;
      return {
        runId: "live-run-allow",
        pid: 3001,
        startedAtMs: Date.now(),
        stdin,
        wait: vi.fn(() => new Promise(() => {})),
        cancel: vi.fn(),
      };
    });

    const result = await executePreparedCliRun(
      buildPreparedCliRunContext({
        provider: "claude-cli",
        model: "sonnet",
        runId: "run-control-allow",
        prompt: "hello",
        backend: { liveSession: "claude-stdio" },
        config: {
          tools: { exec: { security: "full", ask: "off" } },
        } as PreparedCliRunContext["params"]["config"],
      }),
    );
    expect(result.text).toBe("ok");
    const controlResponse = writes.find((entry) => entry.includes('"control_response"'));
    expect(controlResponse, "control_response written to stdin").toBeDefined();
    const parsed = JSON.parse((controlResponse ?? "").trim()) as {
      type: string;
      response: {
        subtype: string;
        request_id: string;
        response: { behavior: string; toolUseID?: string; updatedInput?: unknown };
      };
    };
    expect(parsed.type).toBe("control_response");
    expect(parsed.response.subtype).toBe("success");
    expect(parsed.response.request_id).toBe("req-allow");
    expect(parsed.response.response.behavior).toBe("allow");
    expect(parsed.response.response.toolUseID).toBe("tool-allow-1");
    expect(parsed.response.response.updatedInput).toEqual({ command: "ls" });
  });

  it("reports Claude live stream progress without timer heartbeats", async () => {
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    vi.setSystemTime(new Date("2026-05-28T00:00:00.000Z"));
    const diagnosticEvents: string[] = [];
    const stopDiagnostics = onInternalDiagnosticEvent((event) => {
      if (event.type === "run.progress" || event.type.startsWith("tool.execution.")) {
        diagnosticEvents.push(event.type);
      }
    });
    let stdoutListener: ((chunk: string) => void) | undefined;
    const stdin = {
      write: vi.fn((data: string, cb?: (err?: Error | null) => void) => {
        stdoutListener?.(
          [
            JSON.stringify({
              type: "system",
              subtype: "init",
              session_id: "live-diagnostics",
            }),
            JSON.stringify({
              type: "assistant",
              session_id: "live-diagnostics",
              message: {
                role: "assistant",
                content: [
                  {
                    type: "mcp_tool_use",
                    id: "tool-live-1",
                    name: "mcp__team__lookup",
                    input: { query: "status" },
                  },
                  {
                    type: "server_tool_use",
                    id: "tool-live-2",
                    name: "web_search",
                    input: { query: "release status" },
                  },
                ],
              },
            }),
          ].join("\n") + "\n",
        );
        cb?.();
      }),
      end: vi.fn(),
    };
    supervisorSpawnMock.mockImplementation(async (...args: unknown[]) => {
      const input = (args[0] ?? {}) as { onStdout?: (chunk: string) => void };
      stdoutListener = input.onStdout;
      return {
        runId: "live-run-diagnostics",
        pid: 3060,
        startedAtMs: Date.now(),
        stdin,
        wait: vi.fn(() => new Promise(() => {})),
        cancel: vi.fn(),
      };
    });

    try {
      const context = buildPreparedCliRunContext({
        provider: "claude-cli",
        model: "sonnet",
        runId: "run-live-diagnostics",
        sessionId: "session-live-diagnostics",
        sessionKey: "agent:main:diagnostics",
        prompt: "hello",
        backend: { liveSession: "claude-stdio" },
        timeoutMs: 120_000,
      });
      const resultPromise = runClaudeLiveSessionTurn({
        context,
        args: context.preparedBackend.backend.args ?? [],
        env: {},
        prompt: "hello",
        useResume: false,
        noOutputTimeoutMs: 120_000,
        getProcessSupervisor: () => ({
          spawn: (params: Parameters<SupervisorSpawnFn>[0]) =>
            supervisorSpawnMock(params) as ReturnType<SupervisorSpawnFn>,
          cancel: vi.fn(),
          cancelScope: vi.fn(),
          getRecord: vi.fn(),
        }),
        onAssistantDelta: () => {},
        cleanup: async () => {},
      });

      await waitForDiagnosticEventsDrained();
      await vi.waitFor(() =>
        expect(
          getDiagnosticSessionActivitySnapshot({
            sessionKey: "agent:main:diagnostics",
          }).activeToolName,
        ).toBe("mcp__team__lookup"),
      );
      expect(
        getDiagnosticSessionActivitySnapshot({ sessionKey: "agent:main:diagnostics" })
          .lastProgressReason,
      ).toBe("cli_live:tool_started");

      await vi.advanceTimersByTimeAsync(10_000);
      await waitForDiagnosticEventsDrained();
      expect(
        getDiagnosticSessionActivitySnapshot({ sessionKey: "agent:main:diagnostics" })
          .lastProgressReason,
      ).toBe("cli_live:tool_started");
      expect(
        getDiagnosticSessionActivitySnapshot({ sessionKey: "agent:main:diagnostics" })
          .lastProgressAgeMs,
      ).toBeGreaterThanOrEqual(10_000);

      stdoutListener?.(
        [
          JSON.stringify({
            type: "user",
            session_id: "live-diagnostics",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "tool-live-1",
                  content: "lookup failed",
                  is_error: true,
                },
                {
                  type: "tool_result",
                  tool_use_id: "tool-live-2",
                  content: "done",
                },
              ],
            },
          }),
          JSON.stringify({
            type: "assistant",
            session_id: "live-diagnostics",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "ok" }],
            },
          }),
          JSON.stringify({
            type: "result",
            session_id: "live-diagnostics",
            result: "ok",
          }),
        ].join("\n") + "\n",
      );

      await expect(resultPromise).resolves.toMatchObject({ output: { text: "ok" } });
      await waitForDiagnosticEventsDrained();
      expect(
        getDiagnosticSessionActivitySnapshot({ sessionKey: "agent:main:diagnostics" })
          .activeToolName,
      ).toBeUndefined();
      expect(
        getDiagnosticSessionActivitySnapshot({ sessionKey: "agent:main:diagnostics" })
          .lastProgressReason,
      ).toBe("cli_live:result");
      expect(diagnosticEvents.filter((event) => event === "tool.execution.started")).toHaveLength(
        2,
      );
      expect(diagnosticEvents).toContain("tool.execution.completed");
      expect(diagnosticEvents).toContain("tool.execution.error");
    } finally {
      stopDiagnostics();
    }
  });

  it("preserves loopback policy blocks for Claude live tools", async () => {
    const diagnosticEvents: Array<Record<string, unknown>> = [];
    const stopDiagnostics = onInternalDiagnosticEvent((event) => {
      if (
        event.type.startsWith("tool.execution.") &&
        "toolCallId" in event &&
        event.toolCallId === "tool-live-blocked"
      ) {
        diagnosticEvents.push(event as unknown as Record<string, unknown>);
      }
    });
    let stdoutListener: ((chunk: string) => void) | undefined;
    let captureKey = "";
    const stdin = {
      write: vi.fn((_data: string, cb?: (err?: Error | null) => void) => {
        const captureHandle = markMcpLoopbackToolCallStarted({
          captureKey,
          toolName: "message",
          args: { action: "react" },
        });
        if (!captureHandle) {
          throw new Error("Expected live tool capture");
        }
        recordMcpLoopbackToolCallResult({
          captureHandle,
          toolName: "message",
          args: { action: "react" },
          outcome: "blocked",
          deniedReason: "plugin-approval",
        });
        markMcpLoopbackToolCallFinished(captureHandle);
        stdoutListener?.(
          [
            JSON.stringify({ type: "system", subtype: "init", session_id: "live-blocked" }),
            JSON.stringify({
              type: "assistant",
              session_id: "live-blocked",
              message: {
                role: "assistant",
                content: [
                  {
                    type: "mcp_tool_use",
                    id: "tool-live-blocked",
                    name: "mcp__openclaw__message",
                    input: { action: "react" },
                  },
                ],
              },
            }),
            JSON.stringify({
              type: "user",
              session_id: "live-blocked",
              message: {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: "tool-live-blocked",
                    content: "blocked",
                    is_error: true,
                  },
                ],
              },
            }),
            JSON.stringify({ type: "result", session_id: "live-blocked", result: "ok" }),
          ].join("\n") + "\n",
        );
        cb?.();
      }),
      end: vi.fn(),
    };
    supervisorSpawnMock.mockImplementation(async (...args: unknown[]) => {
      const input = (args[0] ?? {}) as {
        env?: Record<string, string>;
        onStdout?: (chunk: string) => void;
      };
      stdoutListener = input.onStdout;
      captureKey = input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "";
      return {
        runId: "live-run-blocked",
        pid: 3061,
        startedAtMs: Date.now(),
        stdin,
        wait: vi.fn(() => new Promise(() => {})),
        cancel: vi.fn(),
      };
    });
    const context = buildPreparedCliRunContext({
      provider: "claude-cli",
      model: "sonnet",
      runId: "run-live-blocked",
      sessionId: "session-live-blocked",
      sessionKey: "agent:main:blocked",
      prompt: "hello",
      backend: { liveSession: "claude-stdio" },
    });
    context.mcpDeliveryCapture = true;

    try {
      await expect(executePreparedCliRun(context)).resolves.toMatchObject({ text: "ok" });
      await waitForDiagnosticEventsDrained();
    } finally {
      stopDiagnostics();
    }

    expect(diagnosticEvents).toMatchObject([
      { type: "tool.execution.started", toolCallId: "tool-live-blocked" },
      {
        type: "tool.execution.blocked",
        toolCallId: "tool-live-blocked",
        deniedReason: "plugin-approval",
      },
    ]);
  });

  it("keeps identical parallel Claude live tool outcomes explicitly unknown", async () => {
    const diagnosticEvents: Array<Record<string, unknown>> = [];
    const stopDiagnostics = onInternalDiagnosticEvent((event) => {
      if (
        event.type.startsWith("tool.execution.") &&
        "toolCallId" in event &&
        typeof event.toolCallId === "string" &&
        event.toolCallId.startsWith("tool-live-identical-")
      ) {
        diagnosticEvents.push(event as unknown as Record<string, unknown>);
      }
    });
    let stdoutListener: ((chunk: string) => void) | undefined;
    let captureKey = "";
    const toolArgs = { action: "react", emoji: "same" };
    const stdin = {
      write: vi.fn((_data: string, cb?: (err?: Error | null) => void) => {
        stdoutListener?.(
          [
            JSON.stringify({ type: "system", subtype: "init", session_id: "live-identical" }),
            JSON.stringify({
              type: "assistant",
              session_id: "live-identical",
              message: {
                role: "assistant",
                content: [
                  {
                    type: "mcp_tool_use",
                    id: "tool-live-identical-a",
                    name: "mcp__openclaw__message",
                    input: toolArgs,
                  },
                  {
                    type: "mcp_tool_use",
                    id: "tool-live-identical-b",
                    name: "mcp__openclaw__message",
                    input: toolArgs,
                  },
                ],
              },
            }),
          ].join("\n") + "\n",
        );
        const captureHandle = markMcpLoopbackToolCallStarted({
          captureKey,
          toolName: "message",
          args: toolArgs,
        });
        if (!captureHandle) {
          throw new Error("Expected live tool capture");
        }
        recordMcpLoopbackToolCallResult({
          captureHandle,
          toolName: "message",
          args: toolArgs,
          outcome: "failed",
        });
        markMcpLoopbackToolCallFinished(captureHandle);
        stdoutListener?.(
          [
            JSON.stringify({
              type: "user",
              session_id: "live-identical",
              message: {
                role: "user",
                content: [
                  { type: "tool_result", tool_use_id: "tool-live-identical-a", content: "ok" },
                  { type: "tool_result", tool_use_id: "tool-live-identical-b", content: "ok" },
                ],
              },
            }),
            JSON.stringify({ type: "result", session_id: "live-identical", result: "ok" }),
          ].join("\n") + "\n",
        );
        cb?.();
      }),
      end: vi.fn(),
    };
    supervisorSpawnMock.mockImplementation(async (...args: unknown[]) => {
      const input = (args[0] ?? {}) as {
        env?: Record<string, string>;
        onStdout?: (chunk: string) => void;
      };
      stdoutListener = input.onStdout;
      captureKey = input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "";
      return {
        runId: "live-run-identical",
        pid: 3062,
        startedAtMs: Date.now(),
        stdin,
        wait: vi.fn(() => new Promise(() => {})),
        cancel: vi.fn(),
      };
    });
    const context = buildPreparedCliRunContext({
      provider: "claude-cli",
      model: "sonnet",
      runId: "run-live-identical",
      sessionId: "session-live-identical",
      sessionKey: "agent:main:live-identical",
      prompt: "hello",
      backend: { liveSession: "claude-stdio" },
    });
    context.mcpDeliveryCapture = true;

    try {
      await expect(executePreparedCliRun(context)).resolves.toMatchObject({ text: "ok" });
      await waitForDiagnosticEventsDrained();
    } finally {
      stopDiagnostics();
    }

    expect(diagnosticEvents).toMatchObject([
      { type: "tool.execution.started", toolCallId: "tool-live-identical-a" },
      { type: "tool.execution.started", toolCallId: "tool-live-identical-b" },
      {
        type: "tool.execution.error",
        toolCallId: "tool-live-identical-a",
        errorCode: "tool_outcome_unknown",
      },
      {
        type: "tool.execution.error",
        toolCallId: "tool-live-identical-b",
        errorCode: "tool_outcome_unknown",
      },
    ]);
  });

  it.each([
    [
      "client timeout",
      "tool_use",
      "Bash",
      Object.assign(new Error("gateway timeout"), { name: "TimeoutError" }),
      "TimeoutError",
      { terminalReason: "timed_out" },
    ],
    [
      "client cancellation",
      "tool_use",
      "Bash",
      new Error("operator cancelled"),
      "AbortError",
      { terminalReason: "cancelled" },
    ],
    [
      "server-native timeout",
      "server_tool_use",
      "web_search",
      Object.assign(new Error("gateway timeout"), { name: "TimeoutError" }),
      "TimeoutError",
      { errorCode: "tool_outcome_unknown" },
    ],
    [
      "server-native cancellation",
      "server_tool_use",
      "web_search",
      new Error("operator cancelled"),
      "AbortError",
      { errorCode: "tool_outcome_unknown" },
    ],
  ] as const)(
    "classifies active Claude live tools on %s",
    async (_, toolType, toolName, abortReason, expectedErrorName, expectedOutcome) => {
      const abortController = new AbortController();
      const diagnosticEvents: Array<Record<string, unknown>> = [];
      const stopDiagnostics = onInternalDiagnosticEvent((event) => {
        if (event.type === "tool.execution.error") {
          diagnosticEvents.push(event as unknown as Record<string, unknown>);
        }
      });
      let stdoutListener: ((chunk: string) => void) | undefined;
      const stdin = {
        write: vi.fn((_data: string, cb?: (err?: Error | null) => void) => {
          stdoutListener?.(
            [
              JSON.stringify({ type: "system", subtype: "init", session_id: "live-timeout" }),
              JSON.stringify({
                type: "assistant",
                session_id: "live-timeout",
                message: {
                  role: "assistant",
                  content: [
                    {
                      type: toolType,
                      id: "tool-live-timeout",
                      name: toolName,
                      input: { query: "status" },
                    },
                  ],
                },
              }),
            ].join("\n") + "\n",
          );
          cb?.();
        }),
        end: vi.fn(),
      };
      supervisorSpawnMock.mockImplementation(async (...args: unknown[]) => {
        const input = (args[0] ?? {}) as { onStdout?: (chunk: string) => void };
        stdoutListener = input.onStdout;
        return {
          runId: "live-run-timeout",
          pid: 3061,
          startedAtMs: Date.now(),
          stdin,
          wait: vi.fn(() => new Promise(() => {})),
          cancel: vi.fn(),
        };
      });

      try {
        const context = buildPreparedCliRunContext({
          provider: "claude-cli",
          model: "sonnet",
          runId: "run-live-timeout",
          sessionId: "session-live-timeout",
          sessionKey: "agent:main:timeout",
          backend: { liveSession: "claude-stdio" },
        });
        context.params.abortSignal = abortController.signal;
        const resultPromise = runClaudeLiveSessionTurn({
          context,
          args: context.preparedBackend.backend.args ?? [],
          env: {},
          prompt: "hello",
          useResume: false,
          noOutputTimeoutMs: 120_000,
          getProcessSupervisor: () => ({
            spawn: (params: Parameters<SupervisorSpawnFn>[0]) =>
              supervisorSpawnMock(params) as ReturnType<SupervisorSpawnFn>,
            cancel: vi.fn(),
            cancelScope: vi.fn(),
            getRecord: vi.fn(),
          }),
          onAssistantDelta: () => {},
          cleanup: async () => {},
        });

        await vi.waitFor(() => expect(stdoutListener).toBeDefined());
        abortController.abort(abortReason);
        await expectRejectsWithFields(resultPromise, { name: expectedErrorName });
        await waitForDiagnosticEventsDrained();
        expect(diagnosticEvents).toContainEqual(
          expect.objectContaining({
            toolCallId: "tool-live-timeout",
            ...expectedOutcome,
          }),
        );
        if (toolType === "server_tool_use") {
          const terminal = diagnosticEvents.find(
            (event) => event.toolCallId === "tool-live-timeout",
          );
          expect(terminal).not.toHaveProperty("terminalReason");
        }
      } finally {
        stopDiagnostics();
      }
    },
  );

  it("answers Claude live control_request can_use_tool with deny when exec policy is restrictive", async () => {
    const diagnosticEvents: Array<Record<string, unknown>> = [];
    const stopDiagnostics = onInternalDiagnosticEvent((event) => {
      if (
        event.type.startsWith("tool.execution.") &&
        "toolCallId" in event &&
        event.toolCallId === "tool-deny-1"
      ) {
        diagnosticEvents.push(event as unknown as Record<string, unknown>);
      }
    });
    let stdoutListener: ((chunk: string) => void) | undefined;
    const writes: string[] = [];
    const stdin = {
      write: vi.fn((data: string, cb?: (err?: Error | null) => void) => {
        writes.push(data);
        if (writes.length === 1) {
          stdoutListener?.(
            `${JSON.stringify({
              type: "control_request",
              request_id: "req-deny",
              request: {
                subtype: "can_use_tool",
                tool_name: "Bash",
                tool_use_id: "tool-deny-1",
                input: { command: "rm -rf /" },
              },
            })}
${JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: "live-control-deny",
})}
${JSON.stringify({
  type: "assistant",
  session_id: "live-control-deny",
  message: {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "tool-deny-1",
        name: "Bash",
        input: { command: "rm -rf /" },
      },
    ],
  },
})}
${JSON.stringify({
  type: "user",
  session_id: "live-control-deny",
  message: {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "tool-deny-1",
        content: "denied",
        is_error: true,
      },
    ],
  },
})}
${JSON.stringify({
  type: "result",
  session_id: "live-control-deny",
  result: "ok",
})}
`,
          );
        }
        cb?.();
      }),
      end: vi.fn(),
    };
    supervisorSpawnMock.mockImplementation(async (...args: unknown[]) => {
      const input = (args[0] ?? {}) as { onStdout?: (chunk: string) => void };
      stdoutListener = input.onStdout;
      return {
        runId: "live-run-deny",
        pid: 3002,
        startedAtMs: Date.now(),
        stdin,
        wait: vi.fn(() => new Promise(() => {})),
        cancel: vi.fn(),
      };
    });

    const result = await (async () => {
      try {
        const value = await executePreparedCliRun(
          buildPreparedCliRunContext({
            provider: "claude-cli",
            model: "sonnet",
            runId: "run-control-deny",
            prompt: "hello",
            backend: { liveSession: "claude-stdio" },
            config: {
              tools: { exec: { security: "allowlist", ask: "on-miss" } },
            } as PreparedCliRunContext["params"]["config"],
          }),
        );
        await waitForDiagnosticEventsDrained();
        return value;
      } finally {
        stopDiagnostics();
      }
    })();
    expect(result.text).toBe("ok");
    const controlResponse = writes.find((entry) => entry.includes('"control_response"'));
    expect(controlResponse, "control_response written to stdin").toBeDefined();
    const parsed = JSON.parse((controlResponse ?? "").trim()) as {
      type: string;
      response: {
        subtype: string;
        request_id: string;
        response: { behavior: string; message: string; decisionClassification: string };
      };
    };
    expect(parsed.response.response.behavior).toBe("deny");
    expect(parsed.response.response.decisionClassification).toBe("user_reject");
    expect(parsed.response.response.message).toContain("security=allowlist");
    expect(diagnosticEvents).toMatchObject([
      {
        type: "tool.execution.started",
        toolCallId: "tool-deny-1",
        toolName: "Bash",
        paramsSummary: { kind: "object" },
      },
      {
        type: "tool.execution.blocked",
        toolCallId: "tool-deny-1",
        toolName: "Bash",
        deniedReason: "cli_live_exec_policy",
      },
    ]);
    expect(diagnosticEvents).toHaveLength(2);
    expect(JSON.stringify(diagnosticEvents)).not.toContain("rm -rf");
    const spawnArg = supervisorSpawnMock.mock.calls.at(-1)?.[0] as { argv?: string[] };
    expect(requireArgAfter(spawnArg.argv, "--permission-mode")).toBe("default");
  });

  it("does not create exec approvals file while resolving Claude live policy", async () => {
    await withTempOpenClawHome(async (home) => {
      const approvalsPath = path.join(home, ".openclaw", "exec-approvals.json");
      let stdoutListener: ((chunk: string) => void) | undefined;
      const stdin = {
        write: vi.fn((_data: string, cb?: (err?: Error | null) => void) => {
          stdoutListener?.(
            `${JSON.stringify({
              type: "system",
              subtype: "init",
              session_id: "live-no-approvals-file",
            })}
${JSON.stringify({
  type: "result",
  session_id: "live-no-approvals-file",
  result: "ok",
})}
`,
          );
          cb?.();
        }),
        end: vi.fn(),
      };
      supervisorSpawnMock.mockImplementation(async (...args: unknown[]) => {
        const input = (args[0] ?? {}) as { onStdout?: (chunk: string) => void };
        stdoutListener = input.onStdout;
        return {
          runId: "live-run-no-approvals-file",
          pid: 3009,
          startedAtMs: Date.now(),
          stdin,
          wait: vi.fn(() => new Promise(() => {})),
          cancel: vi.fn(),
        };
      });

      const result = await executePreparedCliRun(
        buildPreparedCliRunContext({
          provider: "claude-cli",
          model: "sonnet",
          runId: "run-no-approvals-file",
          prompt: "hello",
          backend: { liveSession: "claude-stdio" },
          config: {
            tools: { exec: { security: "allowlist", ask: "on-miss" } },
          } as PreparedCliRunContext["params"]["config"],
        }),
      );

      expect(result.text).toBe("ok");
      const spawnArg = supervisorSpawnMock.mock.calls.at(-1)?.[0] as { argv?: string[] };
      expect(requireArgAfter(spawnArg.argv, "--permission-mode")).toBe("default");
      await expectPathMissing(approvalsPath);
    });
  });

  it("answers Claude live control_request can_use_tool with allow when no exec policy is configured (default deployment)", async () => {
    let stdoutListener: ((chunk: string) => void) | undefined;
    const writes: string[] = [];
    const stdin = {
      write: vi.fn((data: string, cb?: (err?: Error | null) => void) => {
        writes.push(data);
        if (writes.length === 1) {
          stdoutListener?.(
            `${JSON.stringify({
              type: "control_request",
              request_id: "req-default-allow",
              request: {
                subtype: "can_use_tool",
                tool_name: "Bash",
                tool_use_id: "tool-default-allow-1",
                input: { command: "echo hi" },
              },
            })}
${JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: "live-control-default-allow",
})}
${JSON.stringify({
  type: "result",
  session_id: "live-control-default-allow",
  result: "ok",
})}
`,
          );
        }
        cb?.();
      }),
      end: vi.fn(),
    };
    supervisorSpawnMock.mockImplementation(async (...args: unknown[]) => {
      const input = (args[0] ?? {}) as { onStdout?: (chunk: string) => void };
      stdoutListener = input.onStdout;
      return {
        runId: "live-run-default-allow",
        pid: 3003,
        startedAtMs: Date.now(),
        stdin,
        wait: vi.fn(() => new Promise(() => {})),
        cancel: vi.fn(),
      };
    });

    // No tools.exec configured at all — represents the default deployment
    // that extensions/anthropic/cli-shared.ts already launches with
    // --permission-mode bypassPermissions via normalizeClaudePermissionArgs.
    const result = await executePreparedCliRun(
      buildPreparedCliRunContext({
        provider: "claude-cli",
        model: "sonnet",
        runId: "run-control-default-allow",
        prompt: "hello",
        backend: { liveSession: "claude-stdio" },
      }),
    );
    expect(result.text).toBe("ok");
    const controlResponse = writes.find((entry) => entry.includes('"control_response"'));
    expect(controlResponse, "control_response written to stdin").toBeDefined();
    const parsed = JSON.parse((controlResponse ?? "").trim()) as {
      type: string;
      response: {
        subtype: string;
        request_id: string;
        response: { behavior: string; toolUseID?: string; updatedInput?: unknown };
      };
    };
    expect(parsed.response.response.behavior).toBe("allow");
    expect(parsed.response.response.toolUseID).toBe("tool-default-allow-1");
    expect(parsed.response.response.updatedInput).toEqual({ command: "echo hi" });
  });

  it("answers Claude live control_request can_use_tool with deny when approval defaults are restrictive", async () => {
    await withTempExecApprovalsFile(
      {
        version: 1,
        defaults: { security: "allowlist", ask: "on-miss" },
        agents: {},
      },
      async () => {
        let stdoutListener: ((chunk: string) => void) | undefined;
        const writes: string[] = [];
        const stdin = {
          write: vi.fn((data: string, cb?: (err?: Error | null) => void) => {
            writes.push(data);
            if (writes.length === 1) {
              stdoutListener?.(
                `${JSON.stringify({
                  type: "control_request",
                  request_id: "req-approval-default-deny",
                  request: {
                    subtype: "can_use_tool",
                    tool_name: "Bash",
                    tool_use_id: "tool-approval-default-deny-1",
                    input: { command: "ls" },
                  },
                })}
${JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: "live-control-approval-default-deny",
})}
${JSON.stringify({
  type: "result",
  session_id: "live-control-approval-default-deny",
  result: "ok",
})}
`,
              );
            }
            cb?.();
          }),
          end: vi.fn(),
        };
        supervisorSpawnMock.mockImplementation(async (...args: unknown[]) => {
          const input = (args[0] ?? {}) as { onStdout?: (chunk: string) => void };
          stdoutListener = input.onStdout;
          return {
            runId: "live-run-approval-default-deny",
            pid: 3005,
            startedAtMs: Date.now(),
            stdin,
            wait: vi.fn(() => new Promise(() => {})),
            cancel: vi.fn(),
          };
        });

        const result = await executePreparedCliRun(
          buildPreparedCliRunContext({
            provider: "claude-cli",
            model: "sonnet",
            runId: "run-control-approval-default-deny",
            prompt: "hello",
            backend: {
              liveSession: "claude-stdio",
              args: [
                "-p",
                "--output-format",
                "stream-json",
                "--permission-mode",
                "bypassPermissions",
              ],
            },
          }),
        );
        expect(result.text).toBe("ok");
        const controlResponse = writes.find((entry) => entry.includes('"control_response"'));
        expect(controlResponse, "control_response written to stdin").toBeDefined();
        const parsed = JSON.parse((controlResponse ?? "").trim()) as {
          response: {
            response: { behavior: string; message: string; decisionClassification: string };
          };
        };
        expect(parsed.response.response.behavior).toBe("deny");
        expect(parsed.response.response.decisionClassification).toBe("user_reject");
        expect(parsed.response.response.message).toContain("security=allowlist");
        const spawnArg = supervisorSpawnMock.mock.calls.at(-1)?.[0] as { argv?: string[] };
        expect(requireArgAfter(spawnArg.argv, "--permission-mode")).toBe("default");
      },
    );
  });

  it("answers Claude live control_request can_use_tool with deny when session exec ask is restrictive", async () => {
    let stdoutListener: ((chunk: string) => void) | undefined;
    const writes: string[] = [];
    const stdin = {
      write: vi.fn((data: string, cb?: (err?: Error | null) => void) => {
        writes.push(data);
        if (writes.length === 1) {
          stdoutListener?.(
            `${JSON.stringify({
              type: "control_request",
              request_id: "req-session-ask-deny",
              request: {
                subtype: "can_use_tool",
                tool_name: "Bash",
                tool_use_id: "tool-session-ask-deny-1",
                input: { command: "ls" },
              },
            })}
${JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: "live-control-session-ask-deny",
})}
${JSON.stringify({
  type: "result",
  session_id: "live-control-session-ask-deny",
  result: "ok",
})}
`,
          );
        }
        cb?.();
      }),
      end: vi.fn(),
    };
    supervisorSpawnMock.mockImplementation(async (...args: unknown[]) => {
      const input = (args[0] ?? {}) as { onStdout?: (chunk: string) => void };
      stdoutListener = input.onStdout;
      return {
        runId: "live-run-session-ask-deny",
        pid: 3006,
        startedAtMs: Date.now(),
        stdin,
        wait: vi.fn(() => new Promise(() => {})),
        cancel: vi.fn(),
      };
    });

    const result = await executePreparedCliRun(
      buildPreparedCliRunContext({
        provider: "claude-cli",
        model: "sonnet",
        runId: "run-control-session-ask-deny",
        prompt: "hello",
        backend: {
          liveSession: "claude-stdio",
          args: ["-p", "--output-format", "stream-json", "--permission-mode", "bypassPermissions"],
        },
        sessionEntry: { execAsk: "always" } as PreparedCliRunContext["params"]["sessionEntry"],
        config: {
          tools: { exec: { security: "full", ask: "off" } },
        } as PreparedCliRunContext["params"]["config"],
      }),
    );
    expect(result.text).toBe("ok");
    const controlResponse = writes.find((entry) => entry.includes('"control_response"'));
    expect(controlResponse, "control_response written to stdin").toBeDefined();
    const parsed = JSON.parse((controlResponse ?? "").trim()) as {
      response: {
        response: { behavior: string; message: string; decisionClassification: string };
      };
    };
    expect(parsed.response.response.behavior).toBe("deny");
    expect(parsed.response.response.decisionClassification).toBe("user_reject");
    expect(parsed.response.response.message).toContain("ask=always");
    const spawnArg = supervisorSpawnMock.mock.calls.at(-1)?.[0] as { argv?: string[] };
    expect(requireArgAfter(spawnArg.argv, "--permission-mode")).toBe("default");
  });

  it("answers Claude live control_request can_use_tool with deny when agent approvals are restrictive", async () => {
    await withTempExecApprovalsFile(
      {
        version: 1,
        agents: { reviewer: { security: "deny" } },
      },
      async () => {
        let stdoutListener: ((chunk: string) => void) | undefined;
        const writes: string[] = [];
        const stdin = {
          write: vi.fn((data: string, cb?: (err?: Error | null) => void) => {
            writes.push(data);
            if (writes.length === 1) {
              stdoutListener?.(
                `${JSON.stringify({
                  type: "control_request",
                  request_id: "req-agent-approval-deny",
                  request: {
                    subtype: "can_use_tool",
                    tool_name: "Bash",
                    tool_use_id: "tool-agent-approval-deny-1",
                    input: { command: "ls" },
                  },
                })}
${JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: "live-control-agent-approval-deny",
})}
${JSON.stringify({
  type: "result",
  session_id: "live-control-agent-approval-deny",
  result: "ok",
})}
`,
              );
            }
            cb?.();
          }),
          end: vi.fn(),
        };
        supervisorSpawnMock.mockImplementation(async (...args: unknown[]) => {
          const input = (args[0] ?? {}) as { onStdout?: (chunk: string) => void };
          stdoutListener = input.onStdout;
          return {
            runId: "live-run-agent-approval-deny",
            pid: 3007,
            startedAtMs: Date.now(),
            stdin,
            wait: vi.fn(() => new Promise(() => {})),
            cancel: vi.fn(),
          };
        });

        const result = await executePreparedCliRun(
          buildPreparedCliRunContext({
            provider: "claude-cli",
            model: "sonnet",
            runId: "run-control-agent-approval-deny",
            prompt: "hello",
            backend: {
              liveSession: "claude-stdio",
              args: [
                "-p",
                "--output-format",
                "stream-json",
                "--permission-mode",
                "bypassPermissions",
              ],
            },
            agentId: "reviewer",
            config: {
              tools: { exec: { security: "full", ask: "off" } },
            } as PreparedCliRunContext["params"]["config"],
          }),
        );
        expect(result.text).toBe("ok");
        const controlResponse = writes.find((entry) => entry.includes('"control_response"'));
        expect(controlResponse, "control_response written to stdin").toBeDefined();
        const parsed = JSON.parse((controlResponse ?? "").trim()) as {
          response: {
            response: { behavior: string; message: string; decisionClassification: string };
          };
        };
        expect(parsed.response.response.behavior).toBe("deny");
        expect(parsed.response.response.decisionClassification).toBe("user_reject");
        expect(parsed.response.response.message).toContain("security=deny");
        const spawnArg = supervisorSpawnMock.mock.calls.at(-1)?.[0] as { argv?: string[] };
        expect(requireArgAfter(spawnArg.argv, "--permission-mode")).toBe("default");
      },
    );
  });

  it("answers Claude live control_request can_use_tool with deny when session-key agent approvals are restrictive", async () => {
    await withTempExecApprovalsFile(
      {
        version: 1,
        agents: { reviewer: { security: "deny" } },
      },
      async () => {
        let stdoutListener: ((chunk: string) => void) | undefined;
        const writes: string[] = [];
        const stdin = {
          write: vi.fn((data: string, cb?: (err?: Error | null) => void) => {
            writes.push(data);
            if (writes.length === 1) {
              stdoutListener?.(
                `${JSON.stringify({
                  type: "control_request",
                  request_id: "req-session-key-approval-deny",
                  request: {
                    subtype: "can_use_tool",
                    tool_name: "Bash",
                    tool_use_id: "tool-session-key-approval-deny-1",
                    input: { command: "ls" },
                  },
                })}
${JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: "live-control-session-key-approval-deny",
})}
${JSON.stringify({
  type: "result",
  session_id: "live-control-session-key-approval-deny",
  result: "ok",
})}
`,
              );
            }
            cb?.();
          }),
          end: vi.fn(),
        };
        supervisorSpawnMock.mockImplementation(async (...args: unknown[]) => {
          const input = (args[0] ?? {}) as { onStdout?: (chunk: string) => void };
          stdoutListener = input.onStdout;
          return {
            runId: "live-run-session-key-approval-deny",
            pid: 3008,
            startedAtMs: Date.now(),
            stdin,
            wait: vi.fn(() => new Promise(() => {})),
            cancel: vi.fn(),
          };
        });

        const result = await executePreparedCliRun(
          buildPreparedCliRunContext({
            provider: "claude-cli",
            model: "sonnet",
            runId: "run-control-session-key-approval-deny",
            prompt: "hello",
            backend: {
              liveSession: "claude-stdio",
              args: [
                "-p",
                "--output-format",
                "stream-json",
                "--permission-mode",
                "bypassPermissions",
              ],
            },
            sessionKey: "agent:reviewer:main",
            config: {
              tools: { exec: { security: "full", ask: "off" } },
            } as PreparedCliRunContext["params"]["config"],
          }),
        );
        expect(result.text).toBe("ok");
        const controlResponse = writes.find((entry) => entry.includes('"control_response"'));
        expect(controlResponse, "control_response written to stdin").toBeDefined();
        const parsed = JSON.parse((controlResponse ?? "").trim()) as {
          response: {
            response: { behavior: string; message: string; decisionClassification: string };
          };
        };
        expect(parsed.response.response.behavior).toBe("deny");
        expect(parsed.response.response.decisionClassification).toBe("user_reject");
        expect(parsed.response.response.message).toContain("security=deny");
        const spawnArg = supervisorSpawnMock.mock.calls.at(-1)?.[0] as { argv?: string[] };
        expect(requireArgAfter(spawnArg.argv, "--permission-mode")).toBe("default");
      },
    );
  });

  it("answers Claude live control_request can_use_tool with allow when OpenClaw exec is YOLO despite raw --permission-mode default", async () => {
    let stdoutListener: ((chunk: string) => void) | undefined;
    const writes: string[] = [];
    const stdin = {
      write: vi.fn((data: string, cb?: (err?: Error | null) => void) => {
        writes.push(data);
        if (writes.length === 1) {
          stdoutListener?.(
            `${JSON.stringify({
              type: "control_request",
              request_id: "req-permmode-allow",
              request: {
                subtype: "can_use_tool",
                tool_name: "Bash",
                tool_use_id: "tool-permmode-allow-1",
                input: { command: "ls" },
              },
            })}
${JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: "live-control-permmode-allow",
})}
${JSON.stringify({
  type: "result",
  session_id: "live-control-permmode-allow",
  result: "ok",
})}
`,
          );
        }
        cb?.();
      }),
      end: vi.fn(),
    };
    supervisorSpawnMock.mockImplementation(async (...args: unknown[]) => {
      const input = (args[0] ?? {}) as { onStdout?: (chunk: string) => void };
      stdoutListener = input.onStdout;
      return {
        runId: "live-run-permmode-allow",
        pid: 3004,
        startedAtMs: Date.now(),
        stdin,
        wait: vi.fn(() => new Promise(() => {})),
        cancel: vi.fn(),
      };
    });

    // tools.exec resolves to full/off (would normally allow native Bash),
    // and OpenClaw policy is authoritative over raw Claude permission-mode
    // args. The live launch is normalized back to bypassPermissions.
    const result = await executePreparedCliRun(
      buildPreparedCliRunContext({
        provider: "claude-cli",
        model: "sonnet",
        runId: "run-control-permmode-allow",
        prompt: "hello",
        backend: {
          liveSession: "claude-stdio",
          args: ["-p", "--output-format", "stream-json", "--permission-mode", "default"],
        },
        config: {
          tools: { exec: { security: "full", ask: "off" } },
        } as PreparedCliRunContext["params"]["config"],
      }),
    );
    expect(result.text).toBe("ok");
    const controlResponse = writes.find((entry) => entry.includes('"control_response"'));
    expect(controlResponse, "control_response written to stdin").toBeDefined();
    const parsed = JSON.parse((controlResponse ?? "").trim()) as {
      type: string;
      response: {
        subtype: string;
        request_id: string;
        response: { behavior: string; toolUseID?: string };
      };
    };
    expect(parsed.response.response.behavior).toBe("allow");
    expect(parsed.response.response.toolUseID).toBe("tool-permmode-allow-1");
    const spawnArg = supervisorSpawnMock.mock.calls.at(-1)?.[0] as { argv?: string[] };
    expect(requireArgAfter(spawnArg.argv, "--permission-mode")).toBe("bypassPermissions");
  });

  it("uses a fresh Claude live process and capture key for every captured turn", async () => {
    const logWarnSpy = vi.spyOn(cliBackendLog, "warn").mockImplementation(() => undefined);
    const cancels: Array<ReturnType<typeof vi.fn>> = [];
    const captureKeys: string[] = [];
    const turnResults = ["first-ok", "resume-ok", "env-ok", "fresh-ok"];
    let turnIndex = 0;
    supervisorSpawnMock.mockImplementation(async (...args: unknown[]) => {
      const spawnIndex = supervisorSpawnMock.mock.calls.length;
      const input = (args[0] ?? {}) as { onStdout?: (chunk: string) => void };
      const cancel = vi.fn();
      cancels.push(cancel);
      let resolveExit: (() => void) | undefined;
      const exited = new Promise<{
        reason: "manual-cancel";
        exitCode: null;
        exitSignal: null;
        durationMs: number;
        stdout: string;
        stderr: string;
        timedOut: false;
        noOutputTimedOut: false;
      }>((resolve) => {
        resolveExit = () =>
          resolve({
            reason: "manual-cancel",
            exitCode: null,
            exitSignal: null,
            durationMs: 1,
            stdout: "",
            stderr: "",
            timedOut: false,
            noOutputTimedOut: false,
          });
      });
      cancel.mockImplementation(() => resolveExit?.());
      return {
        runId: `live-run-${spawnIndex}`,
        pid: 2345 + spawnIndex,
        startedAtMs: Date.now(),
        stdin: {
          write: vi.fn((dataValue: string, cb?: (err?: Error | null) => void) => {
            const result = turnResults[turnIndex] ?? "ok";
            turnIndex += 1;
            input.onStdout?.(
              [
                JSON.stringify({ type: "system", subtype: "init", session_id: "live-session" }),
                JSON.stringify({
                  type: "result",
                  session_id: "live-session",
                  result,
                }),
              ].join("\n") + "\n",
            );
            cb?.();
          }),
          end: vi.fn(),
        },
        wait: vi.fn(() => exited),
        cancel,
      };
    });
    const runTurn = async (runId: string, args: string[], env: Record<string, string>) => {
      const context = buildPreparedCliRunContext({
        provider: "claude-cli",
        model: "sonnet",
        runId,
        backend: {
          liveSession: "claude-stdio",
          resumeArgs: ["-p", "--output-format", "stream-json", "--resume", "{sessionId}"],
        },
        mcpDeliveryCapture: true,
      });
      const result = await runClaudeLiveSessionTurn({
        context,
        args,
        env,
        prompt: "hi",
        useResume: args.some((entry) => entry.startsWith("--resume")),
        noOutputTimeoutMs: 1_000,
        getProcessSupervisor: () => ({
          spawn: (params: Parameters<SupervisorSpawnFn>[0]) =>
            supervisorSpawnMock(params) as ReturnType<SupervisorSpawnFn>,
          cancel: vi.fn(),
          cancelScope: vi.fn(),
          getRecord: vi.fn(),
        }),
        onAssistantDelta: () => {},
        onMcpCaptureReady: (captureKey) => captureKeys.push(captureKey),
        cleanup: async () => {
          if (runId === "run-live-resume") {
            throw new Error("captured cleanup failed");
          }
        },
      });
      return result.output.text;
    };
    const freshArgs = ["-p", "--output-format", "stream-json"];
    const resumeArgs = ["-p", "--output-format", "stream-json", "--resume", "live-session"];

    await expect(
      runTurn("run-live-fresh", freshArgs, { ANTHROPIC_BASE_URL: "https://one.example" }),
    ).resolves.toBe("first-ok");
    await expect(
      runTurn("run-live-resume", resumeArgs, { ANTHROPIC_BASE_URL: "https://one.example" }),
    ).resolves.toBe("resume-ok");
    expect(supervisorSpawnMock).toHaveBeenCalledTimes(2);
    expect(cancels[0]).toHaveBeenCalledWith("manual-cancel");
    expect(cancels[1]).toHaveBeenCalledWith("manual-cancel");
    expect(captureKeys[1]).not.toBe(captureKeys[0]);

    await expect(
      runTurn("run-live-env-change", resumeArgs, { ANTHROPIC_BASE_URL: "https://two.example" }),
    ).resolves.toBe("env-ok");
    expect(supervisorSpawnMock).toHaveBeenCalledTimes(3);
    expect(cancels[2]).toHaveBeenCalledWith("manual-cancel");
    expect(captureKeys[2]).not.toBe(captureKeys[1]);

    await expect(
      runTurn("run-live-fresh-retry", freshArgs, {
        ANTHROPIC_BASE_URL: "https://two.example",
      }),
    ).resolves.toBe("fresh-ok");

    expect(supervisorSpawnMock).toHaveBeenCalledTimes(4);
    expect(cancels[3]).toHaveBeenCalledWith("manual-cancel");
    expect(captureKeys[3]).not.toBe(captureKeys[2]);
    expect(logWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Claude live session cleanup failed: captured cleanup failed"),
    );
  });

  it("ignores non-JSON stdout lines from Claude live sessions", async () => {
    let stdoutListener: ((chunk: string) => void) | undefined;
    const stdin = {
      write: vi.fn((dataValue: string, cb?: (err?: Error | null) => void) => {
        stdoutListener?.(
          [
            "Claude CLI warning",
            JSON.stringify({ type: "system", subtype: "init", session_id: "live-mixed" }),
            JSON.stringify({
              type: "result",
              session_id: "live-mixed",
              result: "mixed-ok",
            }),
          ].join("\n") + "\n",
        );
        cb?.();
      }),
      end: vi.fn(),
    };
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = (args[0] ?? {}) as { onStdout?: (chunk: string) => void };
      stdoutListener = input.onStdout;
      return {
        runId: "live-run",
        pid: 2345,
        startedAtMs: Date.now(),
        stdin,
        wait: vi.fn(() => new Promise(() => {})),
        cancel: vi.fn(),
      };
    });

    const result = await executePreparedCliRun(
      buildPreparedCliRunContext({
        provider: "claude-cli",
        model: "sonnet",
        runId: "run-live-mixed",
        backend: {
          liveSession: "claude-stdio",
        },
      }),
    );

    expect(result.text).toBe("mixed-ok");
  });

  it("fails Claude live turns on is_error results", async () => {
    let stdoutListener: ((chunk: string) => void) | undefined;
    const stdin = {
      write: vi.fn((dataValue: string, cb?: (err?: Error | null) => void) => {
        stdoutListener?.(
          [
            JSON.stringify({ type: "system", subtype: "init", session_id: "live-error" }),
            JSON.stringify({
              type: "result",
              session_id: "live-error",
              is_error: true,
              result: "Credit balance is too low",
            }),
          ].join("\n") + "\n",
        );
        cb?.();
      }),
      end: vi.fn(),
    };
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = (args[0] ?? {}) as { onStdout?: (chunk: string) => void };
      stdoutListener = input.onStdout;
      return {
        runId: "live-run",
        pid: 2345,
        startedAtMs: Date.now(),
        stdin,
        wait: vi.fn(() => new Promise(() => {})),
        cancel: vi.fn(),
      };
    });

    await expectRejectsWithFields(
      executePreparedCliRun(
        buildPreparedCliRunContext({
          provider: "claude-cli",
          model: "sonnet",
          runId: "run-live-error",
          backend: {
            liveSession: "claude-stdio",
          },
        }),
      ),
      {
        name: "FailoverError",
        message: "Credit balance is too low",
      },
    );
  });

  it("marks Claude live stderr context overflows as retryable", async () => {
    let stdoutListener: ((chunk: string) => void) | undefined;
    let resolveExit: ((exit: RunExit) => void) | undefined;
    const exited = new Promise<RunExit>((resolve) => {
      resolveExit = resolve;
    });
    const stdin = {
      write: vi.fn((dataValue: string, cb?: (err?: Error | null) => void) => {
        stdoutListener?.(
          JSON.stringify({ type: "system", subtype: "init", session_id: "live-overflow" }) + "\n",
        );
        cb?.();
        resolveExit?.({
          reason: "exit",
          exitCode: 1,
          exitSignal: null,
          durationMs: 1,
          stdout: "",
          stderr: "Prompt is too long",
          timedOut: false,
          noOutputTimedOut: false,
        });
      }),
      end: vi.fn(),
    };
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = (args[0] ?? {}) as { onStdout?: (chunk: string) => void };
      stdoutListener = input.onStdout;
      return {
        runId: "live-overflow-run",
        pid: 2345,
        startedAtMs: Date.now(),
        stdin,
        wait: vi.fn(() => exited),
        cancel: vi.fn(),
      };
    });

    await expectRejectsWithFields(
      executePreparedCliRun(
        buildPreparedCliRunContext({
          provider: "claude-cli",
          model: "sonnet",
          runId: "run-live-overflow",
          backend: {
            liveSession: "claude-stdio",
          },
        }),
      ),
      {
        name: "FailoverError",
        reason: "context_overflow",
        code: "cli_context_overflow",
        status: 413,
      },
    );
  });

  it("marks quiet Claude live exit-zero turns as retryable empty responses", async () => {
    let resolveExit: ((exit: RunExit) => void) | undefined;
    const exited = new Promise<RunExit>((resolve) => {
      resolveExit = resolve;
    });
    const stdin = {
      write: vi.fn((_dataValue: string, cb?: (err?: Error | null) => void) => {
        cb?.();
        resolveExit?.({
          reason: "exit",
          exitCode: 0,
          exitSignal: null,
          durationMs: 1,
          stdout: "",
          stderr: "",
          timedOut: false,
          noOutputTimedOut: false,
        });
      }),
      end: vi.fn(),
    };
    supervisorSpawnMock.mockImplementationOnce(async () => ({
      runId: "live-empty-run",
      pid: 2345,
      startedAtMs: Date.now(),
      stdin,
      wait: vi.fn(() => exited),
      cancel: vi.fn(),
    }));

    await expectRejectsWithFields(
      executePreparedCliRun(
        buildPreparedCliRunContext({
          provider: "claude-cli",
          model: "sonnet",
          runId: "run-live-empty",
          backend: {
            liveSession: "claude-stdio",
          },
        }),
      ),
      {
        name: "FailoverError",
        reason: "empty_response",
        code: "cli_unknown_empty_failure",
      },
    );
  });

  it("preserves Claude live stderr classification on exit-zero failures", async () => {
    let resolveExit: ((exit: RunExit) => void) | undefined;
    const exited = new Promise<RunExit>((resolve) => {
      resolveExit = resolve;
    });
    const stdin = {
      write: vi.fn((_dataValue: string, cb?: (err?: Error | null) => void) => {
        cb?.();
        resolveExit?.({
          reason: "exit",
          exitCode: 0,
          exitSignal: null,
          durationMs: 1,
          stdout: "",
          stderr: "Prompt is too long",
          timedOut: false,
          noOutputTimedOut: false,
        });
      }),
      end: vi.fn(),
    };
    supervisorSpawnMock.mockImplementationOnce(async () => ({
      runId: "live-exit-zero-overflow-run",
      pid: 2345,
      startedAtMs: Date.now(),
      stdin,
      wait: vi.fn(() => exited),
      cancel: vi.fn(),
    }));

    await expectRejectsWithFields(
      executePreparedCliRun(
        buildPreparedCliRunContext({
          provider: "claude-cli",
          model: "sonnet",
          runId: "run-live-exit-zero-overflow",
          backend: {
            liveSession: "claude-stdio",
          },
        }),
      ),
      {
        name: "FailoverError",
        reason: "context_overflow",
        code: "cli_context_overflow",
      },
    );
  });

  it("fails when Claude exits before a live turn starts", async () => {
    supervisorSpawnMock.mockImplementationOnce(async () => ({
      runId: "live-run",
      pid: 2345,
      startedAtMs: Date.now(),
      stdin: {
        write: vi.fn(),
        end: vi.fn(),
      },
      wait: vi.fn(async () => ({
        reason: "exit",
        exitCode: 1,
        exitSignal: null,
        durationMs: 1,
        stdout: "",
        stderr: "startup failed",
        timedOut: false,
        noOutputTimedOut: false,
      })),
      cancel: vi.fn(),
    }));

    await expect(
      executePreparedCliRun(
        buildPreparedCliRunContext({
          provider: "claude-cli",
          model: "sonnet",
          runId: "run-live-startup-exit",
          backend: {
            liveSession: "claude-stdio",
          },
        }),
      ),
    ).rejects.toThrow("Claude CLI live session closed before handling the turn");
  });

  it("restarts the Claude live process after request abort", async () => {
    const abortController = new AbortController();
    let stdoutListener: ((chunk: string) => void) | undefined;
    const cancels: Array<ReturnType<typeof vi.fn>> = [];
    supervisorSpawnMock.mockImplementation(async (...args: unknown[]) => {
      const input = (args[0] ?? {}) as { onStdout?: (chunk: string) => void };
      stdoutListener = input.onStdout;
      const spawnIndex = supervisorSpawnMock.mock.calls.length;
      const cancel = vi.fn();
      cancels.push(cancel);
      const stdin = {
        write: vi.fn((dataValue: string, cb?: (err?: Error | null) => void) => {
          if (spawnIndex === 2) {
            stdoutListener?.(
              [
                JSON.stringify({ type: "system", subtype: "init", session_id: "live-abort-2" }),
                JSON.stringify({
                  type: "result",
                  session_id: "live-abort-2",
                  result: "second-ok",
                }),
              ].join("\n") + "\n",
            );
          }
          cb?.();
        }),
        end: vi.fn(),
      };
      return {
        runId: `live-run-${spawnIndex}`,
        pid: 2345 + spawnIndex,
        startedAtMs: Date.now(),
        stdin,
        wait: vi.fn(
          () =>
            new Promise((resolve) => {
              if (spawnIndex === 1) {
                cancel.mockImplementationOnce(() => {
                  resolve({
                    reason: "manual-cancel",
                    exitCode: null,
                    exitSignal: null,
                    durationMs: 50,
                    stdout: "",
                    stderr: "",
                    timedOut: false,
                    noOutputTimedOut: false,
                  });
                });
              }
            }),
        ),
        cancel,
      };
    });

    const firstContext = buildPreparedCliRunContext({
      provider: "claude-cli",
      model: "sonnet",
      runId: "run-live-abort-1",
      backend: {
        liveSession: "claude-stdio",
      },
    });
    firstContext.params.abortSignal = abortController.signal;
    const first = executePreparedCliRun(firstContext);

    await vi.waitFor(() => {
      expect(supervisorSpawnMock).toHaveBeenCalledTimes(1);
    });
    abortController.abort();

    await expectRejectsWithFields(first, { name: "AbortError" });
    expect(cancels[0]).toHaveBeenCalledWith("manual-cancel");
    stdoutListener?.(
      [
        JSON.stringify({ type: "system", subtype: "init", session_id: "live-abort" }),
        JSON.stringify({
          type: "result",
          session_id: "live-abort",
          result: "discarded",
        }),
      ].join("\n") + "\n",
    );

    const second = await executePreparedCliRun(
      buildPreparedCliRunContext({
        provider: "claude-cli",
        model: "sonnet",
        runId: "run-live-abort-2",
        backend: {
          liveSession: "claude-stdio",
        },
      }),
    );

    expect(second.text).toBe("second-ok");
    expect(supervisorSpawnMock).toHaveBeenCalledTimes(2);
  });

  it("fails Claude live turns without unhandled rejection when stdin write is stuck", async () => {
    vi.useFakeTimers();
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);
    const cancel = vi.fn();
    let pendingWriteCallback: ((err?: Error | null) => void) | undefined;
    const stdin = {
      write: vi.fn((dataValue: string, cb?: (err?: Error | null) => void) => {
        pendingWriteCallback = cb;
      }),
      end: vi.fn(),
    };
    supervisorSpawnMock.mockImplementationOnce(async () => ({
      runId: "live-run-stuck-stdin",
      pid: 2345,
      startedAtMs: Date.now(),
      stdin,
      wait: vi.fn(() => new Promise(() => {})),
      cancel: vi.fn((reason: string) => {
        cancel(reason);
        pendingWriteCallback?.(new Error("stdin closed"));
      }),
    }));

    try {
      const context = buildPreparedCliRunContext({
        provider: "claude-cli",
        model: "sonnet",
        runId: "run-live-stuck-stdin",
        timeoutMs: 10_000,
        backend: {
          liveSession: "claude-stdio",
        },
      });
      const run = runClaudeLiveSessionTurn({
        context,
        args: context.preparedBackend.backend.args ?? [],
        env: {},
        prompt: "stuck write",
        useResume: false,
        noOutputTimeoutMs: 1_000,
        getProcessSupervisor: () => ({
          spawn: (params: Parameters<SupervisorSpawnFn>[0]) =>
            supervisorSpawnMock(params) as ReturnType<SupervisorSpawnFn>,
          cancel: vi.fn(),
          cancelScope: vi.fn(),
          getRecord: vi.fn(),
        }),
        onAssistantDelta: () => {},
        cleanup: async () => {},
      });
      const runExpectation = expectRejectsWithFields(run, {
        name: "FailoverError",
        message: "CLI produced no output for 1s and was terminated.",
      });

      await vi.advanceTimersByTimeAsync(1_000);

      await runExpectation;
      await Promise.resolve();
      expect(unhandledRejections).toEqual([]);
      expect(cancel).toHaveBeenCalledWith("manual-cancel");
      expect(stdin.write).toHaveBeenCalledOnce();
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  it("restarts Claude live sessions when selected skills change", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-live-skills-"));
    const weatherDir = path.join(workspaceDir, "skills", "weather");
    const gitDir = path.join(workspaceDir, "skills", "git");
    await fs.mkdir(weatherDir, { recursive: true });
    await fs.mkdir(gitDir, { recursive: true });
    await fs.writeFile(path.join(weatherDir, "SKILL.md"), "weather instructions\n", "utf-8");
    await fs.writeFile(path.join(gitDir, "SKILL.md"), "git instructions\n", "utf-8");

    const cancels: Array<ReturnType<typeof vi.fn>> = [];
    supervisorSpawnMock.mockImplementation(async (...args: unknown[]) => {
      const spawnIndex = supervisorSpawnMock.mock.calls.length;
      const input = (args[0] ?? {}) as { onStdout?: (chunk: string) => void };
      const cancel = vi.fn();
      cancels.push(cancel);
      const stdin = {
        write: vi.fn((dataValue: string, cb?: (err?: Error | null) => void) => {
          const text = spawnIndex === 1 ? "weather-ok" : "git-ok";
          input.onStdout?.(
            [
              JSON.stringify({ type: "system", subtype: "init", session_id: `live-${spawnIndex}` }),
              JSON.stringify({
                type: "result",
                session_id: `live-${spawnIndex}`,
                result: text,
              }),
            ].join("\n") + "\n",
          );
          cb?.();
        }),
        end: vi.fn(),
      };
      return {
        runId: `live-run-${spawnIndex}`,
        pid: 2345 + spawnIndex,
        startedAtMs: Date.now(),
        stdin,
        wait: vi.fn(() => new Promise(() => {})),
        cancel,
      };
    });

    try {
      const first = await executePreparedCliRun(
        buildPreparedCliRunContext({
          provider: "claude-cli",
          model: "sonnet",
          runId: "run-live-skills-1",
          prompt: "first",
          workspaceDir,
          backend: {
            liveSession: "claude-stdio",
          },
          skillsSnapshot: {
            prompt: "weather",
            skills: [{ name: "weather" }],
            resolvedSkills: [
              {
                name: "weather",
                description: "Weather instructions.",
                filePath: path.join(weatherDir, "SKILL.md"),
                baseDir: weatherDir,
                source: "test",
                sourceInfo: {
                  path: weatherDir,
                  source: "test",
                  scope: "project",
                  origin: "top-level",
                  baseDir: weatherDir,
                },
                disableModelInvocation: false,
              },
            ],
          },
        }),
      );
      const second = await executePreparedCliRun(
        buildPreparedCliRunContext({
          provider: "claude-cli",
          model: "sonnet",
          runId: "run-live-skills-2",
          prompt: "second",
          workspaceDir,
          backend: {
            liveSession: "claude-stdio",
          },
          skillsSnapshot: {
            prompt: "git",
            skills: [{ name: "git" }],
            resolvedSkills: [
              {
                name: "git",
                description: "Git instructions.",
                filePath: path.join(gitDir, "SKILL.md"),
                baseDir: gitDir,
                source: "test",
                sourceInfo: {
                  path: gitDir,
                  source: "test",
                  scope: "project",
                  origin: "top-level",
                  baseDir: gitDir,
                },
                disableModelInvocation: false,
              },
            ],
          },
        }),
      );

      expect(first.text).toBe("weather-ok");
      expect(second.text).toBe("git-ok");
      expect(supervisorSpawnMock).toHaveBeenCalledTimes(2);
      expect(cancels[0]).toHaveBeenCalledWith("manual-cancel");
      expect(cancels[1]).not.toHaveBeenCalled();
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("closes idle Claude live sessions after ten minutes", async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    let stdoutListener: ((chunk: string) => void) | undefined;
    const cancel = vi.fn();
    const stdin = {
      write: vi.fn((data: string, cb?: (err?: Error | null) => void) => {
        writes.push(data);
        stdoutListener?.(
          [
            JSON.stringify({ type: "system", subtype: "init", session_id: "live-session-idle" }),
            JSON.stringify({
              type: "result",
              session_id: "live-session-idle",
              result: "idle-ok",
            }),
          ].join("\n") + "\n",
        );
        cb?.();
      }),
      end: vi.fn(),
    };
    supervisorSpawnMock.mockImplementation(async (...args: unknown[]) => {
      const input = (args[0] ?? {}) as { onStdout?: (chunk: string) => void };
      stdoutListener = input.onStdout;
      return {
        runId: "live-run",
        pid: 2345,
        startedAtMs: Date.now(),
        stdin,
        wait: vi.fn(() => new Promise(() => {})),
        cancel,
      };
    });

    try {
      const result = await executePreparedCliRun(
        buildPreparedCliRunContext({
          provider: "claude-cli",
          model: "sonnet",
          runId: "run-live-idle",
          prompt: "idle",
          backend: {
            liveSession: "claude-stdio",
          },
        }),
      );

      expect(result.text).toBe("idle-ok");
      expect(cancel).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(10 * 60 * 1_000 - 1);
      expect(cancel).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(cancel).toHaveBeenCalledWith("manual-cancel");
      expect(
        writes.map(
          (entry) => (JSON.parse(entry) as { message: { content: string } }).message.content,
        ),
      ).toEqual(["idle"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not surface stale stderr after a later Claude live exit", async () => {
    let stdoutListener: ((chunk: string) => void) | undefined;
    let stderrListener: ((chunk: string) => void) | undefined;
    let resolveExit:
      | ((value: {
          reason: "exit";
          exitCode: number;
          exitSignal: null;
          durationMs: number;
          stdout: string;
          stderr: string;
          timedOut: false;
          noOutputTimedOut: false;
        }) => void)
      | undefined;
    const wait = new Promise<{
      reason: "exit";
      exitCode: number;
      exitSignal: null;
      durationMs: number;
      stdout: string;
      stderr: string;
      timedOut: false;
      noOutputTimedOut: false;
    }>((resolve) => {
      resolveExit = resolve;
    });
    let writeCount = 0;
    const stdin = {
      write: vi.fn((dataValue: string, cb?: (err?: Error | null) => void) => {
        writeCount += 1;
        if (writeCount === 1) {
          stderrListener?.("stale stderr from first turn");
          stdoutListener?.(
            [
              JSON.stringify({ type: "system", subtype: "init", session_id: "live-stderr" }),
              JSON.stringify({
                type: "result",
                session_id: "live-stderr",
                result: "first-ok",
              }),
            ].join("\n") + "\n",
          );
          cb?.();
          return;
        }
        cb?.();
        if (!resolveExit) {
          throw new Error("Expected Claude live exit resolver to be initialized");
        }
        resolveExit({
          reason: "exit",
          exitCode: 1,
          exitSignal: null,
          durationMs: 50,
          stdout: "",
          stderr: "",
          timedOut: false,
          noOutputTimedOut: false,
        });
      }),
      end: vi.fn(),
    };
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = (args[0] ?? {}) as {
        onStdout?: (chunk: string) => void;
        onStderr?: (chunk: string) => void;
      };
      stdoutListener = input.onStdout;
      stderrListener = input.onStderr;
      return {
        runId: "live-run",
        pid: 2345,
        startedAtMs: Date.now(),
        stdin,
        wait: vi.fn(() => wait),
        cancel: vi.fn(),
      };
    });

    const first = await executePreparedCliRun(
      buildPreparedCliRunContext({
        provider: "claude-cli",
        model: "sonnet",
        runId: "run-live-stderr-1",
        prompt: "first",
        backend: {
          liveSession: "claude-stdio",
        },
      }),
    );
    const second = executePreparedCliRun(
      buildPreparedCliRunContext({
        provider: "claude-cli",
        model: "sonnet",
        runId: "run-live-stderr-2",
        prompt: "second",
        backend: {
          liveSession: "claude-stdio",
        },
      }),
    );

    expect(first.text).toBe("first-ok");
    await expectRejectsWithFields(second, {
      name: "FailoverError",
      message: "Claude CLI failed.",
    });
  });

  it("surfaces nested Claude stream-json API errors instead of raw event output", async () => {
    const { message, jsonl } = createClaudeApiErrorFixture();

    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 1,
        exitSignal: null,
        durationMs: 50,
        stdout: jsonl,
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    const run = executePreparedCliRun(
      buildPreparedCliRunContext({
        provider: "claude-cli",
        model: "sonnet",
        runId: "run-claude-api-error",
      }),
    );

    await expectRejectsWithFields(run, {
      name: "FailoverError",
      message,
      reason: "billing",
      status: 402,
    });
  });

  it("sanitizes dangerous backend env overrides before spawn", async () => {
    mockSuccessfulCliRun();
    await executePreparedCliRun(
      buildPreparedCliRunContext({
        provider: "codex-cli",
        model: "gpt-5.4",
        runId: "run-env-sanitized",
        backend: {
          env: {
            NODE_OPTIONS: "--require ./malicious.js",
            LD_PRELOAD: "/tmp/pwn.so",
            PATH: "/tmp/evil",
            HOME: "/tmp/evil-home",
            SAFE_KEY: "ok",
          },
        },
      }),
      "thread-123",
    );

    const input = mockCallArg(supervisorSpawnMock) as {
      env?: Record<string, string | undefined>;
    };
    expect(input.env?.SAFE_KEY).toBe("ok");
    expect(input.env?.PATH).toBe(process.env.PATH);
    expect(input.env?.HOME).toBe(process.env.HOME);
    expect(input.env?.NODE_OPTIONS).toBeUndefined();
    expect(input.env?.LD_PRELOAD).toBeUndefined();
  });

  it("applies clearEnv after sanitizing backend env overrides", async () => {
    process.env.SAFE_CLEAR = "from-base";
    mockSuccessfulCliRun();
    await executePreparedCliRun(
      buildPreparedCliRunContext({
        provider: "codex-cli",
        model: "gpt-5.4",
        runId: "run-clear-env",
        backend: {
          env: {
            SAFE_KEEP: "keep-me",
          },
          clearEnv: ["SAFE_CLEAR"],
        },
      }),
      "thread-123",
    );

    const input = mockCallArg(supervisorSpawnMock) as {
      env?: Record<string, string | undefined>;
    };
    expect(input.env?.SAFE_KEEP).toBe("keep-me");
    expect(input.env?.SAFE_CLEAR).toBeUndefined();
  });

  it("can preserve selected clearEnv keys for live CLI backend probes", async () => {
    try {
      process.env.OPENCLAW_LIVE_CLI_BACKEND_PRESERVE_ENV = '["SAFE_CLEAR"]';
      process.env.SAFE_CLEAR = "from-base";
      mockSuccessfulCliRun();
      await executePreparedCliRun(
        buildPreparedCliRunContext({
          provider: "codex-cli",
          model: "gpt-5.4",
          runId: "run-clear-env-preserve",
          backend: {
            clearEnv: ["SAFE_CLEAR", "SAFE_DROP"],
          },
        }),
        "thread-123",
      );

      const input = mockCallArg(supervisorSpawnMock) as {
        env?: Record<string, string | undefined>;
      };
      expect(input.env?.SAFE_CLEAR).toBe("from-base");
      expect(input.env?.SAFE_DROP).toBeUndefined();
    } finally {
      delete process.env.OPENCLAW_LIVE_CLI_BACKEND_PRESERVE_ENV;
      delete process.env.SAFE_CLEAR;
    }
  });

  it("keeps explicit backend env overrides even when clearEnv drops inherited values", async () => {
    process.env.SAFE_OVERRIDE = "from-base";
    mockSuccessfulCliRun();
    await executePreparedCliRun(
      buildPreparedCliRunContext({
        provider: "codex-cli",
        model: "gpt-5.4",
        runId: "run-clear-env-override",
        backend: {
          env: {
            SAFE_OVERRIDE: "from-override",
          },
          clearEnv: ["SAFE_OVERRIDE"],
        },
      }),
      "thread-123",
    );

    const input = mockCallArg(supervisorSpawnMock) as {
      env?: Record<string, string | undefined>;
    };
    expect(input.env?.SAFE_OVERRIDE).toBe("from-override");
  });

  it("clears claude-cli provider-routing, auth, telemetry, and host-managed env", async () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://proxy.example.com/v1");
    vi.stubEnv("ANTHROPIC_API_TOKEN", "env-api-token");
    vi.stubEnv("ANTHROPIC_CUSTOM_HEADERS", "x-test-header: env");
    vi.stubEnv("ANTHROPIC_OAUTH_TOKEN", "env-oauth-token");
    vi.stubEnv("CLAUDE_CODE_USE_BEDROCK", "1");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "env-auth-token");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "env-oauth-token");
    vi.stubEnv("CLAUDE_CODE_REMOTE", "1");
    vi.stubEnv("ANTHROPIC_UNIX_SOCKET", "/tmp/anthropic.sock");
    vi.stubEnv("OTEL_LOGS_EXPORTER", "none");
    vi.stubEnv("OTEL_METRICS_EXPORTER", "none");
    vi.stubEnv("OTEL_TRACES_EXPORTER", "none");
    vi.stubEnv("OTEL_EXPORTER_OTLP_PROTOCOL", "none");
    vi.stubEnv("OTEL_SDK_DISABLED", "true");
    vi.stubEnv("CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST", "1");
    mockSuccessfulClaudeJsonlRun();

    await executePreparedCliRun(
      buildPreparedCliRunContext({
        provider: "claude-cli",
        model: "claude-sonnet-4-6",
        runId: "run-claude-env-hardened",
        backend: {
          env: {
            SAFE_KEEP: "ok",
            ANTHROPIC_BASE_URL: "https://override.example.com/v1",
            CLAUDE_CODE_OAUTH_TOKEN: "override-oauth-token",
            CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
          },
          clearEnv: [
            "ANTHROPIC_BASE_URL",
            "ANTHROPIC_API_TOKEN",
            "ANTHROPIC_CUSTOM_HEADERS",
            "ANTHROPIC_OAUTH_TOKEN",
            "CLAUDE_CODE_USE_BEDROCK",
            "ANTHROPIC_AUTH_TOKEN",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "CLAUDE_CODE_REMOTE",
            "ANTHROPIC_UNIX_SOCKET",
            "OTEL_LOGS_EXPORTER",
            "OTEL_METRICS_EXPORTER",
            "OTEL_TRACES_EXPORTER",
            "OTEL_EXPORTER_OTLP_PROTOCOL",
            "OTEL_SDK_DISABLED",
          ],
        },
      }),
    );

    const input = mockCallArg(supervisorSpawnMock) as {
      env?: Record<string, string | undefined>;
    };
    expect(input.env?.SAFE_KEEP).toBe("ok");
    expect(input.env?.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBeUndefined();
    expect(input.env?.ANTHROPIC_BASE_URL).toBe("https://override.example.com/v1");
    expect(input.env?.ANTHROPIC_API_TOKEN).toBeUndefined();
    expect(input.env?.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
    expect(input.env?.ANTHROPIC_OAUTH_TOKEN).toBeUndefined();
    expect(input.env?.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(input.env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(input.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("override-oauth-token");
    expect(input.env?.CLAUDE_CODE_REMOTE).toBeUndefined();
    expect(input.env?.ANTHROPIC_UNIX_SOCKET).toBeUndefined();
    expect(input.env?.OTEL_LOGS_EXPORTER).toBeUndefined();
    expect(input.env?.OTEL_METRICS_EXPORTER).toBeUndefined();
    expect(input.env?.OTEL_TRACES_EXPORTER).toBeUndefined();
    expect(input.env?.OTEL_EXPORTER_OTLP_PROTOCOL).toBeUndefined();
    expect(input.env?.OTEL_SDK_DISABLED).toBeUndefined();
  });

  it("formats CLI auth env diagnostics as key names without secret values", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-host");
    vi.stubEnv("ANTHROPIC_API_TOKEN", "token-host");
    vi.stubEnv("GEMINI_CLI_SYSTEM_SETTINGS_PATH", "/tmp/host-gemini-settings.json");
    vi.stubEnv("OPENAI_API_KEY", "sk-openai-host");

    const log = buildCliEnvAuthLog({
      ANTHROPIC_API_TOKEN: "token-child",
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
      GEMINI_CLI_HOME: "/tmp/child-gemini-home",
      OPENAI_API_KEY: "sk-openai-child",
    });

    expect(log).toMatch(/host=.*ANTHROPIC_API_KEY/);
    expect(log).toMatch(/host=.*ANTHROPIC_API_TOKEN/);
    expect(log).toMatch(/host=.*OPENAI_API_KEY/);
    expect(log).toMatch(/child=.*ANTHROPIC_API_TOKEN/);
    expect(log).toMatch(/child=.*CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST/);
    expect(log).toMatch(/child=.*OPENAI_API_KEY/);
    expect(log).toMatch(/cleared=.*ANTHROPIC_API_KEY/);
    expect(log).toMatch(/runtimeHost=.*GEMINI_CLI_SYSTEM_SETTINGS_PATH/);
    expect(log).toMatch(/runtimeChild=.*GEMINI_CLI_HOME/);
    expect(log).toMatch(/runtimeCleared=.*GEMINI_CLI_SYSTEM_SETTINGS_PATH/);
    expect(log).not.toContain("sk-ant-host");
    expect(log).not.toContain("token-child");
    expect(log).not.toContain("/tmp/child-gemini-home");
    expect(log).not.toContain("sk-openai-child");
  });

  it("prepends bootstrap warnings to the CLI prompt body", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "ok",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );
    const context = buildPreparedCliRunContext({
      provider: "codex-cli",
      model: "gpt-5.4",
      runId: "run-warning",
    });
    context.reusableCliSession = { mode: "reuse", sessionId: "thread-123" };
    context.bootstrapPromptWarningLines = [
      "[Bootstrap truncation warning]",
      "- AGENTS.md: 200 raw -> 20 injected",
    ];

    await executePreparedCliRun(context, "thread-123");

    const input = mockCallArg(supervisorSpawnMock) as {
      argv?: string[];
      input?: string;
    };
    const promptCarrier = [input.input ?? "", ...(input.argv ?? [])].join("\n");

    expect(promptCarrier).toContain("[Bootstrap truncation warning]");
    expect(promptCarrier).toContain("- AGENTS.md: 200 raw -> 20 injected");
    expect(promptCarrier).toContain("hi");
  });

  it("loads workspace bootstrap files into the Claude CLI system prompt", async () => {
    const workspaceDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-cli-bootstrap-context-"),
    );

    await fs.writeFile(
      path.join(workspaceDir, "AGENTS.md"),
      [
        "# AGENTS.md",
        "",
        "Read SOUL.md and IDENTITY.md before replying.",
        "Use the injected workspace bootstrap files as standing instructions.",
      ].join("\n"),
      "utf-8",
    );
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "SOUL-SECRET\n", "utf-8");
    await fs.writeFile(path.join(workspaceDir, "IDENTITY.md"), "IDENTITY-SECRET\n", "utf-8");
    await fs.writeFile(path.join(workspaceDir, "USER.md"), "USER-SECRET\n", "utf-8");

    setCliRunnerPrepareTestDeps({
      makeBootstrapWarn: realMakeBootstrapWarn,
      resolveBootstrapContextForRun: realResolveBootstrapContextForRun,
    });

    try {
      const { contextFiles } = await realResolveBootstrapContextForRun({
        workspaceDir,
      });
      const allArgs = buildCliAgentSystemPrompt({
        workspaceDir,
        modelDisplay: "claude-cli/sonnet",
        contextFiles,
        tools: [],
      });
      const agentsPath = path.join(workspaceDir, "AGENTS.md");
      const soulPath = path.join(workspaceDir, "SOUL.md");
      const identityPath = path.join(workspaceDir, "IDENTITY.md");
      const userPath = path.join(workspaceDir, "USER.md");
      expect(allArgs).toContain("# Project Context");
      expect(allArgs).toContain(`## ${agentsPath}`);
      expect(allArgs).toContain("Read SOUL.md and IDENTITY.md before replying.");
      expect(allArgs).toContain(`## ${soulPath}`);
      expect(allArgs).toContain("SOUL-SECRET");
      expect(allArgs).toContain(
        "SOUL.md: persona/tone. Follow it unless higher-priority instructions override.",
      );
      expect(allArgs).toContain(`## ${identityPath}`);
      expect(allArgs).toContain("IDENTITY-SECRET");
      expect(allArgs).toContain(`## ${userPath}`);
      expect(allArgs).toContain("USER-SECRET");
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      restoreCliRunnerPrepareTestDeps();
    }
  });
});

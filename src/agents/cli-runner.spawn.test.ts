import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { onAgentEvent, resetAgentEventsForTest } from "../infra/agent-events.js";
import type { getProcessSupervisor } from "../process/supervisor/index.js";
import {
  makeBootstrapWarn as realMakeBootstrapWarn,
  resolveBootstrapContextForRun as realResolveBootstrapContextForRun,
} from "./bootstrap-files.js";
import { buildRunClaudeCliAgentParams } from "./cli-runner.js";
import {
  createManagedRun,
  mockSuccessfulCliRun,
  restoreCliRunnerPrepareTestDeps,
  supervisorSpawnMock,
} from "./cli-runner.test-support.js";
import {
  buildClaudeLiveArgs,
  resetClaudeLiveSessionsForTest,
  runClaudeLiveSessionTurn,
} from "./cli-runner/claude-live-session.js";
import { buildCliEnvAuthLog, executePreparedCliRun } from "./cli-runner/execute.js";
import { buildSystemPrompt } from "./cli-runner/helpers.js";
import { setCliRunnerPrepareTestDeps } from "./cli-runner/prepare.js";
import type { PreparedCliRunContext } from "./cli-runner/types.js";
import { createClaudeApiErrorFixture } from "./test-helpers/claude-api-error-fixture.js";

type ProcessSupervisor = ReturnType<typeof getProcessSupervisor>;
type SupervisorSpawnFn = ProcessSupervisor["spawn"];

beforeEach(() => {
  resetAgentEventsForTest();
  resetClaudeLiveSessionsForTest();
  restoreCliRunnerPrepareTestDeps();
  supervisorSpawnMock.mockClear();
});

function buildPreparedCliRunContext(params: {
  provider: "claude-cli" | "codex-cli";
  model: string;
  runId: string;
  prompt?: string;
  sessionId?: string;
  sessionKey?: string;
  backend?: Partial<PreparedCliRunContext["preparedBackend"]["backend"]>;
  config?: PreparedCliRunContext["params"]["config"];
  mcpConfigHash?: string;
  skillsSnapshot?: PreparedCliRunContext["params"]["skillsSnapshot"];
  workspaceDir?: string;
}): PreparedCliRunContext {
  const workspaceDir = params.workspaceDir ?? "/tmp";
  const baseBackend =
    params.provider === "claude-cli"
      ? {
          command: "claude",
          args: ["-p", "--output-format", "stream-json"],
          output: "jsonl" as const,
          input: "stdin" as const,
          modelArg: "--model",
          sessionArg: "--session-id",
          sessionMode: "always" as const,
          systemPromptArg: "--append-system-prompt",
          systemPromptWhen: "first" as const,
          serialize: true,
        }
      : {
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
  const backend = { ...baseBackend, ...params.backend };
  return {
    params: {
      sessionId: params.sessionId ?? "s1",
      sessionKey: params.sessionKey,
      sessionFile: "/tmp/session.jsonl",
      workspaceDir,
      config: params.config,
      prompt: params.prompt ?? "hi",
      provider: params.provider,
      model: params.model,
      timeoutMs: 1_000,
      runId: params.runId,
      skillsSnapshot: params.skillsSnapshot,
    },
    started: Date.now(),
    workspaceDir,
    backendResolved: {
      id: params.provider,
      config: backend,
      bundleMcp: params.provider === "claude-cli",
      pluginId: params.provider === "claude-cli" ? "anthropic" : "openai",
    },
    preparedBackend: {
      backend,
      env: {},
      ...(params.mcpConfigHash ? { mcpConfigHash: params.mcpConfigHash } : {}),
    },
    reusableCliSession: {},
    modelId: params.model,
    normalizedModel: params.model,
    systemPrompt: "You are a helpful assistant.",
    systemPromptReport: {} as PreparedCliRunContext["systemPromptReport"],
    bootstrapPromptWarningLines: [],
  };
}

describe("runCliAgent spawn path", () => {
  it("does not inject hardcoded 'Tools are disabled' text into CLI arguments", async () => {
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
      reusableCliSession: {},
      modelId: "sonnet",
      normalizedModel: "sonnet",
      systemPrompt: "You are a helpful assistant.",
      systemPromptReport: {} as PreparedCliRunContext["systemPromptReport"],
      bootstrapPromptWarningLines: [],
    };
    await executePreparedCliRun(context);

    const input = supervisorSpawnMock.mock.calls[0]?.[0] as { argv?: string[] };
    const allArgs = (input.argv ?? []).join("\n");
    expect(allArgs).not.toContain("Tools are disabled in this session");
    expect(allArgs).toContain("You are a helpful assistant.");
  });

  it("includes the OpenClaw skills prompt in CLI system prompts", () => {
    const systemPrompt = buildSystemPrompt({
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

    expect(systemPrompt).toContain("## Skills (mandatory)");
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
        stdout: "ok",
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

    const input = supervisorSpawnMock.mock.calls[0]?.[0] as {
      argv?: string[];
      input?: string;
    };
    expect(input.input).toContain("Explain this diff");
    expect(input.argv).not.toContain("Explain this diff");
  });

  it("passes --session-id for new Claude sessions", async () => {
    mockSuccessfulCliRun();

    await executePreparedCliRun(
      buildPreparedCliRunContext({
        provider: "claude-cli",
        model: "sonnet",
        runId: "run-claude-session-id",
      }),
    );

    const input = supervisorSpawnMock.mock.calls[0]?.[0] as {
      argv?: string[];
      input?: string;
      mode?: string;
    };
    expect(input.mode).toBe("child");
    expect(input.argv).toContain("claude");
    const sessionArgIndex = input.argv?.indexOf("--session-id") ?? -1;
    expect(sessionArgIndex).toBeGreaterThanOrEqual(0);
    expect(input.argv?.[sessionArgIndex + 1]?.trim()).toBeTruthy();
    expect(input.input).toContain("hi");
    expect(input.argv).not.toContain("hi");
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
      const pluginArgIndex = input.argv?.indexOf("--plugin-dir") ?? -1;
      expect(pluginArgIndex).toBeGreaterThanOrEqual(0);
      pluginDir = input.argv?.[pluginArgIndex + 1] ?? "";
      const manifest = JSON.parse(
        await fs.readFile(path.join(pluginDir, ".claude-plugin", "plugin.json"), "utf-8"),
      ) as { name?: string; skills?: string };
      expect(manifest).toMatchObject({
        name: "openclaw-skills",
        skills: "./skills",
      });
      await expect(
        fs.readFile(path.join(pluginDir, "skills", "weather", "SKILL.md"), "utf-8"),
      ).resolves.toContain("Read forecast data before replying.");
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
      await expect(fs.access(pluginDir)).rejects.toThrow();
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
        stdout: "ok",
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

  it("ignores legacy claudeSessionId on the compat wrapper", () => {
    const params = buildRunClaudeCliAgentParams({
      sessionId: "openclaw-session",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hi",
      model: "opus",
      timeoutMs: 1_000,
      runId: "run-claude-legacy-wrapper",
      claudeSessionId: "c9d7b831-1c31-4d22-80b9-1e50ca207d4b",
    });

    expect(params.provider).toBe("claude-cli");
    expect(params.prompt).toBe("hi");
    expect(params).not.toHaveProperty("cliSessionId");
    expect(JSON.stringify(params)).not.toContain("c9d7b831-1c31-4d22-80b9-1e50ca207d4b");
  });

  it("forwards senderIsOwner through the compat wrapper", () => {
    const params = buildRunClaudeCliAgentParams({
      sessionId: "openclaw-session",
      sessionKey: "agent:main:matrix:room:123",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hi",
      model: "opus",
      timeoutMs: 1_000,
      runId: "run-claude-owner-wrapper",
      senderIsOwner: false,
    });

    expect(params.senderIsOwner).toBe(false);
  });

  it("runs CLI through supervisor and returns payload", async () => {
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
    context.reusableCliSession = { sessionId: "thread-123" };

    const result = await executePreparedCliRun(context, "thread-123");

    expect(result.text).toBe("ok");
    const input = supervisorSpawnMock.mock.calls[0]?.[0] as {
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
  });

  it("passes Codex system prompts through model_instructions_file", async () => {
    let promptFileText = "";
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = (args[0] ?? {}) as { argv?: string[] };
      const configArgIndex = input.argv?.indexOf("-c") ?? -1;
      expect(configArgIndex).toBeGreaterThanOrEqual(0);
      const configArg = input.argv?.[configArgIndex + 1] ?? "";
      const match = /^model_instructions_file="(.+)"$/.exec(configArg);
      expect(match?.[1]).toBeTruthy();
      promptFileText = await fs.readFile(match?.[1] ?? "", "utf-8");
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
    let resolveWait!: (value: {
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
    }) => void;
    const cancel = vi.fn((reason?: string) => {
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

    await expect(runPromise).rejects.toMatchObject({ name: "AbortError" });
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
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: [
          JSON.stringify({ type: "init", session_id: "session-123" }),
          JSON.stringify({
            type: "stream_event",
            event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } },
          }),
          JSON.stringify({
            type: "stream_event",
            event: { type: "content_block_delta", delta: { type: "text_delta", text: " world" } },
          }),
          JSON.stringify({
            type: "result",
            session_id: "session-123",
            result: "Hello world",
          }),
        ].join("\n"),
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

  it("reuses a Claude live session process across turns", async () => {
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
      const first = await executePreparedCliRun(
        buildPreparedCliRunContext({
          provider: "claude-cli",
          model: "sonnet",
          runId: "run-live-1",
          prompt: "first",
          backend: {
            args: [
              "-p",
              "--output-format",
              "stream-json",
              "--strict-mcp-config",
              "--mcp-config",
              "/tmp/mcp-one.json",
            ],
            liveSession: "claude-stdio",
          },
          mcpConfigHash: "same-mcp-config",
        }),
      );
      const second = await executePreparedCliRun(
        buildPreparedCliRunContext({
          provider: "claude-cli",
          model: "sonnet",
          runId: "run-live-2",
          prompt: "second",
          backend: {
            args: [
              "-p",
              "--output-format",
              "stream-json",
              "--strict-mcp-config",
              "--mcp-config",
              "/tmp/mcp-two.json",
            ],
            liveSession: "claude-stdio",
          },
          mcpConfigHash: "same-mcp-config",
        }),
      );

      const spawnInput = supervisorSpawnMock.mock.calls[0]?.[0] as {
        argv?: string[];
        stdinMode?: string;
      };
      expect(first.text).toBe("one");
      expect(second.text).toBe("two");
      expect(supervisorSpawnMock).toHaveBeenCalledOnce();
      expect(spawnInput.stdinMode).toBe("pipe-open");
      expect(spawnInput.argv).toContain("--input-format");
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
    } finally {
      stop();
    }
  });

  it("reuses a Claude live session when resumed turns omit the system prompt arg", async () => {
    let stdoutListener: ((chunk: string) => void) | undefined;
    let turn = 0;
    const stdin = {
      write: vi.fn((_data: string, cb?: (err?: Error | null) => void) => {
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
      write: vi.fn((_data: string, cb?: (err?: Error | null) => void) => {
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

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ text: "one" }),
      expect.objectContaining({ text: "two" }),
    ]);
    expect(supervisorSpawnMock).toHaveBeenCalledOnce();
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
        write: vi.fn((_data: string, cb?: (err?: Error | null) => void) => {
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
            reconcileOrphans: vi.fn(),
            getRecord: vi.fn(),
          }),
          onAssistantDelta: () => {},
          cleanup: async () => {},
        });
      })(),
    );

    await vi.waitFor(() => expect(supervisorSpawnMock).toHaveBeenCalledTimes(16));
    const rejectedRun = runs[16];
    expect(rejectedRun).toBeDefined();
    await expect(rejectedRun).rejects.toThrow("Too many Claude CLI live sessions are active.");
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
      ],
      backend,
      systemPrompt: "current prompt",
      useResume: true,
    });

    expect(args).toContain("--resume");
    expect(args).toContain("claude-session");
    expect(args).not.toContain("--session-id");
    expect(args).not.toContain("openclaw-session");
    expect(args).not.toContain("--append-system-prompt");
    expect(args).not.toContain("old prompt");
    expect(args).not.toContain("current prompt");
  });

  it("restarts Claude live sessions for env changes and fresh retries", async () => {
    const cancels: Array<ReturnType<typeof vi.fn>> = [];
    const turnResults = ["first-ok", "resume-ok", "env-ok", "fresh-ok"];
    let turnIndex = 0;
    supervisorSpawnMock.mockImplementation(async (...args: unknown[]) => {
      const spawnIndex = supervisorSpawnMock.mock.calls.length;
      const input = (args[0] ?? {}) as { onStdout?: (chunk: string) => void };
      const cancel = vi.fn();
      cancels.push(cancel);
      return {
        runId: `live-run-${spawnIndex}`,
        pid: 2345 + spawnIndex,
        startedAtMs: Date.now(),
        stdin: {
          write: vi.fn((_data: string, cb?: (err?: Error | null) => void) => {
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
        wait: vi.fn(() => new Promise(() => {})),
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
          reconcileOrphans: vi.fn(),
          getRecord: vi.fn(),
        }),
        onAssistantDelta: () => {},
        cleanup: async () => {},
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
    expect(supervisorSpawnMock).toHaveBeenCalledTimes(1);
    expect(cancels[0]).not.toHaveBeenCalled();

    await expect(
      runTurn("run-live-env-change", resumeArgs, { ANTHROPIC_BASE_URL: "https://two.example" }),
    ).resolves.toBe("env-ok");
    expect(supervisorSpawnMock).toHaveBeenCalledTimes(2);
    expect(cancels[0]).toHaveBeenCalledWith("manual-cancel");

    await expect(
      runTurn("run-live-fresh-retry", freshArgs, {
        ANTHROPIC_BASE_URL: "https://two.example",
      }),
    ).resolves.toBe("fresh-ok");

    expect(supervisorSpawnMock).toHaveBeenCalledTimes(3);
    expect(cancels[1]).toHaveBeenCalledWith("manual-cancel");
    expect(cancels[2]).not.toHaveBeenCalled();
  });

  it("ignores non-JSON stdout lines from Claude live sessions", async () => {
    let stdoutListener: ((chunk: string) => void) | undefined;
    const stdin = {
      write: vi.fn((_data: string, cb?: (err?: Error | null) => void) => {
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
      write: vi.fn((_data: string, cb?: (err?: Error | null) => void) => {
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

    await expect(
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
    ).rejects.toMatchObject({
      name: "FailoverError",
      message: "Credit balance is too low",
    });
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
        write: vi.fn((_data: string, cb?: (err?: Error | null) => void) => {
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

    await expect(first).rejects.toMatchObject({ name: "AbortError" });
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
        write: vi.fn((_data: string, cb?: (err?: Error | null) => void) => {
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
    let resolveExit!: (value: {
      reason: "exit";
      exitCode: number;
      exitSignal: null;
      durationMs: number;
      stdout: string;
      stderr: string;
      timedOut: false;
      noOutputTimedOut: false;
    }) => void;
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
      write: vi.fn((_data: string, cb?: (err?: Error | null) => void) => {
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
    await expect(second).rejects.toMatchObject({
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

    await expect(run).rejects.toMatchObject({
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

    const input = supervisorSpawnMock.mock.calls[0]?.[0] as {
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

    const input = supervisorSpawnMock.mock.calls[0]?.[0] as {
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

      const input = supervisorSpawnMock.mock.calls[0]?.[0] as {
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

    const input = supervisorSpawnMock.mock.calls[0]?.[0] as {
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
    mockSuccessfulCliRun();

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

    const input = supervisorSpawnMock.mock.calls[0]?.[0] as {
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
    vi.stubEnv("OPENAI_API_KEY", "sk-openai-host");

    const log = buildCliEnvAuthLog({
      ANTHROPIC_API_TOKEN: "token-child",
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
      OPENAI_API_KEY: "sk-openai-child",
    });

    expect(log).toMatch(/host=.*ANTHROPIC_API_KEY/);
    expect(log).toMatch(/host=.*ANTHROPIC_API_TOKEN/);
    expect(log).toMatch(/host=.*OPENAI_API_KEY/);
    expect(log).toMatch(/child=.*ANTHROPIC_API_TOKEN/);
    expect(log).toMatch(/child=.*CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST/);
    expect(log).toMatch(/child=.*OPENAI_API_KEY/);
    expect(log).toMatch(/cleared=.*ANTHROPIC_API_KEY/);
    expect(log).not.toContain("sk-ant-host");
    expect(log).not.toContain("token-child");
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
    context.reusableCliSession = { sessionId: "thread-123" };
    context.bootstrapPromptWarningLines = [
      "[Bootstrap truncation warning]",
      "- AGENTS.md: 200 raw -> 20 injected",
    ];

    await executePreparedCliRun(context, "thread-123");

    const input = supervisorSpawnMock.mock.calls[0]?.[0] as {
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
      const allArgs = buildSystemPrompt({
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
        "If SOUL.md is present, embody its persona and tone. Avoid stiff, generic replies; follow its guidance unless higher-priority instructions override it.",
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

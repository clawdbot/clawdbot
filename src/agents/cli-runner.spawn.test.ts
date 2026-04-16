import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { onAgentEvent, resetAgentEventsForTest } from "../infra/agent-events.js";
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
import { buildCliEnvAuthLog, executePreparedCliRun } from "./cli-runner/execute.js";
import { buildSystemPrompt } from "./cli-runner/helpers.js";
import { setCliRunnerPrepareTestDeps } from "./cli-runner/prepare.js";
import type { PreparedCliRunContext } from "./cli-runner/types.js";

beforeEach(() => {
  resetAgentEventsForTest();
  restoreCliRunnerPrepareTestDeps();
  supervisorSpawnMock.mockClear();
});

function buildPreparedCliRunContext(params: {
  provider: "claude-cli" | "codex-cli";
  model: string;
  runId: string;
  prompt?: string;
  backend?: Partial<PreparedCliRunContext["preparedBackend"]["backend"]>;
  config?: PreparedCliRunContext["params"]["config"];
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
      sessionId: "s1",
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

  it("surfaces nested Claude stream-json API errors instead of raw event output", async () => {
    const message =
      "Third-party apps now draw from your extra usage, not your plan limits. We've added a $200 credit to get you started. Claim it at claude.ai/settings/usage and keep going.";
    const apiError = `API Error: 400 ${JSON.stringify({
      type: "error",
      error: {
        type: "invalid_request_error",
        message,
      },
      request_id: "req_011CZqHuXhFetYCnr8325DQc",
    })}`;

    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 1,
        exitSignal: null,
        durationMs: 50,
        stdout: [
          JSON.stringify({ type: "system", subtype: "init", session_id: "session-api-error" }),
          JSON.stringify({
            type: "assistant",
            message: {
              model: "<synthetic>",
              role: "assistant",
              content: [{ type: "text", text: apiError }],
            },
            session_id: "session-api-error",
            error: "unknown",
          }),
          JSON.stringify({
            type: "result",
            subtype: "success",
            is_error: true,
            result: apiError,
            session_id: "session-api-error",
          }),
        ].join("\n"),
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

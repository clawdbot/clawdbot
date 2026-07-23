import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, vi } from "vitest";
import { CURRENT_SESSION_VERSION } from "../config/sessions/version.js";
import type { McpLoopbackRequestContext } from "../gateway/mcp-grant-store.js";
import {
  onTrustedInternalDiagnosticEvent,
  type DiagnosticEventPayload,
  type DiagnosticEventPrivateData,
} from "../infra/diagnostic-events.js";
import type { CliBackendPlugin } from "../plugins/cli-backend.types.js";
import type { RunExit } from "../process/supervisor/types.js";
import { withEnvAsync } from "../test-utils/env.js";
import type { PreparedCliRunContext } from "./cli-runner/types.js";
import type { RunCliAgentParams } from "./cli-runner/types.js";

type CliProvider = "claude-cli" | "codex-cli" | "google-gemini-cli";
type McpLoopbackClientGrant = ReturnType<
  (typeof import("../gateway/mcp-grant-store.js"))["mintMcpLoopbackClientGrant"]
>;
type ModelCallLifecycleEvent = Extract<
  DiagnosticEventPayload,
  { type: "model.call.started" | "model.call.completed" | "model.call.error" }
>;

export type TestCliBackendParams = {
  bundleMcp?: boolean;
  reseedFromRawTranscriptWhenUncompacted?: boolean;
  systemPromptWhen?: "first" | "always" | "never";
};

export function wrappedPluginSystemContext(text: string) {
  return `---\n\nOpenClaw plugin-injected system context. This block is not workspace file content.\n\n${text}\n\n---`;
}

export function captureModelCallDiagnostics(runId: string) {
  const events: Array<{
    event: ModelCallLifecycleEvent;
    privateData: DiagnosticEventPrivateData;
  }> = [];
  const stop = onTrustedInternalDiagnosticEvent((event, _metadata, privateData) => {
    if (
      (event.type === "model.call.started" ||
        event.type === "model.call.completed" ||
        event.type === "model.call.error") &&
      event.runId === runId
    ) {
      events.push({ event, privateData });
    }
  });
  return { events, stop };
}

export function expectModelCallTypes(
  diagnostics: { events: Array<{ event: { type: string } }> },
  types: string[],
) {
  expect(diagnostics.events.map(({ event }) => event.type)).toEqual(types);
}

export function createTestMcpLoopbackServerConfig(port: number) {
  return {
    mcpServers: {
      openclaw: {
        type: "http",
        url: `http://127.0.0.1:${port}/mcp`,
        alwaysLoad: true,
        headers: {
          Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}",
          "x-openclaw-cli-capture-key": "${OPENCLAW_MCP_CLI_CAPTURE_KEY}",
        },
      },
    },
  };
}

export function createTestMcpLoopbackClientGrant(params: {
  context: McpLoopbackRequestContext;
}): McpLoopbackClientGrant {
  return { token: "loopback-token", context: structuredClone(params.context) };
}

export async function createTestMcpLoopbackServer(port = 0) {
  return { port, close: vi.fn(async () => undefined) };
}

export function buildDefaultTestCliBackend(
  params: TestCliBackendParams = {},
): CliBackendPlugin & { pluginId: string } {
  return {
    id: "test-cli",
    pluginId: "test-cli-plugin",
    bundleMcp: params.bundleMcp === true,
    ...(params.bundleMcp ? { bundleMcpMode: "claude-config-file" as const } : {}),
    config: {
      command: "test-cli",
      args: ["--print"],
      systemPromptArg: "--system-prompt",
      systemPromptWhen: params.systemPromptWhen ?? "first",
      sessionMode: "existing",
      output: "text",
      input: "arg",
      ...(params.reseedFromRawTranscriptWhenUncompacted
        ? { reseedFromRawTranscriptWhenUncompacted: true }
        : {}),
    },
  };
}

export type PreparedCliRunContextOverrides = {
  provider?: CliProvider;
  model?: string;
  runId?: string;
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
  cliToolAvailability?: PreparedCliRunContext["params"]["cliToolAvailability"];
  emitCommentaryText?: boolean;
  workspaceDir?: string;
  timeoutMs?: number;
  onSuccessfulAuthBinding?: PreparedCliRunContext["params"]["onSuccessfulAuthBinding"];
  runtimeArtifact?: PreparedCliRunContext["backendResolved"]["runtimeArtifact"];
};

export function buildPreparedCliRunContext(
  overrides: PreparedCliRunContextOverrides = {},
): PreparedCliRunContext {
  const provider = overrides.provider ?? "claude-cli";
  const model = overrides.model ?? "sonnet";
  const workspaceDir = overrides.workspaceDir ?? "/tmp";
  const baseBackend =
    provider === "claude-cli"
      ? {
          command: "claude",
          args: ["-p", "--output-format", "stream-json"],
          output: "jsonl" as const,
          input: "stdin" as const,
          modelArg: "--model",
          sessionArgs: ["--session-id", "{sessionId}"],
          sessionMode: "always" as const,
          systemPromptFileArg: "--append-system-prompt-file",
          systemPromptWhen: "first" as const,
          serialize: true,
        }
      : provider === "google-gemini-cli"
        ? {
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
  const backend = { ...baseBackend, ...overrides.backend };
  return {
    params: {
      sessionId: overrides.sessionId ?? "s1",
      sessionKey: overrides.sessionKey,
      sessionEntry: overrides.sessionEntry,
      agentId: overrides.agentId,
      sessionFile: "/tmp/session.jsonl",
      workspaceDir,
      config: overrides.config,
      prompt: overrides.prompt ?? "hi",
      provider,
      model,
      thinkLevel: overrides.thinkLevel,
      executionMode: overrides.executionMode,
      cliToolAvailability: overrides.cliToolAvailability,
      emitCommentaryText: overrides.emitCommentaryText,
      onSuccessfulAuthBinding: overrides.onSuccessfulAuthBinding,
      timeoutMs: overrides.timeoutMs ?? 1_000,
      runId: overrides.runId ?? "run-test",
      skillsSnapshot: overrides.skillsSnapshot,
    },
    started: Date.now(),
    workspaceDir,
    backendResolved: {
      id: provider,
      config: backend,
      bundleMcp: provider === "claude-cli",
      pluginId:
        provider === "claude-cli"
          ? "anthropic"
          : provider === "google-gemini-cli"
            ? "google"
            : "openai",
      resolveExecutionArgs: overrides.resolveExecutionArgs,
      runtimeArtifact: overrides.runtimeArtifact,
    },
    preparedBackend: {
      backend,
      env: overrides.preparedEnv ?? {},
      ...(overrides.mcpConfigHash ? { mcpConfigHash: overrides.mcpConfigHash } : {}),
    },
    reusableCliSession: { mode: "none" },
    hadSessionFile: false,
    contextEngineConfig: {},
    modelId: model,
    normalizedModel: model,
    systemPrompt: "You are a helpful assistant.",
    systemPromptReport: {} as PreparedCliRunContext["systemPromptReport"],
    bootstrapPromptWarningLines: [],
    authEpochVersion: 2,
    ...(overrides.mcpDeliveryCapture ? { mcpDeliveryCapture: true } : {}),
  };
}

export function buildClaudeLiveRunContext(overrides: PreparedCliRunContextOverrides = {}) {
  return buildPreparedCliRunContext({
    ...overrides,
    backend: { ...overrides.backend, liveSession: "claude-stdio" },
  });
}

export function buildClaudeLiveBackend(
  overrides: Partial<PreparedCliRunContext["preparedBackend"]["backend"]> = {},
) {
  return {
    command: "claude",
    args: ["-p", "--output-format", "stream-json"],
    output: "jsonl" as const,
    input: "stdin" as const,
    sessionArgs: ["--session-id", "{sessionId}"],
    systemPromptArg: "--append-system-prompt",
    systemPromptFileArg: "--append-system-prompt-file",
    ...overrides,
  };
}

export function createCancelableLiveRunLifecycle() {
  let resolveExit!: (exit: RunExit) => void;
  const exited = new Promise<RunExit>((resolve) => {
    resolveExit = resolve;
  });
  return {
    wait: vi.fn(() => exited),
    cancel: vi.fn((_reason?: string) => {
      resolveExit({
        reason: "manual-cancel",
        exitCode: null,
        exitSignal: null,
        durationMs: 1,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    }),
  };
}

export function requireArgAfter(argv: string[] | undefined, flag: string): string {
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

export function requireRegexMatch(value: string, pattern: RegExp): RegExpExecArray {
  const match = pattern.exec(value);
  if (!match) {
    throw new Error(`expected ${value} to match ${pattern}`);
  }
  return match;
}

export function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label} to be an object`);
  }
  return value as Record<string, unknown>;
}

export function mockCallArg(mock: ReturnType<typeof vi.fn>, callIndex = 0, argIndex = 0) {
  const call = mock.mock.calls[callIndex] as unknown[] | undefined;
  if (!call) {
    throw new Error(`expected mock call ${callIndex}`);
  }
  return call[argIndex];
}

export async function expectRejectsWithFields(
  promise: Promise<unknown>,
  expected: Record<string, unknown>,
) {
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

export async function expectPathMissing(targetPath: string) {
  try {
    await fs.promises.access(targetPath);
  } catch (error) {
    expect(requireRecord(error, "filesystem error").code).toBe("ENOENT");
    return;
  }
  throw new Error(`expected ${targetPath} to be missing`);
}

export async function withTempExecApprovalsFile(
  file: Record<string, unknown>,
  run: () => Promise<void>,
) {
  const home = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-exec-approvals-"));
  await fs.promises.mkdir(path.join(home, ".openclaw"), { recursive: true });
  await fs.promises.writeFile(
    path.join(home, ".openclaw", "exec-approvals.json"),
    `${JSON.stringify(file)}\n`,
    "utf-8",
  );
  try {
    await withEnvAsync({ HOME: home }, run);
  } finally {
    await fs.promises.rm(home, { recursive: true, force: true });
  }
}

export async function withTempOpenClawHome(run: (home: string) => Promise<void>) {
  const home = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-home-"));
  try {
    await withEnvAsync({ OPENCLAW_HOME: home }, async () => run(home));
  } finally {
    await fs.promises.rm(home, { recursive: true, force: true });
  }
}

type PrepareCliRun = (params: RunCliAgentParams) => Promise<PreparedCliRunContext>;

export function createCliRunnerPrepareFixture(prepareCliRun: PrepareCliRun) {
  const tempDirs = new Set<string>();
  const hadStateDir = Object.hasOwn(process.env, "OPENCLAW_STATE_DIR");
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;
  let defaultSession: { dir: string; sessionFile: string } | undefined;

  const createSession = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-prepare-"));
    tempDirs.add(dir);
    process.env.OPENCLAW_STATE_DIR = dir;
    const sessionFile = path.join(dir, "agents", "main", "sessions", "session-test.jsonl");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(
      sessionFile,
      `${JSON.stringify({
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: "session-test",
        timestamp: new Date(0).toISOString(),
        cwd: dir,
      })}\n`,
      "utf-8",
    );
    return { dir, sessionFile };
  };

  const getSession = () => (defaultSession ??= createSession());
  return {
    get session() {
      return getSession();
    },
    createSession,
    prepare(overrides: Partial<RunCliAgentParams> = {}) {
      const { dir, sessionFile } = getSession();
      const defaults: RunCliAgentParams = {
        sessionId: "session-test",
        sessionFile,
        workspaceDir: dir,
        prompt: "latest ask",
        provider: "test-cli",
        model: "test-model",
        timeoutMs: 1_000,
        runId: "run-test",
        config: {},
      };
      return prepareCliRun(Object.assign(defaults, overrides));
    },
    appendTranscript(entry: {
      id: string;
      parentId: string | null;
      timestamp: string;
      message: unknown;
    }) {
      const { sessionFile } = getSession();
      fs.appendFileSync(sessionFile, `${JSON.stringify({ type: "message", ...entry })}\n`, "utf-8");
    },
    cleanup() {
      for (const dir of tempDirs) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      tempDirs.clear();
      defaultSession = undefined;
      if (hadStateDir) {
        process.env.OPENCLAW_STATE_DIR = originalStateDir;
      } else {
        delete process.env.OPENCLAW_STATE_DIR;
      }
    },
  };
}

export function createWeatherSkillFixture(root: string, materialized: boolean) {
  const skillDir = path.join(root, "skills", materialized ? "weather" : "missing");
  const skillFilePath = path.join(skillDir, "SKILL.md");
  if (materialized) {
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      skillFilePath,
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
  }
  const prompt = [
    "<available_skills>",
    "  <skill>",
    "    <name>weather</name>",
    "    <description>Use weather tools for forecasts.</description>",
    `    <location>${skillFilePath}</location>`,
    "  </skill>",
    "</available_skills>",
  ].join("\n");
  return {
    skillDir,
    skillFilePath,
    snapshot: {
      prompt,
      skills: [{ name: "weather" }],
      resolvedSkills: [
        {
          name: "weather",
          description: "Use weather tools for forecasts.",
          filePath: skillFilePath,
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
    } satisfies NonNullable<RunCliAgentParams["skillsSnapshot"]>,
  };
}

type SupervisorSpawnMock = (typeof import("./cli-runner.test-support.js"))["supervisorSpawnMock"];

type ClaudeLiveRunFixture = ReturnType<typeof mockClaudeLiveRun>;

export function mockClaudeLiveRun(
  spawnMock: SupervisorSpawnMock,
  options: {
    cancelable?: boolean;
    beforeSpawn?: () => Promise<void>;
    events?: Array<Record<string, unknown> | string>;
    exitImmediately?: RunExit;
    exitOnWrite?: RunExit;
    onWrite?: (params: {
      data: string;
      emit: (events: Array<Record<string, unknown> | string>) => void;
      writeIndex: number;
    }) => void;
    runId?: string;
    pid?: number;
  } = {},
) {
  let stdoutListener: ((chunk: string) => void) | undefined;
  let resolveExit: ((exit: RunExit) => void) | undefined;
  const exited = new Promise<RunExit>((resolve) => {
    resolveExit = resolve;
  });
  let spawnInput: {
    argv?: string[];
    env?: Record<string, string>;
    onStdout?: (chunk: string) => void;
  } = {};
  const writes: string[] = [];
  const emit = (events: Array<Record<string, unknown> | string>) => {
    stdoutListener?.(
      `${events.map((event) => (typeof event === "string" ? event : JSON.stringify(event))).join("\n")}\n`,
    );
  };
  const stdin = {
    write: vi.fn((data: string, callback?: (error?: Error | null) => void) => {
      writes.push(data);
      const writeIndex = writes.length - 1;
      if (options.onWrite) {
        options.onWrite({ data, emit, writeIndex });
      } else if (writeIndex === 0 && options.events) {
        emit(options.events);
      }
      callback?.();
      if (options.exitOnWrite) {
        resolveExit?.(options.exitOnWrite);
      }
    }),
    end: vi.fn(),
  };
  const lifecycle = options.cancelable
    ? createCancelableLiveRunLifecycle()
    : {
        wait: vi.fn(() =>
          options.exitImmediately
            ? Promise.resolve(options.exitImmediately)
            : options.exitOnWrite
              ? exited
              : new Promise<RunExit>(() => {}),
        ),
        cancel: vi.fn(),
      };
  spawnMock.mockImplementationOnce(async (...args: unknown[]) => {
    spawnInput = (args[0] ?? {}) as typeof spawnInput;
    stdoutListener = spawnInput.onStdout;
    await options.beforeSpawn?.();
    return {
      runId: options.runId ?? "live-run",
      pid: options.pid ?? 2345,
      startedAtMs: Date.now(),
      stdin,
      ...lifecycle,
    };
  });
  return {
    emit,
    get spawnInput() {
      return spawnInput;
    },
    stdin,
    lifecycle,
    writes,
  };
}

export function buildClaudeControlRequestEvents(params: {
  requestId: string;
  toolUseId: string;
  input: Record<string, unknown>;
  sessionId?: string;
}) {
  const sessionId = params.sessionId ?? "live-control";
  return [
    {
      type: "control_request",
      request_id: params.requestId,
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        tool_use_id: params.toolUseId,
        input: params.input,
      },
    },
    { type: "system", subtype: "init", session_id: sessionId },
    { type: "result", session_id: sessionId, result: "ok" },
  ];
}

export function expectClaudeControlDecision(
  fixture: ClaudeLiveRunFixture,
  expected: {
    behavior: "allow" | "deny";
    requestId: string;
    toolUseId?: string;
    updatedInput?: Record<string, unknown>;
    messageIncludes?: string;
  },
) {
  const encoded = fixture.writes.find((entry) => entry.includes('"control_response"'));
  expect(encoded, "control_response written to stdin").toBeDefined();
  const parsed = JSON.parse((encoded ?? "").trim()) as {
    type: string;
    response: {
      subtype: string;
      request_id: string;
      response: {
        behavior: string;
        decisionClassification?: string;
        message?: string;
        toolUseID?: string;
        updatedInput?: unknown;
      };
    };
  };
  expect(parsed.type).toBe("control_response");
  expect(parsed.response.subtype).toBe("success");
  expect(parsed.response.request_id).toBe(expected.requestId);
  expect(parsed.response.response.behavior).toBe(expected.behavior);
  if (expected.toolUseId) {
    expect(parsed.response.response.toolUseID).toBe(expected.toolUseId);
  }
  if (expected.updatedInput) {
    expect(parsed.response.response.updatedInput).toEqual(expected.updatedInput);
  }
  if (expected.messageIncludes) {
    expect(parsed.response.response.decisionClassification).toBe("user_reject");
    expect(parsed.response.response.message).toContain(expected.messageIncludes);
  }
  return parsed;
}

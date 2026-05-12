import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drainFormattedSystemEvents } from "../auto-reply/reply/session-system-events.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  resetHeartbeatWakeStateForTests,
  setHeartbeatWakeHandler,
} from "../infra/heartbeat-wake.js";
import { applyPathPrepend, findPathKey } from "../infra/path-prepend.js";
import {
  peekSystemEventEntries,
  peekSystemEvents,
  resetSystemEventsForTest,
} from "../infra/system-events.js";
import { captureEnv } from "../test-utils/env.js";
import {
  addSession,
  appendOutput,
  getFinishedSession,
  markBackgrounded,
  markExited,
  resetProcessRegistryForTests,
  type ProcessSession,
} from "./bash-process-registry.js";
import { createExecTool, createProcessTool } from "./bash-tools.js";
import { resolveShellFromPath, sanitizeBinaryOutput } from "./shell-utils.js";

vi.mock("../infra/channel-summary.js", () => ({
  buildChannelSummary: vi.fn(async () => []),
}));

vi.mock("../infra/exec-approval-surface.js", () => ({
  describeNativeExecApprovalClientSetup: () => null,
  listNativeExecApprovalClientLabels: () => [],
  resolveExecApprovalInitiatingSurfaceState: (params: {
    channel?: string | null;
    accountId?: string | null;
  }) => {
    const channel = params.channel ?? undefined;
    return {
      kind: "enabled",
      channel,
      channelLabel:
        channel === "tui" ? "terminal UI" : channel === "internal" ? "Web UI" : "this platform",
      accountId: params.accountId ?? undefined,
    };
  },
  supportsNativeExecApprovalClient: (channel?: string | null) =>
    !channel || channel === "internal" || channel === "tui",
}));

vi.mock("../utils/delivery-context.js", () => ({
  normalizeDeliveryContext: (context?: {
    channel?: string | null;
    to?: string | number | null;
    accountId?: string | null;
    threadId?: string | number | null;
  }) => {
    if (!context) {
      return undefined;
    }
    const channel = context.channel?.trim().toLowerCase();
    const to = context.to == null ? undefined : String(context.to).trim();
    const accountId = context.accountId?.trim();
    const threadId = context.threadId == null ? undefined : context.threadId;
    if (!channel && !to && !accountId && threadId == null) {
      return undefined;
    }
    return {
      channel: channel || undefined,
      to: to || undefined,
      accountId: accountId || undefined,
      ...(threadId != null && threadId !== "" ? { threadId } : {}),
    };
  },
}));

vi.mock("./bash-tools.exec-approval-followup.js", () => ({
  buildExecApprovalFollowupPrompt: (text: string) => text,
  sendExecApprovalFollowup: vi.fn(async () => false),
}));

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: vi.fn(async () => ({ ok: true })),
  readGatewayCallOptions: vi.fn(() => ({})),
}));

vi.mock("../infra/shell-env.js", async () => {
  const actual =
    await vi.importActual<typeof import("../infra/shell-env.js")>("../infra/shell-env.js");
  return {
    ...actual,
    getShellPathFromLoginShell: vi.fn(() => null),
    resolveShellEnvFallbackTimeoutMs: vi.fn(() => 0),
  };
});

vi.mock("../process/supervisor/index.js", () => {
  type SpawnInput = {
    argv?: string[];
    ptyCommand?: string;
    env?: NodeJS.ProcessEnv;
    onStdout?: (chunk: string) => void;
  };

  const immediate = () => new Promise<void>((resolve) => setImmediate(resolve));
  const readEnvPath = (env?: NodeJS.ProcessEnv) => env?.PATH ?? env?.Path ?? "";
  const extractCommand = (input: SpawnInput) => input.ptyCommand ?? input.argv?.at(-1) ?? "";
  const splitCommands = (command: string) => {
    const commands: string[] = [];
    for (const part of command.split(";")) {
      const trimmed = part.trim();
      if (trimmed.length > 0) {
        commands.push(trimmed);
      }
    }
    return commands;
  };
  const stdoutForSegment = (segment: string, env?: NodeJS.ProcessEnv) => {
    if (segment === "echo $PATH" || segment === "Write-Output $env:PATH") {
      return `${readEnvPath(env)}\n`;
    }
    if (segment.startsWith("echo ")) {
      return `${segment.slice("echo ".length)}\n`;
    }
    if (segment.startsWith("Write-Output ")) {
      return `${segment.slice("Write-Output ".length)}\n`;
    }
    return "";
  };

  const commandOutput = (command: string, env?: NodeJS.ProcessEnv) =>
    splitCommands(command)
      .map((segment) => stdoutForSegment(segment, env))
      .join("");

  return {
    getProcessSupervisor: () => ({
      spawn: async (input: SpawnInput) => {
        const command = extractCommand(input);
        const output = commandOutput(command, input.env);
        const exitCode = splitCommands(command).includes("exit 1") ? 1 : 0;
        const stagedOutput = command.includes("after")
          ? output.replace(/after[^\n]*\n?/gu, "")
          : output;
        const deferredOutput = output.slice(stagedOutput.length);
        if (stagedOutput) {
          input.onStdout?.(stagedOutput);
        }
        return {
          runId: "mock-bash-run",
          startedAtMs: Date.now(),
          pid: 123,
          stdin: undefined,
          wait: async () => {
            await immediate();
            if (deferredOutput) {
              input.onStdout?.(deferredOutput);
            }
            return {
              reason: "exit" as const,
              exitCode,
              exitSignal: null,
              durationMs: 0,
              stdout: "",
              stderr: "",
              timedOut: false,
              noOutputTimedOut: false,
            };
          },
          cancel: vi.fn(),
        };
      },
      cancel: vi.fn(),
      cancelScope: vi.fn(),
      reconcileOrphans: vi.fn(),
      getRecord: vi.fn(),
    }),
  };
});

const isWin = process.platform === "win32";
const defaultShell = isWin
  ? undefined
  : process.env.OPENCLAW_TEST_SHELL || resolveShellFromPath("bash") || process.env.SHELL || "sh";
// PowerShell: Start-Sleep for delays, ; for command separation, $null for null device
const shortDelayCmd = isWin ? "Start-Sleep -Milliseconds 4" : "sleep 0.004";
const POLL_INTERVAL_MS = isWin ? 15 : 2;
const BACKGROUND_POLL_TIMEOUT_MS = isWin ? 8000 : 1200;
const NOTIFY_EVENT_TIMEOUT_MS = isWin ? 12_000 : 5_000;
const BACKGROUND_POLL_OPTIONS = {
  timeout: BACKGROUND_POLL_TIMEOUT_MS,
  interval: POLL_INTERVAL_MS,
};
const NOTIFY_POLL_OPTIONS = {
  timeout: NOTIFY_EVENT_TIMEOUT_MS,
  interval: POLL_INTERVAL_MS,
};
const SHELL_ENV_KEYS = ["SHELL"] as const;
const PATH_SHELL_ENV_KEYS = ["PATH", "SHELL"] as const;
const PROCESS_STATUS_RUNNING = "running";
const PROCESS_STATUS_COMPLETED = "completed";
const PROCESS_STATUS_FAILED = "failed";
const OUTPUT_DONE = "done";
const OUTPUT_NOPE = "nope";
const OUTPUT_EXEC_COMPLETED = "Exec completed";
const OUTPUT_EXIT_CODE_1 = "Command exited with code 1";
const shellEcho = (message: string) => (isWin ? `Write-Output ${message}` : `echo ${message}`);
const COMMAND_NOOP = isWin ? "$null" : ":";
const COMMAND_ECHO_HELLO = shellEcho("hello");
const COMMAND_PRINT_PATH = isWin ? "Write-Output $env:PATH" : "echo $PATH";
const COMMAND_EXIT_WITH_ERROR = "exit 1";
const SCOPE_KEY_ALPHA = "agent:alpha";
const SCOPE_KEY_BETA = "agent:beta";
const TEST_EXEC_DEFAULTS = {
  host: "gateway" as const,
  security: "full" as const,
  ask: "off" as const,
};
const DEFAULT_NOTIFY_SESSION_KEY = "agent:main:main";
const ECHO_HI_COMMAND = shellEcho("hi");
let callIdCounter = 0;
const nextCallId = () => `call${++callIdCounter}`;
const notifyCfg = {} as OpenClawConfig;
type ExecToolInstance = ReturnType<typeof createExecTool>;
type ProcessToolInstance = ReturnType<typeof createProcessTool>;
type ExecToolArgs = Parameters<ExecToolInstance["execute"]>[1];
type ProcessToolArgs = Parameters<ProcessToolInstance["execute"]>[1];
type ExecToolConfig = Exclude<Parameters<typeof createExecTool>[0], undefined>;
type ExecToolRunOptions = Omit<ExecToolArgs, "command">;
type LabeledCase = { label: string };
const createTestExecTool = (
  defaults?: Parameters<typeof createExecTool>[0],
): ReturnType<typeof createExecTool> => createExecTool({ ...TEST_EXEC_DEFAULTS, ...defaults });
const createDisallowedElevatedExecTool = (
  defaultLevel: "off" | "on",
  overrides: Partial<ExecToolConfig> = {},
) =>
  createTestExecTool({
    elevated: { enabled: true, allowed: false, defaultLevel },
    ...overrides,
  });
const createNotifyOnExitExecTool = (overrides: Partial<ExecToolConfig> = {}) =>
  createTestExecTool({
    allowBackground: true,
    backgroundMs: 0,
    notifyOnExit: true,
    sessionKey: DEFAULT_NOTIFY_SESSION_KEY,
    ...overrides,
  });
const createScopedToolSet = (scopeKey: string) => ({
  exec: createTestExecTool({ backgroundMs: 10, scopeKey }),
  process: createProcessTool({ scopeKey }),
});
const execTool = createTestExecTool();
const processTool = createProcessTool();
const withLabel = <T extends object>(label: string, fields: T): T & LabeledCase => ({
  label,
  ...fields,
});
// Both PowerShell and bash use ; for command separation
const joinCommands = (commands: string[]) => commands.join("; ");
const normalizeText = (value?: string) =>
  sanitizeBinaryOutput(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/u, ""))
    .join("\n")
    .trim();
type ToolTextContent = Array<{ type: string; text?: string }>;
const readTextContent = (content: ToolTextContent) =>
  content.find((part) => part.type === "text")?.text;
const readNormalizedTextContent = (content: ToolTextContent) =>
  normalizeText(readTextContent(content));
const readTrimmedLines = (content: ToolTextContent) =>
  (readTextContent(content) ?? "").split("\n").map((line) => line.trim());
const waitOneTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
const readTotalLines = (details: unknown) => (details as { totalLines?: number }).totalLines;
const readProcessStatus = (details: unknown) => (details as { status?: string }).status;
const readProcessStatusOrRunning = (details: unknown) =>
  readProcessStatus(details) ?? PROCESS_STATUS_RUNNING;
const expectTextContainsValues = (
  text: string,
  values: string[] | undefined,
  shouldContain: boolean,
) => {
  if (!values) {
    return;
  }
  for (const value of values) {
    if (shouldContain) {
      expect(text).toContain(value);
    } else {
      expect(text).not.toContain(value);
    }
  }
};
type ProcessSessionSummary = { sessionId: string; name?: string };
const hasSession = (sessions: ProcessSessionSummary[], sessionId: string) =>
  sessions.some((session) => session.sessionId === sessionId);
const executeExecTool = (tool: ExecToolInstance, params: ExecToolArgs) =>
  tool.execute(nextCallId(), params);
const executeExecCommand = (
  tool: ExecToolInstance,
  command: string,
  options: ExecToolRunOptions = {},
) => executeExecTool(tool, { command, ...options });
const executeProcessTool = (tool: ProcessToolInstance, params: ProcessToolArgs) =>
  tool.execute(nextCallId(), params);
type ProcessPollResult = { status: string; output?: string };
async function listProcessSessions(tool: ProcessToolInstance) {
  const list = await executeProcessTool(tool, { action: "list" });
  return (list.details as { sessions: ProcessSessionSummary[] }).sessions;
}
async function pollProcessSession(params: {
  tool: ProcessToolInstance;
  sessionId: string;
}): Promise<ProcessPollResult> {
  const poll = await executeProcessTool(params.tool, {
    action: "poll",
    sessionId: params.sessionId,
  });
  return {
    status: readProcessStatusOrRunning(poll.details),
    output: readTextContent(poll.content),
  };
}
function applyDefaultShellEnv() {
  if (!isWin && defaultShell) {
    process.env.SHELL = defaultShell;
  }
}

function useCapturedEnv(keys: string[], afterCapture?: () => void) {
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv(keys);
    afterCapture?.();
  });

  afterEach(() => {
    envSnapshot.restore();
  });
}

async function waitForCompletion(sessionId: string) {
  let status = PROCESS_STATUS_RUNNING;
  await expect
    .poll(async () => {
      status = (await pollProcessSession({ tool: processTool, sessionId })).status;
      return status;
    }, BACKGROUND_POLL_OPTIONS)
    .not.toBe(PROCESS_STATUS_RUNNING);
  return status;
}

function requireSessionId(details: { sessionId?: string }): string {
  if (!details.sessionId) {
    throw new Error("expected sessionId in exec result details");
  }
  return details.sessionId;
}
const requireRunningSessionId = (result: { details: unknown }) => {
  expect(readProcessStatus(result.details)).toBe(PROCESS_STATUS_RUNNING);
  return requireSessionId(result.details as { sessionId?: string });
};

function hasNotifyEventForPrefix(prefix: string, sessionKey = DEFAULT_NOTIFY_SESSION_KEY): boolean {
  return peekSystemEvents(sessionKey).some((event) => event.includes(prefix));
}

async function waitForNotifyEvent(sessionId: string, sessionKey = DEFAULT_NOTIFY_SESSION_KEY) {
  const prefix = sessionId.slice(0, 8);
  let finished = getFinishedSession(sessionId);
  let hasEvent = hasNotifyEventForPrefix(prefix, sessionKey);
  await expect
    .poll(() => {
      finished = getFinishedSession(sessionId);
      hasEvent = hasNotifyEventForPrefix(prefix, sessionKey);
      return Boolean(finished && hasEvent);
    }, NOTIFY_POLL_OPTIONS)
    .toBe(true);
  return {
    finished: finished ?? getFinishedSession(sessionId),
    hasEvent: hasEvent || hasNotifyEventForPrefix(prefix),
  };
}

async function startBackgroundCommand(tool: ExecToolInstance, command: string) {
  const result = await executeExecCommand(tool, command, { background: true });
  return requireRunningSessionId(result);
}

async function expectNotifyOnExitWake(tool: ExecToolInstance, expected: Record<string, unknown>) {
  const wakeHandler = vi.fn().mockResolvedValue({ status: "skipped", reason: "disabled" });
  const dispose = setHeartbeatWakeHandler(
    wakeHandler as unknown as Parameters<typeof setHeartbeatWakeHandler>[0],
  );
  try {
    await startBackgroundCommand(tool, shellEcho("notify"));
    await expect
      .poll(() => wakeHandler.mock.calls.at(0)?.[0], NOTIFY_POLL_OPTIONS)
      .toEqual(expected);
  } finally {
    dispose();
  }
}

async function drainNotifyEvents(sessionKey = DEFAULT_NOTIFY_SESSION_KEY) {
  return await drainFormattedSystemEvents({
    cfg: notifyCfg,
    sessionKey,
    isMainSession: false,
    isNewSession: false,
  });
}

async function runBackgroundCommandToCompletion(tool: ExecToolInstance, command: string) {
  const sessionId = await startBackgroundCommand(tool, command);
  const status = await waitForCompletion(sessionId);
  return { sessionId, status };
}

type ProcessLogWindow = { offset?: number; limit?: number };
async function readProcessLog(sessionId: string, options: ProcessLogWindow = {}) {
  return executeProcessTool(processTool, {
    action: "log",
    sessionId,
    ...options,
  });
}

const LONG_LOG_LINE_COUNT = 201;
type LongLogExpectationCase = LabeledCase & {
  options?: ProcessLogWindow;
  firstLine: string;
  lastLine?: string;
  mustContain?: string[];
  mustNotContain?: string[];
};
type ShortLogExpectationCase = LabeledCase & {
  lines: string[];
  options: ProcessLogWindow;
  expectedText: string;
  expectedTotalLines: number;
};
type ProcessLogSnapshot = {
  text: string;
  normalizedText: string;
  lines: string[];
  totalLines: number | undefined;
};
const EXPECTED_TOTAL_LINES_THREE = 3;
type DisallowedElevationCase = LabeledCase & {
  defaultLevel: "off" | "on";
  overrides?: Partial<ExecToolConfig>;
  requestElevated?: boolean;
  expectedError?: string;
  expectedOutputIncludes?: string;
};
type NotifyNoopCase = LabeledCase & {
  notifyOnExitEmptySuccess: boolean;
};
const NOOP_NOTIFY_CASES: NotifyNoopCase[] = [
  withLabel("default behavior skips no-op completion events", { notifyOnExitEmptySuccess: false }),
  withLabel("explicitly enabling no-op completion emits completion events", {
    notifyOnExitEmptySuccess: true,
  }),
];
const DISALLOWED_ELEVATION_CASES: DisallowedElevationCase[] = [
  withLabel("rejects elevated requests when not allowed", {
    defaultLevel: "off",
    overrides: {
      messageProvider: "telegram",
      sessionKey: DEFAULT_NOTIFY_SESSION_KEY,
    },
    requestElevated: true,
    expectedError: "Context: provider=telegram session=agent:main:main",
  }),
  withLabel("does not default to elevated when not allowed", {
    defaultLevel: "on",
    overrides: {
      backgroundMs: 1000,
      timeoutSec: 5,
    },
    expectedOutputIncludes: "hi",
  }),
];
const SHORT_LOG_EXPECTATION_CASES: ShortLogExpectationCase[] = [
  withLabel("logs line-based slices and defaults to last lines", {
    lines: ["one", "two", "three"],
    options: { limit: 2 },
    expectedText: "two\nthree",
    expectedTotalLines: EXPECTED_TOTAL_LINES_THREE,
  }),
  withLabel("supports line offsets for log slices", {
    lines: ["alpha", "beta", "gamma"],
    options: { offset: 1, limit: 1 },
    expectedText: "beta",
    expectedTotalLines: EXPECTED_TOTAL_LINES_THREE,
  }),
];
const LONG_LOG_EXPECTATION_CASES: LongLogExpectationCase[] = [
  withLabel("applies default tail only when no explicit log window is provided", {
    firstLine: "line-2",
    mustContain: ["showing last 200 of 201 lines", "line-2", "line-201"],
  }),
  withLabel("keeps offset-only log requests unbounded by default tail mode", {
    options: { offset: 30 },
    firstLine: "line-31",
    lastLine: "line-201",
    mustNotContain: ["showing last 200"],
  }),
];
const expectNotifyNoopEvents = (
  events: string[],
  notifyOnExitEmptySuccess: boolean,
  sessionId: string,
  label: string,
) => {
  if (!notifyOnExitEmptySuccess) {
    expect(events, label).toStrictEqual([]);
    return;
  }
  expect(events, label).toStrictEqual([
    `${OUTPUT_EXEC_COMPLETED} (${sessionId.slice(0, 8)}, code 0)`,
  ]);
};
const runDisallowedElevationCase = async ({
  defaultLevel,
  overrides,
  requestElevated,
  expectedError,
  expectedOutputIncludes,
}: DisallowedElevationCase) => {
  const customBash = createDisallowedElevatedExecTool(defaultLevel, overrides);
  if (expectedError) {
    await expect(
      executeExecCommand(customBash, ECHO_HI_COMMAND, { elevated: requestElevated }),
    ).rejects.toThrow(expectedError);
    return;
  }

  const result = await executeExecCommand(customBash, ECHO_HI_COMMAND);
  if (expectedOutputIncludes === undefined) {
    throw new Error("expected text assertion value");
  }
  expect(readTextContent(result.content) ?? "").toContain(expectedOutputIncludes);
};
const runShortLogExpectationCase = async ({
  lines,
  options,
  expectedText,
  expectedTotalLines,
}: ShortLogExpectationCase) => {
  const snapshot = await readBackgroundLogSnapshot(lines, options);
  expect(snapshot.normalizedText).toBe(expectedText);
  expect(snapshot.totalLines).toBe(expectedTotalLines);
};
const readBackgroundLogSnapshot = async (
  lines: string[],
  options: ProcessLogWindow = {},
): Promise<ProcessLogSnapshot> => {
  const sessionId = seedFinishedLogSession(lines);
  const log = await readProcessLog(sessionId, options);
  return {
    text: readTextContent(log.content) ?? "",
    normalizedText: readNormalizedTextContent(log.content),
    lines: readTrimmedLines(log.content),
    totalLines: readTotalLines(log.details),
  };
};
const seedFinishedLogSession = (lines: string[]) => {
  const session: ProcessSession = {
    id: `seeded-log-${nextCallId()}`,
    command: "seeded log",
    startedAt: Date.now(),
    maxOutputChars: 100_000,
    pendingMaxOutputChars: 100_000,
    pendingStdout: [],
    pendingStderr: [],
    pendingStdoutChars: 0,
    pendingStderrChars: 0,
    totalOutputChars: 0,
    aggregated: "",
    tail: "",
    exited: false,
    truncated: false,
    backgrounded: false,
    cursorKeyMode: "unknown",
  };
  addSession(session);
  appendOutput(session, "stdout", lines.join("\n"));
  markBackgrounded(session);
  markExited(session, 0, null, PROCESS_STATUS_COMPLETED);
  return session.id;
};
const runLongLogExpectationCase = async ({
  options,
  firstLine,
  lastLine,
  mustContain,
  mustNotContain,
}: LongLogExpectationCase) => {
  const snapshot = await readBackgroundLogSnapshot(
    Array.from({ length: LONG_LOG_LINE_COUNT }, (_value, index) => `line-${index + 1}`),
    options,
  );
  expect(snapshot.lines[0]).toBe(firstLine);
  if (lastLine) {
    expect(snapshot.lines[snapshot.lines.length - 1]).toBe(lastLine);
  }
  expect(snapshot.totalLines).toBe(LONG_LOG_LINE_COUNT);
  expectTextContainsValues(snapshot.text, mustContain, true);
  expectTextContainsValues(snapshot.text, mustNotContain, false);
};
const runNotifyNoopCase = async ({ label, notifyOnExitEmptySuccess }: NotifyNoopCase) => {
  const tool = createNotifyOnExitExecTool(
    notifyOnExitEmptySuccess ? { notifyOnExitEmptySuccess: true } : {},
  );

  const { sessionId, status } = await runBackgroundCommandToCompletion(tool, COMMAND_NOOP);
  expect(status).toBe(PROCESS_STATUS_COMPLETED);
  const events = peekSystemEvents(DEFAULT_NOTIFY_SESSION_KEY);
  expectNotifyNoopEvents(events, notifyOnExitEmptySuccess, sessionId, label);
};

describe("tool descriptions", () => {
  it("adds cron-specific deferred follow-up guidance only when cron is available", () => {
    const execWithCron = createTestExecTool({ hasCronTool: true });
    const processWithCron = createProcessTool({ hasCronTool: true });

    expect(execWithCron.description).toContain(
      "rely on automatic completion wake when it is enabled and the command emits output or fails; otherwise use process to confirm completion. Use process whenever you need logs, status, input, or intervention.",
    );
    expect(processWithCron.description).toContain(
      "completion confirmation when automatic completion wake is unavailable.",
    );
    expect(processWithCron.description).toContain(
      "Use write/send-keys/submit/paste/kill for input or intervention.",
    );
    expect(execWithCron.description).toContain(
      "Do not use exec sleep or delay loops for reminders or deferred follow-ups; use cron instead.",
    );
    expect(processWithCron.description).toContain(
      "Do not use process polling to emulate timers or reminders; use cron for scheduled follow-ups.",
    );
    expect(execTool.description).not.toContain("use cron instead");
    expect(processTool.description).not.toContain("scheduled follow-ups");
    expect(execTool.description).toContain("otherwise use process to confirm completion");
    expect(processTool.description).toContain(
      "completion confirmation when automatic completion wake is unavailable",
    );
    expect(processTool.description).toContain(
      "Use write/send-keys/submit/paste/kill for input or intervention.",
    );
  });
});

beforeEach(() => {
  callIdCounter = 0;
  resetProcessRegistryForTests();
  resetSystemEventsForTest();
});

describe("exec tool backgrounding", () => {
  useCapturedEnv([...SHELL_ENV_KEYS], applyDefaultShellEnv);

  it(
    "backgrounds after yield and can be polled",
    async () => {
      const result = await executeExecCommand(execTool, shellEcho(OUTPUT_DONE), { yieldMs: 0 });

      // Timing can race here: command may already be complete before the first response.
      if (result.details.status === PROCESS_STATUS_COMPLETED) {
        expect(readTextContent(result.content) ?? "").toContain(OUTPUT_DONE);
        return;
      }

      const sessionId = requireRunningSessionId(result);

      let output = "";
      await expect
        .poll(async () => {
          const pollResult = await pollProcessSession({ tool: processTool, sessionId });
          output = pollResult.output ?? "";
          return pollResult.status;
        }, BACKGROUND_POLL_OPTIONS)
        .toBe(PROCESS_STATUS_COMPLETED);

      expect(output).toContain(OUTPUT_DONE);
    },
    isWin ? 15_000 : 5_000,
  );

  it("supports explicit background and derives session name from the command", async () => {
    const sessionId = await startBackgroundCommand(execTool, COMMAND_ECHO_HELLO);

    const sessions = await listProcessSessions(processTool);
    expect(hasSession(sessions, sessionId)).toBe(true);
    expect(sessions.find((s) => s.sessionId === sessionId)?.name).toBe(COMMAND_ECHO_HELLO);
  });

  it.each<DisallowedElevationCase>(DISALLOWED_ELEVATION_CASES)(
    "$label",
    runDisallowedElevationCase,
  );

  it.each<ShortLogExpectationCase>(SHORT_LOG_EXPECTATION_CASES)(
    "$label",
    runShortLogExpectationCase,
  );

  it.each<LongLogExpectationCase>(LONG_LOG_EXPECTATION_CASES)("$label", runLongLogExpectationCase);
  it("scopes process sessions by scopeKey", async () => {
    const alphaTools = createScopedToolSet(SCOPE_KEY_ALPHA);
    const betaTools = createScopedToolSet(SCOPE_KEY_BETA);

    const sessionA = await startBackgroundCommand(alphaTools.exec, shortDelayCmd);
    const sessionB = await startBackgroundCommand(betaTools.exec, shortDelayCmd);

    const sessionsA = await listProcessSessions(alphaTools.process);
    expect(hasSession(sessionsA, sessionA)).toBe(true);
    expect(hasSession(sessionsA, sessionB)).toBe(false);

    const pollB = await pollProcessSession({
      tool: betaTools.process,
      sessionId: sessionA,
    });
    expect(pollB.status).toBe(PROCESS_STATUS_FAILED);
  });
});

describe("exec exit codes", () => {
  useCapturedEnv([...SHELL_ENV_KEYS], applyDefaultShellEnv);

  it("treats non-zero exits as completed and appends exit code", async () => {
    const command = joinCommands([shellEcho(OUTPUT_NOPE), COMMAND_EXIT_WITH_ERROR]);
    const result = await executeExecCommand(execTool, command);
    const resultDetails = result.details as { status?: string; exitCode?: number | null };
    expect(readProcessStatus(resultDetails)).toBe(PROCESS_STATUS_COMPLETED);
    expect(resultDetails.exitCode).toBe(1);

    const text = readNormalizedTextContent(result.content);
    expect(text).toContain(OUTPUT_NOPE);
    expect(text).toContain(OUTPUT_EXIT_CODE_1);
  });
});

describe("exec notifyOnExit", () => {
  beforeEach(() => {
    resetHeartbeatWakeStateForTests();
  });

  afterEach(() => {
    resetHeartbeatWakeStateForTests();
  });

  it("enqueues a system event when a backgrounded exec exits", async () => {
    const tool = createNotifyOnExitExecTool();

    const sessionId = await startBackgroundCommand(tool, shellEcho("notify"));

    const { finished, hasEvent } = await waitForNotifyEvent(sessionId);
    const queuedEvent = peekSystemEventEntries(DEFAULT_NOTIFY_SESSION_KEY).find((event) =>
      event.text.includes(sessionId.slice(0, 8)),
    );
    const formatted = await drainNotifyEvents();

    expect(finished?.id).toBe(sessionId);
    expect(finished?.status).toBe(PROCESS_STATUS_COMPLETED);
    expect(finished?.exitCode).toBe(0);
    expect(hasEvent).toBe(true);
    expect(queuedEvent?.trusted).toBe(false);
    expect(formatted).toBeUndefined();
  });

  it("preserves the origin delivery context on background exec completion events", async () => {
    const sessionKey = "agent:main:telegram:group:-1003774691294:topic:47";
    const tool = createNotifyOnExitExecTool({
      sessionKey,
      messageProvider: "telegram",
      currentChannelId: "telegram:-1003774691294:topic:47",
      currentThreadTs: "47",
    });

    const sessionId = await startBackgroundCommand(tool, shellEcho("notify"));

    await waitForNotifyEvent(sessionId, sessionKey);
    const queuedEvent = peekSystemEventEntries(sessionKey).find((event) =>
      event.text.includes(sessionId.slice(0, 8)),
    );

    expect(queuedEvent?.trusted).toBe(false);
    expect(queuedEvent?.deliveryContext?.channel).toBe("telegram");
    expect(queuedEvent?.deliveryContext?.to).toBe("telegram:-1003774691294:topic:47");
    expect(queuedEvent?.deliveryContext?.threadId).toBe("47");
  });

  it("scopes notifyOnExit heartbeat wake to the exec session key", async () => {
    await expectNotifyOnExitWake(createNotifyOnExitExecTool(), {
      source: "exec-event",
      intent: "event",
      reason: "exec-event",
      sessionKey: DEFAULT_NOTIFY_SESSION_KEY,
    });
  });

  it("keeps notifyOnExit heartbeat wake unscoped for non-agent session keys", async () => {
    await expectNotifyOnExitWake(createNotifyOnExitExecTool({ sessionKey: "global" }), {
      source: "exec-event",
      intent: "event",
      reason: "exec-event",
    });
  });

  it.each<NotifyNoopCase>(NOOP_NOTIFY_CASES)("$label", runNotifyNoopCase);
});

describe("exec PATH handling", () => {
  useCapturedEnv([...PATH_SHELL_ENV_KEYS], applyDefaultShellEnv);

  it("prepends configured path entries", async () => {
    const basePath = isWin ? "C:\\Windows\\System32" : "/usr/bin";
    const prepend = isWin ? ["C:\\custom\\bin", "C:\\oss\\bin"] : ["/custom/bin", "/opt/oss/bin"];
    process.env.PATH = basePath;

    const tool = createTestExecTool({ pathPrepend: prepend });
    const result = await executeExecCommand(tool, COMMAND_PRINT_PATH);

    const text = readNormalizedTextContent(result.content);
    const entries = text.split(path.delimiter);
    const prependIndexes = prepend.map((entry) => entries.indexOf(entry));
    for (const index of prependIndexes) {
      expect(index).toBeGreaterThanOrEqual(0);
    }
    for (let i = 1; i < prependIndexes.length; i += 1) {
      expect(prependIndexes[i]).toBeGreaterThan(prependIndexes[i - 1]);
    }
    const baseIndex = entries.indexOf(basePath);
    expect(baseIndex).toBeGreaterThanOrEqual(0);
    for (const index of prependIndexes) {
      expect(index).toBeLessThan(baseIndex);
    }
  });
});

describe("findPathKey", () => {
  it("returns PATH when key is uppercase", () => {
    expect(findPathKey({ PATH: "/usr/bin" })).toBe("PATH");
  });

  it("returns Path when key is mixed-case (Windows style)", () => {
    expect(findPathKey({ Path: "C:\\Windows\\System32" })).toBe("Path");
  });

  it("returns PATH as default when no PATH-like key exists", () => {
    expect(findPathKey({ HOME: "/home/user" })).toBe("PATH");
  });

  it("prefers uppercase PATH when both PATH and Path exist", () => {
    expect(findPathKey({ PATH: "/usr/bin", Path: "C:\\Windows" })).toBe("PATH");
  });
});

describe("applyPathPrepend with case-insensitive PATH key", () => {
  it("prepends to Path key on Windows-style env (no uppercase PATH)", () => {
    const env: Record<string, string> = { Path: "C:\\Windows\\System32" };
    applyPathPrepend(env, ["C:\\custom\\bin"]);
    // Should write back to the same `Path` key, not create a new `PATH`
    expect(env.Path).toContain("C:\\custom\\bin");
    expect(env.Path).toContain("C:\\Windows\\System32");
    expect("PATH" in env).toBe(false);
  });

  it("preserves all existing entries when prepending via Path key", () => {
    // Use platform-appropriate paths and delimiters
    const delim = path.delimiter;
    const existing = isWin
      ? ["C:\\Windows\\System32", "C:\\Windows", "C:\\Program Files\\nodejs"]
      : ["/usr/bin", "/usr/local/bin", "/opt/node/bin"];
    const prepend = isWin ? ["C:\\custom\\bin"] : ["/custom/bin"];
    const existingPath = existing.join(delim);
    const env: Record<string, string> = { Path: existingPath };
    applyPathPrepend(env, prepend);
    const parts = env.Path.split(delim);
    expect(parts[0]).toBe(prepend[0]);
    for (const entry of existing) {
      expect(parts).toContain(entry);
    }
  });

  it("respects requireExisting option with Path key", () => {
    const env: Record<string, string> = { HOME: "/home/user" };
    applyPathPrepend(env, ["C:\\custom\\bin"], { requireExisting: true });
    // No Path/PATH key exists, so nothing should be written
    expect("PATH" in env).toBe(false);
    expect("Path" in env).toBe(false);
  });
});

describe("exec backgrounded onUpdate suppression", () => {
  useCapturedEnv([...SHELL_ENV_KEYS], applyDefaultShellEnv);

  it(
    "does not invoke onUpdate after the session is backgrounded",
    async () => {
      const onUpdateSpy = vi.fn();
      const tool = createTestExecTool({ allowBackground: true, backgroundMs: 0 });
      const command = joinCommands([shellEcho("before"), shortDelayCmd, shellEcho("after")]);
      const result = await tool.execute(
        nextCallId(),
        { command, background: true },
        undefined,
        onUpdateSpy,
      );

      expect(readProcessStatus(result.details)).toBe(PROCESS_STATUS_RUNNING);
      const sessionId = requireSessionId(result.details as { sessionId?: string });
      const callsBeforeBackground = onUpdateSpy.mock.calls.length;
      await expect
        .poll(() => {
          const finished = getFinishedSession(sessionId);
          return Boolean(finished);
        }, BACKGROUND_POLL_OPTIONS)
        .toBe(true);
      expect(onUpdateSpy.mock.calls.length).toBe(callsBeforeBackground);
    },
    isWin ? 15_000 : 5_000,
  );

  it(
    "does not invoke onUpdate after the foreground exec process exits",
    async () => {
      const onUpdateSpy = vi.fn();
      // Run a foreground command that produces output then exits.
      const command = joinCommands([shellEcho("line1"), shellEcho("line2")]);
      await execTool.execute(nextCallId(), { command }, undefined, onUpdateSpy);
      const callsAtExit = onUpdateSpy.mock.calls.length;
      // Allow a tick for any straggling stdout data events.
      await waitOneTurn();
      expect(onUpdateSpy.mock.calls.length).toBe(callsAtExit);
    },
    isWin ? 10_000 : 5_000,
  );

  it(
    "suppresses onUpdate after abort signal fires",
    async () => {
      const onUpdateSpy = vi.fn();
      const abortController = new AbortController();
      // Run a command that produces output over time.
      const command = joinCommands([
        shellEcho("before-abort"),
        shortDelayCmd,
        shellEcho("after-abort"),
      ]);
      // Abort almost immediately so the signal fires while the command
      // is still producing output.
      setImmediate(() => abortController.abort());
      await execTool.execute(nextCallId(), { command }, abortController.signal, onUpdateSpy);
      const callsAtAbort = onUpdateSpy.mock.calls.length;
      // Allow a tick for any straggling stdout data events.
      await waitOneTurn();
      // After abort, no new onUpdate calls should have been made.
      expect(onUpdateSpy.mock.calls.length).toBe(callsAtAbort);
    },
    isWin ? 10_000 : 5_000,
  );
});

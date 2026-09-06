// Tests bash command status replies and active-process cancellation.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  enqueueSystemEventEntry,
  enqueueSystemEventWithReceipt,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "../../infra/system-events.js";
import { withStateDirEnv } from "../../test-helpers/state-dir-env.js";
import type { MsgContext } from "../templating.js";

const {
  cancelBackgroundExecSessionMock,
  createExecToolMock,
  getFinishedSessionMock,
  getSessionMock,
} = vi.hoisted(() => ({
  cancelBackgroundExecSessionMock: vi.fn(),
  createExecToolMock: vi.fn(),
  getSessionMock: vi.fn(),
  getFinishedSessionMock: vi.fn(),
}));

vi.mock("../../agents/bash-process-control.js", () => ({
  cancelBackgroundExecSession: cancelBackgroundExecSessionMock,
}));

vi.mock("../../agents/bash-process-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/bash-process-registry.js")>()),
  getSession: getSessionMock,
  getFinishedSession: getFinishedSessionMock,
}));

vi.mock("../../agents/bash-tools.js", () => ({
  createExecTool: createExecToolMock,
}));

const { handleBashChatCommand } = await import("./bash-command.js");

function buildParams(commandBody: string) {
  const cfg = {
    commands: { bash: true },
  } as OpenClawConfig;

  const ctx = {
    CommandBody: commandBody,
    commandText: commandBody,
    SessionKey: "session-key",
  } as MsgContext;

  return {
    ctx,
    cfg,
    sessionKey: "session-key",
    isGroup: false,
    elevated: {
      enabled: true,
      allowed: true,
      failures: [],
    },
  };
}

function buildElevatedDeniedParams(commandBody: string) {
  const base = buildParams(commandBody);
  return {
    ...base,
    ctx: {
      ...base.ctx,
      SessionKey: "agent:main:telegram:slash-session",
    } as MsgContext,
    agentId: "target",
    sessionKey: "agent:target:telegram:direct:target-session",
    elevated: {
      enabled: true,
      allowed: false,
      failures: [],
    },
  };
}

function buildRunningSession(overrides?: Record<string, unknown>) {
  return {
    id: "session-1",
    scopeKey: "chat:bash",
    backgrounded: true,
    pid: 4242,
    exited: false,
    startedAt: Date.now(),
    tail: "",
    ...overrides,
  };
}

function backgroundExecResult(sessionId: string) {
  return {
    content: [],
    details: { status: "running", sessionId, startedAt: Date.now() },
  };
}

describe("handleBashChatCommand", () => {
  afterEach(() => resetSystemEventsForTest());

  beforeEach(() => {
    getSessionMock.mockReset();
    getFinishedSessionMock.mockReset();
    cancelBackgroundExecSessionMock.mockReset();
    cancelBackgroundExecSessionMock.mockReturnValue(true);
    createExecToolMock.mockReset();
  });

  it.each([
    { status: "completed", exitCode: 0, exitSignal: null, label: "code 0" },
    { status: "completed", exitCode: 1, exitSignal: null, label: "code 1" },
    { status: "failed", exitCode: 127, exitSignal: null, label: "code 127" },
    { status: "failed", exitCode: null, exitSignal: "SIGTERM", label: "signal SIGTERM" },
  ])("reports foreground $status as $label without losing diagnostics", async (outcome) => {
    createExecToolMock.mockReturnValue({
      execute: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "execution diagnostic" }],
        details: { ...outcome, aggregated: "execution diagnostic" },
      }),
    });

    const result = await handleBashChatCommand(buildParams("/bash command"));

    expect(result.text).toContain(`Exit: ${outcome.label}`);
    expect(result.text).toContain("execution diagnostic");
  });

  it.each([
    { exitCode: null, exitSignal: "SIGTERM", label: "signal SIGTERM" },
    { exitCode: null, exitSignal: null, label: "unknown exit code" },
  ])("reports a retained process's $label without acknowledging delivery", async (outcome) => {
    const eventOptions = { sessionKey: "session-key", contextKey: "exec:finished-status" };
    const previous = enqueueSystemEventEntry("retained diagnostic", eventOptions);
    getFinishedSessionMock.mockReturnValue({
      id: "finished-status",
      scopeKey: "chat:bash",
      terminalStatus: "failed",
      aggregated: "retained diagnostic",
      notifyOnExitRemoval: enqueueSystemEventWithReceipt("retained diagnostic", eventOptions, {
        allowDuplicate: true,
      }),
      ...outcome,
    });
    expect(peekSystemEventEntries("session-key")).toHaveLength(2);

    const result = await handleBashChatCommand(buildParams("!poll finished-status"));

    expect(result.text).toContain(`Exit: ${outcome.label}`);
    expect(result.text).toContain("retained diagnostic");
    expect(peekSystemEventEntries("session-key")).toHaveLength(2);
    expect(peekSystemEventEntries("session-key")).toContainEqual(previous);

    await handleBashChatCommand(buildParams("!poll finished-status"));
    expect(peekSystemEventEntries("session-key")).toHaveLength(2);
  });

  it("returns immediately after canonical cancellation is admitted", async () => {
    const session = buildRunningSession();
    getSessionMock.mockReturnValue(session);
    getFinishedSessionMock.mockReturnValue(undefined);

    const result = await handleBashChatCommand(buildParams("/bash stop session-1"));

    expect(result.text).toContain("bash stopping");
    expect(result.text).toContain("!poll session-1");
    expect(cancelBackgroundExecSessionMock).toHaveBeenCalledWith("session-1");
    expect(session.exited).toBe(false);
  });

  it("includes the full session ID so the user can poll after starting a new job", async () => {
    const session = buildRunningSession({ id: "deep-forest-42" });
    getSessionMock.mockReturnValue(session);
    getFinishedSessionMock.mockReturnValue(undefined);

    const result = await handleBashChatCommand(buildParams("/bash stop deep-forest-42"));

    expect(result.text).toContain("!poll deep-forest-42");
  });

  it("returns no-running-job when session is not found", async () => {
    getSessionMock.mockReturnValue(undefined);
    getFinishedSessionMock.mockReturnValue(undefined);

    const result = await handleBashChatCommand(buildParams("/bash stop session-1"));

    expect(result.text).toContain("No running bash job found");
    expect(cancelBackgroundExecSessionMock).not.toHaveBeenCalled();
  });

  it("does not split boundary emoji in missing session snippets", async () => {
    getSessionMock.mockReturnValue(undefined);
    getFinishedSessionMock.mockReturnValue(undefined);

    const result = await handleBashChatCommand(buildParams("/bash stop 1234567😀tail"));

    expect(result.text).toBe("⚙️ No running bash job found for 1234567….");
  });

  it("returns actionable guidance when canonical cancellation is not admitted", async () => {
    const session = buildRunningSession();
    getSessionMock.mockReturnValue(session);
    getFinishedSessionMock.mockReturnValue(undefined);
    cancelBackgroundExecSessionMock.mockReturnValue(false);

    const result = await handleBashChatCommand(buildParams("/bash stop session-1"));

    expect(result.text).toContain("Unable to stop bash session");
    expect(result.text).toContain("!poll session-1");
    expect(result.text).toContain("no active cancellation handle");
    expect(cancelBackgroundExecSessionMock).toHaveBeenCalledWith("session-1");
  });

  it("clears active job state from registry lifecycle without a child watcher", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce(backgroundExecResult("session-first"))
      .mockResolvedValueOnce(backgroundExecResult("session-second"));
    createExecToolMock.mockReturnValue({ execute });
    getSessionMock.mockReturnValue(undefined);
    getFinishedSessionMock.mockReturnValue(undefined);

    await handleBashChatCommand(buildParams("/bash first"));
    const firstSession = buildRunningSession({ id: "session-first" });
    getSessionMock.mockReturnValue(firstSession);
    await handleBashChatCommand(buildParams("/bash stop"));
    expect(cancelBackgroundExecSessionMock).toHaveBeenCalledWith("session-first");

    getSessionMock.mockReturnValue(undefined);
    getFinishedSessionMock.mockReturnValue({
      id: "session-first",
      scopeKey: "chat:bash",
      terminalStatus: "failed",
    });
    const restarted = await handleBashChatCommand(buildParams("/bash second"));
    expect(restarted.text).toContain("session-second");
    expect(execute).toHaveBeenCalledTimes(2);

    getFinishedSessionMock.mockReturnValue(undefined);
    await handleBashChatCommand(buildParams("/bash help"));
  });

  it("passes the global session's prepared owner to exec", async () => {
    createExecToolMock.mockReturnValue({
      execute: vi.fn().mockResolvedValue({
        content: [],
        details: { status: "completed", exitCode: 0, aggregated: "done" },
      }),
    });
    const params = buildParams("/bash echo done");
    const result = await handleBashChatCommand({
      ...params,
      agentId: "target",
      sessionKey: "global",
      ctx: {
        ...params.ctx,
        RuntimePolicySessionKey: "agent:main:telegram:direct:policy-session",
      },
    });

    expect(result.text).toContain("Exit: code 0");
    expect(createExecToolMock).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "target", sessionKey: "global" }),
    );
  });

  it.each([
    {
      sessionKey: "agent:target:telegram:direct:target-session",
      policySessionKey: undefined,
      runtime: "sandboxed",
    },
    { sessionKey: "global", policySessionKey: undefined, runtime: "sandboxed" },
    {
      sessionKey: "global",
      policySessionKey: "agent:main:telegram:direct:policy-session",
      runtime: "direct",
    },
  ])(
    "explains elevated denial for $sessionKey with policy $policySessionKey",
    async ({ sessionKey, policySessionKey, runtime }) => {
      await withStateDirEnv("bash-denied-owner-", async () => {
        const params = buildElevatedDeniedParams("/bash pwd");
        params.sessionKey = sessionKey;
        params.ctx.RuntimePolicySessionKey = policySessionKey;
        params.cfg = {
          commands: { bash: true },
          agents: {
            ownership: "explicit",
            entries: {
              target: { sandbox: { mode: "all" } },
              main: { sandbox: { mode: "off" } },
            },
          },
        };
        const result = await handleBashChatCommand(params);

        expect(result.text).toContain(`elevated is not available right now (runtime=${runtime})`);
        expect(result.text).toContain(`openclaw sandbox explain --session ${sessionKey}`);
        expect(result.text).not.toContain("agent:main:telegram:slash-session");
        expect(createExecToolMock).not.toHaveBeenCalled();
      });
    },
  );
});

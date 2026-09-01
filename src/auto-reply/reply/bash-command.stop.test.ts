// Tests chat bash outcome projection and active-process cancellation.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appendExecTimeoutRetryGuidance } from "../../agents/bash-tools.exec-output.js";
import { buildExecForegroundResult } from "../../agents/bash-tools.exec-support.js";
import type { ExecToolDetails } from "../../agents/bash-tools.exec-types.js";
import type { OpenClawConfig } from "../../config/config.js";
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

vi.mock("../../agents/bash-process-registry.js", () => ({
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
  beforeEach(() => {
    getSessionMock.mockReset();
    getFinishedSessionMock.mockReset();
    cancelBackgroundExecSessionMock.mockReset();
    cancelBackgroundExecSessionMock.mockReturnValue(true);
    createExecToolMock.mockReset();
  });

  describe.each(["/bash", "!"])("%s outcomes", (alias) => {
    it.each<
      [
        string,
        "completed" | "failed",
        number | null,
        NodeJS.Signals | number | null,
        string,
        string,
      ]
    >([
      ["completed zero", "completed", 0, null, "⚙️", "code 0"],
      ["completed nonzero", "completed", 1, null, "⚙️", "code 1"],
      ["shell not executable", "failed", 126, null, "⚠️", "code 126"],
      ["shell not found", "failed", 127, null, "⚠️", "code 127"],
      ["failed zero", "failed", 0, null, "⚠️", "code 0"],
      ["failed unknown", "failed", null, null, "⚠️", "unknown exit code"],
      ["completed unknown", "completed", null, null, "⚙️", "unknown exit code"],
      ["signal", "failed", null, "SIGTERM", "⚠️", "signal SIGTERM"],
      ["numeric signal", "failed", 0, 9, "⚠️", "signal 9"],
    ])(
      "preserves %s in foreground and explicit poll",
      async (_, status, exitCode, exitSignal, prefix, exitLabel) => {
        const details = {
          status,
          exitCode,
          exitSignal,
          durationMs: 1,
          aggregated: "retained output",
        } satisfies ExecToolDetails;
        const execute = vi.fn().mockResolvedValue({
          content: [{ type: "text", text: "producer guidance\nretained output" }],
          details,
        });
        createExecToolMock.mockReturnValue({ execute });

        const foreground = await handleBashChatCommand(buildParams(`${alias} command`));
        getFinishedSessionMock.mockReturnValue({
          ...details,
          id: "finished-job",
          scopeKey: "chat:bash",
          terminalStatus: status,
          tail: "tail",
        });
        const polled = await handleBashChatCommand(buildParams(`${alias} poll finished-job`));
        const next = await handleBashChatCommand(buildParams(`${alias} next`));

        for (const reply of [foreground, polled, next]) {
          expect.soft(reply.text).toMatch(new RegExp(`^${prefix}`));
          expect.soft(reply.text).toContain(`\nExit: ${exitLabel}\n`);
          expect.soft(reply.text).toContain("retained output");
        }
        expect(foreground.text).toContain("producer guidance");
        expect(polled.text).toContain("bash finished (session finished-job)");
        expect(next.text).toContain("bash: next");
        expect(execute).toHaveBeenCalledTimes(2);
      },
    );

    it("preserves completed producer warnings and retention disclosures", async () => {
      const result = buildExecForegroundResult({
        outcome: {
          status: "completed",
          exitCode: 0,
          exitSignal: null,
          durationMs: 1,
          aggregated: "retained output",
          timedOut: false,
        },
        warningText: "Warning: continuation options are unavailable; running synchronously.",
        aggregateOutputDropped: true,
      });
      createExecToolMock.mockReturnValue({ execute: vi.fn().mockResolvedValue(result) });

      const reply = await handleBashChatCommand(buildParams(`${alias} command`));

      expect(reply.text).toContain(
        "[earlier output was discarded at the retention cap and cannot be recovered]",
      );
      expect(reply.text).toContain(
        "Warning: continuation options are unavailable; running synchronously.",
      );
      expect(reply.text).toContain("retained output");
    });

    it("preserves producer failure guidance without reducing it to aggregate output", async () => {
      const result = buildExecForegroundResult({
        outcome: {
          status: "failed",
          exitCode: null,
          exitSignal: "SIGKILL",
          exitReason: "signal",
          failureKind: "signal",
          oomScoreWrapperSelected: true,
          durationMs: 1,
          aggregated: "partial output",
          timedOut: false,
          reason: "partial output\n\nCommand aborted by signal SIGKILL",
        },
      });
      createExecToolMock.mockReturnValue({ execute: vi.fn().mockResolvedValue(result) });

      const reply = await handleBashChatCommand(buildParams(`${alias} command`));

      expect(reply.text).toMatch(/^⚠️/);
      expect(reply.text).toContain("Exit: signal SIGKILL");
      expect(reply.text).toContain("Command aborted by signal SIGKILL");
      expect(reply.text).toContain("SIGKILL alone does not identify");
      expect(reply.text).toContain("Check cgroup memory events or kernel logs.");
    });

    it.each(["overall-timeout", "no-output-timeout"] as const)(
      "keeps %s retry guidance in foreground and explicit polling",
      async (exitReason) => {
        const result = buildExecForegroundResult({
          outcome: {
            status: "failed",
            exitCode: null,
            exitSignal: "SIGTERM",
            exitReason,
            failureKind: exitReason,
            durationMs: 1,
            aggregated: "partial output",
            timedOut: true,
            reason: appendExecTimeoutRetryGuidance(
              "partial output\n\nCommand timed out.",
              exitReason,
            ),
          },
        });
        createExecToolMock.mockReturnValue({ execute: vi.fn().mockResolvedValue(result) });
        const foreground = await handleBashChatCommand(buildParams(`${alias} command`));
        getFinishedSessionMock.mockReturnValue({
          id: "timed-out",
          scopeKey: "chat:bash",
          terminalStatus: "failed",
          exitCode: null,
          exitSignal: "SIGTERM",
          exitReason,
          aggregated: "partial output",
          tail: "output",
        });

        const polled = await handleBashChatCommand(buildParams(`${alias} poll timed-out`));

        for (const reply of [foreground, polled]) {
          expect.soft(reply.text).toMatch(/^⚠️/);
          expect.soft(reply.text).toContain("Exit: signal SIGTERM");
          expect.soft(reply.text).toContain("partial output");
          expect.soft(reply.text).toContain("Verify the resulting state before retrying.");
          expect.soft(reply.text).toContain("Do not automatically rerun non-idempotent commands.");
        }
      },
    );

    it.each([
      {
        status: "approval-pending",
        approvalId: "approval-1",
        approvalSlug: "approval",
        expiresAtMs: 1000,
        host: "gateway",
        command: "command",
      },
      {
        status: "approval-unavailable",
        reason: "no-approval-route",
        host: "gateway",
        command: "command",
      },
    ] satisfies ExecToolDetails[])(
      "does not label $status as terminal or block the next command",
      async (details) => {
        const execute = vi.fn().mockResolvedValue({
          content: [{ type: "text", text: "Approval guidance from exec" }],
          details,
        });
        createExecToolMock.mockReturnValue({ execute });

        const first = await handleBashChatCommand(buildParams(`${alias} command`));
        const next = await handleBashChatCommand(buildParams(`${alias} next`));

        expect(first.text).toBe("Approval guidance from exec");
        expect(next.text).toBe("Approval guidance from exec");
        expect(execute).toHaveBeenCalledTimes(2);
      },
    );

    it("keeps running responses nonterminal and rejects a concurrent command", async () => {
      const execute = vi.fn().mockResolvedValue(backgroundExecResult("session-1"));
      createExecToolMock.mockReturnValue({ execute });
      const running = await handleBashChatCommand(buildParams(`${alias} command`));
      getSessionMock.mockReturnValue(buildRunningSession());
      const concurrent = await handleBashChatCommand(buildParams(`${alias} next`));

      expect(running.text).toContain("Still running; use !poll / !stop");
      expect(running.text).not.toContain("Exit:");
      expect(concurrent.text).toContain("A bash job is already running");
      expect(execute).toHaveBeenCalledTimes(1);
      getSessionMock.mockReturnValue(undefined);
      await handleBashChatCommand(buildParams(`${alias} help`));
    });

    it("accepts another command after a thrown exec error", async () => {
      const execute = vi.fn().mockRejectedValue(new Error("exec denied"));
      createExecToolMock.mockReturnValue({ execute });

      const failed = await handleBashChatCommand(buildParams(`${alias} command`));
      const next = await handleBashChatCommand(buildParams(`${alias} next`));

      expect(failed.text).toContain("⚠️ bash failed: command");
      expect(failed.text).not.toContain("Exit:");
      expect(next.text).toContain("⚠️ bash failed: next");
      expect(execute).toHaveBeenCalledTimes(2);
    });
  });

  it.each(["/bash", "!"])(
    "%s returns immediately after canonical cancellation is admitted",
    async (alias) => {
      const session = buildRunningSession();
      getSessionMock.mockReturnValue(session);
      getFinishedSessionMock.mockReturnValue(undefined);

      const result = await handleBashChatCommand(buildParams(`${alias} stop session-1`));

      expect(result.text).toContain("bash stopping");
      expect(result.text).toContain("!poll session-1");
      expect(cancelBackgroundExecSessionMock).toHaveBeenCalledWith("session-1");
      expect(session.exited).toBe(false);
    },
  );

  it("does not cancel a foreground session through chat stop", async () => {
    getSessionMock.mockReturnValue(buildRunningSession({ backgrounded: false }));

    const result = await handleBashChatCommand(buildParams("/bash stop session-1"));

    expect(result.text).toContain("is not backgrounded");
    expect(cancelBackgroundExecSessionMock).not.toHaveBeenCalled();
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

    expect(result.text).toContain("Exit: 0");
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

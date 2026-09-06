/**
 * Regression coverage for process-tool supervisor cancellation.
 * Verifies canonical cancellation admission and lifecycle-owned registry state.
 */
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { supervisorMock } = vi.hoisted(() => ({
  supervisorMock: {
    spawn: vi.fn(),
    cancel: vi.fn(),
    cancelScope: vi.fn(),
    getRecord: vi.fn(),
  },
}));

const { killProcessTreeMock } = vi.hoisted(() => ({
  killProcessTreeMock: vi.fn(),
}));

vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => supervisorMock,
}));

vi.mock("../process/kill-tree.js", () => ({
  killProcessTree: (...args: unknown[]) => killProcessTreeMock(...args),
}));

let addSession: typeof import("./bash-process-registry.js").addSession;
let getActiveBackgroundExecSessionCount: typeof import("./bash-process-registry.js").getActiveBackgroundExecSessionCount;
let getFinishedSession: typeof import("./bash-process-registry.js").getFinishedSession;
let getSession: typeof import("./bash-process-registry.js").getSession;
let markBackgrounded: typeof import("./bash-process-registry.js").markBackgrounded;
let markExited: typeof import("./bash-process-registry.js").markExited;
let resetProcessRegistryForTests: typeof import("./bash-process-registry.test-support.js").resetProcessRegistryForTests;
let createProcessSessionFixture: typeof import("./bash-process-registry.test-helpers.js").createProcessSessionFixture;
let createProcessTool: typeof import("./bash-tools.process.js").createProcessTool;

function createBackgroundSession(id: string, pid?: number) {
  const session = createProcessSessionFixture({
    id,
    command: "sleep 999",
    backgrounded: false,
    ...(pid === undefined ? {} : { pid }),
  });
  addSession(session);
  markBackgrounded(session);
  return session;
}

const requireRecord = createRequireRecord("object", "expected-label");

function expectSessionState(sessionId: string, expected: { exited?: boolean }) {
  const session = requireRecord(getSession(sessionId), sessionId);
  if ("exited" in expected) {
    expect(session.exited).toBe(expected.exited);
  }
}

function expectTextContent(value: unknown, text: string) {
  const content = requireRecord(value, "tool content");
  expect(content.type).toBe("text");
  expect(content.text).toBe(text);
}

describe("process tool supervisor cancellation", () => {
  beforeAll(async () => {
    ({
      addSession,
      getActiveBackgroundExecSessionCount,
      getFinishedSession,
      getSession,
      markBackgrounded,
      markExited,
    } = await import("./bash-process-registry.js"));
    ({ resetProcessRegistryForTests } = await import("./bash-process-registry.test-support.js"));
    ({ createProcessSessionFixture } = await import("./bash-process-registry.test-helpers.js"));
    ({ createProcessTool } = await import("./bash-tools.process.js"));
  });

  beforeEach(() => {
    supervisorMock.spawn.mockClear();
    supervisorMock.cancel.mockClear();
    supervisorMock.cancelScope.mockClear();
    supervisorMock.getRecord.mockClear();
    killProcessTreeMock.mockClear();
  });

  afterEach(() => {
    resetProcessRegistryForTests();
  });

  it("routes kill through supervisor when run is managed", async () => {
    supervisorMock.getRecord.mockReturnValue({
      runId: "sess",
      state: "running",
    });
    createBackgroundSession("sess");
    const processTool = createProcessTool();

    const result = await processTool.execute("toolcall", {
      action: "kill",
      sessionId: "sess",
    });

    expect(supervisorMock.cancel).toHaveBeenCalledWith("sess", "manual-cancel");
    expectSessionState("sess", { exited: false });
    expect(getActiveBackgroundExecSessionCount()).toBe(1);
    expectTextContent(result.content[0], "Termination requested for session sess.");
  });

  it("remove drops running session immediately when cancellation is requested", async () => {
    supervisorMock.getRecord.mockReturnValue({
      runId: "sess",
      state: "running",
    });
    const session = createBackgroundSession("sess");
    const processTool = createProcessTool();

    const result = await processTool.execute("toolcall", {
      action: "remove",
      sessionId: "sess",
    });

    expect(supervisorMock.cancel).toHaveBeenCalledWith("sess", "manual-cancel");
    expect(getSession("sess")).toBeUndefined();
    expect(getFinishedSession("sess")).toBeUndefined();
    expect(getActiveBackgroundExecSessionCount()).toBe(1);
    expectTextContent(result.content[0], "Removed session sess (termination requested).");

    markExited(session, null, "SIGTERM", "failed", "manual-cancel");
    expect(getActiveBackgroundExecSessionCount()).toBe(0);
    expect(getFinishedSession("sess")).toBeUndefined();
  });

  it.each([
    {
      action: "kill" as const,
      expected:
        "Unable to terminate session sess-unmanaged: no active supervisor cancellation handle. Use process poll to check whether it is already exiting.",
    },
    {
      action: "remove" as const,
      expected:
        "Unable to remove session sess-unmanaged: no active supervisor cancellation handle. Use process poll to check whether it is already exiting.",
    },
  ])("refuses $action without a live supervisor record", async ({ action, expected }) => {
    supervisorMock.getRecord.mockReturnValue(undefined);
    createBackgroundSession("sess-unmanaged", 4242);
    const processTool = createProcessTool();

    const result = await processTool.execute("toolcall", {
      action,
      sessionId: "sess-unmanaged",
    });

    expect(supervisorMock.cancel).not.toHaveBeenCalled();
    expect(killProcessTreeMock).not.toHaveBeenCalled();
    expectSessionState("sess-unmanaged", { exited: false });
    expect(getFinishedSession("sess-unmanaged")).toBeUndefined();
    expect(getActiveBackgroundExecSessionCount()).toBe(1);
    expectTextContent(result.content[0], expected);
  });

  it.each(["kill", "remove"] as const)(
    "refuses %s while sandbox finalization owns the terminal transition",
    async (action) => {
      supervisorMock.getRecord.mockReturnValue({ runId: "sess-finalizing", state: "exited" });
      const session = createBackgroundSession("sess-finalizing", 4242);
      session.finalizing = true;
      const processTool = createProcessTool();

      const result = await processTool.execute("toolcall", {
        action,
        sessionId: "sess-finalizing",
      });

      expect(supervisorMock.cancel).not.toHaveBeenCalled();
      expect(killProcessTreeMock).not.toHaveBeenCalled();
      expectSessionState("sess-finalizing", { exited: false });
      expect(getActiveBackgroundExecSessionCount()).toBe(1);
      expectTextContent(result.content[0], "Session sess-finalizing is finalizing.");
    },
  );
});

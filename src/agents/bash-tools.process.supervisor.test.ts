import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { supervisorMock } = vi.hoisted(() => ({
  supervisorMock: {
    spawn: vi.fn(),
    cancel: vi.fn(),
    cancelScope: vi.fn(),
    reconcileOrphans: vi.fn(),
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
let getFinishedSession: typeof import("./bash-process-registry.js").getFinishedSession;
let getSession: typeof import("./bash-process-registry.js").getSession;
let resetProcessRegistryForTests: typeof import("./bash-process-registry.js").resetProcessRegistryForTests;
let createProcessSessionFixture: typeof import("./bash-process-registry.test-helpers.js").createProcessSessionFixture;
let createProcessTool: typeof import("./bash-tools.process.js").createProcessTool;

function createBackgroundSession(id: string, pid?: number) {
  return createProcessSessionFixture({
    id,
    command: "sleep 999",
    backgrounded: true,
    ...(pid === undefined ? {} : { pid }),
  });
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function expectSessionState(sessionId: string, expected: { exited?: boolean }) {
  const session = requireRecord(getSession(sessionId), sessionId);
  if ("exited" in expected) {
    expect(session.exited).toBe(expected.exited);
  }
}

function expectFinishedSessionState(
  sessionId: string,
  expected: { status?: string; exitSignal?: string | null },
) {
  const session = requireRecord(getFinishedSession(sessionId), sessionId);
  if ("status" in expected) {
    expect(session.status).toBe(expected.status);
  }
  if ("exitSignal" in expected) {
    expect(session.exitSignal).toBe(expected.exitSignal);
  }
}

function expectTextContent(value: unknown, text: string) {
  const content = requireRecord(value, "tool content");
  expect(content.type).toBe("text");
  expect(content.text).toBe(text);
}

describe("process tool supervisor cancellation", () => {
  beforeAll(async () => {
    ({ addSession, getFinishedSession, getSession, resetProcessRegistryForTests } =
      await import("./bash-process-registry.js"));
    ({ createProcessSessionFixture } = await import("./bash-process-registry.test-helpers.js"));
    ({ createProcessTool } = await import("./bash-tools.process.js"));
  });

  beforeEach(() => {
    supervisorMock.spawn.mockClear();
    supervisorMock.cancel.mockClear();
    supervisorMock.cancelScope.mockClear();
    supervisorMock.reconcileOrphans.mockClear();
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
    addSession(createBackgroundSession("sess"));
    const processTool = createProcessTool();

    const result = await processTool.execute("toolcall", {
      action: "kill",
      sessionId: "sess",
    });

    expect(supervisorMock.cancel).toHaveBeenCalledWith("sess", "manual-cancel");
    expectSessionState("sess", { exited: false });
    expectTextContent(result.content[0], "Termination requested for session sess.");
  });

  it("remove drops running session immediately when cancellation is requested", async () => {
    supervisorMock.getRecord.mockReturnValue({
      runId: "sess",
      state: "running",
    });
    addSession(createBackgroundSession("sess"));
    const processTool = createProcessTool();

    const result = await processTool.execute("toolcall", {
      action: "remove",
      sessionId: "sess",
    });

    expect(supervisorMock.cancel).toHaveBeenCalledWith("sess", "manual-cancel");
    expect(getSession("sess")).toBeUndefined();
    expect(getFinishedSession("sess")).toBeUndefined();
    expectTextContent(result.content[0], "Removed session sess (termination requested).");
  });

  it("falls back to process-tree kill when supervisor record is missing", async () => {
    supervisorMock.getRecord.mockReturnValue(undefined);
    addSession(createBackgroundSession("sess-fallback", 4242));
    const processTool = createProcessTool();

    const result = await processTool.execute("toolcall", {
      action: "kill",
      sessionId: "sess-fallback",
    });

    expect(killProcessTreeMock).toHaveBeenCalledWith(4242);
    expect(getSession("sess-fallback")).toBeUndefined();
    expectFinishedSessionState("sess-fallback", { status: "failed", exitSignal: "SIGKILL" });
    expectTextContent(result.content[0], "Killed session sess-fallback.");
  });

  it("fails remove when no supervisor record and no pid is available", async () => {
    supervisorMock.getRecord.mockReturnValue(undefined);
    addSession(createBackgroundSession("sess-no-pid"));
    const processTool = createProcessTool();

    const result = await processTool.execute("toolcall", {
      action: "remove",
      sessionId: "sess-no-pid",
    });

    expect(killProcessTreeMock).not.toHaveBeenCalled();
    expectSessionState("sess-no-pid", { exited: false });
    expect(requireRecord(result.details, "result details").status).toBe("failed");
    expectTextContent(
      result.content[0],
      "Unable to remove session sess-no-pid: no active supervisor run or process id.",
    );
  });
});

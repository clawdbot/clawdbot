// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type CronRunsLoadStatus = "ok" | "error" | "skipped";

function createDeferred<T = void>() {
  let resolve: ((value: T | PromiseLike<T>) => void) | undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  if (!resolve) {
    throw new Error("Expected deferred resolver to be initialized");
  }
  return { promise, resolve };
}

async function raceWithNextMacrotask(promise: Promise<unknown>): Promise<"resolved" | "pending"> {
  return await Promise.race([
    promise.then(() => "resolved" as const),
    new Promise<"pending">((resolve) => {
      setImmediate(() => resolve("pending"));
    }),
  ]);
}

const mocks = vi.hoisted(() => ({
  refreshChatMock: vi.fn(async () => {}),
  scheduleChatScrollMock: vi.fn(),
  scheduleLogsScrollMock: vi.fn(),
  loadAgentFilesMock: vi.fn(async () => {}),
  loadAgentIdentitiesMock: vi.fn(async () => {}),
  loadAgentIdentityMock: vi.fn(async () => {}),
  loadAgentSkillsMock: vi.fn(async () => {}),
  loadAgentsMock: vi.fn(async () => {}),
  loadChannelsMock: vi.fn<(_host: unknown, _probe: boolean) => Promise<void>>(async () => {}),
  loadConfigMock: vi.fn(async () => {}),
  loadConfigSchemaMock: vi.fn(async () => {}),
  loadCronStatusMock: vi.fn(async () => {}),
  loadCronJobsPageMock: vi.fn(async () => {}),
  loadCronRunsMock: vi.fn<() => Promise<CronRunsLoadStatus>>(async () => "ok"),
  loadDebugMock: vi.fn(async () => {}),
  loadDevicesMock: vi.fn(async () => {}),
  loadExecApprovalsMock: vi.fn(async () => {}),
  loadLogsMock: vi.fn(async () => {}),
  loadModelAuthStatusStateMock: vi.fn(async () => {}),
  loadNodesMock: vi.fn(async () => {}),
  loadPresenceMock: vi.fn(async () => {}),
  loadSessionsMock: vi.fn(async () => {}),
  loadSkillsMock: vi.fn(async () => {}),
  loadUsageMock: vi.fn(async () => {}),
  startDebugPollingMock: vi.fn(),
  startLogsPollingMock: vi.fn(),
  startNodesPollingMock: vi.fn(),
  stopDebugPollingMock: vi.fn(),
  stopLogsPollingMock: vi.fn(),
  stopNodesPollingMock: vi.fn(),
}));

vi.mock("./app-chat.ts", () => ({
  refreshChat: mocks.refreshChatMock,
}));
vi.mock("./app-polling.ts", () => ({
  startDebugPolling: mocks.startDebugPollingMock,
  startLogsPolling: mocks.startLogsPollingMock,
  startNodesPolling: mocks.startNodesPollingMock,
  stopDebugPolling: mocks.stopDebugPollingMock,
  stopLogsPolling: mocks.stopLogsPollingMock,
  stopNodesPolling: mocks.stopNodesPollingMock,
}));
vi.mock("./app-scroll.ts", () => ({
  scheduleChatScroll: mocks.scheduleChatScrollMock,
  scheduleLogsScroll: mocks.scheduleLogsScrollMock,
}));
vi.mock("./controllers/agent-files.ts", () => ({
  loadAgentFiles: mocks.loadAgentFilesMock,
}));
vi.mock("./controllers/agent-identity.ts", () => ({
  loadAgentIdentities: mocks.loadAgentIdentitiesMock,
  loadAgentIdentity: mocks.loadAgentIdentityMock,
}));
vi.mock("./controllers/agent-skills.ts", () => ({
  loadAgentSkills: mocks.loadAgentSkillsMock,
}));
vi.mock("./controllers/agents.ts", () => ({
  loadAgents: mocks.loadAgentsMock,
}));
vi.mock("./controllers/channels.ts", () => ({
  loadChannels: mocks.loadChannelsMock,
}));
vi.mock("./controllers/config.ts", () => ({
  loadConfig: mocks.loadConfigMock,
  loadConfigSchema: mocks.loadConfigSchemaMock,
}));
vi.mock("./controllers/cron.ts", () => ({
  loadCronStatus: mocks.loadCronStatusMock,
  loadCronJobsPage: mocks.loadCronJobsPageMock,
  loadCronRuns: mocks.loadCronRunsMock,
}));
vi.mock("./controllers/debug.ts", () => ({
  loadDebug: mocks.loadDebugMock,
}));
vi.mock("./controllers/devices.ts", () => ({
  loadDevices: mocks.loadDevicesMock,
}));
vi.mock("./controllers/exec-approvals.ts", () => ({
  loadExecApprovals: mocks.loadExecApprovalsMock,
}));
vi.mock("./controllers/logs.ts", () => ({
  loadLogs: mocks.loadLogsMock,
}));
vi.mock("./controllers/model-auth-status.ts", () => ({
  loadModelAuthStatusState: mocks.loadModelAuthStatusStateMock,
}));
vi.mock("./controllers/nodes.ts", () => ({
  loadNodes: mocks.loadNodesMock,
}));
vi.mock("./controllers/presence.ts", () => ({
  loadPresence: mocks.loadPresenceMock,
}));
vi.mock("./controllers/sessions.ts", () => ({
  loadSessions: mocks.loadSessionsMock,
}));
vi.mock("./controllers/skills.ts", () => ({
  loadSkills: mocks.loadSkillsMock,
}));
vi.mock("./controllers/usage.ts", () => ({
  loadUsage: mocks.loadUsageMock,
}));

import { loadChannelsTab, refreshActiveTab, setTab } from "./app-settings.ts";

function createHost() {
  return {
    tab: "agents",
    connected: true,
    client: {},
    agentsPanel: "overview",
    agentsSelectedId: "agent-b",
    agentsList: {
      defaultId: "agent-a",
      agents: [{ id: "agent-a" }, { id: "agent-b" }],
    },
    chatHasAutoScrolled: false,
    logsAtBottom: false,
    eventLog: [],
    eventLogBuffer: [],
    requestUpdate: vi.fn(),
    updateComplete: Promise.resolve(),
    cronRunsScope: "all",
    cronRunsJobId: null as string | null,
    sessionsChangedReloadTimer: null as number | ReturnType<typeof globalThis.setTimeout> | null,
    sessionKey: "main",
    settings: {},
    basePath: "",
  };
}

type BufferedPerformanceEvent = {
  event?: string;
  payload?: Record<string, unknown>;
};

function expectBufferedPerformanceEvent(
  host: { eventLogBuffer: unknown[] },
  event: string,
  expectedPayload: Record<string, unknown>,
) {
  const entry = host.eventLogBuffer.find((value): value is BufferedPerformanceEvent => {
    if (!value || typeof value !== "object") {
      return false;
    }
    const candidate = value as BufferedPerformanceEvent;
    if (candidate.event !== event || !candidate.payload || typeof candidate.payload !== "object") {
      return false;
    }
    return Object.entries(expectedPayload).every(([key, expected]) => {
      return candidate.payload?.[key] === expected;
    });
  });
  if (!entry) {
    throw new Error(`Expected performance event ${event}`);
  }
  for (const [key, expected] of Object.entries(expectedPayload)) {
    expect(entry.payload?.[key]).toBe(expected);
  }
  expect(entry.payload?.durationMs).toBeTypeOf("number");
  return entry.payload;
}

describe("refreshActiveTab", () => {
  beforeEach(() => {
    for (const fn of Object.values(mocks)) {
      fn.mockReset();
    }
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const expectCommonAgentsTabRefresh = (host: ReturnType<typeof createHost>) => {
    expect(mocks.loadAgentsMock).toHaveBeenCalledOnce();
    expect(mocks.loadConfigMock).toHaveBeenCalledOnce();
    expect(mocks.loadAgentIdentitiesMock).toHaveBeenCalledWith(host, ["agent-a", "agent-b"]);
    expect(mocks.loadAgentIdentityMock).toHaveBeenCalledWith(host, "agent-b");
  };
  const expectNoCronLoaders = () => {
    expect(mocks.loadCronStatusMock).not.toHaveBeenCalled();
    expect(mocks.loadCronJobsPageMock).not.toHaveBeenCalled();
    expect(mocks.loadCronRunsMock).not.toHaveBeenCalled();
  };
  const panelLoaderArgs = {
    files: [mocks.loadAgentFilesMock, "agent-b"],
    skills: [mocks.loadAgentSkillsMock, "agent-b"],
    channels: [mocks.loadChannelsMock, false],
    tools: null,
  } as const;

  for (const panel of ["files", "skills", "channels", "tools"] as const) {
    it(`routes agents ${panel} panel refresh through the expected loaders`, async () => {
      const host = createHost();
      host.agentsPanel = panel;

      await refreshActiveTab(host as never);

      expectCommonAgentsTabRefresh(host);
      expect(mocks.loadAgentFilesMock).toHaveBeenCalledTimes(panel === "files" ? 1 : 0);
      expect(mocks.loadAgentSkillsMock).toHaveBeenCalledTimes(panel === "skills" ? 1 : 0);
      expect(mocks.loadChannelsMock).toHaveBeenCalledTimes(panel === "channels" ? 1 : 0);
      const expectedLoader = panelLoaderArgs[panel];
      if (expectedLoader) {
        const [loader, expectedArg] = expectedLoader;
        expect(loader).toHaveBeenCalledWith(host, expectedArg);
      }
      expectNoCronLoaders();
    });
  }

  it("routes agents cron panel refresh through cron loaders", async () => {
    const host = createHost();
    host.agentsPanel = "cron";
    host.cronRunsScope = "job";
    host.cronRunsJobId = "job-123";

    await refreshActiveTab(host as never);

    expectCommonAgentsTabRefresh(host);
    expect(mocks.loadChannelsMock).toHaveBeenCalledWith(host, false);
    expect(mocks.loadCronStatusMock).toHaveBeenCalledOnce();
    expect(mocks.loadCronJobsPageMock).toHaveBeenCalledOnce();
    expect(mocks.loadCronRunsMock).toHaveBeenCalledWith(host, "job-123");
    expect(mocks.loadAgentFilesMock).not.toHaveBeenCalled();
    expect(mocks.loadAgentSkillsMock).not.toHaveBeenCalled();
  });

  it("loads the Channels tab without automatic live probes", async () => {
    const host = createHost();

    await loadChannelsTab(host as never);

    expect(mocks.loadChannelsMock).toHaveBeenCalledWith(host, false);
    expect(mocks.loadConfigSchemaMock).toHaveBeenCalledWith(host);
    expect(mocks.loadConfigMock).toHaveBeenCalledWith(host);
  });

  it("refreshes logs tab by resetting bottom-follow and scheduling scroll", async () => {
    const host = createHost();
    host.tab = "logs";

    await refreshActiveTab(host as never);

    expect(host.logsAtBottom).toBe(true);
    expect(mocks.loadLogsMock).toHaveBeenCalledWith(host, { reset: true });
    expect(mocks.scheduleLogsScrollMock).toHaveBeenCalledWith(host, true);
  });

  it("records tab visible timing without waiting for the tab refresh RPC", async () => {
    const host = createHost();
    host.tab = "chat";
    const sessions = createDeferred();
    mocks.loadSessionsMock.mockReturnValueOnce(sessions.promise);

    setTab(host as never, "sessions");

    expect(host.requestUpdate).toHaveBeenCalled();
    await vi.waitFor(() => {
      expectBufferedPerformanceEvent(host, "control-ui.tab.visible", {
        previousTab: "chat",
        tab: "sessions",
      });
    });

    sessions.resolve();
  });

  it("starts node polling on Nodes tab entry and clears pending session reloads on tab changes", () => {
    vi.useFakeTimers();
    const host = createHost();
    host.tab = "overview";
    const pendingReload = vi.fn();
    host.sessionsChangedReloadTimer = globalThis.setTimeout(pendingReload, 1_000);

    setTab(host as never, "nodes");

    expect(host.sessionsChangedReloadTimer).toBeNull();
    expect(mocks.startNodesPollingMock).toHaveBeenCalledWith(host);
    expect(mocks.stopLogsPollingMock).toHaveBeenCalledWith(host);
    expect(mocks.stopDebugPollingMock).toHaveBeenCalledWith(host);
    vi.advanceTimersByTime(1_000);
    expect(pendingReload).not.toHaveBeenCalled();

    setTab(host as never, "sessions");
    expect(mocks.stopNodesPollingMock).toHaveBeenCalledWith(host);
  });

  it("does not wait for secondary overview refreshes before resolving", async () => {
    const host = createHost();
    host.tab = "overview";
    mocks.loadUsageMock.mockReturnValueOnce(new Promise<void>(() => undefined));

    const refresh = refreshActiveTab(host as never);
    const outcome = await raceWithNextMacrotask(refresh);

    expect(outcome).toBe("resolved");
    expect(mocks.loadChannelsMock).toHaveBeenCalled();
    expect(mocks.loadSessionsMock).toHaveBeenCalled();
    expect(mocks.loadUsageMock).toHaveBeenCalled();
  });

  it("does not wait for config schema before resolving config tab refresh", async () => {
    const host = createHost();
    host.tab = "config";
    const schema = createDeferred();
    mocks.loadConfigSchemaMock.mockReturnValueOnce(schema.promise);

    const refresh = refreshActiveTab(host as never);
    const outcome = await raceWithNextMacrotask(refresh);

    expect(outcome).toBe("resolved");
    expect(mocks.loadConfigSchemaMock).toHaveBeenCalledOnce();
    expect(mocks.loadConfigMock).toHaveBeenCalledOnce();
    expect(host.requestUpdate).not.toHaveBeenCalled();

    schema.resolve();

    await vi.waitFor(() => {
      expect(host.requestUpdate).toHaveBeenCalledOnce();
    });
  });

  it("renders channels from the cheap snapshot without waiting for config schema", async () => {
    const host = createHost();
    host.tab = "channels";
    const schema = createDeferred();
    mocks.loadConfigSchemaMock.mockReturnValueOnce(schema.promise);

    const refresh = refreshActiveTab(host as never);
    const outcome = await raceWithNextMacrotask(refresh);

    expect(outcome).toBe("resolved");
    expect(mocks.loadChannelsMock.mock.calls.map(([, probe]) => probe)).toEqual([false]);
    expect(mocks.loadConfigMock).toHaveBeenCalledOnce();
    expect(host.requestUpdate).not.toHaveBeenCalled();

    schema.resolve();

    await vi.waitFor(() => {
      expect(host.requestUpdate).toHaveBeenCalledOnce();
    });
  });

  it("records overview secondary refresh duration and aggregate status", async () => {
    const host = createHost();
    host.tab = "overview";
    const usage = createDeferred();
    mocks.loadUsageMock.mockReturnValueOnce(usage.promise);
    mocks.loadSkillsMock.mockRejectedValueOnce(new Error("skills failed"));

    await refreshActiveTab(host as never);
    usage.resolve();

    await vi.waitFor(() => {
      expectBufferedPerformanceEvent(host, "control-ui.overview.secondary", {
        phase: "end",
        status: "error",
      });
    });
  });

  it("does not wait for cron runs before resolving the cron tab refresh", async () => {
    const host = createHost();
    host.tab = "cron";
    mocks.loadCronRunsMock.mockReturnValueOnce(new Promise<"ok">(() => undefined));

    const refresh = refreshActiveTab(host as never);
    const outcome = await raceWithNextMacrotask(refresh);

    expect(outcome).toBe("resolved");
    expect(mocks.loadChannelsMock).toHaveBeenCalledWith(host, false);
    expect(mocks.loadCronStatusMock).toHaveBeenCalledOnce();
    expect(mocks.loadCronJobsPageMock).toHaveBeenCalledOnce();
    expect(mocks.loadCronRunsMock).toHaveBeenCalledOnce();
  });

  it("records failed cron runs status from the controller outcome", async () => {
    const host = createHost();
    host.tab = "cron";
    mocks.loadCronRunsMock.mockResolvedValueOnce("error" as const);

    await expect(refreshActiveTab(host as never)).resolves.toBeUndefined();
    await Promise.resolve();

    expectBufferedPerformanceEvent(host, "control-ui.cron.runs", {
      phase: "end",
      status: "error",
    });
  });

  it("contains rejected cron runs refreshes without failing the primary cron tab refresh", async () => {
    const host = createHost();
    host.tab = "cron";
    mocks.loadCronRunsMock.mockRejectedValueOnce(new Error("cron runs slow path failed"));

    await expect(refreshActiveTab(host as never)).resolves.toBeUndefined();
    await Promise.resolve();

    expectBufferedPerformanceEvent(host, "control-ui.cron.runs", {
      phase: "end",
      status: "error",
    });
  });

  it("does not record stale cron run timing after leaving the cron tab", async () => {
    const host = createHost();
    host.tab = "cron";
    const runs = createDeferred<"ok">();
    mocks.loadCronRunsMock.mockReturnValueOnce(runs.promise);

    await refreshActiveTab(host as never);
    host.tab = "chat";
    runs.resolve("ok");
    await Promise.resolve();

    expect(
      host.eventLogBuffer.some(
        (entry) =>
          Boolean(entry) &&
          typeof entry === "object" &&
          (entry as { event?: unknown }).event === "control-ui.cron.runs",
      ),
    ).toBe(false);
  });
});

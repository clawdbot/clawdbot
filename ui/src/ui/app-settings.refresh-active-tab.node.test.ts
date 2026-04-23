// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  refreshChatMock: vi.fn(async () => {}),
  scheduleChatScrollMock: vi.fn(),
  scheduleLogsScrollMock: vi.fn(),
  loadAgentFilesMock: vi.fn(async () => {}),
  loadAgentIdentitiesMock: vi.fn(async () => {}),
  loadAgentIdentityMock: vi.fn(async () => {}),
  loadAgentSkillsMock: vi.fn(async () => {}),
  loadAgentsMock: vi.fn(async () => {}),
  loadChannelsMock: vi.fn(async () => {}),
  loadConfigMock: vi.fn(async () => {}),
  loadConfigSchemaMock: vi.fn(async () => {}),
  loadCronStatusMock: vi.fn(async () => {}),
  loadCronJobsPageMock: vi.fn(async () => {}),
  loadCronRunsMock: vi.fn(async () => {}),
  loadLogsMock: vi.fn(async () => {}),
}));

vi.mock("./app-chat.ts", () => ({
  refreshChat: mocks.refreshChatMock,
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
vi.mock("./controllers/logs.ts", () => ({
  loadLogs: mocks.loadLogsMock,
}));

import { refreshActiveTab } from "./app-settings.ts";

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
    cronRunsScope: "all",
    cronRunsJobId: null as string | null,
    sessionKey: "main",
  };
}

describe("refreshActiveTab", () => {
  beforeEach(() => {
    for (const fn of Object.values(mocks)) {
      fn.mockReset();
    }
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

  it("refreshes logs tab by resetting bottom-follow and scheduling scroll", async () => {
    const host = createHost();
    host.tab = "logs";

    await refreshActiveTab(host as never);

    expect(host.logsAtBottom).toBe(true);
    expect(mocks.loadLogsMock).toHaveBeenCalledWith(host, { reset: true });
    expect(mocks.scheduleLogsScrollMock).toHaveBeenCalledWith(host, true);
  });
});

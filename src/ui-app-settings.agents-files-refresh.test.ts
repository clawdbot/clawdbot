// Tests UI app settings refresh behavior for agent files.
import { beforeEach, describe, expect, it, vi } from "vitest";

const loadAgentsMock = vi.hoisted(() =>
  vi.fn(async (host: { agentsList?: unknown }) => {
    host.agentsList = {
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "main" }],
    };
  }),
);
const loadConfigMock = vi.hoisted(() => vi.fn(async () => undefined));
const loadAgentIdentitiesMock = vi.hoisted(() => vi.fn(async () => undefined));
const loadAgentIdentityMock = vi.hoisted(() => vi.fn(async () => undefined));
const loadAgentSkillsMock = vi.hoisted(() => vi.fn(async () => undefined));
const loadAgentFilesMock = vi.hoisted(() => vi.fn(async () => undefined));
const loadChannelsMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../ui/src/ui/controllers/agents.ts", () => ({
  loadAgents: loadAgentsMock,
}));

vi.mock("../ui/src/ui/controllers/config.ts", () => ({
  loadConfig: loadConfigMock,
  loadConfigSchema: vi.fn(async () => undefined),
}));

vi.mock("../ui/src/ui/controllers/agent-identity.ts", () => ({
  loadAgentIdentities: loadAgentIdentitiesMock,
  loadAgentIdentity: loadAgentIdentityMock,
}));

vi.mock("../ui/src/ui/controllers/agent-skills.ts", () => ({
  loadAgentSkills: loadAgentSkillsMock,
}));

vi.mock("../ui/src/ui/controllers/agent-files.ts", () => ({
  loadAgentFiles: loadAgentFilesMock,
}));

vi.mock("../ui/src/ui/controllers/channels.ts", () => ({
  loadChannels: loadChannelsMock,
}));

vi.mock("../ui/src/ui/controllers/cron.ts", () => ({
  loadCronJobsPage: vi.fn(async () => undefined),
  loadCronRuns: vi.fn(async () => undefined),
  loadCronStatus: vi.fn(async () => undefined),
}));

import { refreshActiveTab } from "../ui/src/ui/app-settings.ts";

type AgentsPanel = "overview" | "files" | "tools" | "skills" | "channels" | "cron";

function createHost(agentsPanel: AgentsPanel): Parameters<typeof refreshActiveTab>[0] {
  return {
    tab: "agents",
    connected: true,
    agentsPanel,
    agentsList: null,
    agentsSelectedId: null,
    settings: {
      gatewayUrl: "",
      token: "",
      sessionKey: "main",
      lastActiveSessionKey: "main",
      theme: "claw",
      themeMode: "system",
      chatShowThinking: true,
      chatShowToolCalls: true,
      splitRatio: 0.6,
      navCollapsed: false,
      navWidth: 220,
      navGroupsCollapsed: {},
      borderRadius: 50,
    },
    theme: "claw",
    themeMode: "system",
    themeResolved: "dark",
    applySessionKey: "main",
    sessionKey: "main",
    chatHasAutoScrolled: false,
    logsAtBottom: false,
    eventLog: [],
    eventLogBuffer: [],
    basePath: "",
    dreamingStatusLoading: false,
    dreamingStatusError: null,
    dreamingStatus: null,
    dreamingModeSaving: false,
    dreamDiaryLoading: false,
    dreamDiaryError: null,
    dreamDiaryPath: null,
    dreamDiaryContent: null,
  } as Parameters<typeof refreshActiveTab>[0];
}

describe("refreshActiveTab (agents/files)", () => {
  beforeEach(() => {
    loadAgentsMock.mockClear();
    loadConfigMock.mockClear();
    loadAgentIdentitiesMock.mockClear();
    loadAgentIdentityMock.mockClear();
    loadAgentSkillsMock.mockClear();
    loadAgentFilesMock.mockClear();
    loadChannelsMock.mockClear();
  });

  it("loads agent files when the active agents panel is files", async () => {
    const host = createHost("files");
    await refreshActiveTab(host);

    expect(loadAgentFilesMock).toHaveBeenCalledTimes(1);
    expect(loadAgentFilesMock).toHaveBeenCalledWith(host, "main");
  });

  it("does not load agent files on non-files panels", async () => {
    const host = createHost("overview");
    await refreshActiveTab(host);

    expect(loadAgentFilesMock).not.toHaveBeenCalled();
  });
});

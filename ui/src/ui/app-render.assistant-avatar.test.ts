/* @vitest-environment jsdom */

import { html } from "lit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppViewState } from "./app-view-state.ts";
import type { QuickSettingsProps } from "./views/config-quick.ts";

const quickSettingsProps = vi.hoisted(() => ({
  current: null as QuickSettingsProps | null,
}));
const localStorageValues = vi.hoisted(() => new Map<string, string>());

vi.mock("../local-storage.ts", () => ({
  getSafeLocalStorage: () => ({
    getItem: (key: string) => localStorageValues.get(key) ?? null,
    removeItem: (key: string) => localStorageValues.delete(key),
    setItem: (key: string, value: string) => localStorageValues.set(key, value),
  }),
  getSafeSessionStorage: () => null,
}));

vi.mock("./views/config-quick.ts", () => ({
  renderQuickSettings: (props: QuickSettingsProps) => {
    quickSettingsProps.current = props;
    return html`<div data-testid="quick-settings"></div>`;
  },
}));

vi.mock("./views/chat.ts", () => ({
  renderChat: () => html`<div data-testid="chat"></div>`,
}));

vi.mock("./icons.ts", () => ({
  icons: {},
}));

import { renderApp } from "./app-render.ts";
import { saveLocalAssistantIdentity } from "./storage.ts";

function createState(overrides: Partial<AppViewState> = {}): AppViewState {
  return {
    settings: {
      gatewayUrl: "ws://localhost:18789",
      token: "",
      locale: "en",
      sessionKey: "main",
      lastActiveSessionKey: "main",
      theme: "claw",
      themeMode: "dark",
      splitRatio: 0.6,
      navWidth: 280,
      navCollapsed: false,
      navGroupsCollapsed: {},
      borderRadius: 50,
      chatFocusMode: false,
      chatShowThinking: false,
      chatShowToolCalls: true,
    },
    password: "",
    loginShowGatewayToken: false,
    loginShowGatewayPassword: false,
    tab: "config",
    onboarding: false,
    basePath: "",
    connected: true,
    theme: "claw",
    themeMode: "dark",
    themeResolved: "dark",
    themeOrder: ["claw", "knot", "dash"],
    customThemeImportUrl: "",
    customThemeImportBusy: false,
    customThemeImportMessage: null,
    customThemeImportExpanded: false,
    customThemeImportFocusToken: 0,
    hello: null,
    lastError: null,
    lastErrorCode: null,
    eventLog: [],
    assistantName: "Nova",
    assistantAvatar: "/avatar/main",
    assistantAvatarSource: "avatars/missing.png",
    assistantAvatarStatus: "none",
    assistantAvatarReason: "missing",
    assistantAvatarUploadBusy: false,
    assistantAvatarUploadError: null,
    assistantAgentId: "main",
    userName: null,
    userAvatar: null,
    localMediaPreviewRoots: [],
    embedSandboxMode: "scripts",
    allowExternalEmbedUrls: false,
    sessionKey: "main",
    chatLoading: false,
    chatSending: false,
    chatMessage: "",
    chatAttachments: [],
    chatMessages: [],
    chatToolMessages: [],
    chatStreamSegments: [],
    chatStream: null,
    chatStreamStartedAt: null,
    chatRunId: null,
    chatSideResult: null,
    chatSideResultTerminalRuns: new Set(),
    compactionStatus: null,
    fallbackStatus: null,
    chatAvatarUrl: null,
    chatAvatarSource: null,
    chatAvatarStatus: null,
    chatAvatarReason: null,
    chatThinkingLevel: null,
    chatModelOverrides: {},
    chatModelsLoading: false,
    chatModelCatalog: [],
    chatQueue: [],
    chatQueueBySession: {},
    chatLocalInputHistoryBySession: {},
    chatInputHistorySessionKey: null,
    chatInputHistoryItems: null,
    chatInputHistoryIndex: -1,
    chatDraftBeforeHistory: null,
    realtimeTalkActive: false,
    realtimeTalkStatus: "idle",
    realtimeTalkDetail: null,
    realtimeTalkTranscript: null,
    chatManualRefreshInFlight: false,
    nodesLoading: false,
    nodes: [],
    chatNewMessagesBelow: false,
    navDrawerOpen: false,
    sidebarOpen: false,
    sidebarContent: null,
    sidebarError: null,
    splitRatio: 0.6,
    scrollToBottom: vi.fn(),
    presenceEntries: [],
    sessionsResult: null,
    cronStatus: null,
    configSettingsMode: "quick",
    configForm: {},
    configSnapshot: { config: {}, hash: "hash" } as AppViewState["configSnapshot"],
    configFormDirty: false,
    configSaving: false,
    configApplying: false,
    cronJobs: [],
    skillsReport: {
      skills: [],
      workspaceDir: "",
      managedSkillsDir: "",
    } as AppViewState["skillsReport"],
    configActiveSection: null,
    configActiveSubsection: null,
    communicationsActiveSection: null,
    communicationsActiveSubsection: null,
    appearanceActiveSection: null,
    appearanceActiveSubsection: null,
    appearanceFormMode: "form",
    appearanceSearchQuery: "",
    automationActiveSection: null,
    automationActiveSubsection: null,
    infrastructureActiveSection: null,
    infrastructureActiveSubsection: null,
    aiAgentsActiveSection: null,
    aiAgentsActiveSubsection: null,
    configReady: true,
    configRaw: "",
    configRawOriginal: "",
    configValid: true,
    configIssues: [],
    configLoading: false,
    configSchema: null,
    configSchemaLoading: false,
    configUiHints: null,
    configFormOriginal: {},
    updateRunning: false,
    agentsList: null,
    agentsSelectedId: null,
    cronModelSuggestions: [],
    cronForm: { deliveryChannel: "", deliveryMode: "last" },
    cronFieldErrors: {},
    cronError: null,
    cronQuickCreateOpen: false,
    cronQuickCreateStep: "what",
    cronQuickCreateDraft: null,
    cronEditingJobId: null,
    channelsSnapshot: null,
    execApprovalQueue: [],
    dreamingRestartConfirmOpen: false,
    dreamingRestartConfirmLoading: false,
    dreamingStatusError: null,
    client: null,
    refreshSessionsAfterChat: new Set(),
    connect: vi.fn(),
    setTab: vi.fn(),
    setTheme: vi.fn(),
    setThemeMode: vi.fn(),
    setCustomThemeImportUrl: vi.fn(),
    openCustomThemeImport: vi.fn(),
    importCustomTheme: vi.fn(),
    clearCustomTheme: vi.fn(),
    setBorderRadius: vi.fn(),
    applySettings: vi.fn(),
    applyLocalUserIdentity: vi.fn(),
    loadOverview: vi.fn(),
    loadAssistantIdentity: vi.fn(),
    loadCron: vi.fn(),
    ...overrides,
  } as unknown as AppViewState;
}

beforeEach(() => {
  localStorageValues.clear();
  quickSettingsProps.current = null;
});

describe("renderApp assistant avatar routing", () => {
  it("passes the browser-local assistant override to Quick Settings ahead of stale identity metadata", () => {
    const dataUrl = "data:image/png;base64,bG9jYWwtYXNzaXN0YW50";
    saveLocalAssistantIdentity({ avatar: dataUrl });

    renderApp(createState());

    expect(quickSettingsProps.current?.assistantAvatar).toBe(dataUrl);
    expect(quickSettingsProps.current?.assistantAvatarUrl).toBe(dataUrl);
    expect(quickSettingsProps.current?.assistantAvatarSource).toBe(dataUrl);
    expect(quickSettingsProps.current?.assistantAvatarStatus).toBe("data");
    expect(quickSettingsProps.current?.assistantAvatarReason).toBeNull();
    expect(quickSettingsProps.current?.assistantAvatarOverride).toBe(dataUrl);
  });
});

import { expectDefined } from "@openclaw/normalization-core";
import { onTestFinished, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import { createTestSessionCapability } from "../../lib/sessions/session-capability.test-support.ts";
import type { ChatPage } from "./chat-page.ts";
import type { ChatSplitLayout } from "./split-layout-types.ts";
import { insertPane } from "./split-layout.ts";

export function createChatPageSessions(
  gateway: Parameters<typeof createTestSessionCapability>[0] = {
    snapshot: { client: null, phase: "stopped", hello: null },
    subscribe: () => () => undefined,
    subscribeEvents: () => () => undefined,
  },
) {
  const sessions = createTestSessionCapability(gateway);
  onTestFinished(() => sessions.dispose());
  return sessions;
}

export function createSplitLayout(sessionKey: string): ChatSplitLayout {
  const singlePane: ChatSplitLayout = {
    columns: [{ id: "c1", panes: [{ id: "p1", sessionKey }], paneWeights: [1] }],
    columnWeights: [1],
    activePaneId: "p1",
  };
  return insertPane(singlePane, "p1", sessionKey, "right");
}

export function itemAt<T>(items: ArrayLike<T>, index: number, label: string): T {
  return expectDefined(items[index], `${label} ${index}`);
}

export function setLayout(page: ChatPage, layout: ChatSplitLayout | undefined) {
  (page as unknown as { layout: ChatSplitLayout | undefined }).layout = layout;
}

export function setNavigationContext(page: ChatPage) {
  const navigate = vi.fn();
  const replace = vi.fn();
  const patch = vi.fn(async () => null);
  const agentSelectionState = { selectedId: "main" };
  const setAgent = vi.fn((agentId: string) => {
    agentSelectionState.selectedId = agentId;
  });
  const chatAttachmentHandoff = {
    prepare: vi.fn(),
    consume: vi.fn(() => null),
    clearPane: vi.fn(),
    dispose: vi.fn(),
  };
  const context = {
    basePath: "",
    sessions: { ...createChatPageSessions(), patch },
    agents: { state: { agentsList: { defaultId: "main", mainKey: "main" } } },
    gateway: {
      snapshot: { hello: null },
      setSessionKey: vi.fn(),
      subscribe: () => () => undefined,
    },
    navigate,
    replace,
    agentSelection: { state: agentSelectionState, set: setAgent },
    chatAttachmentHandoff,
  } as unknown as ApplicationContext;
  (page as unknown as { context: ApplicationContext }).context = context;
  return { chatAttachmentHandoff, context, navigate, replace, setAgent, patch };
}

export function stubMatchMedia(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

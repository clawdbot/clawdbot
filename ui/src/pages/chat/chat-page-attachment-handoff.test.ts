/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-page-attachment-handoff.test/"} */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./chat-pane.ts", () => ({}));
vi.mock("../../app/native-gateways.runtime.ts", () => ({
  nativeGatewaysCapability: () => null,
}));

import type { ApplicationContext } from "../../app/context.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { ChatPage } from "./chat-page.ts";
import type { ChatSplitLayout } from "./split-layout-types.ts";
import { insertPane } from "./split-layout.ts";

type RenderedPane = HTMLElement & {
  paneId: string;
  sessionKey: string;
  onClosePane?: (paneId: string) => void;
  discardStagedAttachments?: () => void;
  resumeStagedAttachments?: () => void;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function splitLayout(sessionKey: string): ChatSplitLayout {
  const layout: ChatSplitLayout = {
    columns: [{ id: "c1", panes: [{ id: "p1", sessionKey }], paneWeights: [1] }],
    columnWeights: [1],
    activePaneId: "p1",
  };
  return insertPane(layout, "p1", sessionKey, "right");
}

function configure(page: ChatPage) {
  const context = {
    sessions: { state: { result: null }, subscribe: () => () => undefined, patch: vi.fn() },
    agents: { state: { agentsList: { defaultId: "main", mainKey: "main" } } },
    gateway: { snapshot: { hello: null }, subscribe: () => () => undefined },
    navigate: vi.fn(),
    replace: vi.fn(),
    agentSelection: { state: { selectedId: "main" }, set: vi.fn() },
    chatAttachmentHandoff: {
      prepare: vi.fn(),
      consume: vi.fn(() => null),
      clearPane: vi.fn(),
      dispose: vi.fn(),
    },
  } as unknown as ApplicationContext;
  (page as unknown as { context: ApplicationContext }).context = context;
  page.data = { sessionKey: "main" };
}

describe("chat page staged attachment rebound", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it("reactivates a closed pane when delayed MCP teardown rebounds to the same owner", async () => {
    const page = new ChatPage();
    configure(page);
    document.body.append(page);
    (page as unknown as { layout: ChatSplitLayout }).layout = splitLayout("main");
    page.requestUpdate();
    await page.updateComplete;

    const closingPane = page.querySelectorAll<RenderedPane>("openclaw-chat-pane")[1]!;
    const discard = vi.fn();
    const resume = vi.fn();
    closingPane.discardStagedAttachments = discard;
    closingPane.resumeStagedAttachments = resume;
    const teardown = deferred<void>();
    const mcpApp = document.createElement("mcp-app-view");
    const restartAfterTeardown = vi.fn();
    mcpApp.restartAfterTeardown = restartAfterTeardown;
    mcpApp.teardown = vi.fn(() => teardown.promise);
    closingPane.append(mcpApp);

    closingPane.onClosePane?.(closingPane.paneId);
    await page.updateComplete;
    expect(discard).toHaveBeenCalledOnce();
    expect(closingPane.isConnected).toBe(true);

    (page as unknown as { layout: ChatSplitLayout }).layout = splitLayout("main");
    page.requestUpdate();
    await page.updateComplete;
    expect(resume).toHaveBeenCalled();

    teardown.resolve();
    await expect.poll(() => restartAfterTeardown).toHaveBeenCalledOnce();
    expect(page.querySelectorAll<RenderedPane>("openclaw-chat-pane")[1]).toBe(closingPane);
  });
});

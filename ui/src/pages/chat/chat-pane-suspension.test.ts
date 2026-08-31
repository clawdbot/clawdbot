/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-pane-suspension.test/"} */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { ChatPaneBase } from "./chat-pane-base.ts";
import { createTestChatPane, type TestChatPane } from "./chat-pane.test-support.ts";
import { getChatComposerState, resetChatComposerState } from "./components/chat-composer-state.ts";

afterEach(() => {
  resetChatComposerState();
  vi.restoreAllMocks();
});

describe("chat pane suspension", () => {
  it("commits the live composer draft before a hidden document can suspend", async () => {
    let visibilityState: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibilityState);
    const { pane, requestUpdate, state } = createTestChatPane({
      client: { request: vi.fn() } as unknown as GatewayBrowserClient,
      sessions: {} as SessionCapability,
    });
    const lifecycle = pane as TestChatPane & {
      paneId: string;
      render: () => unknown;
    };
    lifecycle.render = () => null;
    const textarea = document.createElement("textarea");
    textarea.value = "Draft still being composed";
    getChatComposerState(lifecycle.paneId).composerTextarea = textarea;
    state.chatMessage = "Draft still being";
    state.handleChatDraftChange = vi.fn((next: string) => {
      state.chatMessage = next;
    });
    ChatPaneBase.prototype.connectedCallback.call(lifecycle);
    await lifecycle.updateComplete;

    visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));

    expect(state.handleChatDraftChange).toHaveBeenCalledExactlyOnceWith(textarea.value);
    expect(state.chatMessage).toBe(textarea.value);
    expect(requestUpdate).toHaveBeenCalledOnce();

    visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await lifecycle.updateComplete;
    Object.defineProperty(lifecycle, "isConnected", { configurable: true, value: false });
    ChatPaneBase.prototype.disconnectedCallback.call(lifecycle);
  });
});

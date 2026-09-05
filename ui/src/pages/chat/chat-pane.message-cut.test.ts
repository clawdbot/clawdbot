import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { consumePaneSessionHandoff } from "./chat-pane-shared.ts";
import { createTestChatPane } from "./chat-pane.test-support.ts";

describe("chat pane message cuts", () => {
  it("restores forked prompt attachments into the new session composer", async () => {
    const sessions = {
      forkAtMessage: vi.fn().mockResolvedValue({
        sessionKey: "agent:main:forked",
        editorText: "edit me",
        editorAttachments: [{ mimeType: "image/png", data: "aW1hZ2U=" }],
      }),
    } as unknown as SessionCapability;
    const client = {} as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions });
    state.chatAttachments = [{ id: "old", mimeType: "image/jpeg", dataUrl: "data:old" }];

    await pane.forkFromMessage("user-entry");

    expect(state.sessionKey).toBe("agent:main:current");
    expect(state.chatAttachments).toEqual([
      { id: "old", mimeType: "image/jpeg", dataUrl: "data:old" },
    ]);
    expect(consumePaneSessionHandoff(pane.context, pane.paneId, "agent:main:forked")).toEqual({
      attachments: [
        {
          id: expect.stringMatching(/^att-/),
          mimeType: "image/png",
          dataUrl: "data:image/png;base64,aW1hZ2U=",
        },
      ],
      draft: "edit me",
    });
  });

  it("keeps a newer global agent selection when a message fork finishes late", async () => {
    const forked = createDeferred<{ sessionKey: string; editorText?: string }>();
    const sessions = {
      forkAtMessage: vi.fn(() => forked.promise),
    } as unknown as SessionCapability;
    const client = {} as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions });
    const navigate = vi.fn();
    pane.onPaneSessionChange = navigate;
    state.sessionKey = "global";
    state.assistantAgentId = "main";

    const pending = pane.forkFromMessage("user-entry");
    state.assistantAgentId = "work";
    forked.resolve({ sessionKey: "agent:main:forked", editorText: "edit me" });

    await pending;
    expect(navigate).not.toHaveBeenCalled();
    expect(state.sessionKey).toBe("global");
    expect(state.assistantAgentId).toBe("work");
  });

  it("does not navigate to a fork that finishes after a same-client reconnect", async () => {
    const forked = createDeferred<{ sessionKey: string; editorText?: string }>();
    const sessions = {
      forkAtMessage: vi.fn(() => forked.promise),
    } as unknown as SessionCapability;
    const client = {} as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions });
    const navigate = vi.fn();
    pane.onPaneSessionChange = navigate;

    const pending = pane.forkFromMessage("user-entry");
    pane.connectionGeneration += 1;
    state.connectionEpoch = pane.connectionGeneration;
    forked.resolve({ sessionKey: "agent:main:forked", editorText: "stale draft" });

    await pending;
    expect(navigate).not.toHaveBeenCalled();
    expect(consumePaneSessionHandoff(pane.context, pane.paneId, "agent:main:forked")).toBeNull();
  });

  it("does not navigate or seed a draft after leaving and returning to the retained source", async () => {
    const forked = createDeferred<{ sessionKey: string; editorText: string }>();
    const sessions = {
      forkAtMessage: vi.fn(() => forked.promise),
    } as unknown as SessionCapability;
    const client = {} as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions });
    pane.sessionKey = state.sessionKey;
    const navigate = vi.fn();
    pane.onPaneSessionChange = navigate;

    try {
      const pending = pane.forkFromMessage("user-entry");
      // A -> B -> A retains A's component, session key, and connection.
      pane.presented = false;
      pane.presented = true;
      state.chatMessage = "newer source draft";
      forked.resolve({ sessionKey: "agent:main:forked-after-return", editorText: "stale draft" });

      await pending;
      expect(navigate).not.toHaveBeenCalled();
      expect(
        consumePaneSessionHandoff(pane.context, pane.paneId, "agent:main:forked-after-return"),
      ).toBeNull();
      expect(state.sessionKey).toBe("agent:main:current");
      expect(state.chatMessage).toBe("newer source draft");
    } finally {
      pane.presented = false;
    }
  });

  it.each([
    { presentation: "hidden", returnToSource: false },
    { presentation: "shown again", returnToSource: true },
  ])(
    "does not paint a stale fork error in a retained source that is $presentation",
    async ({ returnToSource }) => {
      const forked = createDeferred<never>();
      const sessions = {
        forkAtMessage: vi.fn(() => forked.promise),
      } as unknown as SessionCapability;
      const { pane, state } = createTestChatPane({ client: {} as GatewayBrowserClient, sessions });
      pane.sessionKey = state.sessionKey;

      try {
        const pending = pane.forkFromMessage("user-entry");
        pane.presented = false;
        if (returnToSource) {
          pane.presented = true;
        }
        forked.reject(new Error("stale fork failed"));

        await pending;
        expect(state.lastError).toBeNull();
        expect(state.chatError).toBeNull();
      } finally {
        pane.presented = false;
      }
    },
  );

  it("shows a current fork error after the retained source is presented again", async () => {
    const sessions = {
      forkAtMessage: vi.fn().mockRejectedValue(new Error("current fork failed")),
    } as unknown as SessionCapability;
    const { pane, state } = createTestChatPane({ client: {} as GatewayBrowserClient, sessions });
    pane.sessionKey = state.sessionKey;

    try {
      pane.presented = false;
      pane.presented = true;
      await pane.forkFromMessage("user-entry");

      expect(state.lastError).toBe("current fork failed");
      expect(state.chatError).toBe("current fork failed");
    } finally {
      pane.presented = false;
    }
  });
});

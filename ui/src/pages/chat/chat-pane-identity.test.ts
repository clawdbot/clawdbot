/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { consumePaneSessionHandoff } from "./chat-pane-shared.ts";
import { createTestChatPane } from "./chat-pane.test-support.ts";
import type { ChatPageHost } from "./chat-state-host.ts";

describe("chat pane assistant identity snapshots", () => {
  it("keeps a session-specific assistant identity across ordinary gateway snapshots", () => {
    const client = {} as GatewayBrowserClient;
    const { pane } = createTestChatPane({ client, sessions: {} as SessionCapability });
    const state = (pane as unknown as { state: ChatPageHost }).state;
    state.client = client;
    state.connected = true;
    state.assistantName = "Session Agent";

    pane.applyGatewaySnapshot({
      ...pane.context.gateway.snapshot,
      client,
    });

    expect(state.assistantName).toBe("Session Agent");
  });

  it("resets a session-specific identity when the logical connection changes", () => {
    const client = {} as GatewayBrowserClient;
    const nextClient = {} as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions: {} as SessionCapability });
    state.assistantName = "Session Agent";

    pane.applyGatewaySnapshot({
      ...pane.context.gateway.snapshot,
      client: nextClient,
      phase: "reconnecting" as const,
    });

    expect(state.assistantName).toBe(pane.context.config.current.assistantIdentity.name);
  });
});

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

  it("does not paint a stale fork error after the selected session changes", async () => {
    let rejectFork!: (error: Error) => void;
    const forked = new Promise<never>((_resolve, reject) => {
      rejectFork = reject;
    });
    const sessions = {
      forkAtMessage: vi.fn(() => forked),
    } as unknown as SessionCapability;
    const client = {} as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions });

    const pending = pane.forkFromMessage("user-entry");
    state.sessionKey = "agent:main:replacement";
    rejectFork(new Error("stale fork failed"));

    await pending;
    expect(state.lastError).toBeNull();
    expect(state.chatError).toBeNull();
  });
});

/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { createTestChatPane, type TestChatPane } from "./chat-pane.test-support.ts";

function advertiseSessionCreate(pane: TestChatPane) {
  pane.context.gateway.snapshot.hello = {
    auth: { role: "operator", scopes: ["operator.write"] },
    features: { methods: ["sessions.create"] },
  } as typeof pane.context.gateway.snapshot.hello;
}

describe("chat pane session recovery", () => {
  it("recovers a tombstoned session into a fresh continuing session", async () => {
    const created = createDeferred<string | null>();
    const sessions = {
      create: vi.fn(() => created.promise),
    } as unknown as SessionCapability;
    const client = {} as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions });
    const navigate = vi.fn();
    pane.onPaneSessionChange = navigate;
    advertiseSessionCreate(pane);

    expect(pane.restartRecoveryComposerBanner()).toMatchObject({
      title: "This session ended during a restart.",
      text: "Its transcript is safe.",
      tone: "neutral",
      icon: "warning",
      actionLabel: "Resume in new session",
      actionStyle: "primary",
      busy: false,
    });

    const pending = pane.recoverSession();
    await vi.waitFor(() => expect(sessions.create).toHaveBeenCalledOnce());
    expect(pane.restartRecoveryComposerBanner()).toMatchObject({
      actionLabel: "Resume in new session",
      actionStyle: "primary",
      busy: true,
      busyLabel: "Resuming…",
    });
    created.resolve("agent:main:dashboard:recovered");

    await expect(pending).resolves.toBe(true);

    expect(sessions.create).toHaveBeenCalledWith({
      agentId: "main",
      parentSessionKey: "agent:main:current",
      recover: true,
    });
    expect(navigate).toHaveBeenCalledWith(pane.paneId, "agent:main:dashboard:recovered");
    expect(state.sessionKey).toBe("agent:main:current");
  });

  it("reuses the recovered session after a same-client reconnect", async () => {
    const created = createDeferred<string | null>();
    const sessions = {
      create: vi
        .fn<SessionCapability["create"]>()
        .mockImplementationOnce(() => created.promise)
        .mockResolvedValueOnce("agent:main:dashboard:recovered"),
    } as unknown as SessionCapability;
    const client = {} as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions });
    const navigate = vi.fn();
    pane.onPaneSessionChange = navigate;
    advertiseSessionCreate(pane);

    const pending = pane.recoverSession();
    await vi.waitFor(() => expect(sessions.create).toHaveBeenCalledOnce());
    state.connected = false;
    pane.connectionGeneration += 1;
    state.connectionEpoch = pane.connectionGeneration;
    state.connected = true;
    pane.connectionGeneration += 1;
    state.connectionEpoch = pane.connectionGeneration;
    created.resolve("agent:main:dashboard:recovered");

    await expect(pending).resolves.toBe(false);
    expect(navigate).not.toHaveBeenCalled();

    await expect(pane.recoverSession()).resolves.toBe(true);
    expect(sessions.create).toHaveBeenCalledTimes(2);
    expect(navigate).toHaveBeenCalledWith(pane.paneId, "agent:main:dashboard:recovered");
  });
});

/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { createTestChatPane } from "./chat-pane.test-support.ts";
import type { ChatPageHost } from "./chat-state.ts";

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

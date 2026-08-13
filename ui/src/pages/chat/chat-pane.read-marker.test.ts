/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { createTestChatPane } from "./chat-pane.test-support.ts";

describe("chat pane read markers", () => {
  it("marks an unread failure read even when its regular unread flag is false", () => {
    const patch = vi.fn().mockResolvedValue(null);
    const { pane } = createTestChatPane({
      client: {} as GatewayBrowserClient,
      sessions: { patch } as unknown as SessionCapability,
    });

    pane.markSessionRead({
      key: "agent:main:current",
      kind: "direct",
      label: "Failed run",
      updatedAt: 20,
      endedAt: 20,
      status: "failed",
      unread: false,
    });

    expect(patch).toHaveBeenCalledWith(
      "agent:main:current",
      { unread: false },
      { agentId: "main" },
    );
  });

  it("marks an active agent status read even without other unread state", () => {
    const patch = vi.fn().mockResolvedValue(null);
    const { pane } = createTestChatPane({
      client: {} as GatewayBrowserClient,
      sessions: { patch } as unknown as SessionCapability,
    });

    pane.markSessionRead({
      key: "agent:main:current",
      kind: "direct",
      label: "Waiting",
      updatedAt: 20,
      unread: false,
      agentStatus: { note: "Need the staging password", expiresAt: Date.now() + 60_000 },
    });

    expect(patch).toHaveBeenCalledWith(
      "agent:main:current",
      { unread: false },
      { agentId: "main" },
    );
  });

  it.each([
    {
      name: "read-only scope",
      methods: ["sessions.patch"],
      scopes: ["operator.read"],
    },
    {
      name: "unadvertised sessions.patch",
      methods: ["sessions.create"],
      scopes: ["operator.write"],
    },
  ])("does not mutate unread state with $name", ({ methods, scopes }) => {
    const patch = vi.fn().mockResolvedValue(null);
    const { pane, state } = createTestChatPane({
      client: {} as GatewayBrowserClient,
      sessions: { patch } as unknown as SessionCapability,
    });
    pane.context.gateway.snapshot.hello = {
      auth: { role: "operator", scopes },
      features: { methods },
    } as ApplicationGatewaySnapshot["hello"];
    const row = {
      key: "agent:main:current",
      kind: "direct" as const,
      updatedAt: 20,
      unread: true,
    };

    pane.markSessionRead(row);
    pane.markSessionRead(row);

    expect(patch).not.toHaveBeenCalled();
    expect(state.chatError).toBeNull();
    expect(state.lastError).toBeNull();
  });
});

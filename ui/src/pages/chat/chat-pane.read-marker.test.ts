/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
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
});

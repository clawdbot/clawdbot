import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import {
  __testing as sessionBindingTesting,
  getSessionBindingService,
} from "openclaw/plugin-sdk/conversation-runtime";
import { beforeEach, describe, expect, it } from "vitest";
import { __testing, createBlueBubblesConversationBindingManager } from "./conversation-bindings.js";

const baseCfg = {
  session: { mainKey: "main", scope: "per-sender" },
} satisfies OpenClawConfig;

describe("BlueBubbles conversation bindings", () => {
  beforeEach(() => {
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    __testing.resetBlueBubblesConversationBindingsForTests();
  });

  it("preserves existing metadata when rebinding the same conversation", async () => {
    const manager = createBlueBubblesConversationBindingManager({
      cfg: baseCfg,
      accountId: "default",
    });

    manager.bindConversation({
      conversationId: "chat-guid-1",
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:child",
      metadata: {
        agentId: "codex",
        label: "child",
        boundBy: "system",
      },
    });

    await getSessionBindingService().bind({
      targetSessionKey: "agent:main:subagent:child",
      targetKind: "subagent",
      conversation: {
        channel: "bluebubbles",
        accountId: "default",
        conversationId: "chat-guid-1",
      },
      placement: "current",
      metadata: {
        label: "child",
      },
    });

    expect(
      getSessionBindingService().resolveByConversation({
        channel: "bluebubbles",
        accountId: "default",
        conversationId: "chat-guid-1",
      }),
    ).toMatchObject({
      metadata: expect.objectContaining({
        agentId: "codex",
        label: "child",
        boundBy: "system",
      }),
    });
  });
});

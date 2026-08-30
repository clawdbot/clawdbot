/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-pane-typing.test/"} */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { createTestChatPane } from "./chat-pane.test-support.ts";
import { renderChatTypingIndicator } from "./components/chat-typing-indicator.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("chat pane typing presence", () => {
  it("sender provenance clears only the exact profile sender and expires remaining actors", () => {
    vi.useFakeTimers();
    const { pane, state } = createTestChatPane({
      client: { request: vi.fn() } as unknown as GatewayBrowserClient,
      sessions: {} as SessionCapability,
    });
    state.sessionKey = "agent:work:main";
    state.assistantAgentId = "work";
    state.agentsList = { defaultId: "main", mainKey: "main", scope: "global", agents: [] };
    state.sessionsResultAgentId = "work";
    const aliceId = "0d9f4c35-d221-49da-9a3f-b8c73921066b";
    pane.presencePayload = {
      presence: [{ user: { id: "owner" } }, { user: { id: aliceId } }, { user: { id: "bob" } }],
    };
    state.sessionsResult = {
      count: 1,
      path: "",
      sessions: [
        {
          key: "global",
          kind: "global",
          sessionId: "session-a",
          updatedAt: 1,
        } as GatewaySessionRow,
      ],
    } as never;
    for (const actor of [
      { id: aliceId, label: "Alice", preview: "Alice's ephemeral draft" },
      { id: "bob", label: "Bob" },
    ]) {
      pane.handleSessionTypingEvent({
        sessionKey: state.sessionKey,
        sessionId: "session-a",
        agentId: "work",
        actor: { type: "human", ...actor },
        typing: true,
        ...(actor.preview ? { preview: actor.preview } : {}),
        ts: 1,
      });
    }
    expect(pane.typingActorViews()).toEqual([
      { id: aliceId, label: "Alice", preview: "Alice's ephemeral draft" },
      { id: "bob", label: "Bob" },
    ]);

    const event = (message: unknown, sessionKey = state.sessionKey) => ({
      sessionKey,
      agentId: "work",
      message,
    });
    pane.clearTypingActorForSessionMessage(
      event({ role: "user", senderLabel: `Alice (${aliceId})` }),
    );
    pane.clearTypingActorForSessionMessage(
      event({ role: "assistant", __openclaw: { senderId: aliceId } }),
    );
    pane.clearTypingActorForSessionMessage(
      event({ role: "user", __openclaw: { senderId: aliceId } }, "agent:work:other"),
    );
    expect([...pane.typingActors.keys()]).toEqual([aliceId, "bob"]);

    pane.clearTypingActorForSessionMessage(
      event({ role: "user", __openclaw: { senderId: aliceId } }),
    );
    pane.clearTypingActorForSessionMessage(
      event({
        role: "user",
        __openclaw: {
          senderId: aliceId,
          senderIdentity: {
            type: "observation",
            id: aliceId,
            pluginId: "channel",
            accountId: null,
            senderKind: "unknown",
          },
        },
      }),
    );
    expect([...pane.typingActors.keys()]).toEqual([aliceId, "bob"]);
    pane.clearTypingActorForSessionMessage(
      event({
        role: "user",
        __openclaw: { senderId: aliceId, senderIdentity: { type: "profile", id: aliceId } },
      }),
    );
    expect([...pane.typingActors.keys()]).toEqual(["bob"]);

    vi.advanceTimersByTime(2_500);
    expect(pane.typingActors.size).toBe(0);
  });

  it("renders draft bubbles separately from boolean-only dots and live status", () => {
    const container = document.createElement("div");
    render(
      renderChatTypingIndicator([
        { id: "alice", label: "Alice", preview: "Hello **world**" },
        { id: "bob", label: "Bob" },
      ]),
      container,
    );

    expect(container.querySelector(".agent-chat__typing-preview-bubble")?.textContent).toContain(
      "Hello **world**",
    );
    expect(container.querySelector(".agent-chat__typing-preview-label")?.textContent?.trim()).toBe(
      "Alice is typing…",
    );
    expect(container.querySelectorAll(".agent-chat__typing-bubble > span")).toHaveLength(3);
    expect(container.querySelector(".sr-only")?.textContent).toBe("Alice, Bob are typing…");
  });

  it("sends only the last 300 draft code points and omits previews when typing stops", () => {
    const request = vi.fn().mockResolvedValue({ ok: true, broadcast: true });
    const { pane, state } = createTestChatPane({
      client: { request } as unknown as GatewayBrowserClient,
      sessions: {} as SessionCapability,
    });
    pane.presencePayload = { presence: [{ user: { id: "owner" } }, { user: { id: "alice" } }] };
    state.sessionKey = "agent:work:main";
    state.assistantAgentId = "work";
    state.agentsList = { defaultId: "main", mainKey: "main", scope: "global", agents: [] };
    state.sessionsResultAgentId = "work";
    state.sessionsResult = {
      count: 1,
      path: "",
      sessions: [{ key: "global", kind: "global", sessionId: "session-a", updatedAt: 1 }],
    } as never;

    pane.sendTypingState(true, `  prefix${"😀".repeat(300)}  `);
    expect(request).toHaveBeenNthCalledWith(
      1,
      "session.typing",
      expect.objectContaining({
        sessionKey: "agent:work:main",
        sessionId: "session-a",
        agentId: "work",
        typing: true,
        preview: "😀".repeat(300),
      }),
    );

    pane.sendTypingState(false, "must not leak");
    expect(request.mock.calls[1]?.[1]).toMatchObject({ typing: false });
    expect(request.mock.calls[1]?.[1]).not.toHaveProperty("preview");

    pane.sendTypingState(true, "   ");
    expect(request.mock.calls[2]?.[1]).not.toHaveProperty("preview");
  });
});

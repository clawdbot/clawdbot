import { describe, expect, it } from "vitest";
import { createInitialUserMessageHandoff } from "../../app/initial-user-message-handoff.ts";
import {
  admitInitialUserMessageHandoff,
  prepareInitialUserMessageHandoff,
  reconcileInitialUserMessageHandoff,
} from "./initial-turn-handoff.ts";

describe("initial user message handoff", () => {
  it("reprojects an accepted first prompt across state replacement until history owns it", () => {
    const sessionKey = "agent:main:new-session";
    const hello = {};
    const handoff = createInitialUserMessageHandoff();
    prepareInitialUserMessageHandoff(
      handoff,
      sessionKey,
      {
        text: "show this while the run is active",
        createdAt: 123,
      },
      hello,
    );

    const otherSession = { chatMessages: [] as unknown[], hello };
    expect(admitInitialUserMessageHandoff(handoff, otherSession, "agent:main:other")).toBe(false);
    expect(otherSession.chatMessages).toEqual([]);

    const createdSession = { chatMessages: [] as unknown[], hello };
    expect(admitInitialUserMessageHandoff(handoff, createdSession, sessionKey)).toBe(true);
    expect(createdSession.chatMessages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "show this while the run is active" }],
        timestamp: 123,
      },
    ]);
    expect(admitInitialUserMessageHandoff(handoff, createdSession, sessionKey)).toBe(false);

    const secondSessionKey = "agent:main:second-new-session";
    prepareInitialUserMessageHandoff(
      handoff,
      secondSessionKey,
      {
        text: "keep the other active prompt too",
        createdAt: 124,
      },
      hello,
    );
    const secondActiveSession = { chatMessages: [] as unknown[], hello };
    expect(admitInitialUserMessageHandoff(handoff, secondActiveSession, secondSessionKey)).toBe(
      true,
    );

    const assistantOutput = {
      role: "assistant",
      content: [{ type: "text", text: "already working" }],
    };
    const remountedSession = { chatMessages: [assistantOutput] as unknown[], hello };
    expect(admitInitialUserMessageHandoff(handoff, remountedSession, sessionKey)).toBe(true);
    expect(remountedSession.chatMessages).toEqual([
      ...createdSession.chatMessages,
      assistantOutput,
    ]);

    const persisted = {
      role: "user",
      content: [{ type: "text", text: "show this while the run is active" }],
      __openclaw: { seq: 1 },
    };
    remountedSession.chatMessages = [persisted];
    expect(
      reconcileInitialUserMessageHandoff(handoff, remountedSession, sessionKey, [persisted], true),
    ).toBe(false);
    const activeRunReset = { chatMessages: [] as unknown[], hello };
    expect(admitInitialUserMessageHandoff(handoff, activeRunReset, sessionKey)).toBe(true);
    activeRunReset.chatMessages = [persisted];
    expect(
      reconcileInitialUserMessageHandoff(handoff, activeRunReset, sessionKey, [persisted], false),
    ).toBe(false);
    expect(admitInitialUserMessageHandoff(handoff, { chatMessages: [], hello }, sessionKey)).toBe(
      false,
    );
  });

  it("does not duplicate a first prompt that history already loaded", () => {
    const sessionKey = "agent:main:main";
    const routeSessionKey = "main";
    const hello = {};
    const handoff = createInitialUserMessageHandoff();
    prepareInitialUserMessageHandoff(
      handoff,
      sessionKey,
      {
        text: "history won the race",
        createdAt: 123,
      },
      hello,
    );
    const persisted = {
      role: "user",
      content: [{ type: "text", text: "history won the race" }],
      __openclaw: { seq: 1 },
    };
    const createdSession = { chatMessages: [persisted] as unknown[], hello };

    expect(
      reconcileInitialUserMessageHandoff(
        handoff,
        createdSession,
        routeSessionKey,
        [persisted],
        false,
      ),
    ).toBe(false);
    expect(createdSession.chatMessages).toEqual([persisted]);
    expect(
      admitInitialUserMessageHandoff(handoff, { chatMessages: [], hello }, routeSessionKey),
    ).toBe(false);
  });

  it("does not expose a pending prompt after reconnecting", () => {
    const sessionKey = "agent:main:new-session";
    const originalConnection = {};
    const handoff = createInitialUserMessageHandoff();
    prepareInitialUserMessageHandoff(
      handoff,
      sessionKey,
      { text: "private prompt", createdAt: 123 },
      originalConnection,
    );

    const replacementGatewaySession = { chatMessages: [] as unknown[], hello: {} };
    expect(admitInitialUserMessageHandoff(handoff, replacementGatewaySession, sessionKey)).toBe(
      false,
    );
    expect(replacementGatewaySession.chatMessages).toEqual([]);
  });
});

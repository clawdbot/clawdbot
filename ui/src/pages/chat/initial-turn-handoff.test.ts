import { describe, expect, it } from "vitest";
import { createInitialUserMessageHandoff } from "../../app/initial-user-message-handoff.ts";
import {
  admitInitialUserMessageHandoff,
  isPendingInitialUserMessage,
  prepareInitialUserMessageHandoff,
  reconcileInitialUserMessageHandoff,
} from "./initial-turn-handoff.ts";

describe("initial user message handoff", () => {
  it("reprojects an accepted first prompt across state replacement until history owns it", () => {
    const sessionKey = "agent:main:new-session";
    const client = {};
    const handoff = createInitialUserMessageHandoff();
    prepareInitialUserMessageHandoff(
      handoff,
      sessionKey,
      {
        text: "show this while the run is active",
        createdAt: 123,
      },
      client,
    );

    const otherSession = { chatMessages: [] as unknown[], client };
    expect(admitInitialUserMessageHandoff(handoff, otherSession, "agent:main:other")).toBe(false);
    expect(otherSession.chatMessages).toEqual([]);

    const createdSession = { chatMessages: [] as unknown[], client };
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
      client,
    );
    const secondActiveSession = { chatMessages: [] as unknown[], client };
    expect(admitInitialUserMessageHandoff(handoff, secondActiveSession, secondSessionKey)).toBe(
      true,
    );

    const assistantOutput = {
      role: "assistant",
      content: [{ type: "text", text: "already working" }],
    };
    const remountedSession = { chatMessages: [assistantOutput] as unknown[], client };
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
    const activeRunReset = { chatMessages: [] as unknown[], client };
    expect(admitInitialUserMessageHandoff(handoff, activeRunReset, sessionKey)).toBe(true);
    activeRunReset.chatMessages = [persisted];
    expect(
      reconcileInitialUserMessageHandoff(handoff, activeRunReset, sessionKey, [persisted], false),
    ).toBe(false);
    expect(admitInitialUserMessageHandoff(handoff, { chatMessages: [], client }, sessionKey)).toBe(
      false,
    );
  });

  it("identifies an already-projected prompt so history cannot re-place it", () => {
    const sessionKey = "agent:main:new-session";
    const client = {};
    const handoff = createInitialUserMessageHandoff();
    prepareInitialUserMessageHandoff(
      handoff,
      sessionKey,
      { text: "keep this above the replies it started", createdAt: 10 },
      client,
    );

    const host = { chatMessages: [] as unknown[], client };
    admitInitialUserMessageHandoff(handoff, host, sessionKey);
    const projected = host.chatMessages[0];

    expect(isPendingInitialUserMessage(handoff, host, sessionKey, projected)).toBe(true);
    expect(
      isPendingInitialUserMessage(handoff, host, sessionKey, {
        role: "assistant",
        content: [{ type: "text", text: "reply" }],
        timestamp: 11,
      }),
    ).toBe(false);
    expect(isPendingInitialUserMessage(handoff, host, "agent:main:other", projected)).toBe(false);
    expect(isPendingInitialUserMessage(undefined, host, sessionKey, projected)).toBe(false);
  });

  it("does not duplicate a first prompt that history already loaded", () => {
    const sessionKey = "agent:main:main";
    const routeSessionKey = "main";
    const client = {};
    const handoff = createInitialUserMessageHandoff();
    prepareInitialUserMessageHandoff(
      handoff,
      sessionKey,
      {
        text: "history won the race",
        createdAt: 123,
      },
      client,
    );
    const persisted = {
      role: "user",
      content: [{ type: "text", text: "history won the race" }],
      __openclaw: { seq: 1 },
    };
    const createdSession = { chatMessages: [persisted] as unknown[], client };

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
      admitInitialUserMessageHandoff(handoff, { chatMessages: [], client }, routeSessionKey),
    ).toBe(false);
  });

  it("reconciles an image prompt by accepted message sequence", () => {
    const sessionKey = "agent:main:image-session";
    const client = {};
    const handoff = createInitialUserMessageHandoff();
    prepareInitialUserMessageHandoff(
      handoff,
      sessionKey,
      {
        text: "inspect this image",
        attachments: [
          {
            id: "image-1",
            mimeType: "image/png",
            fileName: "image.png",
            sizeBytes: 68,
            dataUrl: "data:image/png;base64,iVBORw0KGgo=",
          },
        ],
        createdAt: 123,
      },
      client,
      { messageId: "initial-image-send", messageSeq: 1 },
    );
    const projectedSession = { chatMessages: [] as unknown[], client };
    expect(admitInitialUserMessageHandoff(handoff, projectedSession, sessionKey)).toBe(true);
    expect(projectedSession.chatMessages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "inspect this image" },
          {
            type: "image",
            url: "data:image/png;base64,iVBORw0KGgo=",
            source: { type: "url", url: "data:image/png;base64,iVBORw0KGgo=" },
          },
        ],
        timestamp: 123,
        __openclaw: { idempotencyKey: "initial-image-send:user", seq: 1 },
      },
    ]);
    const persisted = {
      role: "user",
      content: "inspect this image",
      idempotencyKey: "initial-image-send:user",
      __openclaw: {
        id: "persisted-image-prompt",
        seq: 1,
        media: [{ path: "/media/image-1", contentType: "image/png" }],
      },
    };
    const createdSession = { chatMessages: [persisted] as unknown[], client };
    const projectedMessage = projectedSession.chatMessages[0];

    expect(
      reconcileInitialUserMessageHandoff(handoff, createdSession, sessionKey, [persisted], true),
    ).toBe(true);
    expect(createdSession.chatMessages).toEqual([
      {
        role: "user",
        content: (projectedMessage as { content: unknown }).content,
        timestamp: 123,
        idempotencyKey: "initial-image-send:user",
        __openclaw: {
          id: "persisted-image-prompt",
          idempotencyKey: "initial-image-send:user",
          seq: 1,
        },
      },
    ]);
  });

  it("keeps a pending prompt across reconnects from the same browser client", () => {
    const sessionKey = "agent:main:new-session";
    const client = {};
    const handoff = createInitialUserMessageHandoff();
    prepareInitialUserMessageHandoff(
      handoff,
      sessionKey,
      { text: "private prompt", createdAt: 123 },
      client,
    );

    const reconnectedSession = { chatMessages: [] as unknown[], client };
    expect(admitInitialUserMessageHandoff(handoff, reconnectedSession, sessionKey)).toBe(true);
    expect(reconnectedSession.chatMessages).toHaveLength(1);
  });

  it("does not expose a pending prompt to a replacement gateway client", () => {
    const sessionKey = "agent:main:new-session";
    const handoff = createInitialUserMessageHandoff();
    prepareInitialUserMessageHandoff(
      handoff,
      sessionKey,
      { text: "private prompt", createdAt: 123 },
      {},
    );

    const replacementGatewaySession = { chatMessages: [] as unknown[], client: {} };
    expect(admitInitialUserMessageHandoff(handoff, replacementGatewaySession, sessionKey)).toBe(
      false,
    );
    expect(replacementGatewaySession.chatMessages).toEqual([]);
  });
});

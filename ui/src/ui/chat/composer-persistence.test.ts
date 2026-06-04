// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../../test-helpers/storage.ts";
import type { ChatQueueItem } from "../ui-types.ts";
import {
  loadChatComposerSnapshot,
  persistChatComposerState,
  removeStoredChatComposerQueueItem,
  restoreChatComposerState,
} from "./composer-persistence.ts";

function createState(overrides: Partial<Parameters<typeof persistChatComposerState>[0]> = {}) {
  return {
    settings: { gatewayUrl: "ws://gateway.test/control" },
    sessionKey: "agent:lily:main",
    chatMessage: "",
    chatQueue: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubGlobal("sessionStorage", createStorageMock());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("chat composer persistence", () => {
  it("restores draft text and queued messages for the same gateway session", () => {
    const queue: ChatQueueItem[] = [
      {
        id: "queued-1",
        text: "follow up after tools finish",
        createdAt: 1,
        attachments: [
          {
            id: "att-1",
            mimeType: "image/png",
            fileName: "screen.png",
            dataUrl: "data:image/png;base64,AAA",
          },
        ],
      },
    ];
    persistChatComposerState(
      createState({
        chatMessage: "unsent draft",
        chatQueue: queue,
      }),
    );

    const restored = createState();
    expect(restoreChatComposerState(restored)).toBe(true);

    expect(restored.chatMessage).toBe("unsent draft");
    expect(restored.chatQueue).toEqual(queue);
  });

  it("preserves Skill Workshop revision metadata on queued sends", () => {
    persistChatComposerState(
      createState({
        chatQueue: [
          {
            id: "revision-queued",
            text: "Make the support files 5",
            createdAt: 1,
            sessionKey: "agent:lily:main",
            agentId: "lily",
            sendState: "waiting-reconnect",
            skillWorkshopRevision: {
              proposalId: "support-file-sampler-20260531-68207b7b7f",
              agentId: "proposal-owner",
            },
          },
        ],
      }),
    );

    const restored = createState();
    expect(restoreChatComposerState(restored)).toBe(true);

    expect(restored.chatQueue).toEqual([
      {
        id: "revision-queued",
        text: "Make the support files 5",
        createdAt: 1,
        sessionKey: "agent:lily:main",
        agentId: "lily",
        sendState: "waiting-reconnect",
        skillWorkshopRevision: {
          proposalId: "support-file-sampler-20260531-68207b7b7f",
          agentId: "proposal-owner",
        },
      },
    ]);
  });

  it("scopes persisted composers by gateway and session key", () => {
    persistChatComposerState(createState({ chatMessage: "main draft" }));

    expect(
      loadChatComposerSnapshot(
        { settings: { gatewayUrl: "ws://gateway.test/control" } },
        "agent:lily:other",
      ),
    ).toBeNull();
    expect(
      loadChatComposerSnapshot(
        { settings: { gatewayUrl: "ws://other-gateway.test/control" } },
        "agent:lily:main",
      ),
    ).toBeNull();
  });

  it("scopes global-session composers by selected agent", () => {
    const queued: ChatQueueItem = {
      id: "queued-global",
      text: "agent-specific prompt",
      createdAt: 1,
      sessionKey: "global",
      agentId: "agent-a",
    };
    persistChatComposerState(
      createState({
        assistantAgentId: "agent-a",
        sessionKey: "global",
        chatMessage: "agent A draft",
        chatQueue: [queued],
      }),
    );

    expect(
      loadChatComposerSnapshot(
        { settings: { gatewayUrl: "ws://gateway.test/control" }, assistantAgentId: "agent-b" },
        "global",
      ),
    ).toBeNull();

    const restored = createState({ assistantAgentId: "agent-a", sessionKey: "global" });
    expect(restoreChatComposerState(restored)).toBe(true);
    expect(restored.chatMessage).toBe("agent A draft");
    expect(restored.chatQueue).toEqual([queued]);
  });

  it("clears the stored session when both draft and queue are empty", () => {
    persistChatComposerState(createState({ chatMessage: "clear me" }));
    persistChatComposerState(createState());

    expect(
      loadChatComposerSnapshot(
        { settings: { gatewayUrl: "ws://gateway.test/control" } },
        "agent:lily:main",
      ),
    ).toBeNull();
  });

  it("does not restore queued attachments without payload data", () => {
    persistChatComposerState(
      createState({
        chatQueue: [
          {
            id: "queued-1",
            text: "needs attachment",
            createdAt: 1,
            attachments: [{ id: "att-1", mimeType: "image/png", fileName: "screen.png" }],
          },
        ],
      }),
    );

    expect(
      loadChatComposerSnapshot(
        { settings: { gatewayUrl: "ws://gateway.test/control" } },
        "agent:lily:main",
      ),
    ).toBeNull();
  });

  it("keeps in-memory queue items when the stored snapshot only has a draft", () => {
    persistChatComposerState(createState({ chatMessage: "stored draft" }));
    const restored = createState({
      chatQueue: [{ id: "queued-1", text: "memory queue", createdAt: 1 }],
    });

    expect(restoreChatComposerState(restored)).toBe(true);

    expect(restored.chatMessage).toBe("stored draft");
    expect(restored.chatQueue).toEqual([{ id: "queued-1", text: "memory queue", createdAt: 1 }]);
  });

  it("keeps failed queued messages failed after restore", () => {
    const failed: ChatQueueItem = {
      id: "failed-1",
      text: "manual retry only",
      createdAt: 1,
      sendError: "send blocked",
      sendRunId: "run-failed",
      sendState: "failed",
    };
    persistChatComposerState(createState({ chatQueue: [failed] }));

    const restored = createState();
    expect(restoreChatComposerState(restored)).toBe(true);

    expect(restored.chatQueue).toEqual([failed]);
  });

  it("does not restore in-flight sends that may already have reached the gateway", () => {
    persistChatComposerState(
      createState({
        chatQueue: [
          {
            id: "sending-1",
            text: "possibly already sent",
            createdAt: 1,
            sendRunId: "run-sending",
            sendState: "sending",
          },
        ],
      }),
    );

    expect(
      loadChatComposerSnapshot(
        { settings: { gatewayUrl: "ws://gateway.test/control" } },
        "agent:lily:main",
      ),
    ).toBeNull();
  });

  it("restores pre-request model-wait sends for manual retry only", () => {
    persistChatComposerState(
      createState({
        chatQueue: [
          {
            id: "waiting-model-1",
            text: "not sent yet",
            createdAt: 1,
            sendRunId: "run-waiting-model",
            sendState: "waiting-model",
          },
        ],
      }),
    );

    const restored = createState();
    expect(restoreChatComposerState(restored)).toBe(true);

    expect(restored.chatQueue).toEqual([
      {
        id: "waiting-model-1",
        text: "not sent yet",
        createdAt: 1,
        sendRunId: "run-waiting-model",
        sendState: "failed",
        sendError: "Model selection was interrupted. Review and retry when ready.",
      },
    ]);
  });

  it("removes one stored queued item without dropping the stored draft", () => {
    persistChatComposerState(
      createState({
        chatMessage: "keep this draft",
        chatQueue: [
          { id: "remove-me", text: "stale queued send", createdAt: 1 },
          { id: "keep-me", text: "still queued", createdAt: 2 },
        ],
      }),
    );

    removeStoredChatComposerQueueItem(createState(), "agent:lily:main", "remove-me");

    expect(
      loadChatComposerSnapshot(
        { settings: { gatewayUrl: "ws://gateway.test/control" } },
        "agent:lily:main",
      ),
    ).toEqual({
      draft: "keep this draft",
      queue: [{ id: "keep-me", text: "still queued", createdAt: 2 }],
    });
  });

  it("does not restore steered messages tied to a previous active run", () => {
    persistChatComposerState(
      createState({
        chatQueue: [
          {
            id: "steered-1",
            text: "stale steer",
            createdAt: 1,
            kind: "steered",
            pendingRunId: "run-before-refresh",
          },
        ],
      }),
    );

    expect(
      loadChatComposerSnapshot(
        { settings: { gatewayUrl: "ws://gateway.test/control" } },
        "agent:lily:main",
      ),
    ).toBeNull();
  });
});

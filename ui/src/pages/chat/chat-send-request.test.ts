// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { ControlModelCommandError } from "../../../../packages/gateway-client/src/model/conversation.ts";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type { ChatState } from "./chat-history.ts";
import { isActiveLeafChangedError, requestChatSend } from "./chat-send-request.ts";

function makeState(overrides: Partial<ChatState> = {}): ChatState {
  return {
    client: { request: vi.fn() } as unknown as GatewayBrowserClient,
    connected: true,
    sessionKey: "agent:main",
    currentSessionId: "session-main",
    reconnectResumeSessionId: null,
    ...overrides,
  } as ChatState;
}

describe("requestChatSend", () => {
  it("routes the selected ordinary send through the Control Model", async () => {
    const request = vi.fn();
    const send = vi.fn(async () => ({
      runId: "run-model",
      status: "accepted",
      idempotencyKey: "send-one",
    }));
    const state = makeState({
      client: { request } as unknown as GatewayBrowserClient,
      controlModelConversation: { send } as unknown as ChatState["controlModelConversation"],
      controlModelConversationSessionKey: "agent:main",
      controlModelConversationAgentId: null,
    });

    await expect(
      requestChatSend(state, {
        message: "continue",
        attachments: [
          {
            id: "attachment-one",
            fileName: "notes.txt",
            mimeType: "text/plain",
            dataUrl: "data:text/plain;base64,aGVsbG8=",
          },
        ],
        runId: "send-one",
        replyToId: "message-one",
        expectedLeafEntryId: "leaf-one",
        expectedRunId: "run-active",
      }),
    ).resolves.toMatchObject({ runId: "run-model", status: "started" });

    expect(send).toHaveBeenCalledWith({
      message: "continue",
      sessionId: "session-main",
      attachments: [
        {
          type: "file",
          mimeType: "text/plain",
          fileName: "notes.txt",
          content: "aGVsbG8=",
        },
      ],
      idempotencyKey: "send-one",
      replyToId: "message-one",
      expectedLeafEntryId: "leaf-one",
      expectedRunId: "run-active",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("maps model command rejections into the incumbent send error contract", async () => {
    const send = vi.fn(async () => {
      throw new ControlModelCommandError({
        category: "retryable",
        code: "UNAVAILABLE",
        message: "try again",
        command: "chat.send",
        details: { reason: "active-leaf-changed" },
        retryable: true,
        retryAfterMs: 750,
      });
    });
    const state = makeState({
      controlModelConversation: { send } as unknown as ChatState["controlModelConversation"],
      controlModelConversationSessionKey: "agent:main",
      controlModelConversationAgentId: null,
    });

    const rejection = await requestChatSend(state, {
      message: "continue",
      runId: "send-retry",
    }).catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(GatewayRequestError);
    expect(rejection).toMatchObject({
      code: "UNAVAILABLE",
      message: "try again",
      retryable: true,
      retryAfterMs: 750,
    });
    expect(isActiveLeafChangedError(rejection)).toBe(true);
  });

  it("keeps reconnect-resume sends on the incumbent Gateway path", async () => {
    const request = vi.fn(async () => ({ runId: "run-raw", status: "accepted" }));
    const send = vi.fn();
    const state = makeState({
      client: { request } as unknown as GatewayBrowserClient,
      reconnectResumeSessionId: "session-main",
      controlModelConversation: { send } as unknown as ChatState["controlModelConversation"],
      controlModelConversationSessionKey: "agent:main",
      controlModelConversationAgentId: null,
    });

    await requestChatSend(state, { message: "resume", runId: "send-resume" });

    expect(send).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith(
      "chat.send",
      expect.objectContaining({
        sessionId: "session-main",
        __controlUiReconnectResume: true,
      }),
    );
    expect(state.reconnectResumeSessionId).toBeNull();
  });

  it("keeps steer sends on the incumbent Gateway path", async () => {
    const request = vi.fn(async () => ({ runId: "run-steer", status: "accepted" }));
    const send = vi.fn();
    const state = makeState({
      client: { request } as unknown as GatewayBrowserClient,
      controlModelConversation: { send } as unknown as ChatState["controlModelConversation"],
      controlModelConversationSessionKey: "agent:main",
      controlModelConversationAgentId: null,
    });

    await requestChatSend(state, {
      message: "adjust",
      runId: "send-steer",
      queueMode: "steer",
    });

    expect(send).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith(
      "chat.send",
      expect.objectContaining({ queueMode: "steer" }),
    );
  });
});

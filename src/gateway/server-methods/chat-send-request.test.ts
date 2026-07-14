import { describe, expect, it } from "vitest";
import { normalizeChatSendRequest } from "./chat-send-request.js";

function validParams(overrides: Record<string, unknown> = {}) {
  return {
    sessionKey: "agent:main:main",
    message: " hello ",
    idempotencyKey: "request-1",
    ...overrides,
  };
}

describe("normalizeChatSendRequest", () => {
  it("normalizes the message and derives the main-turn defaults", () => {
    const result = normalizeChatSendRequest({ params: validParams(), client: null });

    expect(result).toMatchObject({
      ok: true,
      value: {
        inboundMessage: " hello ",
        rawMessage: "hello",
        stopCommand: false,
        turnKind: "main",
        normalizedAttachments: [],
        reconnectResumeRequested: false,
      },
    });
  });

  it("rejects an empty text-and-attachment request", () => {
    const result = normalizeChatSendRequest({
      params: validParams({ message: "  " }),
      client: null,
    });

    expect(result).toEqual({ ok: false, error: "message or attachment required" });
  });

  it("accepts an attachment-only request after attachment normalization", () => {
    const result = normalizeChatSendRequest({
      params: validParams({
        message: "",
        attachments: [{ mimeType: "text/plain", content: "aGVsbG8=" }],
      }),
      client: null,
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        rawMessage: "",
        normalizedAttachments: [{ mimeType: "text/plain", content: "aGVsbG8=" }],
      },
    });
  });

  it("rejects partial explicit-origin fields before session work", () => {
    const result = normalizeChatSendRequest({
      params: validParams({ originatingChannel: "slack" }),
      client: null,
    });

    expect(result).toEqual({
      ok: false,
      error: "originatingTo is required when using originating route fields",
    });
  });

  it("rejects reserved provenance controls without admin scope", () => {
    const result = normalizeChatSendRequest({
      params: validParams({ suppressCommandInterpretation: true }),
      client: null,
    });

    expect(result).toEqual({
      ok: false,
      error: "system provenance fields require admin scope",
    });
  });
});

import { describe, expect, it } from "vitest";
import { normalizeChatSendRequest } from "./chat-send-request.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

function copilotClient(caps: string[] = []): NonNullable<GatewayRequestHandlerOptions["client"]> {
  return {
    connId: "copilot",
    pairedClientId: "openclaw-browser-copilot",
    connect: {
      role: "operator",
      scopes: ["operator.read", "operator.write"],
      caps,
      client: {
        id: "openclaw-browser-copilot",
        version: "test",
        platform: "chrome",
        mode: "ui",
      },
    },
  } as unknown as NonNullable<GatewayRequestHandlerOptions["client"]>;
}

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

  it("requires capable copilot runs to carry explicit tool bindings", () => {
    expect(normalizeChatSendRequest({ params: validParams(), client: copilotClient() })).toEqual({
      ok: false,
      error: "browser copilot runs require an explicit browser tool binding",
    });

    expect(
      normalizeChatSendRequest({
        params: validParams({ toolBindings: { unrelated: true } }),
        client: copilotClient(["run-tool-bindings"]),
      }),
    ).toEqual({
      ok: false,
      error: "browser copilot runs require an explicit browser tool binding",
    });

    const toolBindings = { browser: { kind: "tab", tabId: 1, targetId: "target" } };
    expect(
      normalizeChatSendRequest({
        params: validParams({ toolBindings }),
        client: copilotClient(),
      }),
    ).toEqual({ ok: false, error: "run tool bindings require client capability" });
    expect(
      normalizeChatSendRequest({
        params: validParams({ toolBindings }),
        client: copilotClient(["run-tool-bindings"]),
      }),
    ).toMatchObject({ ok: true, value: { p: { toolBindings } } });
  });

  it("accepts tool bindings only from a server-paired copilot identity", () => {
    const toolBindings = { browser: { kind: "tab", tabId: 1, targetId: "target" } };
    const unpaired = copilotClient(["run-tool-bindings"]);
    unpaired.pairedClientId = undefined;
    expect(
      normalizeChatSendRequest({ params: validParams({ toolBindings }), client: unpaired }),
    ).toEqual({ ok: false, error: "run tool bindings require a paired browser copilot" });

    const otherClient = copilotClient(["run-tool-bindings"]);
    otherClient.connect.client.id = "openclaw-control-ui";
    expect(
      normalizeChatSendRequest({ params: validParams({ toolBindings }), client: otherClient }),
    ).toEqual({ ok: false, error: "run tool bindings require a paired browser copilot" });
  });
});

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
  it.each(["clear the backlog", "/stop", "/btw investigate", "  résumé\n\n  preserve spacing  "])(
    "admits Goal objective %j literally without command interpretation",
    (message) => {
      expect(
        normalizeChatSendRequest({
          params: validParams({
            message,
            intent: { kind: "session-goal-start", version: 1, issuedAtMs: Date.now() },
          }),
          client: null,
        }),
      ).toMatchObject({
        ok: true,
        value: {
          inboundMessage: message,
          rawMessage: message,
          stopCommand: false,
          turnKind: "main",
          suppressCommandInterpretation: true,
          goalOperation: { action: "start", objective: message, operationId: "request-1" },
        },
      });
    },
  );

  it.each([
    { message: "  " },
    { message: "x".repeat(16_001) },
    { message: "bad\u0001text" },
    { queueMode: "steer" },
    { thinking: "high" },
    { fastMode: "on" },
    { fastAutoOnSeconds: 10 },
    { timeoutMs: 1000 },
    { deliver: true },
    { idempotencyKey: "x".repeat(129) },
    { intent: { kind: "session-goal-resume", version: 1, issuedAtMs: 1 } },
    { intent: { kind: "session-goal-start", version: 2, issuedAtMs: 1 } },
    { intent: { kind: "session-goal-start", version: 1 } },
    {
      intent: { kind: "session-goal-start", version: 1, issuedAtMs: 1, objective: "second target" },
    },
  ])("rejects invalid Goal intent before admission: %j", (overrides) => {
    expect(
      normalizeChatSendRequest({
        params: validParams({
          intent: { kind: "session-goal-start", version: 1, issuedAtMs: Date.now() },
          ...overrides,
        }),
        client: null,
      }),
    ).toMatchObject({ ok: false });
  });

  it("binds Goal retries to immutable attachments, reply context, options, and timestamp", () => {
    const base = validParams({
      intent: { kind: "session-goal-start", version: 1, issuedAtMs: 1 },
      attachments: [{ mimeType: "text/plain", content: "aGVsbG8=" }],
      replyToId: "reply-1",
    });
    const fingerprint = (params: Record<string, unknown>) => {
      const result = normalizeChatSendRequest({ params, client: null });
      if (!result.ok) {
        throw new Error(result.error);
      }
      return result.value.goalOperation?.requestFingerprint;
    };
    const original = fingerprint(base);
    expect(fingerprint(Object.fromEntries(Object.entries(base).toReversed()))).toBe(original);
    for (const change of [
      { attachments: [] },
      { replyToId: "reply-2" },
      { sessionId: "other-session" },
      { message: "different" },
      { intent: { kind: "session-goal-start", version: 1, issuedAtMs: 2 } },
    ]) {
      expect(fingerprint({ ...base, ...change })).not.toBe(original);
    }
  });

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

  it("accepts start-or-steer requests with or without a transcript leaf", () => {
    expect(
      normalizeChatSendRequest({
        params: validParams({ queueMode: "steer" }),
        client: null,
      }),
    ).toMatchObject({ ok: true });
    expect(
      normalizeChatSendRequest({
        params: validParams({
          queueMode: "steer",
          expectedLeafEntryId: "leaf-1",
        }),
        client: null,
      }),
    ).toMatchObject({ ok: true });
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

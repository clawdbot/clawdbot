import { describe, expect, it, vi } from "vitest";
import {
  applyChatDelta,
  buildCopilotChatSendParams,
  createChatStream,
  deriveTabSessionKey,
  gatewayUrlFromPairing,
  normalizeGatewayUrl,
  readMessageText,
  renderMarkdownLite,
} from "./panel-core.js";

describe("browser copilot panel contracts", () => {
  it("mints isolated thread keys without exposing reusable tab ids", () => {
    const first = deriveTabSessionKey("agent:main:main", "11111111-1111-4111-8111-111111111111");
    const second = deriveTabSessionKey(
      "agent:main:main:thread:old",
      "22222222-2222-4222-8222-222222222222",
    );
    expect(first).toBe(
      "agent:main:main:thread:browser-copilot-11111111-1111-4111-8111-111111111111",
    );
    expect(second).toBe(
      "agent:main:main:thread:browser-copilot-22222222-2222-4222-8222-222222222222",
    );
    expect(first).not.toBe(second);
    expect(deriveTabSessionKey("agent:main:main", "tab-7")).toBeNull();
  });

  it("derives only secure remote or loopback Gateway endpoints", () => {
    expect(gatewayUrlFromPairing("wss://gateway.example/base/browser/extension", undefined)).toBe(
      "wss://gateway.example/base",
    );
    expect(gatewayUrlFromPairing("ws://127.0.0.1:18792/extension", "ws://127.0.0.1:18789")).toBe(
      "ws://127.0.0.1:18789/",
    );
    expect(normalizeGatewayUrl("ws://gateway.example")).toBeNull();
    const credentialed = new URL("wss://gateway.example");
    credentialed.username = "fixture-user";
    credentialed.password = "test-password";
    expect(normalizeGatewayUrl(credentialed.toString())).toBeNull();
  });

  it("builds a local-only delivery with the trusted browser binding", () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("33333333-3333-4333-8333-333333333333");
    const binding = {
      kind: "tab",
      tabId: 7,
      target: "host",
      profile: "chrome",
      targetId: "target-7",
    } as const;
    expect(
      buildCopilotChatSendParams({
        binding,
        message: "  inspect this  ",
        sessionId: "session-7",
        sessionKey: "agent:main:main:thread:browser-copilot-x",
      }),
    ).toEqual({
      sessionKey: "agent:main:main:thread:browser-copilot-x",
      sessionId: "session-7",
      message: "inspect this",
      idempotencyKey: "33333333-3333-4333-8333-333333333333",
      deliver: false,
      toolBindings: { browser: binding },
    });
  });

  it("renders cumulative deltas once and escapes page-controlled markup", () => {
    const stream = createChatStream();
    expect(applyChatDelta(stream, { runId: "run", deltaText: "Hello" })).toEqual({
      text: "Hello",
      newBubble: true,
    });
    expect(
      applyChatDelta(stream, {
        runId: "run",
        message: { content: [{ text: "Hello world" }] },
      }),
    ).toEqual({ text: "Hello world", newBubble: false });
    expect(renderMarkdownLite("<img src=x> **safe**")).toBe(
      "&lt;img src=x&gt; <strong>safe</strong>",
    );
  });

  it("projects only visible text from history content", () => {
    expect(readMessageText({ content: [{ type: "text", text: "one" }, { text: "two" }] })).toBe(
      "one\ntwo",
    );
    expect(readMessageText({ content: [{ type: "image", data: "secret" }] })).toBe("");
  });
});

import { describe, expect, it } from "vitest";
import { resolveOpencodeSessionHeaders } from "./session-affinity.js";

describe("OpenCode conversation headers", () => {
  it.each([
    "https://proxy.example/zen/v1",
    "https://opencode.ai.example/zen/v1",
    "https://opencode.ai@proxy.example/zen/v1",
    "https://unrelated.opencode.ai/zen/v1",
    "http://opencode.ai/zen/v1",
    "not a URL",
  ])("does not send conversation identity to %s", (baseUrl) => {
    const headers = { "X-Custom": "keep" };
    expect(resolveOpencodeSessionHeaders({ baseUrl }, { sessionId: "conversation", headers })).toBe(
      headers,
    );
  });

  it("keeps conversation identity stable across requests and distinct across conversations", () => {
    const baseUrl = "https://OPENCODE.AI./zen/go/v1";
    const first = resolveOpencodeSessionHeaders({ baseUrl }, { sessionId: "conversation-a" });
    expect(first).toEqual({ "x-opencode-session": "conversation-a" });
    expect(resolveOpencodeSessionHeaders({ baseUrl }, { sessionId: "conversation-a" })).toEqual(
      first,
    );
    expect(resolveOpencodeSessionHeaders({ baseUrl }, { sessionId: "conversation-b" })).toEqual({
      "x-opencode-session": "conversation-b",
    });
  });

  it("preserves an explicit header case-insensitively and does not mutate caller headers", () => {
    const headers = { "X-OpenCode-Session": "configured", "X-Custom": "keep" };
    expect(
      resolveOpencodeSessionHeaders(
        { baseUrl: "https://opencode.ai/zen/v1" },
        {
          sessionId: "conversation",
          headers,
        },
      ),
    ).toBe(headers);
    expect(headers).toEqual({ "X-OpenCode-Session": "configured", "X-Custom": "keep" });
  });

  it("preserves explicit model-level conversation identity", () => {
    const model = {
      baseUrl: "https://opencode.ai/zen/v1",
      headers: { "X-OpenCode-Session": "model-session" },
    };
    const headers = { "X-Custom": "keep" };
    expect(resolveOpencodeSessionHeaders(model, { sessionId: "conversation", headers })).toBe(
      headers,
    );
    expect(resolveOpencodeSessionHeaders(model, { sessionId: "conversation" })).toBeUndefined();
  });

  it("does not invent a shared conversation for sessionless requests", () => {
    expect(
      resolveOpencodeSessionHeaders({ baseUrl: "https://opencode.ai/zen/v1" }),
    ).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { resolveOpencodeSessionHeaders } from "./session-affinity.js";

describe("resolveOpencodeSessionHeaders", () => {
  const model = (baseUrl: string, headers?: Record<string, string>) => ({ baseUrl, headers });

  it.each(["https://opencode.ai/zen/v1", "https://opencode.ai./zen/go/v1"])(
    "identifies an OpenCode conversation at %s",
    (baseUrl) => {
      expect(
        resolveOpencodeSessionHeaders(model(baseUrl), {
          sessionId: "conversation-123",
          headers: { "x-existing": "kept" },
        }),
      ).toEqual({ "x-existing": "kept", "x-opencode-session": "conversation-123" });
    },
  );

  it("preserves an explicitly configured session header case-insensitively", () => {
    expect(
      resolveOpencodeSessionHeaders(
        model("https://opencode.ai/zen/v1", { "X-OpenCode-Session": "configured" }),
        { sessionId: "conversation-123", headers: { "x-existing": "kept" } },
      ),
    ).toEqual({ "x-existing": "kept" });
  });

  it.each([
    "http://opencode.ai/zen/v1",
    "https://proxy.opencode.ai/zen/v1",
    "https://opencode.ai.example/zen/v1",
    "not a URL",
  ])("does not identify an unrelated endpoint at %s", (baseUrl) => {
    expect(
      resolveOpencodeSessionHeaders(model(baseUrl), { sessionId: "conversation-123" }),
    ).toBeUndefined();
  });
});

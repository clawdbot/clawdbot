// Codex tests cover plugin app cache key plugin behavior.
import { describe, expect, it } from "vitest";
import { resolveCodexPluginAppCacheEndpoint } from "./plugin-app-cache-key.js";

describe("resolveCodexPluginAppCacheEndpoint", () => {
  it("keys plugin app inventory by websocket credentials without exposing them", () => {
    const first = resolveCodexPluginAppCacheEndpoint({
      start: {
        transport: "websocket",
        command: "codex",
        args: [],
        url: "ws://127.0.0.1:39175",
        authToken: "token-first",
        headers: { Authorization: "Bearer first" },
      },
    });
    const second = resolveCodexPluginAppCacheEndpoint({
      start: {
        transport: "websocket",
        command: "codex",
        args: [],
        url: "ws://127.0.0.1:39175",
        authToken: "token-second",
        headers: { Authorization: "Bearer second" },
      },
    });

    expect(first).not.toEqual(second);
    expect(first).not.toContain("token-first");
    expect(first).not.toContain("Bearer first");
    expect(second).not.toContain("token-second");
    expect(second).not.toContain("Bearer second");
  });
});

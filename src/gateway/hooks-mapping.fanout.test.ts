// Hook mapping fan-out tests protect the per-item action contract: one action
// per payload array element, per-item template payloads, the item cap, and the
// producer-derived gmail body bound.
import { describe, expect, it } from "vitest";
import { applyHookMappings, resolveHookMappings } from "./hooks-mapping.js";

describe("hook mapping fan-out", () => {
  const fanOutUrl = new URL("http://127.0.0.1:18789/hooks/gmail");

  function applyGmailPreset(payload: Record<string, unknown>) {
    const mappings = resolveHookMappings({ presets: ["gmail"] });
    return applyHookMappings(mappings, { payload, headers: {}, url: fanOutUrl, path: "gmail" });
  }

  it("renders one action per batched gmail message with per-message session keys", async () => {
    const result = await applyGmailPreset({
      messages: [
        { id: "m1", from: "a@example.com", subject: "One" },
        { id: "m2", from: "b@example.com", subject: "Two" },
      ],
    });
    expect(result?.ok).toBe(true);
    if (!result?.ok) {
      return;
    }
    expect(result.fanout).toBe(true);
    expect(result.dropped).toBe(0);
    expect(result.actions).toHaveLength(2);
    const agentActions = result.actions.filter((action) => action.kind === "agent");
    expect(agentActions.map((action) => action.sessionKey)).toEqual([
      "hook:gmail:m1",
      "hook:gmail:m2",
    ]);
    expect(agentActions[0]?.message).toContain("a@example.com");
    expect(agentActions[0]?.message).toContain("One");
    expect(agentActions[1]?.message).toContain("b@example.com");
    expect(agentActions[1]?.message).toContain("Two");
  });

  it("produces no actions for an empty or missing fan-out array", async () => {
    for (const payload of [{ messages: [] }, {}, { messages: "not-an-array" }]) {
      const result = await applyGmailPreset(payload as Record<string, unknown>);
      expect(result).toMatchObject({ ok: true, actions: [], fanout: true, dropped: 0 });
    }
  });

  it("attaches the producer-derived body bound to every gmail-path mapping", () => {
    const mappings = resolveHookMappings({
      presets: ["gmail"],
      mappings: [
        {
          id: "gmail-safe-reader",
          match: { path: "gmail" },
          action: "agent",
          forEach: "messages",
          messageTemplate: "{{messages[0].subject}}",
        },
        { id: "other", match: { path: "other" }, action: "agent", messageTemplate: "x" },
      ],
      gmail: { maxBytes: 10_000 },
    });
    const expected = 100 * (10_000 * 3 + 8_192);
    expect(mappings.find((mapping) => mapping.id === "gmail-safe-reader")?.maxBodyBytes).toBe(
      expected,
    );
    expect(mappings.find((mapping) => mapping.id === "gmail")?.maxBodyBytes).toBe(expected);
    expect(mappings.find((mapping) => mapping.id === "other")?.maxBodyBytes).toBeUndefined();
  });

  it("rejects nested forEach paths", () => {
    expect(() =>
      resolveHookMappings({
        mappings: [
          {
            id: "nested",
            match: { path: "gmail" },
            action: "agent",
            forEach: "data.messages",
            messageTemplate: "x",
          },
        ],
      }),
    ).toThrow(/forEach must be a top-level payload key/);
  });
});

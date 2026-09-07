import { expect, it, vi } from "vitest";

vi.mock("../runtime/index.js", () => {
  throw new Error("session storage must not load the agent runtime facade");
});

vi.mock("../../plugin-sdk/agent-core.js", () => {
  throw new Error("session storage must not load the plugin SDK agent runtime adapter");
});

it("creates sessions and builds context without loading agent runtime facades", async () => {
  const { SessionManager, buildSessionContext } = await import("./session-manager.js");
  const { uuidv7 } = await import("../../../packages/agent-core/src/harness/session/uuid.js");
  const now = vi.spyOn(Date, "now").mockReturnValue(Date.now());
  try {
    // Hold the clock so ordering depends on the shared UUID sequence.
    const before = uuidv7();
    const manager = SessionManager.inMemory("/workspace");
    const sessionIds = [
      before,
      manager.getSessionId(),
      uuidv7(),
      SessionManager.inMemory("/workspace").getSessionId(),
      uuidv7(),
    ];
    expect(sessionIds).toEqual(sessionIds.toSorted());
    expect(new Set(sessionIds).size).toBe(sessionIds.length);
    for (const id of sessionIds) {
      expect(id).toMatch(/^[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
    }

    const message = { role: "user" as const, content: "session context", timestamp: 1 };
    const entryIds = [
      manager.appendThinkingLevelChange("high"),
      manager.appendModelChange("test-provider", "test-model"),
      manager.appendMessage(message),
    ];
    for (const id of entryIds) {
      expect(id).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
    }
    const expected = {
      messages: [message],
      thinkingLevel: "high",
      model: { provider: "test-provider", modelId: "test-model" },
    };
    expect(manager.buildSessionContext()).toEqual(expected);
    expect(buildSessionContext(manager.getEntries())).toEqual(expected);
  } finally {
    now.mockRestore();
  }
});

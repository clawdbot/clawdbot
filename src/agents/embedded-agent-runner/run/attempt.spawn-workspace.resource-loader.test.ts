// Coverage for explicit resource-loader wiring during attempt session creation.
import { describe, expect, it, vi } from "vitest";
import { createEmbeddedAgentSessionWithResourceLoader } from "./attempt-session.js";

describe("runEmbeddedAttempt resource loader wiring", () => {
  it("passes an explicit resourceLoader to createAgentSession even without extension factories", async () => {
    // The resource loader is an explicit runtime dependency; it must be passed
    // even when no inline extension factories are present.
    const resourceLoader = { reload: vi.fn() };
    const createAgentSession = vi.fn(async () => ({ session: { id: "session" } }));

    await createEmbeddedAgentSessionWithResourceLoader({
      createAgentSession,
      options: {
        cwd: "/tmp/workspace",
        agentDir: "/tmp/agent",
        authStorage: {},
        modelRegistry: {},
        model: {},
        thinkingLevel: undefined,
        tools: [],
        customTools: [],
        sessionManager: {},
        settingsManager: {},
        resourceLoader,
      },
    });

    expect(createAgentSession).toHaveBeenCalledOnce();
    const calls = createAgentSession.mock.calls as unknown as Array<[{ resourceLoader?: unknown }]>;
    const options = calls[0]?.[0];
    if (!options) {
      throw new Error("Expected createAgentSession options");
    }
    expect(options.resourceLoader).toBe(resourceLoader);
  });
});

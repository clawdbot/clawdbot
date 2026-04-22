import { describe, expect, it, vi } from "vitest";
import { createEmbeddedAgentSessionWithResourceLoader } from "./attempt-session.js";

describe("runEmbeddedAttempt resource loader wiring", () => {
  it("passes an explicit resourceLoader to createAgentSession even without extension factories", async () => {
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
    expect(createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceLoader,
      }),
    );
  });
});

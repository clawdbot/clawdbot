/** Tests ACP translator session creation rate limiting. */
import { createInMemorySessionStore } from "@openclaw/acp-core/session";
import { describe, expect, it, vi } from "vitest";
import {
  createNewSessionRequest,
  createLoadSessionRequest,
} from "./translator.bridge-test-helpers.js";
import { AcpGatewayAgent } from "./translator.js";
import { createAcpConnection, createAcpGateway } from "./translator.test-helpers.js";

vi.mock("./commands.js", () => ({
  getAvailableCommands: () => [],
}));

describe("acp session creation rate limit", () => {
  it("rate limits excessive newSession bursts", async () => {
    const sessionStore = createInMemorySessionStore();
    const agent = new AcpGatewayAgent(createAcpConnection(), createAcpGateway(), {
      sessionStore,
      sessionCreateRateLimit: {
        maxRequests: 1,
        windowMs: 60_000,
      },
    });

    await agent.newSession(createNewSessionRequest());
    await expect(agent.newSession(createNewSessionRequest())).rejects.toThrow(
      /session creation rate limit exceeded/i,
    );

    sessionStore.clearAllSessionsForTest();
  });

  it("does not count loadSession refreshes for an existing session ID", async () => {
    const sessionStore = createInMemorySessionStore();
    const agent = new AcpGatewayAgent(createAcpConnection(), createAcpGateway(), {
      sessionStore,
      sessionCreateRateLimit: {
        maxRequests: 1,
        windowMs: 60_000,
      },
    });

    await agent.loadSession(createLoadSessionRequest("shared-session"));
    await agent.loadSession(createLoadSessionRequest("shared-session"));
    await expect(agent.loadSession(createLoadSessionRequest("new-session"))).rejects.toThrow(
      /session creation rate limit exceeded/i,
    );

    sessionStore.clearAllSessionsForTest();
  });

  it("falls back for non-finite session creation rate limit overrides", async () => {
    const sessionStore = createInMemorySessionStore();
    const agent = new AcpGatewayAgent(createAcpConnection(), createAcpGateway(), {
      sessionStore,
      sessionCreateRateLimit: {
        maxRequests: Number.NaN,
        windowMs: Number.NaN,
      },
    });

    await expect(agent.newSession(createNewSessionRequest())).resolves.toMatchObject({
      sessionId: expect.any(String),
    });
    await expect(agent.newSession(createNewSessionRequest())).resolves.toMatchObject({
      sessionId: expect.any(String),
    });

    sessionStore.clearAllSessionsForTest();
  });
});

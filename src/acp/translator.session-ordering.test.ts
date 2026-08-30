import type { AgentSideConnection } from "@agentclientprotocol/sdk";
/** Tests deferred notification delivery ordering and close-then-resume identity guard. */
import { createInMemorySessionStore } from "@openclaw/acp-core/session";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "../gateway/client.js";
import type { AcpEventLedger } from "./event-ledger.js";
import { createNewSessionRequest, expectSessionUpdate } from "./translator.bridge-test-helpers.js";
import { AcpGatewayAgent } from "./translator.js";
import { AcpTranslatorSessionUpdates } from "./translator.session-updates.js";
import { createAcpConnection, createAcpGateway } from "./translator.test-helpers.js";

vi.mock("./commands.js", () => ({
  getAvailableCommands: () => [],
}));

function createResumeSessionRequest(sessionId: string, cwd = "/tmp") {
  return {
    sessionId,
    cwd,
    mcpServers: [],
    _meta: {},
  } as never;
}

async function flushTimers() {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** Gateway mock that returns a resumable session for sessions.list searches. */
function createResumableGateway(): GatewayClient {
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === "sessions.list") {
      return {
        ts: Date.now(),
        path: "/tmp/sessions.json",
        count: 1,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [
          {
            key: typeof params?.search === "string" ? params.search : "agent:main:resumable",
            label: "resumable",
            displayName: "Resumable",
            kind: "direct",
            updatedAt: 1_710_000_000_000,
            thinkingLevel: "adaptive",
            modelProvider: "openai",
            model: "gpt-5.4",
          },
        ],
      };
    }
    return { ok: true };
  }) as GatewayClient["request"];
  return createAcpGateway(request);
}

describe("acp session notification ordering", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("newSession: response precedes session_info_update notification", async () => {
    const sessionStore = createInMemorySessionStore();
    const connection = createAcpConnection();
    const sessionUpdate = connection["__sessionUpdateMock"];
    const agent = new AcpGatewayAgent(connection, createAcpGateway(), {
      sessionStore,
    });

    const result = await agent.newSession(createNewSessionRequest());

    expect(result.sessionId).toEqual(expect.any(String));
    expect(sessionUpdate).not.toHaveBeenCalled();

    await flushTimers();
    expectSessionUpdate(sessionUpdate, result.sessionId, "session_info_update");
    expectSessionUpdate(sessionUpdate, result.sessionId, "available_commands_update");
  });

  it("resumeSession: response precedes session_info_update notification", async () => {
    const sessionStore = createInMemorySessionStore();
    const connection = createAcpConnection();
    const sessionUpdate = connection["__sessionUpdateMock"];
    const agent = new AcpGatewayAgent(connection, createResumableGateway(), {
      sessionStore,
    });

    const result = await agent.resumeSession(createResumeSessionRequest("agent:main:resumable"));

    expect(result.modes).toBeDefined();
    expect(sessionUpdate).not.toHaveBeenCalled();

    await flushTimers();
    expectSessionUpdate(sessionUpdate, "agent:main:resumable", "session_info_update");
  });

  it("newSession suppresses deferred notifications when closeSession runs before the timer fires", async () => {
    const sessionStore = createInMemorySessionStore();
    const connection = createAcpConnection();
    const sessionUpdate = connection["__sessionUpdateMock"];
    const agent = new AcpGatewayAgent(connection, createAcpGateway(), {
      sessionStore,
    });

    const result = await agent.newSession(createNewSessionRequest());
    await agent.closeSession({ sessionId: result.sessionId } as never);

    await flushTimers();
    expect(sessionUpdate).not.toHaveBeenCalled();
  });

  it("resumeSession suppresses deferred notifications when closeSession runs before the timer fires", async () => {
    const sessionStore = createInMemorySessionStore();
    const connection = createAcpConnection();
    const sessionUpdate = connection["__sessionUpdateMock"];
    const agent = new AcpGatewayAgent(connection, createResumableGateway(), {
      sessionStore,
    });

    await agent.resumeSession(createResumeSessionRequest("agent:main:resumable"));
    await agent.closeSession({ sessionId: "agent:main:resumable" } as never);

    await flushTimers();
    expect(sessionUpdate).not.toHaveBeenCalled();
  });

  it("does not leak stale notifications from a closed session into a resumed session with the same ID", async () => {
    const sessionStore = createInMemorySessionStore();
    const connection = createAcpConnection();
    const sessionUpdate = connection["__sessionUpdateMock"];
    const agent = new AcpGatewayAgent(connection, createResumableGateway(), {
      sessionStore,
    });

    // Resume arms a deferred callback, then close removes the session instance.
    await agent.resumeSession(createResumeSessionRequest("agent:main:resumable"));
    await agent.closeSession({ sessionId: "agent:main:resumable" } as never);

    // Resume again with the same ID before the timer fires. The old callback's
    // deliveryGuard compares against the captured (now-deleted) session instance
    // and must suppress delivery; the new session's own callbacks deliver later.
    await agent.resumeSession(createResumeSessionRequest("agent:main:resumable"));

    await flushTimers();
    // Exactly one session_info_update (from the new lifecycle), not two.
    const infoUpdates = vi
      .mocked(sessionUpdate)
      .mock.calls.filter(
        ([call]) =>
          (call as { update: { sessionUpdate: string } }).update.sessionUpdate ===
          "session_info_update",
      );
    expect(infoUpdates.length).toBe(1);
  });
});

describe("acp session command discovery failure", () => {
  it("emit with deferDelivery propagates command discovery failure to the caller", async () => {
    // Unit-level proof: sendAvailableCommands awaits getAvailableCommands inside
    // emit before deferring delivery, so a discovery failure rejects the caller's
    // promise (newSession/resumeSession) rather than being swallowed.
    const failingCommands = vi.fn(async () => {
      throw new Error("command discovery unavailable");
    });
    const updates = new AcpTranslatorSessionUpdates({
      connection: {
        sessionUpdate: vi.fn(async () => {}),
      } as Pick<AgentSideConnection, "sessionUpdate">,
      eventLedger: createLedger(),
      getAvailableCommands: failingCommands,
      log: () => {},
    });

    await expect(
      updates.sendAvailableCommands(
        { sessionId: "session-1", sessionKey: "agent:main:session-1" },
        { record: true, deferDelivery: true, deliveryGuard: () => true },
      ),
    ).rejects.toThrow(/command discovery unavailable/);
  });
});

function createLedger(): AcpEventLedger {
  return {
    startSession: vi.fn(async () => {}),
    recordUserPrompt: vi.fn(async () => {}),
    recordUpdate: vi.fn(async () => {}),
    markIncomplete: vi.fn(async () => {}),
    readReplay: vi.fn(async () => ({ complete: true, events: [] })),
    readReplayBySessionId: vi.fn(async () => ({ complete: true, events: [] })),
    readReplayBySessionKey: vi.fn(async () => ({ complete: true, events: [] })),
  };
}

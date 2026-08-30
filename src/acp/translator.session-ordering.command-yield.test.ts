/** Tests that a yielding command-module import cannot let the snapshot timer
 * fire before the lifecycle RPC result is returned.
 *
 * The real getAvailableCommandsForAcp uses a lazy dynamic import that yields to
 * the macrotask queue on first call. If commands are resolved AFTER arming the
 * snapshot delivery timer, that yield lets the timer fire and send
 * session_info_update before the session/new or session/resume response. This
 * test injects a yielding stub to prove the pre-fetch fix holds. */
import { createInMemorySessionStore } from "@openclaw/acp-core/session";
import { describe, expect, it, vi } from "vitest";
import { createNewSessionRequest, expectSessionUpdate } from "./translator.bridge-test-helpers.js";
import { AcpGatewayAgent } from "./translator.js";
import { createAcpConnection, createAcpGateway } from "./translator.test-helpers.js";

// Yield to the macrotask queue before returning, simulating the lazy
// command-module dynamic-import yield that triggers the ordering race.
vi.mock("./commands.js", () => ({
  getAvailableCommands: async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    return [];
  },
}));

async function flushTimers() {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe("acp session ordering with delayed command discovery", () => {
  it("newSession does not send session_info_update while command discovery yields", async () => {
    const sessionStore = createInMemorySessionStore();
    const connection = createAcpConnection();
    const sessionUpdate = connection["__sessionUpdateMock"];
    const agent = new AcpGatewayAgent(connection, createAcpGateway(), {
      sessionStore,
    });

    const result = await agent.newSession(createNewSessionRequest());

    // The RPC result is available before any notification is delivered, even
    // though command discovery yielded to the macrotask queue. Without the
    // pre-fetch fix, the snapshot timer would fire during the yield.
    expect(result.sessionId).toEqual(expect.any(String));
    expect(sessionUpdate).not.toHaveBeenCalled();

    await flushTimers();
    expectSessionUpdate(sessionUpdate, result.sessionId, "session_info_update");
  });
});

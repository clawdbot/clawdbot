// Live Gateway RPC coverage for trusted continuation handoff consumption.
import { describe, expect, test } from "vitest";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { waitForAgentCommandCall } from "./agent-command.test-helpers.js";
import { installConnectedSessionStoreGatewaySuite } from "./test-helpers.connected-session-store.js";
import { installGatewayTestHooks, rpcReq, testState, writeSessionStore } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const gatewaySuite = installConnectedSessionStoreGatewaySuite("openclaw-gw-continuation-trust-");

describe("Gateway continuation handoff trust", () => {
  test("consumes a persisted traceparent once without trusting raw continuation controls", async () => {
    const sessionKey = "agent:main:subagent:continuation-trust";
    const runId = "continuation-trust-live-run";
    const persistedTraceparent = `00-${"11".repeat(16)}-${"22".repeat(8)}-01`;
    const untrustedTraceparent = `00-${"33".repeat(16)}-${"44".repeat(8)}-01`;

    testState.sessionStorePath = gatewaySuite.sessionStorePath;
    await writeSessionStore({
      entries: {
        [sessionKey]: {
          sessionId: "continuation-trust-live-session",
          updatedAt: Date.now(),
          spawnedBy: "agent:main:main",
          continuationTraceparent: persistedTraceparent,
        },
      },
    });

    const response = await rpcReq(gatewaySuite.ws, "agent", {
      message: "continue from a persisted handoff",
      sessionKey,
      idempotencyKey: runId,
      continuationTrigger: "delegate-return",
      drainsContinuationDelegateQueue: true,
      traceparent: untrustedTraceparent,
    });

    expect(response.ok).toBe(true);
    const call = await waitForAgentCommandCall(runId);
    expect(call.traceparent).toBe(persistedTraceparent);
    expect(call.continuationTrigger).toBeUndefined();
    expect(call.drainsContinuationDelegateQueue).toBeUndefined();

    const persisted = loadSessionEntry({
      sessionKey,
      storePath: gatewaySuite.sessionStorePath,
    });
    expect(persisted?.continuationTraceparent).toBeUndefined();
  });
});

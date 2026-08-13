import { afterEach, expect, test } from "vitest";
import { getFallbackGatewayContext } from "./server-plugin-fallback-context.js";
import { startGatewayServerHarness, type GatewayServerHarness } from "./server.e2e-ws-harness.js";
import { loadSessionEntry } from "./session-utils.js";
import { installGatewayTestHooks, rpcReq } from "./test-helpers.js";
import { isDeviceWorkerAvailable } from "./worker-environments/device-provider.js";
import type { WorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

installGatewayTestHooks({ scope: "suite" });

let harness: GatewayServerHarness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

test(
  "profiles-disabled startup publishes core worker placement ownership to real session RPCs",
  { timeout: 30_000 },
  async () => {
    // The shared server harness defaults to its minimal mode, which deliberately skips all
    // worker stores. Exercise the production startup path while keeping plugin profiles unconfigured;
    // the core device provider still owns the worker service.
    process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = "0";
    harness = await startGatewayServerHarness();
    const context = getFallbackGatewayContext();
    expect(context?.workerEnvironmentService).toBeDefined();
    await expect(
      isDeviceWorkerAvailable(context?.workerEnvironmentService, "missing-device"),
    ).resolves.toBe(false);
    const placements = context?.workerSessionPlacementService as
      | WorkerSessionPlacementStore
      | undefined;
    expect(placements).toBeDefined();
    if (!placements) {
      throw new Error("startup placement store was not published");
    }

    const { ws } = await harness.openClient();
    const created = await rpcReq<{ key?: string; sessionId?: string }>(ws, "sessions.create", {
      agentId: "main",
      key: "startup-placement-local",
    });
    expect(created.ok).toBe(true);
    const sessionId = created.payload?.sessionId;
    const sessionKey = created.payload?.key;
    if (!sessionId || !sessionKey) {
      throw new Error("session creation did not return placement identity");
    }

    const claim = placements.claimTurn({
      sessionId,
      sessionKey,
      agentId: "main",
      owner: { kind: "local" },
      claimId: "startup-placement-local-claim",
      runId: "startup-placement-local-run",
    });
    placements.releaseTurn(claim);

    const deleted = await rpcReq(ws, "sessions.delete", { key: sessionKey });
    expect(deleted).toMatchObject({ ok: true, payload: { deleted: true } });
    expect(placements.get(sessionId)).toBeUndefined();

    const createdForReset = await rpcReq<{ key?: string }>(ws, "sessions.create", {
      agentId: "main",
      key: "startup-placement-local-reset",
    });
    expect(createdForReset.ok).toBe(true);
    const resetSessionKey = createdForReset.payload?.key;
    if (!resetSessionKey) {
      throw new Error("reset session creation did not return a session key");
    }
    const createdResetEntry = loadSessionEntry(resetSessionKey).entry;
    const resetSessionId = createdResetEntry?.sessionId;
    const previousLifecycleRevision = createdResetEntry?.lifecycleRevision;
    if (!resetSessionId) {
      throw new Error("reset session creation did not persist session identity");
    }
    const resetClaim = placements.claimTurn({
      sessionId: resetSessionId,
      sessionKey: resetSessionKey,
      agentId: "main",
      owner: { kind: "local" },
      claimId: "startup-placement-local-reset-claim",
      runId: "startup-placement-local-reset-run",
    });
    placements.releaseTurn(resetClaim);

    const reset = await rpcReq<{
      key?: string;
      entry?: { lifecycleRevision?: string; sessionId?: string };
    }>(ws, "sessions.reset", { key: resetSessionKey });
    expect(reset).toMatchObject({
      ok: true,
      payload: { key: resetSessionKey, entry: { sessionId: resetSessionId } },
    });
    const resetLifecycleRevision = reset.payload?.entry?.lifecycleRevision;
    expect(resetLifecycleRevision).toEqual(expect.any(String));
    expect(resetLifecycleRevision).not.toBe(previousLifecycleRevision);
    expect(loadSessionEntry(resetSessionKey).entry).toMatchObject({
      sessionId: resetSessionId,
      lifecycleRevision: resetLifecycleRevision,
    });
    expect(placements.get(resetSessionId)).toBeUndefined();
    expect(getFallbackGatewayContext()?.workerEnvironmentService).toBeDefined();
    ws.close();
  },
);

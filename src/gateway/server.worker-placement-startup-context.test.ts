import { afterEach, expect, test } from "vitest";
import { startGatewayServerHarness, type GatewayServerHarness } from "./server.e2e-ws-harness.js";
import { installGatewayTestHooks, rpcReq } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

let harness: GatewayServerHarness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

test(
  "profiles-disabled startup exposes core worker placement through real session RPCs",
  { timeout: 30_000 },
  async () => {
    // Minimal Gateway mode intentionally omits worker ownership; this exercises production startup
    // with no configured cloud profiles, where the core device provider still owns placement.
    process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = "0";
    harness = await startGatewayServerHarness();
    const { ws } = await harness.openClient();
    const created = await rpcReq<{ key?: string; sessionId?: string }>(ws, "sessions.create", {
      agentId: "main",
      key: "startup-placement-local",
    });
    expect(created).toMatchObject({ ok: true });
    const sessionKey = created.payload?.key;
    if (!sessionKey) {
      throw new Error("session creation did not return a key");
    }

    const dispatch = await rpcReq(ws, "sessions.dispatch", {
      key: sessionKey,
      deviceId: "missing-device",
    });
    expect(dispatch.ok).toBe(false);
    expect(dispatch.error?.message).toBe("device worker is not a paired node host: missing-device");

    const reset = await rpcReq(ws, "sessions.reset", { key: sessionKey });
    expect(reset).toMatchObject({ ok: true, payload: { key: sessionKey } });
    const deleted = await rpcReq(ws, "sessions.delete", { key: sessionKey });
    expect(deleted).toMatchObject({ ok: true, payload: { deleted: true } });
    ws.close();
  },
);

import { expect, test } from "vitest";
import { resolveAgentDir } from "../agents/agent-scope.js";
import {
  loadAuthProfileStoreForRuntime,
  loadAuthProfileStoreWithoutExternalProfiles,
  saveAuthProfileStore,
} from "../agents/auth-profiles.js";
import {
  reloadSharedAuthStoreOwnership,
  SHARED_AUTH_STORE_STATE_KEY,
} from "../agents/auth-profiles/path-resolve.js";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import { getRuntimeConfig } from "../config/io.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import type { ModelAuthStatusResult } from "./server-methods/models-auth-status.types.js";
import { startGatewayServerHarness } from "./server.e2e-ws-harness.js";
import { prepareGatewayReplyRuntimeForTest, rpcReq } from "./test-helpers.js";
import { setupGatewaySessionsHandlerTestHarness } from "./test/server-sessions.test-helpers.js";

const { createSelectedGlobalSessionStore } = setupGatewaySessionsHandlerTestHarness();

test.each(["main", "work"])(
  "models.authOrderSet keeps %s priority and Reset agent-owned",
  async (agentId) => {
    await createSelectedGlobalSessionStore();
    const cfg = getRuntimeConfig();
    const agentDir = resolveAgentDir(cfg, agentId);
    const siblingDir = resolveAgentDir(cfg, agentId === "main" ? "work" : "main");
    // Select the shared owner before startup captures process-stable auth snapshots.
    writeConfigMachineState(SHARED_AUTH_STORE_STATE_KEY, { location: "state-db" });
    reloadSharedAuthStoreOwnership(process.env);
    const provider = "fixture";
    const initialOrder = ["fixture:first"];
    const updatedOrder = ["fixture:second", "fixture:first"];
    saveAuthProfileStore({
      version: 1,
      profiles: {
        "fixture:first": { type: "api_key", provider, key: "fixture-first" },
        "fixture:second": { type: "api_key", provider, key: "fixture-second" },
      },
      order: { [provider]: initialOrder },
    });
    const harness = await startGatewayServerHarness();
    try {
      await prepareGatewayReplyRuntimeForTest();
      for (const scope of ["operator.read", "operator.write"]) {
        const { ws } = await harness.openClient({ scopes: [scope] });
        const denied = await rpcReq(ws, "models.authOrderSet", {
          provider,
          profileIds: updatedOrder,
          agentId,
        });
        expect(denied.error).toMatchObject({
          code: "FORBIDDEN",
          message: "missing scope: operator.admin",
        });
        expect(loadPersistedAuthProfileStore(agentDir)?.order?.[provider]).toBeUndefined();
      }

      const { ws } = await harness.openClient({ scopes: ["operator.admin", "operator.read"] });
      const readStatus = async () => {
        const status = await rpcReq<ModelAuthStatusResult>(ws, "models.authStatus", { agentId });
        expect(status.ok, JSON.stringify(status)).toBe(true);
        return status.payload?.providers.find((entry) => entry.provider === provider);
      };
      const inheritedStatus = await readStatus();
      expect(inheritedStatus).toMatchObject({ profileOrder: initialOrder });
      expect(inheritedStatus?.profileOrderStored).not.toBe(true);
      const allowed = await rpcReq(ws, "models.authOrderSet", {
        provider,
        profileIds: updatedOrder,
        agentId,
      });
      expect(allowed.ok, JSON.stringify(allowed)).toBe(true);
      // The first status after acknowledgement must already reflect the committed owner.
      expect(await readStatus()).toMatchObject({
        profileOrder: updatedOrder,
        profileOrderStored: true,
      });
      expect(loadPersistedAuthProfileStore(agentDir)?.order?.[provider]).toEqual(updatedOrder);
      expect(loadAuthProfileStoreWithoutExternalProfiles().order?.[provider]).toEqual(initialOrder);
      expect(loadAuthProfileStoreForRuntime(siblingDir).order?.[provider]).toEqual(initialOrder);
      const reset = await rpcReq(ws, "models.authOrderSet", { provider, agentId });
      expect(reset.ok, JSON.stringify(reset)).toBe(true);
      const afterReset = await readStatus();
      expect(afterReset?.profileOrder).toEqual(initialOrder);
      expect(afterReset?.profileOrderStored).not.toBe(true);
      expect(loadPersistedAuthProfileStore(agentDir)?.order?.[provider]).toBeUndefined();
      expect(loadAuthProfileStoreWithoutExternalProfiles().order?.[provider]).toEqual(initialOrder);
      expect(loadAuthProfileStoreForRuntime(siblingDir).order?.[provider]).toEqual(initialOrder);
    } finally {
      await harness.close();
    }
  },
);

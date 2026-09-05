import fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadDeviceIdentityIfPresent,
  loadOrCreateDeviceIdentity,
} from "../infra/device-identity.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { configureNodeHost } from "./config.js";
import { resolveLocalNodeId } from "./local-id.js";

const states: OpenClawTestState[] = [];

async function createState(label: string) {
  const state = await createOpenClawTestState({ label, layout: "state-only", applyEnv: false });
  states.push(state);
  return state;
}

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  while (states.length > 0) {
    await states.pop()?.cleanup();
  }
});

describe("resolveLocalNodeId", () => {
  it("uses the primary device identity, not the default runner UUID or instance override", async () => {
    const state = await createState("local-node-id");
    const config = await configureNodeHost({
      fallbackDisplayName: "Gateway node",
      gateway: {},
      env: state.env,
    });
    const identity = loadOrCreateDeviceIdentity({ env: state.env });
    expect(config.nodeId).not.toBe(identity.deviceId);
    await expect(resolveLocalNodeId(state.env)).resolves.toBe(identity.deviceId);

    await configureNodeHost({
      nodeId: "replacement-instance",
      fallbackDisplayName: "Gateway node",
      gateway: {},
      env: state.env,
    });
    await expect(resolveLocalNodeId(state.env)).resolves.toBe(identity.deviceId);

    // Once discovered, the same-install identity stays stable until process restart.
    closeOpenClawStateDatabaseForTest();
    await fs.rm(state.statePath("state"), { recursive: true });
    expect(loadDeviceIdentityIfPresent({ env: state.env })).toBeNull();
    await expect(resolveLocalNodeId(state.env)).resolves.toBe(identity.deviceId);
  });

  it("does not create credentials on a miss and discovers an identity created later", async () => {
    const state = await createState("local-node-id-missing");
    await expect(resolveLocalNodeId(state.env)).resolves.toBeNull();
    expect(await fs.readdir(state.stateDir)).toEqual([]);

    await configureNodeHost({ fallbackDisplayName: "Gateway node", gateway: {}, env: state.env });
    await expect(resolveLocalNodeId(state.env)).resolves.toBeNull();
    expect(loadDeviceIdentityIfPresent({ env: state.env })).toBeNull();

    const identity = loadOrCreateDeviceIdentity({ env: state.env });
    await expect(resolveLocalNodeId(state.env)).resolves.toBe(identity.deviceId);
  });

  it("keeps independently created state-directory identities separate", async () => {
    const gateway = await createState("local-node-id-gateway");
    const independent = await createState("local-node-id-independent");
    const gatewayIdentity = loadOrCreateDeviceIdentity({ env: gateway.env });
    const independentIdentity = loadOrCreateDeviceIdentity({ env: independent.env });
    expect(independentIdentity.deviceId).not.toBe(gatewayIdentity.deviceId);

    await expect(resolveLocalNodeId(gateway.env)).resolves.toBe(gatewayIdentity.deviceId);
    await expect(resolveLocalNodeId(independent.env)).resolves.toBe(independentIdentity.deviceId);
    await expect(resolveLocalNodeId(gateway.env)).resolves.toBe(gatewayIdentity.deviceId);
  });

  it("retries after a failed canonical identity read", async () => {
    const state = await createState("local-node-id-retry");
    const legacyPath = await state.writeText("identity/device.json", "{}\n");
    await expect(resolveLocalNodeId(state.env)).rejects.toThrow("openclaw doctor --fix");

    await fs.rm(legacyPath);
    const identity = loadOrCreateDeviceIdentity({ env: state.env });
    await expect(resolveLocalNodeId(state.env)).resolves.toBe(identity.deviceId);
  });
});

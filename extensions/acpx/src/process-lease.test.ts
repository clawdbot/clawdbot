// ACPX tests cover process lease plugin behavior.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAcpxProcessLeaseStore,
  openAcpxProcessLeaseStateStore,
  OPENCLAW_ACPX_LEASE_ID_ARG,
  OPENCLAW_ACPX_LEASE_ID_ENV,
  OPENCLAW_GATEWAY_INSTANCE_ID_ARG,
  withAcpxLeaseEnvironment,
  type AcpxProcessLease,
} from "./process-lease.js";

const OPENCLAW_GATEWAY_INSTANCE_ID_ENV = "OPENCLAW_GATEWAY_INSTANCE_ID";

function makeLease(index: number): AcpxProcessLease {
  return {
    leaseId: `lease-${index}`,
    gatewayInstanceId: "gateway-test",
    sessionKey: `agent:codex:acp:${index}`,
    wrapperRoot: "/tmp/openclaw/acpx",
    wrapperPath: "/tmp/openclaw/acpx/codex-acp-wrapper.mjs",
    rootPid: 1000 + index,
    commandHash: `hash-${index}`,
    startedAt: index,
    state: "open",
  };
}

describe("createAcpxProcessLeaseStore", () => {
  let stateDir = "";
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    resetPluginStateStoreForTests();
    stateDir = await mkdtemp(path.join(tmpdir(), "openclaw-acpx-leases-"));
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  function createStore() {
    return createAcpxProcessLeaseStore({
      store: openAcpxProcessLeaseStateStore((options) =>
        createPluginStateKeyedStoreForTests("acpx", { ...options, env }),
      ),
    });
  }

  it("serializes concurrent lease saves without dropping records", async () => {
    const store = createStore();
    await Promise.all(Array.from({ length: 25 }, (_, index) => store.save(makeLease(index))));

    const leases = await store.listOpen("gateway-test");
    expect(leases.map((lease) => lease.leaseId).toSorted()).toEqual(
      Array.from({ length: 25 }, (_, index) => `lease-${index}`).toSorted(),
    );
  });

  it("removes terminal leases from the live lease namespace", async () => {
    const store = createStore();
    const openLease = makeLease(1);
    const closedLease = makeLease(2);
    await store.save(openLease);
    await store.save(closedLease);

    await store.markState(closedLease.leaseId, "closed");

    await expect(store.load(closedLease.leaseId)).resolves.toBeUndefined();
    await expect(store.listOpen("gateway-test")).resolves.toEqual([openLease]);
  });
});

describe("withAcpxLeaseEnvironment", () => {
  it("adds lease environment and wrapper args on POSIX", () => {
    const command = withAcpxLeaseEnvironment({
      command: "node /tmp/openclaw/acpx/codex-acp-wrapper.mjs",
      leaseId: "lease-test",
      gatewayInstanceId: "gateway-test",
      platform: "darwin",
    });

    expect(command).toBe(
      [
        "env",
        `${OPENCLAW_ACPX_LEASE_ID_ENV}=lease-test`,
        `${OPENCLAW_GATEWAY_INSTANCE_ID_ENV}=gateway-test`,
        "node /tmp/openclaw/acpx/codex-acp-wrapper.mjs",
        OPENCLAW_ACPX_LEASE_ID_ARG,
        "lease-test",
        OPENCLAW_GATEWAY_INSTANCE_ID_ARG,
        "gateway-test",
      ].join(" "),
    );
  });

  it("keeps Windows logs keyed by lease id with wrapper args", () => {
    const command = withAcpxLeaseEnvironment({
      command: "node C:/openclaw/acpx/codex-acp-wrapper.mjs",
      leaseId: "lease-test",
      gatewayInstanceId: "gateway-test",
      platform: "win32",
    });

    expect(command).toBe(
      [
        "node C:/openclaw/acpx/codex-acp-wrapper.mjs",
        OPENCLAW_ACPX_LEASE_ID_ARG,
        "lease-test",
        OPENCLAW_GATEWAY_INSTANCE_ID_ARG,
        "gateway-test",
      ].join(" "),
    );
    expect(command).not.toContain(`${OPENCLAW_ACPX_LEASE_ID_ENV}=`);
    expect(command).not.toContain(`${OPENCLAW_GATEWAY_INSTANCE_ID_ENV}=`);
  });
});

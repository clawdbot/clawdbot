// SSH-verified node pairing e2e: real gateway server on the LAN self-connect
// harness, with the SSH probe runtime mocked at the module boundary.
import { beforeEach, expect, test, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { writeConfigFile } from "../config/config.js";
import { getRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { GatewayNodePairingConfig } from "../config/types.gateway.js";
import * as pairingApprovals from "../infra/device-pairing-approval.js";
import { withDevicePairingLock } from "../infra/device-pairing-state.js";
import {
  getPairedDevice,
  listDevicePairing,
  requestDevicePairing,
} from "../infra/device-pairing.js";
import type {
  NodeIdentityProbeParams,
  NodeIdentityProbeResult,
} from "./node-pairing-ssh-verify.runtime.js";
import { installGatewayTestHooks } from "./test-helpers.js";
import { describeWithLanNodePairingServer } from "./test-helpers.lan-pairing.js";

const probeMock = vi.hoisted(() =>
  vi.fn<(params: NodeIdentityProbeParams) => Promise<NodeIdentityProbeResult>>(),
);

vi.mock("./node-pairing-ssh-verify.runtime.js", () => ({
  runNodeIdentityProbe: (params: NodeIdentityProbeParams) => probeMock(params),
}));

vi.mock("../skills/runtime/remote.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../skills/runtime/remote.js")>()),
  // Pairing coverage does not need the unrelated 5s connect-time bin refresh.
  refreshRemoteNodeBins: vi.fn(async () => {}),
}));

installGatewayTestHooks({ scope: "suite" });

async function waitFor<T>(
  fn: () => Promise<T | null | undefined>,
  what: string,
  timeoutMs = 8_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value !== null && value !== undefined) {
      return value;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error(`timed out waiting for ${what}`);
}

type PairingRequiredDetails = {
  code?: string;
  recommendedNextStep?: string;
  pauseReconnect?: boolean;
};

describeWithLanNodePairingServer("gateway ssh-verified node pairing auto-approve", (attempt) => {
  beforeEach(() => {
    // Each case uses a distinct identityName, matching the host+device cooldown key.
    probeMock.mockReset();
  });

  test.each([
    { name: "disabled during probe", lockApproval: false, next: false },
    { name: "disabled while approval waits for lock", lockApproval: true, next: false },
    { name: "SSH user changed", lockApproval: false, next: { user: "replacement-user" } },
    { name: "SSH identity changed", lockApproval: false, next: { identity: "/keys/replacement" } },
    { name: "SSH scope narrowed", lockApproval: false, next: { cidrs: ["203.0.113.0/24"] } },
    { name: "SSH timeout changed", lockApproval: false, next: { timeoutMs: 300 } },
  ] satisfies {
    name: string;
    lockApproval: boolean;
    next: GatewayNodePairingConfig["sshVerify"];
  }[])("keeps pairing pending when $name", async ({ name, lockApproval, next }) => {
    await attempt({
      identityName: `ssh-policy-${name.replaceAll(" ", "-")}`,
      configure: async () => {
        await writeConfigFile({ gateway: { nodes: { pairing: { sshVerify: true } } } });
      },
      run: async ({ loaded, connectNode }) => {
        const probe = createDeferred<NodeIdentityProbeResult>();
        const lock = createDeferred();
        const locked = createDeferred();
        let lockWork: Promise<void> | undefined;
        const approval = vi.spyOn(pairingApprovals, "approveDevicePairing");
        probeMock.mockImplementation(() => probe.promise);
        try {
          const first = await connectNode();
          expect(first.ok).toBe(false);
          expect(probeMock).toHaveBeenCalledOnce();
          if (lockApproval) {
            lockWork = withDevicePairingLock(async () => {
              locked.resolve();
              await lock.promise;
            });
            await locked.promise;
            probe.resolve({
              status: "ok",
              stdout: JSON.stringify({
                deviceId: loaded.identity.deviceId,
                publicKey: loaded.publicKey,
              }),
            });
            await vi.waitFor(() => expect(approval).toHaveBeenCalledOnce());
          }
          const current = getRuntimeConfigSnapshot();
          expect(current).not.toBeNull();
          setRuntimeConfigSnapshot({
            ...current,
            gateway: {
              ...current?.gateway,
              nodes: { ...current?.gateway?.nodes, pairing: { sshVerify: next } },
            },
          });
          probe.resolve({
            status: "ok",
            stdout: JSON.stringify({
              deviceId: loaded.identity.deviceId,
              publicKey: loaded.publicKey,
            }),
          });
          lock.resolve();
          await lockWork;
          await vi.waitFor(() => expect(approval).toHaveBeenCalledOnce());
          await approval.mock.results[0]?.value;
          expect((await getPairedDevice(loaded.identity.deviceId)) === null).toBe(true);
          expect((await listDevicePairing()).pending).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ deviceId: loaded.identity.deviceId }),
            ]),
          );
        } finally {
          lock.resolve();
          probe.resolve({ status: "timeout" });
          await lockWork;
          approval.mockRestore();
        }
      },
    });
  });

  test("approves device pairing and the first capability surface on a key match", async () => {
    await attempt({
      identityName: "ssh-verify-key-match",
      run: async ({ lanIp, loaded, connectNode }) => {
        probeMock.mockImplementation(async () => ({
          status: "ok",
          stdout: `motd noise\n{"deviceId":"${loaded.identity.deviceId}","publicKey":"${loaded.publicKey}"}\n`,
        }));

        const first = await connectNode();
        expect(first.ok).toBe(false);
        const details = first.error?.details as PairingRequiredDetails | undefined;
        // The node must keep retrying while the detached probe can still land.
        expect(details?.recommendedNextStep).toBe("wait_then_retry");
        expect(details?.pauseReconnect).toBe(false);

        const paired = await waitFor(async () => {
          const record = await getPairedDevice(loaded.identity.deviceId);
          // Wait for the ssh-verified provenance specifically: the approval
          // and its read-back must survive the SQLite round-trip.
          return record?.approvedVia === "ssh-verified" ? record : null;
        }, "ssh-verified device approval");
        expect(paired.approvedVia).toBe("ssh-verified");
        expect(paired.publicKey).toBe(loaded.publicKey);
        expect(probeMock).toHaveBeenCalledWith(expect.objectContaining({ host: lanIp }));

        const second = await connectNode();
        expect(second.ok).toBe(true);
        expect((second.payload as { type?: unknown } | undefined)?.type).toBe("hello-ok");

        // The first capability surface rides on the same machine-ownership
        // proof: approved without a node.pair prompt.
        const record = await getPairedDevice(loaded.identity.deviceId);
        expect(record?.nodeSurface).toBeDefined();
        expect(record?.pendingNodeSurface).toBeUndefined();
      },
    });
  });

  test("does not ssh-approve a pending request that carries scopes from an earlier attempt", async () => {
    await attempt({
      identityName: "ssh-verify-scoped-refresh",
      run: async ({ loaded, connectNode }) => {
        // Seed a scoped pending request (as an earlier interactive attempt
        // would). The scopeless reconnect below refreshes this same request in
        // place, so approving it would smuggle the scope past the fresh
        // scopeless boundary. A matching probe would approve if reached.
        await requestDevicePairing({
          deviceId: loaded.identity.deviceId,
          publicKey: loaded.publicKey,
          role: "node",
          roles: ["node"],
          scopes: ["node.exec"],
        });
        probeMock.mockImplementation(async () => ({
          status: "ok",
          stdout: `{"deviceId":"${loaded.identity.deviceId}","publicKey":"${loaded.publicKey}"}\n`,
        }));

        const res = await connectNode();
        expect(res.ok).toBe(false);

        // The scoped pending request disqualifies ssh-verify entirely: no probe
        // runs and the device is never auto-approved.
        await new Promise((resolve) => {
          setTimeout(resolve, 250);
        });
        expect(probeMock).not.toHaveBeenCalled();
        expect(await getPairedDevice(loaded.identity.deviceId)).toBeNull();
      },
    });
  });

  test("leaves the pairing pending when the remote identity does not match", async () => {
    await attempt({
      identityName: "ssh-verify-key-mismatch",
      run: async ({ loaded, connectNode }) => {
        // A different key than the pending request: assembled from words so the
        // fixture is not a high-entropy blob (keeps review bundlers happy).
        const wrongKey = ["not", "the", "expected", "device", "key"].join("-");
        probeMock.mockImplementation(async () => ({
          status: "ok",
          stdout: `{"deviceId":"${loaded.identity.deviceId}","publicKey":"${wrongKey}"}\n`,
        }));

        const res = await connectNode();
        expect(res.ok).toBe(false);

        await waitFor(
          async () => (probeMock.mock.calls.length > 0 ? true : undefined),
          "probe execution",
        );
        // Give the detached approval path time to (incorrectly) land before
        // asserting it did not.
        await new Promise((resolve) => {
          setTimeout(resolve, 250);
        });
        expect(await getPairedDevice(loaded.identity.deviceId)).toBeNull();
        const pending = (await listDevicePairing()).pending.filter(
          (entry) => entry.deviceId === loaded.identity.deviceId,
        );
        expect(pending).toHaveLength(1);
      },
    });
  });

  test("sshVerify: false disables the probe and keeps default reconnect pause behavior", async () => {
    await attempt({
      identityName: "ssh-verify-disabled",
      configure: async () => {
        await writeConfigFile({
          gateway: { nodes: { pairing: { sshVerify: false } } },
        });
      },
      run: async ({ loaded, connectNode }) => {
        const res = await connectNode();
        expect(res.ok).toBe(false);
        const details = res.error?.details as PairingRequiredDetails | undefined;
        expect(details?.recommendedNextStep).toBeUndefined();
        expect(details?.pauseReconnect).toBeUndefined();
        expect(probeMock).not.toHaveBeenCalled();
        expect(await getPairedDevice(loaded.identity.deviceId)).toBeNull();
      },
    });
  });
});

// SSH-verified node pairing e2e: real gateway server on the LAN self-connect
// harness, with the SSH probe runtime mocked at the module boundary.
import { beforeEach, describe, expect, test, vi } from "vitest";
import { writeConfigFile } from "../config/config.js";
import {
  getPairedDevice,
  listDevicePairing,
  requestDevicePairing,
} from "../infra/device-pairing.js";
import { resetNodePairingSshVerifyStateForTests } from "./node-pairing-ssh-verify.js";
import type {
  NodeIdentityProbeParams,
  NodeIdentityProbeResult,
} from "./node-pairing-ssh-verify.runtime.js";
import { installGatewayTestHooks } from "./test-helpers.js";
import { withLanNodePairingAttempt } from "./test-helpers.lan-pairing.js";

const probeMock = vi.hoisted(() =>
  vi.fn<(params: NodeIdentityProbeParams) => Promise<NodeIdentityProbeResult>>(),
);

vi.mock("./node-pairing-ssh-verify.runtime.js", () => ({
  runNodeIdentityProbe: (params: NodeIdentityProbeParams) => probeMock(params),
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
      setTimeout(resolve, 50);
    });
  }
  throw new Error(`timed out waiting for ${what}`);
}

type PairingRequiredDetails = {
  code?: string;
  recommendedNextStep?: string;
  pauseReconnect?: boolean;
};

describe("gateway ssh-verified node pairing auto-approve", () => {
  beforeEach(() => {
    probeMock.mockReset();
    resetNodePairingSshVerifyStateForTests();
  });

  test("approves device pairing and the first capability surface on a key match", async () => {
    await withLanNodePairingAttempt({
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
    await withLanNodePairingAttempt({
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
    await withLanNodePairingAttempt({
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
    await withLanNodePairingAttempt({
      identityName: "ssh-verify-disabled",
      beforeStart: async () => {
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

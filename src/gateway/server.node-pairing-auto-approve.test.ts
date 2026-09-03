// Node pairing auto-approve tests cover LAN self-connect detection, token auth,
// node identity persistence, and auto-approved pairing state.
import { expect, test, vi } from "vitest";
import { writeConfigFile } from "../config/config.js";
import { getRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import * as pairingApprovals from "../infra/device-pairing-approval.js";
import { getPairedDevice, listDevicePairing } from "../infra/device-pairing.js";
import { installGatewayTestHooks } from "./test-helpers.js";
import { describeWithLanNodePairingServer } from "./test-helpers.lan-pairing.js";

installGatewayTestHooks({ scope: "suite" });

describeWithLanNodePairingServer("gateway trusted CIDR node pairing auto-approve", (attempt) => {
  test("keeps a pending request when its CIDR permission is removed before approval", async () => {
    await attempt({
      identityName: "trusted-cidr-revoked-before-approval",
      configure: async (lanIp) => {
        await writeConfigFile({
          gateway: { nodes: { pairing: { autoApproveCidrs: [`${lanIp}/32`], sshVerify: false } } },
        });
      },
      run: async ({ loaded, connectNode }) => {
        const approve = pairingApprovals.approveDevicePairing;
        const approval = vi
          .spyOn(pairingApprovals, "approveDevicePairing")
          .mockImplementation((requestId, options, baseDir) => {
            const current = getRuntimeConfigSnapshot();
            if (!current) {
              throw new Error("expected active Gateway config");
            }
            setRuntimeConfigSnapshot({
              ...current,
              gateway: {
                ...current.gateway,
                nodes: { ...current.gateway?.nodes, pairing: { sshVerify: false } },
              },
            });
            return approve(requestId, options, baseDir);
          });
        try {
          const response = await connectNode();
          expect(approval).toHaveBeenCalledOnce();
          expect(response.ok).toBe(false);
          expect(response.error?.code).toBe("NOT_PAIRED");
          expect((await getPairedDevice(loaded.identity.deviceId)) === null).toBe(true);
          expect((await listDevicePairing()).pending.map((entry) => entry.deviceId)).toContain(
            loaded.identity.deviceId,
          );
        } finally {
          approval.mockRestore();
        }
      },
    });
  });

  test("stays disabled by default for a direct non-loopback node", async () => {
    await attempt({
      identityName: "trusted-cidr-default-off",
      configure: async () => {
        // Pin SSH verification off so this case exercises the CIDR default
        // without spawning a real ssh probe to the runner's own LAN IP.
        await writeConfigFile({
          gateway: { nodes: { pairing: { sshVerify: false } } },
        });
      },
      run: async ({ loaded, connectNode }) => {
        const res = await connectNode();
        expect(res.ok).toBe(false);
        expect(res.error?.message ?? "").toContain("pairing required");
        const pending = (await listDevicePairing()).pending.filter(
          (entry) => entry.deviceId === loaded.identity.deviceId,
        );
        expect(pending).toHaveLength(1);
        expect(pending[0]?.silent).toBe(false);
        expect(await getPairedDevice(loaded.identity.deviceId)).toBeNull();
      },
    });
  });

  test("auto-approves first-time node pairing from a matching direct non-loopback CIDR", async () => {
    await attempt({
      identityName: "trusted-cidr-direct-lan-auto-approve",
      configure: async (lanIp) => {
        await writeConfigFile({
          gateway: {
            nodes: {
              pairing: {
                autoApproveCidrs: [`${lanIp}/32`],
              },
            },
          },
        });
      },
      run: async ({ loaded, connectNode }) => {
        const res = await connectNode();
        expect(res.ok).toBe(true);
        expect((res.payload as { type?: unknown } | undefined)?.type).toBe("hello-ok");
        const pending = (await listDevicePairing()).pending.filter(
          (entry) => entry.deviceId === loaded.identity.deviceId,
        );
        expect(pending).toHaveLength(0);
        const paired = await getPairedDevice(loaded.identity.deviceId);
        expect(paired?.role).toBe("node");
        expect(paired?.approvedScopes ?? []).toStrictEqual([]);
        expect(paired?.approvedVia).toBe("trusted-cidr");
        // Network origin approves the device only: the capability surface must
        // stay on the manual operator prompt (#128446 documents the flow).
        expect(paired?.nodeSurface).toBeUndefined();
        expect(paired?.pendingNodeSurface).toBeDefined();
      },
    });
  });
});

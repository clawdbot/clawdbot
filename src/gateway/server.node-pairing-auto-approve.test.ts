// Node pairing auto-approve tests cover LAN self-connect detection, token auth,
// node identity persistence, and auto-approved pairing state.
import { describe, expect, test } from "vitest";
import { writeConfigFile } from "../config/config.js";
import { getPairedDevice, listDevicePairing } from "../infra/device-pairing.js";
import { installGatewayTestHooks } from "./test-helpers.js";
import { withLanNodePairingAttempt } from "./test-helpers.lan-pairing.js";

installGatewayTestHooks({ scope: "suite" });

describe("gateway trusted CIDR node pairing auto-approve", () => {
  test("stays disabled by default for a direct non-loopback node", async () => {
    await withLanNodePairingAttempt({
      identityName: "trusted-cidr-default-off",
      beforeStart: async () => {
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
    await withLanNodePairingAttempt({
      identityName: "trusted-cidr-direct-lan-auto-approve",
      beforeStart: async (lanIp) => {
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
      },
    });
  });
});

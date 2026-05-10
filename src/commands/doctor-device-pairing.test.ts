import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { storeDeviceAuthToken } from "../infra/device-auth-store.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
} from "../infra/device-identity.js";
import {
  approveDevicePairing,
  requestDevicePairing,
  revokeDeviceToken,
  rotateDeviceToken,
} from "../infra/device-pairing.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withTempDir } from "../test-utils/temp-dir.js";

const callGatewayMock = vi.hoisted(() => vi.fn());
const noteMock = vi.hoisted(() => vi.fn());

vi.mock("../gateway/call.js", () => ({
  callGateway: (...args: unknown[]) => callGatewayMock(...args),
}));

vi.mock("../terminal/note.js", () => ({
  note: (...args: unknown[]) => noteMock(...args),
}));

describe("noteDevicePairingHealth", () => {
  let noteDevicePairingHealth: typeof import("./doctor-device-pairing.js").noteDevicePairingHealth;

  async function withApprovedOperatorPairing(
    run: (context: {
      stateDir: string;
      identity: ReturnType<typeof loadOrCreateDeviceIdentity>;
      publicKey: string;
      initial: Awaited<ReturnType<typeof requestDevicePairing>>;
    }) => Promise<void>,
  ): Promise<void> {
    await withTempDir("openclaw-doctor-device-pairing-", async (stateDir) => {
      await withEnvAsync(
        {
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_TEST_FAST: "1",
        },
        async () => {
          const identity = loadOrCreateDeviceIdentity();
          const publicKey = publicKeyRawBase64UrlFromPem(identity.publicKeyPem);
          const initial = await requestDevicePairing({
            deviceId: identity.deviceId,
            publicKey,
            role: "operator",
            scopes: ["operator.read"],
            clientId: "control-ui",
            clientMode: "webchat",
            displayName: "Dashboard",
          });
          await approveDevicePairing(initial.request.requestId, {
            callerScopes: ["operator.read"],
          });

          await run({ stateDir, identity, publicKey, initial });
        },
      );
    });
  }

  beforeEach(async () => {
    vi.resetModules();
    callGatewayMock.mockReset();
    noteMock.mockReset();
    ({ noteDevicePairingHealth } = await import("./doctor-device-pairing.js"));
  });

  afterEach(() => {
    callGatewayMock.mockReset();
    noteMock.mockReset();
  });

  it("warns about pending scope upgrades from local pairing state when the gateway is down", async () => {
    await withApprovedOperatorPairing(async ({ identity, publicKey }) => {
      await requestDevicePairing({
        deviceId: identity.deviceId,
        publicKey,
        role: "operator",
        scopes: ["operator.admin"],
        clientId: "control-ui",
        clientMode: "webchat",
        displayName: "Dashboard",
      });

      await noteDevicePairingHealth({
        cfg: { gateway: { mode: "local" } },
        healthOk: false,
      });

      expect(noteMock).toHaveBeenCalledTimes(1);
      const message = String(noteMock.mock.calls[0]?.[0] ?? "");
      expect(noteMock.mock.calls[0]?.[1]).toBe("Device pairing");
      expect(message).toContain("Pending scope upgrade");
      expect(message).toContain("operator.admin");
      expect(message).toContain("openclaw devices approve");
      expect(callGatewayMock).not.toHaveBeenCalled();
    });
  });

  it("warns when local pairing state is corrupt instead of treating it as empty", async () => {
    await withTempDir("openclaw-doctor-device-pairing-", async (stateDir) => {
      await withEnvAsync(
        {
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_TEST_FAST: "1",
        },
        async () => {
          const pairedPath = path.join(stateDir, "devices", "paired.json");
          await fs.mkdir(path.dirname(pairedPath), { recursive: true });
          await fs.writeFile(pairedPath, "{not-json}", "utf8");

          await noteDevicePairingHealth({
            cfg: { gateway: { mode: "local" } },
            healthOk: false,
          });

          expect(noteMock).toHaveBeenCalledTimes(1);
          const message = String(noteMock.mock.calls[0]?.[0] ?? "");
          expect(noteMock.mock.calls[0]?.[1]).toBe("Device pairing");
          expect(message).toContain("paired.json");
          expect(message).toContain("refused to treat it as empty");
          expect(await fs.readFile(pairedPath, "utf8")).toBe("{not-json}");
        },
      );
    });
  });

  it("warns when the local cached device token predates the gateway rotation", async () => {
    await withApprovedOperatorPairing(async ({ stateDir, identity }) => {
      storeDeviceAuthToken({
        deviceId: identity.deviceId,
        role: "operator",
        token: "stale-local-token",
        scopes: ["operator.read"],
      });
      const deviceAuthPath = path.join(stateDir, "identity", "device-auth.json");
      const store = JSON.parse(await fs.readFile(deviceAuthPath, "utf8")) as {
        version: 1;
        deviceId: string;
        tokens: Record<
          string,
          { token: string; role: string; scopes: string[]; updatedAtMs: number }
        >;
      };
      store.tokens.operator.updatedAtMs = 1;
      await fs.writeFile(deviceAuthPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");

      const rotated = await rotateDeviceToken({
        deviceId: identity.deviceId,
        role: "operator",
      });
      expect(rotated.ok).toBe(true);

      await noteDevicePairingHealth({
        cfg: { gateway: { mode: "local" } },
        healthOk: false,
      });

      expect(noteMock).toHaveBeenCalledTimes(1);
      const message = String(noteMock.mock.calls[0]?.[0] ?? "");
      expect(message).toContain("stale device-token pattern");
      expect(message).toContain("openclaw devices rotate");
    });
  });

  it("does not suggest rotating local auth for a role that is no longer approved", async () => {
    await withApprovedOperatorPairing(async ({ identity }) => {
      storeDeviceAuthToken({
        deviceId: identity.deviceId,
        role: "node",
        token: "stale-node-token",
        scopes: [],
      });

      await noteDevicePairingHealth({
        cfg: { gateway: { mode: "local" } },
        healthOk: false,
      });

      expect(noteMock).toHaveBeenCalledTimes(1);
      const message = String(noteMock.mock.calls[0]?.[0] ?? "");
      expect(message).toContain("Local cached node device auth");
      expect(message).toContain("role is no longer approved");
      expect(message).toContain("remove the stale cached node auth entry");
      expect(message).not.toContain("--role node");
    });
  });

  it("uses gateway device pairing state when the gateway is healthy", async () => {
    callGatewayMock.mockResolvedValue({
      pending: [
        {
          requestId: "req-gateway-1",
          deviceId: "device-gateway-1",
          publicKey: "pubkey",
          role: "operator",
          roles: ["operator"],
          scopes: ["operator.admin"],
          clientId: "control-ui",
          clientMode: "webchat",
          displayName: "Dashboard",
          ts: 1,
          isRepair: false,
        },
      ],
      paired: [],
    });

    await noteDevicePairingHealth({
      cfg: { gateway: { mode: "remote" } },
      healthOk: true,
    });

    expect(callGatewayMock).toHaveBeenCalledOnce();
    const [gatewayRequest] = callGatewayMock.mock.calls[0] ?? [];
    expect(gatewayRequest?.method).toBe("device.pair.list");
    expect(noteMock).toHaveBeenCalledTimes(1);
    expect(String(noteMock.mock.calls[0]?.[0] ?? "")).toContain("req-gateway-1");
  });

  it("sanitizes device labels before printing doctor notes", async () => {
    callGatewayMock.mockResolvedValue({
      pending: [
        {
          requestId: "req-gateway-1",
          deviceId: "device-gateway-1",
          publicKey: "pubkey",
          role: "operator",
          roles: ["operator"],
          scopes: ["operator.admin"],
          clientId: "control-ui\tclient",
          clientMode: "webchat",
          displayName: "\u001b[2Kbad\nname",
          ts: 1,
          isRepair: false,
        },
      ],
      paired: [],
    });

    await noteDevicePairingHealth({
      cfg: { gateway: { mode: "remote" } },
      healthOk: true,
    });

    const message = String(noteMock.mock.calls[0]?.[0] ?? "");
    expect(message).toContain("bad\\nname");
    expect(message).not.toContain("\u001b");
    expect(message).not.toContain("control-ui\tclient");
  });

  it("quotes untrusted device pairing fields in suggested commands", async () => {
    callGatewayMock.mockResolvedValue({
      pending: [
        {
          requestId: "req-gateway-1",
          deviceId: "device; echo pwn",
          publicKey: "pending-pubkey",
          role: "operator",
          roles: ["operator"],
          scopes: ["operator.read"],
          clientId: "control-ui",
          clientMode: "webchat",
          displayName: "Dashboard",
          ts: 1,
          isRepair: true,
        },
      ],
      paired: [
        {
          deviceId: "device; echo pwn",
          publicKey: "paired-pubkey",
          displayName: "Dashboard",
          clientId: "control-ui",
          clientMode: "webchat",
          role: "operator; touch /tmp/pwn",
          roles: ["operator; touch /tmp/pwn"],
          scopes: [],
          approvedScopes: [],
          tokens: [],
          createdAtMs: 1,
          approvedAtMs: 1,
        },
      ],
    });

    await noteDevicePairingHealth({
      cfg: { gateway: { mode: "remote" } },
      healthOk: true,
    });

    const message = String(noteMock.mock.calls[0]?.[0] ?? "");
    expect(message).toContain("openclaw devices remove 'device; echo pwn'");
    expect(message).toContain(
      "openclaw devices rotate --device 'device; echo pwn' --role 'operator; touch /tmp/pwn'",
    );
  });

  it("does not duplicate missing-token warnings when local cache exists for an approved role", async () => {
    await withApprovedOperatorPairing(async ({ identity }) => {
      storeDeviceAuthToken({
        deviceId: identity.deviceId,
        role: "operator",
        token: "stale-local-token",
        scopes: ["operator.read"],
      });
      await revokeDeviceToken({
        deviceId: identity.deviceId,
        role: "operator",
      });

      await noteDevicePairingHealth({
        cfg: { gateway: { mode: "local" } },
        healthOk: false,
      });

      const message = String(noteMock.mock.calls[0]?.[0] ?? "");
      expect(message).toContain("has no active operator device token");
      expect(message).not.toContain("no longer has a matching active gateway token");
    });
  });
});

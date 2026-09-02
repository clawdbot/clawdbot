import fs from "node:fs/promises";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
// Doctor device pairing tests cover device-pairing checks, repair prompts, and diagnostics.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadDeviceAuthToken, storeDeviceAuthToken } from "../infra/device-auth-store.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
} from "../infra/device-identity.js";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import { revokeDeviceToken, rotateDeviceToken } from "../infra/device-pairing-tokens.js";
import { requestDevicePairing } from "../infra/device-pairing.js";
import {
  detectLegacyDeviceAuth,
  migrateLegacyDeviceAuth,
} from "../infra/state-migrations.device-auth.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withTempDir } from "../test-utils/temp-dir.js";

const callGatewayMock = vi.hoisted(() => vi.fn());
const noteMock = vi.hoisted(() => vi.fn());

vi.mock("../gateway/call.js", () => ({
  callGateway: (...args: unknown[]) => callGatewayMock(...args),
}));

vi.mock("../../packages/terminal-core/src/note.js", () => ({
  note: (...args: unknown[]) => noteMock(...args),
}));

function requireMockCall(
  mock: { mock: { calls: unknown[][] } },
  callIndex: number,
  label: string,
): unknown[] {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected ${label} call ${callIndex}`);
  }
  return call;
}

function requireNoteMessage(callIndex = 0): string {
  const [message] = requireMockCall(noteMock, callIndex, "doctor note");
  if (typeof message !== "string") {
    throw new Error(`expected doctor note message ${callIndex}`);
  }
  return message;
}

function requireNoteTitle(callIndex = 0): unknown {
  const [, title] = requireMockCall(noteMock, callIndex, "doctor note");
  return title;
}

const requireRecord = createRequireRecord("object", "expected-label-record-short");
const legacyDeviceAuthContents = JSON.stringify({
  version: 1,
  deviceId: "synthetic-device",
  tokens: {
    operator: {
      token: "synthetic-legacy-token",
      role: "operator",
      scopes: ["operator.read"],
      updatedAtMs: 10,
    },
  },
});

describe("noteDevicePairingHealth", () => {
  let collectDevicePairingHealthFindings: typeof import("./doctor-device-pairing.js").collectDevicePairingHealthFindings;
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

  beforeAll(async () => {
    vi.resetModules();
    ({ collectDevicePairingHealthFindings, noteDevicePairingHealth } =
      await import("./doctor-device-pairing.js"));
  });

  beforeEach(() => {
    callGatewayMock.mockReset();
    noteMock.mockReset();
  });

  afterEach(() => {
    __setFsSafeTestHooksForTest(undefined);
    callGatewayMock.mockReset();
    noteMock.mockReset();
  });

  it("does not create shared state while collecting local pairing findings", async () => {
    await withTempDir("openclaw-doctor-device-pairing-readonly-", async (stateDir) => {
      await withEnvAsync(
        {
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_TEST_FAST: "1",
        },
        async () => {
          await expect(
            collectDevicePairingHealthFindings({
              cfg: { gateway: { mode: "local" } },
              healthOk: false,
            }),
          ).resolves.toEqual([]);
          await expect(
            fs.stat(path.join(stateDir, "state", "openclaw.sqlite")),
          ).rejects.toMatchObject({ code: "ENOENT" });
        },
      );
    });
  });

  it("warns about pending scope upgrades from local pairing state when the gateway is down", async () => {
    await withApprovedOperatorPairing(async ({ identity, publicKey }) => {
      const pending = await requestDevicePairing({
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
      const message = requireNoteMessage();
      expect(requireNoteTitle()).toBe("Device pairing");
      expect(message).toContain("Pending scope upgrade");
      expect(message).toContain("operator.admin");
      expect(message).toContain("openclaw devices approve");
      expect(callGatewayMock).not.toHaveBeenCalled();

      const findings = await collectDevicePairingHealthFindings({
        cfg: { gateway: { mode: "local" } },
      });
      expect(findings).toEqual([
        expect.objectContaining({
          checkId: "core/doctor/device-pairing",
          severity: "warning",
          path: "devices.pending",
          target: identity.deviceId + ":" + pending.request.requestId,
          requirement: "scope-upgrade",
          message: expect.stringContaining("Pending scope upgrade"),
          fixHint: expect.stringContaining("openclaw devices approve"),
        }),
      ]);
      expect(callGatewayMock).not.toHaveBeenCalled();
    });
  });

  it.each([
    {
      file: "devices/paired.json",
      mode: "local",
      findingPath: "devices.legacy-store",
      requirement: "pairing-store-legacy-file",
      fixHint: "Restart the gateway",
    },
    ...(["local", "remote"] as const).map((mode) => ({
      file: "identity/device-auth.json",
      mode,
      findingPath: "identity.device-auth",
      requirement: "device-auth-store-legacy-file",
      fixHint: "openclaw doctor --fix",
    })),
  ] as const)(
    "warns about unimported $file in $mode mode without changing it",
    async (testCase) => {
      await withOpenClawTestState(
        { prefix: "openclaw-doctor-device-pairing-", env: { OPENCLAW_TEST_FAST: "1" } },
        async (state) => {
          const content =
            testCase.file === "devices/paired.json" ? "{not-json}" : legacyDeviceAuthContents;
          const sourcePath = await state.writeText(testCase.file, content);
          const params = { cfg: { gateway: { mode: testCase.mode } }, healthOk: false };

          const findings = await collectDevicePairingHealthFindings(params);
          expect.soft(findings).toEqual([
            expect.objectContaining({
              checkId: "core/doctor/device-pairing",
              severity: "warning",
              path: testCase.findingPath,
              requirement: testCase.requirement,
              message: expect.stringContaining(
                testCase.file === "devices/paired.json"
                  ? "has not been imported"
                  : "is still present",
              ),
              fixHint: expect.stringContaining(testCase.fixHint),
            }),
          ]);
          await noteDevicePairingHealth(params);
          expect.soft(noteMock).toHaveBeenCalledTimes(1);
          expect(noteMock).toHaveBeenCalledWith(
            expect.stringContaining(path.basename(sourcePath)),
            "Device pairing",
          );
          expect(requireNoteMessage()).not.toContain("synthetic-legacy-token");
          expect(await fs.readFile(sourcePath, "utf8")).toBe(content);
          await expect(fs.stat(state.statePath("state", "openclaw.sqlite"))).rejects.toMatchObject({
            code: "ENOENT",
          });
        },
      );
    },
  );

  it.each(["canonical rows coexist", "import committed before source removal failed"] as const)(
    "describes remaining device-auth files when %s",
    async (scenario) => {
      await withOpenClawTestState(
        { prefix: "openclaw-doctor-device-auth-debt-", env: { OPENCLAW_TEST_FAST: "1" } },
        async (state) => {
          const { db } = openOpenClawStateDatabase({ env: state.env });
          const expectedToken =
            scenario === "canonical rows coexist"
              ? "synthetic-canonical-token"
              : "synthetic-legacy-token";
          if (scenario === "canonical rows coexist") {
            db.prepare(
              "INSERT INTO device_auth_tokens (device_id, role, token, scopes_json, updated_at_ms) VALUES (?, ?, ?, ?, ?)",
            ).run("synthetic-device", "operator", expectedToken, "[]", 10);
          }
          const sourcePath = await state.writeText(
            "identity/device-auth.json",
            legacyDeviceAuthContents,
          );
          const readTokenRow = () =>
            db
              .prepare("SELECT token FROM device_auth_tokens WHERE device_id = ? AND role = ?")
              .get("synthetic-device", "operator");
          if (scenario !== "canonical rows coexist") {
            let rowAtRemoval: unknown;
            let removalAttempts = 0;
            __setFsSafeTestHooksForTest({
              beforeRootFallbackMutation(operation, targetPath) {
                if (operation === "remove" && targetPath === sourcePath) {
                  removalAttempts++;
                  rowAtRemoval = readTokenRow();
                  throw new Error("synthetic device-auth source removal failure");
                }
              },
            });
            try {
              const result = await migrateLegacyDeviceAuth({
                detected: detectLegacyDeviceAuth({
                  stateDir: state.stateDir,
                  doctorOnlyStateMigrations: true,
                }),
                stateDir: state.stateDir,
                env: state.env,
              });
              expect(removalAttempts).toBe(1);
              expect(rowAtRemoval).toEqual({ token: expectedToken });
              expect(result.warnings.length).toBeGreaterThan(0);
            } finally {
              __setFsSafeTestHooksForTest(undefined);
            }
          }
          expect(readTokenRow()).toEqual({ token: expectedToken });
          // Existing rows do not release the legacy-file access guard.
          expect(() =>
            loadDeviceAuthToken({ deviceId: "synthetic-device", role: "operator", env: state.env }),
          ).toThrow("Legacy device auth requires migration");
          const params = { cfg: { gateway: { mode: "remote" as const } }, healthOk: false };
          const findings = await collectDevicePairingHealthFindings(params);
          expect(findings).toEqual([
            expect.objectContaining({
              requirement: "device-auth-store-legacy-file",
              message: expect.stringContaining("is still present"),
              fixHint: expect.stringContaining("migration or cleanup"),
            }),
          ]);
          await noteDevicePairingHealth(params);
          expect(requireNoteMessage()).not.toContain("has not been imported");
          expect(requireNoteMessage()).not.toContain(expectedToken);
          expect(await fs.readFile(sourcePath, "utf8")).toBe(legacyDeviceAuthContents);
          expect(readTokenRow()).toEqual({ token: expectedToken });
        },
      );
    },
  );

  it("warns when the local cached device token predates the gateway rotation", async () => {
    await withApprovedOperatorPairing(async ({ identity }) => {
      const now = vi.spyOn(Date, "now").mockReturnValue(1);
      try {
        storeDeviceAuthToken({
          deviceId: identity.deviceId,
          role: "operator",
          token: "stale-local-token",
          scopes: ["operator.read"],
        });
      } finally {
        now.mockRestore();
      }

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
      const message = requireNoteMessage();
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
      const message = requireNoteMessage();
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
    const [rawGatewayRequest] = requireMockCall(callGatewayMock, 0, "gateway call");
    const gatewayRequest = requireRecord(rawGatewayRequest, "gateway request");
    expect(gatewayRequest?.method).toBe("device.pair.list");
    expect(noteMock).toHaveBeenCalledTimes(1);
    expect(requireNoteMessage()).toContain("req-gateway-1");
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

    const message = requireNoteMessage();
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

    const message = requireNoteMessage();
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

      const message = requireNoteMessage();
      expect(message).toContain("has no active operator device token");
      expect(message).not.toContain("no longer has a matching active gateway token");
    });
  });
});

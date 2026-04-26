import { readFile, writeFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PAIRING_SETUP_BOOTSTRAP_PROFILE } from "../shared/device-bootstrap-profile.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { issueDeviceBootstrapToken, verifyDeviceBootstrapToken } from "./device-bootstrap.js";
import {
  approveBootstrapDevicePairing,
  approveDevicePairing,
  clearDevicePairing,
  ensureDeviceToken,
  getPairedDevice,
  hasEffectivePairedDeviceRole,
  listEffectivePairedDeviceRoles,
  listDevicePairing,
  removePairedDevice,
  requestDevicePairing,
  revokeDeviceToken,
  rotateDeviceToken,
  updatePairedDeviceMetadata,
  verifyDeviceToken,
  type PairedDevice,
  type RotateDeviceTokenResult,
} from "./device-pairing.js";
import { resolvePairingPaths } from "./pairing-files.js";

async function setupPairedOperatorDevice(baseDir: string, scopes: string[]) {
  const request = await requestDevicePairing(
    {
      deviceId: "device-1",
      publicKey: "public-key-1",
      role: "operator",
      scopes,
    },
    baseDir,
  );
  await approveDevicePairing(request.request.requestId, { callerScopes: scopes }, baseDir);
}

async function setupPairedNodeDevice(baseDir: string) {
  const request = await requestDevicePairing(
    {
      deviceId: "node-1",
      publicKey: "public-key-node-1",
      role: "node",
      scopes: [],
    },
    baseDir,
  );
  await approveDevicePairing(request.request.requestId, { callerScopes: [] }, baseDir);
}

async function setupOperatorToken(scopes: string[]) {
  const baseDir = await makeDevicePairingDir();
  await setupPairedOperatorDevice(baseDir, scopes);
  const paired = await getPairedDevice("device-1", baseDir);
  const token = requireToken(paired?.tokens?.operator?.token);
  return { baseDir, token };
}

function verifyOperatorToken(params: { baseDir: string; token: string; scopes: string[] }) {
  return verifyDeviceToken({
    deviceId: "device-1",
    token: params.token,
    role: "operator",
    scopes: params.scopes,
    baseDir: params.baseDir,
  });
}

function requireToken(token: string | undefined): string {
  expect(typeof token).toBe("string");
  if (typeof token !== "string") {
    throw new Error("expected device token to be issued");
  }
  return token;
}

function requireRotatedEntry(result: RotateDeviceTokenResult) {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`expected rotated token entry, got ${result.reason}`);
  }
  return result.entry;
}

async function overwritePairedOperatorTokenScopes(baseDir: string, scopes: string[]) {
  const { pairedPath } = resolvePairingPaths(baseDir, "devices");
  const pairedByDeviceId = JSON.parse(await readFile(pairedPath, "utf8")) as Record<
    string,
    PairedDevice
  >;
  const device = pairedByDeviceId["device-1"];
  expect(device?.tokens?.operator).toBeDefined();
  if (!device?.tokens?.operator) {
    throw new Error("expected paired operator token");
  }
  device.tokens.operator.scopes = scopes;
  await writeFile(pairedPath, JSON.stringify(pairedByDeviceId, null, 2));
}

async function mutatePairedDevice(
  baseDir: string,
  deviceId: string,
  mutate: (device: PairedDevice) => void,
) {
  const { pairedPath } = resolvePairingPaths(baseDir, "devices");
  const pairedByDeviceId = JSON.parse(await readFile(pairedPath, "utf8")) as Record<
    string,
    PairedDevice
  >;
  const device = pairedByDeviceId[deviceId];
  expect(device).toBeDefined();
  if (!device) {
    throw new Error(`expected paired device ${deviceId}`);
  }
  mutate(device);
  await writeFile(pairedPath, JSON.stringify(pairedByDeviceId, null, 2));
}

async function clearPairedOperatorApprovalBaseline(baseDir: string) {
  await mutatePairedDevice(baseDir, "device-1", (device) => {
    delete device.approvedScopes;
    delete device.scopes;
  });
}

const suiteRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-device-pairing-" });

async function makeDevicePairingDir(): Promise<string> {
  return await suiteRootTracker.make("case");
}

describe("device pairing tokens", () => {
  beforeAll(async () => {
    await suiteRootTracker.setup();
  });

  afterAll(async () => {
    await suiteRootTracker.cleanup();
  });

  test("reuses existing pending requests for the same device", async () => {
    const baseDir = await makeDevicePairingDir();
    const first = await requestDevicePairing(
      {
        deviceId: "device-1",
        publicKey: "public-key-1",
      },
      baseDir,
    );
    const second = await requestDevicePairing(
      {
        deviceId: "device-1",
        publicKey: "public-key-1",
      },
      baseDir,
    );

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.request.requestId).toBe(first.request.requestId);
  });

  test("re-requesting with identical params preserves the original ts to prevent queue-jumping", async () => {
    // Regression: refreshPendingDevicePairingRequest must not bump ts to Date.now().
    // An attacker who reconnects with the same key/role/scopes could otherwise
    // silently move their request to the top of the implicit --latest approval queue.
    const baseDir = await makeDevicePairingDir();
    const first = await requestDevicePairing(
      {
        deviceId: "device-1",
        publicKey: "public-key-1",
        role: "operator",
        scopes: ["operator.read"],
      },
      baseDir,
    );
    const originalTs = first.request.ts;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await requestDevicePairing(
      {
        deviceId: "device-1",
        publicKey: "public-key-1",
        role: "operator",
        scopes: ["operator.read"],
      },
      baseDir,
    );

    expect(second.created).toBe(false);
    expect(second.request.requestId).toBe(first.request.requestId);
    expect(second.request.ts).toBe(originalTs);
  });

  test("supersedes pending requests when requested roles/scopes change", async () => {
    const baseDir = await makeDevicePairingDir();
    const first = await requestDevicePairing(
      {
        deviceId: "device-1",
        publicKey: "public-key-1",
        role: "node",
        scopes: [],
      },
      baseDir,
    );
    const second = await requestDevicePairing(
      {
        deviceId: "device-1",
        publicKey: "public-key-1",
        role: "operator",
        scopes: ["operator.read", "operator.write"],
      },
      baseDir,
    );

    expect(second.created).toBe(true);
    expect(second.request.requestId).not.toBe(first.request.requestId);
    expect(second.request.role).toBe("operator");
    expect(second.request.roles).toEqual(expect.arrayContaining(["node", "operator"]));
    expect(second.request.scopes).toEqual(
      expect.arrayContaining(["operator.read", "operator.write"]),
    );

    const list = await listDevicePairing(baseDir);
    expect(list.pending).toHaveLength(1);
    expect(list.pending[0]?.requestId).toBe(second.request.requestId);

    await approveDevicePairing(
      second.request.requestId,
      { callerScopes: ["operator.read", "operator.write"] },
      baseDir,
    );
    const paired = await getPairedDevice("device-1", baseDir);
    expect(paired?.roles).toEqual(expect.arrayContaining(["node", "operator"]));
    expect(paired?.scopes).toEqual(expect.arrayContaining(["operator.read", "operator.write"]));
  });

  test("approves mixed node and operator requests with admin caller scopes", async () => {
    const baseDir = await makeDevicePairingDir();
    const request = await requestDevicePairing(
      {
        deviceId: "device-1",
        publicKey: "public-key-1",
        roles: ["node", "operator"],
        scopes: ["operator.read", "operator.write", "operator.talk.secrets"],
      },
      baseDir,
    );

    await expect(
      approveDevicePairing(
        request.request.requestId,
        { callerScopes: ["operator.admin", "operator.pairing"] },
        baseDir,
      ),
    ).resolves.toMatchObject({
      status: "approved",
      requestId: request.request.requestId,
    });

    const paired = await getPairedDevice("device-1", baseDir);
    expect(paired && listEffectivePairedDeviceRoles(paired)).toEqual(["node", "operator"]);
    expect(paired?.tokens?.node?.scopes).toEqual([]);
    expect(paired?.tokens?.operator?.scopes).toEqual([
      "operator.read",
      "operator.talk.secrets",
      "operator.write",
    ]);
    await expect(
      verifyDeviceToken({
        deviceId: "device-1",
        token: requireToken(paired?.tokens?.node?.token),
        role: "node",
        scopes: [],
        baseDir,
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      verifyDeviceToken({
        deviceId: "device-1",
        token: requireToken(paired?.tokens?.operator?.token),
        role: "operator",
        scopes: ["operator.read"],
        baseDir,
      }),
    ).resolves.toEqual({ ok: true });
  });

  test("preserves requested non-operator scopes on newly minted role tokens", async () => {
    const baseDir = await makeDevicePairingDir();
    const request = await requestDevicePairing(
      {
        deviceId: "device-1",
        publicKey: "public-key-1",
        role: "node",
        scopes: ["node.exec"],
      },
      baseDir,
    );

    await expect(approveDevicePairing(request.request.requestId, baseDir)).resolves.toMatchObject({
      status: "approved",
      requestId: request.request.requestId,
    });

    const paired = await getPairedDevice("device-1", baseDir);
    expect(paired?.tokens?.node?.scopes).toEqual(["node.exec"]);
    await expect(
      verifyDeviceToken({
        deviceId: "device-1",
        token: requireToken(paired?.tokens?.node?.token),
        role: "node",
        scopes: ["node.exec"],
        baseDir,
      }),
    ).resolves.toEqual({ ok: true });
  });

  test.each([
    {
      name: "node custom scope",
      roles: ["node"],
      scopes: ["vault.admin"],
      scope: "vault.admin",
      callerScopes: [],
    },
    {
      name: "operator custom scope",
      roles: ["operator"],
      scopes: ["vault.admin"],
      scope: "vault.admin",
      callerScopes: ["operator.pairing"],
    },
    {
      name: "node requesting operator scope",
      roles: ["node"],
      scopes: ["operator.read"],
      scope: "operator.read",
      callerScopes: ["operator.read"],
    },
  ])("rejects requested scopes outside requested roles: $name", async (params) => {
    const baseDir = await makeDevicePairingDir();
    const request = await requestDevicePairing(
      {
        deviceId: "device-1",
        publicKey: "public-key-1",
        roles: params.roles,
        scopes: params.scopes,
      },
      baseDir,
    );

    await expect(
      approveDevicePairing(
        request.request.requestId,
        { callerScopes: params.callerScopes },
        baseDir,
      ),
    ).resolves.toEqual({
      status: "forbidden",
      reason: "scope-outside-requested-roles",
      scope: params.scope,
    });
    await expect(getPairedDevice("device-1", baseDir)).resolves.toBeNull();
  });

  test("preserves existing non-operator scopes during operator-only mixed-role repairs", async () => {
    const baseDir = await makeDevicePairingDir();
    const initial = await requestDevicePairing(
      {
        deviceId: "device-1",
        publicKey: "public-key-1",
        role: "node",
        scopes: ["node.exec"],
      },
      baseDir,
    );
    await expect(approveDevicePairing(initial.request.requestId, baseDir)).resolves.toMatchObject({
      status: "approved",
      requestId: initial.request.requestId,
    });

    const repair = await requestDevicePairing(
      {
        deviceId: "device-1",
        publicKey: "public-key-1",
        roles: ["node", "operator"],
        scopes: ["operator.read"],
      },
      baseDir,
    );
    await expect(
      approveDevicePairing(repair.request.requestId, { callerScopes: ["operator.read"] }, baseDir),
    ).resolves.toMatchObject({
      status: "approved",
      requestId: repair.request.requestId,
    });

    const paired = await getPairedDevice("device-1", baseDir);
    expect(paired?.tokens?.node?.scopes).toEqual(["node.exec"]);
    expect(paired?.tokens?.operator?.scopes).toEqual(["operator.read"]);
    await expect(
      verifyDeviceToken({
        deviceId: "device-1",
        token: requireToken(paired?.tokens?.node?.token),
        role: "node",
        scopes: ["node.exec"],
        baseDir,
      }),
    ).resolves.toEqual({ ok: true });
  });

  test("keeps superseded requests interactive when an existing pending request is interactive", async () => {
    const baseDir = await makeDevicePairingDir();
    const first = await requestDevicePairing(
      {
        deviceId: "device-1",
        publicKey: "public-key-1",
        role: "node",
        scopes: [],
        silent: false,
      },
      baseDir,
    );
    expect(first.request.silent).toBe(false);

    const second = await requestDevicePairing(
      {
        deviceId: "device-1",
        publicKey: "public-key-1",
        role: "operator",
        scopes: ["operator.read"],
        silent: true,
      },
      baseDir,
    );

    expect(second.created).toBe(true);
    expect(second.request.requestId).not.toBe(first.request.requestId);
    expect(second.request.silent).toBe(false);
  });

  test("rejects bootstrap token replay before pending scope escalation can be approved", async () => {
    const baseDir = await makeDevicePairingDir();
    const issued = await issueDeviceBootstrapToken({
      baseDir,
      roles: ["operator"],
      scopes: ["operator.read"],
    });

    await expect(
      verifyDeviceBootstrapToken({
        token: issued.token,
        deviceId: "device-1",
        publicKey: "public-key-1",
        role: "operator",
        scopes: ["operator.read"],
        baseDir,
      }),
    ).resolves.toEqual({ ok: true });

    const first = await requestDevicePairing(
      {
        deviceId: "device-1",
        publicKey: "public-key-1",
        role: "operator",
        scopes: ["operator.read"],
      },
      baseDir,
    );

    await expect(
      verifyDeviceBootstrapToken({
        token: issued.token,
        deviceId: "device-1",
        publicKey: "public-key-1",
        role: "operator",
        scopes: ["operator.admin"],
        baseDir,
      }),
    ).resolves.toEqual({ ok: false, reason: "bootstrap_token_invalid" });

    await approveDevicePairing(
      first.request.requestId,
      { callerScopes: ["operator.read"] },
      baseDir,
    );
    const paired = await getPairedDevice("device-1", baseDir);
    expect(paired?.scopes).toEqual(["operator.read"]);
    expect(paired?.approvedScopes).toEqual(["operator.read"]);
    expect(paired?.tokens?.operator?.scopes).toEqual(["operator.read"]);
  });

  test("fails closed for operator approvals when caller scopes are omitted", async () => {
    const baseDir = await makeDevicePairingDir();
    const request = await requestDevicePairing(
      {
        deviceId: "device-1",
        publicKey: "public-key-1",
        role: "operator",
        scopes: ["operator.admin"],
      },
      baseDir,
    );

    await expect(approveDevicePairing(request.request.requestId, baseDir)).resolves.toEqual({
      status: "forbidden",
      reason: "caller-scopes-required",
      scope: "operator.admin",
    });

    await expect(
      approveDevicePairing(
        request.request.requestId,
        {
          callerScopes: ["operator.admin"],
        },
        baseDir,
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        status: "approved",
        requestId: request.request.requestId,
      }),
    );
  });

  test("metadata refresh cannot mutate approved role and scope fields", async () => {
    const baseDir = await makeDevicePairingDir();
    await setupPairedNodeDevice(baseDir);

    await updatePairedDeviceMetadata(
      "node-1",
      {
        displayName: "renamed-node",
        role: "operator",
        roles: ["operator"],
        scopes: ["operator.admin"],
        approvedScopes: ["operator.admin"],
        tokens: {},
        publicKey: "attacker-key",
      } as unknown as Parameters<typeof updatePairedDeviceMetadata>[1],
      baseDir,
    );

    const paired = await getPairedDevice("node-1", baseDir);
    expect(paired?.displayName).toBe("renamed-node");
    expect(paired?.publicKey).toBe("public-key-node-1");
    expect(paired?.role).toBe("node");
    expect(paired?.roles).toEqual(["node"]);
    expect(paired?.scopes).toEqual([]);
    expect(paired?.approvedScopes).toEqual([]);
    expect(paired?.tokens?.node).toBeTruthy();
    expect(paired?.tokens?.operator).toBeUndefined();
  });

  test("generates base64url device tokens with 256-bit entropy output length", async () => {
    const baseDir = await makeDevicePairingDir();
    await setupPairedOperatorDevice(baseDir, ["operator.admin"]);

    const paired = await getPairedDevice("device-1", baseDir);
    const token = requireToken(paired?.tokens?.operator?.token);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
  });

  test("allows down-scoping from admin and preserves approved scope baseline", async () => {
    const baseDir = await makeDevicePairingDir();
    await setupPairedOperatorDevice(baseDir, ["operator.admin"]);

    const downscoped = await rotateDeviceToken({
      deviceId: "device-1",
      role: "operator",
      scopes: ["operator.read"],
      baseDir,
    });
    expect(downscoped.ok).toBe(true);
    let paired = await getPairedDevice("device-1", baseDir);
    expect(paired?.tokens?.operator?.scopes).toEqual(["operator.read"]);
    expect(paired?.scopes).toEqual(["operator.admin"]);
    expect(paired?.approvedScopes).toEqual(["operator.admin"]);

    const reused = await rotateDeviceToken({
      deviceId: "device-1",
      role: "operator",
      baseDir,
    });
    expect(reused.ok).toBe(true);
    paired = await getPairedDevice("device-1", baseDir);
    expect(paired?.tokens?.operator?.scopes).toEqual(["operator.read"]);
  });

  test("preserves existing token scopes when approving a repair without requested scopes", async () => {
    const baseDir = await makeDevicePairingDir();
    await setupPairedOperatorDevice(baseDir, ["operator.admin"]);

    const repair = await requestDevicePairing(
      {
        deviceId: "device-1",
        publicKey: "public-key-1",
        role: "operator",
      },
      baseDir,
    );
    await approveDevicePairing(
      repair.request.requestId,
      { callerScopes: ["operator.admin"] },
      baseDir,
    );

    const paired = await getPairedDevice("device-1", baseDir);
    expect(paired?.scopes).toEqual(["operator.admin"]);
    expect(paired?.approvedScopes).toEqual(["operator.admin"]);
    expect(paired?.tokens?.operator?.scopes).toEqual([
      "operator.admin",
      "operator.read",
      "operator.write",
    ]);
  });

  test("rejects scope escalation when rotating a token and leaves state unchanged", async () => {
    const baseDir = await makeDevicePairingDir();
    await setupPairedOperatorDevice(baseDir, ["operator.read"]);
    const before = await getPairedDevice("device-1", baseDir);

    const rotated = await rotateDeviceToken({
      deviceId: "device-1",
      role: "operator",
      scopes: ["operator.admin"],
      baseDir,
    });
    expect(rotated).toEqual({ ok: false, reason: "scope-outside-approved-baseline" });

    const after = await getPairedDevice("device-1", baseDir);
    expect(after?.tokens?.operator?.token).toEqual(before?.tokens?.operator?.token);
    expect(after?.tokens?.operator?.scopes).toEqual(["operator.read"]);
    expect(after?.scopes).toEqual(["operator.read"]);
    expect(after?.approvedScopes).toEqual(["operator.read"]);
  });

  test("rejects omitted-scope rotation when caller cannot hold the current token scopes", async () => {
    const baseDir = await makeDevicePairingDir();
    await setupPairedOperatorDevice(baseDir, ["operator.admin"]);
    const before = await getPairedDevice("device-1", baseDir);

    const rotated = await rotateDeviceToken({
      deviceId: "device-1",
      role: "operator",
      callerScopes: ["operator.pairing"],
      baseDir,
    });
    expect(rotated).toEqual({
      ok: false,
      reason: "caller-missing-scope",
      scope: "operator.admin",
    });

    const after = await getPairedDevice("device-1", baseDir);
    expect(after?.tokens?.operator?.token).toEqual(before?.tokens?.operator?.token);
    expect(after?.tokens?.operator?.scopes).toEqual([
      "operator.admin",
      "operator.read",
      "operator.write",
    ]);
    expect(after?.tokens?.operator?.revokedAtMs).toBeUndefined();
  });

  test("rejects token revocation when caller cannot hold the target token scopes", async () => {
    const baseDir = await makeDevicePairingDir();
    await setupPairedOperatorDevice(baseDir, ["operator.admin"]);
    const before = await getPairedDevice("device-1", baseDir);

    const revoked = await revokeDeviceToken({
      deviceId: "device-1",
      role: "operator",
      callerScopes: ["operator.pairing"],
      baseDir,
    });
    expect(revoked).toEqual({
      ok: false,
      reason: "caller-missing-scope",
      scope: "operator.admin",
    });

    const after = await getPairedDevice("device-1", baseDir);
    expect(after?.tokens?.operator?.token).toEqual(before?.tokens?.operator?.token);
    expect(after?.tokens?.operator?.revokedAtMs).toBeUndefined();
  });

  test("allows token revocation when caller holds the target token scopes", async () => {
    const baseDir = await makeDevicePairingDir();
    await setupPairedOperatorDevice(baseDir, ["operator.admin"]);

    const revoked = await revokeDeviceToken({
      deviceId: "device-1",
      role: "operator",
      callerScopes: ["operator.admin"],
      baseDir,
    });
    expect(revoked).toEqual({
      ok: true,
      entry: expect.objectContaining({
        role: "operator",
        revokedAtMs: expect.any(Number),
      }),
    });

    const after = await getPairedDevice("device-1", baseDir);
    expect(after?.tokens?.operator?.revokedAtMs).toBeTypeOf("number");
  });

  test("rejects scope escalation when ensuring a token and leaves state unchanged", async () => {
    const baseDir = await makeDevicePairingDir();
    await setupPairedOperatorDevice(baseDir, ["operator.read"]);
    const before = await getPairedDevice("device-1", baseDir);

    const ensured = await ensureDeviceToken({
      deviceId: "device-1",
      role: "operator",
      scopes: ["operator.admin"],
      baseDir,
    });
    expect(ensured).toBeNull();

    const after = await getPairedDevice("device-1", baseDir);
    expect(after?.tokens?.operator?.token).toEqual(before?.tokens?.operator?.token);
    expect(after?.tokens?.operator?.scopes).toEqual(["operator.read"]);
    expect(after?.scopes).toEqual(["operator.read"]);
    expect(after?.approvedScopes).toEqual(["operator.read"]);
  });

  test("preserves explicit empty scope baselines for node device tokens", async () => {
    const baseDir = await makeDevicePairingDir();
    await setupPairedNodeDevice(baseDir);

    const paired = await getPairedDevice("node-1", baseDir);
    expect(paired?.scopes).toEqual([]);
    expect(paired?.approvedScopes).toEqual([]);

    const seededToken = requireToken(paired?.tokens?.node?.token);
    await expect(
      ensureDeviceToken({
        deviceId: "node-1",
        role: "node",
        scopes: [],
        baseDir,
      }),
    ).resolves.toEqual(expect.objectContaining({ token: seededToken, scopes: [] }));

    await expect(
      verifyDeviceToken({
        deviceId: "node-1",
        token: seededToken,
        role: "node",
        scopes: [],
        baseDir,
      }),
    ).resolves.toEqual({ ok: true });
  });

  test("normalizes legacy node token scopes back to [] on re-approval", async () => {
    const baseDir = await makeDevicePairingDir();
    await setupPairedNodeDevice(baseDir);

    await mutatePairedDevice(baseDir, "node-1", (device) => {
      const nodeToken = device.tokens?.node;
      expect(nodeToken).toBeDefined();
      if (!nodeToken) {
        throw new Error("expected paired node token");
      }
      nodeToken.scopes = ["operator.read"];
    });

    const repair = await requestDevicePairing(
      {
        deviceId: "node-1",
        publicKey: "public-key-node-1",
        role: "node",
      },
      baseDir,
    );
    await approveDevicePairing(repair.request.requestId, { callerScopes: [] }, baseDir);

    const paired = await getPairedDevice("node-1", baseDir);
    expect(paired?.scopes).toEqual([]);
    expect(paired?.approvedScopes).toEqual([]);
    expect(paired?.tokens?.node?.scopes).toEqual([]);
  });

  test("bootstrap pairing seeds node and operator device tokens explicitly", async () => {
    const baseDir = await makeDevicePairingDir();
    const request = await requestDevicePairing(
      {
        deviceId: "bootstrap-device-1",
        publicKey: "bootstrap-public-key-1",
        role: "node",
        roles: ["node", "operator"],
        scopes: [],
        silent: true,
      },
      baseDir,
    );

    await expect(
      approveBootstrapDevicePairing(
        request.request.requestId,
        PAIRING_SETUP_BOOTSTRAP_PROFILE,
        baseDir,
      ),
    ).resolves.toEqual(expect.objectContaining({ status: "approved" }));

    const paired = await getPairedDevice("bootstrap-device-1", baseDir);
    expect(paired?.roles).toEqual(expect.arrayContaining(["node", "operator"]));
    expect(paired?.approvedScopes).toEqual(
      expect.arrayContaining(PAIRING_SETUP_BOOTSTRAP_PROFILE.scopes),
    );
    expect(paired?.tokens?.node?.scopes).toEqual([]);
    expect(paired?.tokens?.operator?.scopes).toEqual(
      expect.arrayContaining(PAIRING_SETUP_BOOTSTRAP_PROFILE.scopes),
    );
  });

  test("bootstrap pairing keeps operator token scopes operator-only", async () => {
    const baseDir = await makeDevicePairingDir();
    const request = await requestDevicePairing(
      {
        deviceId: "bootstrap-device-operator-scope",
        publicKey: "bootstrap-public-key-operator-scope",
        role: "node",
        roles: ["node", "operator"],
        scopes: [],
        silent: true,
      },
      baseDir,
    );

    await expect(
      approveBootstrapDevicePairing(
        request.request.requestId,
        {
          roles: ["node", "operator"],
          scopes: ["node.exec", "operator.pairing", "operator.read", "operator.write"],
        },
        baseDir,
      ),
    ).resolves.toEqual(expect.objectContaining({ status: "approved" }));

    const paired = await getPairedDevice("bootstrap-device-operator-scope", baseDir);
    expect(paired?.tokens?.operator?.scopes).toEqual(["operator.read", "operator.write"]);
    expect(paired?.tokens?.node?.scopes).toEqual([]);
  });

  test("verifies token and rejects mismatches", async () => {
    const { baseDir, token } = await setupOperatorToken(["operator.read"]);

    const ok = await verifyOperatorToken({
      baseDir,
      token,
      scopes: ["operator.read"],
    });
    expect(ok.ok).toBe(true);

    const mismatch = await verifyOperatorToken({
      baseDir,
      token: "x".repeat(token.length),
      scopes: ["operator.read"],
    });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.reason).toBe("token-mismatch");
  });

  test("rejects persisted tokens whose scopes exceed the approved scope baseline", async () => {
    const { baseDir, token } = await setupOperatorToken(["operator.read"]);
    await overwritePairedOperatorTokenScopes(baseDir, ["operator.admin"]);

    await expect(
      verifyOperatorToken({
        baseDir,
        token,
        scopes: ["operator.admin"],
      }),
    ).resolves.toEqual({ ok: false, reason: "scope-mismatch" });
  });

  test("fails closed when the paired device approval baseline is missing during verification", async () => {
    const { baseDir, token } = await setupOperatorToken(["operator.read"]);
    await clearPairedOperatorApprovalBaseline(baseDir);

    await expect(
      verifyOperatorToken({
        baseDir,
        token,
        scopes: ["operator.read"],
      }),
    ).resolves.toEqual({ ok: false, reason: "scope-mismatch" });
  });

  test("accepts operator.read/operator.write requests with an operator.admin token scope", async () => {
    const { baseDir, token } = await setupOperatorToken(["operator.admin"]);

    const readOk = await verifyOperatorToken({
      baseDir,
      token,
      scopes: ["operator.read"],
    });
    expect(readOk.ok).toBe(true);

    const writeOk = await verifyOperatorToken({
      baseDir,
      token,
      scopes: ["operator.write"],
    });
    expect(writeOk.ok).toBe(true);
  });

  test("accepts custom operator scopes under an operator.admin approval baseline", async () => {
    const baseDir = await makeDevicePairingDir();
    await setupPairedOperatorDevice(baseDir, ["operator.admin"]);

    const rotated = await rotateDeviceToken({
      deviceId: "device-1",
      role: "operator",
      scopes: ["operator.talk.secrets"],
      baseDir,
    });
    const entry = requireRotatedEntry(rotated);
    expect(entry.scopes).toEqual(["operator.talk.secrets"]);

    await expect(
      verifyOperatorToken({
        baseDir,
        token: requireToken(entry.token),
        scopes: ["operator.talk.secrets"],
      }),
    ).resolves.toEqual({ ok: true });
  });

  test("fails closed when the paired device approval baseline is missing during ensure", async () => {
    const baseDir = await makeDevicePairingDir();
    await setupPairedOperatorDevice(baseDir, ["operator.admin"]);
    await clearPairedOperatorApprovalBaseline(baseDir);

    await expect(
      ensureDeviceToken({
        deviceId: "device-1",
        role: "operator",
        scopes: ["operator.admin"],
        baseDir,
      }),
    ).resolves.toBeNull();
  });

  test("fails closed when the paired device approval baseline is missing during rotation", async () => {
    const baseDir = await makeDevicePairingDir();
    await setupPairedOperatorDevice(baseDir, ["operator.admin"]);
    await clearPairedOperatorApprovalBaseline(baseDir);

    await expect(
      rotateDeviceToken({
        deviceId: "device-1",
        role: "operator",
        scopes: ["operator.admin"],
        baseDir,
      }),
    ).resolves.toEqual({ ok: false, reason: "missing-approved-scope-baseline" });
  });

  test("treats multibyte same-length token input as mismatch without throwing", async () => {
    const { baseDir, token } = await setupOperatorToken(["operator.read"]);
    const multibyteToken = "é".repeat(token.length);
    expect(Buffer.from(multibyteToken).length).not.toBe(Buffer.from(token).length);

    await expect(
      verifyOperatorToken({
        baseDir,
        token: multibyteToken,
        scopes: ["operator.read"],
      }),
    ).resolves.toEqual({ ok: false, reason: "token-mismatch" });
  });

  test("derives effective roles from active tokens instead of sticky historical roles", async () => {
    const baseDir = await makeDevicePairingDir();
    const request = await requestDevicePairing(
      {
        deviceId: "device-1",
        publicKey: "public-key-1",
        role: "node",
      },
      baseDir,
    );
    await approveDevicePairing(request.request.requestId, { callerScopes: [] }, baseDir);

    let paired = await getPairedDevice("device-1", baseDir);
    expect(paired).toBeDefined();
    if (!paired) {
      throw new Error("expected paired node device");
    }
    expect(paired?.roles).toContain("node");
    expect(listEffectivePairedDeviceRoles(paired)).toEqual(["node"]);
    expect(hasEffectivePairedDeviceRole(paired, "node")).toBe(true);

    await revokeDeviceToken({ deviceId: "device-1", role: "node", baseDir });

    paired = await getPairedDevice("device-1", baseDir);
    expect(paired).toBeDefined();
    if (!paired) {
      throw new Error("expected paired node device after revoke");
    }
    expect(paired?.roles).toContain("node");
    expect(listEffectivePairedDeviceRoles(paired)).toEqual([]);
    expect(hasEffectivePairedDeviceRole(paired, "node")).toBe(false);
  });

  test("fails closed for tokenless legacy role fields", async () => {
    const device: PairedDevice = {
      deviceId: "device-fallback",
      publicKey: "pk-fallback",
      role: "node",
      roles: ["node", "operator"],
      tokens: {},
      createdAtMs: Date.now(),
      approvedAtMs: Date.now(),
    };
    expect(listEffectivePairedDeviceRoles(device)).toEqual([]);
    expect(hasEffectivePairedDeviceRole(device, "node")).toBe(false);
    expect(hasEffectivePairedDeviceRole(device, "operator")).toBe(false);
  });

  test("filters active token roles to the approved pairing role set", async () => {
    const now = Date.now();
    const device: PairedDevice = {
      deviceId: "device-filtered",
      publicKey: "pk-filtered",
      role: "operator",
      roles: ["operator"],
      tokens: {
        node: {
          token: "forged-node-token",
          role: "node",
          scopes: [],
          createdAtMs: now,
        },
        operator: {
          token: "real-operator-token",
          role: "operator",
          scopes: ["operator.read"],
          createdAtMs: now,
        },
      },
      createdAtMs: now,
      approvedAtMs: now,
    };

    expect(listEffectivePairedDeviceRoles(device)).toEqual(["operator"]);
    expect(hasEffectivePairedDeviceRole(device, "node")).toBe(false);
  });

  test("rejects rotating a token for a role that was never approved", async () => {
    const baseDir = await makeDevicePairingDir();
    await setupPairedOperatorDevice(baseDir, ["operator.pairing"]);

    await expect(
      rotateDeviceToken({
        deviceId: "device-1",
        role: "node",
        baseDir,
      }),
    ).resolves.toEqual({ ok: false, reason: "unknown-device-or-role" });

    const paired = await getPairedDevice("device-1", baseDir);
    expect(paired?.tokens?.node).toBeUndefined();
    expect(paired && listEffectivePairedDeviceRoles(paired)).toEqual(["operator"]);
  });

  test("removes paired devices by device id", async () => {
    const baseDir = await makeDevicePairingDir();
    await setupPairedOperatorDevice(baseDir, ["operator.read"]);

    const removed = await removePairedDevice("device-1", baseDir);
    expect(removed).toEqual({ deviceId: "device-1" });
    await expect(getPairedDevice("device-1", baseDir)).resolves.toBeNull();

    await expect(removePairedDevice("device-1", baseDir)).resolves.toBeNull();
  });

  test("removing a paired device clears pending requests for that device only", async () => {
    const baseDir = await makeDevicePairingDir();
    await setupPairedOperatorDevice(baseDir, ["operator.read"]);

    const staleRepair = await requestDevicePairing(
      {
        deviceId: "device-1",
        publicKey: "public-key-1-rotated",
        role: "operator",
        scopes: ["operator.read"],
      },
      baseDir,
    );
    const otherPending = await requestDevicePairing(
      {
        deviceId: "device-2",
        publicKey: "public-key-2",
        role: "node",
        scopes: [],
      },
      baseDir,
    );

    await expect(removePairedDevice("device-1", baseDir)).resolves.toEqual({
      deviceId: "device-1",
    });

    const pending = (await listDevicePairing(baseDir)).pending;
    expect(pending.map((entry) => entry.requestId)).not.toContain(staleRepair.request.requestId);
    expect(pending.map((entry) => entry.requestId)).toContain(otherPending.request.requestId);
    await expect(
      approveDevicePairing(
        staleRepair.request.requestId,
        { callerScopes: ["operator.read"] },
        baseDir,
      ),
    ).resolves.toBeNull();
    await expect(getPairedDevice("device-1", baseDir)).resolves.toBeNull();
  });

  test("refuses to overwrite corrupt paired device state", async () => {
    const baseDir = await makeDevicePairingDir();
    const request = await requestDevicePairing(
      {
        deviceId: "device-1",
        publicKey: "public-key-1",
        role: "node",
        scopes: [],
      },
      baseDir,
    );
    const { pairedPath } = resolvePairingPaths(baseDir, "devices");
    await writeFile(pairedPath, "{not-json}", "utf8");

    await expect(
      approveDevicePairing(request.request.requestId, { callerScopes: [] }, baseDir),
    ).rejects.toThrow(/paired\.json/);
    await expect(readFile(pairedPath, "utf8")).resolves.toBe("{not-json}");
  });

  test("clears paired device state by device id", async () => {
    const baseDir = await makeDevicePairingDir();
    await setupPairedOperatorDevice(baseDir, ["operator.read"]);

    await expect(clearDevicePairing("device-1", baseDir)).resolves.toBe(true);
    await expect(getPairedDevice("device-1", baseDir)).resolves.toBeNull();
    await expect(clearDevicePairing("device-1", baseDir)).resolves.toBe(false);
  });
});

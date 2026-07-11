// SSH-verified node pairing policy and verifier tests (probe injected).
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  deriveDeviceIdFromPublicKey,
  publicKeyRawBase64UrlFromPem,
} from "../infra/device-identity.js";
import type { FreshNodePairingEligibilityParams } from "./node-pairing-auto-approve.js";
import {
  planNodePairingSshVerify,
  resetNodePairingSshVerifyStateForTests,
  resolveNodePairingSshVerifyPolicy,
  startNodePairingSshVerify,
  type NodePairingSshVerifyPlan,
} from "./node-pairing-ssh-verify.js";
import type {
  NodeIdentityProbeParams,
  NodeIdentityProbeResult,
} from "./node-pairing-ssh-verify.runtime.js";

function makeIdentity(): { deviceId: string; publicKey: string } {
  const { publicKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }) as string;
  const raw = publicKeyRawBase64UrlFromPem(publicKeyPem);
  const deviceId = deriveDeviceIdFromPublicKey(raw);
  if (!deviceId) {
    throw new Error("failed to derive device id for test identity");
  }
  return { deviceId, publicKey: raw };
}

function makeEligibility(
  overrides?: Partial<FreshNodePairingEligibilityParams>,
): FreshNodePairingEligibilityParams {
  return {
    existingPairedDevice: false,
    role: "node",
    reason: "not-paired",
    scopes: [],
    hasBrowserOriginHeader: false,
    isControlUi: false,
    isWebchat: false,
    reportedClientIpSource: "direct",
    reportedClientIp: "192.168.1.20",
    ...overrides,
  };
}

function makePlan(host = "192.168.1.20"): NodePairingSshVerifyPlan {
  return {
    policy: { user: "tester", timeoutMs: 1_000 },
    host,
  };
}

function probeReturning(result: NodeIdentityProbeResult) {
  const calls: NodeIdentityProbeParams[] = [];
  const probe = async (params: NodeIdentityProbeParams) => {
    calls.push(params);
    return result;
  };
  return { probe, calls };
}

beforeEach(() => {
  resetNodePairingSshVerifyStateForTests();
});

afterEach(() => {
  resetNodePairingSshVerifyStateForTests();
});

describe("resolveNodePairingSshVerifyPolicy", () => {
  test("is enabled by default and honors explicit true", () => {
    for (const raw of [undefined, true] as const) {
      const policy = resolveNodePairingSshVerifyPolicy(raw);
      expect(policy).not.toBeNull();
      expect(policy?.user.length).toBeGreaterThan(0);
      expect(policy?.timeoutMs).toBe(7_000);
    }
  });

  test("false disables the policy", () => {
    expect(resolveNodePairingSshVerifyPolicy(false)).toBeNull();
  });

  test("object form overrides user, identity, timeout, and cidrs", () => {
    const policy = resolveNodePairingSshVerifyPolicy({
      user: "peter",
      identity: "/keys/probe",
      timeoutMs: 1234,
      cidrs: ["10.0.0.0/8", "  "],
    });
    expect(policy).toEqual({
      user: "peter",
      identity: "/keys/probe",
      timeoutMs: 1234,
      cidrs: ["10.0.0.0/8"],
    });
  });
});

describe("planNodePairingSshVerify", () => {
  test("plans a probe for an eligible private-network node pairing", () => {
    const plan = planNodePairingSshVerify({
      config: undefined,
      eligibility: makeEligibility(),
    });
    expect(plan?.host).toBe("192.168.1.20");
  });

  test("strips the IPv4-mapped IPv6 prefix from the probe target", () => {
    const plan = planNodePairingSshVerify({
      config: undefined,
      eligibility: makeEligibility({ reportedClientIp: "::ffff:192.168.1.21" }),
    });
    expect(plan?.host).toBe("192.168.1.21");
  });

  test.each([
    ["disabled config", { config: false as const, eligibility: makeEligibility() }],
    [
      "existing paired device",
      { config: undefined, eligibility: makeEligibility({ existingPairedDevice: true }) },
    ],
    ["operator role", { config: undefined, eligibility: makeEligibility({ role: "operator" }) }],
    [
      "upgrade reason",
      { config: undefined, eligibility: makeEligibility({ reason: "scope-upgrade" }) },
    ],
    [
      "requested scopes",
      { config: undefined, eligibility: makeEligibility({ scopes: ["operator.read"] }) },
    ],
    [
      "browser origin",
      { config: undefined, eligibility: makeEligibility({ hasBrowserOriginHeader: true }) },
    ],
    [
      "spoofable loopback proxy source",
      {
        config: undefined,
        eligibility: makeEligibility({ reportedClientIpSource: "loopback-trusted-proxy" }),
      },
    ],
    [
      "public source address",
      { config: undefined, eligibility: makeEligibility({ reportedClientIp: "203.0.113.9" }) },
    ],
    [
      "loopback source address",
      { config: undefined, eligibility: makeEligibility({ reportedClientIp: "127.0.0.1" }) },
    ],
    [
      "zone-scoped IPv6 literal",
      { config: undefined, eligibility: makeEligibility({ reportedClientIp: "fe80::1%en0" }) },
    ],
  ])("returns null for %s", (_label, params) => {
    expect(planNodePairingSshVerify(params)).toBeNull();
  });

  test("custom cidrs replace the default private-range probe scope", () => {
    const config = { cidrs: ["10.1.0.0/16"] };
    expect(
      planNodePairingSshVerify({
        config,
        eligibility: makeEligibility({ reportedClientIp: "192.168.1.20" }),
      }),
    ).toBeNull();
    expect(
      planNodePairingSshVerify({
        config,
        eligibility: makeEligibility({ reportedClientIp: "10.1.2.3" }),
      })?.host,
    ).toBe("10.1.2.3");
  });
});

describe("startNodePairingSshVerify", () => {
  test("approves when the remote identity matches, tolerating login-shell noise", async () => {
    const identity = makeIdentity();
    const { probe, calls } = probeReturning({
      status: "ok",
      stdout: `Welcome to devbox\n{"deviceId":"${identity.deviceId}","publicKey":"${identity.publicKey}"}\n`,
    });
    const started = startNodePairingSshVerify({
      plan: makePlan(),
      expectedDeviceId: identity.deviceId,
      expectedPublicKey: identity.publicKey,
      probe,
    });
    expect(started).not.toBeNull();
    await expect(started?.done).resolves.toEqual({
      ok: true,
      user: "tester",
      host: "192.168.1.20",
    });
    expect(calls).toEqual([
      { user: "tester", host: "192.168.1.20", identity: undefined, timeoutMs: 1_000 },
    ]);
  });

  test("rejects a remote identity with a different key and cools the target down", async () => {
    const expected = makeIdentity();
    const other = makeIdentity();
    const { probe } = probeReturning({
      status: "ok",
      stdout: `{"deviceId":"${expected.deviceId}","publicKey":"${other.publicKey}"}\n`,
    });
    const started = startNodePairingSshVerify({
      plan: makePlan(),
      expectedDeviceId: expected.deviceId,
      expectedPublicKey: expected.publicKey,
      probe,
    });
    await expect(started?.done).resolves.toEqual({ ok: false, reason: "identity-mismatch" });
    expect(
      startNodePairingSshVerify({
        plan: makePlan(),
        expectedDeviceId: expected.deviceId,
        expectedPublicKey: expected.publicKey,
        probe,
      }),
    ).toBeNull();
  });

  test("rejects a matching key under a different device id", async () => {
    const identity = makeIdentity();
    const { probe } = probeReturning({
      status: "ok",
      stdout: `{"deviceId":"someone-else","publicKey":"${identity.publicKey}"}\n`,
    });
    const started = startNodePairingSshVerify({
      plan: makePlan(),
      expectedDeviceId: identity.deviceId,
      expectedPublicKey: identity.publicKey,
      probe,
    });
    await expect(started?.done).resolves.toEqual({ ok: false, reason: "identity-mismatch" });
  });

  test("reports probe failures and unreadable identities distinctly", async () => {
    const identity = makeIdentity();
    const failed = startNodePairingSshVerify({
      plan: makePlan("192.168.1.30"),
      expectedDeviceId: identity.deviceId,
      expectedPublicKey: identity.publicKey,
      probe: probeReturning({ status: "failed", code: 255, stderr: "denied" }).probe,
    });
    await expect(failed?.done).resolves.toEqual({ ok: false, reason: "probe-failed" });

    const unreadable = startNodePairingSshVerify({
      plan: makePlan("192.168.1.31"),
      expectedDeviceId: identity.deviceId,
      expectedPublicKey: identity.publicKey,
      probe: probeReturning({ status: "ok", stdout: "no json here\n" }).probe,
    });
    await expect(unreadable?.done).resolves.toEqual({ ok: false, reason: "identity-unreadable" });
  });

  test("shares an in-flight probe with reconnects instead of starting another", async () => {
    const identity = makeIdentity();
    let probeRuns = 0;
    let release: (result: NodeIdentityProbeResult) => void = () => {};
    const gate = new Promise<NodeIdentityProbeResult>((resolve) => {
      release = resolve;
    });
    const probe = () => {
      probeRuns += 1;
      return gate;
    };
    const started = startNodePairingSshVerify({
      plan: makePlan(),
      expectedDeviceId: identity.deviceId,
      expectedPublicKey: identity.publicKey,
      probe,
    });
    expect(started).toMatchObject({ alreadyInFlight: false });
    const retry = startNodePairingSshVerify({
      plan: makePlan(),
      expectedDeviceId: identity.deviceId,
      expectedPublicKey: identity.publicKey,
      probe,
    });
    // The retry must observe the running probe (so the client keeps retrying)
    // without spawning a second one.
    expect(retry).toMatchObject({ alreadyInFlight: true });
    expect(retry?.done).toBe(started?.done);
    release({
      status: "ok",
      stdout: `{"deviceId":"${identity.deviceId}","publicKey":"${identity.publicKey}"}\n`,
    });
    await expect(started?.done).resolves.toMatchObject({ ok: true });
    expect(probeRuns).toBe(1);
  });
});

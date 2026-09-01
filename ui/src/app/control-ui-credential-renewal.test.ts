// @vitest-environment node
// The Gateway-minted Control UI credential expires on a fixed deadline and is
// never refreshed in place, so these run the real issuer and the real redemption
// check either side of that deadline: the point is that the browser reconnects
// early enough for the replacement to exist before the old one dies.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_SAFE_TIMEOUT_DELAY_MS } from "../../../packages/gateway-client/src/timeouts.js";
import {
  issueControlUiDeviceCredential,
  verifyControlUiDeviceCredential,
} from "../../../src/gateway/control-ui-device-credential.js";
import { READ_SCOPE } from "../../../src/gateway/operator-scopes.js";
import type { ControlUiAuthSource } from "./control-ui-auth.ts";
import { createControlUiCredentialRenewal } from "./control-ui-credential-renewal.ts";

const CONNECT_AT_MS = Date.UTC(2026, 7, 20, 12, 0, 0);
/** Longer than the shipped credential TTL, so it lands past any deadline. */
const PAST_ANY_DEADLINE_MS = 13 * 60 * 60 * 1000;
const DEVICE_ID = "device-tailscale-serve-dashboard";
const PRINCIPAL = "peter@github";
const AUTH_GENERATION = "gen-1";

/** Mint through production issuance, exactly as hello-ok does. */
function mintCredential(nowMs: number): { credential: string; expiresAtMs: number } {
  const issued = issueControlUiDeviceCredential({
    deviceId: DEVICE_ID,
    principal: PRINCIPAL,
    authGeneration: AUTH_GENERATION,
    nowMs,
  });
  if (!issued) {
    throw new Error("expected a principal-bound Control UI credential");
  }
  return issued;
}

/** The auth shape the store hands the scheduler after a Serve-lane hello. */
function serveHello(issued: { credential: string; expiresAtMs: number }): ControlUiAuthSource {
  return {
    hello: {
      auth: {
        httpCredential: issued.credential,
        httpCredentialExpiresAtMs: issued.expiresAtMs,
      },
    },
  };
}

/** The authorizer's own decision for a credential presented at `nowMs`. */
function authorizeAt(credential: string, nowMs: number): Promise<string[] | null> {
  return verifyControlUiDeviceCredential({
    credential,
    authGeneration: AUTH_GENERATION,
    resolvePresentedPrincipal: async () => PRINCIPAL,
    nowMs,
  });
}

describe("control ui credential renewal", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(CONNECT_AT_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps a held-open Serve dashboard authorized across the credential deadline", async () => {
    const issuedAtConnect = mintCredential(CONNECT_AT_MS);
    let presented = issuedAtConnect;
    const renewal = createControlUiCredentialRenewal({
      // A renewal is a reconnect, and a reconnect's hello-ok mints a fresh
      // credential — the same path the store drives against a live Gateway.
      renew: () => {
        presented = mintCredential(Date.now());
        renewal.arm(serveHello(presented));
      },
    });
    renewal.arm(serveHello(issuedAtConnect));

    await vi.advanceTimersByTimeAsync(PAST_ANY_DEADLINE_MS);

    const crossedDeadlineAtMs = Date.now();
    expect(crossedDeadlineAtMs).toBeGreaterThan(issuedAtConnect.expiresAtMs);
    // The credential the dashboard connected with is dead by now, which is the
    // 401 that broke assistant-media attachments before renewal existed.
    await expect(authorizeAt(issuedAtConnect.credential, crossedDeadlineAtMs)).resolves.toBeNull();
    // What it actually presents is the replacement renewal fetched in time.
    expect(presented.credential).not.toBe(issuedAtConnect.credential);
    await expect(authorizeAt(presented.credential, crossedDeadlineAtMs)).resolves.toEqual([
      READ_SCOPE,
    ]);

    renewal.stop();
  });

  it("schedules the reconnect before the deadline the hello carried", () => {
    const renew = vi.fn();
    const renewal = createControlUiCredentialRenewal({ renew });
    const issued = mintCredential(CONNECT_AT_MS);
    renewal.arm(serveHello(issued));

    // Renewal has to land while the current credential still authorizes reads;
    // firing on expiry would leave a window with no working credential at all.
    vi.advanceTimersByTime(Math.floor((issued.expiresAtMs - CONNECT_AT_MS) * 0.9));

    expect(renew).toHaveBeenCalledTimes(1);
    expect(Date.now()).toBeLessThan(issued.expiresAtMs);

    renewal.stop();
  });

  it("clamps an oversized hello deadline instead of firing the renewal immediately", () => {
    // Read the delay off `setTimeout` itself: `deps.renew` staying uncalled is a
    // proxy that a leaked or coerced timer can keep green, and the defect here is
    // precisely a delay the timer layer cannot represent.
    const scheduleSpy = vi.spyOn(globalThis, "setTimeout");
    const renew = vi.fn();
    const renewal = createControlUiCredentialRenewal({ renew });

    // An honest Gateway sends `now + 12h`; a hostile or buggy one can send any
    // positive protocol integer, and 0.85 of that still overflows a 32-bit timer.
    renewal.arm({
      hello: {
        auth: {
          httpCredential: mintCredential(CONNECT_AT_MS).credential,
          httpCredentialExpiresAtMs: Number.MAX_SAFE_INTEGER,
        },
      },
    });

    const scheduledDelayMs = Number(scheduleSpy.mock.calls.at(-1)?.[1]);
    expect(scheduledDelayMs).toBe(MAX_SAFE_TIMEOUT_DELAY_MS);
    // Unclamped, the overflowed delay fires on the next tick, and each renewal
    // reconnects into a fresh hello that arms the same immediate fire again.
    vi.advanceTimersByTime(0);
    expect(renew).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);

    renewal.stop();
    scheduleSpy.mockRestore();
  });

  it("leaves an ordinary deadline scheduled on its own lifetime fraction", () => {
    const scheduleSpy = vi.spyOn(globalThis, "setTimeout");
    const renewal = createControlUiCredentialRenewal({ renew: vi.fn() });
    const issued = mintCredential(CONNECT_AT_MS);

    renewal.arm(serveHello(issued));

    // The ceiling is a guard, not a new schedule: a real 12h credential still
    // renews at its own fraction, well under the clamp.
    expect(Number(scheduleSpy.mock.calls.at(-1)?.[1])).toBe(
      Math.floor((issued.expiresAtMs - CONNECT_AT_MS) * 0.85),
    );

    renewal.stop();
    scheduleSpy.mockRestore();
  });

  it("re-arms from each new hello without stacking timers", () => {
    const renew = vi.fn();
    const renewal = createControlUiCredentialRenewal({ renew });
    const first = mintCredential(CONNECT_AT_MS);
    renewal.arm(serveHello(first));
    renewal.arm(serveHello(first));
    renewal.arm(serveHello(mintCredential(CONNECT_AT_MS)));

    vi.advanceTimersByTime(PAST_ANY_DEADLINE_MS);

    expect(renew).toHaveBeenCalledTimes(1);

    renewal.stop();
  });

  it("goes inert for a lane the Gateway mints no credential for", () => {
    const renew = vi.fn();
    const renewal = createControlUiCredentialRenewal({ renew });

    renewal.arm({ hello: { auth: { deviceToken: "device-token" } } });
    renewal.arm({ settings: { token: "shared-token" } });
    vi.advanceTimersByTime(PAST_ANY_DEADLINE_MS);

    // A paired device browser and a shared-secret session never had a timed
    // reconnect, and must not acquire one here.
    expect(renew).not.toHaveBeenCalled();
  });

  it("drops a pending renewal on teardown", () => {
    const renew = vi.fn();
    const renewal = createControlUiCredentialRenewal({ renew });
    renewal.arm(serveHello(mintCredential(CONNECT_AT_MS)));

    renewal.stop();
    vi.advanceTimersByTime(PAST_ANY_DEADLINE_MS);

    expect(renew).not.toHaveBeenCalled();
  });

  it("stops arming once a hello carries no credential", () => {
    const renew = vi.fn();
    const renewal = createControlUiCredentialRenewal({ renew });
    renewal.arm(serveHello(mintCredential(CONNECT_AT_MS)));
    renewal.arm({ hello: { auth: { deviceToken: "device-token" } } });

    vi.advanceTimersByTime(PAST_ANY_DEADLINE_MS);

    expect(renew).not.toHaveBeenCalled();
  });
});

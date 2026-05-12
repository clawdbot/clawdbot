import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCdpReachabilityPolicy } from "./cdp-reachability-policy.js";
import {
  PROFILE_HTTP_REACHABILITY_TIMEOUT_MS,
  PROFILE_WS_REACHABILITY_MAX_TIMEOUT_MS,
  PROFILE_WS_REACHABILITY_MIN_TIMEOUT_MS,
  resolveCdpReachabilityTimeouts,
} from "./cdp-timeouts.js";
import type { ResolvedBrowserProfile } from "./config.js";
import { assertBrowserNavigationAllowed } from "./navigation-guard.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: (...args: unknown[]) => fetchWithSsrFGuardMock(...args),
  };
});

import { assertCdpEndpointAllowed, fetchJson, fetchOk } from "./cdp.helpers.js";

describe("cdp helpers", () => {
  afterEach(() => {
    fetchWithSsrFGuardMock.mockReset();
  });

  function requireGuardedFetchRequest() {
    const [call] = fetchWithSsrFGuardMock.mock.calls;
    if (!call) {
      throw new Error("expected guarded CDP fetch call");
    }
    const [request] = call;
    return request;
  }

  it("releases guarded CDP fetches after the response body is consumed", async () => {
    const release = vi.fn(async () => {});
    const json = vi.fn(async () => {
      expect(release).not.toHaveBeenCalled();
      return { ok: true };
    });
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: {
        ok: true,
        status: 200,
        json,
      },
      release,
    });

    await expect(
      fetchJson("http://127.0.0.1:9222/json/version", 250, undefined, {
        dangerouslyAllowPrivateNetwork: false,
        allowedHostnames: ["127.0.0.1"],
      }),
    ).resolves.toEqual({ ok: true });

    expect(json).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("allows loopback CDP endpoints in strict SSRF mode", async () => {
    await expect(
      assertCdpEndpointAllowed("http://127.0.0.1:9222/json/version", {
        dangerouslyAllowPrivateNetwork: false,
      }),
    ).resolves.toBeUndefined();
  });

  it("still enforces hostname allowlist for loopback CDP endpoints", async () => {
    await expect(
      assertCdpEndpointAllowed("http://127.0.0.1:9222/json/version", {
        dangerouslyAllowPrivateNetwork: false,
        hostnameAllowlist: ["*.corp.example"],
      }),
    ).rejects.toThrow("browser endpoint blocked by policy");
  });

  it("releases guarded CDP fetches for bodyless requests", async () => {
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: {
        ok: true,
        status: 200,
      },
      release,
    });

    await expect(
      fetchOk("http://127.0.0.1:9222/json/close/TARGET_1", 250, undefined, {
        dangerouslyAllowPrivateNetwork: false,
        allowedHostnames: ["127.0.0.1"],
      }),
    ).resolves.toBeUndefined();

    expect(release).toHaveBeenCalledTimes(1);
  });

  it("uses an exact loopback allowlist for guarded loopback CDP fetches", async () => {
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: {
        ok: true,
        status: 200,
      },
      release,
    });

    await expect(
      fetchOk("http://127.0.0.1:9222/json/version", 250, undefined, {
        dangerouslyAllowPrivateNetwork: false,
      }),
    ).resolves.toBeUndefined();

    const request = requireGuardedFetchRequest();
    expect(request?.url).toBe("http://127.0.0.1:9222/json/version");
    expect(request?.policy).toEqual({
      dangerouslyAllowPrivateNetwork: false,
      allowedHostnames: ["127.0.0.1"],
    });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("sends URL credentials as an auth header for guarded CDP fetches", async () => {
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: {
        ok: true,
        status: 200,
      },
      release,
    });

    await expect(
      fetchOk("http://openclaw:relay-token@127.0.0.1:9222/json/version", 250),
    ).resolves.toBeUndefined();

    const request = requireGuardedFetchRequest();
    expect(request?.url).toBe("http://127.0.0.1:9222/json/version");
    expect(request?.init?.headers).toEqual({
      Authorization: "Basic b3BlbmNsYXc6cmVsYXktdG9rZW4=",
    });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("preserves hostname allowlist while allowing exact loopback CDP fetches", async () => {
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: {
        ok: true,
        status: 200,
      },
      release,
    });

    await expect(
      fetchOk("http://127.0.0.1:9222/json/version", 250, undefined, {
        dangerouslyAllowPrivateNetwork: false,
        hostnameAllowlist: ["*.corp.example"],
      }),
    ).resolves.toBeUndefined();

    const request = requireGuardedFetchRequest();
    expect(request?.url).toBe("http://127.0.0.1:9222/json/version");
    expect(request?.policy).toEqual({
      dangerouslyAllowPrivateNetwork: false,
      hostnameAllowlist: ["*.corp.example"],
      allowedHostnames: ["127.0.0.1"],
    });
    expect(release).toHaveBeenCalledTimes(1);
  });
});

function createProfile(overrides: Partial<ResolvedBrowserProfile>): ResolvedBrowserProfile {
  return {
    name: "remote",
    cdpPort: 9223,
    cdpUrl: "http://172.29.128.1:9223",
    cdpHost: "172.29.128.1",
    cdpIsLoopback: false,
    color: "#123456",
    driver: "openclaw",
    attachOnly: false,
    ...overrides,
    headless: overrides.headless ?? false,
  };
}

describe("resolveCdpReachabilityTimeouts", () => {
  it("uses loopback defaults when timeout is omitted", () => {
    expect(
      resolveCdpReachabilityTimeouts({
        profileIsLoopback: true,
        timeoutMs: undefined,
        remoteHttpTimeoutMs: 1500,
        remoteHandshakeTimeoutMs: 3000,
      }),
    ).toEqual({
      httpTimeoutMs: PROFILE_HTTP_REACHABILITY_TIMEOUT_MS,
      wsTimeoutMs: PROFILE_HTTP_REACHABILITY_TIMEOUT_MS * 2,
    });
  });

  it("clamps loopback websocket timeout range", () => {
    const low = resolveCdpReachabilityTimeouts({
      profileIsLoopback: true,
      timeoutMs: 1,
      remoteHttpTimeoutMs: 1500,
      remoteHandshakeTimeoutMs: 3000,
    });
    const high = resolveCdpReachabilityTimeouts({
      profileIsLoopback: true,
      timeoutMs: 5000,
      remoteHttpTimeoutMs: 1500,
      remoteHandshakeTimeoutMs: 3000,
    });

    expect(low.wsTimeoutMs).toBe(PROFILE_WS_REACHABILITY_MIN_TIMEOUT_MS);
    expect(high.wsTimeoutMs).toBe(PROFILE_WS_REACHABILITY_MAX_TIMEOUT_MS);
  });

  it("enforces remote minimums even when caller passes lower timeout", () => {
    expect(
      resolveCdpReachabilityTimeouts({
        profileIsLoopback: false,
        timeoutMs: 200,
        remoteHttpTimeoutMs: 1500,
        remoteHandshakeTimeoutMs: 3000,
      }),
    ).toEqual({
      httpTimeoutMs: 1500,
      wsTimeoutMs: 3000,
    });
  });

  it("uses remote defaults when timeout is omitted", () => {
    expect(
      resolveCdpReachabilityTimeouts({
        profileIsLoopback: false,
        timeoutMs: undefined,
        remoteHttpTimeoutMs: 1750,
        remoteHandshakeTimeoutMs: 3250,
      }),
    ).toEqual({
      httpTimeoutMs: 1750,
      wsTimeoutMs: 3250,
    });
  });
});

describe("CDP reachability policy", () => {
  it("allows the selected remote profile CDP host without widening browser navigation policy", async () => {
    const browserPolicy = {};
    const profile = createProfile({});

    expect(resolveCdpReachabilityPolicy(profile, browserPolicy)).toEqual({
      allowedHostnames: ["172.29.128.1"],
    });
    expect(browserPolicy).toStrictEqual({});
    await expect(
      assertBrowserNavigationAllowed({
        url: "http://172.29.128.1/",
        ssrfPolicy: browserPolicy,
      }),
    ).rejects.toThrow(/private\/internal\/special-use ip address/i);
  });

  it("merges the selected remote profile CDP host with existing CDP policy hostnames", () => {
    const profile = createProfile({});

    expect(
      resolveCdpReachabilityPolicy(profile, {
        allowedHostnames: ["metadata.internal"],
      }),
    ).toEqual({
      allowedHostnames: ["metadata.internal", "172.29.128.1"],
    });
  });

  it("keeps local managed loopback CDP control outside browser SSRF policy", () => {
    const profile = createProfile({
      cdpUrl: "http://127.0.0.1:18800",
      cdpHost: "127.0.0.1",
      cdpIsLoopback: true,
    });

    expect(resolveCdpReachabilityPolicy(profile, {})).toBeUndefined();
  });
});

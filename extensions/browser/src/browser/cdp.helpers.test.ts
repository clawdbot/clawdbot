// Browser tests cover cdp.helpers plugin behavior.
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCdpReachabilityPolicy } from "./cdp-reachability-policy.js";
import { resolveCdpReachabilityTimeouts } from "./cdp-timeouts.js";
import type { ResolvedBrowserProfile } from "./config.js";
import { assertBrowserNavigationAllowed } from "./navigation-guard.js";

const PROFILE_HTTP_REACHABILITY_TIMEOUT_MS = 300;
const PROFILE_WS_REACHABILITY_MIN_TIMEOUT_MS = 200;
const PROFILE_WS_REACHABILITY_MAX_TIMEOUT_MS = 2000;

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: (...args: unknown[]) => fetchWithSsrFGuardMock(...args),
  };
});

import {
  assertCdpEndpointAllowed,
  fetchJson,
  fetchOk,
  resolveCdpTabOwnership,
  scopeCdpPolicyToConfiguredEndpoint,
} from "./cdp.helpers.js";

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
    const arrayBuffer = vi.fn(async () => {
      expect(release).not.toHaveBeenCalled();
      return new TextEncoder().encode(JSON.stringify({ ok: true })).buffer;
    });
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: {
        ok: true,
        status: 200,
        body: null,
        arrayBuffer,
      },
      release,
    });

    await expect(
      fetchJson("http://127.0.0.1:9222/json/version", 250, undefined, {
        dangerouslyAllowPrivateNetwork: false,
        allowedHostnames: ["127.0.0.1"],
      }),
    ).resolves.toEqual({ ok: true });

    expect(arrayBuffer).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized CDP JSON responses before parsing", async () => {
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(new Uint8Array(16 * 1024 * 1024 + 1)),
      release,
    });

    await expect(fetchJson("http://127.0.0.1:9222/json/version")).rejects.toThrow(
      "cdp-json: JSON response exceeds 16777216 bytes",
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("allows loopback CDP endpoints in strict SSRF mode", async () => {
    await expect(
      assertCdpEndpointAllowed("http://127.0.0.1:9222/json/version", {
        dangerouslyAllowPrivateNetwork: false,
      }),
    ).resolves.toBeUndefined();
  });

  it("adds exact loopback hosts to the CDP hostname allowlist", async () => {
    await expect(
      assertCdpEndpointAllowed("http://127.0.0.1:9222/json/version", {
        dangerouslyAllowPrivateNetwork: false,
        hostnameAllowlist: ["*.corp.example"],
      }),
    ).resolves.toBeUndefined();
  });

  it("still enforces hostname allowlist for non-loopback CDP endpoints", async () => {
    await expect(
      assertCdpEndpointAllowed("http://172.29.128.1:9222/json/version", {
        dangerouslyAllowPrivateNetwork: false,
        hostnameAllowlist: ["*.corp.example"],
      }),
    ).rejects.toThrow("browser endpoint blocked by policy");
  });

  it("does not let a returned loopback URL replace an exact remote CDP host", async () => {
    await expect(
      assertCdpEndpointAllowed(
        "ws://127.0.0.1:9222/devtools/browser/remote",
        {
          allowPrivateNetwork: true,
          allowedHostnames: ["browserless.example.com"],
          hostnameAllowlist: ["browserless.example.com"],
        },
        {
          source: "discovered",
          configuredUrl: "wss://browserless.example.com:9222",
        },
      ),
    ).rejects.toThrow("browser endpoint blocked by policy");
  });

  it("allows a discovered endpoint on the configured loopback CDP host", async () => {
    const policy = scopeCdpPolicyToConfiguredEndpoint("http://127.0.0.1:9222", {});
    await expect(
      assertCdpEndpointAllowed("ws://127.0.0.1:9222/devtools/browser/local", policy, {
        source: "discovered",
        configuredUrl: "http://127.0.0.1:9222",
      }),
    ).resolves.toBeUndefined();
  });

  it("blocks a discovered endpoint on another port in strict SSRF mode", async () => {
    const policy = scopeCdpPolicyToConfiguredEndpoint("http://127.0.0.1:9222", {});
    await expect(
      assertCdpEndpointAllowed("ws://127.0.0.1:22/devtools/browser/local", policy, {
        source: "discovered",
        configuredUrl: "http://127.0.0.1:9222",
      }),
    ).rejects.toThrow("browser endpoint blocked by policy");
  });

  it("still grants configured loopback for same-shaped strict navigation policy", async () => {
    await expect(
      assertCdpEndpointAllowed("http://127.0.0.1:9222/json/version", {
        allowedHostnames: ["api.example.com"],
        hostnameAllowlist: ["api.example.com"],
      }),
    ).resolves.toBeUndefined();
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
      hostnameAllowlist: ["127.0.0.1"],
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

  it("threads caller abort and strict CDP policy through browser identity lookup", async () => {
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(
        JSON.stringify({
          webSocketDebuggerUrl: "wss://1.1.1.1/devtools/browser/BROWSER-1",
        }),
        { headers: { "content-type": "application/json" } },
      ),
      release,
    });
    const controller = new AbortController();
    const policy = {
      dangerouslyAllowPrivateNetwork: false,
      hostnameAllowlist: ["1.1.1.1"],
    };
    const resolveOwnership = resolveCdpTabOwnership as unknown as (params: {
      profileName: string;
      cdpUrl: string;
      nativeTargetId: string;
      timeoutMs: number;
      signal: AbortSignal;
      ssrfPolicy: typeof policy;
    }) => ReturnType<typeof resolveCdpTabOwnership>;

    await expect(
      resolveOwnership({
        profileName: "remote",
        cdpUrl: "https://1.1.1.1",
        nativeTargetId: "TARGET-1",
        timeoutMs: 4321,
        signal: controller.signal,
        ssrfPolicy: policy,
      }),
    ).resolves.toMatchObject({ status: "durable", nativeTargetId: "TARGET-1" });

    const request = requireGuardedFetchRequest();
    expect(request.policy).toBe(policy);
    expect(request.signal).not.toBe(controller.signal);
    controller.abort(new Error("caller stopped ownership lookup"));
    expect(request.signal.aborted).toBe(true);
    expect(release).toHaveBeenCalledOnce();
  });

  it("classifies browser identity network failures without hiding caller aborts", async () => {
    fetchWithSsrFGuardMock.mockRejectedValueOnce(new Error("version lookup timed out"));
    await expect(
      resolveCdpTabOwnership({
        profileName: "remote",
        cdpUrl: "https://browser.example",
        nativeTargetId: "TARGET-1",
      }),
    ).resolves.toEqual({
      status: "non-durable",
      reason: "browser-identity-lookup-failed",
    });

    const controller = new AbortController();
    const abortError = new Error("caller stopped ownership lookup");
    fetchWithSsrFGuardMock.mockImplementationOnce(
      async ({ signal }: { signal: AbortSignal }) =>
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () =>
              reject(
                signal.reason instanceof Error
                  ? signal.reason
                  : new Error("ownership lookup aborted"),
              ),
            { once: true },
          );
        }),
    );
    const resolveOwnership = resolveCdpTabOwnership as unknown as (params: {
      profileName: string;
      cdpUrl: string;
      nativeTargetId: string;
      signal: AbortSignal;
    }) => ReturnType<typeof resolveCdpTabOwnership>;
    const pending = resolveOwnership({
      profileName: "remote",
      cdpUrl: "https://browser.example",
      nativeTargetId: "TARGET-1",
      signal: controller.signal,
    });
    controller.abort(abortError);

    await expect(pending).rejects.toBe(abortError);
  });

  it("decodes URL credentials before sending guarded CDP auth headers", async () => {
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: {
        ok: true,
        status: 200,
      },
      release,
    });

    await expect(
      fetchOk("http://alice:p%40ss%20word@127.0.0.1:9222/json/version", 250),
    ).resolves.toBeUndefined();

    const request = requireGuardedFetchRequest();
    expect(request?.url).toBe("http://127.0.0.1:9222/json/version");
    expect(request?.init?.headers).toEqual({
      Authorization: `Basic ${Buffer.from("alice:p@ss word").toString("base64")}`,
    });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("replaces navigation grants with the exact loopback CDP host", async () => {
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
      hostnameAllowlist: ["127.0.0.1"],
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

  it("caps remote reachability timeouts to timer-safe values", () => {
    expect(
      resolveCdpReachabilityTimeouts({
        profileIsLoopback: false,
        timeoutMs: Number.MAX_SAFE_INTEGER,
        remoteHttpTimeoutMs: Number.MAX_SAFE_INTEGER,
        remoteHandshakeTimeoutMs: Number.MAX_SAFE_INTEGER,
      }),
    ).toEqual({
      httpTimeoutMs: MAX_TIMER_TIMEOUT_MS,
      wsTimeoutMs: MAX_TIMER_TIMEOUT_MS,
    });
  });
});

describe("CDP reachability policy", () => {
  it("allows the selected remote profile CDP host without widening browser navigation policy", async () => {
    const browserPolicy = {};
    const profile = createProfile({});

    expect(resolveCdpReachabilityPolicy(profile, browserPolicy)).toEqual({
      allowedHostnames: ["172.29.128.1"],
      hostnameAllowlist: ["172.29.128.1"],
    });
    expect(browserPolicy).toStrictEqual({});
    await expect(
      assertBrowserNavigationAllowed({
        url: "http://172.29.128.1/",
        ssrfPolicy: browserPolicy,
      }),
    ).rejects.toThrow(/private\/internal\/special-use ip address/i);
  });

  it("restricts remote CDP policy to the selected profile host", () => {
    const profile = createProfile({});

    expect(
      resolveCdpReachabilityPolicy(profile, {
        allowedHostnames: ["metadata.internal"],
      }),
    ).toEqual({
      allowedHostnames: ["172.29.128.1"],
      hostnameAllowlist: ["172.29.128.1"],
    });
  });

  it("narrows permissive private-network policy to the selected CDP host", () => {
    const profile = createProfile({});
    const browserPolicy = {
      allowPrivateNetwork: true,
      allowedHostnames: ["metadata.internal"],
      allowedOrigins: ["https://navigation.example"],
    };

    expect(resolveCdpReachabilityPolicy(profile, browserPolicy)).toEqual({
      allowPrivateNetwork: true,
      allowedHostnames: ["172.29.128.1"],
      hostnameAllowlist: ["172.29.128.1"],
    });
    expect(browserPolicy).toStrictEqual({
      allowPrivateNetwork: true,
      allowedHostnames: ["metadata.internal"],
      allowedOrigins: ["https://navigation.example"],
    });
  });

  it("preserves a restrictive hostname allowlist that rejects the remote CDP host", async () => {
    const profile = createProfile({});
    const browserPolicy = { hostnameAllowlist: ["browserless.example.com"] };

    expect(resolveCdpReachabilityPolicy(profile, browserPolicy)).toBe(browserPolicy);
    expect(browserPolicy).toStrictEqual({ hostnameAllowlist: ["browserless.example.com"] });
    await expect(
      assertBrowserNavigationAllowed({
        url: "http://172.29.128.1/",
        ssrfPolicy: browserPolicy,
      }),
    ).rejects.toThrow(/not in allowlist/i);
  });

  it("narrows an allowlisted remote CDP host to that exact control host", () => {
    const profile = createProfile({});

    expect(
      resolveCdpReachabilityPolicy(profile, {
        hostnameAllowlist: ["browserless.example.com", "172.29.128.1"],
        allowedOrigins: ["https://navigation.example"],
      }),
    ).toEqual({
      hostnameAllowlist: ["172.29.128.1"],
      allowedHostnames: ["172.29.128.1"],
    });
  });

  it("normalizes the selected CDP host before narrowing wildcard policy", () => {
    const profile = createProfile({
      cdpUrl: "https://browser.corp.example.:9222",
      cdpHost: "browser.corp.example.",
    });

    expect(
      resolveCdpReachabilityPolicy(profile, {
        hostnameAllowlist: ["*.corp.example"],
      }),
    ).toEqual({
      hostnameAllowlist: ["browser.corp.example"],
      allowedHostnames: ["browser.corp.example"],
    });
  });

  it.each(["*", "*."])("narrows the global %s allowlist to the selected CDP host", (pattern) => {
    const profile = createProfile({
      cdpUrl: "https://browser.example:9222",
      cdpHost: "browser.example",
    });

    expect(resolveCdpReachabilityPolicy(profile, { hostnameAllowlist: [pattern] })).toEqual({
      hostnameAllowlist: ["browser.example"],
      allowedHostnames: ["browser.example"],
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

  it("narrows configured extension loopback outside navigation allowlist", () => {
    const profile = createProfile({
      cdpUrl: "http://127.0.0.1:18792",
      cdpHost: "127.0.0.1",
      cdpIsLoopback: true,
      driver: "extension",
    });

    expect(
      resolveCdpReachabilityPolicy(profile, {
        hostnameAllowlist: ["*.corp.example"],
      }),
    ).toEqual({
      hostnameAllowlist: ["127.0.0.1"],
      allowedHostnames: ["127.0.0.1"],
    });
  });
});

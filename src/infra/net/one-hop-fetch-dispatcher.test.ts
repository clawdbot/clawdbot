import { describe, expect, it, vi } from "vitest";
import {
  NETWORK_GUARD_PROFILE_VERSION,
  type NetworkGuardProfileV1,
} from "./network-guard-profile.js";
import { createLocalOneHopFetchDispatcher } from "./one-hop-fetch-dispatcher.js";

function createNetworkGuard(
  resolution: NetworkGuardProfileV1["route"]["resolution"] = "caller",
): NetworkGuardProfileV1 {
  return {
    version: NETWORK_GUARD_PROFILE_VERSION,
    target: {
      protocol: "https:",
      origin: "https://public.example",
      hostname: "public.example",
      port: 443,
    },
    route: { mode: "direct", resolution, tls: "required" },
    addressPolicy: {
      mode: "public-only",
      trustedHostnames: [],
      hostnameAllowlist: [],
      allowedPrivateCidrs: [],
      allowRfc2544BenchmarkRange: false,
      allowIpv6UniqueLocalRange: false,
      dnsRebinding: {
        policy: "reject",
        enforcement:
          resolution === "pinned"
            ? "local-pinned"
            : resolution === "proxy"
              ? "connection-owner-required"
              : "not-enforced",
      },
    },
  };
}

describe("createLocalOneHopFetchDispatcher", () => {
  it("delegates one manual-redirect exchange and preserves HTTP responses", async () => {
    const response = new Response("rate limited", { status: 429 });
    const fetchImpl = vi.fn().mockResolvedValue(response);
    const dispatcher = createLocalOneHopFetchDispatcher(fetchImpl);
    const signal = new AbortController().signal;

    await expect(
      dispatcher.dispatch({
        url: "https://public.example/resource",
        init: {
          method: "POST",
          redirect: "manual",
          signal,
        },
        networkGuard: createNetworkGuard(),
      }),
    ).resolves.toBe(response);
    expect(fetchImpl).toHaveBeenCalledWith("https://public.example/resource", {
      method: "POST",
      redirect: "manual",
      signal,
    });
  });

  it("propagates transport failures unchanged", async () => {
    const transportError = new Error("socket closed");
    const dispatcher = createLocalOneHopFetchDispatcher(vi.fn().mockRejectedValue(transportError));

    await expect(
      dispatcher.dispatch({
        url: "https://public.example/resource",
        init: { redirect: "manual" },
        networkGuard: createNetworkGuard(),
      }),
    ).rejects.toBe(transportError);
  });

  it("keeps local dispatcher state outside the portable request", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok"));
    const dispatcher = createLocalOneHopFetchDispatcher(fetchImpl, {
      hasPreparedDispatcher: true,
    });
    const request = {
      url: "https://public.example/resource",
      init: { redirect: "manual" as const },
      networkGuard: createNetworkGuard("pinned"),
    };

    await dispatcher.dispatch(request);

    expect(request.init).toEqual({ redirect: "manual" });
    expect(fetchImpl).toHaveBeenCalledWith(request.url, request.init);
  });
});

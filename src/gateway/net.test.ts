import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeNetworkInterfacesSnapshot } from "../test-helpers/network-interfaces.js";
import {
  __resetContainerCacheForTest,
  defaultGatewayBindMode,
  isContainerEnvironment,
  isLocalishHost,
  isLoopbackHost,
  isPrivateOrLoopbackAddress,
  isPrivateOrLoopbackHost,
  isSecureWebSocketUrl,
  isTrustedProxyAddress,
  pickPrimaryLanIPv4,
  resolveClientIp,
  resolveGatewayBindHost,
  resolveGatewayListenHosts,
  resolveHostName,
} from "./net.js";

const flyMachineEnvKeys = ["FLY_MACHINE_ID", "FLY_APP_NAME"] as const;

function clearFlyMachineEnvForTest(): () => void {
  const previousEnv = new Map<(typeof flyMachineEnvKeys)[number], string | undefined>();
  for (const key of flyMachineEnvKeys) {
    previousEnv.set(key, process.env[key]);
    delete process.env[key];
  }

  return () => {
    for (const key of flyMachineEnvKeys) {
      const value = previousEnv.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

function useClearedFlyMachineEnv() {
  let restoreFlyMachineEnv: (() => void) | undefined;

  beforeEach(() => {
    restoreFlyMachineEnv = clearFlyMachineEnvForTest();
  });

  afterEach(() => {
    restoreFlyMachineEnv?.();
    restoreFlyMachineEnv = undefined;
  });
}

describe("resolveHostName", () => {
  it.each([
    { input: "localhost:18789", expected: "localhost" },
    { input: "127.0.0.1:18789", expected: "127.0.0.1" },
    { input: "[::1]:18789", expected: "::1" },
    { input: "::1", expected: "::1" },
  ] as const)("normalizes host form for $input", ({ input, expected }) => {
    expect(resolveHostName(input), input).toBe(expected);
  });
});

describe("isLocalishHost", () => {
  it("accepts loopback and tailscale serve/funnel host headers", () => {
    const accepted = [
      "localhost",
      "localhost.:18789",
      "127.0.0.1:18789",
      "[::1]:18789",
      "[::ffff:127.0.0.1]:18789",
      "gateway.tailnet.ts.net",
    ];
    for (const host of accepted) {
      expect(isLocalishHost(host), host).toBe(true);
    }
  });

  it("rejects non-local hosts", () => {
    const rejected = ["example.com", "192.168.1.10", "203.0.113.5:18789"];
    for (const host of rejected) {
      expect(isLocalishHost(host), host).toBe(false);
    }
  });
});

describe("isLoopbackHost", () => {
  it("accepts localhost absolute-form hostnames", () => {
    expect(isLoopbackHost("localhost.")).toBe(true);
    expect(isLoopbackHost("LOCALHOST...")).toBe(true);
  });
});

describe("isTrustedProxyAddress", () => {
  it.each([
    {
      name: "matches exact IP entries",
      ip: "192.168.1.1",
      trustedProxies: ["192.168.1.1"],
      expected: true,
    },
    {
      name: "rejects non-matching exact IP entries",
      ip: "192.168.1.2",
      trustedProxies: ["192.168.1.1"],
      expected: false,
    },
    {
      name: "matches one of multiple exact entries",
      ip: "10.0.0.5",
      trustedProxies: ["192.168.1.1", "10.0.0.5", "172.16.0.1"],
      expected: true,
    },
    {
      name: "ignores surrounding whitespace in exact IP entries",
      ip: "10.0.0.5",
      trustedProxies: [" 10.0.0.5 "],
      expected: true,
    },
    {
      name: "matches /24 CIDR entries",
      ip: "10.42.0.59",
      trustedProxies: ["10.42.0.0/24"],
      expected: true,
    },
    {
      name: "rejects IPs outside /24 CIDR entries",
      ip: "10.42.1.1",
      trustedProxies: ["10.42.0.0/24"],
      expected: false,
    },
    {
      name: "matches /16 CIDR entries",
      ip: "172.19.255.255",
      trustedProxies: ["172.19.0.0/16"],
      expected: true,
    },
    {
      name: "rejects IPs outside /16 CIDR entries",
      ip: "172.20.0.1",
      trustedProxies: ["172.19.0.0/16"],
      expected: false,
    },
    {
      name: "treats /32 as a single-IP CIDR",
      ip: "10.42.0.0",
      trustedProxies: ["10.42.0.0/32"],
      expected: true,
    },
    {
      name: "rejects non-matching /32 CIDR entries",
      ip: "10.42.0.1",
      trustedProxies: ["10.42.0.0/32"],
      expected: false,
    },
    {
      name: "handles mixed exact IP and CIDR entries",
      ip: "172.19.5.100",
      trustedProxies: ["192.168.1.1", "10.42.0.0/24", "172.19.0.0/16"],
      expected: true,
    },
    {
      name: "rejects IPs missing from mixed exact IP and CIDR entries",
      ip: "10.43.0.1",
      trustedProxies: ["192.168.1.1", "10.42.0.0/24", "172.19.0.0/16"],
      expected: false,
    },
    {
      name: "supports IPv6 CIDR notation",
      ip: "2001:db8::1234",
      trustedProxies: ["2001:db8::/32"],
      expected: true,
    },
    {
      name: "rejects IPv6 addresses outside the configured CIDR",
      ip: "2001:db9::1234",
      trustedProxies: ["2001:db8::/32"],
      expected: false,
    },
    {
      name: "preserves exact matching behavior for plain IP entries",
      ip: "10.42.0.59",
      trustedProxies: ["10.42.0.1"],
      expected: false,
    },
    {
      name: "normalizes IPv4-mapped IPv6 addresses",
      ip: "::ffff:192.168.1.1",
      trustedProxies: ["192.168.1.1"],
      expected: true,
    },
    {
      name: "returns false when IP is undefined",
      ip: undefined,
      trustedProxies: ["192.168.1.1"],
      expected: false,
    },
    {
      name: "returns false when trusted proxies are undefined",
      ip: "192.168.1.1",
      trustedProxies: undefined,
      expected: false,
    },
    {
      name: "returns false when trusted proxies are empty",
      ip: "192.168.1.1",
      trustedProxies: [],
      expected: false,
    },
    {
      name: "rejects invalid CIDR prefixes and addresses",
      ip: "10.42.0.59",
      trustedProxies: ["10.42.0.0/33", "10.42.0.0/-1", "invalid/24", "2001:db8::/129"],
      expected: false,
    },
    {
      name: "ignores surrounding whitespace in CIDR entries",
      ip: "10.42.0.59",
      trustedProxies: [" 10.42.0.0/24 "],
      expected: true,
    },
    {
      name: "ignores blank trusted proxy entries",
      ip: "10.0.0.5",
      trustedProxies: [" ", "10.0.0.5", ""],
      expected: true,
    },
    {
      name: "treats all-blank trusted proxy entries as no match",
      ip: "10.0.0.5",
      trustedProxies: [" ", "\t"],
      expected: false,
    },
  ])("$name", ({ ip, trustedProxies, expected }) => {
    expect(isTrustedProxyAddress(ip, trustedProxies)).toBe(expected);
  });
});

describe("resolveClientIp", () => {
  it.each([
    {
      name: "returns remote IP when remote is not trusted proxy",
      remoteAddr: "203.0.113.10",
      forwardedFor: "10.0.0.2",
      trustedProxies: ["127.0.0.1"],
      expected: "203.0.113.10",
    },
    {
      name: "uses right-most untrusted X-Forwarded-For hop",
      remoteAddr: "127.0.0.1",
      forwardedFor: "198.51.100.99, 10.0.0.9, 127.0.0.1",
      trustedProxies: ["127.0.0.1"],
      expected: "10.0.0.9",
    },
    {
      name: "ignores spoofed loopback X-Forwarded-For hops from trusted proxies",
      remoteAddr: "10.0.0.50",
      forwardedFor: "127.0.0.1",
      trustedProxies: ["10.0.0.0/8"],
      expected: undefined,
    },
    {
      name: "fails closed when all X-Forwarded-For hops are trusted proxies",
      remoteAddr: "127.0.0.1",
      forwardedFor: "127.0.0.1, ::1",
      trustedProxies: ["127.0.0.1", "::1"],
      expected: undefined,
    },
    {
      name: "fails closed when all non-loopback X-Forwarded-For hops are trusted proxies",
      remoteAddr: "10.0.0.50",
      forwardedFor: "10.0.0.2, 10.0.0.1",
      trustedProxies: ["10.0.0.0/8"],
      expected: undefined,
    },
    {
      name: "fails closed when trusted proxy omits forwarding headers",
      remoteAddr: "127.0.0.1",
      trustedProxies: ["127.0.0.1"],
      expected: undefined,
    },
    {
      name: "ignores invalid X-Forwarded-For entries",
      remoteAddr: "127.0.0.1",
      forwardedFor: "garbage, 10.0.0.999",
      trustedProxies: ["127.0.0.1"],
      expected: undefined,
    },
    {
      name: "does not trust X-Real-IP by default",
      remoteAddr: "127.0.0.1",
      realIp: "[2001:db8::5]",
      trustedProxies: ["127.0.0.1"],
      expected: undefined,
    },
    {
      name: "uses X-Real-IP only when explicitly enabled",
      remoteAddr: "127.0.0.1",
      realIp: "[2001:db8::5]",
      trustedProxies: ["127.0.0.1"],
      allowRealIpFallback: true,
      expected: "2001:db8::5",
    },
    {
      name: "ignores invalid X-Real-IP even when fallback enabled",
      remoteAddr: "127.0.0.1",
      realIp: "not-an-ip",
      trustedProxies: ["127.0.0.1"],
      allowRealIpFallback: true,
      expected: undefined,
    },
  ])("$name", (testCase) => {
    const ip = resolveClientIp({
      remoteAddr: testCase.remoteAddr,
      forwardedFor: testCase.forwardedFor,
      realIp: testCase.realIp,
      trustedProxies: testCase.trustedProxies,
      allowRealIpFallback: testCase.allowRealIpFallback,
    });
    expect(ip).toBe(testCase.expected);
  });
});

describe("resolveGatewayListenHosts", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    {
      name: "non-loopback host passthrough",
      host: "0.0.0.0",
      canBindToHost: async () => {
        throw new Error("should not be called");
      },
      expected: ["0.0.0.0"],
    },
    {
      name: "loopback with IPv6 available",
      host: "127.0.0.1",
      canBindToHost: async () => true,
      expected: ["127.0.0.1", "::1"],
    },
    {
      name: "loopback with IPv6 unavailable",
      host: "127.0.0.1",
      canBindToHost: async () => false,
      expected: ["127.0.0.1"],
    },
  ] as const)("resolves listen hosts: $name", async ({ host, canBindToHost, expected }) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const hosts = await resolveGatewayListenHosts(host, {
      canBindToHost,
    });
    expect(hosts).toEqual(expected);
  });

  it("skips ::1 on Windows even when IPv6 is bindable", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const canBindToHost = vi.fn().mockResolvedValue(true);
    const hosts = await resolveGatewayListenHosts("127.0.0.1", { canBindToHost });
    expect(hosts).toEqual(["127.0.0.1"]);
    expect(canBindToHost).not.toHaveBeenCalled();
  });

  it("still includes ::1 on non-Windows when IPv6 is bindable", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const canBindToHost = vi.fn().mockResolvedValue(true);
    const hosts = await resolveGatewayListenHosts("127.0.0.1", { canBindToHost });
    expect(hosts).toEqual(["127.0.0.1", "::1"]);
    expect(canBindToHost).toHaveBeenCalledWith("::1");
  });
});

describe("pickPrimaryLanIPv4", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    {
      name: "prefers en0",
      interfaces: makeNetworkInterfacesSnapshot({
        lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
        en0: [{ address: "192.168.1.42", family: "IPv4" }],
      }),
      expected: "192.168.1.42",
    },
    {
      name: "falls back to eth0",
      interfaces: makeNetworkInterfacesSnapshot({
        lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
        eth0: [{ address: "10.0.0.5", family: "IPv4" }],
      }),
      expected: "10.0.0.5",
    },
    {
      name: "falls back to any non-internal interface",
      interfaces: makeNetworkInterfacesSnapshot({
        lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
        wlan0: [{ address: "172.16.0.99", family: "IPv4" }],
      }),
      expected: "172.16.0.99",
    },
    {
      name: "no non-internal interface",
      interfaces: makeNetworkInterfacesSnapshot({
        lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
      }),
      expected: undefined,
    },
  ] as const)(
    "prefers en0, then eth0, then any non-internal IPv4: $name",
    ({ interfaces, expected }) => {
      vi.spyOn(os, "networkInterfaces").mockReturnValue(interfaces);
      expect(pickPrimaryLanIPv4()).toBe(expected);
    },
  );

  it("throws when interface discovery throws", () => {
    vi.spyOn(os, "networkInterfaces").mockImplementation(() => {
      throw new Error("uv_interface_addresses failed");
    });
    expect(() => pickPrimaryLanIPv4()).toThrow("uv_interface_addresses failed");
  });
});

describe("isPrivateOrLoopbackAddress", () => {
  it("accepts loopback, private, link-local, and cgnat ranges", () => {
    const accepted = [
      "127.0.0.1",
      "::1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.254",
      "192.168.0.1",
      "169.254.10.20",
      "100.64.0.1",
      "100.127.255.254",
      "::ffff:100.100.100.100",
      "fc00::1",
      "fd12:3456:789a::1",
      "fe80::1",
      "fe9a::1",
      "febb::1",
    ];
    for (const ip of accepted) {
      expect(isPrivateOrLoopbackAddress(ip)).toBe(true);
    }
  });

  it("rejects public IP addresses", () => {
    const rejected = ["1.1.1.1", "8.8.8.8", "172.32.0.1", "203.0.113.10", "2001:4860:4860::8888"];
    for (const ip of rejected) {
      expect(isPrivateOrLoopbackAddress(ip)).toBe(false);
    }
  });
});

describe("isPrivateOrLoopbackHost", () => {
  it("accepts localhost", () => {
    expect(isPrivateOrLoopbackHost("localhost")).toBe(true);
    expect(isPrivateOrLoopbackHost("localhost.")).toBe(true);
  });

  it("accepts loopback addresses", () => {
    expect(isPrivateOrLoopbackHost("127.0.0.1")).toBe(true);
    expect(isPrivateOrLoopbackHost("::1")).toBe(true);
    expect(isPrivateOrLoopbackHost("[::1]")).toBe(true);
  });

  it("accepts RFC 1918 private addresses", () => {
    expect(isPrivateOrLoopbackHost("10.0.0.5")).toBe(true);
    expect(isPrivateOrLoopbackHost("10.42.1.100")).toBe(true);
    expect(isPrivateOrLoopbackHost("172.16.0.1")).toBe(true);
    expect(isPrivateOrLoopbackHost("172.31.255.254")).toBe(true);
    expect(isPrivateOrLoopbackHost("192.168.1.100")).toBe(true);
  });

  it("accepts CGNAT and link-local addresses", () => {
    expect(isPrivateOrLoopbackHost("100.64.0.1")).toBe(true);
    expect(isPrivateOrLoopbackHost("169.254.10.20")).toBe(true);
  });

  it("accepts IPv6 private addresses", () => {
    expect(isPrivateOrLoopbackHost("[fc00::1]")).toBe(true);
    expect(isPrivateOrLoopbackHost("[fd12:3456:789a::1]")).toBe(true);
    expect(isPrivateOrLoopbackHost("[fe80::1]")).toBe(true);
  });

  it("rejects unspecified IPv6 address (::)", () => {
    expect(isPrivateOrLoopbackHost("[::]")).toBe(false);
    expect(isPrivateOrLoopbackHost("::")).toBe(false);
    expect(isPrivateOrLoopbackHost("0:0::0")).toBe(false);
    expect(isPrivateOrLoopbackHost("[0:0::0]")).toBe(false);
    expect(isPrivateOrLoopbackHost("[0000:0000:0000:0000:0000:0000:0000:0000]")).toBe(false);
  });

  it("rejects multicast IPv6 addresses (ff00::/8)", () => {
    expect(isPrivateOrLoopbackHost("[ff02::1]")).toBe(false);
    expect(isPrivateOrLoopbackHost("[ff05::2]")).toBe(false);
    expect(isPrivateOrLoopbackHost("[ff0e::1]")).toBe(false);
  });

  it("rejects public host addresses", () => {
    expect(isPrivateOrLoopbackHost("1.1.1.1")).toBe(false);
    expect(isPrivateOrLoopbackHost("8.8.8.8")).toBe(false);
    expect(isPrivateOrLoopbackHost("203.0.113.10")).toBe(false);
  });

  it("rejects empty/falsy input", () => {
    expect(isPrivateOrLoopbackHost("")).toBe(false);
  });
});

describe("isContainerEnvironment", () => {
  useClearedFlyMachineEnv();

  afterEach(() => {
    __resetContainerCacheForTest();
    vi.restoreAllMocks();
  });

  it("returns false on a typical non-container host", () => {
    // Mock fs.accessSync to throw (no /.dockerenv) and fs.readFileSync to
    // return a cgroup file without container markers.
    const fs = require("node:fs");
    vi.spyOn(fs, "accessSync").mockImplementation(() => {
      throw new Error("ENOENT");
    });
    vi.spyOn(fs, "readFileSync").mockReturnValue("12:memory:/user.slice/user-1000.slice\n");
    expect(isContainerEnvironment()).toBe(false);
  });

  it("returns true when /.dockerenv exists", () => {
    const fs = require("node:fs");
    vi.spyOn(fs, "accessSync").mockImplementation(() => undefined);
    expect(isContainerEnvironment()).toBe(true);
  });

  it("returns true when /run/.containerenv exists", () => {
    const fs = require("node:fs");
    vi.spyOn(fs, "accessSync").mockImplementation((filePath: unknown) => {
      if (filePath === "/run/.containerenv") {
        return undefined;
      }
      throw new Error("ENOENT");
    });
    expect(isContainerEnvironment()).toBe(true);
  });

  it("returns true on Fly Machines without Docker sentinel files", () => {
    const fs = require("node:fs");
    vi.spyOn(fs, "accessSync").mockImplementation(() => {
      throw new Error("ENOENT");
    });
    vi.spyOn(fs, "readFileSync").mockReturnValue("10:cpuset:/\n9:perf_event:/\n8:memory:/\n0::/\n");

    process.env.FLY_MACHINE_ID = "3d8d5459a03038";
    process.env.FLY_APP_NAME = "openclaw-test";
    expect(isContainerEnvironment()).toBe(true);
  });

  it("returns true when /proc/1/cgroup contains docker marker", () => {
    const fs = require("node:fs");
    vi.spyOn(fs, "accessSync").mockImplementation(() => {
      throw new Error("ENOENT");
    });
    vi.spyOn(fs, "readFileSync").mockReturnValue("12:memory:/docker/abc123def456\n");
    expect(isContainerEnvironment()).toBe(true);
  });

  it("returns true when /proc/1/cgroup contains kubepods marker", () => {
    const fs = require("node:fs");
    vi.spyOn(fs, "accessSync").mockImplementation(() => {
      throw new Error("ENOENT");
    });
    vi.spyOn(fs, "readFileSync").mockReturnValue("11:cpuset:/kubepods/besteffort/pod-abc\n");
    expect(isContainerEnvironment()).toBe(true);
  });

  it("returns true when /proc/1/cgroup contains containerd with container ID", () => {
    const fs = require("node:fs");
    vi.spyOn(fs, "accessSync").mockImplementation(() => {
      throw new Error("ENOENT");
    });
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      "0::/system.slice/containerd/a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2\n",
    );
    expect(isContainerEnvironment()).toBe(true);
  });

  it("returns false when /proc/1/cgroup contains containerd.service (host machine)", () => {
    const fs = require("node:fs");
    vi.spyOn(fs, "accessSync").mockImplementation(() => {
      throw new Error("ENOENT");
    });
    vi.spyOn(fs, "readFileSync").mockReturnValue("0::/system.slice/containerd.service\n");
    expect(isContainerEnvironment()).toBe(false);
  });

  it("returns true for cgroup v2 kubepods.slice path", () => {
    const fs = require("node:fs");
    vi.spyOn(fs, "accessSync").mockImplementation(() => {
      throw new Error("ENOENT");
    });
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      "0::/kubepods.slice/kubepods-burstable.slice/kubepods-burstable-pod123.slice/cri-containerd-abc123.scope\n",
    );
    expect(isContainerEnvironment()).toBe(true);
  });

  it("returns true for cgroup v2 cri-containerd scope path", () => {
    const fs = require("node:fs");
    vi.spyOn(fs, "accessSync").mockImplementation(() => {
      throw new Error("ENOENT");
    });
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      "0::/system.slice/cri-containerd-a1b2c3d4e5f6.scope\n",
    );
    expect(isContainerEnvironment()).toBe(true);
  });

  it("caches the result across calls", () => {
    const fs = require("node:fs");
    const accessSpy = vi.spyOn(fs, "accessSync").mockImplementation(() => undefined);
    expect(isContainerEnvironment()).toBe(true);
    expect(isContainerEnvironment()).toBe(true);
    // accessSync should only be called once due to caching
    expect(accessSpy).toHaveBeenCalledTimes(1);
  });
});

describe("resolveGatewayBindHost", () => {
  useClearedFlyMachineEnv();

  afterEach(() => {
    __resetContainerCacheForTest();
    vi.restoreAllMocks();
  });

  it("returns 127.0.0.1 for loopback mode", async () => {
    expect(await resolveGatewayBindHost("loopback")).toBe("127.0.0.1");
  });

  it("returns 0.0.0.0 for lan mode", async () => {
    expect(await resolveGatewayBindHost("lan")).toBe("0.0.0.0");
  });

  it("returns 127.0.0.1 for auto mode on non-container host", async () => {
    const fs = require("node:fs");
    vi.spyOn(fs, "accessSync").mockImplementation(() => {
      throw new Error("ENOENT");
    });
    vi.spyOn(fs, "readFileSync").mockReturnValue("12:memory:/user.slice\n");
    expect(await resolveGatewayBindHost("auto")).toBe("127.0.0.1");
  });

  it("returns 0.0.0.0 for auto mode inside a container", async () => {
    const fs = require("node:fs");
    vi.spyOn(fs, "accessSync").mockImplementation(() => undefined);
    expect(await resolveGatewayBindHost("auto")).toBe("0.0.0.0");
  });

  it("defaults to loopback when bind is undefined (non-container)", async () => {
    const fs = require("node:fs");
    vi.spyOn(fs, "accessSync").mockImplementation(() => {
      throw new Error("ENOENT");
    });
    vi.spyOn(fs, "readFileSync").mockReturnValue("12:memory:/user.slice\n");
    expect(await resolveGatewayBindHost(undefined)).toBe("127.0.0.1");
  });
});

describe("defaultGatewayBindMode", () => {
  useClearedFlyMachineEnv();

  afterEach(() => {
    __resetContainerCacheForTest();
    vi.restoreAllMocks();
  });

  it("returns loopback on non-container host", () => {
    const fs = require("node:fs");
    vi.spyOn(fs, "accessSync").mockImplementation(() => {
      throw new Error("ENOENT");
    });
    vi.spyOn(fs, "readFileSync").mockReturnValue("12:memory:/user.slice\n");
    expect(defaultGatewayBindMode()).toBe("loopback");
  });

  it("returns auto inside a container", () => {
    const fs = require("node:fs");
    vi.spyOn(fs, "accessSync").mockImplementation(() => undefined);
    expect(defaultGatewayBindMode()).toBe("auto");
  });

  it("returns loopback inside a container when tailscale serve is active", () => {
    const fs = require("node:fs");
    vi.spyOn(fs, "accessSync").mockImplementation(() => undefined);
    expect(defaultGatewayBindMode("serve")).toBe("loopback");
  });

  it("returns loopback inside a container when tailscale funnel is active", () => {
    const fs = require("node:fs");
    vi.spyOn(fs, "accessSync").mockImplementation(() => undefined);
    expect(defaultGatewayBindMode("funnel")).toBe("loopback");
  });

  it("returns auto inside a container when tailscale is off", () => {
    const fs = require("node:fs");
    vi.spyOn(fs, "accessSync").mockImplementation(() => undefined);
    expect(defaultGatewayBindMode("off")).toBe("auto");
  });
});

describe("isSecureWebSocketUrl", () => {
  it.each([
    // wss:// always accepted
    { input: "wss://127.0.0.1:18789", expected: true },
    { input: "wss://localhost:18789", expected: true },
    { input: "wss://remote.example.com:18789", expected: true },
    { input: "wss://192.168.1.100:18789", expected: true },
    // ws:// loopback accepted
    { input: "ws://127.0.0.1:18789", expected: true },
    { input: "ws://localhost:18789", expected: true },
    { input: "ws://[::1]:18789", expected: true },
    { input: "ws://127.0.0.42:18789", expected: true },
    // ws:// private/public remote addresses rejected by default
    { input: "ws://10.0.0.5:18789", expected: false },
    { input: "ws://10.42.1.100:18789", expected: false },
    { input: "ws://172.16.0.1:18789", expected: false },
    { input: "ws://172.31.255.254:18789", expected: false },
    { input: "ws://192.168.1.100:18789", expected: false },
    { input: "ws://169.254.10.20:18789", expected: false },
    { input: "ws://100.64.0.1:18789", expected: false },
    { input: "ws://[fc00::1]:18789", expected: false },
    { input: "ws://[fd12:3456:789a::1]:18789", expected: false },
    { input: "ws://[fe80::1]:18789", expected: false },
    { input: "ws://[::]:18789", expected: false },
    { input: "ws://[ff02::1]:18789", expected: false },
    // ws:// public addresses rejected
    { input: "ws://remote.example.com:18789", expected: false },
    { input: "ws://1.1.1.1:18789", expected: false },
    { input: "ws://8.8.8.8:18789", expected: false },
    { input: "ws://203.0.113.10:18789", expected: false },
    // invalid URLs
    { input: "not-a-url", expected: false },
    { input: "", expected: false },
    { input: "http://127.0.0.1:18789", expected: true },
    { input: "https://127.0.0.1:18789", expected: true },
    { input: "https://remote.example.com:18789", expected: true },
    { input: "http://remote.example.com:18789", expected: false },
  ] as const)("defaults secure websocket behavior for $input", ({ input, expected }) => {
    expect(isSecureWebSocketUrl(input), input).toBe(expected);
  });

  it("allows private ws:// only when opt-in is enabled", () => {
    const allowedWhenOptedIn = [
      "ws://10.0.0.5:18789",
      "http://10.0.0.5:18789",
      "ws://172.16.0.1:18789",
      "ws://192.168.1.100:18789",
      "ws://100.64.0.1:18789",
      "ws://169.254.10.20:18789",
      "ws://[fc00::1]:18789",
      "ws://[fe80::1]:18789",
      "ws://gateway.private.example:18789",
    ];

    for (const input of allowedWhenOptedIn) {
      expect(isSecureWebSocketUrl(input, { allowPrivateWs: true }), input).toBe(true);
    }
  });

  it("still rejects ws:// public IP literals when opt-in is enabled", () => {
    const publicIpWsUrls = ["ws://1.1.1.1:18789", "ws://8.8.8.8:18789", "ws://203.0.113.10:18789"];

    for (const input of publicIpWsUrls) {
      expect(isSecureWebSocketUrl(input, { allowPrivateWs: true }), input).toBe(false);
    }
  });

  it("still rejects non-unicast IPv6 ws:// even when opt-in is enabled", () => {
    const disallowedWhenOptedIn = [
      "ws://[::]:18789",
      "ws://[0:0::0]:18789",
      "ws://[ff02::1]:18789",
    ];

    for (const input of disallowedWhenOptedIn) {
      expect(isSecureWebSocketUrl(input, { allowPrivateWs: true }), input).toBe(false);
    }
  });
});

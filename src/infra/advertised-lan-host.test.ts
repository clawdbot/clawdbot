// Tests route-aware LAN advertisement host selection.
import { describe, expect, it, vi } from "vitest";
import { resolveAdvertisedLanHost } from "./advertised-lan-host.js";
import type { NetworkInterfacesSnapshot } from "./network-interfaces.js";

type ResolveOptions = NonNullable<Parameters<typeof resolveAdvertisedLanHost>[0]>;
type RouteRunner = NonNullable<ResolveOptions["runCommandWithTimeout"]>;

function ipv4(address: string, family: "IPv4" | 4 = "IPv4") {
  return {
    address,
    family,
    internal: false,
    netmask: "255.255.255.0",
    mac: "00:00:00:00:00:00",
    cidr: `${address}/24`,
  };
}

function createRouteRunner(stdout: string, code = 0): RouteRunner {
  return vi.fn(async () => ({
    code,
    stdout,
    stderr: "",
  }));
}

describe("advertised LAN host", () => {
  it("uses the first private IPv4 candidate when route hints are unavailable", async () => {
    const runner = createRouteRunner("");

    await expect(
      resolveAdvertisedLanHost({
        platform: "aix",
        runCommandWithTimeout: runner,
        networkInterfaces: () =>
          ({
            tailscale0: [ipv4("100.64.0.9")],
            bridge: [ipv4("10.37.129.4")],
            ethernet: [ipv4("10.211.55.3", 4)],
            wifi: [ipv4("192.168.1.20")],
          }) as NetworkInterfacesSnapshot,
      }),
    ).resolves.toBe("10.37.129.4");
    expect(runner).not.toHaveBeenCalled();
  });

  it("uses the lowest-metric Windows default-route alias", async () => {
    const runner = createRouteRunner(
      JSON.stringify([
        { InterfaceAlias: "Ethernet", RouteMetric: 1, InterfaceMetric: 1000 },
        { InterfaceAlias: "Ethernet 2", RouteMetric: 100, InterfaceMetric: 1 },
      ]),
    );

    await expect(
      resolveAdvertisedLanHost({
        platform: "win32",
        runCommandWithTimeout: runner,
        networkInterfaces: () =>
          ({
            Ethernet: [ipv4("10.37.129.4")],
            "Ethernet 2": [ipv4("10.211.55.3")],
          }) as NetworkInterfacesSnapshot,
      }),
    ).resolves.toBe("10.211.55.3");
    expect(runner).toHaveBeenCalledWith(
      [
        "powershell.exe",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        expect.stringContaining("Get-NetRoute"),
      ],
      { timeoutMs: 3_000, maxOutputBytes: 16 * 1024 },
    );
  });

  it("falls back to interface order when Linux route hints do not match", async () => {
    await expect(
      resolveAdvertisedLanHost({
        platform: "linux",
        runCommandWithTimeout: createRouteRunner("default via 100.64.0.1 dev tailscale0 metric 10"),
        networkInterfaces: () =>
          ({
            ethernet: [ipv4("10.37.129.4")],
            wifi: [ipv4("192.168.1.20")],
          }) as NetworkInterfacesSnapshot,
      }),
    ).resolves.toBe("10.37.129.4");
  });

  it("uses the macOS default-route interface", async () => {
    await expect(
      resolveAdvertisedLanHost({
        platform: "darwin",
        runCommandWithTimeout: createRouteRunner("   route to: default\ninterface: en9\n"),
        networkInterfaces: () =>
          ({
            en0: [ipv4("192.168.1.20")],
            en9: [ipv4("10.37.129.4")],
          }) as NetworkInterfacesSnapshot,
      }),
    ).resolves.toBe("10.37.129.4");
  });

  it("uses the first Linux default-route interface", async () => {
    await expect(
      resolveAdvertisedLanHost({
        platform: "linux",
        runCommandWithTimeout: createRouteRunner(
          "default via 192.168.1.1 dev wlan0 proto dhcp metric 600\ndefault via 10.0.0.1 dev eth0 metric 1000",
        ),
        networkInterfaces: () =>
          ({
            eth0: [ipv4("10.37.129.4")],
            wlan0: [ipv4("192.168.1.20")],
          }) as NetworkInterfacesSnapshot,
      }),
    ).resolves.toBe("192.168.1.20");
  });

  it("fails open to first private IPv4 when route probing times out", async () => {
    const runner: RouteRunner = vi.fn(async () => ({
      code: null,
      stdout: "",
      stderr: "",
    }));

    await expect(
      resolveAdvertisedLanHost({
        platform: "win32",
        runCommandWithTimeout: runner,
        networkInterfaces: () =>
          ({
            Ethernet: [ipv4("10.37.129.4")],
            "Ethernet 2": [ipv4("10.211.55.3")],
          }) as NetworkInterfacesSnapshot,
      }),
    ).resolves.toBe("10.37.129.4");
  });
});

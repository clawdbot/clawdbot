// Windows-native proof that PowerShell preserves localized adapter aliases.
import { describe, expect, it, vi } from "vitest";
import { runCommandWithTimeout } from "../process/exec.js";
import { resolveAdvertisedLanHostCore } from "./advertised-lan-host.js";
import type { NetworkInterfacesSnapshot } from "./network-interfaces.js";
import { WINDOWS_POWERSHELL_COLD_SPAWN_TIMEOUT_MS } from "./windows-powershell-spawn.js";

type ResolveOptions = NonNullable<Parameters<typeof resolveAdvertisedLanHostCore>[0]>;
type RouteRunner = NonNullable<ResolveOptions["runCommandWithTimeout"]>;
function ipv4(address: string) {
  return {
    address,
    family: "IPv4" as const,
    internal: false,
    netmask: "255.255.255.0",
    mac: "00:00:00:00:00:00",
    cidr: `${address}/24`,
  };
}

describe.runIf(process.platform === "win32")("advertised LAN host PowerShell contract", () => {
  it("round-trips a localized route alias through the production command prefix", async () => {
    let capturedArgv: string[] | undefined;
    const captureRunner: RouteRunner = vi.fn(async (argv) => {
      capturedArgv = argv;
      return { code: 0, stdout: "", stderr: "" };
    });
    const interfaces = {
      "vEthernet (Default Switch)": [ipv4("10.37.129.4")],
      "réseau-网卡": [ipv4("192.168.1.20")],
    } as NetworkInterfacesSnapshot;

    await resolveAdvertisedLanHostCore({
      platform: "win32",
      networkInterfaces: () => interfaces,
      runCommandWithTimeout: captureRunner,
    });

    const command = capturedArgv?.at(-1);
    const routeCommandIndex = command?.indexOf("Get-NetRoute") ?? -1;
    const outputPrefix = routeCommandIndex > 0 ? (command?.slice(0, routeCommandIndex) ?? "") : "";
    const result = await runCommandWithTimeout(
      [
        "powershell.exe",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `[Console]::OutputEncoding=[Text.Encoding]::GetEncoding(437); ${outputPrefix}[pscustomobject]@{InterfaceAlias='réseau-网卡';RouteMetric=1;InterfaceMetric=1} | ConvertTo-Json -Compress`,
      ],
      // Real spawn: cold PowerShell first-use can exceed the production 3s
      // fail-open probe budget; only production keeps the short bound.
      { timeoutMs: WINDOWS_POWERSHELL_COLD_SPAWN_TIMEOUT_MS, maxOutputBytes: 16 * 1024 },
    );
    expect(result).toMatchObject({ code: 0 });
    expect(JSON.parse(result.stdout)).toMatchObject({ InterfaceAlias: "réseau-网卡" });
    expect(command).toMatch(
      /^\[Console\]::OutputEncoding=\[Text\.UTF8Encoding\]::new\(\$false\); Get-NetRoute/,
    );
    expect(routeCommandIndex).toBeGreaterThan(0);

    await expect(
      resolveAdvertisedLanHostCore({
        platform: "win32",
        networkInterfaces: () => interfaces,
        runCommandWithTimeout: vi.fn(async () => result),
      }),
    ).resolves.toBe("192.168.1.20");
  });
});

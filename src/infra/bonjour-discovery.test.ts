import { describe, expect, it, vi } from "vitest";

import type { runCommandWithTimeout } from "../process/exec.js";
import { discoverGatewayBeacons } from "./bonjour-discovery.js";
import { WIDE_AREA_DISCOVERY_DOMAIN } from "./widearea-dns.js";

describe("bonjour-discovery", () => {
  it("discovers beacons on darwin across local + wide-area domains", async () => {
    const calls: Array<{ argv: string[]; timeoutMs: number }> = [];
    const studioInstance = "Peter’s Mac Studio Bridge";

    const run = vi.fn(
      async (argv: string[], options: { timeoutMs: number }) => {
        calls.push({ argv, timeoutMs: options.timeoutMs });
        const domain = argv[3] ?? "";

        if (argv[0] === "dns-sd" && argv[1] === "-B") {
          if (domain === "local.") {
            return {
              stdout: [
                "Add 2 3 local. _clawdbot-bridge._tcp. Peter\\226\\128\\153s Mac Studio Bridge",
                "Add 2 3 local. _clawdbot-bridge._tcp. Laptop Bridge",
                "",
              ].join("\n"),
              stderr: "",
              code: 0,
              signal: null,
              killed: false,
            };
          }
          if (domain === WIDE_AREA_DISCOVERY_DOMAIN) {
            return {
              stdout: [
                `Add 2 3 ${WIDE_AREA_DISCOVERY_DOMAIN} _clawdbot-bridge._tcp. Tailnet Bridge`,
                "",
              ].join("\n"),
              stderr: "",
              code: 0,
              signal: null,
              killed: false,
            };
          }
        }

        if (argv[0] === "dns-sd" && argv[1] === "-L") {
          const instance = argv[2] ?? "";
          const host =
            instance === studioInstance
              ? "studio.local"
              : instance === "Laptop Bridge"
                ? "laptop.local"
                : "tailnet.local";
          const tailnetDns =
            instance === "Tailnet Bridge" ? "studio.tailnet.ts.net" : "";
          const displayName =
            instance === studioInstance
              ? "Peter’s\\032Mac\\032Studio"
              : instance.replace(" Bridge", "");
          const txtParts = [
            "txtvers=1",
            `displayName=${displayName}`,
            `lanHost=${host}`,
            "gatewayPort=18789",
            "bridgePort=18790",
            "sshPort=22",
            tailnetDns ? `tailnetDns=${tailnetDns}` : null,
          ].filter((v): v is string => Boolean(v));

          return {
            stdout: [
              `${instance}._clawdbot-bridge._tcp. can be reached at ${host}:18790`,
              txtParts.join(" "),
              "",
            ].join("\n"),
            stderr: "",
            code: 0,
            signal: null,
            killed: false,
          };
        }

        throw new Error(`unexpected argv: ${argv.join(" ")}`);
      },
    );

    const beacons = await discoverGatewayBeacons({
      platform: "darwin",
      timeoutMs: 1234,
      run: run as unknown as typeof runCommandWithTimeout,
    });

    expect(beacons).toHaveLength(3);
    expect(beacons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          instanceName: studioInstance,
          displayName: "Peter’s Mac Studio",
        }),
      ]),
    );
    expect(beacons.map((b) => b.domain)).toEqual(
      expect.arrayContaining(["local.", WIDE_AREA_DISCOVERY_DOMAIN]),
    );

    const browseCalls = calls.filter(
      (c) => c.argv[0] === "dns-sd" && c.argv[1] === "-B",
    );
    expect(browseCalls.map((c) => c.argv[3])).toEqual(
      expect.arrayContaining(["local.", WIDE_AREA_DISCOVERY_DOMAIN]),
    );
    expect(browseCalls.every((c) => c.timeoutMs === 1234)).toBe(true);
  });

  it("decodes dns-sd octal escapes in TXT displayName", async () => {
    const run = vi.fn(
      async (argv: string[], options: { timeoutMs: number }) => {
        if (options.timeoutMs < 0) throw new Error("invalid timeout");

        const domain = argv[3] ?? "";
        if (argv[0] === "dns-sd" && argv[1] === "-B" && domain === "local.") {
          return {
            stdout: [
              "Add 2 3 local. _clawdbot-bridge._tcp. Studio Bridge",
              "",
            ].join("\n"),
            stderr: "",
            code: 0,
            signal: null,
            killed: false,
          };
        }

        if (argv[0] === "dns-sd" && argv[1] === "-L") {
          return {
            stdout: [
              "Studio Bridge._clawdbot-bridge._tcp. can be reached at studio.local:18790",
              "txtvers=1 displayName=Peter\\226\\128\\153s\\032Mac\\032Studio lanHost=studio.local gatewayPort=18789 bridgePort=18790 sshPort=22",
              "",
            ].join("\n"),
            stderr: "",
            code: 0,
            signal: null,
            killed: false,
          };
        }

        return {
          stdout: "",
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
        };
      },
    );

    const beacons = await discoverGatewayBeacons({
      platform: "darwin",
      timeoutMs: 800,
      domains: ["local."],
      run: run as unknown as typeof runCommandWithTimeout,
    });

    expect(beacons).toEqual([
      expect.objectContaining({
        domain: "local.",
        instanceName: "Studio Bridge",
        displayName: "Peter’s Mac Studio",
        txt: expect.objectContaining({
          displayName: "Peter’s Mac Studio",
        }),
      }),
    ]);
  });

  it("falls back to tailnet DNS probing for wide-area when split DNS is not configured", async () => {
    const calls: Array<{ argv: string[]; timeoutMs: number }> = [];

    const run = vi.fn(
      async (argv: string[], options: { timeoutMs: number }) => {
        calls.push({ argv, timeoutMs: options.timeoutMs });
        const cmd = argv[0];

        if (cmd === "dns-sd" && argv[1] === "-B") {
          return {
            stdout: "",
            stderr: "",
            code: 0,
            signal: null,
            killed: false,
          };
        }

        if (
          cmd === "tailscale" &&
          argv[1] === "status" &&
          argv[2] === "--json"
        ) {
          return {
            stdout: JSON.stringify({
              Self: { TailscaleIPs: ["100.69.232.64"] },
              Peer: {
                "peer-1": { TailscaleIPs: ["100.123.224.76"] },
              },
            }),
            stderr: "",
            code: 0,
            signal: null,
            killed: false,
          };
        }

        if (cmd === "dig") {
          const at = argv.find((a) => a.startsWith("@")) ?? "";
          const server = at.replace(/^@/, "");
          const qname = argv[argv.length - 2] ?? "";
          const qtype = argv[argv.length - 1] ?? "";

          if (
            server === "100.123.224.76" &&
            qtype === "PTR" &&
            qname === "_clawdbot-bridge._tcp.clawdbot.internal"
          ) {
            return {
              stdout: `studio-bridge._clawdbot-bridge._tcp.clawdbot.internal.\n`,
              stderr: "",
              code: 0,
              signal: null,
              killed: false,
            };
          }

          if (
            server === "100.123.224.76" &&
            qtype === "SRV" &&
            qname === "studio-bridge._clawdbot-bridge._tcp.clawdbot.internal"
          ) {
            return {
              stdout: `0 0 18790 studio.clawdbot.internal.\n`,
              stderr: "",
              code: 0,
              signal: null,
              killed: false,
            };
          }

          if (
            server === "100.123.224.76" &&
            qtype === "TXT" &&
            qname === "studio-bridge._clawdbot-bridge._tcp.clawdbot.internal"
          ) {
            return {
              stdout: [
                `"displayName=Studio"`,
                `"transport=bridge"`,
                `"bridgePort=18790"`,
                `"gatewayPort=18789"`,
                `"sshPort=22"`,
                `"tailnetDns=peters-mac-studio-1.sheep-coho.ts.net"`,
                `"cliPath=/opt/homebrew/bin/clawdbot"`,
                "",
              ].join(" "),
              stderr: "",
              code: 0,
              signal: null,
              killed: false,
            };
          }
        }

        throw new Error(`unexpected argv: ${argv.join(" ")}`);
      },
    );

    const beacons = await discoverGatewayBeacons({
      platform: "darwin",
      timeoutMs: 1200,
      domains: [WIDE_AREA_DISCOVERY_DOMAIN],
      run: run as unknown as typeof runCommandWithTimeout,
    });

    expect(beacons).toEqual([
      expect.objectContaining({
        domain: WIDE_AREA_DISCOVERY_DOMAIN,
        instanceName: "studio-bridge",
        displayName: "Studio",
        host: "studio.clawdbot.internal",
        port: 18790,
        tailnetDns: "peters-mac-studio-1.sheep-coho.ts.net",
        gatewayPort: 18789,
        sshPort: 22,
        cliPath: "/opt/homebrew/bin/clawdbot",
      }),
    ]);

    expect(
      calls.some((c) => c.argv[0] === "tailscale" && c.argv[1] === "status"),
    ).toBe(true);
    expect(calls.some((c) => c.argv[0] === "dig")).toBe(true);
  });

  it("normalizes domains and respects domains override", async () => {
    const calls: string[][] = [];
    const run = vi.fn(async (argv: string[]) => {
      calls.push(argv);
      return {
        stdout: "",
        stderr: "",
        code: 0,
        signal: null,
        killed: false,
      };
    });

    await discoverGatewayBeacons({
      platform: "darwin",
      timeoutMs: 1,
      domains: ["local", "clawdbot.internal"],
      run: run as unknown as typeof runCommandWithTimeout,
    });

    expect(calls.filter((c) => c[1] === "-B").map((c) => c[3])).toEqual(
      expect.arrayContaining(["local.", "clawdbot.internal."]),
    );

    calls.length = 0;
    await discoverGatewayBeacons({
      platform: "darwin",
      timeoutMs: 1,
      domains: ["local."],
      run: run as unknown as typeof runCommandWithTimeout,
    });

    expect(calls.filter((c) => c[1] === "-B")).toHaveLength(1);
    expect(calls.filter((c) => c[1] === "-B")[0]?.[3]).toBe("local.");
  });
});

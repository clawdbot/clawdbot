// Covers gateway port listener classification and diagnostics text.
import { describe, expect, it } from "vitest";
import { formatCliCommand } from "../cli/command-format.js";
import {
  buildPortHints,
  classifyPortListener,
  formatPortDiagnostics,
  isDualStackLoopbackGatewayListeners,
  isExpectedGatewayListeners,
  isSameProcessSpecificIpv4WithLoopbackListeners,
} from "./ports-format.js";

const gatewayAlreadyRunningHint = `Gateway already running locally. Stop it (${formatCliCommand("openclaw gateway stop")}) or use a different port.`;
const multipleListenersHint =
  "Multiple listeners detected; ensure only one gateway/tunnel per port unless intentionally running isolated profiles.";

describe("ports-format", () => {
  it.each([
    [{ commandLine: "ssh -N -L 18789:127.0.0.1:18789 user@host" }, "ssh"],
    [{ commandLine: "ssh -NL 18789:127.0.0.1:18789 user@host" }, "ssh"],
    [{ commandLine: "ssh -NfL18789:127.0.0.1:18789 user@host" }, "ssh"],
    [
      { commandLine: '"C:\\Program Files\\Git\\usr\\bin\\ssh.exe" -N -L18789:127.0.0.1:22 host' },
      "ssh",
    ],
    [{ commandLine: "ssh -N -L 127.0.0.1:18789:remote:22 host" }, "ssh"],
    [{ commandLine: "ssh -N -R 18789:localhost:22 host" }, "ssh"],
    [{ commandLine: "ssh -N -D 18789 host" }, "ssh"],
    [{ commandLine: "ssh -ND18789 host" }, "ssh"],
    [{ commandLine: "ssh -N -D 127.0.0.1:18789 host" }, "ssh"],
    [{ commandLine: "ssh -N -o 'LocalForward 18789 localhost:22' host" }, "ssh"],
    [{ commandLine: "ssh -N -oLocalForward=127.0.0.1:18789 localhost:22 host" }, "ssh"],
    [{ commandLine: "ssh -N -o DynamicForward=18789 host" }, "ssh"],
    [{ command: "ssh", commandLine: "ssh -N host-from-ssh-config" }, "ssh"],
    [{ command: "ssh" }, "ssh"],
    // ssh-named processes that do not forward *this* port are not tunnels; the
    // "close the tunnel / change -L port" remediation does not apply to them.
    [{ command: "sshd" }, "non_gateway"],
    [{ command: "sshd-session.exe" }, "non_gateway"],
    [{ commandLine: "/opt/fast-ssh/server --listen 18789" }, "non_gateway"],
    // ssh-named non-tunnel that merely mentions the queried port with a colon: there
    // is no -L/-R forward, so it must not classify as a tunnel or emit the hint.
    [{ commandLine: "/opt/fast-ssh/server --listen 127.0.0.1:18789" }, "non_gateway"],
    [{ commandLine: "ssh -N -L 9999:remote:22 host" }, "ssh"],
    [{ commandLine: "node /Users/me/Projects/openclaw/dist/entry.js gateway" }, "gateway"],
    [{ commandLine: "python -m http.server 18789" }, "unknown"],
  ] as const)("classifies port listener %j", (listener, expected) => {
    expect(classifyPortListener(listener, 18789)).toBe(expected);
  });

  it("does not emit the SSH tunnel hint for an ssh-named non-tunnel process", () => {
    const hints = buildPortHints([{ command: "sshd" }], 18789);
    expect(hints).not.toContain(
      "SSH tunnel already bound to this port. Close the tunnel or use a different local port in -L.",
    );
    expect(hints).toContain("Another process is listening on this port.");
  });

  it("builds ordered hints for mixed listener kinds and multiplicity", () => {
    expect(
      buildPortHints(
        [
          { commandLine: "node dist/index.js openclaw gateway" },
          { commandLine: "ssh -N -L 18789:127.0.0.1:18789" },
          { commandLine: "python -m http.server 18789" },
        ],
        18789,
      ),
    ).toEqual([
      gatewayAlreadyRunningHint,
      "SSH tunnel already bound to this port. Close the tunnel or use a different local port in -L.",
      "Another process is listening on this port.",
      multipleListenersHint,
    ]);
    expect(buildPortHints([], 18789)).toStrictEqual([]);
  });

  it("treats single-process loopback dual-stack gateway listeners as benign", () => {
    const listeners = [
      { pid: 4242, commandLine: "openclaw-gateway", address: "127.0.0.1:18789" },
      { pid: 4242, commandLine: "openclaw-gateway", address: "[::1]:18789" },
    ];
    expect(isDualStackLoopbackGatewayListeners(listeners, 18789)).toBe(true);
    expect(isExpectedGatewayListeners(listeners, 18789)).toBe(true);
    expect(buildPortHints(listeners, 18789)).toEqual([]);
  });

  it("treats a single-process specific IPv4 plus loopback alias as benign", () => {
    const listeners = [
      { pid: 4242, commandLine: "openclaw-gateway", address: "100.64.0.1:18789" },
      { pid: 4242, commandLine: "openclaw-gateway", address: "127.0.0.1:18789" },
    ];

    expect(isExpectedGatewayListeners(listeners, 18789)).toBe(true);
    expect(isSameProcessSpecificIpv4WithLoopbackListeners(listeners, 18789, "100.64.0.1")).toBe(
      true,
    );
    expect(isSameProcessSpecificIpv4WithLoopbackListeners(listeners, 18789, "10.0.0.5")).toBe(
      false,
    );
    expect(buildPortHints(listeners, 18789)).toEqual([]);
  });

  it("checks exact alias ownership without relying on process display metadata", () => {
    const listeners = [
      { pid: 4242, commandLine: "opaque-wrapper", address: "100.64.0.1:18789" },
      { pid: 4242, commandLine: "opaque-wrapper", address: "127.0.0.1:18789" },
    ];

    expect(isExpectedGatewayListeners(listeners, 18789)).toBe(false);
    expect(isSameProcessSpecificIpv4WithLoopbackListeners(listeners, 18789, "100.64.0.1")).toBe(
      true,
    );
  });

  it.each([
    [
      "mixed process ids",
      [
        { pid: 4242, commandLine: "openclaw-gateway", address: "100.64.0.1:18789" },
        { pid: 4243, commandLine: "openclaw-gateway", address: "127.0.0.1:18789" },
      ],
    ],
    [
      "an IPv6 selected address",
      [
        { pid: 4242, commandLine: "openclaw-gateway", address: "[fd7a:115c:a1e0::1]:18789" },
        { pid: 4242, commandLine: "openclaw-gateway", address: "127.0.0.1:18789" },
      ],
    ],
    [
      "a missing loopback alias",
      [{ pid: 4242, commandLine: "openclaw-gateway", address: "100.64.0.1:18789" }],
    ],
    [
      "missing process metadata",
      [
        { commandLine: "openclaw-gateway", address: "100.64.0.1:18789" },
        { commandLine: "openclaw-gateway", address: "127.0.0.1:18789" },
      ],
    ],
    [
      "an extra listener",
      [
        { pid: 4242, commandLine: "openclaw-gateway", address: "100.64.0.1:18789" },
        { pid: 4242, commandLine: "openclaw-gateway", address: "127.0.0.1:18789" },
        { pid: 4242, commandLine: "openclaw-gateway", address: "[::1]:18789" },
      ],
    ],
  ])("rejects specific-address ownership with %s", (_label, listeners) => {
    expect(isExpectedGatewayListeners(listeners, 18789)).toBe(false);
    expect(isSameProcessSpecificIpv4WithLoopbackListeners(listeners, 18789, "100.64.0.1")).toBe(
      false,
    );
    expect(buildPortHints(listeners, 18789)).toContain(gatewayAlreadyRunningHint);
  });

  it("keeps Gateway conflict hints for ambiguous Gateway listeners", () => {
    expect(
      buildPortHints(
        [
          { pid: 4242, commandLine: "openclaw-gateway", address: "0.0.0.0:18789" },
          { pid: 4243, commandLine: "openclaw-gateway", address: "127.0.0.1:18789" },
        ],
        18789,
      ),
    ).toEqual([gatewayAlreadyRunningHint, multipleListenersHint]);
  });

  it("formats free and busy port diagnostics", () => {
    expect(
      formatPortDiagnostics({
        port: 18789,
        status: "free",
        listeners: [],
        hints: [],
      }),
    ).toEqual(["Port 18789 is free."]);

    const lines = formatPortDiagnostics({
      port: 18789,
      status: "busy",
      listeners: [{ pid: 123, user: "alice", commandLine: "ssh -N -L 18789:127.0.0.1:18789" }],
      hints: buildPortHints([{ pid: 123, commandLine: "ssh -N -L 18789:127.0.0.1:18789" }], 18789),
    });
    expect(lines[0]).toContain("Port 18789 is already in use");
    expect(lines).toContain("- pid 123 alice: ssh -N -L 18789:127.0.0.1:18789");
    const sshTunnelHints = lines.filter((line) => line.includes("SSH tunnel"));
    expect(sshTunnelHints.length).toBeGreaterThan(0);
  });
});

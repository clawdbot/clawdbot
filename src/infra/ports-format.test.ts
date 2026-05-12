import { describe, expect, it } from "vitest";
import { formatCliCommand } from "../cli/command-format.js";
import {
  buildPortHints,
  classifyPortListener,
  formatPortDiagnostics,
  formatPortListener,
  isDualStackLoopbackGatewayListeners,
  isExpectedGatewayListeners,
  isSingleExpectedGatewayListener,
} from "./ports-format.js";

const gatewayAlreadyRunningHint = `Gateway already running locally. Stop it (${formatCliCommand("openclaw gateway stop")}) or use a different port.`;
const multipleListenersHint =
  "Multiple listeners detected; ensure only one gateway/tunnel per port unless intentionally running isolated profiles.";

describe("ports-format", () => {
  it.each([
    [{ commandLine: "ssh -N -L 18789:127.0.0.1:18789 user@host" }, "ssh"],
    [{ command: "ssh" }, "ssh"],
    [{ commandLine: "node /Users/me/Projects/openclaw/dist/entry.js gateway" }, "gateway"],
    [{ commandLine: "python -m http.server 18789" }, "unknown"],
  ] as const)("classifies port listener %j", (listener, expected) => {
    expect(classifyPortListener(listener, 18789)).toBe(expected);
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

  it.each([
    "127.0.0.1:18789",
    "[::1]:18789",
    "localhost:18789",
    "0.0.0.0:18789",
    "[::]:18789",
    "*:18789",
  ])("treats a single expected Gateway listener on %s as benign", (address) => {
    const listeners = [{ pid: 4242, commandLine: "openclaw-gateway", address }];

    expect(isSingleExpectedGatewayListener(listeners, 18789)).toBe(true);
    expect(isExpectedGatewayListeners(listeners, 18789)).toBe(true);
    expect(buildPortHints(listeners, 18789)).toEqual([]);
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

  it.each([
    [
      { pid: 123, user: "alice", commandLine: "ssh -N", address: "::1" },
      "pid 123 alice: ssh -N (::1)",
    ],
    [{ command: "ssh", address: "127.0.0.1:18789" }, "pid ?: ssh (127.0.0.1:18789)"],
    [{}, "pid ?: unknown"],
  ] as const)("formats port listener %j", (listener, expected) => {
    expect(formatPortListener(listener)).toBe(expected);
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

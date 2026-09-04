// Status gateway connection tests cover connection detail resolution and terminal logging.
import { describe, expect, it, vi } from "vitest";
import {
  logGatewayConnectionDetails,
  resolveStatusAllConnectionDetails,
} from "./status.gateway-connection.js";

describe("status.gateway-connection", () => {
  it("logs gateway connection details with indentation", () => {
    const runtime = { log: vi.fn() };

    logGatewayConnectionDetails({
      runtime,
      info: (value) => `info:${value}`,
      message: "Gateway mode: local\nGateway target: ws://127.0.0.1:18789",
      trailingBlankLine: true,
    });

    expect(runtime.log.mock.calls).toEqual([
      ["info:Gateway connection:"],
      ["  Gateway mode: local"],
      ["  Gateway target: ws://127.0.0.1:18789"],
      [""],
    ]);
  });

  it("builds remote fallback connection details", () => {
    expect(
      resolveStatusAllConnectionDetails({
        nodeOnlyGateway: null,
        remoteUrlMissing: true,
        gatewayConnection: {
          url: "ws://127.0.0.1:18789",
          urlSource: "local loopback",
          message: "ignored",
        },
        bindMode: "loopback",
        configPath: "/tmp/openclaw.json",
      }),
    ).toBe(
      [
        "Gateway mode: remote",
        "Gateway target: (missing gateway.remote.url)",
        "Config: /tmp/openclaw.json",
        "Bind: loopback",
        "Local fallback (used for probes): ws://127.0.0.1:18789",
        "Fix: set gateway.remote.url, or set gateway.mode=local.",
      ].join("\n"),
    );
  });

  it("redacts credentials from the remote fallback URL", () => {
    const details = resolveStatusAllConnectionDetails({
      nodeOnlyGateway: null,
      remoteUrlMissing: true,
      gatewayConnection: {
        url: "ws://user:secret@127.0.0.1:18789?token=abc123",
        urlSource: "env",
        message: "ignored",
      },
      bindMode: "loopback",
      configPath: "/tmp/openclaw.json",
    });
    expect(details).not.toContain("secret");
    expect(details).not.toContain("abc123");
    expect(details).toContain("ws://***:***@127.0.0.1:18789/?token=***");
  });

  it("prefers node-only connection details when present", () => {
    expect(
      resolveStatusAllConnectionDetails({
        nodeOnlyGateway: {
          gatewayTarget: "remote.example:18789",
          gatewayValue: "node → remote.example:18789 · no local gateway",
          connectionDetails: "Node-only mode detected",
        },
        remoteUrlMissing: false,
        gatewayConnection: {
          url: "ws://127.0.0.1:18789",
          urlSource: "local loopback",
          message: "Gateway mode: local",
        },
        bindMode: "loopback",
        configPath: "/tmp/openclaw.json",
      }),
    ).toBe("Node-only mode detected");
  });
});

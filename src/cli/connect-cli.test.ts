// Connect CLI tests cover accepted targets and handoff to the canonical node runtime.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodePairingSetupCode } from "../pairing/setup-code.js";
import { registerConnectCli } from "./connect-cli.js";

const mocks = vi.hoisted(() => ({
  runNodeHost: vi.fn(),
  runNodeDaemonInstall: vi.fn(),
  fetchWithSsrFGuard: vi.fn(),
  runtime: {
    error: vi.fn(),
    exit: vi.fn(),
  },
}));

vi.mock("../node-host/runner.js", () => ({ runNodeHost: mocks.runNodeHost }));
vi.mock("./node-cli/daemon.js", () => ({
  runNodeDaemonInstall: mocks.runNodeDaemonInstall,
}));
vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: mocks.fetchWithSsrFGuard,
}));
vi.mock("../runtime.js", () => ({ defaultRuntime: mocks.runtime }));

const payload = {
  url: "wss://192.168.1.20:8443/openclaw-gw",
  urls: ["wss://192.168.1.20:8443/openclaw-gw", "wss://gateway.tailnet.example/tailnet-gw"],
  bootstrapToken: "bootstrap-token",
  tlsFingerprint: "ab".repeat(32),
};

function setupCode(): string {
  return encodePairingSetupCode(payload);
}

async function runConnect(args: string[]): Promise<void> {
  const program = new Command();
  registerConnectCli(program);
  await program.parseAsync(["connect", ...args], { from: "user" });
}

describe("connect cli", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runNodeHost.mockResolvedValue(undefined);
    mocks.runNodeDaemonInstall.mockResolvedValue(undefined);
    mocks.runtime.exit.mockImplementation(() => {});
  });

  it.each([
    { name: "bare setup code", target: () => setupCode(), fetched: false },
    { name: "oc-pair wrapper", target: () => `oc-pair://${setupCode()}`, fetched: false },
    {
      name: "HTTPS join URL",
      target: () => `https://gateway.example/openclaw-gw/j/${"a".repeat(22)}`,
      fetched: true,
    },
  ])("maps a $name into the existing node foreground runtime", async ({ target, fetched }) => {
    if (fetched) {
      mocks.fetchWithSsrFGuard.mockResolvedValueOnce({
        response: new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
        }),
        finalUrl: target(),
        release: vi.fn().mockResolvedValue(undefined),
      });
    }

    await runConnect([target(), "--display-name", "Build Node"]);

    expect(mocks.runNodeHost).toHaveBeenCalledWith({
      gatewayHost: "192.168.1.20",
      gatewayPort: 8443,
      gatewayTls: true,
      gatewayTlsFingerprint: "ab".repeat(32),
      gatewayContextPath: "/openclaw-gw",
      gatewayCandidates: [
        {
          host: "192.168.1.20",
          port: 8443,
          contextPath: "/openclaw-gw",
          tls: true,
          tlsFingerprint: "ab".repeat(32),
        },
        {
          host: "gateway.tailnet.example",
          port: 443,
          contextPath: "/tailnet-gw",
          tls: true,
        },
      ],
      gatewayBootstrapToken: "bootstrap-token",
      preferGatewayBootstrapToken: true,
      displayName: "Build Node",
    });
    expect(mocks.fetchWithSsrFGuard).toHaveBeenCalledTimes(fetched ? 1 : 0);
    expect(mocks.runNodeDaemonInstall).not.toHaveBeenCalled();
  });

  it("redeems before installing from the winning persisted endpoint", async () => {
    await runConnect([setupCode(), "--service", "--display-name", "Service Node"]);

    expect(mocks.runNodeHost).toHaveBeenCalledWith(
      expect.objectContaining({
        gatewayBootstrapToken: "bootstrap-token",
        stopAfterFirstConnect: true,
      }),
    );
    expect(mocks.runNodeDaemonInstall).toHaveBeenCalledWith({
      displayName: "Service Node",
      force: true,
    });
  });

  it("refuses plain HTTP join URLs for non-loopback gateways", async () => {
    await runConnect([`http://gateway.example/j/${"a".repeat(22)}`]);

    expect(mocks.runtime.error).toHaveBeenCalledWith(
      "Plain HTTP join URLs are allowed only for loopback gateways.",
    );
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
    expect(mocks.fetchWithSsrFGuard).not.toHaveBeenCalled();
    expect(mocks.runNodeHost).not.toHaveBeenCalled();
  });
});

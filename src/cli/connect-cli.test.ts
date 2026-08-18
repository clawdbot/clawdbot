// Connect CLI tests cover accepted targets and handoff to the canonical node runtime.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeHostConfig } from "../node-host/config.js";
import { encodePairingSetupCode } from "../pairing/setup-code.js";
import { registerConnectCli } from "./connect-cli.js";

const mocks = vi.hoisted(() => ({
  runNodeHost: vi.fn(),
  runNodeDaemonInstall: vi.fn(),
  fetchWithSsrFGuard: vi.fn(),
  loadNodeHostConfig: vi.fn<() => Promise<NodeHostConfig | null>>(async () => null),
  runtime: {
    error: vi.fn(),
    exit: vi.fn(),
  },
}));

vi.mock("../node-host/runner.js", () => ({ runNodeHost: mocks.runNodeHost }));
vi.mock("../node-host/config.js", () => ({ loadNodeHostConfig: mocks.loadNodeHostConfig }));
vi.mock("../config/config.js", () => ({ getRuntimeConfig: vi.fn(() => ({})) }));
vi.mock("./node-cli/daemon.js", () => ({
  runNodeDaemonInstall: mocks.runNodeDaemonInstall,
}));
vi.mock("../infra/net/fetch-guard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/net/fetch-guard.js")>();
  mocks.fetchWithSsrFGuard.mockImplementation(actual.fetchWithSsrFGuard);
  return { fetchWithSsrFGuard: mocks.fetchWithSsrFGuard };
});
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
    if (fetched) {
      expect(mocks.fetchWithSsrFGuard.mock.calls[0]?.[0]).not.toHaveProperty("init");
    }
    expect(mocks.runNodeDaemonInstall).not.toHaveBeenCalled();
  });

  it("runs environment-managed nodes as process-scoped session hosts", async () => {
    await runConnect([setupCode(), "--ephemeral", "--display-name", "Cloud Node"]);

    expect(mocks.runNodeHost).toHaveBeenCalledWith(
      expect.objectContaining({
        gatewayBootstrapToken: "bootstrap-token",
        preferGatewayBootstrapToken: false,
        forceWorkerRuns: true,
        displayName: "Cloud Node",
      }),
    );
    expect(mocks.runNodeDaemonInstall).not.toHaveBeenCalled();
  });

  it("consumes an environment-managed target file before connecting", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-connect-target-"));
    const targetFile = path.join(root, "setup-code");
    await fs.writeFile(targetFile, setupCode(), { mode: 0o600 });
    try {
      await runConnect(["--target-file", targetFile, "--ephemeral"]);

      expect(mocks.runNodeHost).toHaveBeenCalledWith(
        expect.objectContaining({ forceWorkerRuns: true }),
      );
      await expect(fs.stat(targetFile)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects service installation for environment-managed nodes", async () => {
    await runConnect([setupCode(), "--ephemeral", "--service"]);

    expect(mocks.runtime.error).toHaveBeenCalledWith(
      "--ephemeral cannot be combined with --service.",
    );
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
    expect(mocks.runNodeHost).not.toHaveBeenCalled();
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

  it("sends Cloudflare Access credentials on the pinned HTTPS join request", async () => {
    const clientId = ["cf", "client", "id"].join("-");
    const clientSecret = ["cf", "client", "secret"].join("-");
    mocks.loadNodeHostConfig.mockResolvedValueOnce({
      version: 1,
      nodeId: "node-test",
      gateway: {
        host: "gateway.example",
        port: 443,
        tls: true,
        cloudflareAccess: { clientId, clientSecret },
      },
    });
    const target = `https://gateway.example/j/${"a".repeat(22)}`;
    mocks.fetchWithSsrFGuard.mockResolvedValueOnce({
      response: new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      finalUrl: target,
      release: vi.fn(async () => undefined),
    });

    await runConnect([target]);

    expect(mocks.fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        maxRedirects: 0,
        init: {
          headers: {
            "CF-Access-Client-Id": clientId,
            "CF-Access-Client-Secret": clientSecret,
          },
        },
      }),
    );
  });

  it("rejects Cloudflare Access credentials before a plaintext join request", async () => {
    const clientSecret = ["cf", "plaintext", "secret"].join("-");
    mocks.loadNodeHostConfig.mockResolvedValueOnce({
      version: 1,
      nodeId: "node-test",
      gateway: {
        host: "127.0.0.1",
        port: 80,
        tls: false,
        cloudflareAccess: { clientId: "cf-plaintext-id", clientSecret },
      },
    });

    await runConnect([`http://127.0.0.1/j/${"a".repeat(22)}`]);

    expect(mocks.runtime.error).toHaveBeenCalledWith(
      "Cloudflare Access credentials require an HTTPS join URL.",
    );
    expect(String(mocks.runtime.error.mock.calls[0]?.[0])).not.toContain(clientSecret);
    expect(mocks.fetchWithSsrFGuard).not.toHaveBeenCalled();
    expect(mocks.runNodeHost).not.toHaveBeenCalled();
  });
});

// Connect CLI tests cover accepted targets and handoff to the canonical node runtime.
import { createServer } from "node:http";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodePairingSetupCode } from "../pairing/setup-code.js";
import { registerConnectCli } from "./connect-cli.js";

const mocks = vi.hoisted(() => ({
  runNodeHost: vi.fn(),
  runNodeDaemonInstall: vi.fn(),
  fetchWithSsrFGuard: vi.fn(),
  loadNodeHostConfig: vi.fn(async () => null),
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

  afterEach(() => {
    vi.unstubAllEnvs();
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

  it("sends Cloudflare Access credentials on the pinned join request", async () => {
    const clientId = ["cf", "client", "id"].join("-");
    const clientSecret = ["cf", "client", "secret"].join("-");
    vi.stubEnv("CF_ACCESS_CLIENT_ID", clientId);
    vi.stubEnv("CF_ACCESS_CLIENT_SECRET", clientSecret);
    let observedHeaders: Record<string, string | string[] | undefined> | undefined;
    const server = createServer((request, response) => {
      observedHeaders = request.headers;
      const accepted =
        request.headers["cf-access-client-id"] === clientId &&
        request.headers["cf-access-client-secret"] === clientSecret;
      response.writeHead(accepted ? 200 : 403, {
        "content-type": accepted ? "application/json" : "text/plain",
      });
      response.end(accepted ? JSON.stringify(payload) : "Access denied");
    });
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("test edge did not allocate a port"));
          return;
        }
        resolve(address.port);
      });
    });
    const target = `http://127.0.0.1:${port}/j/${"a".repeat(22)}`;

    try {
      await runConnect([target]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }

    expect(observedHeaders).toMatchObject({
      "cf-access-client-id": clientId,
      "cf-access-client-secret": clientSecret,
    });
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
});

import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { getFreePort, installGatewayTestHooks, startGatewayServer } from "./test-helpers.js";

const webFetchProviderDiscovery = vi.hoisted(() => ({
  resolveBundledWebFetchProvidersFromPublicArtifactsMock: vi.fn(() => {
    throw new Error("gateway startup must not discover bundled web fetch providers before bind");
  }),
  resolvePluginWebFetchProvidersMock: vi.fn(() => {
    throw new Error("gateway startup must not discover plugin web fetch providers before bind");
  }),
}));

vi.mock("../secrets/runtime-web-tools-fallback.runtime.js", async () => {
  const actual = await vi.importActual<
    typeof import("../secrets/runtime-web-tools-fallback.runtime.js")
  >("../secrets/runtime-web-tools-fallback.runtime.js");
  return {
    ...actual,
    runtimeWebToolsFallbackProviders: {
      ...actual.runtimeWebToolsFallbackProviders,
      resolvePluginWebFetchProviders: webFetchProviderDiscovery.resolvePluginWebFetchProvidersMock,
    },
  };
});

vi.mock("../secrets/runtime-web-tools-public-artifacts.runtime.js", async () => {
  const actual = await vi.importActual<
    typeof import("../secrets/runtime-web-tools-public-artifacts.runtime.js")
  >("../secrets/runtime-web-tools-public-artifacts.runtime.js");
  return {
    ...actual,
    resolveBundledWebFetchProvidersFromPublicArtifacts:
      webFetchProviderDiscovery.resolveBundledWebFetchProvidersFromPublicArtifactsMock,
  };
});

installGatewayTestHooks();

afterEach(() => {
  webFetchProviderDiscovery.resolveBundledWebFetchProvidersFromPublicArtifactsMock.mockClear();
  webFetchProviderDiscovery.resolvePluginWebFetchProvidersMock.mockClear();
});

async function requestHealthz(port: number): Promise<{ status: number; body: string }> {
  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/healthz",
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.once("end", () => {
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.once("error", reject);
    req.setTimeout(5_000, () => {
      req.destroy(new Error("timeout waiting for /healthz"));
    });
    req.end();
  });
}

async function writeConfig(config: OpenClawConfig): Promise<void> {
  const { writeConfigFile } = await import("../config/config.js");
  await writeConfigFile(config);
}

describe("gateway startup web fetch config", () => {
  it("binds HTTP with credential-free tools.web.fetch config without fetch provider discovery", async () => {
    const previousMinimal = process.env.OPENCLAW_TEST_MINIMAL_GATEWAY;
    process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = "0";
    let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
    try {
      await writeConfig({
        gateway: {
          mode: "local",
          bind: "loopback",
          auth: { mode: "none" },
        },
        plugins: {
          enabled: true,
          allow: [],
          entries: {},
        },
        tools: {
          web: {
            fetch: {
              enabled: true,
              maxChars: 200_000,
              maxCharsCap: 2_000_000,
            },
          },
        },
      } as OpenClawConfig);

      const port = await getFreePort();
      server = await startGatewayServer(port, {
        auth: { mode: "none" },
      });

      const response = await requestHealthz(port);
      expect(response.status).toBe(200);
      expect(
        webFetchProviderDiscovery.resolveBundledWebFetchProvidersFromPublicArtifactsMock,
      ).not.toHaveBeenCalled();
      expect(webFetchProviderDiscovery.resolvePluginWebFetchProvidersMock).not.toHaveBeenCalled();
    } finally {
      if (server) {
        await server.close();
      }
      if (previousMinimal === undefined) {
        delete process.env.OPENCLAW_TEST_MINIMAL_GATEWAY;
      } else {
        process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = previousMinimal;
      }
    }
  });
});

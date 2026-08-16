// Doctor web fetch proxy tests cover explicit opt-in diagnostics without exposing proxy values.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { noteWebFetchProxyDiagnostic } from "./doctor-web-fetch-proxy.js";

function serviceWithEnv(environment?: Record<string, string>) {
  return {
    readCommand: vi.fn(async () =>
      environment ? { programArguments: ["openclaw", "gateway"], environment } : null,
    ),
  };
}

async function collectDiagnostic(
  params: Omit<Parameters<typeof noteWebFetchProxyDiagnostic>[0], "noteFn">,
): Promise<string | null> {
  let diagnostic: string | null = null;
  await noteWebFetchProxyDiagnostic({
    ...params,
    noteFn: (message) => {
      if (typeof message !== "string") {
        throw new TypeError("expected doctor proxy diagnostic to be a string");
      }
      diagnostic = message;
    },
  });
  return diagnostic;
}

describe("web_fetch proxy doctor diagnostic", () => {
  it("reports direct routing for an installed Gateway proxy without exposing its value", async () => {
    const proxyUrl = "http://private-proxy.example:8080/proxy-value-marker";
    const diagnostic = await collectDiagnostic({
      cfg: {},
      env: {},
      service: serviceWithEnv({ HTTPS_PROXY: proxyUrl }),
      probeDirectConnectivity: vi.fn(async () => "unreachable" as const),
    });

    expect(diagnostic).toContain(
      "HTTP(S) proxy environment detected in the installed Gateway service: HTTPS_PROXY",
    );
    expect(diagnostic).toContain("web_fetch still uses direct connections");
    expect(diagnostic).toContain("tools.web.fetch.useTrustedEnvProxy is not enabled");
    expect(diagnostic).toContain("Direct TLS connectivity to docs.openclaw.ai:443 failed");
    expect(diagnostic).toContain("openclaw config set tools.web.fetch.useTrustedEnvProxy true");
    expect(diagnostic).not.toContain(proxyUrl);
    expect(diagnostic).not.toContain("proxy-value-marker");
  });

  it("reports a reachable direct path from the doctor process", async () => {
    const diagnostic = await collectDiagnostic({
      cfg: {},
      env: { http_proxy: "http://proxy.example:8080" },
      service: serviceWithEnv(),
      probeDirectConnectivity: vi.fn(async () => "reachable" as const),
    });

    expect(diagnostic).toContain("proxy environment detected in the doctor process: http_proxy");
    expect(diagnostic).toContain("Direct TLS connectivity to docs.openclaw.ai:443 succeeded");
  });

  it("reports both process and installed service proxy sources", async () => {
    const diagnostic = await collectDiagnostic({
      cfg: {},
      env: { HTTP_PROXY: "http://shell-proxy.example:8080" },
      service: serviceWithEnv({ HTTPS_PROXY: "http://service-proxy.example:8080" }),
      probeDirectConnectivity: vi.fn(async () => "reachable" as const),
    });

    expect(diagnostic).toContain("doctor process: HTTP_PROXY");
    expect(diagnostic).toContain("installed Gateway service: HTTPS_PROXY");
  });

  it("does nothing when no HTTP(S) proxy is effective", async () => {
    const probe = vi.fn(async () => "reachable" as const);

    await expect(
      collectDiagnostic({
        cfg: {},
        env: { ALL_PROXY: "socks5://proxy.example:1080" },
        service: serviceWithEnv(),
        probeDirectConnectivity: probe,
      }),
    ).resolves.toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "trusted proxy opt-in is enabled",
      cfg: { tools: { web: { fetch: { useTrustedEnvProxy: true } } } },
    },
    {
      name: "web_fetch is disabled",
      cfg: { tools: { web: { fetch: { enabled: false } } } },
    },
    {
      name: "Gateway mode is remote",
      cfg: { gateway: { mode: "remote" } },
    },
  ])("does nothing when $name", async ({ cfg }) => {
    const service = serviceWithEnv({ HTTPS_PROXY: "http://proxy.example:8080" });
    const probe = vi.fn(async () => "unreachable" as const);

    await expect(
      collectDiagnostic({
        cfg: cfg as OpenClawConfig,
        env: {},
        service,
        probeDirectConnectivity: probe,
      }),
    ).resolves.toBeNull();
    expect(service.readCommand).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });

  it("emits one titled note", async () => {
    const noteFn = vi.fn();

    await noteWebFetchProxyDiagnostic({
      cfg: {},
      env: { HTTPS_PROXY: "http://proxy.example:8080" },
      service: serviceWithEnv(),
      probeDirectConnectivity: vi.fn(async () => "reachable" as const),
      noteFn,
    });

    expect(noteFn).toHaveBeenCalledTimes(1);
    expect(noteFn).toHaveBeenCalledWith(expect.stringContaining("web_fetch"), "Web fetch proxy");
  });
});

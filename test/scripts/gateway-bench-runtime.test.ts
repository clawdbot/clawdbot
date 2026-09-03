import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BASE_GATEWAY_BENCH_CONFIG,
  createGatewayBenchEnv,
  writeGatewayBenchConfig,
} from "../../scripts/lib/gateway-bench-runtime.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { startGatewayPluginDiscovery } from "../../src/gateway/server-startup-early.js";
import {
  resolveWideAreaDiscoveryDomain,
  writeWideAreaGatewayZone,
} from "../../src/infra/widearea-dns.js";
import { createEmptyPluginRegistry } from "../../src/plugins/registry-empty.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

vi.mock("../../src/infra/machine-name.js", () => ({
  getMachineDisplayName: async () => "Benchmark fixture",
}));

vi.mock("../../src/infra/widearea-dns.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/infra/widearea-dns.js")>();
  return {
    ...actual,
    resolveWideAreaDiscoveryDomain: vi.fn(actual.resolveWideAreaDiscoveryDomain),
    writeWideAreaGatewayZone: vi.fn(async () => ({ changed: false, zonePath: "unused" })),
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("gateway benchmark discovery isolation", () => {
  it.each([
    { name: "benchmark fixture", enabled: false },
    { name: "enabled minimal-discovery control", enabled: true },
  ])("$name reaches the publication boundary with the expected policy", async ({ enabled }) => {
    const root = tempDirs.make("openclaw-bench-discovery-");
    const configPath = writeGatewayBenchConfig(
      root,
      {
        ...BASE_GATEWAY_BENCH_CONFIG,
        ...(enabled ? { discovery: { mdns: { mode: "minimal" } } } : {}),
      },
      {},
    );
    vi.stubEnv("OPENCLAW_WIDE_AREA_DOMAIN", "inherited.example.test");
    const childEnv = createGatewayBenchEnv(root, configPath, {});
    for (const key of [
      "HOME",
      "OPENCLAW_HOME",
      "OPENCLAW_STATE_DIR",
      "OPENCLAW_CONFIG_PATH",
      "NODE_ENV",
      "VITEST",
      "OPENCLAW_DISABLE_BONJOUR",
      "OPENCLAW_WIDE_AREA_DOMAIN",
      "OPENCLAW_TAILNET_DNS",
      "OPENCLAW_CLI_PATH",
      "OPENCLAW_SSH_PORT",
      "OPENCLAW_GATEWAY_DISCOVERY_ADVERTISE_TIMEOUT_MS",
    ]) {
      vi.stubEnv(key, childEnv[key]);
    }
    const cfgAtStart: OpenClawConfig = JSON.parse(readFileSync(configPath, "utf8"));
    const stop = vi.fn();
    const advertise = vi.fn(async () => ({ stop }));
    const pluginRegistry = createEmptyPluginRegistry();
    pluginRegistry.gatewayDiscoveryServices.push({
      pluginId: "fixture-discovery",
      source: "test",
      service: { id: "fixture-discovery", advertise },
    });

    const bonjourStop = await startGatewayPluginDiscovery({
      minimalTestGateway: false,
      cfgAtStart,
      port: 18789,
      gatewayTls: { enabled: false },
      gatewayDirectReachable: false,
      tailscaleMode: "off",
      logDiscovery: { info: vi.fn(), warn: vi.fn() },
      pluginRegistry,
    });
    await bonjourStop?.();

    expect(childEnv.OPENCLAW_WIDE_AREA_DOMAIN).toBeUndefined();
    expect(resolveWideAreaDiscoveryDomain).not.toHaveBeenCalled();
    expect(writeWideAreaGatewayZone).not.toHaveBeenCalled();
    if (enabled) {
      expect(advertise).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ gatewayDirectReachable: false, minimal: true }),
      );
      expect(stop).toHaveBeenCalledOnce();
    } else {
      expect(advertise).not.toHaveBeenCalled();
      expect(stop).not.toHaveBeenCalled();
    }
  });
});

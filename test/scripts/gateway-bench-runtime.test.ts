import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BASE_GATEWAY_BENCH_CONFIG,
  createGatewayBenchEnv,
  formatMb,
  formatStats,
  writeGatewayBenchConfig,
} from "../../scripts/lib/gateway-bench-runtime.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { startGatewayDiscovery } from "../../src/gateway/server-discovery-runtime.js";
import { createGatewayPluginRuntimeGeneration } from "../../src/gateway/server-plugin-runtime-generation.js";
import {
  resolveWideAreaDiscoveryDomain,
  writeWideAreaGatewayZone,
} from "../../src/infra/widearea-dns.js";
import { createEmptyPluginRegistry } from "../../src/plugins/registry-empty.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

vi.mock("../../src/infra/widearea-dns.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/infra/widearea-dns.js")>();
  return {
    ...actual,
    resolveWideAreaDiscoveryDomain: vi.fn(actual.resolveWideAreaDiscoveryDomain),
    writeWideAreaGatewayZone: vi.fn(async () => ({ changed: false, zonePath: "unused" })),
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("benchmark statistic units", () => {
  const stats = { p50: 1.5, avg: 1.5, min: 1, max: 2, p95: 2 };
  it.each([
    {
      name: "default duration",
      format: undefined,
      expected: "p50=1.5ms avg=1.5ms min=1.0ms max=2.0ms",
    },
    { name: "fractional counts", format: String, expected: "p50=1.5 avg=1.5 min=1 max=2" },
    { name: "memory", format: formatMb, expected: "p50=1.5MB avg=1.5MB min=1.0MB max=2.0MB" },
    {
      name: "ratios",
      format: (value: number) => value.toFixed(3),
      expected: "p50=1.500 avg=1.500 min=1.000 max=2.000",
    },
  ])("formats $name", ({ format, expected }) => {
    expect(format === undefined ? formatStats(stats) : formatStats(stats, format)).toBe(expected);
  });

  it.each([null, undefined])("keeps missing statistics %s unavailable", (missingStats) => {
    const format = vi.fn(() => "unexpected");
    expect(formatStats(missingStats, format)).toBe("n/a");
    expect(format).not.toHaveBeenCalled();
  });
});

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

    const discovery = await startGatewayDiscovery({
      machineDisplayName: "Benchmark fixture",
      discovery: cfgAtStart.discovery,
      pluginRuntimeClaim: createGatewayPluginRuntimeGeneration({
        getServices: () => null,
        setServices: () => {},
      }).currentClaim(),
      port: 18789,
      gatewayTls: { enabled: false },
      gatewayDirectReachable: false,
      tailscaleMode: "off",
      logDiscovery: { info: vi.fn(), warn: vi.fn() },
      gatewayDiscoveryServices: pluginRegistry.gatewayDiscoveryServices,
    });
    await discovery.stop();

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

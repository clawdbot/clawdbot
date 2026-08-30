// The routed Gateway status path must not initialize full config IO for a plain config.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  loadedModules: new Set<string>(),
  output: undefined as unknown,
}));

vi.mock("./command-execution-startup.js", () => ({
  applyCliExecutionStartupPresentation: vi.fn(async () => {}),
  ensureCliExecutionBootstrap: vi.fn(async () => {}),
  resolveCliExecutionStartupContext: vi.fn(() => ({
    startupPolicy: { loadPlugins: false, suppressDoctorStdout: true },
  })),
}));

vi.mock("../config/io.runtime.js", async (importOriginal) => {
  testState.loadedModules.add("config-io-runtime");
  return await importOriginal();
});

vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: () => ({
    label: "Gateway",
    loadedText: "loaded",
    notLoadedText: "not loaded",
  }),
  readGatewayServiceState: vi.fn(async () => ({
    command: null,
    env: {},
    loadState: { status: "not-loaded" as const },
    runtime: { status: "stopped" as const },
  })),
}));

vi.mock("../gateway/control-ui-links.js", () => ({
  resolveAdvertisedControlUiLinks: vi.fn(async () => ({
    httpUrl: "http://127.0.0.1:18789/",
    wsUrl: "ws://127.0.0.1:18789",
  })),
}));

vi.mock("../gateway/desktop/host-source.js", () => ({
  inspectHostDesktop: vi.fn(async () => ({
    status: { enabled: false, state: "disabled", port: 5900 },
    detail: "disabled",
  })),
}));

vi.mock("../infra/network-discovery-display.js", () => ({
  inspectBestEffortPrimaryTailnetIPv4: vi.fn(() => ({ tailnetIPv4: undefined })),
  resolveBestEffortGatewayBindHostForDisplay: vi.fn(async () => ({
    bindHost: "127.0.0.1",
  })),
}));

vi.mock("../infra/ports-inspect.js", () => ({
  inspectPortConnections: vi.fn(async (port: number) => ({ port, connections: [] })),
  inspectPortUsage: vi.fn(async (port: number) => ({
    port,
    status: "free",
    listeners: [],
    hints: [],
  })),
  inspectPortUsages: vi.fn(async () => new Map()),
}));

vi.mock("../plugins/installed-plugin-index-record-reader.js", () => ({
  loadInstalledPluginIndexInstallRecords: vi.fn(async () => ({})),
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: {
    error: vi.fn(),
    exit: vi.fn(),
    log: vi.fn(),
    writeJson: vi.fn((value: unknown) => {
      testState.output = value;
    }),
    writeStdout: vi.fn(),
  },
}));

import { tryRouteCli } from "./route.js";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-gateway-status-route-"));
const configPath = path.join(tempRoot, "openclaw.json");
fs.writeFileSync(configPath, JSON.stringify({ gateway: { bind: "loopback" } }));

afterAll(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

it("keeps plain-config status off the full config runtime", async () => {
  vi.stubEnv("OPENCLAW_HOME", tempRoot);
  vi.stubEnv("OPENCLAW_STATE_DIR", tempRoot);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);

  await expect(
    tryRouteCli(["node", "openclaw", "gateway", "status", "--json", "--no-probe"]),
  ).resolves.toBe(true);

  expect(testState.output).toMatchObject({
    config: {
      cli: { path: configPath, exists: true, valid: true },
    },
    gateway: { bindMode: "loopback", port: 18789 },
  });
  expect(testState.loadedModules).not.toContain("config-io-runtime");
});

// Shared mocks and harness for the non-interactive gateway onboarding suites.
// vi.mock calls live here so sibling suites share one config-write/daemon/health surface.
import path from "node:path";
import { vi } from "vitest";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import {
  createOnboardTestConfigStore,
  createThrowingRuntime,
  mockOnboardingAgent,
} from "./onboard-non-interactive.test-helpers.js";
import type { WaitForGatewayReachableMock } from "./onboard-non-interactive.test-helpers.js";
import type { installGatewayDaemonNonInteractive } from "./onboard-non-interactive/local/daemon-install.js";

export const ensureWorkspaceAndSessionsMock = vi.fn(async (..._args: unknown[]) => {});
const onboardTestConfigStore = createOnboardTestConfigStore();
export const {
  configStore: testConfigStore,
  resolveConfigPath: resolveTestConfigPath,
  readConfig: readTestConfig,
} = onboardTestConfigStore;
const gatewayOnboardConfigSnapshotMock = vi.hoisted(() =>
  vi.fn<() => Promise<ConfigFileSnapshot>>(),
);
const pluginLifecycleLeaseState = vi.hoisted(() => ({ depth: 0 }));
export const configWritePluginLeaseDepths: number[] = [];
type InstallGatewayDaemonResult = Awaited<ReturnType<typeof installGatewayDaemonNonInteractive>>;
const installGatewayDaemonNonInteractiveMock = vi.hoisted(() =>
  vi.fn(async (): Promise<InstallGatewayDaemonResult> => ({ installed: true })),
);
const healthCommandMock = vi.hoisted(() => vi.fn(async () => {}));
const gatewayServiceMock = vi.hoisted(() => ({
  label: "LaunchAgent",
  loadedText: "loaded",
  isLoaded: vi.fn(async () => true),
  readRuntime: vi.fn(async () => ({
    status: "running",
    state: "active",
    pid: 4242,
  })),
}));
const readLastGatewayErrorLineMock = vi.hoisted(() =>
  vi.fn(async () => "Gateway failed to start: required secrets are unavailable."),
);
/** Suites swap reachability behavior per test; the hoisted mock factory reads the current value. */
export const gatewayReachableState: { mock: WaitForGatewayReachableMock } = { mock: undefined };

gatewayOnboardConfigSnapshotMock.mockImplementation(async () =>
  onboardTestConfigStore.readSnapshot(),
);

vi.mock("../config/io.js", () => ({
  createConfigIO: () => ({
    configPath: resolveTestConfigPath(),
  }),
  loadConfig: () => readTestConfig(),
  readConfigFileSnapshot: gatewayOnboardConfigSnapshotMock,
}));

vi.mock("../plugins/plugin-lifecycle-lease.js", () => ({
  withPluginLifecycleLease: async (
    _options: unknown,
    run: (lease: {
      databasePath: string;
      signal: AbortSignal;
      assertOwned: () => void;
      assertOwnedInTransaction: () => void;
    }) => Promise<unknown>,
  ) => {
    pluginLifecycleLeaseState.depth += 1;
    try {
      return await run({
        databasePath: path.join(path.dirname(resolveTestConfigPath()), "openclaw.sqlite"),
        signal: new AbortController().signal,
        assertOwned: () => {},
        assertOwnedInTransaction: () => {},
      });
    } finally {
      pluginLifecycleLeaseState.depth -= 1;
    }
  },
}));

export const capturedReplaceConfigFileCalls: Array<{
  nextConfig: OpenClawConfig;
  writeOptions?: { allowConfigSizeDrop?: boolean; unsetPaths?: string[][] };
}> = [];

vi.mock("../config/config.js", async (importActual) => {
  const actual = await importActual<typeof import("../config/config.js")>();
  return {
    replaceConfigFile: async ({
      nextConfig,
      writeOptions,
    }: {
      nextConfig: OpenClawConfig;
      writeOptions?: { allowConfigSizeDrop?: boolean; unsetPaths?: string[][] };
    }) => {
      configWritePluginLeaseDepths.push(pluginLifecycleLeaseState.depth);
      capturedReplaceConfigFileCalls.push({
        nextConfig,
        ...(writeOptions ? { writeOptions } : {}),
      });
      testConfigStore.set(resolveTestConfigPath(), nextConfig);
    },
    resolveConfigWriteAfterWrite: actual.resolveConfigWriteAfterWrite,
    resolveGatewayPort: (cfg: OpenClawConfig) => cfg.gateway?.port ?? 18789,
    transformConfigFileWithRetry: async (
      params: Parameters<typeof import("../config/config.js").transformConfigFileWithRetry>[0],
    ) => {
      const snapshot = await gatewayOnboardConfigSnapshotMock();
      const previousHash = snapshot.hash ?? null;
      const transformed = await params.transform(
        snapshot.sourceConfig,
        { snapshot, previousHash, attempt: 0 },
        {},
      );
      const committed = await params.commit!({
        nextConfig: transformed.nextConfig,
        snapshot,
        ...(previousHash ? { baseHash: previousHash } : {}),
        writeOptions: params.writeOptions,
        afterWrite: { mode: "auto" },
      });
      return { nextConfig: committed.config };
    },
  };
});

vi.mock("./onboard-agent.js", () => ({ ensureOnboardingAgent: mockOnboardingAgent }));

vi.mock("./onboard-helpers.js", () => {
  const normalizeGatewayTokenInput = (value: unknown): string => {
    if (typeof value !== "string") {
      return "";
    }
    const trimmed = value.trim();
    return trimmed === "undefined" || trimmed === "null" ? "" : trimmed;
  };
  return {
    DEFAULT_WORKSPACE: "/tmp/openclaw-workspace",
    applyWizardMetadata: (cfg: unknown) => cfg,
    ensureWorkspaceAndSessions: ensureWorkspaceAndSessionsMock,
    normalizeGatewayTokenInput,
    randomToken: () => "tok_generated_gateway_test_token",
    resolveControlUiLinks: ({ port }: { port: number }) => ({
      httpUrl: `http://127.0.0.1:${port}`,
      wsUrl: `ws://127.0.0.1:${port}`,
    }),
    resolveLocalControlUiProbeLinks: ({ port }: { port: number }) => ({
      httpUrl: `http://127.0.0.1:${port}`,
      wsUrl: `ws://127.0.0.1:${port}`,
    }),
    waitForGatewayReachable: (params: {
      url: string;
      token?: string;
      password?: string;
      deadlineMs?: number;
      probeTimeoutMs?: number;
    }) => gatewayReachableState.mock?.(params) ?? Promise.resolve({ ok: true }),
  };
});

vi.mock("./onboard-non-interactive/local/daemon-install.js", () => ({
  installGatewayDaemonNonInteractive: installGatewayDaemonNonInteractiveMock,
}));

vi.mock("./health.js", () => ({
  healthCommandNonExiting: healthCommandMock,
}));

vi.mock("../daemon/service.js", () => ({
  readGatewayServiceState: async () => {
    const [loadState, runtime] = await Promise.all([
      gatewayServiceMock
        .isLoaded()
        .then((loaded) =>
          loaded ? ({ status: "loaded" } as const) : ({ status: "not-loaded" } as const),
        )
        .catch((error: unknown) => ({ status: "unknown" as const, detail: String(error) })),
      gatewayServiceMock.readRuntime(),
    ]);
    return {
      installed: true,
      loadState,
      running: runtime.status === "running",
      env: {},
      command: null,
      runtime,
    };
  },
  resolveGatewayService: () => gatewayServiceMock,
}));

vi.mock("../daemon/diagnostics.js", () => ({
  readLastGatewayErrorLine: readLastGatewayErrorLineMock,
}));

export let runNonInteractiveSetup: typeof import("./onboard-non-interactive.js").runNonInteractiveSetup;

export async function loadGatewayOnboardModules(): Promise<void> {
  vi.resetModules();
  ({ runNonInteractiveSetup } = await import("./onboard-non-interactive.js"));
}

export const getPseudoPort = (base: number): number => base + (process.pid % 1000);

export const gatewayOnboardRuntime = createThrowingRuntime();

// vi.hoisted values cannot be exported at their declaration; re-export them here.
export {
  gatewayServiceMock,
  healthCommandMock,
  installGatewayDaemonNonInteractiveMock,
  gatewayOnboardConfigSnapshotMock,
  readLastGatewayErrorLineMock,
};

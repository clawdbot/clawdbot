/** Small runtime and orchestration helpers for the doctor E2E harness. */
import { vi } from "vitest";
import { defineMockFn, type MockFn } from "../test-utils/vitest-mock-fn.js";
import { createDoctorConfigSnapshot } from "./doctor-config-snapshot.test-helpers.js";

export type DoctorConfigSnapshotFixtureParams = {
  config?: Record<string, unknown>;
  parsed?: Record<string, unknown>;
  valid?: boolean;
  issues?: Array<{ path: string; message: string }>;
  legacyIssues?: Array<{ path: string; message: string }>;
};

export function setDoctorStdinTty(value: boolean | undefined): void {
  try {
    Object.defineProperty(process.stdin, "isTTY", {
      value,
      configurable: true,
    });
  } catch {
    // ignore
  }
}

export function createGatewayUpdateResult() {
  return {
    status: "skipped",
    mode: "unknown",
    steps: [],
    durationMs: 0,
  } as const;
}

export function createCommandWithTimeoutResult() {
  return {
    stdout: "",
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
  } as const;
}

export function createLegacyConfigSnapshot() {
  return {
    path: "/tmp/openclaw.json",
    exists: false,
    raw: null,
    parsed: {},
    valid: true,
    config: {},
    issues: [],
    legacyIssues: [],
  } as const;
}

export function createDoctorServiceMocks() {
  return {
    findLegacyGatewayServices: defineMockFn(vi.fn().mockResolvedValue([])),
    uninstallLegacyGatewayServices: defineMockFn(vi.fn().mockResolvedValue([])),
    findExtraGatewayServices: defineMockFn(vi.fn().mockResolvedValue([])),
    findSystemGatewayServices: defineMockFn(vi.fn().mockResolvedValue([])),
    renderGatewayServiceCleanupHints: defineMockFn(vi.fn().mockReturnValue(["cleanup"])),
    auditGatewayServiceConfig: defineMockFn(vi.fn().mockResolvedValue({ ok: true, issues: [] })),
    buildGatewayInstallPlan: defineMockFn(
      vi.mocked(
        vi.fn().mockResolvedValue({
          programArguments: ["node", "cli", "gateway", "--port", "18789"],
          workingDirectory: "/tmp",
          environment: {},
        }),
      ),
    ),
    resolveGatewayAuthTokenForService: defineMockFn(
      vi.fn().mockResolvedValue({ token: undefined }),
    ),
    resolveGatewayProgramArguments: defineMockFn(
      vi.fn().mockResolvedValue({
        programArguments: ["node", "cli", "gateway", "--port", "18789"],
      }),
    ),
    serviceInstall: defineMockFn(vi.fn().mockResolvedValue(undefined)),
    serviceIsLoaded: defineMockFn(vi.fn().mockResolvedValue(false)),
    serviceStop: defineMockFn(vi.fn().mockResolvedValue(undefined)),
    serviceRestart: defineMockFn(vi.fn().mockResolvedValue(undefined)),
    serviceUninstall: defineMockFn(vi.fn().mockResolvedValue(undefined)),
    serviceReadCommand: defineMockFn(vi.fn().mockResolvedValue(null)),
    callGateway: defineMockFn(vi.fn().mockRejectedValue(new Error("gateway closed"))),
  };
}

export function applyMockDoctorConfigSnapshot(
  readConfigFileSnapshot: MockFn,
  params: DoctorConfigSnapshotFixtureParams = {},
): void {
  readConfigFileSnapshot.mockResolvedValue(createDoctorConfigSnapshot(params));
}

export function createDoctorRuntime() {
  return {
    log: defineMockFn(vi.fn()),
    error: defineMockFn(vi.fn()),
    exit: defineMockFn(vi.fn()),
  };
}

export async function arrangeLegacyStateMigrationFixture(deps: {
  confirm: MockFn;
  createDetection: (params: { hasLegacySessions: boolean; preview: string[] }) => unknown;
  detectLegacyStateMigrations: MockFn;
  mockDoctorConfigSnapshot: () => void;
  runLegacyStateMigrations: MockFn;
}): Promise<{
  doctorCommand: unknown;
  runtime: { log: MockFn; error: MockFn; exit: MockFn };
  detectLegacyStateMigrations: MockFn;
  runLegacyStateMigrations: MockFn;
}> {
  deps.mockDoctorConfigSnapshot();

  const { doctorCommand } = await import("./doctor.js");
  const runtime = createDoctorRuntime();

  deps.detectLegacyStateMigrations.mockClear();
  deps.runLegacyStateMigrations.mockClear();
  deps.detectLegacyStateMigrations.mockResolvedValue(
    deps.createDetection({
      hasLegacySessions: true,
      preview: ["- Legacy sessions detected"],
    }),
  );
  deps.runLegacyStateMigrations.mockResolvedValueOnce({
    changes: ["migrated"],
    warnings: [],
  });
  deps.confirm.mockClear();

  return {
    doctorCommand,
    runtime,
    detectLegacyStateMigrations: deps.detectLegacyStateMigrations,
    runLegacyStateMigrations: deps.runLegacyStateMigrations,
  };
}

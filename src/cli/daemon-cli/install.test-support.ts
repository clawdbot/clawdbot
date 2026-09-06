// Shared daemon install test harness: mocks, module registrations, and assertion helpers.
import { expect, vi } from "vitest";
import type { ResolvedGatewayAuth } from "../../gateway/auth.js";
import { captureFullEnv } from "../../test-utils/env.js";
import { createCliRuntimeCapture } from "../test-runtime-capture.js";
import type { createDaemonInstallActionContext } from "./shared.js";

type DaemonActionResponse = Parameters<
  ReturnType<typeof createDaemonInstallActionContext>["emit"]
>[0];

const resolveNodeStartupTlsEnvironmentMock = vi.hoisted(() => vi.fn());
const loadConfigMock = vi.hoisted(() => vi.fn());
const readConfigFileSnapshotMock = vi.hoisted(() => vi.fn());
const resolveGatewayPortMock = vi.hoisted(() => vi.fn(() => 18789));
const replaceConfigFileMock = vi.hoisted(() => vi.fn());
const resolveSecretInputRefMock = vi.hoisted(() =>
  vi.fn((_value?: unknown): { ref: unknown } => ({ ref: undefined })),
);
const hasConfiguredSecretInputMock = vi.hoisted(() =>
  vi.fn((value: unknown): boolean => {
    if (typeof value === "string" && value.trim()) {
      return true;
    }
    return resolveSecretInputRefMock(value)?.ref != null;
  }),
);
const resolveGatewayAuthMock = vi.hoisted(() =>
  vi.fn<() => ResolvedGatewayAuth>(() => ({
    mode: "token",
    token: undefined,
    password: undefined,
    allowTailscale: false,
  })),
);
const resolveGatewayBindHostMock = vi.hoisted(() => vi.fn(async () => "127.0.0.1"));
const resolveSecretRefValuesMock = vi.hoisted(() => vi.fn());
const randomTokenMock = vi.hoisted(() => vi.fn(() => "generated-token"));
const createInstallPlanFixture = vi.hoisted(() => {
  return async (params?: {
    wrapperPath?: string;
    env?: Record<string, string | undefined>;
  }): Promise<{
    programArguments: string[];
    workingDirectory: string;
    environment: Record<string, string | undefined>;
    environmentValueSources?: Record<string, string | undefined>;
  }> => {
    const environment: Record<string, string | undefined> = {};
    if (params?.wrapperPath || params?.env?.OPENCLAW_WRAPPER) {
      environment.OPENCLAW_WRAPPER = params.wrapperPath ?? params.env?.OPENCLAW_WRAPPER;
    }
    return {
      programArguments: params?.wrapperPath
        ? [params.wrapperPath, "gateway", "run"]
        : ["openclaw", "gateway", "run"],
      workingDirectory: "/tmp",
      environment,
    };
  };
});
const buildGatewayInstallPlanMock = vi.hoisted(() => vi.fn(createInstallPlanFixture));
const parsePortMock = vi.hoisted(() => vi.fn(() => null));
const isGatewayDaemonRuntimeMock = vi.hoisted(() => vi.fn(() => true));
const installDaemonServiceAndEmitMock = vi.hoisted(() => vi.fn(async (_params?: unknown) => {}));
const readGatewayServiceCommandForMutationMock = vi.hoisted(() => vi.fn());

const actionState = vi.hoisted(() => ({
  warnings: [] as string[],
  emitted: [] as DaemonActionResponse[],
  failed: [] as Array<{ message: string; hints?: string[] }>,
}));

const service = vi.hoisted(() => ({
  label: "Gateway",
  loadedText: "loaded",
  notLoadedText: "not loaded",
  isLoaded: vi.fn(async () => false),
  stage: vi.fn(async () => {}),
  install: vi.fn(async () => {}),
  uninstall: vi.fn(async () => {}),
  restart: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  readDefinitionMutationCapability: vi.fn(async () => ({ kind: "writable" as const })),
  readCommand: vi.fn(async () => null),
  readRuntime: vi.fn(async () => ({ status: "stopped" as const })),
}));

vi.mock("../../bootstrap/node-startup-env.js", () => ({
  resolveNodeStartupTlsEnvironment: resolveNodeStartupTlsEnvironmentMock,
}));

vi.mock("../../config/io.js", () => ({
  loadConfig: loadConfigMock,
  readConfigFileSnapshotForWrite: vi.fn(async () => ({
    snapshot: await readConfigFileSnapshotMock(),
    writeOptions: { expectedConfigPath: "/tmp/openclaw.json" },
  })),
}));

vi.mock("../../config/mutate.js", () => ({
  replaceConfigFile: replaceConfigFileMock,
}));

vi.mock("../../config/paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/paths.js")>()),
  resolveGatewayPort: resolveGatewayPortMock,
}));

vi.mock("../../config/types.secrets.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/types.secrets.js")>();
  return {
    ...actual,
    coerceSecretRef: (value: unknown, defaults?: unknown) =>
      resolveSecretInputRefMock({ value, defaults })?.ref ?? null,
    hasConfiguredSecretInput: hasConfiguredSecretInputMock,
    resolveSecretInputRef: resolveSecretInputRefMock,
  };
});

vi.mock("../../gateway/auth.js", () => ({
  resolveGatewayAuth: resolveGatewayAuthMock,
}));

vi.mock("../../gateway/net.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../gateway/net.js")>();
  return {
    ...actual,
    resolveGatewayBindHost: resolveGatewayBindHostMock,
  };
});

vi.mock("../../secrets/resolve.js", () => ({
  resolveSecretRefValues: resolveSecretRefValuesMock,
}));

vi.mock("../../commands/random-token.js", () => ({
  randomToken: randomTokenMock,
}));

vi.mock("../../commands/daemon-install-helpers.js", () => ({
  buildGatewayInstallPlan: buildGatewayInstallPlanMock,
}));

vi.mock("../../daemon/program-args.js", () => ({
  OPENCLAW_WRAPPER_ENV_KEY: "OPENCLAW_WRAPPER",
  resolveOpenClawWrapperPath: async (value: string | undefined) => value?.trim() || undefined,
}));

vi.mock("./shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared.js")>()),
  parsePort: parsePortMock,
  createDaemonInstallActionContext: (jsonFlag: unknown) => {
    const json = Boolean(jsonFlag);
    return {
      json,
      stdout: process.stdout,
      warnings: actionState.warnings,
      emit: (payload: DaemonActionResponse) => {
        actionState.emitted.push(payload);
      },
      fail: (message: string, hints?: string[]) => {
        actionState.failed.push({ message, hints });
      },
    };
  },
}));
vi.mock("../../commands/daemon-runtime.js", () => ({
  DEFAULT_GATEWAY_DAEMON_RUNTIME: "node",
  isGatewayDaemonRuntime: isGatewayDaemonRuntimeMock,
}));

vi.mock("../../daemon/service.js", () => ({
  readGatewayServiceCommandForMutation: readGatewayServiceCommandForMutationMock,
  resolveGatewayService: () => service,
}));

vi.mock("./response.js", () => ({
  buildDaemonServiceSnapshot: vi.fn(),
  installDaemonServiceAndEmit: installDaemonServiceAndEmitMock,
}));

const { defaultRuntime, resetRuntimeCapture } = createCliRuntimeCapture();
vi.mock("../../runtime.js", () => ({
  defaultRuntime,
}));

function expectFirstInstallPlanCallOmitsToken() {
  const firstArg = readFirstInstallPlanArg();
  expect("token" in firstArg).toBe(false);
}

function expectFields(value: unknown, expected: Record<string, unknown>): void {
  if (!value || typeof value !== "object") {
    throw new Error("expected fields object");
  }
  const record = value as Record<string, unknown>;
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key], key).toEqual(expectedValue);
  }
}

function readFirstInstallPlanArg(): Record<string, unknown> {
  const [firstArg] = buildGatewayInstallPlanMock.mock.calls[0] ?? [];
  if (!firstArg) {
    throw new Error("Expected gateway install plan arg");
  }
  return firstArg as Record<string, unknown>;
}

function readFirstConfigWriteParams(): {
  nextConfig?: { gateway?: { mode?: string; auth?: { token?: string } } };
} {
  const [params] = replaceConfigFileMock.mock.calls[0] ?? [];
  if (!params || typeof params !== "object") {
    throw new Error("expected first config write params");
  }
  return params as { nextConfig?: { gateway?: { mode?: string; auth?: { token?: string } } } };
}

function readFirstNodeStartupTlsEnvironmentArg(): Record<string, unknown> {
  const [params] = resolveNodeStartupTlsEnvironmentMock.mock.calls[0] ?? [];
  if (!params || typeof params !== "object") {
    throw new Error("expected node startup TLS environment params");
  }
  return params as Record<string, unknown>;
}

function expectLastEmittedResult(result: string): void {
  expectFields(actionState.emitted.at(-1), { result });
}

function mockResolvedGatewayTokenSecretRef() {
  resolveSecretInputRefMock.mockReturnValue({
    ref: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_TOKEN" },
  });
  resolveSecretRefValuesMock.mockResolvedValue(
    new Map([["env:default:OPENCLAW_GATEWAY_TOKEN", "resolved-from-secretref"]]),
  );
}

const { runDaemonInstall } = await import("./install.js");
const envSnapshot = captureFullEnv();
const originalPlatform = process.platform;

export {
  actionState,
  buildGatewayInstallPlanMock,
  createInstallPlanFixture,
  envSnapshot,
  expectFields,
  expectFirstInstallPlanCallOmitsToken,
  expectLastEmittedResult,
  installDaemonServiceAndEmitMock,
  isGatewayDaemonRuntimeMock,
  loadConfigMock,
  mockResolvedGatewayTokenSecretRef,
  originalPlatform,
  parsePortMock,
  randomTokenMock,
  readConfigFileSnapshotMock,
  readFirstConfigWriteParams,
  readFirstInstallPlanArg,
  readFirstNodeStartupTlsEnvironmentArg,
  readGatewayServiceCommandForMutationMock,
  replaceConfigFileMock,
  resetRuntimeCapture,
  resolveGatewayAuthMock,
  resolveGatewayBindHostMock,
  resolveGatewayPortMock,
  resolveNodeStartupTlsEnvironmentMock,
  resolveSecretInputRefMock,
  resolveSecretRefValuesMock,
  runDaemonInstall,
  service,
};

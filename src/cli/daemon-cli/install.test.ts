import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureFullEnv } from "../../test-utils/env.js";
import { createCliRuntimeCapture } from "../test-runtime-capture.js";
import type { DaemonActionResponse } from "./response.js";

const resolveNodeStartupTlsEnvironmentMock = vi.hoisted(() => vi.fn());
const loadConfigMock = vi.hoisted(() => vi.fn());
const readConfigFileSnapshotMock = vi.hoisted(() => vi.fn());
const resolveGatewayPortMock = vi.hoisted(() => vi.fn(() => 18789));
const writeConfigFileMock = vi.hoisted(() => vi.fn());
const resolveIsNixModeMock = vi.hoisted(() => vi.fn(() => false));
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
  vi.fn(() => ({
    mode: "token",
    token: undefined,
    password: undefined,
    allowTailscale: false,
  })),
);
const resolveSecretRefValuesMock = vi.hoisted(() => vi.fn());
const randomTokenMock = vi.hoisted(() => vi.fn(() => "generated-token"));
const buildGatewayInstallPlanMock = vi.hoisted(() =>
  vi.fn(async () => ({
    programArguments: ["openclaw", "gateway", "run"],
    workingDirectory: "/tmp",
    environment: {},
  })),
);
const parsePortMock = vi.hoisted(() => vi.fn(() => null));
const isGatewayDaemonRuntimeMock = vi.hoisted(() => vi.fn(() => true));
const installDaemonServiceAndEmitMock = vi.hoisted(() => vi.fn(async () => {}));

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

vi.mock("../../config/paths.js", () => ({
  resolveGatewayPort: resolveGatewayPortMock,
  resolveIsNixMode: resolveIsNixModeMock,
}));

vi.mock("../../commands/gateway-install-token.persist.runtime.js", () => ({
  readConfigFileSnapshot: readConfigFileSnapshotMock,
  readConfigFileSnapshotForWrite: vi.fn(async () => ({
    snapshot: await readConfigFileSnapshotMock(),
    writeOptions: { expectedConfigPath: "/tmp/openclaw.json" },
  })),
  writeConfigFile: writeConfigFileMock,
}));

vi.mock("../../config/types.secrets.js", () => ({
  hasConfiguredSecretInput: hasConfiguredSecretInputMock,
  resolveSecretInputRef: resolveSecretInputRefMock,
}));

vi.mock("../../gateway/auth.js", () => ({
  resolveGatewayAuth: resolveGatewayAuthMock,
}));

vi.mock("../../secrets/resolve.js", () => ({
  resolveSecretRefValues: resolveSecretRefValuesMock,
}));

vi.mock("../../commands/random-token.js", () => ({
  randomToken: randomTokenMock,
}));

vi.mock("../../commands/daemon-install-helpers.js", () => ({
  buildGatewayInstallPlan: buildGatewayInstallPlanMock,
}));

vi.mock("./shared.js", () => ({
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
  failIfNixDaemonInstallMode: (fail: (message: string, hints?: string[]) => void) => {
    if (!resolveIsNixModeMock()) {
      return false;
    }
    fail("Nix mode detected; service install is disabled.");
    return true;
  },
}));
vi.mock("../../commands/daemon-runtime.js", () => ({
  DEFAULT_GATEWAY_DAEMON_RUNTIME: "node",
  isGatewayDaemonRuntime: isGatewayDaemonRuntimeMock,
}));

vi.mock("../../daemon/service.js", () => ({
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
  const [firstArg] =
    (buildGatewayInstallPlanMock.mock.calls.at(0) as [Record<string, unknown>] | undefined) ?? [];
  expect(firstArg).toBeDefined();
  expect(firstArg && "token" in firstArg).toBe(false);
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

describe("runDaemonInstall", () => {
  beforeEach(() => {
    loadConfigMock.mockReset();
    resolveNodeStartupTlsEnvironmentMock.mockReset();
    readConfigFileSnapshotMock.mockReset();
    resolveGatewayPortMock.mockClear();
    writeConfigFileMock.mockReset();
    resolveIsNixModeMock.mockReset();
    resolveSecretInputRefMock.mockReset();
    resolveGatewayAuthMock.mockReset();
    resolveSecretRefValuesMock.mockReset();
    randomTokenMock.mockReset();
    buildGatewayInstallPlanMock.mockReset();
    parsePortMock.mockReset();
    isGatewayDaemonRuntimeMock.mockReset();
    installDaemonServiceAndEmitMock.mockReset();
    service.isLoaded.mockReset();
    service.stage.mockReset();
    resetRuntimeCapture();
    actionState.warnings.length = 0;
    actionState.emitted.length = 0;
    actionState.failed.length = 0;

    loadConfigMock.mockReturnValue({ gateway: { auth: { mode: "token" } } });
    readConfigFileSnapshotMock.mockResolvedValue({
      exists: false,
      valid: true,
      config: {},
      sourceConfig: { gateway: { auth: { mode: "token" } } },
    });
    resolveGatewayPortMock.mockReturnValue(18789);
    resolveIsNixModeMock.mockReturnValue(false);
    resolveSecretInputRefMock.mockReturnValue({ ref: undefined });
    resolveGatewayAuthMock.mockReturnValue({
      mode: "token",
      token: undefined,
      password: undefined,
      allowTailscale: false,
    });
    resolveSecretRefValuesMock.mockResolvedValue(new Map());
    randomTokenMock.mockReturnValue("generated-token");
    buildGatewayInstallPlanMock.mockResolvedValue({
      programArguments: ["openclaw", "gateway", "run"],
      workingDirectory: "/tmp",
      environment: {},
    });
    parsePortMock.mockReturnValue(null);
    isGatewayDaemonRuntimeMock.mockReturnValue(true);
    installDaemonServiceAndEmitMock.mockResolvedValue(undefined);
    service.isLoaded.mockResolvedValue(false);
    service.stage.mockResolvedValue(undefined);
    service.readCommand.mockResolvedValue(null);
    resolveNodeStartupTlsEnvironmentMock.mockReturnValue({
      NODE_EXTRA_CA_CERTS: undefined,
      NODE_USE_SYSTEM_CA: undefined,
    });
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
  });

  afterEach(() => {
    envSnapshot.restore();
  });

  it("fails install when token auth requires an unresolved token SecretRef", async () => {
    resolveSecretInputRefMock.mockReturnValue({
      ref: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_TOKEN" },
    });
    resolveSecretRefValuesMock.mockRejectedValue(new Error("secret unavailable"));

    await runDaemonInstall({ json: true });

    expect(actionState.failed[0]?.message).toContain("gateway.auth.token SecretRef is configured");
    expect(actionState.failed[0]?.message).toContain("unresolved");
    expect(buildGatewayInstallPlanMock).not.toHaveBeenCalled();
    expect(installDaemonServiceAndEmitMock).not.toHaveBeenCalled();
  });

  it("validates token SecretRef but does not serialize resolved token into service env", async () => {
    mockResolvedGatewayTokenSecretRef();

    await runDaemonInstall({ json: true });

    expect(actionState.failed).toEqual([]);
    expect(buildGatewayInstallPlanMock).toHaveBeenCalledTimes(1);
    expectFirstInstallPlanCallOmitsToken();
    expect(writeConfigFileMock).not.toHaveBeenCalled();
    expect(
      actionState.warnings.some((warning) =>
        warning.includes("gateway.auth.token is SecretRef-managed"),
      ),
    ).toBe(true);
  });

  it("does not treat env-template gateway.auth.token as plaintext during install", async () => {
    loadConfigMock.mockReturnValue({
      gateway: { auth: { mode: "token", token: "${OPENCLAW_GATEWAY_TOKEN}" } },
    });
    mockResolvedGatewayTokenSecretRef();

    await runDaemonInstall({ json: true });

    expect(actionState.failed).toEqual([]);
    expect(resolveSecretRefValuesMock).toHaveBeenCalledTimes(1);
    expect(buildGatewayInstallPlanMock).toHaveBeenCalledTimes(1);
    expectFirstInstallPlanCallOmitsToken();
  });

  it("auto-mints and persists token when no source exists", async () => {
    randomTokenMock.mockReturnValue("minted-token");
    readConfigFileSnapshotMock.mockResolvedValue({
      exists: true,
      valid: true,
      config: { gateway: { auth: { mode: "token" } } },
      sourceConfig: { gateway: { auth: { mode: "token" } } },
    });

    await runDaemonInstall({ json: true });

    expect(actionState.failed).toEqual([]);
    expect(writeConfigFileMock).toHaveBeenCalledTimes(1);
    const writtenConfig = writeConfigFileMock.mock.calls[0]?.[0] as {
      gateway?: { auth?: { token?: string } };
    };
    expect(writtenConfig.gateway?.auth?.token).toBe("minted-token");
    expect(buildGatewayInstallPlanMock).toHaveBeenCalledWith(
      expect.objectContaining({ port: 18789 }),
    );
    expectFirstInstallPlanCallOmitsToken();
    expect(installDaemonServiceAndEmitMock).toHaveBeenCalledTimes(1);
    expect(actionState.warnings.some((warning) => warning.includes("Auto-generated"))).toBe(true);
  });

  it("continues Linux install when service probe hits a non-fatal systemd bus failure", async () => {
    service.isLoaded.mockRejectedValueOnce(
      new Error("systemctl is-enabled unavailable: Failed to connect to bus"),
    );

    await runDaemonInstall({ json: true });

    expect(actionState.failed).toEqual([]);
    expect(installDaemonServiceAndEmitMock).toHaveBeenCalledTimes(1);
  });

  it("fails install when service probe reports an unrelated error", async () => {
    service.isLoaded.mockRejectedValueOnce(
      new Error("systemctl is-enabled unavailable: read-only file system"),
    );

    await runDaemonInstall({ json: true });

    expect(actionState.failed[0]?.message).toContain("Gateway service check failed");
    expect(actionState.failed[0]?.message).toContain("read-only file system");
    expect(installDaemonServiceAndEmitMock).not.toHaveBeenCalled();
  });

  it("returns already-installed when the service already has the expected TLS env", async () => {
    service.isLoaded.mockResolvedValue(true);
    resolveNodeStartupTlsEnvironmentMock.mockReturnValue({
      NODE_EXTRA_CA_CERTS: "/etc/ssl/certs/ca-certificates.crt",
      NODE_USE_SYSTEM_CA: undefined,
    });
    service.readCommand.mockResolvedValue({
      programArguments: ["openclaw", "gateway", "run"],
      environment: {
        NODE_EXTRA_CA_CERTS: "/etc/ssl/certs/ca-certificates.crt",
      },
    } as never);

    await runDaemonInstall({ json: true });

    expect(installDaemonServiceAndEmitMock).not.toHaveBeenCalled();
    expect(actionState.emitted.at(-1)).toMatchObject({ result: "already-installed" });
  });

  it("reinstalls when an existing service is missing the nvm TLS CA bundle", async () => {
    service.isLoaded.mockResolvedValue(true);
    resolveNodeStartupTlsEnvironmentMock.mockReturnValue({
      NODE_EXTRA_CA_CERTS: "/etc/ssl/certs/ca-certificates.crt",
      NODE_USE_SYSTEM_CA: undefined,
    });
    service.readCommand.mockResolvedValue({
      programArguments: ["openclaw", "gateway", "run"],
      environment: {},
    } as never);

    await runDaemonInstall({ json: true });

    expect(installDaemonServiceAndEmitMock).toHaveBeenCalledTimes(1);
  });

  it("reinstalls when the installed service still runs from nvm even if the installer runtime does not", async () => {
    service.isLoaded.mockResolvedValue(true);
    resolveNodeStartupTlsEnvironmentMock.mockImplementation(({ execPath }) => ({
      NODE_EXTRA_CA_CERTS:
        typeof execPath === "string" && execPath.includes("/.nvm/")
          ? "/etc/ssl/certs/ca-certificates.crt"
          : undefined,
      NODE_USE_SYSTEM_CA: undefined,
    }));
    service.readCommand.mockResolvedValue({
      programArguments: ["/home/test/.nvm/versions/node/v22.18.0/bin/node", "dist/entry.js"],
      environment: {},
    } as never);

    await runDaemonInstall({ json: true });

    expect(installDaemonServiceAndEmitMock).toHaveBeenCalledTimes(1);
    expect(resolveNodeStartupTlsEnvironmentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        execPath: "/home/test/.nvm/versions/node/v22.18.0/bin/node",
      }),
    );
  });

  it("reuses env-backed service secrets during forced reinstall when the current shell is missing them", async () => {
    service.isLoaded.mockResolvedValue(true);
    service.readCommand.mockResolvedValue({
      programArguments: ["openclaw", "gateway", "run"],
      environment: {
        OPENAI_API_KEY: "service-openai-key",
      },
    } as never);
    const previous = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      await runDaemonInstall({ json: true, force: true });

      expect(buildGatewayInstallPlanMock).toHaveBeenCalledWith(
        expect.objectContaining({
          env: expect.objectContaining({
            OPENAI_API_KEY: "service-openai-key",
          }),
        }),
      );
      expect(installDaemonServiceAndEmitMock).toHaveBeenCalledTimes(1);
    } finally {
      if (previous === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previous;
      }
    }
  });

  it("does not reuse stale service control env during forced reinstall", async () => {
    service.isLoaded.mockResolvedValue(true);
    service.readCommand.mockResolvedValue({
      programArguments: ["openclaw", "gateway", "run"],
      environment: {
        OPENCLAW_STATE_DIR: "/tmp/openclaw-doctor-manual",
        OPENCLAW_CONFIG_PATH: "/tmp/openclaw-doctor-manual/openclaw.json",
        OPENCLAW_GATEWAY_TOKEN: "stale-service-token",
        PATH: "/tmp/doctor-bin:/usr/bin",
        NODE_OPTIONS: "--require /tmp/evil.js",
        OPENAI_API_KEY: "service-openai-key",
      },
    } as never);

    await runDaemonInstall({ json: true, force: true });

    expect(buildGatewayInstallPlanMock).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          OPENAI_API_KEY: "service-openai-key",
        }),
      }),
    );
    const [firstArg] =
      (buildGatewayInstallPlanMock.mock.calls.at(0) as [Record<string, unknown>] | undefined) ?? [];
    const env = firstArg?.env as Record<string, string | undefined>;
    expect(env.OPENCLAW_STATE_DIR).toBeUndefined();
    expect(env.OPENCLAW_CONFIG_PATH).toBeUndefined();
    expect(env.OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.PATH).not.toContain("/tmp/doctor-bin");
    expect(installDaemonServiceAndEmitMock).toHaveBeenCalledTimes(1);
  });
});

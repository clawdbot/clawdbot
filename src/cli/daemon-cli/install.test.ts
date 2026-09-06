// Daemon install tests cover service install command behavior and plan handling.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockSystemAccountHome } from "../../daemon/service.test-helpers.js";
import {
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
} from "./install.test-support.js";

describe("runDaemonInstall", () => {
  beforeEach(() => {
    loadConfigMock.mockReset();
    resolveNodeStartupTlsEnvironmentMock.mockReset();
    readConfigFileSnapshotMock.mockReset();
    resolveGatewayPortMock.mockClear();
    mockSystemAccountHome();
    replaceConfigFileMock.mockReset();
    resolveSecretInputRefMock.mockReset();
    resolveGatewayAuthMock.mockReset();
    resolveGatewayBindHostMock.mockReset();
    resolveSecretRefValuesMock.mockReset();
    randomTokenMock.mockReset();
    buildGatewayInstallPlanMock.mockReset();
    parsePortMock.mockReset();
    isGatewayDaemonRuntimeMock.mockReset();
    installDaemonServiceAndEmitMock.mockReset();
    readGatewayServiceCommandForMutationMock.mockReset();
    service.isLoaded.mockReset();
    service.stage.mockReset();
    service.install.mockReset();
    service.readDefinitionMutationCapability.mockReset();
    service.readCommand.mockReset();
    resetRuntimeCapture();
    actionState.warnings.length = 0;
    actionState.emitted.length = 0;
    actionState.failed.length = 0;

    loadConfigMock.mockReturnValue({ gateway: { mode: "local", auth: { mode: "token" } } });
    readConfigFileSnapshotMock.mockResolvedValue({
      exists: false,
      valid: true,
      config: {},
      sourceConfig: { gateway: { mode: "local", auth: { mode: "token" } } },
    });
    resolveGatewayPortMock.mockReturnValue(18789);
    delete process.env.OPENCLAW_NIX_MODE;
    resolveSecretInputRefMock.mockReturnValue({ ref: undefined });
    resolveGatewayAuthMock.mockReturnValue({
      mode: "token",
      token: undefined,
      password: undefined,
      allowTailscale: false,
    });
    resolveGatewayBindHostMock.mockResolvedValue("127.0.0.1");
    resolveSecretRefValuesMock.mockResolvedValue(new Map());
    randomTokenMock.mockReturnValue("generated-token");
    buildGatewayInstallPlanMock.mockImplementation(createInstallPlanFixture);
    parsePortMock.mockReturnValue(null);
    isGatewayDaemonRuntimeMock.mockReturnValue(true);
    installDaemonServiceAndEmitMock.mockResolvedValue(undefined);
    service.isLoaded.mockResolvedValue(false);
    service.stage.mockResolvedValue(undefined);
    service.install.mockResolvedValue(undefined);
    service.readDefinitionMutationCapability.mockResolvedValue({ kind: "writable" });
    service.readCommand.mockResolvedValue(null);
    readGatewayServiceCommandForMutationMock.mockImplementation(async () => {
      const command = await service.readCommand();
      return command === null ? { kind: "missing", command: null } : { kind: "current", command };
    });
    resolveNodeStartupTlsEnvironmentMock.mockReturnValue({
      NODE_EXTRA_CA_CERTS: undefined,
      NODE_USE_SYSTEM_CA: undefined,
    });
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    envSnapshot.restore();
    Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
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

  it("blocks external-supervisor installs before reading or mutating config", async () => {
    process.env.OPENCLAW_SUPERVISOR_MODE = "external";

    await runDaemonInstall({ json: true });

    expect(actionState.failed[0]?.message).toContain(
      "gateway lifecycle is managed by an external supervisor",
    );
    expect(readConfigFileSnapshotMock).not.toHaveBeenCalled();
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
    expect(service.isLoaded).not.toHaveBeenCalled();
    expect(installDaemonServiceAndEmitMock).not.toHaveBeenCalled();
  });

  it("blocks sudo-to-root systemd installs before persistent mutation", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.spyOn(process, "geteuid").mockReturnValue(0);
    process.env.HOME = "/root";
    process.env.USER = "root";
    process.env.LOGNAME = "root";
    process.env.SUDO_USER = "operator";
    delete process.env.XDG_RUNTIME_DIR;
    delete process.env.DBUS_SESSION_BUS_ADDRESS;

    await runDaemonInstall({ json: true });

    expect(actionState.failed[0]?.message).toContain("Rerun the same command without sudo");
    expect(actionState.failed[0]?.message).toContain("chmod go-w <path>");
    expect(actionState.failed[0]?.message).toContain(
      "https://docs.openclaw.ai/cli/gateway#install-identity",
    );
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
    expect(randomTokenMock).not.toHaveBeenCalled();
    expect(installDaemonServiceAndEmitMock).not.toHaveBeenCalled();
  });

  it("blocks inaccessible definitions before config reads or credential generation", async () => {
    service.readDefinitionMutationCapability.mockRejectedValueOnce(new Error("secret-canary"));
    await runDaemonInstall({ json: true, force: true });
    expect(actionState.failed[0]?.message).toContain("SERVICE_DEFINITION_UNKNOWN");
    expect(readConfigFileSnapshotMock).not.toHaveBeenCalled();
    expect(randomTokenMock).not.toHaveBeenCalled();
    expect(service.readCommand).toHaveBeenCalledOnce();
  });

  it("blocks non-default install identities before inspecting host services", async () => {
    process.env.OPENCLAW_STATE_DIR = "/tmp/openclaw-non-default-service-state";

    await runDaemonInstall({ json: true });

    expect(actionState.failed[0]?.message).toContain(
      "service management skipped: non-default state dir or config path",
    );
    expect(readConfigFileSnapshotMock).not.toHaveBeenCalled();
    expect(service.isLoaded).not.toHaveBeenCalled();
    expect(service.readCommand).not.toHaveBeenCalled();
    expect(installDaemonServiceAndEmitMock).not.toHaveBeenCalled();
  });

  it("validates token SecretRef but does not serialize resolved token into service env", async () => {
    mockResolvedGatewayTokenSecretRef();

    await runDaemonInstall({ json: true });

    expect(actionState.failed).toStrictEqual([]);
    expect(buildGatewayInstallPlanMock).toHaveBeenCalledTimes(1);
    expectFirstInstallPlanCallOmitsToken();
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
    expect(
      actionState.warnings.some((warning) =>
        warning.includes("gateway.auth.token is SecretRef-managed"),
      ),
    ).toBe(true);
  });

  it("passes service environment value sources through to service install", async () => {
    buildGatewayInstallPlanMock.mockResolvedValueOnce({
      programArguments: ["openclaw", "gateway", "run"],
      workingDirectory: "/tmp",
      environment: {
        OPENROUTER_API_KEY: "or-operator-key",
      },
      environmentValueSources: {
        OPENROUTER_API_KEY: "file",
      },
    });
    installDaemonServiceAndEmitMock.mockImplementationOnce(async (params?: unknown) => {
      await (params as { install: () => Promise<void> }).install();
    });

    await runDaemonInstall({ json: true });

    const installCalls = service.install.mock.calls as unknown as Array<
      [
        {
          environment?: Record<string, string>;
          environmentValueSources?: Record<string, string>;
        },
      ]
    >;
    const installOptions = installCalls[0]?.[0] as
      | {
          environment?: Record<string, string>;
          environmentValueSources?: Record<string, string>;
        }
      | undefined;
    expect(installOptions?.environment).toEqual({
      OPENROUTER_API_KEY: "or-operator-key",
    });
    expect(installOptions?.environmentValueSources).toEqual({
      OPENROUTER_API_KEY: "file",
    });
  });

  it("captures service install warnings in json install output", async () => {
    installDaemonServiceAndEmitMock.mockImplementationOnce(async (params?: unknown) => {
      await (params as { install: () => Promise<void> }).install();
    });
    service.install.mockImplementationOnce(async (args?: unknown) => {
      (args as { warn?: (message: string) => void }).warn?.(
        "Existing generated LaunchAgent env wrapper contains custom behavior and will be overwritten.",
      );
    });

    await runDaemonInstall({ json: true, force: true });

    expect(actionState.warnings).toContain(
      "Existing generated LaunchAgent env wrapper contains custom behavior and will be overwritten.",
    );
  });

  it("does not treat env-template gateway.auth.token as plaintext during install", async () => {
    loadConfigMock.mockReturnValue({
      gateway: { auth: { mode: "token", token: "${OPENCLAW_GATEWAY_TOKEN}" } },
    });
    mockResolvedGatewayTokenSecretRef();

    await runDaemonInstall({ json: true });

    expect(actionState.failed).toStrictEqual([]);
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
      sourceConfig: { gateway: { mode: "local", auth: { mode: "token" } } },
    });

    await runDaemonInstall({ json: true });

    expect(actionState.failed).toStrictEqual([]);
    expect(replaceConfigFileMock).toHaveBeenCalledTimes(1);
    const writeParams = readFirstConfigWriteParams();
    expect(writeParams.nextConfig?.gateway?.auth?.token).toBe("minted-token");
    expectFields(readFirstInstallPlanArg(), { port: 18789 });
    expectFirstInstallPlanCallOmitsToken();
    expect(installDaemonServiceAndEmitMock).toHaveBeenCalledTimes(1);
    expect(actionState.warnings.join("\n")).toContain("Auto-generated");
  });

  it("persists local gateway mode when installing from config missing gateway.mode", async () => {
    readConfigFileSnapshotMock
      .mockResolvedValueOnce({
        exists: true,
        valid: true,
        config: { gateway: { auth: { mode: "token", token: "durable-token" } } },
        sourceConfig: { gateway: { auth: { mode: "token", token: "durable-token" } } },
      })
      .mockResolvedValue({
        exists: true,
        valid: true,
        config: {
          gateway: { mode: "local", auth: { mode: "token", token: "durable-token" } },
        },
        sourceConfig: {
          gateway: { mode: "local", auth: { mode: "token", token: "durable-token" } },
        },
      });
    resolveGatewayAuthMock.mockReturnValue({
      mode: "token",
      token: "durable-token",
      password: undefined,
      allowTailscale: false,
    });

    await runDaemonInstall({ json: true });

    expect(actionState.failed).toStrictEqual([]);
    expect(replaceConfigFileMock).toHaveBeenCalledTimes(1);
    expect(readFirstConfigWriteParams().nextConfig?.gateway?.mode).toBe("local");
    expect(actionState.warnings).toContain(
      "No gateway.mode found. Set gateway.mode=local for managed gateway install.",
    );
    expectFields(readFirstInstallPlanArg().config as Record<string, unknown>, {
      gateway: {
        mode: "local",
        auth: { mode: "token", token: "durable-token" },
      },
    });
  });

  it("blocks managed install when explicit no-auth would bind to LAN", async () => {
    const config = {
      gateway: {
        mode: "local",
        bind: "lan",
        auth: {
          mode: "none",
          token: "test-token",
        },
      },
    };
    readConfigFileSnapshotMock.mockResolvedValue({
      exists: true,
      valid: true,
      config,
      sourceConfig: config,
    });
    resolveGatewayAuthMock.mockReturnValue({
      mode: "none",
      token: "test-token",
      password: undefined,
      allowTailscale: false,
    });
    resolveGatewayBindHostMock.mockResolvedValue("0.0.0.0");

    await runDaemonInstall({ json: true });

    expect(actionState.failed[0]?.message).toContain("Gateway install blocked");
    expect(actionState.failed[0]?.message).toContain("gateway.bind=lan");
    expect(actionState.failed[0]?.message).toContain("gateway.auth.mode=none");
    expect(actionState.failed[0]?.message).toContain("openclaw config set gateway.auth.mode token");
    expect(buildGatewayInstallPlanMock).not.toHaveBeenCalled();
    expect(installDaemonServiceAndEmitMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "custom bind resolving to a network interface",
      bind: "custom" as const,
      customBindHost: "192.168.1.20",
      resolvedHost: "192.168.1.20",
      blocked: true,
      message: undefined,
    },
    {
      name: "tailnet bind resolving to a tailnet interface",
      bind: "tailnet" as const,
      customBindHost: undefined,
      resolvedHost: "100.64.0.20",
      blocked: true,
      message: undefined,
    },
    {
      name: "tailnet bind falling back to loopback",
      bind: "tailnet" as const,
      customBindHost: undefined,
      resolvedHost: "127.0.0.1",
      blocked: true,
      message: "can later resolve to a Tailnet interface",
    },
    {
      name: "loopback bind",
      bind: "loopback" as const,
      customBindHost: undefined,
      resolvedHost: "127.0.0.1",
      blocked: false,
      message: undefined,
    },
  ])("handles explicit no-auth for $name", async (testCase) => {
    const config = {
      gateway: {
        mode: "local" as const,
        bind: testCase.bind,
        customBindHost: testCase.customBindHost,
        auth: { mode: "none" as const },
      },
    };
    readConfigFileSnapshotMock.mockResolvedValue({
      exists: true,
      valid: true,
      config,
      sourceConfig: config,
    });
    resolveGatewayAuthMock.mockReturnValue({
      mode: "none",
      token: undefined,
      password: undefined,
      allowTailscale: false,
    });
    resolveGatewayBindHostMock.mockResolvedValue(testCase.resolvedHost);

    await runDaemonInstall({ json: true });

    expect(resolveGatewayBindHostMock).toHaveBeenCalledWith(testCase.bind, testCase.customBindHost);
    if (testCase.blocked) {
      expect(actionState.failed[0]?.message).toContain(`gateway.bind=${testCase.bind}`);
      if (testCase.message) {
        expect(actionState.failed[0]?.message).toContain(testCase.message);
      }
      expect(buildGatewayInstallPlanMock).not.toHaveBeenCalled();
      expect(installDaemonServiceAndEmitMock).not.toHaveBeenCalled();
    } else {
      expect(actionState.failed).toStrictEqual([]);
      expect(buildGatewayInstallPlanMock).toHaveBeenCalledTimes(1);
      expect(installDaemonServiceAndEmitMock).toHaveBeenCalledTimes(1);
    }
  });

  it("allows a managed LAN install with trusted-proxy auth", async () => {
    const config = {
      gateway: {
        mode: "local" as const,
        bind: "lan" as const,
        trustedProxies: ["127.0.0.1"],
        auth: { mode: "trusted-proxy" as const },
      },
    };
    readConfigFileSnapshotMock.mockResolvedValue({
      exists: true,
      valid: true,
      config,
      sourceConfig: config,
    });
    resolveGatewayAuthMock.mockReturnValue({
      mode: "trusted-proxy",
      token: undefined,
      password: undefined,
      allowTailscale: false,
    });
    resolveGatewayBindHostMock.mockResolvedValue("0.0.0.0");

    await runDaemonInstall({ json: true });

    expect(actionState.failed).toStrictEqual([]);
    expect(buildGatewayInstallPlanMock).toHaveBeenCalledTimes(1);
    expect(installDaemonServiceAndEmitMock).toHaveBeenCalledTimes(1);
  });

  it("does not persist gateway mode when runtime validation fails", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({
      exists: true,
      valid: true,
      config: { gateway: { auth: { mode: "token", token: "durable-token" } } },
      sourceConfig: { gateway: { auth: { mode: "token", token: "durable-token" } } },
    });
    isGatewayDaemonRuntimeMock.mockReturnValue(false);

    await runDaemonInstall({ json: true, runtime: "bogus" });

    expect(actionState.failed[0]?.message).toContain("Invalid --runtime");
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
    expect(installDaemonServiceAndEmitMock).not.toHaveBeenCalled();
  });

  it("forwards Bun as the explicit managed-service runtime", async () => {
    await runDaemonInstall({ json: true, runtime: "bun" });

    expect(readFirstInstallPlanArg().runtime).toBe("bun");
    expect(actionState.failed).toStrictEqual([]);
  });

  it("continues Linux install when service probe hits a non-fatal systemd bus failure", async () => {
    service.isLoaded.mockRejectedValueOnce(
      new Error("systemctl is-enabled unavailable: Failed to connect to bus"),
    );

    await runDaemonInstall({ json: true });

    expect(actionState.failed).toStrictEqual([]);
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

  it("blocks install from an older binary when config was written by a newer one", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({
      exists: true,
      valid: true,
      config: { meta: { lastTouchedVersion: "9999.1.1" } },
      sourceConfig: { meta: { lastTouchedVersion: "9999.1.1" } },
    });

    await runDaemonInstall({ json: true, force: true });

    expect(actionState.failed[0]?.message).toContain(
      "Refusing to install or rewrite the gateway service",
    );
    expect(buildGatewayInstallPlanMock).not.toHaveBeenCalled();
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
    expectLastEmittedResult("already-installed");
  });

  it("fails closed when a pre-migration LaunchAgent cannot be inspected", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
    readGatewayServiceCommandForMutationMock.mockRejectedValue(new Error("secret-canary"));

    await runDaemonInstall({ json: true });

    expect(actionState.failed[0]?.message).toContain("SERVICE_DEFINITION_UNKNOWN");
    expect(actionState.failed[0]?.message).not.toContain("secret-canary");
    expect(service.readCommand).not.toHaveBeenCalled();
    expect(buildGatewayInstallPlanMock).not.toHaveBeenCalled();
    expect(installDaemonServiceAndEmitMock).not.toHaveBeenCalled();
  });

  it.each([
    [true, false],
    [true, true],
    [false, false],
  ])(
    "preserves pre-migration service-only values during loaded=%s force=%s install",
    async (loaded, force) => {
      Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
      const wrapperPath = "/usr/local/bin/openclaw-doppler";
      const plistPath = "/Volumes/MainDataDrive/Library/LaunchAgents/ai.openclaw.gateway.plist";
      const existingCommand = {
        programArguments: [wrapperPath, "gateway", "run"],
        environment: {
          NODE_EXTRA_CA_CERTS: "/opt/openclaw/corporate-ca.pem",
          OPENCLAW_WRAPPER: wrapperPath,
        },
        environmentValueSources: {
          NODE_EXTRA_CA_CERTS: "file",
          OPENCLAW_WRAPPER: "file",
        },
      };
      delete process.env.NODE_EXTRA_CA_CERTS;
      delete process.env.OPENCLAW_WRAPPER;
      service.isLoaded.mockResolvedValue(loaded);
      service.readCommand.mockResolvedValue(null);
      readGatewayServiceCommandForMutationMock.mockResolvedValue({
        kind: "relocated",
        plistPath,
        command: existingCommand,
      });

      await runDaemonInstall({ json: true, force });

      const installPlanArg = readFirstInstallPlanArg();
      expectFields(installPlanArg, {
        existingCommand,
        existingEnvironment: existingCommand.environment,
        existingEnvironmentValueSources: existingCommand.environmentValueSources,
        wrapperPath,
      });
      expectFields(installPlanArg.env, existingCommand.environment);
      expect(installDaemonServiceAndEmitMock).toHaveBeenCalledTimes(1);
    },
  );

  it("reinstalls when the loaded service still embeds OPENCLAW_GATEWAY_TOKEN", async () => {
    const programArguments = [
      "/usr/bin/node",
      "--max-old-space-size=24576",
      "--require=/tmp/service-preload.js",
      "/usr/local/bin/openclaw",
      "gateway",
    ];
    service.isLoaded.mockResolvedValue(true);
    const managedDefinition = {
      programArguments,
      environment: {
        OPENCLAW_GATEWAY_TOKEN: "stale-service-token",
      },
    };
    const existingCommand = {
      ...managedDefinition,
      environment: { NODE_OPTIONS: "--max-old-space-size=512" },
      managedDefinition,
      managedOverrides: { environment: { keys: ["NODE_OPTIONS"] } },
    };
    service.readCommand.mockResolvedValue(existingCommand as never);

    await runDaemonInstall({ json: true });

    expect(installDaemonServiceAndEmitMock).toHaveBeenCalledTimes(1);
    for (const [options] of buildGatewayInstallPlanMock.mock.calls) {
      expect(options).toEqual(expect.objectContaining({ existingCommand }));
    }
    expect(actionState.warnings).toContain(
      "Gateway service OPENCLAW_GATEWAY_TOKEN differs from the current install plan; refreshing the install.",
    );
  });

  it("returns already-installed when the embedded gateway token matches the install plan", async () => {
    service.isLoaded.mockResolvedValue(true);
    service.readCommand.mockResolvedValue({
      programArguments: ["openclaw", "gateway", "run"],
      environment: {
        OPENCLAW_GATEWAY_TOKEN: "durable-token",
      },
    } as never);
    buildGatewayInstallPlanMock.mockResolvedValueOnce({
      programArguments: ["openclaw", "gateway", "run"],
      workingDirectory: "/tmp",
      environment: {
        OPENCLAW_GATEWAY_TOKEN: "durable-token",
      },
    });

    await runDaemonInstall({ json: true });

    expect(buildGatewayInstallPlanMock).toHaveBeenCalledTimes(1);
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
    expect(installDaemonServiceAndEmitMock).not.toHaveBeenCalled();
    expectLastEmittedResult("already-installed");
  });

  it("preserves managed base wrapper, environment, and provenance during forced reinstall", async () => {
    for (const key of ["OPENAI_API_KEY", "OPENCLAW_WRAPPER"]) {
      delete process.env[key];
    }
    const environment = {
      OPENAI_API_KEY: "managed-service-key",
      OPENCLAW_WRAPPER: "/usr/local/bin/openclaw-doppler",
    };
    const environmentValueSources = {
      OPENAI_API_KEY: "file",
      OPENCLAW_WRAPPER: "inline",
    };
    service.isLoaded.mockResolvedValue(false);
    service.readCommand.mockResolvedValue({
      programArguments: ["/operator/drop-in-wrapper", "gateway", "run"],
      environment: {
        OPENAI_API_KEY: "operator-drop-in-key",
        OPENCLAW_WRAPPER: "/operator/drop-in-wrapper",
      },
      environmentValueSources: { OPENAI_API_KEY: "inline" },
      managedDefinition: {
        programArguments: [environment.OPENCLAW_WRAPPER, "gateway", "run"],
        environment,
        environmentValueSources,
      },
    } as never);

    await runDaemonInstall({ json: true, force: true });

    expect(service.readCommand).toHaveBeenCalledTimes(1);
    const installPlanArg = readFirstInstallPlanArg();
    expectFields(installPlanArg, {
      wrapperPath: environment.OPENCLAW_WRAPPER,
      existingEnvironment: environment,
      existingEnvironmentValueSources: environmentValueSources,
    });
    expectFields(installPlanArg.env, environment);
    expect(installDaemonServiceAndEmitMock).toHaveBeenCalledTimes(1);
  });

  it("preserves generated-service CA trust without unsafe overrides during forced reinstall", async () => {
    const extraCaCerts = "/opt/openclaw/corporate-ca.pem";
    const programArguments = [
      "/usr/bin/node",
      "--max-old-space-size=24576",
      "--require=/tmp/service-preload.js",
      "/usr/local/bin/openclaw",
      "gateway",
    ];
    for (const key of [
      "NODE_EXTRA_CA_CERTS",
      "NODE_TLS_REJECT_UNAUTHORIZED",
      "HTTPS_PROXY",
      "NODE_OPTIONS",
      "BASH_ENV",
      "LD_PRELOAD",
    ]) {
      delete process.env[key];
    }
    service.isLoaded.mockResolvedValue(true);
    service.readCommand.mockResolvedValue({
      programArguments,
      environment: {
        NODE_EXTRA_CA_CERTS: extraCaCerts,
        NODE_TLS_REJECT_UNAUTHORIZED: "0",
        HTTPS_PROXY: "https://attacker.invalid",
        NODE_OPTIONS: "--require /tmp/untrusted.js",
        BASH_ENV: "/tmp/untrusted.sh",
        LD_PRELOAD: "/tmp/untrusted.so",
      },
      environmentValueSources: {
        NODE_EXTRA_CA_CERTS: "file",
      },
    } as never);
    buildGatewayInstallPlanMock.mockImplementationOnce(async (params) => {
      const plan = await createInstallPlanFixture(params);
      return {
        ...plan,
        environment: {
          ...plan.environment,
          NODE_EXTRA_CA_CERTS: params?.env?.NODE_EXTRA_CA_CERTS ?? "/etc/ssl/cert.pem",
        },
      };
    });
    installDaemonServiceAndEmitMock.mockImplementationOnce(async (params?: unknown) => {
      await (params as { install: () => Promise<void> }).install();
    });

    await runDaemonInstall({ json: true, force: true });

    const installPlanArg = readFirstInstallPlanArg();
    expect(installPlanArg.existingCommand).toEqual(expect.objectContaining({ programArguments }));
    const installEnv = installPlanArg.env as Record<string, string | undefined>;
    expect(installEnv.NODE_EXTRA_CA_CERTS).toBe(extraCaCerts);
    expect(installEnv.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
    expect(installEnv.HTTPS_PROXY).toBeUndefined();
    expect(installEnv.NODE_OPTIONS).toBeUndefined();
    expect(installEnv.BASH_ENV).toBeUndefined();
    expect(installEnv.LD_PRELOAD).toBeUndefined();
    expectFields(installPlanArg.existingEnvironmentValueSources, {
      NODE_EXTRA_CA_CERTS: "file",
    });
    const installCalls = service.install.mock.calls as unknown as Array<
      [{ environment?: Record<string, string | undefined> }]
    >;
    expect(installCalls[0]?.[0].environment?.NODE_EXTRA_CA_CERTS).toBe(extraCaCerts);
  });

  it("reinstalls when wrapper command matches but wrapper env is missing", async () => {
    service.isLoaded.mockResolvedValue(true);
    service.readCommand.mockResolvedValue({
      programArguments: ["/usr/local/bin/openclaw-doppler", "gateway", "run"],
      environment: {},
    } as never);

    await runDaemonInstall({
      json: true,
      wrapper: "/usr/local/bin/openclaw-doppler",
    });

    expect(installDaemonServiceAndEmitMock).toHaveBeenCalledTimes(1);
    expect(actionState.warnings).toContain(
      "Gateway service OPENCLAW_WRAPPER differs from the current wrapper install plan; refreshing the install.",
    );
  });

  it("reinstalls when the embedded gateway token differs from the install plan", async () => {
    service.isLoaded.mockResolvedValue(true);
    service.readCommand.mockResolvedValue({
      programArguments: ["openclaw", "gateway", "run"],
      environment: {
        OPENCLAW_GATEWAY_TOKEN: "stale-service-token",
      },
    } as never);
    buildGatewayInstallPlanMock.mockResolvedValueOnce({
      programArguments: ["openclaw", "gateway", "run"],
      workingDirectory: "/tmp",
      environment: {
        OPENCLAW_GATEWAY_TOKEN: "fresh-token",
      },
    });

    await runDaemonInstall({ json: true });

    expect(installDaemonServiceAndEmitMock).toHaveBeenCalledTimes(1);
    expect(actionState.warnings).toContain(
      "Gateway service OPENCLAW_GATEWAY_TOKEN differs from the current install plan; refreshing the install.",
    );
  });

  it.each([
    { name: "an env file", source: "file", operatorOwned: false },
    { name: "an operator-only drop-in", source: "inline", operatorOwned: true },
  ])("does not reinstall when OPENCLAW_GATEWAY_TOKEN comes from $name", async (testCase) => {
    service.isLoaded.mockResolvedValue(true);
    const programArguments = ["openclaw", "gateway", "run"];
    service.readCommand.mockResolvedValue({
      programArguments,
      environment: { OPENCLAW_GATEWAY_TOKEN: "operator-token" },
      environmentValueSources: { OPENCLAW_GATEWAY_TOKEN: testCase.source },
      ...(testCase.operatorOwned && {
        managedDefinition: { programArguments, environment: {} },
      }),
    } as never);

    await runDaemonInstall({ json: true });

    expect(buildGatewayInstallPlanMock).not.toHaveBeenCalled();
    expect(installDaemonServiceAndEmitMock).not.toHaveBeenCalled();
    expectLastEmittedResult("already-installed");
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
      programArguments: ["/home/test/.nvm/versions/node/v22.19.0/bin/node", "dist/entry.js"],
      environment: {},
    } as never);

    await runDaemonInstall({ json: true });

    expect(installDaemonServiceAndEmitMock).toHaveBeenCalledTimes(1);
    expectFields(readFirstNodeStartupTlsEnvironmentArg(), {
      execPath: "/home/test/.nvm/versions/node/v22.19.0/bin/node",
    });
  });

  it("reuses env-backed service secrets during forced reinstall when the current shell is missing them", async () => {
    service.isLoaded.mockResolvedValue(true);
    service.readCommand.mockResolvedValue({
      programArguments: ["openclaw", "gateway", "run"],
      environment: {
        OPENAI_API_KEY: "service-openai-key",
      },
    } as never);
    delete process.env.OPENAI_API_KEY;
    process.env.NODE_OPTIONS = "--require /tmp/untrusted.js";
    await runDaemonInstall({ json: true, force: true });

    expectFields(readFirstInstallPlanArg().env, {
      OPENAI_API_KEY: "service-openai-key",
    });
    expect(installDaemonServiceAndEmitMock).toHaveBeenCalledTimes(1);
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

    delete process.env.OPENAI_API_KEY;
    await runDaemonInstall({ json: true, force: true });

    expectFields(readFirstInstallPlanArg().env, {
      OPENAI_API_KEY: "service-openai-key",
    });
    const env = readFirstInstallPlanArg().env as Record<string, string | undefined>;
    expect(env.OPENCLAW_STATE_DIR).toBeUndefined();
    expect(env.OPENCLAW_CONFIG_PATH).toBeUndefined();
    expect(env.OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.PATH).not.toContain("/tmp/doctor-bin");
    expect(installDaemonServiceAndEmitMock).toHaveBeenCalledTimes(1);
  });
});

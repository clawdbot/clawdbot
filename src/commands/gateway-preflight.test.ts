import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn(),
  collectGatewayStartupPreflight: vi.fn(),
  inspectStartupSessionMigrationPrerequisites: vi.fn(),
  resolveSqliteReadOnlyInspectionLocation: vi.fn((pathname: string) => pathname),
  withSqliteReadOnlyInspectionSnapshots: vi.fn(async (run: () => Promise<unknown>) => await run()),
  withOpenClawStateDatabaseInspectionSnapshots: vi.fn(
    async (run: () => Promise<unknown>) => await run(),
  ),
  shellEnvPlan: { enabled: false } as
    | { enabled: false }
    | {
        enabled: true;
        expectedKeys: string[];
        missingKeys: string[];
        timeoutMs: number;
      },
  unresolvedDirectories: [] as string[],
}));

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
}));

vi.mock("../infra/startup-preflight.js", () => ({
  collectGatewayStartupPreflight: mocks.collectGatewayStartupPreflight,
}));

vi.mock("../infra/sqlite-readonly-inspection.js", () => ({
  resolveSqliteReadOnlyInspectionLocation: mocks.resolveSqliteReadOnlyInspectionLocation,
  withSqliteReadOnlyInspectionSnapshots: mocks.withSqliteReadOnlyInspectionSnapshots,
}));

vi.mock("../gateway/server-startup-session-migration.js", () => ({
  inspectStartupSessionMigrationPrerequisites: mocks.inspectStartupSessionMigrationPrerequisites,
}));

vi.mock("../infra/path-case.js", () => ({
  withReadOnlyPathCaseProbe: async (run: () => unknown) => ({
    value: await run(),
    unresolvedDirectories: mocks.unresolvedDirectories,
  }),
}));

vi.mock("../state/openclaw-state-db-readonly.js", () => ({
  withOpenClawStateDatabaseInspectionSnapshots: mocks.withOpenClawStateDatabaseInspectionSnapshots,
}));

vi.mock("../cli/gateway-cli/shell-env-fallback-plan.js", () => ({
  resolveGatewayShellEnvFallbackPlan: () => mocks.shellEnvPlan,
}));

import { gatewayPreflightCommand } from "./gateway-preflight.js";

async function runJsonPreflight() {
  let result: unknown;
  const runtime = {
    log: vi.fn(),
    error: vi.fn(),
    writeStdout: vi.fn(),
    writeJson: vi.fn((value: unknown) => {
      result = value;
    }),
    exit: vi.fn(),
  };
  await gatewayPreflightCommand({ json: true }, runtime);
  return { result, runtime };
}

describe("gateway startup preflight command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.shellEnvPlan = { enabled: false };
    mocks.unresolvedDirectories = [];
    mocks.inspectStartupSessionMigrationPrerequisites.mockResolvedValue({ status: "ready" });
    delete process.env.JITI_FS_CACHE;
  });

  it("uses an unobserved config read without activating plugin runtime", async () => {
    const config = {
      gateway: { mode: "local" as const },
      memory: { search: { provider: "local", fallback: "none" as const } },
    };
    const sourceConfig = structuredClone(config);
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      config,
      sourceConfig,
    });
    mocks.collectGatewayStartupPreflight.mockResolvedValue({
      checksRun: 1,
      blockers: [],
      errors: [],
    });

    const { result, runtime } = await runJsonPreflight();

    expect(result).toEqual({
      protocol: "openclaw.gateway.startup-preflight",
      protocolVersion: 1,
      ok: true,
      status: "ready",
      checksRun: 3,
      blockers: [],
      errors: [],
    });
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(mocks.readConfigFileSnapshot).toHaveBeenCalledWith({ observe: false });
    expect(mocks.collectGatewayStartupPreflight).toHaveBeenCalledWith({
      config,
      env: process.env,
      resolveSqliteReadOnlyLocation: mocks.resolveSqliteReadOnlyInspectionLocation,
    });
    expect(mocks.inspectStartupSessionMigrationPrerequisites).toHaveBeenCalledWith({
      cfg: config,
      env: process.env,
    });
    expect(mocks.withOpenClawStateDatabaseInspectionSnapshots).toHaveBeenCalledTimes(1);
    expect(mocks.withSqliteReadOnlyInspectionSnapshots).toHaveBeenCalledTimes(1);
    expect(process.env.JITI_FS_CACHE).toBeUndefined();
  });

  it("disables plugin transform cache writes only for the evaluation", async () => {
    process.env.JITI_FS_CACHE = "true";
    mocks.readConfigFileSnapshot.mockImplementation(async () => {
      expect(process.env.JITI_FS_CACHE).toBe("false");
      return {
        exists: true,
        valid: true,
        config: { gateway: { mode: "local" } },
        sourceConfig: { gateway: { mode: "local" } },
      };
    });
    mocks.collectGatewayStartupPreflight.mockResolvedValue({
      checksRun: 0,
      blockers: [],
      errors: [],
    });

    const { result } = await runJsonPreflight();

    expect(result).toMatchObject({
      status: "ready",
    });
    expect(process.env.JITI_FS_CACHE).toBe("true");
  });

  it("returns indeterminate instead of writing when path case cannot be inspected", async () => {
    mocks.unresolvedDirectories = ["/protected/state"];
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      config: { gateway: { mode: "local" } },
      sourceConfig: { gateway: { mode: "local" } },
    });
    mocks.collectGatewayStartupPreflight.mockResolvedValue({
      checksRun: 1,
      blockers: [],
      errors: [],
    });

    const { result, runtime } = await runJsonPreflight();

    expect(result).toMatchObject({
      ok: false,
      status: "indeterminate",
      checksRun: 3,
      blockers: [],
      errors: [
        {
          id: "filesystem/path-case",
          code: "filesystem-inspection-indeterminate",
          message: expect.stringContaining("/protected/state"),
        },
      ],
    });
    expect(runtime.exit).toHaveBeenCalledWith(2, { resetStream: process.stderr });
  });

  it("returns exit 2 for invalid config without running startup inspections", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue({
      valid: false,
      issues: [{ path: ["memory", "search", "provider"], message: "Invalid provider" }],
    });

    const { result, runtime } = await runJsonPreflight();

    expect(result).toMatchObject({
      ok: false,
      status: "indeterminate",
      checksRun: 0,
      blockers: [],
      errors: [{ id: "config/validation", code: "invalid-config" }],
    });
    expect(runtime.exit).toHaveBeenCalledWith(2, { resetStream: process.stderr });
    expect(mocks.collectGatewayStartupPreflight).not.toHaveBeenCalled();
  });

  it("returns indeterminate without running a login shell when fallback could add inputs", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      config: { gateway: { mode: "local" }, env: { shellEnv: { enabled: true } } },
      sourceConfig: { gateway: { mode: "local" }, env: { shellEnv: { enabled: true } } },
    });
    mocks.shellEnvPlan = {
      enabled: true,
      expectedKeys: ["OPENCLAW_GATEWAY_TOKEN", "OPENCLAW_GATEWAY_PASSWORD"],
      missingKeys: ["OPENCLAW_GATEWAY_TOKEN"],
      timeoutMs: 15_000,
    };

    const { result, runtime } = await runJsonPreflight();

    expect(result).toMatchObject({
      ok: false,
      status: "indeterminate",
      checksRun: 2,
      blockers: [],
      errors: [
        {
          id: "core/gateway-environment/shell-fallback",
          pluginId: "core",
          migrationId: "gateway-environment",
          code: "gateway-shell-env-inspection-required",
          message: expect.stringContaining("OPENCLAW_GATEWAY_TOKEN"),
        },
      ],
    });
    expect(runtime.exit).toHaveBeenCalledWith(2, { resetStream: process.stderr });
    expect(mocks.collectGatewayStartupPreflight).not.toHaveBeenCalled();
    expect(mocks.inspectStartupSessionMigrationPrerequisites).not.toHaveBeenCalled();
  });

  it("ignores unrelated shell gaps when explicit Gateway auth is already inspectable", async () => {
    const config = {
      gateway: {
        mode: "local" as const,
        auth: { mode: "token" as const, token: "configured-token" },
      },
      env: { shellEnv: { enabled: true } },
      memory: { search: { provider: "none" as const } },
    };
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      config,
      sourceConfig: structuredClone(config),
    });
    mocks.shellEnvPlan = {
      enabled: true,
      expectedKeys: [
        "OPENAI_API_KEY",
        "DISCORD_BOT_TOKEN",
        "OPENCLAW_GATEWAY_TOKEN",
        "OPENCLAW_GATEWAY_PASSWORD",
      ],
      missingKeys: [
        "OPENAI_API_KEY",
        "DISCORD_BOT_TOKEN",
        "OPENCLAW_GATEWAY_TOKEN",
        "OPENCLAW_GATEWAY_PASSWORD",
      ],
      timeoutMs: 15_000,
    };
    mocks.collectGatewayStartupPreflight.mockResolvedValue({
      checksRun: 0,
      blockers: [],
      errors: [],
    });

    const { result, runtime } = await runJsonPreflight();

    expect(result).toMatchObject({
      ok: true,
      status: "ready",
      blockers: [],
      errors: [],
    });
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(mocks.collectGatewayStartupPreflight).toHaveBeenCalledOnce();
    expect(mocks.inspectStartupSessionMigrationPrerequisites).toHaveBeenCalledOnce();
  });

  it("blocks a missing target config before running startup inspections", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: false,
      valid: true,
      config: {},
      sourceConfig: {},
    });

    const { result, runtime } = await runJsonPreflight();

    expect(result).toMatchObject({
      ok: false,
      status: "blocked",
      checksRun: 1,
      blockers: [
        {
          id: "core/gateway-config/start-guard",
          pluginId: "core",
          migrationId: "gateway-config",
          code: "gateway-start-config-blocked",
          message: expect.stringContaining("Missing config"),
          configPath: "gateway.mode",
        },
      ],
      errors: [],
    });
    expect(runtime.exit).toHaveBeenCalledWith(1, { resetStream: process.stderr });
    expect(mocks.collectGatewayStartupPreflight).not.toHaveBeenCalled();
    expect(mocks.inspectStartupSessionMigrationPrerequisites).not.toHaveBeenCalled();
  });

  it.each([
    {
      status: "blocked" as const,
      evaluation: {
        checksRun: 1,
        blockers: [{ id: "memory/local", code: "missing", message: "missing" }],
        errors: [],
      },
      exitCode: 1,
    },
    {
      status: "indeterminate" as const,
      evaluation: {
        checksRun: 1,
        blockers: [],
        errors: [{ id: "memory/local", code: "unsupported", message: "unsupported" }],
      },
      exitCode: 2,
    },
  ])("writes one JSON result and exits for $status", async ({ evaluation, exitCode }) => {
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      config: { gateway: { mode: "local" } },
      sourceConfig: { gateway: { mode: "local" } },
    });
    mocks.collectGatewayStartupPreflight.mockResolvedValue(evaluation);
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      writeStdout: vi.fn(),
      writeJson: vi.fn(),
      exit: vi.fn(),
    };

    await gatewayPreflightCommand({ json: true }, runtime);

    expect(runtime.writeJson).toHaveBeenCalledTimes(1);
    expect(runtime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        checksRun: 3,
        blockers: evaluation.blockers,
        errors: evaluation.errors,
      }),
      2,
    );
    expect(runtime.exit).toHaveBeenCalledWith(exitCode, { resetStream: process.stderr });
    expect(runtime.log).not.toHaveBeenCalled();
  });

  it("reports core session SQLite startup blockers", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      config: { gateway: { mode: "local" } },
      sourceConfig: { gateway: { mode: "local" } },
    });
    mocks.collectGatewayStartupPreflight.mockResolvedValue({
      checksRun: 0,
      blockers: [],
      errors: [],
    });
    mocks.inspectStartupSessionMigrationPrerequisites.mockResolvedValue({
      status: "blocked",
      findings: [
        {
          id: "main/store_unreadable/1",
          code: "store_unreadable",
          message: "Session store is unreadable.",
          remediation: ["Run doctor inspect."],
          agentId: "main",
        },
      ],
    });

    const { result, runtime } = await runJsonPreflight();

    expect(result).toMatchObject({
      ok: false,
      status: "blocked",
      checksRun: 2,
      blockers: [
        {
          id: "core/session-sqlite/main/store_unreadable/1",
          pluginId: "core",
          migrationId: "session-sqlite",
          code: "store_unreadable",
          message: "Session store is unreadable.",
          remediation: ["Run doctor inspect."],
          agentId: "main",
        },
      ],
      errors: [],
    });
    expect(runtime.exit).toHaveBeenCalledWith(1, { resetStream: process.stderr });
  });

  it("reports a core Gateway auth blocker when password mode has no password", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      config: { gateway: { mode: "local", auth: { mode: "password" } } },
      sourceConfig: { gateway: { mode: "local", auth: { mode: "password" } } },
    });
    mocks.collectGatewayStartupPreflight.mockResolvedValue({
      checksRun: 0,
      blockers: [],
      errors: [],
    });

    const { result, runtime } = await runJsonPreflight();

    expect(result).toMatchObject({
      ok: false,
      status: "blocked",
      checksRun: 2,
      blockers: [
        {
          id: "core/gateway-auth/password-missing",
          pluginId: "core",
          migrationId: "gateway-auth",
          code: "gateway-password-missing",
          configPath: "gateway.auth.password",
        },
      ],
      errors: [],
    });
    expect(runtime.exit).toHaveBeenCalledWith(1, { resetStream: process.stderr });
  });

  it("reports the canonical explicit auth mode blocker", async () => {
    const config = {
      gateway: {
        mode: "local" as const,
        auth: {
          token: "configured-token",
          password: "configured-password",
        },
      },
    };
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      config,
      sourceConfig: config,
    });
    mocks.collectGatewayStartupPreflight.mockResolvedValue({
      checksRun: 0,
      blockers: [],
      errors: [],
    });

    const { result, runtime } = await runJsonPreflight();

    expect(result).toMatchObject({
      ok: false,
      status: "blocked",
      checksRun: 2,
      blockers: [
        {
          id: "core/gateway-auth/explicit-mode-required",
          pluginId: "core",
          migrationId: "gateway-auth",
          code: "gateway-auth-mode-required",
          message: expect.stringMatching(/gateway\.auth\.mode is unset/i),
          configPath: "gateway.auth.mode",
        },
      ],
      errors: [],
    });
    expect(runtime.exit).toHaveBeenCalledWith(1, { resetStream: process.stderr });
  });

  it.each([
    {
      name: "trusted-proxy auth without a proxy list",
      config: {
        gateway: {
          mode: "local" as const,
          auth: {
            mode: "trusted-proxy" as const,
            trustedProxy: { userHeader: "x-forwarded-user" },
          },
        },
      },
      code: "gateway-trusted-proxies-required",
      configPath: "gateway.trustedProxies",
    },
    {
      name: "Tailscale Funnel with token auth",
      config: {
        gateway: {
          mode: "local" as const,
          auth: { mode: "token" as const, token: "configured-token" },
          tailscale: { mode: "funnel" as const },
        },
      },
      code: "gateway-tailscale-funnel-password-required",
      configPath: "gateway.auth.mode",
    },
  ])("reports the shared Gateway runtime blocker for $name", async (testCase) => {
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      config: testCase.config,
      sourceConfig: testCase.config,
    });
    mocks.collectGatewayStartupPreflight.mockResolvedValue({
      checksRun: 0,
      blockers: [],
      errors: [],
    });

    const { result, runtime } = await runJsonPreflight();

    expect(result).toMatchObject({
      ok: false,
      status: "blocked",
      blockers: [
        {
          id: `core/gateway-runtime/${testCase.code}`,
          pluginId: "core",
          migrationId: "gateway-runtime",
          code: testCase.code,
          configPath: testCase.configPath,
        },
      ],
      errors: [],
    });
    expect(runtime.exit).toHaveBeenCalledWith(1, { resetStream: process.stderr });
  });

  it("keeps runtime-seeded non-loopback Control UI origins ready without writing config", async () => {
    const config = {
      gateway: {
        mode: "local" as const,
        bind: "lan" as const,
        auth: { mode: "token" as const, token: "configured-token" },
      },
    };
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      config,
      sourceConfig: config,
    });
    mocks.collectGatewayStartupPreflight.mockResolvedValue({
      checksRun: 0,
      blockers: [],
      errors: [],
    });

    const { result, runtime } = await runJsonPreflight();

    expect(result).toMatchObject({
      ok: true,
      status: "ready",
      blockers: [],
      errors: [],
    });
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(config.gateway).not.toHaveProperty("controlUi");
  });

  it("returns indeterminate for an active Gateway auth SecretRef", async () => {
    const config = {
      gateway: {
        mode: "local",
        auth: {
          mode: "password",
          password: { source: "env", provider: "default", id: "GW_PASSWORD" },
        },
      },
    };
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      config,
      sourceConfig: config,
    });
    mocks.collectGatewayStartupPreflight.mockResolvedValue({
      checksRun: 0,
      blockers: [],
      errors: [],
    });

    const { result, runtime } = await runJsonPreflight();

    expect(result).toMatchObject({
      ok: false,
      status: "indeterminate",
      checksRun: 2,
      blockers: [],
      errors: [
        {
          id: "core/gateway-auth",
          pluginId: "core",
          migrationId: "gateway-auth",
          code: "credential-inspection-required",
          message: expect.stringContaining("gateway.auth.password"),
        },
      ],
    });
    expect(runtime.exit).toHaveBeenCalledWith(2, { resetStream: process.stderr });
  });
});

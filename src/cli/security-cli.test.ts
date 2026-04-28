import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerSecurityCli } from "./security-cli.js";

const mocks = await vi.hoisted(async () => {
  const { createCliRuntimeMock } = await import("./test-runtime-mock.js");
  const runtime = createCliRuntimeMock(vi);
  return {
    loadConfig: vi.fn(),
    runSecurityAudit: vi.fn(),
    fixSecurityFootguns: vi.fn(),
    resolveCommandSecretRefsViaGateway: vi.fn(),
    getSecurityAuditCommandSecretTargetIds: vi.fn(
      () => new Set(["gateway.auth.token", "gateway.auth.password"]),
    ),
    ...runtime,
  };
});

const {
  loadConfig,
  runSecurityAudit,
  fixSecurityFootguns,
  resolveCommandSecretRefsViaGateway,
  getSecurityAuditCommandSecretTargetIds,
  runtimeLogs,
} = mocks;

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => mocks.loadConfig(),
  loadConfig: () => mocks.loadConfig(),
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.defaultRuntime,
}));

vi.mock("../security/audit.js", () => ({
  runSecurityAudit: (opts: unknown) => mocks.runSecurityAudit(opts),
}));

vi.mock("../security/fix.js", () => ({
  fixSecurityFootguns: () => mocks.fixSecurityFootguns(),
}));

vi.mock("./command-secret-gateway.js", () => ({
  resolveCommandSecretRefsViaGateway: (opts: unknown) =>
    mocks.resolveCommandSecretRefsViaGateway(opts),
}));

vi.mock("./command-secret-targets.js", () => ({
  getSecurityAuditCommandSecretTargetIds: () => mocks.getSecurityAuditCommandSecretTargetIds(),
}));

function createProgram() {
  const program = new Command();
  program.exitOverride();
  registerSecurityCli(program);
  return program;
}

function primeDeepAuditConfig(sourceConfig = { gateway: { mode: "local" } }) {
  loadConfig.mockReturnValue(sourceConfig);
  resolveCommandSecretRefsViaGateway.mockResolvedValue({
    resolvedConfig: sourceConfig,
    diagnostics: [],
    targetStatesByPath: {},
    hadUnresolvedTargets: false,
  });
  runSecurityAudit.mockResolvedValue({
    ts: 0,
    summary: { critical: 0, warn: 0, info: 0 },
    findings: [],
  });
  return sourceConfig;
}

describe("security CLI", () => {
  beforeEach(() => {
    runtimeLogs.length = 0;
    loadConfig.mockReset();
    runSecurityAudit.mockReset();
    fixSecurityFootguns.mockReset();
    resolveCommandSecretRefsViaGateway.mockReset();
    getSecurityAuditCommandSecretTargetIds.mockClear();
    fixSecurityFootguns.mockResolvedValue({
      changes: [],
      actions: [],
      errors: [],
    });
  });

  it("runs audit with read-only SecretRef resolution and prints JSON diagnostics", async () => {
    const sourceConfig = {
      gateway: {
        auth: {
          mode: "token",
          token: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_TOKEN" },
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    };
    const resolvedConfig = {
      ...sourceConfig,
      gateway: {
        ...sourceConfig.gateway,
        auth: {
          ...sourceConfig.gateway.auth,
          token: "resolved-token",
        },
      },
    };
    loadConfig.mockReturnValue(sourceConfig);
    resolveCommandSecretRefsViaGateway.mockResolvedValue({
      resolvedConfig,
      diagnostics: [
        "security audit: gateway secrets.resolve unavailable (gateway closed); resolved command secrets locally.",
      ],
      targetStatesByPath: {},
      hadUnresolvedTargets: false,
    });
    runSecurityAudit.mockResolvedValue({
      ts: 0,
      summary: { critical: 0, warn: 1, info: 0 },
      findings: [
        {
          checkId: "gateway.probe_failed",
          severity: "warn",
          title: "Gateway probe failed (deep)",
          detail: "connect failed: connect ECONNREFUSED 127.0.0.1:18789",
        },
      ],
    });

    await createProgram().parseAsync(["security", "audit", "--json"], { from: "user" });

    expect(resolveCommandSecretRefsViaGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        config: sourceConfig,
        commandName: "security audit",
        mode: "read_only_status",
        targetIds: expect.any(Set),
      }),
    );
    expect(runSecurityAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        config: resolvedConfig,
        sourceConfig,
        deep: false,
        includeFilesystem: true,
        includeChannelSecurity: true,
      }),
    );
    const payload = JSON.parse(String(runtimeLogs.at(-1)));
    expect(payload.secretDiagnostics).toEqual([
      "security audit: gateway secrets.resolve unavailable (gateway closed); resolved command secrets locally.",
    ]);
  });

  it.each([
    {
      title: "forwards --token to deep probe auth without altering command-level resolver mode",
      argv: ["--token", "explicit-token"],
      deepProbeAuth: { token: "explicit-token" },
    },
    {
      title: "forwards --password to deep probe auth without altering command-level resolver mode",
      argv: ["--password", "explicit-password"],
      deepProbeAuth: { password: "explicit-password" },
    },
    {
      title: "forwards both --token and --password to deep probe auth",
      argv: ["--token", "explicit-token", "--password", "explicit-password"],
      deepProbeAuth: {
        token: "explicit-token",
        password: "explicit-password",
      },
    },
  ])("$title", async ({ argv, deepProbeAuth }) => {
    primeDeepAuditConfig();

    await createProgram().parseAsync(["security", "audit", "--deep", ...argv, "--json"], {
      from: "user",
    });

    expect(resolveCommandSecretRefsViaGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "read_only_status",
      }),
    );
    expect(runSecurityAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        deep: true,
        deepProbeAuth,
      }),
    );
  });
});

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

function lastSecretResolverOptions(): Record<string, unknown> | undefined {
  const calls = resolveCommandSecretRefsViaGateway.mock.calls;
  return calls[calls.length - 1]?.[0] as Record<string, unknown> | undefined;
}

function lastSecurityAuditOptions(): Record<string, unknown> | undefined {
  const calls = runSecurityAudit.mock.calls;
  return calls[calls.length - 1]?.[0] as Record<string, unknown> | undefined;
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

    const resolverOptions = lastSecretResolverOptions();
    expect(resolverOptions?.config).toBe(sourceConfig);
    expect(resolverOptions?.commandName).toBe("security audit");
    expect(resolverOptions?.mode).toBe("read_only_status");
    expect(resolverOptions?.targetIds).toBeInstanceOf(Set);
    const auditOptions = lastSecurityAuditOptions();
    expect(auditOptions?.config).toBe(resolvedConfig);
    expect(auditOptions?.sourceConfig).toBe(sourceConfig);
    expect(auditOptions?.deep).toBe(false);
    expect(auditOptions?.includeFilesystem).toBe(true);
    expect(auditOptions?.includeChannelSecurity).toBe(true);
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

    expect(lastSecretResolverOptions()?.mode).toBe("read_only_status");
    expect(lastSecurityAuditOptions()?.deep).toBe(true);
    expect(lastSecurityAuditOptions()?.deepProbeAuth).toEqual(deepProbeAuth);
  });
});

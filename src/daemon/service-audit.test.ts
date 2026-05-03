import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  auditGatewayServiceConfig,
  checkTokenDrift,
  readGatewayServiceCommandPort,
  SERVICE_AUDIT_CODES,
} from "./service-audit.js";
import { buildMinimalServicePath } from "./service-env.js";
import type { GatewayServiceEnvironmentValueSource } from "./service-types.js";

function hasIssue(
  audit: Awaited<ReturnType<typeof auditGatewayServiceConfig>>,
  code: (typeof SERVICE_AUDIT_CODES)[keyof typeof SERVICE_AUDIT_CODES],
) {
  return audit.issues.some((issue) => issue.code === code);
}

function createGatewayAudit({
  expectedGatewayToken,
  expectedManagedServiceEnvKeys,
  path = "/usr/local/bin:/usr/bin:/bin",
  serviceToken,
  extraEnvironment,
  environmentValueSources,
}: {
  expectedGatewayToken?: string;
  expectedManagedServiceEnvKeys?: Iterable<string>;
  path?: string;
  serviceToken?: string;
  extraEnvironment?: Record<string, string>;
  environmentValueSources?: Record<string, GatewayServiceEnvironmentValueSource>;
} = {}) {
  return auditGatewayServiceConfig({
    env: { HOME: "/tmp" },
    platform: "linux",
    expectedGatewayToken,
    expectedManagedServiceEnvKeys,
    command: {
      programArguments: ["/usr/bin/node", "gateway"],
      environment: {
        PATH: path,
        ...(serviceToken ? { OPENCLAW_GATEWAY_TOKEN: serviceToken } : {}),
        ...extraEnvironment,
      },
      ...(environmentValueSources ? { environmentValueSources } : {}),
    },
  });
}

function expectTokenAudit(
  audit: Awaited<ReturnType<typeof auditGatewayServiceConfig>>,
  {
    embedded,
    mismatch,
  }: {
    embedded: boolean;
    mismatch: boolean;
  },
) {
  expect(hasIssue(audit, SERVICE_AUDIT_CODES.gatewayTokenEmbedded)).toBe(embedded);
  expect(hasIssue(audit, SERVICE_AUDIT_CODES.gatewayTokenMismatch)).toBe(mismatch);
}

describe("auditGatewayServiceConfig", () => {
  it("flags bun runtime", async () => {
    const audit = await auditGatewayServiceConfig({
      env: { HOME: "/tmp" },
      platform: "darwin",
      command: {
        programArguments: ["/opt/homebrew/bin/bun", "gateway"],
        environment: { PATH: "/usr/bin:/bin" },
      },
    });
    expect(audit.issues.some((issue) => issue.code === SERVICE_AUDIT_CODES.gatewayRuntimeBun)).toBe(
      true,
    );
  });

  it("flags version-managed node paths", async () => {
    const audit = await auditGatewayServiceConfig({
      env: { HOME: "/tmp" },
      platform: "darwin",
      command: {
        programArguments: ["/Users/test/.nvm/versions/node/v22.0.0/bin/node", "gateway"],
        environment: {
          PATH: "/usr/bin:/bin:/Users/test/.nvm/versions/node/v22.0.0/bin",
        },
      },
    });
    expect(
      audit.issues.some(
        (issue) => issue.code === SERVICE_AUDIT_CODES.gatewayRuntimeNodeVersionManager,
      ),
    ).toBe(true);
    expect(
      audit.issues.some((issue) => issue.code === SERVICE_AUDIT_CODES.gatewayPathNonMinimal),
    ).toBe(true);
    expect(
      audit.issues.some((issue) => issue.code === SERVICE_AUDIT_CODES.gatewayPathMissingDirs),
    ).toBe(true);
  });

  it("accepts Linux minimal PATH with user directories", async () => {
    const env = { HOME: "/tmp/openclaw-testuser", PNPM_HOME: "/opt/pnpm" };
    const minimalPath = buildMinimalServicePath({ platform: "linux", env });
    const audit = await auditGatewayServiceConfig({
      env,
      platform: "linux",
      command: {
        programArguments: ["/usr/bin/node", "gateway"],
        environment: { PATH: minimalPath },
      },
    });

    expect(
      audit.issues.some((issue) => issue.code === SERVICE_AUDIT_CODES.gatewayPathNonMinimal),
    ).toBe(false);
    expect(
      audit.issues.some((issue) => issue.code === SERVICE_AUDIT_CODES.gatewayPathMissingDirs),
    ).toBe(false);
  });

  it("accepts canonical macOS gateway service PATH without user-bin defaults", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-service-audit-home-"));
    try {
      const servicePath = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

      const audit = await auditGatewayServiceConfig({
        env: { HOME: home },
        platform: "darwin",
        command: {
          programArguments: ["/usr/bin/node", "gateway"],
          environment: { PATH: servicePath },
        },
      });

      expect(hasIssue(audit, SERVICE_AUDIT_CODES.gatewayPathMissingDirs)).toBe(false);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("still requires explicit env-configured tool roots in gateway service PATH", async () => {
    const audit = await auditGatewayServiceConfig({
      env: { HOME: "/tmp/openclaw-testuser", PNPM_HOME: "/opt/pnpm" },
      platform: "linux",
      command: {
        programArguments: ["/usr/bin/node", "gateway"],
        environment: { PATH: "/usr/local/bin:/usr/bin:/bin" },
      },
    });

    const issue = audit.issues.find(
      (entry) => entry.code === SERVICE_AUDIT_CODES.gatewayPathMissingDirs,
    );
    expect(issue?.message).toContain("/opt/pnpm");
  });

  it("flags stale Linux version-manager and package-manager PATH entries", async () => {
    const env = { HOME: "/tmp/openclaw-testuser-nonminimal" };
    const minimalPath = buildMinimalServicePath({ platform: "linux", env });
    const staleEntries = [
      `${env.HOME}/.volta/bin`,
      `${env.HOME}/.asdf/shims`,
      `${env.HOME}/.nvm/current/bin`,
      `${env.HOME}/.local/share/fnm/current/bin`,
      `${env.HOME}/.fnm/current/bin`,
      `${env.HOME}/.local/share/pnpm`,
      "/opt/pnpm/bin",
    ];
    const audit = await auditGatewayServiceConfig({
      env,
      platform: "linux",
      command: {
        programArguments: ["/usr/bin/node", "gateway"],
        environment: { PATH: [minimalPath, ...staleEntries].join(":") },
      },
    });

    const issue = audit.issues.find(
      (entry) => entry.code === SERVICE_AUDIT_CODES.gatewayPathNonMinimal,
    );
    expect(issue?.detail).toContain(`${env.HOME}/.volta/bin`);
    expect(issue?.detail).toContain(`${env.HOME}/.local/share/fnm/current/bin`);
    expect(issue?.detail).toContain(`${env.HOME}/.local/share/pnpm`);
    expect(issue?.detail).toContain("/opt/pnpm/bin");
  });

  it("accepts Linux fnm aliases/default without requiring the legacy current symlink", async () => {
    const env = {
      HOME: "/tmp/openclaw-testuser",
      FNM_DIR: "/tmp/openclaw-testuser/.local/share/fnm",
    };
    const pathParts = buildMinimalServicePath({ platform: "linux", env })
      .split(":")
      .filter((entry) => !entry.includes("/fnm/current/bin"));
    const audit = await auditGatewayServiceConfig({
      env,
      platform: "linux",
      command: {
        programArguments: ["/usr/bin/node", "gateway"],
        environment: { PATH: pathParts.join(":") },
      },
    });

    expect(
      audit.issues.some((issue) => issue.code === SERVICE_AUDIT_CODES.gatewayPathMissingDirs),
    ).toBe(false);
  });

  it("accepts Linux fnm current symlink without requiring aliases/default", async () => {
    const env = {
      HOME: "/tmp/openclaw-testuser",
      FNM_DIR: "/tmp/openclaw-testuser/.local/share/fnm",
    };
    const pathParts = buildMinimalServicePath({ platform: "linux", env })
      .split(":")
      .filter((entry) => !entry.includes("/fnm/aliases/default/bin"));
    const audit = await auditGatewayServiceConfig({
      env,
      platform: "linux",
      command: {
        programArguments: ["/usr/bin/node", "gateway"],
        environment: { PATH: pathParts.join(":") },
      },
    });

    expect(
      audit.issues.some((issue) => issue.code === SERVICE_AUDIT_CODES.gatewayPathMissingDirs),
    ).toBe(false);
  });

  it("reads gateway service ports from split and equals-form arguments", () => {
    expect(
      readGatewayServiceCommandPort(["/usr/bin/node", "entry.js", "gateway", "--port", "18888"]),
    ).toBe(18888);
    expect(
      readGatewayServiceCommandPort(["/usr/bin/node", "entry.js", "gateway", "--port=18889"]),
    ).toBe(18889);
    expect(readGatewayServiceCommandPort(["/usr/bin/node", "entry.js", "gateway"])).toBe(undefined);
    expect(
      readGatewayServiceCommandPort(["/usr/bin/node", "entry.js", "gateway", "--port=0"]),
    ).toBe(undefined);
  });

  it("flags gateway service port drift from the expected config port", async () => {
    const audit = await auditGatewayServiceConfig({
      env: { HOME: "/tmp" },
      platform: "win32",
      expectedPort: 18888,
      command: {
        programArguments: ["/usr/bin/node", "entry.js", "gateway", "--port", "18789"],
        environment: {},
      },
    });

    const issue = audit.issues.find(
      (entry) => entry.code === SERVICE_AUDIT_CODES.gatewayPortMismatch,
    );
    expect(issue).toMatchObject({
      message: "Gateway service port does not match current gateway config.",
      detail: "18789 -> 18888",
      level: "recommended",
    });
  });

  it("accepts gateway service ports that match the expected config port", async () => {
    const audit = await auditGatewayServiceConfig({
      env: { HOME: "/tmp" },
      platform: "win32",
      expectedPort: 18888,
      command: {
        programArguments: ["/usr/bin/node", "entry.js", "gateway", "--port=18888"],
        environment: {},
      },
    });

    expect(hasIssue(audit, SERVICE_AUDIT_CODES.gatewayPortMismatch)).toBe(false);
  });

  it("flags gateway token mismatch when service token is stale", async () => {
    const audit = await createGatewayAudit({
      expectedGatewayToken: "new-token",
      serviceToken: "old-token",
    });
    expectTokenAudit(audit, { embedded: true, mismatch: true });
  });

  it("flags embedded service token even when it matches config token", async () => {
    const audit = await createGatewayAudit({
      expectedGatewayToken: "new-token",
      serviceToken: "new-token",
    });
    expectTokenAudit(audit, { embedded: true, mismatch: false });
  });

  it("does not flag token issues when service token is not embedded", async () => {
    const audit = await createGatewayAudit({
      expectedGatewayToken: "new-token",
    });
    expectTokenAudit(audit, { embedded: false, mismatch: false });
  });

  it("does not treat EnvironmentFile-backed tokens as embedded", async () => {
    const audit = await createGatewayAudit({
      expectedGatewayToken: "new-token",
      serviceToken: "old-token",
      environmentValueSources: {
        OPENCLAW_GATEWAY_TOKEN: "file",
      },
    });
    expectTokenAudit(audit, { embedded: false, mismatch: false });
  });

  it("treats tokens present inline and in EnvironmentFile as embedded", async () => {
    const audit = await createGatewayAudit({
      expectedGatewayToken: "new-token",
      serviceToken: "old-token",
      environmentValueSources: {
        OPENCLAW_GATEWAY_TOKEN: "inline-and-file",
      },
    });
    expectTokenAudit(audit, { embedded: true, mismatch: true });
  });

  it("flags inline managed service env values from the service key list", async () => {
    const audit = await createGatewayAudit({
      extraEnvironment: {
        OPENCLAW_SERVICE_MANAGED_ENV_KEYS: "TAVILY_API_KEY,OPENROUTER_API_KEY",
        TAVILY_API_KEY: "tvly-test",
        OPENROUTER_API_KEY: "or-test",
      },
    });

    const issue = audit.issues.find(
      (entry) => entry.code === SERVICE_AUDIT_CODES.gatewayManagedEnvEmbedded,
    );
    expect(issue?.detail).toContain("OPENROUTER_API_KEY");
    expect(issue?.detail).toContain("TAVILY_API_KEY");
  });

  it("flags inline managed values expected by the current install plan for old services", async () => {
    const audit = await createGatewayAudit({
      expectedManagedServiceEnvKeys: ["TAVILY_API_KEY"],
      extraEnvironment: {
        TAVILY_API_KEY: "tvly-test",
      },
    });

    expect(hasIssue(audit, SERVICE_AUDIT_CODES.gatewayManagedEnvEmbedded)).toBe(true);
  });

  it("does not flag managed env values loaded from EnvironmentFile", async () => {
    const audit = await createGatewayAudit({
      expectedManagedServiceEnvKeys: ["TAVILY_API_KEY"],
      extraEnvironment: {
        TAVILY_API_KEY: "tvly-test",
      },
      environmentValueSources: {
        TAVILY_API_KEY: "file",
      },
    });

    expect(hasIssue(audit, SERVICE_AUDIT_CODES.gatewayManagedEnvEmbedded)).toBe(false);
  });

  it("flags managed env values present inline even when an EnvironmentFile overrides them", async () => {
    const audit = await createGatewayAudit({
      expectedManagedServiceEnvKeys: ["TAVILY_API_KEY"],
      extraEnvironment: {
        TAVILY_API_KEY: "tvly-test",
      },
      environmentValueSources: {
        TAVILY_API_KEY: "inline-and-file",
      },
    });

    expect(hasIssue(audit, SERVICE_AUDIT_CODES.gatewayManagedEnvEmbedded)).toBe(true);
  });

  it("flags inline proxy environment values embedded in the service", async () => {
    const audit = await createGatewayAudit({
      extraEnvironment: {
        HTTP_PROXY: "http://proxy.local:7890",
        HTTPS_PROXY: "https://proxy.local:7890",
        NO_PROXY: "localhost,127.0.0.1",
      },
    });

    const issue = audit.issues.find(
      (entry) => entry.code === SERVICE_AUDIT_CODES.gatewayProxyEnvEmbedded,
    );
    expect(issue?.detail).toContain("HTTP_PROXY");
    expect(issue?.detail).toContain("HTTPS_PROXY");
    expect(issue?.detail).toContain("NO_PROXY");
  });

  it("flags lowercase inline proxy environment values using portable key names", async () => {
    const audit = await createGatewayAudit({
      extraEnvironment: {
        https_proxy: "https://proxy.local:7890",
      },
    });

    const issue = audit.issues.find(
      (entry) => entry.code === SERVICE_AUDIT_CODES.gatewayProxyEnvEmbedded,
    );
    expect(issue?.detail).toContain("HTTPS_PROXY");
  });

  it("does not flag proxy values loaded only from EnvironmentFile", async () => {
    const audit = await createGatewayAudit({
      extraEnvironment: {
        HTTP_PROXY: "http://proxy.local:7890",
      },
      environmentValueSources: {
        HTTP_PROXY: "file",
      },
    });

    expect(hasIssue(audit, SERVICE_AUDIT_CODES.gatewayProxyEnvEmbedded)).toBe(false);
  });

  it("flags proxy values present inline even when an EnvironmentFile overrides them", async () => {
    const audit = await createGatewayAudit({
      extraEnvironment: {
        HTTP_PROXY: "http://proxy.local:7890",
      },
      environmentValueSources: {
        HTTP_PROXY: "inline-and-file",
      },
    });

    expect(hasIssue(audit, SERVICE_AUDIT_CODES.gatewayProxyEnvEmbedded)).toBe(true);
  });
});

describe("checkTokenDrift", () => {
  it("returns null when both tokens are undefined", () => {
    const result = checkTokenDrift({ serviceToken: undefined, configToken: undefined });
    expect(result).toBeNull();
  });

  it("returns null when both tokens are empty strings", () => {
    const result = checkTokenDrift({ serviceToken: "", configToken: "" });
    expect(result).toBeNull();
  });

  it("returns null when tokens match", () => {
    const result = checkTokenDrift({ serviceToken: "same-token", configToken: "same-token" });
    expect(result).toBeNull();
  });

  it("returns null when tokens match but service token has trailing newline", () => {
    const result = checkTokenDrift({ serviceToken: "same-token\n", configToken: "same-token" });
    expect(result).toBeNull();
  });

  it("returns null when tokens match but have surrounding whitespace", () => {
    const result = checkTokenDrift({ serviceToken: "  same-token  ", configToken: "same-token" });
    expect(result).toBeNull();
  });

  it("returns null when both tokens have different whitespace padding", () => {
    const result = checkTokenDrift({
      serviceToken: "same-token\r\n",
      configToken: " same-token ",
    });
    expect(result).toBeNull();
  });

  it("detects drift when config has token but service has different token", () => {
    const result = checkTokenDrift({ serviceToken: "old-token", configToken: "new-token" });
    expect(result).not.toBeNull();
    expect(result?.code).toBe(SERVICE_AUDIT_CODES.gatewayTokenDrift);
    expect(result?.message).toContain("differs from service token");
  });

  it("returns null when config has token but service has no token", () => {
    const result = checkTokenDrift({ serviceToken: undefined, configToken: "new-token" });
    expect(result).toBeNull();
  });

  it("returns null when service has token but config does not", () => {
    // This is not really drift - service will work, just config is incomplete
    const result = checkTokenDrift({ serviceToken: "service-token", configToken: undefined });
    expect(result).toBeNull();
  });
});

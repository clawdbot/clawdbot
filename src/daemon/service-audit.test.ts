import { describe, expect, it } from "vitest";
import {
  auditGatewayServiceConfig,
  checkTokenDrift,
  SERVICE_AUDIT_CODES,
} from "./service-audit.js";
import { buildMinimalServicePath } from "./service-env.js";

function hasIssue(
  audit: Awaited<ReturnType<typeof auditGatewayServiceConfig>>,
  code: (typeof SERVICE_AUDIT_CODES)[keyof typeof SERVICE_AUDIT_CODES],
) {
  return audit.issues.some((issue) => issue.code === code);
}

function createGatewayAudit({
  expectedGatewayToken,
  path = "/usr/local/bin:/usr/bin:/bin",
  serviceToken,
  environmentValueSources,
}: {
  expectedGatewayToken?: string;
  path?: string;
  serviceToken?: string;
  environmentValueSources?: Record<string, "file" | "inline">;
} = {}) {
  return auditGatewayServiceConfig({
    env: { HOME: "/tmp" },
    platform: "linux",
    expectedGatewayToken,
    command: {
      programArguments: ["/usr/bin/node", "gateway"],
      environment: {
        PATH: path,
        ...(serviceToken ? { OPENCLAW_GATEWAY_TOKEN: serviceToken } : {}),
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
    const env = { HOME: "/home/testuser", PNPM_HOME: "/opt/pnpm" };
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

  it("accepts Linux fnm aliases/default without requiring the legacy current symlink", async () => {
    const env = { HOME: "/home/testuser", FNM_DIR: "/home/testuser/.local/share/fnm" };
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
    const env = { HOME: "/home/testuser", FNM_DIR: "/home/testuser/.local/share/fnm" };
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

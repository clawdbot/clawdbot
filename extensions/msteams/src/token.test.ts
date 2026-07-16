import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAccessToken } from "./token-response.js";
import { hasConfiguredMSTeamsCredentials, resolveMSTeamsCredentials } from "./token.js";

vi.mock("./secret-input.js", () => ({
  normalizeSecretInputString: (v: unknown) =>
    typeof v === "string" && v.trim() ? v.trim() : undefined,
  normalizeResolvedSecretInputString: (opts: { value: unknown; path: string }) =>
    typeof opts.value === "string" && opts.value.trim() ? opts.value.trim() : undefined,
  hasConfiguredSecretInput: (v: unknown) => typeof v === "string" && v.trim().length > 0,
}));

const ENV_KEYS = [
  "MSTEAMS_APP_ID",
  "MSTEAMS_APP_PASSWORD",
  "MSTEAMS_TENANT_ID",
  "MSTEAMS_AUTH_TYPE",
  "MSTEAMS_CERTIFICATE_PATH",
  "MSTEAMS_CERTIFICATE_THUMBPRINT",
  "MSTEAMS_USE_MANAGED_IDENTITY",
  "MSTEAMS_MANAGED_IDENTITY_CLIENT_ID",
] as const;

let savedEnv: Record<string, string | undefined> = {};

function saveAndClearEnv() {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
}

function restoreEnv() {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] !== undefined) {
      process.env[key] = savedEnv[key];
    } else {
      delete process.env[key];
    }
  }
}

describe("token – secret credentials", () => {
  beforeEach(saveAndClearEnv);
  afterEach(restoreEnv);

  it("returns true when appId + appPassword + tenantId are provided in config", () => {
    const cfg = { appId: "app-id", appPassword: "app-pw", tenantId: "tenant-id" } as any;
    expect(hasConfiguredMSTeamsCredentials(cfg)).toBe(true);
  });

  it("returns false when appPassword is missing", () => {
    const cfg = { appId: "app-id", tenantId: "tenant-id" } as any;
    expect(hasConfiguredMSTeamsCredentials(cfg)).toBe(false);
  });

  it("returns false when no config is given and no env vars set", () => {
    expect(hasConfiguredMSTeamsCredentials(undefined)).toBe(false);
  });

  it("resolves secret credentials from config", () => {
    const cfg = { appId: "app-id", appPassword: "app-pw", tenantId: "tenant-id" } as any;
    const result = resolveMSTeamsCredentials(cfg);
    expect(result).toEqual({
      type: "secret",
      appId: "app-id",
      appPassword: "app-pw",
      tenantId: "tenant-id",
    });
  });

  it("resolves secret credentials from env vars", () => {
    process.env.MSTEAMS_APP_ID = "env-app-id";
    process.env.MSTEAMS_APP_PASSWORD = "env-app-pw";
    process.env.MSTEAMS_TENANT_ID = "env-tenant-id";
    const result = resolveMSTeamsCredentials(undefined);
    expect(result).toEqual({
      type: "secret",
      appId: "env-app-id",
      appPassword: "env-app-pw",
      tenantId: "env-tenant-id",
    });
  });

  it("returns undefined when appPassword is missing", () => {
    const cfg = { appId: "app-id", tenantId: "tenant-id" } as any;
    expect(resolveMSTeamsCredentials(cfg)).toBeUndefined();
  });
});

describe("token – federated credentials (certificate)", () => {
  beforeEach(saveAndClearEnv);
  afterEach(restoreEnv);

  it("hasConfigured returns true when certificate path is provided", () => {
    const cfg = {
      appId: "app-id",
      tenantId: "tenant-id",
      authType: "federated",
      certificatePath: "/cert.pem",
    } as any;
    expect(hasConfiguredMSTeamsCredentials(cfg)).toBe(true);
  });

  it("hasConfigured returns false when neither cert nor MI is provided", () => {
    const cfg = { appId: "app-id", tenantId: "tenant-id", authType: "federated" } as any;
    expect(hasConfiguredMSTeamsCredentials(cfg)).toBe(false);
  });

  it("resolves federated credentials with certificate from config", () => {
    const cfg = {
      appId: "app-id",
      tenantId: "tenant-id",
      authType: "federated",
      certificatePath: "/cert.pem",
      certificateThumbprint: "AABBCCDD",
    } as any;
    const result = resolveMSTeamsCredentials(cfg);
    expect(result).toEqual({
      type: "federated",
      appId: "app-id",
      tenantId: "tenant-id",
      certificatePath: "/cert.pem",
      certificateThumbprint: "AABBCCDD",
      useManagedIdentity: undefined,
      managedIdentityClientId: undefined,
    });
  });

  it("resolves federated credentials from env vars", () => {
    process.env.MSTEAMS_AUTH_TYPE = "federated";
    process.env.MSTEAMS_APP_ID = "env-app-id";
    process.env.MSTEAMS_TENANT_ID = "env-tenant-id";
    process.env.MSTEAMS_CERTIFICATE_PATH = "/env/cert.pem";
    process.env.MSTEAMS_CERTIFICATE_THUMBPRINT = "EEFF0011";
    const result = resolveMSTeamsCredentials(undefined);
    expect(result).toEqual({
      type: "federated",
      appId: "env-app-id",
      tenantId: "env-tenant-id",
      certificatePath: "/env/cert.pem",
      certificateThumbprint: "EEFF0011",
      useManagedIdentity: undefined,
      managedIdentityClientId: undefined,
    });
  });
});

describe("token – federated credentials (managed identity)", () => {
  beforeEach(saveAndClearEnv);
  afterEach(restoreEnv);

  it("resolves managed identity from config", () => {
    const cfg = {
      appId: "app-id",
      tenantId: "tenant-id",
      authType: "federated",
      useManagedIdentity: true,
      managedIdentityClientId: "mi-client-id",
    } as any;
    const result = resolveMSTeamsCredentials(cfg);
    expect(result).toEqual({
      type: "federated",
      appId: "app-id",
      tenantId: "tenant-id",
      certificatePath: undefined,
      certificateThumbprint: undefined,
      useManagedIdentity: true,
      managedIdentityClientId: "mi-client-id",
    });
  });

  it("resolves system-assigned managed identity (no clientId)", () => {
    const cfg = {
      appId: "app-id",
      tenantId: "tenant-id",
      authType: "federated",
      useManagedIdentity: true,
    } as any;
    const result = resolveMSTeamsCredentials(cfg);
    expect(result).toEqual({
      type: "federated",
      appId: "app-id",
      tenantId: "tenant-id",
      certificatePath: undefined,
      certificateThumbprint: undefined,
      useManagedIdentity: true,
      managedIdentityClientId: undefined,
    });
  });

  it("hasConfigured returns true for managed identity via env", () => {
    process.env.MSTEAMS_AUTH_TYPE = "federated";
    process.env.MSTEAMS_APP_ID = "env-app-id";
    process.env.MSTEAMS_TENANT_ID = "env-tenant-id";
    process.env.MSTEAMS_USE_MANAGED_IDENTITY = "true";
    expect(hasConfiguredMSTeamsCredentials(undefined)).toBe(true);
  });

  it("config useManagedIdentity=false overrides env MSTEAMS_USE_MANAGED_IDENTITY=true", () => {
    process.env.MSTEAMS_USE_MANAGED_IDENTITY = "true";
    const cfg = {
      appId: "app-id",
      tenantId: "tenant-id",
      authType: "federated",
      certificatePath: "/cert.pem",
      useManagedIdentity: false,
    } as any;
    const result = resolveMSTeamsCredentials(cfg);
    expect(result).toBeDefined();
    expect(result!.type).toBe("federated");
    expect((result as any).useManagedIdentity).toBeUndefined();
    expect((result as any).certificatePath).toBe("/cert.pem");
  });
});

describe("token – backward compatibility", () => {
  beforeEach(saveAndClearEnv);
  afterEach(restoreEnv);

  it("defaults to secret when authType is absent", () => {
    const cfg = { appId: "app-id", appPassword: "pw", tenantId: "tenant-id" } as any;
    const result = resolveMSTeamsCredentials(cfg);
    expect(result).toBeDefined();
    expect(result!.type).toBe("secret");
  });

  it("explicit authType=secret behaves same as absent", () => {
    const cfg = {
      appId: "app-id",
      appPassword: "pw",
      tenantId: "tenant-id",
      authType: "secret",
    } as any;
    const result = resolveMSTeamsCredentials(cfg);
    expect(result).toEqual({
      type: "secret",
      appId: "app-id",
      appPassword: "pw",
      tenantId: "tenant-id",
    });
  });
});

describe("readAccessToken", () => {
  it("reads string and object token forms", () => {
    expect(readAccessToken("abc")).toBe("abc");
    expect(readAccessToken({ accessToken: "access-token" })).toBe("access-token");
    expect(readAccessToken({ token: "fallback-token" })).toBe("fallback-token");
  });

  it("returns null for unsupported token payloads", () => {
    expect(readAccessToken({ accessToken: 123 })).toBeNull();
    expect(readAccessToken({ token: false })).toBeNull();
    expect(readAccessToken(null)).toBeNull();
    expect(readAccessToken(undefined)).toBeNull();
  });
});

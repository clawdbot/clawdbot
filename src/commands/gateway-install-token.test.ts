import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { resolveGatewayInstallToken } from "./gateway-install-token.js";

const readConfigFileSnapshotMock = vi.hoisted(() => vi.fn());
const readConfigFileSnapshotForWriteMock = vi.hoisted(() => vi.fn());
const replaceConfigFileMock = vi.hoisted(() => vi.fn());
const resolveSecretInputRefMock = vi.hoisted(() =>
  vi.fn((): { ref: unknown } => ({ ref: undefined })),
);
const hasConfiguredSecretInputMock = vi.hoisted(() =>
  vi.fn((value: unknown) => {
    if (typeof value === "string") {
      return value.trim().length > 0;
    }
    return value != null;
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
const shouldRequireGatewayTokenForInstallMock = vi.hoisted(() => vi.fn(() => true));
const resolveSecretRefValuesMock = vi.hoisted(() => vi.fn());
const secretRefKeyMock = vi.hoisted(() => vi.fn(() => "env:default:OPENCLAW_GATEWAY_TOKEN"));
const randomTokenMock = vi.hoisted(() => vi.fn(() => "generated-token"));

vi.mock("./gateway-install-token.persist.runtime.js", () => ({
  readConfigFileSnapshotForWrite: readConfigFileSnapshotForWriteMock,
  replaceConfigFile: replaceConfigFileMock,
}));

vi.mock("../config/types.secrets.js", () => ({
  resolveSecretInputRef: resolveSecretInputRefMock,
  hasConfiguredSecretInput: hasConfiguredSecretInputMock,
}));

vi.mock("../gateway/auth.js", () => ({
  resolveGatewayAuth: resolveGatewayAuthMock,
}));

vi.mock("../gateway/auth-install-policy.js", () => ({
  shouldRequireGatewayTokenForInstall: shouldRequireGatewayTokenForInstallMock,
}));

vi.mock("../secrets/ref-contract.js", () => ({
  secretRefKey: secretRefKeyMock,
}));

vi.mock("../secrets/resolve.js", () => ({
  resolveSecretRefValues: resolveSecretRefValuesMock,
}));

vi.mock("./random-token.js", () => ({
  randomToken: randomTokenMock,
}));

describe("resolveGatewayInstallToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readConfigFileSnapshotMock.mockResolvedValue({ exists: false, valid: true, config: {} });
    readConfigFileSnapshotForWriteMock.mockImplementation(async () => ({
      snapshot: await readConfigFileSnapshotMock(),
      writeOptions: {},
    }));
    resolveSecretInputRefMock.mockReturnValue({ ref: undefined });
    hasConfiguredSecretInputMock.mockImplementation((value: unknown) => {
      if (typeof value === "string") {
        return value.trim().length > 0;
      }
      return value != null;
    });
    resolveSecretRefValuesMock.mockResolvedValue(new Map());
    shouldRequireGatewayTokenForInstallMock.mockReturnValue(true);
    resolveGatewayAuthMock.mockReturnValue({
      mode: "token",
      token: undefined,
      password: undefined,
      allowTailscale: false,
    });
    randomTokenMock.mockReturnValue("generated-token");
  });

  it("uses plaintext gateway.auth.token when configured", async () => {
    const result = await resolveGatewayInstallToken({
      config: {
        gateway: { auth: { token: "config-token" } },
      } as OpenClawConfig,
      env: {} as NodeJS.ProcessEnv,
    });

    expect(result).toEqual({
      token: "config-token",
      tokenRefConfigured: false,
      unavailableReason: undefined,
      warnings: [],
    });
  });

  it("validates SecretRef token but does not persist resolved plaintext", async () => {
    const tokenRef = { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_TOKEN" };
    resolveSecretInputRefMock.mockReturnValue({ ref: tokenRef });
    resolveSecretRefValuesMock.mockResolvedValue(
      new Map([["env:default:OPENCLAW_GATEWAY_TOKEN", "resolved-token"]]),
    );

    const result = await resolveGatewayInstallToken({
      config: {
        gateway: { auth: { mode: "token", token: tokenRef } },
      } as OpenClawConfig,
      env: { OPENCLAW_GATEWAY_TOKEN: "resolved-token" } as NodeJS.ProcessEnv,
    });

    expect(result.token).toBeUndefined();
    expect(result.tokenRefConfigured).toBe(true);
    expect(result.unavailableReason).toBeUndefined();
    expect(result.warnings.some((message) => message.includes("SecretRef-managed"))).toBeTruthy();
  });

  it("returns unavailable reason when token SecretRef is unresolved in token mode", async () => {
    resolveSecretInputRefMock.mockReturnValue({
      ref: { source: "env", provider: "default", id: "MISSING_GATEWAY_TOKEN" },
    });
    resolveSecretRefValuesMock.mockRejectedValue(new Error("missing env var"));

    const result = await resolveGatewayInstallToken({
      config: {
        gateway: { auth: { mode: "token", token: "${MISSING_GATEWAY_TOKEN}" } },
      } as OpenClawConfig,
      env: {} as NodeJS.ProcessEnv,
    });

    expect(result.token).toBeUndefined();
    expect(result.unavailableReason).toContain("gateway.auth.token SecretRef is configured");
  });

  it("returns unavailable reason when token and password are both configured and mode is unset", async () => {
    const result = await resolveGatewayInstallToken({
      config: {
        gateway: {
          auth: {
            token: "token-value",
            password: "password-value", // pragma: allowlist secret
          },
        },
      } as OpenClawConfig,
      env: {} as NodeJS.ProcessEnv,
      autoGenerateWhenMissing: true,
      persistGeneratedToken: true,
    });

    expect(result.token).toBeUndefined();
    expect(result.unavailableReason).toContain("gateway.auth.mode is unset");
    expect(result.unavailableReason).toContain("openclaw config set gateway.auth.mode token");
    expect(result.unavailableReason).toContain("openclaw config set gateway.auth.mode password");
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
    expect(resolveSecretRefValuesMock).not.toHaveBeenCalled();
  });

  it("auto-generates token when no source exists and auto-generation is enabled", async () => {
    const result = await resolveGatewayInstallToken({
      config: {
        gateway: { auth: { mode: "token" } },
      } as OpenClawConfig,
      env: {} as NodeJS.ProcessEnv,
      autoGenerateWhenMissing: true,
    });

    expect(result.token).toBe("generated-token");
    expect(result.unavailableReason).toBeUndefined();
    expect(
      result.warnings.some((message) => message.includes("without saving to config")),
    ).toBeTruthy();
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
  });

  it("persists auto-generated token when requested", async () => {
    const result = await resolveGatewayInstallToken({
      config: {
        gateway: { auth: { mode: "token" } },
      } as OpenClawConfig,
      env: {} as NodeJS.ProcessEnv,
      autoGenerateWhenMissing: true,
      persistGeneratedToken: true,
    });

    expect(result.warnings.some((message) => message.includes("saving to config"))).toBeTruthy();
    expect(replaceConfigFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        nextConfig: expect.objectContaining({
          gateway: {
            auth: {
              mode: "token",
              token: "generated-token",
            },
          },
        }),
        writeOptions: expect.objectContaining({
          baseSnapshot: expect.any(Object),
          skipRuntimeSnapshotRefresh: true,
        }),
        afterWrite: { mode: "auto" },
      }),
    );
  });

  it("drops generated plaintext when config changes to SecretRef before persist", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({
      exists: true,
      valid: true,
      config: {
        gateway: {
          auth: {
            token: "${OPENCLAW_GATEWAY_TOKEN}",
          },
        },
      },
      issues: [],
    });
    resolveSecretInputRefMock.mockReturnValueOnce({ ref: undefined }).mockReturnValueOnce({
      ref: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_TOKEN" },
    });

    const result = await resolveGatewayInstallToken({
      config: {
        gateway: { auth: { mode: "token" } },
      } as OpenClawConfig,
      env: {} as NodeJS.ProcessEnv,
      autoGenerateWhenMissing: true,
      persistGeneratedToken: true,
    });

    expect(result.token).toBeUndefined();
    expect(
      result.warnings.some((message) => message.includes("skipping plaintext token persistence")),
    ).toBeTruthy();
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
  });

  it("does not auto-generate when inferred mode has password SecretRef configured", async () => {
    shouldRequireGatewayTokenForInstallMock.mockReturnValue(false);

    const result = await resolveGatewayInstallToken({
      config: {
        gateway: {
          auth: {
            password: { source: "env", provider: "default", id: "GATEWAY_PASSWORD" },
          },
        },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
      } as OpenClawConfig,
      env: {} as NodeJS.ProcessEnv,
      autoGenerateWhenMissing: true,
      persistGeneratedToken: true,
    });

    expect(result.token).toBeUndefined();
    expect(result.unavailableReason).toBeUndefined();
    expect(result.warnings.some((message) => message.includes("Auto-generated"))).toBe(false);
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
  });

  it("passes the install env through to gateway auth resolution", async () => {
    const env = {
      OPENCLAW_GATEWAY_PASSWORD: "dotenv-password", // pragma: allowlist secret
    } as NodeJS.ProcessEnv;
    shouldRequireGatewayTokenForInstallMock.mockReturnValue(false);
    resolveGatewayAuthMock.mockReturnValue({
      mode: "password",
      token: undefined,
      password: undefined,
      allowTailscale: false,
    });

    const result = await resolveGatewayInstallToken({
      config: {
        gateway: { auth: {} },
      } as OpenClawConfig,
      env,
      autoGenerateWhenMissing: true,
      persistGeneratedToken: true,
    });

    expect(resolveGatewayAuthMock).toHaveBeenCalledWith({
      authConfig: {},
      env,
      tailscaleMode: "off",
    });
    expect(result.token).toBeUndefined();
    expect(result.unavailableReason).toBeUndefined();
    expect(result.warnings.some((message) => message.includes("Auto-generated"))).toBe(false);
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
  });

  it("skips token SecretRef resolution when token auth is not required", async () => {
    const tokenRef = { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_TOKEN" };
    resolveSecretInputRefMock.mockReturnValue({ ref: tokenRef });
    shouldRequireGatewayTokenForInstallMock.mockReturnValue(false);

    const result = await resolveGatewayInstallToken({
      config: {
        gateway: {
          auth: {
            mode: "password",
            token: tokenRef,
          },
        },
      } as OpenClawConfig,
      env: {} as NodeJS.ProcessEnv,
    });

    expect(resolveSecretRefValuesMock).not.toHaveBeenCalled();
    expect(result.unavailableReason).toBeUndefined();
    expect(result.warnings).toEqual([]);
    expect(result.token).toBeUndefined();
    expect(result.tokenRefConfigured).toBe(true);
  });
});

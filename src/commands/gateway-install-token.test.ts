// Gateway install auth tests cover validation and guarded token generation.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import type { ConfigFileSnapshot } from "../config/types.openclaw.js";
import { resolveGatewayInstallToken } from "./gateway-install-token.js";

const replaceConfigFileMock = vi.hoisted(() => vi.fn());
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

vi.mock("../config/mutate.js", () => ({
  replaceConfigFile: replaceConfigFileMock,
}));

vi.mock("../gateway/auth.js", () => ({
  resolveGatewayAuth: resolveGatewayAuthMock,
}));

vi.mock("../gateway/auth-install-policy.js", () => ({
  shouldRequireGatewayTokenForInstall: shouldRequireGatewayTokenForInstallMock,
}));

vi.mock("../secrets/ref-contract.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../secrets/ref-contract.js")>()),
  secretRefKey: secretRefKeyMock,
}));

vi.mock("../secrets/resolve.js", () => ({
  resolveSecretRefValues: resolveSecretRefValuesMock,
}));

vi.mock("./random-token.js", () => ({
  randomToken: randomTokenMock,
}));

function firstReplaceConfigRequest(): unknown {
  const [call] = replaceConfigFileMock.mock.calls;
  if (!call) {
    throw new Error("expected config replace call");
  }
  return call[0];
}

function createGeneration(config: OpenClawConfig = {}) {
  const snapshot: ConfigFileSnapshot = {
    path: "/tmp/openclaw.json",
    exists: true,
    valid: true,
    raw: JSON.stringify(config),
    parsed: config,
    sourceConfig: config,
    resolved: config,
    runtimeConfig: config,
    config,
    hash: "captured-config-hash",
    issues: [],
    warnings: [],
    legacyIssues: [],
  };
  return { snapshot, writeOptions: {} };
}

describe("resolveGatewayInstallToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("does not generate a token when plaintext gateway.auth.token is configured", async () => {
    const result = await resolveGatewayInstallToken({
      config: {
        gateway: { auth: { token: "config-token" } },
      } as OpenClawConfig,
      env: {} as NodeJS.ProcessEnv,
      generateIfMissing: createGeneration(),
    });

    expect(result).toEqual({
      unavailableReason: undefined,
      warnings: [],
    });
    expect(randomTokenMock).not.toHaveBeenCalled();
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
  });

  it("validates SecretRef token but does not persist resolved plaintext", async () => {
    const tokenRef = { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_TOKEN" };
    resolveSecretRefValuesMock.mockResolvedValue(
      new Map([["env:default:OPENCLAW_GATEWAY_TOKEN", "resolved-token"]]),
    );

    const result = await resolveGatewayInstallToken({
      config: {
        gateway: { auth: { mode: "token", token: tokenRef } },
      } as OpenClawConfig,
      env: { OPENCLAW_GATEWAY_TOKEN: "resolved-token" } as NodeJS.ProcessEnv,
      generateIfMissing: createGeneration(),
    });

    expect(result.unavailableReason).toBeUndefined();
    expect(result.warnings.join("\n")).toContain("SecretRef-managed");
    expect(randomTokenMock).not.toHaveBeenCalled();
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
  });

  it("returns unavailable reason when token SecretRef is unresolved in token mode", async () => {
    resolveSecretRefValuesMock.mockRejectedValue(new Error("missing env var"));

    const result = await resolveGatewayInstallToken({
      config: {
        gateway: { auth: { mode: "token", token: "${MISSING_GATEWAY_TOKEN}" } },
      } as OpenClawConfig,
      env: {} as NodeJS.ProcessEnv,
    });

    expect(result.unavailableReason).toBe(
      "gateway.auth.token SecretRef is configured but unresolved (gateway.auth.token SecretRef is unresolved (env:default:MISSING_GATEWAY_TOKEN).).",
    );
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
      generateIfMissing: createGeneration(),
    });

    expect(result.unavailableReason).toContain("gateway.auth.mode is unset");
    expect(result.unavailableReason).toContain("openclaw config set gateway.auth.mode token");
    expect(result.unavailableReason).toContain("openclaw config set gateway.auth.mode password");
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
    expect(resolveSecretRefValuesMock).not.toHaveBeenCalled();
  });

  it("does not generate a token during validation-only setup", async () => {
    const result = await resolveGatewayInstallToken({
      config: {
        gateway: { auth: { mode: "token" } },
      } as OpenClawConfig,
      env: {} as NodeJS.ProcessEnv,
    });

    expect(result.unavailableReason).toBeUndefined();
    expect(result.warnings).toEqual([]);
    expect(randomTokenMock).not.toHaveBeenCalled();
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
  });

  it("persists an auto-generated token with the captured write guards", async () => {
    const generation = createGeneration();
    const baseSnapshot = generation.snapshot;
    const writeOptions = {
      expectedConfigPath: baseSnapshot.path,
      assertConfigPathForWrite: vi.fn(),
    };

    const result = await resolveGatewayInstallToken({
      config: {
        gateway: { auth: { mode: "token" } },
      } as OpenClawConfig,
      env: {} as NodeJS.ProcessEnv,
      generateIfMissing: { ...generation, writeOptions },
    });

    expect(result.warnings.join("\n")).toContain("saving to config");
    expect(replaceConfigFileMock).toHaveBeenCalledOnce();
    expect(firstReplaceConfigRequest()).toStrictEqual({
      sourceConfig: {
        gateway: {
          auth: {
            mode: "token",
            token: "generated-token",
          },
        },
      },
      snapshot: baseSnapshot,
      writeOptions: {
        baseSnapshot,
        ...writeOptions,
        skipRuntimeSnapshotRefresh: true,
      },
      afterWrite: { mode: "auto" },
    });
  });

  it("does not overwrite a SecretRef in the captured source config", async () => {
    const result = await resolveGatewayInstallToken({
      config: {
        gateway: { auth: { mode: "token" } },
      } as OpenClawConfig,
      env: {} as NodeJS.ProcessEnv,
      generateIfMissing: createGeneration({
        gateway: { auth: { token: "${OPENCLAW_GATEWAY_TOKEN}" } },
      }),
    });

    expect(result.warnings.join("\n")).toContain("skipping plaintext token persistence");
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
  });

  it("reports a rejected token write without changing install auth validation", async () => {
    replaceConfigFileMock.mockRejectedValueOnce(new Error("Config changed since it was read"));

    const result = await resolveGatewayInstallToken({
      config: { gateway: { auth: { mode: "token" } } },
      env: {},
      generateIfMissing: createGeneration(),
    });

    expect(replaceConfigFileMock).toHaveBeenCalledOnce();
    expect(result.unavailableReason).toBeUndefined();
    expect(result.warnings).toEqual([
      "No gateway token found. Auto-generated one and saving to config.",
      "Warning: could not persist token to config: Error: Config changed since it was read",
    ]);
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
      generateIfMissing: createGeneration(),
    });

    expect(result.unavailableReason).toBeUndefined();
    expect(result.warnings.join("\n")).not.toContain("Auto-generated");
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
      generateIfMissing: createGeneration(),
    });

    expect(resolveGatewayAuthMock).toHaveBeenCalledWith({
      authConfig: {},
      env,
      tailscaleMode: "off",
    });
    expect(result.unavailableReason).toBeUndefined();
    expect(result.warnings.join("\n")).not.toContain("Auto-generated");
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
  });

  it("skips token SecretRef resolution when token auth is not required", async () => {
    const tokenRef = { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_TOKEN" };
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
    expect(result.warnings).toStrictEqual([]);
  });
});

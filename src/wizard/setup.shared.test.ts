import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import { withoutPluginInstallRecords } from "../plugins/installed-plugin-index-records.js";

const mocks = vi.hoisted(() => ({
  commitConfigWriteWithPendingPluginInstalls: vi.fn(),
  replaceConfigFile: vi.fn(),
}));

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  replaceConfigFile: mocks.replaceConfigFile,
}));

vi.mock("../plugins/install-record-commit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/install-record-commit.js")>()),
  commitConfigWriteWithPendingPluginInstalls: mocks.commitConfigWriteWithPendingPluginInstalls,
}));

import { resolveQuickstartGatewayDefaults, writeWizardConfigFile } from "./setup.shared.js";

describe("resolveQuickstartGatewayDefaults", () => {
  const storedConfig: OpenClawConfig = {
    gateway: {
      port: 19111,
      bind: "custom",
      customBindHost: "192.0.2.10",
      auth: {
        mode: "token",
        token: "stored-token",
        password: "stored-password",
      },
      tailscale: {
        mode: "serve",
        resetOnExit: true,
      },
    },
  };

  it("overlays every explicitly supplied classic quickstart gateway option", () => {
    const result = resolveQuickstartGatewayDefaults(storedConfig, {
      gatewayPort: 19001,
      gatewayBind: "lan",
      gatewayAuth: "password",
      gatewayToken: "explicit-token",
      gatewayPassword: "explicit-password",
      tailscale: "off",
      tailscaleResetOnExit: false,
    });

    expect(result).toEqual({
      hasExisting: true,
      port: 19001,
      bind: "lan",
      authMode: "password",
      tailscaleMode: "off",
      token: "explicit-token",
      password: "explicit-password",
      customBindHost: "192.0.2.10",
      tailscaleResetOnExit: false,
    });
  });

  it("preserves stored quickstart defaults when no override is defined", () => {
    expect(resolveQuickstartGatewayDefaults(storedConfig)).toEqual({
      hasExisting: true,
      port: 19111,
      bind: "custom",
      authMode: "token",
      tailscaleMode: "serve",
      token: "stored-token",
      password: "stored-password",
      customBindHost: "192.0.2.10",
      tailscaleResetOnExit: true,
    });
  });

  it("aligns credential-only overrides while keeping an explicit auth mode authoritative", () => {
    expect(
      resolveQuickstartGatewayDefaults(storedConfig, {
        gatewayPassword: "explicit-password",
      }).authMode,
    ).toBe("password");
    expect(
      resolveQuickstartGatewayDefaults(
        { gateway: { auth: { mode: "password", password: "stored-password" } } },
        { gatewayToken: "explicit-token" },
      ).authMode,
    ).toBe("token");
    expect(
      resolveQuickstartGatewayDefaults(storedConfig, {
        gatewayAuth: "password",
        gatewayToken: "explicit-token",
      }).authMode,
    ).toBe("password");
    expect(
      resolveQuickstartGatewayDefaults(storedConfig, {
        gatewayAuth: "token",
        gatewayPassword: "explicit-password",
      }).authMode,
    ).toBe("token");
  });

  it("maps an explicit env-backed token to the canonical SecretRef", () => {
    expect(
      resolveQuickstartGatewayDefaults(storedConfig, {
        gatewayTokenRefEnv: " OPENCLAW_GATEWAY_TOKEN ",
      }),
    ).toMatchObject({
      authMode: "token",
      token: {
        source: "env",
        provider: "default",
        id: "OPENCLAW_GATEWAY_TOKEN",
      },
    });
  });
});

describe("writeWizardConfigFile pending install ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.commitConfigWriteWithPendingPluginInstalls.mockImplementation(
      async (params: { nextConfig: OpenClawConfig }) => ({
        config: withoutPluginInstallRecords(params.nextConfig),
        installRecords: {},
        movedInstallRecords: true,
        persistedHash: "test-hash",
      }),
    );
    mocks.replaceConfigFile.mockResolvedValue({ persistedHash: "next-hash" });
  });

  it("rejects a normal write with pending records but no migration base", async () => {
    const config: OpenClawConfig = {
      plugins: { installs: { demo: { source: "npm", spec: "demo@1.0.0" } } },
    };

    await expect(writeWizardConfigFile(config, { allowConfigSizeDrop: false })).rejects.toThrow(
      "declare migration ownership",
    );
    expect(mocks.commitConfigWriteWithPendingPluginInstalls).not.toHaveBeenCalled();
  });

  it("migrates the baseline as source before the final wizard write", async () => {
    const baseConfig: OpenClawConfig = {
      plugins: { installs: { demo: { source: "npm", spec: "demo@1.0.0" } } },
    };

    await writeWizardConfigFile(baseConfig, {
      allowConfigSizeDrop: false,
      migrationBaseConfig: baseConfig,
    });

    expect(mocks.commitConfigWriteWithPendingPluginInstalls).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        nextConfig: baseConfig,
        sourceConfig: baseConfig,
        writeOptions: { allowConfigSizeDrop: true },
      }),
    );
    expect(mocks.commitConfigWriteWithPendingPluginInstalls).toHaveBeenCalledTimes(2);
  });

  it("commits fresh pending records after baseline migration is complete", async () => {
    const config: OpenClawConfig = {
      plugins: { installs: { fresh: { source: "npm", spec: "fresh@1.0.0" } } },
    };

    await writeWizardConfigFile(config, {
      allowConfigSizeDrop: false,
      migrationBaseConfig: undefined,
    });

    expect(mocks.commitConfigWriteWithPendingPluginInstalls).toHaveBeenCalledOnce();
    expect(mocks.commitConfigWriteWithPendingPluginInstalls).toHaveBeenCalledWith(
      expect.objectContaining({ nextConfig: config }),
    );
  });

  it("binds the final write to the live-verified config hash", async () => {
    const config: OpenClawConfig = { gateway: { port: 18789 } };

    await writeWizardConfigFile(config, { baseHash: "verified-hash" });

    const commit = mocks.commitConfigWriteWithPendingPluginInstalls.mock.calls[0]?.[0]?.commit;
    expect(commit).toBeTypeOf("function");
    await commit(config);
    expect(mocks.replaceConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        nextConfig: config,
        baseHash: "verified-hash",
        afterWrite: { mode: "auto" },
      }),
    );
  });

  it("preserves an absent config snapshot through the final write", async () => {
    const config: OpenClawConfig = { gateway: { port: 18789 } };
    const baseSnapshot: ConfigFileSnapshot = {
      path: "/tmp/openclaw.json",
      exists: false,
      raw: null,
      parsed: undefined,
      sourceConfig: {},
      resolved: {},
      valid: true,
      runtimeConfig: {},
      config: {},
      issues: [],
      warnings: [],
      legacyIssues: [],
    };

    await writeWizardConfigFile(config, { baseSnapshot });

    const commit = mocks.commitConfigWriteWithPendingPluginInstalls.mock.calls[0]?.[0]?.commit;
    expect(commit).toBeTypeOf("function");
    await commit(config);
    expect(mocks.replaceConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({ nextConfig: config, snapshot: baseSnapshot }),
    );
  });
});

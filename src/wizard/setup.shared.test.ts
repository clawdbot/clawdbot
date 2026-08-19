import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";

const mocks = vi.hoisted(() => ({
  currentConfig: {} as OpenClawConfig,
  transformConfigWithPendingPluginInstalls: vi.fn(),
}));

vi.mock("../plugins/install-record-commit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/install-record-commit.js")>()),
  transformConfigWithPendingPluginInstalls: mocks.transformConfigWithPendingPluginInstalls,
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

describe("writeWizardConfigFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.currentConfig = {};
    mocks.transformConfigWithPendingPluginInstalls.mockImplementation(
      async (params: {
        transform: (current: OpenClawConfig) => { nextConfig: OpenClawConfig };
      }) => ({ nextConfig: params.transform(mocks.currentConfig).nextConfig }),
    );
  });

  it("delegates CAS and pending-install ownership to the canonical transform", async () => {
    const config: OpenClawConfig = { gateway: { port: 18789 } };
    const baseSnapshot = { path: "/tmp/openclaw.json", exists: false } as ConfigFileSnapshot;
    const afterWrite = { mode: "none" as const, reason: "restart after setup" };

    await writeWizardConfigFile(config, {
      allowConfigSizeDrop: false,
      baseHash: "verified-hash",
      baseSnapshot,
      afterWrite,
    });

    expect(mocks.transformConfigWithPendingPluginInstalls).toHaveBeenCalledWith({
      baseHash: "verified-hash",
      maxAttempts: 1,
      afterWrite,
      writeOptions: { allowConfigSizeDrop: false, baseSnapshot },
      transform: expect.any(Function),
    });
  });

  it("replaces config directly when no merge base is supplied", async () => {
    const config: OpenClawConfig = {
      plugins: { installs: { fresh: { source: "npm", spec: "fresh@1.0.0" } } },
    };
    mocks.currentConfig = { gateway: { port: 19001 } };

    await expect(writeWizardConfigFile(config)).resolves.toEqual(config);
  });

  it("applies only the wizard delta to a fresh concurrent config", async () => {
    const base: OpenClawConfig = {
      agents: { defaults: { workspace: "/old" } },
      gateway: { port: 18789 },
    };
    const next: OpenClawConfig = {
      agents: { defaults: { workspace: "/old" } },
      gateway: { port: 19001 },
    };
    mocks.currentConfig = {
      agents: { defaults: { workspace: "/concurrent" } },
      gateway: { port: 18789 },
      plugins: { entries: { demo: { enabled: true } } },
    };

    await expect(writeWizardConfigFile(next, { mergeBase: base })).resolves.toEqual({
      agents: { defaults: { workspace: "/concurrent" } },
      gateway: { port: 19001 },
      plugins: { entries: { demo: { enabled: true } } },
    });
  });
});

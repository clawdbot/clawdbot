import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { createTestConfigFileStore } from "../commands/test-runtime-config-helpers.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import type { WizardPrompter } from "./prompts.js";

const configFiles = createTestConfigFileStore();

const mocks = vi.hoisted(() => ({
  currentConfig: {} as OpenClawConfig,
  transformConfigWithPendingPluginInstalls: vi.fn(),
}));

vi.mock("../plugins/install-record-commit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/install-record-commit.js")>()),
  transformConfigWithPendingPluginInstalls: mocks.transformConfigWithPendingPluginInstalls,
}));

import {
  formatQuickstartGatewaySummary,
  requestTelemetryConsent,
  resolveQuickstartGatewayDefaults,
  writeWizardConfigFile,
} from "./setup.shared.js";

describe("requestTelemetryConsent", () => {
  it.each([false, true])("records the interactive operator's %s choice once", async (enabled) => {
    const select = vi.fn(async () => enabled) as unknown as WizardPrompter["select"];
    const prompter = createWizardPrompter({ select });

    const config = await requestTelemetryConsent({ opts: {}, prompter, config: {} });

    expect(config.telemetry).toEqual({ enabled, consentedAt: expect.any(String) });
    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("Never messages, never identifiers"),
      "Help make OpenClaw better?",
    );
    expect(select).toHaveBeenCalledWith({
      message: "Help make OpenClaw better?",
      options: [
        { value: false, label: "No thanks" },
        { value: true, label: "Yes, share feature stats" },
      ],
      initialValue: false,
    });

    await expect(requestTelemetryConsent({ opts: {}, prompter, config })).resolves.toBe(config);
    expect(select).toHaveBeenCalledOnce();
  });

  it("leaves telemetry unset without prompting during non-interactive onboarding", async () => {
    const prompter = createWizardPrompter();
    const config: OpenClawConfig = {};

    await expect(
      requestTelemetryConsent({ opts: { nonInteractive: true }, prompter, config }),
    ).resolves.toBe(config);
    expect(config.telemetry).toBeUndefined();
    expect(prompter.note).not.toHaveBeenCalled();
    expect(prompter.select).not.toHaveBeenCalled();
  });
});

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

  it.each([
    { config: {}, expected: "Gateway secret (generated)", mode: "token" },
    {
      config: { gateway: { auth: { mode: "password" as const, password: "saved-password" } } },
      expected: "Password",
      mode: "password",
    },
  ])(
    "summarizes the resolved $mode secret without offering an auth choice",
    ({ config, expected, mode }) => {
      const defaults = resolveQuickstartGatewayDefaults(config);
      expect(defaults.authMode).toBe(mode);
      expect(formatQuickstartGatewaySummary(defaults, defaults.hasExisting)).toContain(expected);
    },
  );

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
      async (params: { transform: (current: OpenClawConfig) => { nextConfig: OpenClawConfig } }) =>
        configFiles.write(params.transform(mocks.currentConfig).nextConfig),
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

    await expect(writeWizardConfigFile(config)).resolves.toMatchObject({
      nextConfig: config,
      path: "/tmp/openclaw.json",
    });
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

    await expect(writeWizardConfigFile(next, { mergeBase: base })).resolves.toMatchObject({
      path: "/tmp/openclaw.json",
      nextConfig: {
        agents: { defaults: { workspace: "/concurrent" } },
        gateway: { port: 19001 },
        plugins: { entries: { demo: { enabled: true } } },
      },
    });
  });
});

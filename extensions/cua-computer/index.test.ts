import fs from "node:fs";
import {
  validateJsonSchemaValue,
  type JsonSchemaObject,
} from "openclaw/plugin-sdk/json-schema-runtime";
import {
  normalizePluginsConfig,
  resolveEffectiveEnableState,
} from "openclaw/plugin-sdk/plugin-config-runtime";
import type {
  OpenClawPluginNodeHostCommand,
  OpenClawPluginNodeInvokePolicy,
  OpenClawPluginNodeInvokePolicyContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi, type TestPluginApiInput } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const artifactMocks = vi.hoisted(() => ({
  verify: vi.fn(),
  registerDoctor: vi.fn(),
}));

vi.mock("./api.js", () => ({
  registerCuaDriverDoctorChecks: artifactMocks.registerDoctor,
}));

vi.mock("./src/driver-artifacts.js", () => ({
  verifyInstalledCuaDriverArtifacts: artifactMocks.verify,
}));

import plugin from "./index.js";

const originalPlatform = process.platform;
const enabledConfig = { plugins: { entries: { "cua-computer": { enabled: true } } } };

function registerPlugin(overrides: TestPluginApiInput = {}) {
  plugin.register(createTestPluginApi({ id: "cua-computer", config: enabledConfig, ...overrides }));
}

function validateManifestConfig(value: unknown) {
  const manifest = JSON.parse(
    fs.readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
  ) as { configSchema: JsonSchemaObject };
  return validateJsonSchemaValue({
    cacheKey: "cua-computer.manifest.config.test",
    schema: manifest.configSchema,
    value,
  });
}

describe("cua-computer plugin registration", () => {
  beforeEach(() => {
    artifactMocks.verify.mockReset().mockReturnValue({ ok: true, applicable: false });
    artifactMocks.registerDoctor.mockReset();
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
  });

  it("enables Gateway policy by default while keeping explicit plugin disable authoritative", () => {
    const manifest = JSON.parse(
      fs.readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
    ) as { enabledByDefault?: boolean; enabledByDefaultOnPlatforms?: string[] };

    expect(manifest.enabledByDefault).toBe(true);
    expect(manifest.enabledByDefaultOnPlatforms).toBeUndefined();
    expect(
      resolveEffectiveEnableState({
        id: "cua-computer",
        origin: "bundled",
        enabledByDefault: manifest.enabledByDefault,
        config: normalizePluginsConfig({ entries: { "cua-computer": { enabled: false } } }),
      }).enabled,
    ).toBe(false);
  });

  it.each(["linux", "win32"])("loads only remote policy by default on %s", (platform) => {
    Object.defineProperty(process, "platform", { configurable: true, value: platform });
    const registerNodeHostCommand = vi.fn();
    const policies: OpenClawPluginNodeInvokePolicy[] = [];
    registerPlugin({
      config: {},
      registerNodeHostCommand,
      registerNodeInvokePolicy: (policy) => policies.push(policy),
    });
    expect(policies).toHaveLength(1);
    expect(policies[0]).toMatchObject({ commands: ["computer.act"], dangerous: true });
    expect(registerNodeHostCommand).not.toHaveBeenCalled();
    expect(artifactMocks.verify).not.toHaveBeenCalled();
    expect(artifactMocks.registerDoctor).not.toHaveBeenCalled();
  });

  it.each([
    { platform: "darwin", config: {} },
    { platform: "linux", config: enabledConfig },
    { platform: "win32", config: enabledConfig },
    {
      platform: "linux",
      config: { plugins: { entries: { " CUA-COMPUTER ": { enabled: true } } } },
    },
  ])("preserves native provider activation on $platform", ({ platform, config }) => {
    Object.defineProperty(process, "platform", { configurable: true, value: platform });
    const commands: OpenClawPluginNodeHostCommand[] = [];
    registerPlugin({ config, registerNodeHostCommand: (command) => commands.push(command) });
    expect(commands.map((command) => command.command)).toEqual(["screen.snapshot", "computer.act"]);
    expect(artifactMocks.verify).toHaveBeenCalledOnce();
    expect(artifactMocks.registerDoctor).toHaveBeenCalledOnce();
  });

  it("registers the screen and dangerous computer node-host commands", () => {
    const commands: OpenClawPluginNodeHostCommand[] = [];
    const policies: OpenClawPluginNodeInvokePolicy[] = [];
    const registerTool = vi.fn();
    const registerCli = vi.fn();
    const registerNodeCliFeature = vi.fn();
    const registerService = vi.fn();
    registerPlugin({
      pluginConfig: {},
      registerNodeHostCommand: (command: OpenClawPluginNodeHostCommand) => commands.push(command),
      registerNodeInvokePolicy: (policy: OpenClawPluginNodeInvokePolicy) => policies.push(policy),
      registerTool,
      registerCli,
      registerNodeCliFeature,
      registerService,
    });

    expect(commands.map(({ command, cap, dangerous }) => ({ command, cap, dangerous }))).toEqual([
      { command: "screen.snapshot", cap: "screen", dangerous: false },
      { command: "computer.act", cap: "computer", dangerous: true },
    ]);
    expect(policies).toHaveLength(1);
    expect(policies[0]).toMatchObject({ commands: ["computer.act"], dangerous: true });
    expect(policies[0]?.defaultPlatforms).toBeUndefined();
    expect(commands.every((command) => command.agentTool === undefined)).toBe(true);
    expect(registerTool).not.toHaveBeenCalled();
    expect(registerCli).not.toHaveBeenCalled();
    expect(registerNodeCliFeature).not.toHaveBeenCalled();
    expect(registerService).not.toHaveBeenCalled();
  });

  it("accepts the retired driver path as a no-op while keeping both schemas strict", () => {
    const config = { driverPath: "/usr/local/bin/cua-driver" };
    const runtimeResult = plugin.configSchema.safeParse?.(config);

    expect(runtimeResult).toEqual({ success: true, data: config });
    expect(validateManifestConfig(config).ok).toBe(true);
    expect(plugin.configSchema.safeParse?.({ unexpected: true }).success).toBe(false);
    expect(validateManifestConfig({ unexpected: true }).ok).toBe(false);
    expect(plugin.configSchema).not.toHaveProperty("uiHints");

    const commands: OpenClawPluginNodeHostCommand[] = [];
    registerPlugin({
      pluginConfig: config,
      registerNodeHostCommand: (command: OpenClawPluginNodeHostCommand) => commands.push(command),
      registerNodeInvokePolicy: () => {},
    });

    expect(commands.map(({ command, cap, dangerous }) => ({ command, cap, dangerous }))).toEqual([
      { command: "screen.snapshot", cap: "screen", dangerous: false },
      { command: "computer.act", cap: "computer", dangerous: true },
    ]);
  });

  it("logs the typed artifact diagnostic during plugin startup", () => {
    const error = vi.fn();
    artifactMocks.verify.mockReturnValue({
      ok: false,
      code: "COMPUTER_DRIVER_PACKAGE_MISSING",
      diagnostic:
        "COMPUTER_DRIVER_PACKAGE_MISSING: native package absent. Fix: reinstall OpenClaw.",
      fixHint: "Reinstall OpenClaw.",
    });

    registerPlugin({
      pluginConfig: {},
      logger: { info() {}, warn() {}, error },
      registerNodeHostCommand: () => {},
      registerNodeInvokePolicy: () => {},
    });

    expect(error).toHaveBeenCalledWith(
      "COMPUTER_DRIVER_PACKAGE_MISSING: native package absent. Fix: reinstall OpenClaw.",
    );
  });

  it("forwards an explicitly armed computer action and preserves node refusals", async () => {
    const policies: OpenClawPluginNodeInvokePolicy[] = [];
    registerPlugin({
      pluginConfig: {},
      registerNodeHostCommand: () => {},
      registerNodeInvokePolicy: (policy: OpenClawPluginNodeInvokePolicy) => policies.push(policy),
    });
    const refusal = {
      ok: false as const,
      code: "INVALID_REQUEST",
      message: "COMPUTER_STALE_FRAME: take a new screenshot",
    };
    const invokeNode = vi.fn(async () => refusal);

    await expect(
      policies[0]!.handle({
        invokeNode,
        risk: { level: "ordinary", family: "input" },
      } as unknown as OpenClawPluginNodeInvokePolicyContext),
    ).resolves.toEqual(refusal);
    expect(invokeNode).toHaveBeenCalledOnce();
  });
});

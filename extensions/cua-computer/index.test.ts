import fs from "node:fs";
import {
  validateJsonSchemaValue,
  type JsonSchemaObject,
} from "openclaw/plugin-sdk/json-schema-runtime";
import type {
  OpenClawPluginApi,
  OpenClawPluginNodeHostCommand,
  OpenClawPluginNodeInvokePolicy,
  OpenClawPluginNodeInvokePolicyContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { beforeEach, describe, expect, it, vi } from "vitest";

const artifactMocks = vi.hoisted(() => ({
  verify: vi.fn(),
}));

vi.mock("./src/driver-artifacts.js", () => ({
  verifyInstalledCuaDriverArtifacts: artifactMocks.verify,
}));

import plugin from "./index.js";

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
  });

  it("defaults on only for the app-gated macOS provider path", () => {
    const manifest = JSON.parse(
      fs.readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
    ) as { enabledByDefault?: boolean; enabledByDefaultOnPlatforms?: string[] };

    expect(manifest.enabledByDefault).toBe(false);
    expect(manifest.enabledByDefaultOnPlatforms).toEqual(["darwin"]);
  });

  it("registers the screen and dangerous computer node-host commands", () => {
    const commands: OpenClawPluginNodeHostCommand[] = [];
    const policies: OpenClawPluginNodeInvokePolicy[] = [];
    const registerTool = vi.fn();
    const registerCli = vi.fn();
    const registerNodeCliFeature = vi.fn();
    const registerService = vi.fn();
    plugin.register({
      pluginConfig: {},
      registerNodeHostCommand: (command: OpenClawPluginNodeHostCommand) => commands.push(command),
      registerNodeInvokePolicy: (policy: OpenClawPluginNodeInvokePolicy) => policies.push(policy),
      registerTool,
      registerCli,
      registerNodeCliFeature,
      registerService,
    } as unknown as OpenClawPluginApi);

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
    plugin.register({
      pluginConfig: config,
      registerNodeHostCommand: (command: OpenClawPluginNodeHostCommand) => commands.push(command),
      registerNodeInvokePolicy: () => {},
    } as unknown as OpenClawPluginApi);

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

    plugin.register({
      pluginConfig: {},
      logger: { error },
      registerNodeHostCommand: () => {},
      registerNodeInvokePolicy: () => {},
    } as unknown as OpenClawPluginApi);

    expect(error).toHaveBeenCalledWith(
      "COMPUTER_DRIVER_PACKAGE_MISSING: native package absent. Fix: reinstall OpenClaw.",
    );
  });

  it("forwards an explicitly armed computer action and preserves node refusals", async () => {
    const policies: OpenClawPluginNodeInvokePolicy[] = [];
    plugin.register({
      pluginConfig: {},
      registerNodeHostCommand: () => {},
      registerNodeInvokePolicy: (policy: OpenClawPluginNodeInvokePolicy) => policies.push(policy),
    } as unknown as OpenClawPluginApi);
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

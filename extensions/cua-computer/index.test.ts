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
import { describe, expect, it, vi } from "vitest";
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
  it("registers the screen and dangerous computer node-host commands", () => {
    const commands: OpenClawPluginNodeHostCommand[] = [];
    const policies: OpenClawPluginNodeInvokePolicy[] = [];
    plugin.register({
      pluginConfig: {},
      registerNodeHostCommand: (command: OpenClawPluginNodeHostCommand) => commands.push(command),
      registerNodeInvokePolicy: (policy: OpenClawPluginNodeInvokePolicy) => policies.push(policy),
    } as unknown as OpenClawPluginApi);

    expect(commands.map(({ command, cap, dangerous }) => ({ command, cap, dangerous }))).toEqual([
      { command: "screen.snapshot", cap: "screen", dangerous: false },
      { command: "computer.act", cap: "computer", dangerous: true },
    ]);
    expect(policies).toHaveLength(1);
    expect(policies[0]).toMatchObject({ commands: ["computer.act"], dangerous: true });
    expect(policies[0]?.defaultPlatforms).toBeUndefined();
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
      policies[0]!.handle({ invokeNode } as unknown as OpenClawPluginNodeInvokePolicyContext),
    ).resolves.toEqual(refusal);
    expect(invokeNode).toHaveBeenCalledOnce();
  });
});

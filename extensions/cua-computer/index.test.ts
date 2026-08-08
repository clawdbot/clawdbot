import type {
  OpenClawPluginApi,
  OpenClawPluginNodeHostCommand,
  OpenClawPluginNodeInvokePolicy,
  OpenClawPluginNodeInvokePolicyContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

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

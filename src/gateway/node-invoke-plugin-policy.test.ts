import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRegistry } from "../plugins/registry-types.js";
import type { OpenClawPluginNodeInvokePolicyContext } from "../plugins/types.js";
import { applyPluginNodeInvokePolicy } from "./node-invoke-plugin-policy.js";
import type { NodeSession } from "./node-registry.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

const registryState = vi.hoisted(() => ({
  current: null as PluginRegistry | null,
}));

vi.mock("../plugins/active-runtime-registry.js", () => ({
  getActiveRuntimePluginRegistry: () => registryState.current,
}));

function createNodeSession(): NodeSession {
  return {
    nodeId: "node-1",
    connId: "conn-1",
    client: {} as NodeSession["client"],
    caps: [],
    commands: ["demo.read"],
    connectedAtMs: 0,
  };
}

function createContext() {
  const invoke = vi.fn(async () => ({
    ok: true,
    payload: { ok: true, value: 1 },
    payloadJSON: null,
    error: null,
  }));
  return {
    context: {
      getRuntimeConfig: () => ({}),
      nodeRegistry: { invoke },
      broadcast: vi.fn(),
    } as unknown as GatewayRequestContext,
    invoke,
  };
}

describe("applyPluginNodeInvokePolicy", () => {
  beforeEach(() => {
    registryState.current = null;
  });

  it("fails closed for dangerous plugin node commands without a policy", async () => {
    registryState.current = {
      nodeHostCommands: [
        {
          pluginId: "demo",
          command: {
            command: "demo.read",
            dangerous: true,
            handle: async () => "{}",
          },
          source: "test",
        },
      ],
      nodeInvokePolicies: [],
    } as unknown as PluginRegistry;
    const { context, invoke } = createContext();

    const result = await applyPluginNodeInvokePolicy({
      context,
      client: null,
      nodeSession: createNodeSession(),
      command: "demo.read",
      params: { path: "/tmp/x" },
    });

    expect(result).toMatchObject({
      ok: false,
      code: "PLUGIN_POLICY_MISSING",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("uses a matching plugin policy when one is registered", async () => {
    registryState.current = {
      nodeHostCommands: [
        {
          pluginId: "demo",
          command: {
            command: "demo.read",
            dangerous: true,
            handle: async () => "{}",
          },
          source: "test",
        },
      ],
      nodeInvokePolicies: [
        {
          pluginId: "demo",
          policy: {
            commands: ["demo.read"],
            handle: (ctx: OpenClawPluginNodeInvokePolicyContext) => ctx.invokeNode(),
          },
          pluginConfig: { enabled: true },
          source: "test",
        },
      ],
    } as unknown as PluginRegistry;
    const { context, invoke } = createContext();

    const result = await applyPluginNodeInvokePolicy({
      context,
      client: null,
      nodeSession: createNodeSession(),
      command: "demo.read",
      params: { path: "/tmp/x" },
    });

    expect(result).toMatchObject({ ok: true, payload: { ok: true, value: 1 } });
    expect(invoke).toHaveBeenCalledWith({
      nodeId: "node-1",
      command: "demo.read",
      params: { path: "/tmp/x" },
      timeoutMs: undefined,
      idempotencyKey: undefined,
    });
  });

  it("leaves commands without a dangerous plugin registration to normal allowlist handling", async () => {
    registryState.current = {
      nodeHostCommands: [],
      nodeInvokePolicies: [],
    } as unknown as PluginRegistry;
    const { context } = createContext();

    const result = await applyPluginNodeInvokePolicy({
      context,
      client: null,
      nodeSession: createNodeSession(),
      command: "safe.echo",
      params: { value: "hello" },
    });

    expect(result).toBeNull();
  });
});

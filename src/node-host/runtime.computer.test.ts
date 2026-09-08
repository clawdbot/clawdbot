import { afterEach, describe, expect, it, vi } from "vitest";
import { NODE_WORKER_DESKTOP_COMPUTER_COMMAND } from "../infra/node-commands.js";
import {
  registerComputerUseProvider,
  type ComputerUseCapabilityDescriptor,
} from "../plugins/computer-use-contract.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { NodeHostClient } from "./client.js";
import { prepareNodeHostRuntime } from "./runtime.js";

vi.mock("../infra/path-env.js", () => ({ ensureOpenClawCliOnPath: vi.fn() }));
vi.mock("./mcp.js", () => ({
  startNodeHostMcpManager: vi.fn(async () => ({ descriptors: [], close: async () => {} })),
}));
vi.mock("../plugins/loader.js", () => ({
  loadPluginRegistryHandle: () => getActivePluginRegistry(),
}));

afterEach(() => resetPluginRuntimeStateForTest());

const executionId = "123e4567-e89b-42d3-a456-426614174000";
const otherExecutionId = "223e4567-e89b-42d3-a456-426614174000";
const descriptor: ComputerUseCapabilityDescriptor = {
  contractVersion: 2,
  provider: { id: "fixture", label: "Fixture", generation: "generation-1" },
  actions: ["screenshot", "type"],
  targets: ["screen"],
  deliveryModes: ["foreground"],
  observations: ["image"],
  features: { recording: false, agentCursor: false, multiDisplay: false },
};

async function startComputer(ephemeral = true, prepare?: () => Promise<void>) {
  let available = true;
  let providerGeneration = descriptor.provider.generation;
  let availabilityChanged: (() => void) | undefined;
  const snapshot = vi.fn(async (_params: unknown, _signal?: AbortSignal) =>
    JSON.stringify({ format: "png", base64: "c2NyZWVu", displayFrameId: "frame-1" }),
  );
  const act = vi.fn(async (_params: unknown, _signal?: AbortSignal) =>
    JSON.stringify({ ok: true }),
  );
  const close = vi.fn(async (_reason: string) => {});
  const openExecution = vi.fn(async (_context: unknown) => ({ snapshot, act, close }));
  const registry = createEmptyPluginRegistry();
  registry.plugins.push(createPluginRecord({ id: "fixture", enabled: true, status: "loaded" }));
  registerComputerUseProvider(
    {
      registerNodeHostCommand: (command) =>
        registry.nodeHostCommands.push({ pluginId: "fixture", command, source: "test" }),
    },
    {
      id: "fixture",
      label: "Fixture",
      isAvailable: () => available,
      prepare,
      capabilities: () => ({
        ...descriptor,
        provider: { ...descriptor.provider, generation: providerGeneration },
      }),
      openExecution,
      watchAvailability: (_context, notify) => {
        availabilityChanged = notify;
      },
    },
  );
  setActivePluginRegistry(registry);
  const prepared = await prepareNodeHostRuntime({
    config: { nodeHost: { skills: { enabled: false } } },
    env: { PATH: "/usr/bin" },
    ephemeral,
  });
  const requests: Array<Parameters<NodeHostClient["request"]>> = [];
  function request<T>(...args: Parameters<NodeHostClient["request"]>): Promise<T>;
  async function request(...args: Parameters<NodeHostClient["request"]>): Promise<unknown> {
    requests.push(args);
    return {};
  }
  const onManifestChanged = vi.fn();
  const runtime = prepared.start({ client: { request }, onManifestChanged });
  let invokeId = 0;
  const invoke = async (input: unknown, command = NODE_WORKER_DESKTOP_COMPUTER_COMMAND) => {
    const id = `invoke-${++invokeId}`;
    await runtime.invoke({
      id,
      nodeId: "cloud-node",
      sessionKey: "agent:main:cloud-session",
      command,
      paramsJSON: JSON.stringify(input),
    });
    const result = requests.find(
      (call) => call[0] === "node.invoke.result" && (call[1] as { id?: string }).id === id,
    )?.[1] as { ok: boolean; payloadJSON?: string; error?: { code: string; message: string } };
    return { ...result, payload: result?.payloadJSON ? JSON.parse(result.payloadJSON) : undefined };
  };
  return {
    prepared,
    runtime,
    invoke,
    snapshot,
    act,
    close,
    openExecution,
    onManifestChanged,
    setProviderGeneration(value: string) {
      providerGeneration = value;
    },
    setAvailable(value: boolean) {
      available = value;
      availabilityChanged?.();
    },
  };
}

describe("private worker computer runtime", () => {
  it("awaits the registered provider preparation before publishing the first manifest", async () => {
    const gate = createDeferredCore();
    const prepare = vi.fn(() => gate.promise);
    let prepared = false;
    const starting = startComputer(true, prepare).then((host) => {
      prepared = true;
      return host;
    });
    try {
      await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
      expect(prepared).toBe(false);
      gate.resolve();
      const host = await starting;
      expect(await host.invoke({ operation: "capabilities" })).toMatchObject({ ok: true });
      host.runtime.cancelAll();
      await host.invoke({ operation: "capabilities" });
      expect(prepare).toHaveBeenCalledOnce();
    } finally {
      gate.resolve();
      await (await starting).runtime.close();
    }
  });

  it("uses the registered provider and exact execution lifecycle without publishing public computer commands", async () => {
    const host = await startComputer();
    try {
      expect(host.prepared.manifest.computerUse).toBeUndefined();
      expect(host.prepared.manifest.commands).not.toContain("computer.act");
      expect(host.prepared.manifest.commands).not.toContain(NODE_WORKER_DESKTOP_COMPUTER_COMMAND);
      expect(await host.invoke({ operation: "capabilities" })).toMatchObject({
        ok: true,
        payload: descriptor,
      });
      expect(
        await host.invoke({
          operation: "snapshot",
          providerGeneration: descriptor.provider.generation,
          params: { executionId },
        }),
      ).toMatchObject({
        ok: true,
        payload: { displayFrameId: "frame-1" },
      });
      expect(
        await host.invoke({
          operation: "act",
          providerGeneration: descriptor.provider.generation,
          params: { executionId, action: "type", text: "fixture" },
        }),
      ).toMatchObject({ ok: true, payload: { ok: true } });
      expect(host.openExecution).toHaveBeenCalledExactlyOnceWith({
        executionId,
        sessionKey: "agent:main:cloud-session",
      });
      expect(host.act).toHaveBeenCalledWith(
        JSON.stringify({ executionId, action: "type", text: "fixture" }),
        expect.any(AbortSignal),
      );
      expect(
        await host.invoke({
          operation: "act",
          providerGeneration: descriptor.provider.generation,
          params: { executionId: otherExecutionId, action: "type", text: "wrong owner" },
        }),
      ).toMatchObject({
        ok: false,
        error: { message: expect.stringContaining("COMPUTER_HOST_BUSY") },
      });
      await host.invoke({
        operation: "close",
        executionId: otherExecutionId,
        reason: "completion",
      });
      expect(host.close).not.toHaveBeenCalled();
      host.setAvailable(false);
      expect(host.onManifestChanged).not.toHaveBeenCalled();
      await host.invoke({ operation: "close", executionId, reason: "completion" });
      expect(host.close).toHaveBeenCalledExactlyOnceWith("completion");
      host.setAvailable(true);
      await host.invoke({
        operation: "snapshot",
        providerGeneration: descriptor.provider.generation,
        params: { executionId: otherExecutionId },
      });
      host.runtime.cancelAll();
      await vi.waitFor(() => expect(host.close).toHaveBeenLastCalledWith("gateway-disconnect"));
      await host.runtime.close();
      expect(host.close.mock.calls).toEqual([["completion"], ["gateway-disconnect"]]);
    } finally {
      await host.runtime.close();
    }
  });

  it("rejects a prepared provider generation after rotation without blocking exact execution cleanup", async () => {
    const host = await startComputer();
    try {
      expect(
        await host.invoke({
          operation: "snapshot",
          providerGeneration: descriptor.provider.generation,
          params: { executionId },
        }),
      ).toMatchObject({ ok: true });
      host.setProviderGeneration("generation-2");
      for (const operation of ["snapshot", "act"] as const) {
        expect(
          await host.invoke({
            operation,
            providerGeneration: descriptor.provider.generation,
            params: {
              executionId,
              ...(operation === "act" ? { action: "type", text: "stale" } : {}),
            },
          }),
        ).toMatchObject({
          ok: false,
          error: { message: expect.stringContaining("COMPUTER_CONTRACT_MISMATCH") },
        });
      }
      expect(host.snapshot).toHaveBeenCalledOnce();
      expect(host.act).not.toHaveBeenCalled();
      await host.invoke({ operation: "close", executionId, reason: "provider-changed" });
      expect(host.close).toHaveBeenCalledExactlyOnceWith("provider-changed");
      expect(await host.invoke({ operation: "capabilities" })).toMatchObject({
        payload: { provider: { generation: "generation-2" } },
      });
      expect(
        await host.invoke({
          operation: "snapshot",
          providerGeneration: "generation-2",
          params: { executionId: otherExecutionId },
        }),
      ).toMatchObject({ ok: true });
      expect(host.openExecution).toHaveBeenCalledTimes(2);
    } finally {
      await host.runtime.close();
    }
  });

  it.each([true, false])(
    "enforces the private/public transport boundary for ephemeral=%s",
    async (ephemeral) => {
      const host = await startComputer(ephemeral);
      try {
        const privateResult = await host.invoke({ operation: "capabilities" });
        expect(privateResult.ok).toBe(ephemeral);
        const publicResult = await host.invoke({ executionId }, "screen.snapshot");
        expect(publicResult.ok).toBe(!ephemeral);
        expect(host.snapshot).toHaveBeenCalledTimes(ephemeral ? 0 : 1);
      } finally {
        await host.runtime.close();
      }
    },
  );

  it.each([
    { operation: "snapshot", params: { executionId } },
    { operation: "snapshot", providerGeneration: descriptor.provider.generation, params: {} },
    {
      operation: "act",
      providerGeneration: descriptor.provider.generation,
      params: { executionId, action: "__close_execution" },
    },
    {
      operation: "act",
      providerGeneration: descriptor.provider.generation,
      params: { executionId, action: "type", text: "x".repeat(128 * 1024) },
    },
    { operation: "close", executionId, reason: "completion", command: "system.run" },
    { operation: "capabilities", command: "computer.act" },
  ])("rejects malformed private operation $operation before the provider", async (input) => {
    const host = await startComputer();
    try {
      expect(await host.invoke(input)).toMatchObject({
        ok: false,
        error: { code: "INVALID_REQUEST" },
      });
      expect(host.openExecution).not.toHaveBeenCalled();
    } finally {
      await host.runtime.close();
    }
  });
});

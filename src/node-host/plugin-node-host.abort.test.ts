/** Verifies non-duplex plugin commands inherit the node invocation lifetime. */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "../gateway/client.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import type { OpenClawPluginNodeHostCommandContext } from "../plugins/types.node-host.js";
import { handleInvoke } from "./invoke.js";

afterEach(() => {
  resetPluginRuntimeStateForTest();
});

describe("non-duplex node-host plugin cancellation", () => {
  it("passes the actual invocation signal into the node-owned plugin context", async () => {
    const controller = new AbortController();
    const sendNodeEvent = vi.fn(async () => undefined);
    const handle = vi.fn(
      async (
        _paramsJSON?: string | null,
        _io?: unknown,
        context?: OpenClawPluginNodeHostCommandContext,
      ) => {
        await new Promise<void>((_resolve, reject) => {
          context?.signal?.addEventListener(
            "abort",
            () =>
              reject(
                context.signal?.reason instanceof Error
                  ? context.signal.reason
                  : new Error("node plugin invocation aborted", { cause: context.signal?.reason }),
              ),
            { once: true },
          );
        });
        return '{"stale":true}';
      },
    );
    const registry = createEmptyPluginRegistry();
    registry.nodeHostCommands = [
      {
        pluginId: "ollama",
        pluginName: "Ollama",
        command: { command: "ollama.chat", cap: "local-inference", handle },
        source: "test",
      },
    ];
    setActivePluginRegistry(registry);
    const request = vi.fn<GatewayClient["request"]>().mockResolvedValue(null);

    const invocation = handleInvoke(
      {
        id: "cancelable-model-inference",
        nodeId: "paired-node",
        command: "ollama.chat",
        paramsJSON: '{"model":"local-only:small"}',
        sessionKey: "agent:main:local-model",
      },
      { request } as unknown as GatewayClient,
      { current: async () => [] },
      undefined,
      { signal: controller.signal, pluginCommandContext: { sendNodeEvent } },
    );
    await vi.waitFor(() => expect(handle).toHaveBeenCalledOnce());

    controller.abort(new Error("paired inference canceled"));
    await invocation;

    expect(handle).toHaveBeenCalledWith('{"model":"local-only:small"}', undefined, {
      sendNodeEvent,
      sessionKey: "agent:main:local-model",
      signal: controller.signal,
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("preserves legacy plugin context when the caller supplies no signal", async () => {
    const sendNodeEvent = vi.fn(async () => undefined);
    const handle = vi.fn(async () => '{"ok":true}');
    const registry = createEmptyPluginRegistry();
    registry.nodeHostCommands = [
      {
        pluginId: "ollama",
        pluginName: "Ollama",
        command: { command: "ollama.chat", cap: "local-inference", handle },
        source: "test",
      },
    ];
    setActivePluginRegistry(registry);
    const request = vi.fn<GatewayClient["request"]>().mockResolvedValue(null);

    await handleInvoke(
      {
        id: "legacy-model-inference",
        nodeId: "paired-node",
        command: "ollama.chat",
        paramsJSON: "{}",
      },
      { request } as unknown as GatewayClient,
      { current: async () => [] },
      undefined,
      { pluginCommandContext: { sendNodeEvent } },
    );

    expect(handle).toHaveBeenCalledWith("{}", undefined, { sendNodeEvent });
    expect(request).toHaveBeenCalledWith(
      "node.invoke.result",
      expect.objectContaining({ ok: true, payloadJSON: '{"ok":true}' }),
    );
  });
});

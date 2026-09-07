/** Verifies non-duplex plugin commands inherit the node invocation lifetime. */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "../gateway/client.js";
import { createNodeDuplexEndpoint } from "../infra/node-duplex-framing.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import type {
  OpenClawPluginNodeHostCommandContext,
  OpenClawPluginNodeHostCommandIo,
} from "../plugins/types.node-host.js";
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
      prepareExecAuthorization: expect.any(Function),
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

    expect(handle).toHaveBeenCalledWith("{}", undefined, {
      sendNodeEvent,
      prepareExecAuthorization: expect.any(Function),
    });
    expect(request).toHaveBeenCalledWith(
      "node.invoke.result",
      expect.objectContaining({ ok: true, payloadJSON: '{"ok":true}' }),
    );
  });

  it.each(["success", "failure", "cancellation", "supersession", "different-error"] as const)(
    "settles pending asynchronous plugin listener delivery before result (%s)",
    async (outcome) => {
      let resolveListener!: () => void;
      let rejectListener!: (error: Error) => void;
      const listenerCompleted = new Promise<void>((resolve, reject) => {
        resolveListener = resolve;
        rejectListener = reject;
      });
      const controller = new AbortController();
      let currentInvocation = true;
      let framedFailure: Error | undefined;
      const framedIo = createNodeDuplexEndpoint({
        sendFrame: async () => undefined,
        onError: (error) => {
          framedFailure = error;
          controller.abort(error);
        },
      });
      controller.signal.addEventListener("abort", () => framedIo.close(), { once: true });
      const io: OpenClawPluginNodeHostCommandIo = {
        signal: controller.signal,
        emitChunk: vi.fn(async (_chunk: string) => undefined),
        onInput: vi.fn(),
        frames: framedIo,
      };
      const handle = vi.fn(
        async (_paramsJSON?: string | null, commandIo?: OpenClawPluginNodeHostCommandIo) => {
          commandIo?.frames?.onMessage(async () => await listenerCompleted);
          framedIo.receive(
            JSON.stringify({ v: 1, kind: "data", message: 0, index: 0, last: true, data: "Bw==" }),
          );
          if (outcome === "different-error") {
            await new Promise<void>((_resolve, reject) => {
              controller.signal.addEventListener(
                "abort",
                () => reject(new Error("identical framed failure message")),
                { once: true },
              );
            });
          }
          return '{"ok":true}';
        },
      );
      const registry = createEmptyPluginRegistry();
      registry.nodeHostCommands = [
        {
          pluginId: "frames-fixture",
          pluginName: "Frames fixture",
          command: { command: "fixture.duplex", duplex: true, handle },
          source: "test",
        },
      ];
      setActivePluginRegistry(registry);
      const request = vi.fn<GatewayClient["request"]>().mockResolvedValue(null);

      const invocation = handleInvoke(
        { id: "pending-listener", nodeId: "paired-node", command: "fixture.duplex" },
        { request } as unknown as GatewayClient,
        { current: async () => [] },
        undefined,
        {
          signal: controller.signal,
          pluginCommandIo: io,
          flushPluginCommandIo: framedIo.drain,
          canReportAbortedFailure: (error) =>
            currentInvocation && error === framedFailure && error === controller.signal.reason,
        },
      );

      try {
        await vi.waitFor(() => expect(handle).toHaveBeenCalledOnce());
        expect(request).not.toHaveBeenCalled();
        if (outcome === "failure") {
          rejectListener(new Error("asynchronous plugin listener rejected"));
        } else if (outcome === "cancellation") {
          controller.abort(new Error("plugin command canceled"));
        } else if (outcome === "supersession") {
          currentInvocation = false;
          rejectListener(new Error("superseded plugin listener rejected"));
        } else if (outcome === "different-error") {
          rejectListener(new Error("identical framed failure message"));
        } else {
          resolveListener();
        }
        await invocation;

        if (outcome === "success") {
          expect(request).toHaveBeenCalledWith(
            "node.invoke.result",
            expect.objectContaining({ ok: true, payloadJSON: '{"ok":true}' }),
          );
        } else if (outcome === "failure") {
          expect(request).toHaveBeenCalledWith(
            "node.invoke.result",
            expect.objectContaining({
              ok: false,
              error: {
                code: "INVALID_REQUEST",
                message: "Error: asynchronous plugin listener rejected",
              },
            }),
          );
        } else {
          expect(controller.signal.aborted).toBe(true);
          expect(request).not.toHaveBeenCalled();
        }
      } finally {
        resolveListener();
        framedIo.close();
        await invocation;
      }
    },
  );
});

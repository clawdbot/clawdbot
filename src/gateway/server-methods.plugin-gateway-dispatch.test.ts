/**
 * Regression tests for plugin-registered gateway RPC dispatch (#94127).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  pinActivePluginHttpRouteRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import {
  createGatewayMethodRegistry,
  createPluginGatewayMethodDescriptor,
} from "./methods/registry.js";
import { WRITE_SCOPE } from "./operator-scopes.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayRequestHandler } from "./server-methods/types.js";

describe("handleGatewayRequest plugin gateway dispatch", () => {
  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  it("dispatches plugin methods registered after the startup method registry snapshot", async () => {
    const handler = vi.fn<GatewayRequestHandler>(({ respond }) => {
      respond(true, { ok: true, ts: 42 });
    });
    const activeRegistry = createEmptyPluginRegistry();
    activeRegistry.gatewayHandlers["demo.ping"] = handler;
    activeRegistry.gatewayMethodDescriptors.push(
      createPluginGatewayMethodDescriptor({
        pluginId: "demo",
        name: "demo.ping",
        handler,
        scope: WRITE_SCOPE,
      }),
    );
    setActivePluginRegistry(activeRegistry);

    const staleStartupRegistry = createGatewayMethodRegistry([]);
    const respond = vi.fn();
    await handleGatewayRequest({
      req: {
        type: "req",
        id: "proof-94127",
        method: "demo.ping",
        params: { hello: "world" },
      },
      respond,
      client: {
        connId: "conn-proof",
        connect: {
          role: "operator",
          scopes: [WRITE_SCOPE],
          client: {
            id: "cli",
            version: "test",
            platform: "linux",
            mode: "cli",
          },
          minProtocol: 1,
          maxProtocol: 1,
        },
      },
      isWebchatConnect: () => false,
      context: {
        logGateway: { warn: vi.fn() },
      } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"],
      methodRegistry: staleStartupRegistry,
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(true, { ok: true, ts: 42 });
  });

  it("dispatches a method owned by the caller-attached registry even when global state lacks it (#94343)", async () => {
    const handler = vi.fn<GatewayRequestHandler>(({ respond }) => {
      respond(true, { ok: true, source: "attached" });
    });
    // Active plugin registry does NOT carry the method; only the caller-attached
    // snapshot owns it, so dispatch must prefer the attached registry.
    setActivePluginRegistry(createEmptyPluginRegistry());
    const attachedRegistry = createGatewayMethodRegistry([
      createPluginGatewayMethodDescriptor({
        pluginId: "demo",
        name: "demo.attached",
        handler,
        scope: WRITE_SCOPE,
      }),
    ]);
    const respond = vi.fn();
    await handleGatewayRequest({
      req: { type: "req", id: "proof-94343", method: "demo.attached", params: {} },
      respond,
      client: {
        connId: "conn-proof",
        connect: {
          role: "operator",
          scopes: [WRITE_SCOPE],
          client: { id: "cli", version: "test", platform: "linux", mode: "cli" },
          minProtocol: 1,
          maxProtocol: 1,
        },
      },
      isWebchatConnect: () => false,
      context: {
        logGateway: { warn: vi.fn() },
      } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"],
      methodRegistry: attachedRegistry,
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(true, { ok: true, source: "attached" });
  });

  it("keeps fallback plugin dispatch pinned when an agent replaces the active registry", async () => {
    const gatewayHandler = vi.fn<GatewayRequestHandler>(({ respond }) => {
      respond(true, { ok: true, source: "gateway" });
    });
    const scopedHandler = vi.fn<GatewayRequestHandler>(({ respond }) => {
      respond(true, { ok: true, source: "agent" });
    });
    const gatewayRegistry = createEmptyPluginRegistry();
    gatewayRegistry.gatewayHandlers["demo.gateway"] = gatewayHandler;
    gatewayRegistry.gatewayMethodDescriptors.push(
      createPluginGatewayMethodDescriptor({
        pluginId: "demo",
        name: "demo.gateway",
        handler: gatewayHandler,
        scope: WRITE_SCOPE,
      }),
    );
    const scopedRegistry = createEmptyPluginRegistry();
    scopedRegistry.gatewayHandlers["demo.agent"] = scopedHandler;
    scopedRegistry.gatewayMethodDescriptors.push(
      createPluginGatewayMethodDescriptor({
        pluginId: "demo",
        name: "demo.agent",
        handler: scopedHandler,
        scope: WRITE_SCOPE,
      }),
    );
    setActivePluginRegistry(gatewayRegistry);
    pinActivePluginHttpRouteRegistry(gatewayRegistry);
    setActivePluginRegistry(scopedRegistry);

    const staleStartupRegistry = createGatewayMethodRegistry([]);
    const invoke = async (method: string) => {
      const respond = vi.fn();
      await handleGatewayRequest({
        req: { type: "req", id: `pinned-${method}`, method, params: {} },
        respond,
        client: {
          connId: "conn-proof",
          connect: {
            role: "operator",
            scopes: [WRITE_SCOPE],
            client: { id: "cli", version: "test", platform: "linux", mode: "cli" },
            minProtocol: 1,
            maxProtocol: 1,
          },
        },
        isWebchatConnect: () => false,
        context: {
          logGateway: { warn: vi.fn() },
        } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"],
        methodRegistry: staleStartupRegistry,
      });
      return respond;
    };

    const rejected = await invoke("demo.agent");
    expect(rejected).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
    expect(scopedHandler).not.toHaveBeenCalled();

    const dispatched = await invoke("demo.gateway");
    expect(dispatched).toHaveBeenCalledWith(true, { ok: true, source: "gateway" });
    expect(gatewayHandler).toHaveBeenCalledOnce();
  });

  it("fails closed when neither the attached snapshot nor the live registry owns the method", async () => {
    const handler = vi.fn<GatewayRequestHandler>();
    setActivePluginRegistry(createEmptyPluginRegistry());
    const respond = vi.fn();
    await handleGatewayRequest({
      req: { type: "req", id: "proof-unknown", method: "demo.does-not-exist", params: {} },
      respond,
      client: {
        connId: "conn-proof",
        connect: {
          role: "operator",
          scopes: [WRITE_SCOPE],
          client: { id: "cli", version: "test", platform: "linux", mode: "cli" },
          minProtocol: 1,
          maxProtocol: 1,
        },
      },
      isWebchatConnect: () => false,
      context: {
        logGateway: { warn: vi.fn() },
      } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"],
      methodRegistry: createGatewayMethodRegistry([]),
    });

    expect(handler).not.toHaveBeenCalled();
    const [ok] = respond.mock.calls.at(-1) ?? [];
    expect(ok).toBe(false);
  });
});

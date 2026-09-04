import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../shared/deferred.js";
import {
  createCoreGatewayMethodDescriptors,
  createGatewayMethodRegistry,
} from "../../methods/registry.js";
import { listGatewayMethods } from "../../server-methods-list.js";
import { handleGatewayRequest } from "../../server-methods.js";
import { coreGatewayHandlers } from "../../server-methods/core-handlers.js";
import type { GatewayRequestOptions } from "../../server-methods/types.js";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
} from "./authenticated-request-dispatch.test-support.js";

const runtime = vi.hoisted(() => ({
  handler: vi.fn<(options: GatewayRequestOptions) => Promise<void>>(),
}));
vi.mock("./authenticated-request-dispatch.server-methods.runtime.js", () => ({
  handleGatewayRequest: runtime.handler,
}));

const ping: GatewayRequestOptions["req"] = {
  type: "req",
  id: "restore-check",
  method: "gateway.ping",
};

describe("authenticated WebSocket liveness ACK", () => {
  beforeEach(() => {
    runtime.handler.mockReset();
  });

  it.each(["node", "operator"])("ACKs %s with no scopes or application work", async (role) => {
    const client = createOperatorWsClient({ scopes: [] });
    client.connect.role = role;
    const applicationWork = vi.fn(() => {
      throw new Error("ACK entered application work");
    });
    const harness = createDispatchTestHarness({
      buildRequestContext: () => ({
        getRuntimeConfig: applicationWork,
        getHealthCache: applicationWork,
        refreshHealthSnapshot: applicationWork,
        nodeRegistry: { isConnectionCurrentPairingState: applicationWork },
      }),
    });
    expect(listGatewayMethods()).toContain(ping.method);
    const registry = createGatewayMethodRegistry(
      createCoreGatewayMethodDescriptors(coreGatewayHandlers),
    );
    expect(registry.listAdvertisedMethods()).toContain(ping.method);
    await harness.dispatcher.dispatch(ping, client);
    expect(await harness.awaitResponseFrame(ping.id)).toEqual({
      type: "res",
      id: ping.id,
      ok: true,
      payload: {},
      error: undefined,
    });
    expect(applicationWork).not.toHaveBeenCalled();
    expect(runtime.handler).not.toHaveBeenCalled();
    expect(harness.close).not.toHaveBeenCalled();
  });

  it.each(["node", "operator", "unknown"])(
    "keeps registered authorization for %s without scopes",
    async (role) => {
      const client = createOperatorWsClient({ scopes: [] });
      client.connect.role = role;
      const respond = vi.fn();
      await handleGatewayRequest({
        req: ping,
        client,
        respond,
        isWebchatConnect: () => false,
        context: {
          logGateway: { warn: vi.fn() },
          nodeRegistry: { isConnectionCurrentPairingState: vi.fn().mockResolvedValue(true) },
        } as unknown as GatewayRequestOptions["context"],
      });
      if (role === "unknown") {
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "INVALID_REQUEST" }),
        );
      } else {
        expect(respond).toHaveBeenCalledWith(true, {});
      }
    },
  );

  it("does not extend the ACK exception to an unknown role", async () => {
    const client = createOperatorWsClient();
    client.connect.role = "unknown";
    const harness = createDispatchTestHarness();
    await harness.dispatcher.dispatch(ping, client);
    expect(await harness.awaitResponseFrame(ping.id)).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });
    expect(runtime.handler).not.toHaveBeenCalled();
  });

  it.each(["invalidated", "rotated", "closed"])("does not ACK a %s socket", async (state) => {
    const client = createOperatorWsClient();
    client.invalidated = state === "invalidated";
    client.usesSharedGatewayAuth = state === "rotated";
    client.sharedGatewaySessionGeneration = "old";
    const harness = createDispatchTestHarness({
      isClosed: () => state === "closed",
      getRequiredSharedGatewaySessionGeneration: () => "new",
    });
    await harness.dispatcher.dispatch(ping, client);
    expect(harness.send).not.toHaveBeenCalled();
    expect(runtime.handler).not.toHaveBeenCalled();
  });

  it("keeps credential mutation ordering and rechecks authority before ACK", async () => {
    const held = createDeferredCore();
    const started = createDeferredCore();
    const client = createOperatorWsClient();
    runtime.handler.mockImplementation(async ({ respond }) => {
      started.resolve();
      await held.promise;
      client.invalidated = true;
      respond(true, {});
    });
    const harness = createDispatchTestHarness();
    await harness.dispatcher.dispatch(
      { ...ping, id: "rotate", method: "device.token.rotate" },
      client,
    );
    await started.promise;
    await harness.dispatcher.dispatch(ping, client);
    expect(harness.send).not.toHaveBeenCalled();
    held.resolve();
    await vi.waitFor(() => expect(harness.close).toHaveBeenCalled());
    expect(
      harness.send.mock.calls.some(([frame]) => (frame as { id?: string }).id === ping.id),
    ).toBe(false);
    expect(runtime.handler).toHaveBeenCalledOnce();
  });
});

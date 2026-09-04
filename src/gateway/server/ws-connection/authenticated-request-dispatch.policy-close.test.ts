import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as deviceTokens from "../../../infra/device-pairing-tokens.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { deviceHandlers } from "../../server-methods/devices.js";
import { createSecretsHandlers } from "../../server-methods/secrets.js";
import type { GatewayRequestOptions } from "../../server-methods/types.js";
import { disconnectAllSharedGatewayAuthClients } from "../../server-shared-auth-generation.js";
import { holdGatewayPolicyResponse } from "../ws-policy-close.js";
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

function createFixture() {
  const closed = createDeferredCore();
  const socketClose = vi.fn(() => closed.resolve());
  const client = createOperatorWsClient({ socket: { close: socketClose } });
  client.usesSharedGatewayAuth = true;
  const harness = createDispatchTestHarness();
  const dispatch = async (id: string, method = "secrets.reload") =>
    await harness.dispatcher.dispatch({ type: "req", id, method, params: {} }, client);
  return { client, harness, dispatch, socketClose, closed };
}

describe("policy writer response ownership", () => {
  beforeEach(() => {
    runtime.handler.mockReset();
  });

  it.each([false, true])(
    "delivers a secrets activation result before closing (failed=%s)",
    async (failed) => {
      const fixture = createFixture();
      const published = createDeferredCore();
      const release = createDeferredCore();
      const handlers = createSecretsHandlers({
        reloadSecrets: async () => {
          disconnectAllSharedGatewayAuthClients([fixture.client]);
          published.resolve();
          await release.promise;
          if (failed) {
            throw new Error("activation failed");
          }
          return { warningCount: 0 };
        },
        storeWriteService: {
          resolveUpdatedBy: () => "test",
          write: vi.fn(),
          reloadReference: async () => ({ reloaded: false }),
        },
        resolveSecrets: async () => ({ assignments: [], diagnostics: [], inactiveRefPaths: [] }),
      });
      runtime.handler.mockImplementation(async (options) => {
        await expectDefined(
          handlers[options.req.method],
          options.req.method,
        )({
          ...options,
          params: {},
        });
      });
      await fixture.dispatch("writer");
      await published.promise;
      expect(fixture.client.invalidated).toBe(true);
      expect(fixture.socketClose).not.toHaveBeenCalled();
      await fixture.dispatch("revoked", "health");
      expect(runtime.handler).toHaveBeenCalledOnce();
      expect(fixture.harness.send).not.toHaveBeenCalled();
      release.resolve();
      expect(await fixture.harness.awaitResponseFrame("writer")).toMatchObject({
        ok: !failed,
        ...(failed ? { error: { message: "secrets.reload failed" } } : {}),
      });
      await fixture.closed.promise;
      expect(fixture.socketClose).toHaveBeenCalledExactlyOnceWith(4001, "gateway auth changed");
      expect(fixture.harness.send).toHaveBeenCalledBefore(fixture.socketClose);
    },
  );

  it.each(["config.patch", "device.token.rotate", "device.token.revoke", "device.pair.remove"])(
    "keeps only accepted %s results, then closes after the last result",
    async (method) => {
      const fixture = createFixture();
      const writers = (method === "config.patch" ? ["first", "second"] : ["first"]).map((id) => ({
        id,
        started: createDeferredCore(),
        release: createDeferredCore(),
        finished: createDeferredCore(),
      }));
      const readStarted = createDeferredCore();
      const readRelease = createDeferredCore();
      const readFinished = createDeferredCore();
      runtime.handler.mockImplementation(async ({ req, respond }) => {
        const writer = writers.find(({ id }) => id === req.id);
        if (writer) {
          holdGatewayPolicyResponse(respond);
          writer.started.resolve();
          await writer.release.promise;
          respond(true, { committed: req.id });
          writer.finished.resolve();
        } else {
          readStarted.resolve();
          await readRelease.promise;
          respond(true, { private: "old-authority-read" });
          readFinished.resolve();
        }
      });
      await fixture.dispatch("read", "health");
      await readStarted.promise;
      for (const writer of writers) {
        await fixture.dispatch(writer.id, method);
        await writer.started.promise;
      }
      try {
        disconnectAllSharedGatewayAuthClients([fixture.client]);
        readRelease.resolve();
        await readFinished.promise;
        expect(fixture.harness.send).not.toHaveBeenCalled();
        for (const [index, writer] of writers.entries()) {
          expect(fixture.socketClose).not.toHaveBeenCalled();
          writer.release.resolve();
          expect(await fixture.harness.awaitResponseFrame(writer.id)).toMatchObject({ ok: true });
          expect(fixture.harness.send).toHaveBeenCalledTimes(index + 1);
        }
        await fixture.closed.promise;
        expect(fixture.socketClose).toHaveBeenCalledOnce();
      } finally {
        readRelease.resolve();
        for (const writer of writers) {
          writer.release.resolve();
        }
        await Promise.all([
          readFinished.promise,
          ...writers.map((writer) => writer.finished.promise),
        ]);
      }
    },
  );

  it("does not reserve a replacement bearer before the token mutation finishes", async () => {
    const fixture = createFixture();
    fixture.client.isDeviceTokenAuth = true;
    fixture.client.usesSharedGatewayAuth = false;
    fixture.client.connect.device = {
      id: "self",
      publicKey: "public",
      signature: "signature",
      signedAt: 1,
      nonce: "nonce",
    };
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const closed = createDeferredCore();
    const invalidateClientsForDevice = vi.fn();
    const disconnectClientsForDevice = vi.fn();
    fixture.harness.close.mockImplementation(() => closed.resolve());
    const rotate = vi.spyOn(deviceTokens, "rotateDeviceToken").mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return {
        ok: true,
        entry: {
          token: "synthetic-replacement",
          role: "operator",
          scopes: ["operator.pairing"],
          createdAtMs: 1,
        },
      };
    });
    runtime.handler.mockImplementation(async (options) => {
      await expectDefined(
        deviceHandlers[options.req.method],
        options.req.method,
      )({
        ...options,
        params: { deviceId: "self", role: "operator" },
        context: {
          ...options.context,
          logGateway: { ...createSubsystemLogger("gateway-test"), ...fixture.harness.logGateway },
          invalidateClientsForDevice,
          disconnectClientsForDevice,
        },
      });
    });
    try {
      await fixture.dispatch("writer", "device.token.rotate");
      await entered.promise;
      // Invalidation is the authority fence; defer transport close so the test
      // detects an illicit held response even when the socket could still send.
      fixture.client.invalidated = true;
      fixture.client.invalidatedReason = "device-token-revoked";
      release.resolve();
      await Promise.race([closed.promise, fixture.harness.awaitResponseFrame("writer")]);
      expect(fixture.harness.send.mock.calls.length).toBe(0);
      expect(fixture.harness.close).toHaveBeenCalledWith(
        4001,
        "client invalidated: device-token-revoked",
      );
      expect(invalidateClientsForDevice).toHaveBeenCalledWith("self", {
        role: "operator",
        reason: "device-token-rotated",
      });
      expect(disconnectClientsForDevice).toHaveBeenCalledWith("self", { role: "operator" });
    } finally {
      release.resolve();
      rotate.mockRestore();
    }
  });

  it.each(["throw", "return"])(
    "releases a revoked writer when its handler exits with %s",
    async (completion) => {
      const fixture = createFixture();
      runtime.handler.mockImplementation(async ({ respond }) => {
        holdGatewayPolicyResponse(respond);
        disconnectAllSharedGatewayAuthClients([fixture.client]);
        if (completion === "throw") {
          throw new Error("write failed");
        }
      });
      await fixture.dispatch("writer", "config.apply");
      await fixture.closed.promise;
      expect(fixture.socketClose).toHaveBeenCalledOnce();
      if (completion === "throw") {
        expect(await fixture.harness.awaitResponseFrame("writer")).toMatchObject({
          ok: false,
          error: { code: "UNAVAILABLE", message: expect.stringContaining("write failed") },
        });
      } else {
        expect(fixture.harness.send).not.toHaveBeenCalled();
      }
    },
  );
});

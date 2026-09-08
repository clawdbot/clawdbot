import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_IDS } from "../../../packages/gateway-protocol/src/client-info.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { NODE_DESKTOP_STREAM_COMMAND } from "../../shared/node-desktop-stream.js";
import { NodeRegistry } from "../node-registry.js";
import type { GatewayWsClient } from "../server/ws-types.js";
import { createNodeDesktopService } from "./node-source.js";
import { createNodeDesktopStreamBroker } from "./node-stream-broker.js";
import * as observeBridge from "./observe-bridge.js";
import { createDesktopSessionRegistry } from "./session-registry.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  vi.restoreAllMocks();
});

function createFixture(boundary: "activation" | "pairing" | "attachment") {
  let config: OpenClawConfig = {
    gateway: { nodes: { commands: { allow: [NODE_DESKTOP_STREAM_COMMAND] } } },
  };
  const reached = createDeferred();
  const release = createDeferred();
  const forwarded: string[] = [];
  const nodeRegistry = new NodeRegistry({
    resolveCurrentPairingState: async () => {
      if (boundary === "pairing") {
        reached.resolve();
        await release.promise;
      }
      return { identity: "identity", generation: "generation" };
    },
  });
  const client = {
    connId: "node-conn",
    usesSharedGatewayAuth: false,
    socket: {
      readyState: 1,
      bufferedAmount: 0,
      send(frame: string) {
        const event = JSON.parse(frame) as {
          event: string;
          payload: { id: string; command: string };
        };
        if (event.event !== "node.invoke.request") {
          return;
        }
        forwarded.push(event.payload.command);
        if (boundary === "attachment") {
          reached.resolve();
          return;
        }
        queueMicrotask(() =>
          nodeRegistry.handleInvokeResult({
            id: event.payload.id,
            nodeId: "node",
            connId: "node-conn",
            ok: false,
            error: { code: "FIXTURE", message: "unexpected desktop dispatch" },
          }),
        );
      },
      close: vi.fn(),
    },
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: GATEWAY_CLIENT_IDS.NODE_HOST,
        platform: "linux",
        version: "test",
        mode: "node",
      },
      device: { id: "node" },
      commands: [NODE_DESKTOP_STREAM_COMMAND],
    },
  } as unknown as GatewayWsClient;
  nodeRegistry.register(client, { pairingIdentity: "identity", pairingGeneration: "generation" });
  const desktopRegistry = createDesktopSessionRegistry();
  if (boundary === "activation") {
    const activate = desktopRegistry.activate;
    vi.spyOn(desktopRegistry, "activate").mockImplementation(async (request) => {
      await activate(request);
      reached.resolve();
      await release.promise;
    });
  }
  const streamBroker = createNodeDesktopStreamBroker();
  const attached = createDeferred<Awaited<ReturnType<typeof streamBroker.mint>["attached"]>>();
  if (boundary === "attachment") {
    vi.spyOn(streamBroker, "mint").mockReturnValue({
      ticket: "synthetic-ticket",
      attachPath: "/synthetic-attach",
      expiresAtMs: Date.now() + 60_000,
      attached: attached.promise,
      cancel: () => attached.reject(new Error("cancelled")),
    });
  }
  const service = createNodeDesktopService({
    getConfig: () => config,
    nodeRegistry,
    desktopRegistry,
    streamBroker,
  });
  cleanups.push(async () => {
    release.resolve();
    await desktopRegistry.stopAll();
    nodeRegistry.unregister(client.connId);
  });
  return {
    service,
    reached: reached.promise,
    release: release.resolve,
    attached,
    forwarded,
    revoke() {
      config = { gateway: { nodes: { commands: { deny: [NODE_DESKTOP_STREAM_COMMAND] } } } };
    },
  };
}

describe("node desktop runtime policy", () => {
  it("keeps requester authority on the observer ticket after node attachment", async () => {
    const fixture = createFixture("attachment");
    const mint = vi.spyOn(observeBridge, "mintDesktopObserverToken");
    const controller = new AbortController();
    const client = { invalidated: false };
    const requester = {
      signal: controller.signal,
      isCurrent: () => !client.invalidated,
    };
    const observed = fixture.service.observe({
      nodeId: "node",
      control: false,
      credentials: { password: "synthetic-password" },
      requester,
    });
    await fixture.reached;
    fixture.attached.resolve({ stream: new PassThrough(), auth: "vnc-password" });

    await expect(observed).resolves.toMatchObject({ transport: "rfb", control: false });
    const mintedRequester = mint.mock.calls[0]?.[0].requester;
    expect(mintedRequester).toBe(requester);
    expect(mintedRequester?.isCurrent()).toBe(true);
    client.invalidated = true;
    expect(mintedRequester?.isCurrent()).toBe(false);
    expect(controller.signal.aborted).toBe(false);
  });

  it.each(["activation", "pairing"] as const)(
    "does not dispatch after policy changes during %s",
    async (boundary) => {
      const fixture = createFixture(boundary);
      const observed = fixture.service.observe({ nodeId: "node", control: false }).then(
        () => true,
        () => false,
      );
      await fixture.reached;
      fixture.revoke();
      fixture.release();

      expect(await observed).toBe(false);
      expect(fixture.forwarded).toEqual([]);
    },
  );

  it("destroys a late attachment instead of publishing a revoked desktop", async () => {
    const fixture = createFixture("attachment");
    const stream = new PassThrough();
    const observed = fixture.service
      .observe({ nodeId: "node", control: false, credentials: { password: "synthetic-password" } })
      .then(
        () => true,
        () => false,
      );
    await fixture.reached;
    fixture.revoke();
    fixture.attached.resolve({ stream, auth: "vnc-password" });

    expect(await observed).toBe(false);
    expect(stream.destroyed).toBe(true);
  });
});

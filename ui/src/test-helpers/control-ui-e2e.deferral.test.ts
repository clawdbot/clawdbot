/* @vitest-environment jsdom */
import { expect, it } from "vitest";
import { createControlUiMockGatewayInitScript } from "./control-ui-e2e.ts";

type ResponseFrame = {
  type: string;
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { message: string };
};

it.each(["resolve", "reject"] as const)(
  "%ss every held request without changing one-shot deferrals",
  async (outcome) => {
    const catalog = { environments: [], profiles: [{ id: "aws" }] };
    const scenario = {
      heldMethods: ["environments.list"],
      deferredMethods: ["models.list"],
      methodResponses: { "environments.list": catalog },
    };
    const priorWebSocket = window.WebSocket;
    window.sessionStorage.clear();
    // oxlint-disable-next-line typescript/no-implied-eval -- Exercise the serialized browser transport, including its closure boundary.
    new Function(createControlUiMockGatewayInitScript(scenario))();
    const sockets = [
      new WebSocket("ws://mock-gateway/first"),
      new WebSocket("ws://mock-gateway/second"),
    ] as const;
    const frames: ResponseFrame[] = [];
    for (const socket of sockets) {
      socket.addEventListener("message", (event) => {
        const frame = JSON.parse(String((event as MessageEvent).data)) as ResponseFrame;
        if (frame.type === "res") {
          frames.push(frame);
        }
      });
    }
    const flush = () =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    const send = (socket: WebSocket, id: string, method: string) =>
      socket.send(JSON.stringify({ type: "req", id, method }));
    const gateway = (
      window as Window & {
        openclawControlUiE2eGateway?: {
          resolveDeferred: (method: string) => void;
          rejectDeferred: (method: string, error: { message: string }) => void;
          deferNext: (method: string) => void;
        };
      }
    ).openclawControlUiE2eGateway;
    try {
      if (!gateway) {
        throw new Error("Mock Gateway was not installed");
      }
      await flush();
      send(sockets[0], "catalog-first", "environments.list");
      send(sockets[1], "catalog-replacement", "environments.list");
      send(sockets[0], "model-held", "models.list");
      send(sockets[0], "model-next", "models.list");
      await flush();
      expect(frames.map((frame) => frame.id)).toEqual(["model-next"]);

      if (outcome === "resolve") {
        gateway.resolveDeferred("environments.list");
      } else {
        gateway.rejectDeferred("environments.list", { message: "catalog unavailable" });
      }
      expect(frames.filter((frame) => frame.id.startsWith("catalog-"))).toEqual(
        ["catalog-first", "catalog-replacement"].map((id) =>
          expect.objectContaining(
            outcome === "resolve"
              ? { id, ok: true, payload: catalog }
              : {
                  id,
                  ok: false,
                  error: expect.objectContaining({ message: "catalog unavailable" }),
                },
          ),
        ),
      );
      send(sockets[1], "catalog-after-release", "environments.list");
      await flush();
      expect(frames.at(-1)).toMatchObject({
        id: "catalog-after-release",
        ok: true,
        payload: catalog,
      });
      gateway.resolveDeferred("models.list");
      expect(frames.at(-1)).toMatchObject({ id: "model-held", ok: true });

      gateway.deferNext("environments.list");
      send(sockets[0], "catalog-one-shot", "environments.list");
      send(sockets[0], "catalog-unblocked", "environments.list");
      await flush();
      expect(frames.at(-1)).toMatchObject({ id: "catalog-unblocked", ok: true });
      expect(frames.some((frame) => frame.id === "catalog-one-shot")).toBe(false);
      gateway.resolveDeferred("environments.list");
      expect(frames.at(-1)).toMatchObject({ id: "catalog-one-shot", ok: true });
    } finally {
      for (const socket of sockets) {
        socket.close();
      }
      window.WebSocket = priorWebSocket;
      window.sessionStorage.clear();
    }
  },
);

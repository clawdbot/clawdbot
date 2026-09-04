/* @vitest-environment jsdom */
import { expect } from "vitest";
import {
  createControlUiMockGatewayInitScript,
  type ControlUiMockGateway,
} from "./control-ui-e2e.ts";
import { mockGatewayTest as it } from "./mock-gateway-page.test-support.ts";

type ResponseFrame = {
  type: string;
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { message: string };
};

it.for(["resolve", "reject"] as const)(
  "%ss every held request without changing one-shot deferrals",
  async (outcome, { gatewayPage }) => {
    const { window, execute } = gatewayPage;
    const catalog = { environments: [], profiles: [{ id: "aws" }] };
    const scenario = {
      heldMethods: ["environments.list"],
      deferredMethods: ["models.list"],
      methodResponses: { "environments.list": catalog },
    };
    execute(createControlUiMockGatewayInitScript(scenario));
    const sockets = [
      new window.WebSocket("ws://mock-gateway/first"),
      new window.WebSocket("ws://mock-gateway/second"),
    ] as const;
    const frames: ResponseFrame[] = [];
    for (const socket of sockets) {
      socket.addEventListener("message", (event: MessageEvent) => {
        const frame = JSON.parse(String(event.data)) as ResponseFrame;
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
      window as typeof window & {
        openclawControlUiE2eGateway?: {
          resolveDeferred: (method: string) => void;
          rejectDeferred: (method: string, error: { message: string }) => void;
          deferNext: (method: string) => void;
        };
      }
    ).openclawControlUiE2eGateway;
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
  },
);

it("separates canonical roster capture and deferrals from child session queries", async ({
  gatewayPage,
}) => {
  const { window, execute } = gatewayPage;
  execute(createControlUiMockGatewayInitScript());
  const gateway = (window as typeof window & { openclawControlUiE2eGateway?: ControlUiMockGateway })
    .openclawControlUiE2eGateway;
  if (!gateway) {
    throw new Error("Mock Gateway was not installed");
  }
  const socket = new window.WebSocket("ws://mock-gateway/roster");
  const frames: ResponseFrame[] = [];
  socket.addEventListener("message", (event: MessageEvent) => {
    const frame = JSON.parse(String(event.data)) as ResponseFrame;
    if (frame.type === "res") {
      frames.push(frame);
    }
  });
  const flush = () =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  const send = (id: string, method: string, params: Record<string, unknown>) =>
    socket.send(JSON.stringify({ type: "req", id, method, params }));
  await flush();

  const rosterMatch = { includeGlobal: true };
  const childQuery = { includeGlobal: false, spawnedBy: "agent:main:parent" };
  gateway.deferNext("sessions.list", rosterMatch);
  send("child-before", "sessions.list", childQuery);
  send("roster-held", "sessions.list", rosterMatch);
  send("child-after", "sessions.list", childQuery);
  send("health", "health", {});
  await flush();

  expect(frames.map((frame) => frame.id)).toEqual(["child-before", "child-after", "health"]);
  expect(gateway.findRequests("sessions.list", rosterMatch).map((request) => request.id)).toEqual([
    "roster-held",
  ]);
  expect(gateway.findRequests("sessions.list").map((request) => request.id)).toEqual([
    "child-before",
    "roster-held",
    "child-after",
  ]);
  expect(gateway.findRequests()).toHaveLength(4);

  gateway.resolveDeferred("sessions.list");
  expect(frames.at(-1)).toMatchObject({ id: "roster-held", ok: true });
  send("roster-next", "sessions.list", rosterMatch);
  await flush();
  expect(frames.at(-1)).toMatchObject({ id: "roster-next", ok: true });
  expect(gateway.findRequests("sessions.list", rosterMatch).map((request) => request.id)).toEqual([
    "roster-held",
    "roster-next",
  ]);
});

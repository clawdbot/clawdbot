import { expect } from "vitest";
import { createControlUiMockGatewayInitScript } from "./control-ui-e2e.ts";
import { mockGatewayTest as it } from "./mock-gateway-page.test-support.ts";

it("keeps serialized Gateway globals and storage out of the host realm", ({ gatewayPage }) => {
  const keys = [
    "WebSocket",
    "JSON5",
    "__OPENCLAW_CONTROL_UI_BASE_PATH__",
    "openclawControlUiE2eGateway",
  ];
  const descriptors = () => keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  const before = descriptors();
  const hostStorage = Object.entries(sessionStorage);
  gatewayPage.execute(createControlUiMockGatewayInitScript({}));
  gatewayPage.window.sessionStorage.setItem("fixture-only", "owned");

  expect(gatewayPage.window).not.toBe(globalThis.window);
  expect(
    Object.getOwnPropertyDescriptor(gatewayPage.window, "openclawControlUiE2eGateway")?.value,
  ).toBeDefined();
  expect(descriptors()).toEqual(before);
  expect(Object.entries(sessionStorage)).toEqual(hostStorage);
});

it("retires queued Gateway work and listeners when its page closes", async ({ gatewayPage }) => {
  const { window, execute } = gatewayPage;
  execute(
    createControlUiMockGatewayInitScript({
      methodResponses: {
        "config.get": {
          raw: '{"count":1}',
          config: { count: 1 },
          hash: "original",
          valid: true,
          issues: [],
        },
      },
    }),
  );
  const storage = window.sessionStorage;
  const socket = new window.WebSocket("ws://mock-gateway");
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  expect(socket.readyState).toBe(window.WebSocket.OPEN);
  const responses: string[] = [];
  socket.addEventListener("message", (event: MessageEvent) => responses.push(String(event.data)));
  socket.send(
    JSON.stringify({
      type: "req",
      id: "queued-write",
      method: "config.set",
      params: { raw: '{"count":2}', baseHash: "original" },
    }),
  );
  let listenerCalls = 0;
  window.addEventListener("fixture-probe", () => {
    listenerCalls += 1;
  });
  gatewayPage.close();
  window.dispatchEvent(new window.Event("fixture-probe"));
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

  expect(storage.getItem("openclaw.control-ui-e2e.configState")).toBeNull();
  expect(responses).toEqual([]);
  expect(listenerCalls).toBe(0);
});

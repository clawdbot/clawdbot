import { afterEach, expect, test, vi } from "vitest";
import { GatewayClient, GatewayClientRequestTimeoutError } from "./client.js";
import type { GatewayProtocolSocket } from "./protocol-client.js";

afterEach(() => {
  vi.useRealTimers();
});

test("reports that a timed-out request crossed the transport send boundary", async () => {
  vi.useFakeTimers();
  const client = new GatewayClient({ requestTimeoutMs: 100 });
  const send = vi.fn();
  const socket: GatewayProtocolSocket = {
    isOpen: () => true,
    send,
    close: vi.fn(),
  };
  Object.assign(
    (client as unknown as { protocol: { socket: GatewayProtocolSocket | null } }).protocol,
    { socket },
  );

  const request = client.request("node.invoke", { nodeId: "node-1" });
  const outcome = request.catch((value: unknown) => value);
  expect(send).toHaveBeenCalledOnce();

  await vi.advanceTimersByTimeAsync(100);

  const error = await outcome;
  expect(error).toBeInstanceOf(GatewayClientRequestTimeoutError);
  expect(error).toMatchObject({
    method: "node.invoke",
    timeoutMs: 100,
    requestSent: true,
  });
});

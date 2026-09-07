import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import type { WebSocket } from "ws";
import { websocket } from "./sandbox-exec-server.websocket.js";

it("preserves an initialization frame while pausing and resuming the accepted socket", async () => {
  const server = new websocket.WebSocketServer({ host: "127.0.0.1", port: 0 });
  let client: WebSocket | undefined;
  try {
    await once(server, "listening");
    const connected = once(server, "connection");
    client = new websocket.WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`);
    await once(client, "open");
    const [socket] = (await connected) as [WebSocket];
    const frame = JSON.stringify({
      id: "initialize",
      method: "initialize",
      params: { clientName: "test-client" },
    });
    const incoming = once(socket, "message");
    client.send(frame);
    const [data, binary] = await incoming;
    expect(binary).toBe(false);
    expect(data.toString()).toBe(frame);

    socket.pause();
    const echoed = once(client, "message");
    socket.send(data, { binary: false });
    socket.resume();
    const [echo, echoBinary] = await echoed;
    expect(echoBinary).toBe(false);
    expect(echo.toString()).toBe(frame);
  } finally {
    const closed = new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    client?.terminate();
    for (const socket of server.clients) {
      socket.terminate();
    }
    await closed;
  }
});

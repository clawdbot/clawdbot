// Plugin SDK test helper for temporary local HTTP servers.
import { createServer, type RequestListener } from "node:http";
import type { AddressInfo, Socket } from "node:net";

/** Run an ephemeral loopback HTTP server for the duration of an async test callback. */
export async function withServer(handler: RequestListener, fn: (baseUrl: string) => Promise<void>) {
  const server = createServer(handler);
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo | null;
  if (!address) {
    throw new Error("missing server address");
  }
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      // Bun clears its native handle in close(), so closeAllConnections cannot finish active streams.
      for (const socket of sockets) {
        socket.destroy();
      }
    });
  }
}

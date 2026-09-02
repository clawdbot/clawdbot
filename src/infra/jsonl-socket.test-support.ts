import { once } from "node:events";
import net from "node:net";
import path from "node:path";
import { withTestDir } from "../test-helpers/temp-dir.js";

/** A real one-shot peer; handlers run only after the caller half-closes its request. */
export async function withJsonlSocketPeer(
  onRequest: (socket: net.Socket, wire: string) => void | Promise<void>,
  run: (peer: {
    dir: string;
    socketPath: string;
    requests: string[];
    connections: net.Socket[];
  }) => Promise<void>,
): Promise<void> {
  // The wrapper's nested TMPDIR can exceed macOS's sockaddr_un path limit.
  await withTestDir({ prefix: "oc-js-", parentDir: "/tmp" }, async (dir) => {
    const socketPath = path.join(dir, "peer.sock");
    const requests: string[] = [];
    const connections: net.Socket[] = [];
    const closed: Promise<void>[] = [];
    const handlers: Promise<void>[] = [];
    const failures: unknown[] = [];
    const server = net.createServer({ allowHalfOpen: true }, (socket) => {
      connections.push(socket);
      closed.push(
        new Promise<void>((resolve) => {
          socket.once("close", resolve);
        }),
      );
      // Cancellation tests intentionally make the response reader disappear.
      socket.on("error", () => {});
      socket.setEncoding("utf8");
      let wire = "";
      socket.on("data", (chunk: string) => {
        wire += chunk;
      });
      socket.once("end", () => {
        requests.push(wire);
        handlers.push(
          Promise.resolve()
            .then(() => onRequest(socket, wire))
            .catch((error: unknown) => {
              failures.push(error);
              socket.destroy();
            }),
        );
      });
    });
    const listening = once(server, "listening");
    server.listen(socketPath);
    await listening;
    try {
      await run({ dir, socketPath, requests, connections });
      await Promise.all(handlers);
      if (failures.length > 0) {
        throw new AggregateError(failures, "JSONL peer handler failed");
      }
    } finally {
      for (const socket of connections) {
        socket.destroy();
      }
      await Promise.all(closed);
      await Promise.all(handlers);
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
}

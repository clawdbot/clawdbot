import { once } from "node:events";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { verifyEvent, type Event } from "nostr-tools";
import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import { WebSocketServer } from "ws";

export const PREFIX_ACK_REASON = "connection failure: historical diagnostic";

export async function createNostrRelayFixture(
  options: {
    accepted?: boolean;
    reason?: string;
    rejectUpgrade?: boolean;
    holdAcknowledgements?: boolean;
    onEvent?: (event: Event) => void;
  } = {},
) {
  const events: Event[] = [];
  const acknowledgements: Array<["OK", string, boolean, string]> = [];
  const errors: unknown[] = [];
  const connections = new Set<Socket>();
  const pendingAcknowledgements: Array<() => void> = [];
  let upgradeAttempts = 0;
  const server = createServer((_request, response) => {
    response.writeHead(404).end();
  });
  server.on("connection", (socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
  });
  const sockets = new WebSocketServer({
    server,
    maxPayload: 64 * 1024,
    verifyClient: (_info, done) => {
      upgradeAttempts += 1;
      done(!options.rejectUpgrade, 503, "fixture refusal");
    },
  });
  sockets.on("error", (error) => errors.push(error));
  sockets.on("connection", (socket) => {
    socket.on("error", (error) => errors.push(error));
    socket.on("message", (data) => {
      try {
        const [kind, value] = JSON.parse(rawDataToString(data)) as [string, string | Event];
        if (kind === "REQ" && typeof value === "string") {
          // Settle the real pool's EOSE timer through the wire, including cleanup paths.
          socket.send(JSON.stringify(["EOSE", value]));
        } else if (kind === "EVENT" && typeof value !== "string") {
          if (!verifyEvent(value)) {
            throw new Error("Fixture received an invalid signed Nostr event");
          }
          events.push(value);
          options.onEvent?.(value);
          const acknowledge = () => {
            const frame: ["OK", string, boolean, string] = [
              "OK",
              value.id,
              options.accepted ?? true,
              options.reason ?? "saved",
            ];
            acknowledgements.push(frame);
            socket.send(JSON.stringify(frame));
          };
          if (options.holdAcknowledgements) {
            pendingAcknowledgements.push(acknowledge);
          } else {
            acknowledge();
          }
        }
      } catch (error) {
        errors.push(error);
        socket.close();
      }
    });
  });
  let closePromise: Promise<void> | undefined;
  const close = () => {
    closePromise ??= (async () => {
      for (const socket of sockets.clients) {
        socket.terminate();
      }
      for (const connection of connections) {
        connection.destroy();
      }
      const results = await Promise.allSettled([
        new Promise<void>((resolve, reject) => {
          sockets.close((error) => (error ? reject(error) : resolve()));
        }),
        new Promise<void>((resolve, reject) => {
          if (!server.listening) {
            resolve();
            return;
          }
          server.close((error) => (error ? reject(error) : resolve()));
        }),
      ]);
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length > 0) {
        throw new AggregateError(failures, "Nostr fixture shutdown failed");
      }
    })();
    return closePromise;
  };
  try {
    const listening = once(server, "listening");
    server.listen(0, "127.0.0.1");
    await listening;
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Missing Nostr fixture listen port");
    }
    return {
      url: `ws://127.0.0.1:${address.port}/`,
      events,
      acknowledgements,
      errors,
      upgradeAttempts: () => upgradeAttempts,
      acknowledgeAll: () => {
        for (const acknowledge of pendingAcknowledgements.splice(0)) {
          acknowledge();
        }
      },
      endpoints: () => ({
        listening: server.listening,
        connections: connections.size,
        clients: sockets.clients.size,
      }),
      close,
    };
  } catch (error) {
    const [cleanup] = await Promise.allSettled([close()]);
    if (cleanup?.status === "rejected") {
      throw new AggregateError(
        [error, cleanup.reason],
        "Nostr fixture startup and cleanup failed",
        {
          cause: error,
        },
      );
    }
    throw error;
  }
}

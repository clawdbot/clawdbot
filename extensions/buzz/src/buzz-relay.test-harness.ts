import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  matchFilter,
  verifyEvent,
  type Event,
  type Filter,
} from "nostr-tools";
import { WebSocketServer, type WebSocket } from "ws";

/** Signed protocol fixture, not an implementation of the upstream Buzz service. */
export async function createBuzzRelayFixture() {
  const relayKey = generateSecretKey();
  const botKey = generateSecretKey();
  const senderKey = generateSecretKey();
  const relayPublicKey = getPublicKey(relayKey);
  const botPublicKey = getPublicKey(botKey);
  const senderPublicKey = getPublicKey(senderKey);
  const roomId = randomUUID();
  const signRelay = (template: Parameters<typeof finalizeEvent>[0]) =>
    finalizeEvent(template, relayKey);
  const now = Math.floor(Date.now() / 1000);
  const events: Event[] = [
    signRelay({
      kind: 39000,
      created_at: now,
      content: "",
      tags: [
        ["d", roomId],
        ["name", "Lifecycle fixture"],
        ["t", "stream"],
      ],
    }),
    signRelay({
      kind: 39002,
      created_at: now,
      content: "",
      tags: [
        ["d", roomId],
        ["p", botPublicKey, "", "bot"],
        ["p", senderPublicKey, "", "member"],
      ],
    }),
  ];
  const received: Event[] = [];
  const sessions = new Map<
    WebSocket,
    { challenge: string; publicKey?: string; subscriptions: Map<string, Filter[]> }
  >();
  let presenceMode: "accept" | "reject" | "silent" = "accept";
  let authenticatedSessions = 0;
  let pauseMembershipQuery: ((respond: () => void) => void) | undefined;
  const heldSnapshots = new Set<string>();
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/nostr+json");
    response.end(
      JSON.stringify({ self: relayPublicKey, software: "https://github.com/block/buzz" }),
    );
  });
  const sockets = new WebSocketServer({ server });
  const send = (socket: WebSocket, frame: unknown[]) => socket.send(JSON.stringify(frame));
  const storedRoom = (event: Event) =>
    event.tags.find((tag) => tag[0] === "h")?.[1] ??
    ([39000, 39002].includes(event.kind)
      ? event.tags.find((tag) => tag[0] === "d")?.[1]
      : undefined);
  const matchesStored = (filter: Filter, event: Event) => {
    const { "#h": rooms, ...signedFilter } = filter;
    return rooms
      ? rooms.includes(storedRoom(event) ?? "") && matchFilter(signedFilter, event)
      : matchFilter(filter, event);
  };
  const broadcast = (event: Event) => {
    events.push(event);
    for (const [socket, session] of sessions) {
      for (const [id, filters] of session.subscriptions) {
        if (heldSnapshots.has(id)) {
          continue;
        }
        // Buzz routes to room topics only when every wire filter has #h.
        // Its stored channel metadata can match #h absent from signed roster tags.
        const room = storedRoom(event);
        const roomScoped = filters.every((filter) => filter["#h"] !== undefined);
        if (Boolean(room) !== roomScoped) {
          continue;
        }
        if (filters.some((filter) => matchesStored(filter, event))) {
          send(socket, ["EVENT", id, event]);
        }
      }
    }
  };
  sockets.on("connection", (socket) => {
    const session = {
      challenge: randomUUID(),
      publicKey: undefined as string | undefined,
      subscriptions: new Map<string, Filter[]>(),
    };
    sessions.set(socket, session);
    send(socket, ["AUTH", session.challenge]);
    socket.on("close", () => sessions.delete(socket));
    socket.on("message", (data) => {
      const text = Buffer.isBuffer(data)
        ? data.toString("utf8")
        : Array.isArray(data)
          ? Buffer.concat(data).toString("utf8")
          : Buffer.from(data).toString("utf8");
      const [type, value, ...filters] = JSON.parse(text) as [string, string | Event, ...Filter[]];
      if (type === "AUTH" && typeof value !== "string") {
        const valid =
          verifyEvent(value) &&
          value.kind === 22242 &&
          [botPublicKey, senderPublicKey].includes(value.pubkey) &&
          value.tags.some((tag) => tag[0] === "relay" && tag[1] === relayUrl) &&
          value.tags.some((tag) => tag[0] === "challenge" && tag[1] === session.challenge);
        if (valid) {
          session.publicKey = value.pubkey;
          authenticatedSessions++;
        }
        send(socket, ["OK", value.id, valid, valid ? "" : "invalid auth"]);
      } else if (type === "REQ" && typeof value === "string") {
        if (!session.publicKey) {
          send(socket, ["CLOSED", value, "auth-required"]);
          return;
        }
        session.subscriptions.set(value, filters);
        const snapshot = [...events];
        const respond = () => {
          const sent = new Set<string>();
          for (const filter of filters) {
            const matching = snapshot
              .filter((event) => matchesStored(filter, event))
              .toSorted((a, b) => b.created_at - a.created_at);
            for (const event of matching.slice(0, filter.limit ?? matching.length)) {
              if (!sent.has(event.id)) {
                send(socket, ["EVENT", value, event]);
              }
              sent.add(event.id);
            }
          }
          send(socket, ["EOSE", value]);
        };
        if (pauseMembershipQuery && filters.length === 1 && filters[0]?.kinds?.includes(39002)) {
          const pause = pauseMembershipQuery;
          pauseMembershipQuery = undefined;
          // Hold a stale snapshot independently of the live room stream.
          heldSnapshots.add(value);
          pause(() => {
            respond();
            heldSnapshots.delete(value);
          });
        } else {
          respond();
        }
      } else if (type === "CLOSE" && typeof value === "string") {
        session.subscriptions.delete(value);
      } else if (type === "EVENT" && typeof value !== "string") {
        if (!verifyEvent(value) || value.pubkey !== session.publicKey) {
          send(socket, ["OK", value.id, false, "invalid publisher"]);
          return;
        }
        received.push(value);
        if (value.kind === 20001 && presenceMode === "silent") {
          return;
        }
        const accepted = value.kind !== 20001 || presenceMode !== "reject";
        send(socket, [
          "OK",
          value.id,
          accepted,
          accepted ? "" : "blocked: fixture presence policy",
        ]);
        if (accepted) {
          broadcast(value);
        }
      }
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing fixture listen port");
  }
  const relayUrl = `ws://127.0.0.1:${address.port}/`;
  return {
    relayUrl,
    botPrivateKey: Buffer.from(botKey).toString("hex"),
    botPublicKey,
    senderPublicKey,
    relayPublicKey,
    roomId,
    received,
    events,
    authenticatedSessions: () => authenticatedSessions,
    pauseNextMembershipQuery: () => {
      let respond: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        pauseMembershipQuery = (sendSnapshot) => {
          respond = sendSnapshot;
          resolve();
        };
      });
      return {
        started,
        release: () => {
          respond?.();
          respond = undefined;
        },
      };
    },
    setPresenceMode: (mode: typeof presenceMode) => {
      presenceMode = mode;
    },
    signRelay,
    broadcast,
    sendUnchecked: (event: Event) => {
      for (const [socket, session] of sessions) {
        for (const [id, filters] of session.subscriptions) {
          if (filters.some((filter) => filter.kinds?.includes(9))) {
            send(socket, ["EVENT", id, event]);
          }
        }
      }
    },
    sendMessage: (content: string, createdAt = Math.floor(Date.now() / 1000)) => {
      const event = finalizeEvent(
        { kind: 9, created_at: createdAt, content, tags: [["h", roomId]] },
        senderKey,
      );
      broadcast(event);
      return event;
    },
    close: async () => {
      for (const socket of sockets.clients) {
        socket.terminate();
      }
      await new Promise<void>((resolve, reject) => {
        sockets.close((error) => (error ? reject(error) : resolve()));
      });
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

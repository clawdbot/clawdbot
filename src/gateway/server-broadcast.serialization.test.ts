// Covers broadcast frame-serialization failure: an unserializable payload must
// not consume per-client seqs (which would fire every client's gap detector and
// cause a synchronized reconnect storm) and must leave a server-side record.
import { once } from "node:events";
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { resolveSessionStorePathCore } from "../config/sessions.js";
import {
  deleteSessionEntryLifecycle,
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setVerbose } from "../global-state.js";
import type { SystemPresence } from "../infra/system-presence.js";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createPresenceRecipientProjection } from "./presence-projection.js";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import { createGatewayConnectionState } from "./server-connection-state.js";
import type { GatewayWsClient } from "./server/ws-types.js";

const warnSpy = vi.hoisted(() => vi.fn());

vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      if (subsystem !== "gateway/broadcast") {
        return logger;
      }
      return { ...logger, error: warnSpy };
    },
  };
});

type RecordingSocket = {
  readyState: number;
  bufferedAmount: number;
  close: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  frames: Array<{ event: string; seq: number }>;
};

function makeClient(connId: string): { client: GatewayWsClient; socket: RecordingSocket } {
  const frames: Array<{ event: string; seq: number }> = [];
  const socket: RecordingSocket = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    close: vi.fn(),
    send: vi.fn((payload: string) => {
      const frame = JSON.parse(payload) as { event: string; seq: number };
      frames.push({ event: frame.event, seq: frame.seq });
    }),
    frames,
  };
  return {
    client: {
      socket: socket as unknown as GatewayWsClient["socket"],
      connect: { role: "operator", scopes: ["operator.read"] } as GatewayWsClient["connect"],
      connId,
      usesSharedGatewayAuth: false,
    },
    socket,
  };
}

afterEach(() => {
  setVerbose(false);
  setLoggerOverride(null);
  resetLogger();
});

describe("broadcast serialization failures", () => {
  it("delivers public suspension state to connected operators without read scope", () => {
    const peer = makeClient("suspension-viewer");
    peer.client.connect.scopes = [];
    const { broadcast } = createGatewayBroadcaster({ clients: new Set([peer.client]) });
    broadcast("gateway.suspension", { phase: "prepared" });
    expect(peer.socket.send).toHaveBeenCalledOnce();
    expect(JSON.parse(peer.socket.send.mock.calls[0]![0])).toMatchObject({
      type: "event",
      event: "gateway.suspension",
      seq: 1,
      payload: { phase: "prepared" },
    });
  });

  it("never sends raw presence when its owner projection is missing", () => {
    const peer = makeClient("unprepared");
    const { broadcast } = createGatewayBroadcaster({ clients: new Set([peer.client]) });
    warnSpy.mockClear();
    broadcast("presence", {
      presence: [{ text: "watcher", ts: 1, watchedSessions: ["agent:main:hidden"] }],
    });
    expect(peer.socket.send).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("presence recipient projection unavailable"),
    );
    broadcast("skills.changed", {});
    expect(peer.socket.frames).toEqual([{ event: "skills.changed", seq: 1 }]);
  });
  it.each([
    { state: "closing", readyState: WebSocket.CLOSING },
    { state: "closed", readyState: WebSocket.CLOSED },
  ])("skips $state sockets without disrupting healthy broadcast sequences", ({ readyState }) => {
    const retired = makeClient("retired");
    const healthy = makeClient("healthy");
    const clients = new Set([retired.client, healthy.client]);
    const { broadcast, broadcastToConnIds } = createGatewayBroadcaster({ clients });

    retired.socket.readyState = readyState;
    broadcast("skills.changed", { reason: "first" });
    broadcastToConnIds("skills.changed", { reason: "second" }, new Set(["healthy", "retired"]));

    expect(retired.socket.send).not.toHaveBeenCalled();
    expect(clients.has(retired.client)).toBe(true);
    expect(healthy.socket.frames).toEqual([
      { event: "skills.changed", seq: 1 },
      { event: "skills.changed", seq: 2 },
    ]);
  });

  it("keeps a real healthy peer delivering while rejecting closing and failed peers", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const address = server.address() as AddressInfo;
    const connectPeer = async () => {
      const accepted = once(server, "connection");
      const peer = new WebSocket(`ws://127.0.0.1:${address.port}`);
      await once(peer, "open");
      const [socket] = (await accepted) as [WebSocket];
      return { peer, socket };
    };
    const retired = await connectPeer();
    const broken = await connectPeer();
    const healthy = await connectPeer();
    const delivered: Array<{ event: string; seq: number }> = [];
    healthy.peer.on("message", (data: RawData) => {
      delivered.push(JSON.parse(rawDataToString(data)) as { event: string; seq: number });
    });
    const makeRealClient = (connId: string, socket: WebSocket): GatewayWsClient => ({
      connId,
      socket,
      connect: { role: "operator", scopes: ["operator.read"] } as GatewayWsClient["connect"],
      usesSharedGatewayAuth: false,
    });
    const retiredClient = makeRealClient("real-retired", retired.socket);
    const brokenClient = makeRealClient("real-broken", broken.socket);
    const healthyClient = makeRealClient("real-healthy", healthy.socket);
    const clients = new Set([retiredClient, brokenClient, healthyClient]);
    const { broadcast, broadcastToConnIds } = createGatewayBroadcaster({ clients });

    try {
      warnSpy.mockClear();
      const brokenPeerClosed = vi.fn();
      broken.peer.once("close", brokenPeerClosed);
      vi.spyOn(broken.socket, "send").mockImplementationOnce(() => {
        throw new Error("injected synchronous send failure");
      });
      retired.socket.close(1000, "retiring peer");
      expect(retired.socket.readyState).toBe(WebSocket.CLOSING);
      const bufferedAtClose = retired.socket.bufferedAmount;

      broadcast("chat", {
        state: "final",
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      });
      broadcastToConnIds("skills.changed", { reason: "targeted" }, new Set(["real-healthy"]));
      await vi.waitFor(() => expect(delivered).toHaveLength(2));
      await vi.waitFor(() => expect(brokenPeerClosed).toHaveBeenCalledOnce());

      expect(retired.socket.bufferedAmount).toBe(bufferedAtClose);
      expect(clients.has(retiredClient)).toBe(true);
      expect(delivered.map(({ event, seq }) => ({ event, seq }))).toEqual([
        { event: "chat", seq: 1 },
        { event: "skills.changed", seq: 2 },
      ]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("real-broken: injected synchronous send failure"),
        { event: "chat" },
      );

      let callbackError: Error | undefined;
      retired.socket.send("dependency-callback-proof", (error) => {
        callbackError = error;
      });
      expect(callbackError).toBeUndefined();
      await vi.waitFor(() => expect(callbackError).toBeInstanceOf(Error));
    } finally {
      retired.peer.terminate();
      broken.peer.terminate();
      healthy.peer.terminate();
      for (const activeSocket of server.clients) {
        activeSocket.terminate();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("drops the event without consuming seqs when the payload cannot serialize", () => {
    warnSpy.mockClear();
    const first = makeClient("first");
    const second = makeClient("second");
    const clients = new Set([first.client, second.client]);
    const { broadcast } = createGatewayBroadcaster({ clients });

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    broadcast("skills.changed", circular);

    // Neither socket saw the bad frame, and the failure is recorded once.
    expect(first.socket.send).not.toHaveBeenCalled();
    expect(second.socket.send).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("skills.changed");

    // The next good broadcast starts at seq 1 for every client: the dropped
    // event consumed no seq, so no gap detector fires.
    broadcast("skills.changed", { reason: "recovered" });
    expect(first.socket.frames).toEqual([{ event: "skills.changed", seq: 1 }]);
    expect(second.socket.frames).toEqual([{ event: "skills.changed", seq: 1 }]);
  });

  it("does not inspect agent log summaries for an ineligible outbound broadcast", () => {
    setVerbose(true);
    setLoggerOverride({ level: "silent", consoleLevel: "info" });
    const filtered = makeClient("filtered");
    filtered.client.connect.scopes = [];
    const { broadcast } = createGatewayBroadcaster({ clients: new Set([filtered.client]) });
    let dataReads = 0;
    const payload = {
      runId: "run-1",
      stream: "assistant",
      get data() {
        dataReads += 1;
        return { text: "not delivered" };
      },
    };

    broadcast("agent", payload);

    expect(filtered.socket.send).not.toHaveBeenCalled();
    expect(dataReads).toBe(0);
  });
});

describe("presence recipient projection", () => {
  it.each(["chat.metadata.changed", "node.presence", "node.hostStats"])(
    "delivers %s only to readable operators",
    (event) => {
      const readers = [makeClient("reader"), makeClient("writer"), makeClient("admin")];
      readers[1]!.client.connect.scopes = ["operator.write"];
      readers[2]!.client.connect.scopes = ["operator.admin"];
      const denied = [makeClient("no-scope"), makeClient("node"), makeClient("pairing")];
      denied[0]!.client.connect.scopes = [];
      denied[1]!.client.connect.role = "node";
      denied[2]!.client.connect.scopes = ["operator.pairing"];
      const { broadcast } = createGatewayBroadcaster({
        clients: new Set([...readers, ...denied].map(({ client }) => client)),
      });
      broadcast(event, {});
      for (const peer of readers) {
        expect(JSON.parse(peer.socket.send.mock.lastCall![0])).toMatchObject({
          event,
          payload: {},
        });
      }
      for (const peer of denied) {
        expect(peer.socket.send).not.toHaveBeenCalled();
      }
    },
  );

  it("delivers mention invalidations only to targeted readable operators", () => {
    const readers = [makeClient("reader"), makeClient("writer"), makeClient("admin")];
    readers[1]!.client.connect.scopes = ["operator.write"];
    readers[2]!.client.connect.scopes = ["operator.admin"];
    const denied = [makeClient("no-scope"), makeClient("node"), makeClient("unrelated")];
    denied[0]!.client.connect.scopes = [];
    denied[1]!.client.connect.role = "node";
    const { broadcastToConnIds } = createGatewayBroadcaster({
      clients: new Set([...readers, ...denied].map(({ client }) => client)),
    });
    const payload = { gatewayInstanceId: "mention-gateway", revision: 1 };

    broadcastToConnIds(
      "mentions.changed",
      payload,
      new Set(["reader", "writer", "admin", "no-scope", "node"]),
    );

    for (const peer of readers) {
      expect(JSON.parse(peer.socket.send.mock.lastCall![0])).toMatchObject({
        event: "mentions.changed",
        payload,
        seq: 1,
      });
    }
    for (const peer of denied) {
      expect(peer.socket.send).not.toHaveBeenCalled();
    }
  });

  it("preserves scoped sentinels, recipient ordering, and current visibility without changing the source", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      let cfg: OpenClawConfig = { agents: { entries: { main: {}, work: {} } } };
      const sharedKey = "agent:main:shared";
      const incognitoKey = "agent:main:dashboard:incognito-presence";
      const keys = [
        sharedKey,
        incognitoKey,
        "agent:main:global",
        "agent:work:global",
        "agent:work:unknown",
      ];
      for (const [agentId, sessionKey, visibility] of [
        ["main", sharedKey, "shared"],
        ["main", incognitoKey, "shared"],
        ["main", "global", "draft"],
        ["work", "global", "read-only"],
        ["work", "unknown", "suggest"],
      ] as const) {
        await upsertSessionEntryCore(
          { agentId, sessionKey },
          {
            sessionId: `${agentId}-${sessionKey}`,
            updatedAt: 1,
            visibility,
            createdVia: "operator",
            createdActor: { type: "human", source: "profile", id: "creator" },
          },
        );
      }
      const reader = makeClient("reader");
      reader.client.authenticatedUserProfile = {
        profileId: ensureProfileForEmail("presence-reader@example.test").id,
        displayName: "Reader",
        avatarRevision: "1",
        hasAvatar: false,
        updatedAt: 1,
      };
      const admin = makeClient("admin");
      admin.client.connect.scopes = ["operator.admin"];
      const connection = createGatewayConnectionState({
        bootId: "presence-projection",
        cfg,
        getRuntimeConfig: () => cfg,
      });
      onTestFinished(() => connection.mentionInbox.dispose());
      const person = {
        text: "watcher",
        ts: 42,
        onlineSince: 30,
        lastActivityAt: 40,
        timeZone: "Europe/Vienna",
        instanceId: "watcher",
        user: { id: "creator", name: "Creator" },
      };
      const watcher = { ...person, watchedSessions: [...keys, "agent:main:deleted"] };
      const presence = [watcher, { ...person, text: "idle", instanceId: "idle", ts: 41 }];
      Object.freeze(watcher.watchedSessions);
      presence.forEach(Object.freeze);
      Object.freeze(presence);
      const payload = { presence };
      const stateVersion = { presence: 7, health: 3 };
      const lastFrame = (peer: ReturnType<typeof makeClient>) =>
        // SAFETY: These sockets record JSON frames emitted by the real presence broadcaster below.
        JSON.parse(peer.socket.send.mock.lastCall![0]) as {
          payload: { presence: SystemPresence[] };
          seq: number;
          stateVersion: typeof stateVersion;
        };
      for (const order of [
        [reader, admin],
        [admin, reader],
      ]) {
        connection.clients.clear();
        order.forEach((peer) => connection.clients.add(peer.client));
        connection.broadcast("presence", payload, { stateVersion });
        expect(lastFrame(reader).payload.presence).toEqual([
          { ...person, watchedSessions: [sharedKey, "agent:work:global", "agent:work:unknown"] },
          presence[1],
        ]);
        expect(lastFrame(admin).payload.presence).toEqual([
          { ...person, watchedSessions: keys },
          presence[1],
        ]);
        expect(lastFrame(reader).stateVersion).toEqual(stateVersion);
      }
      await patchSessionEntryCore({ agentId: "main", sessionKey: sharedKey }, () => ({
        visibility: "draft",
      }));
      await deleteSessionEntryLifecycle({
        agentId: "work",
        storePath: resolveSessionStorePathCore(undefined, { agentId: "work" }),
        target: { canonicalKey: "global", storeKeys: ["global"] },
        archiveTranscript: false,
      });
      connection.broadcast("presence", payload);
      expect(lastFrame(reader).payload.presence).toEqual([
        { ...person, watchedSessions: ["agent:work:unknown"] },
        presence[1],
      ]);
      expect(lastFrame(admin).payload.presence[0]?.watchedSessions).toEqual(
        keys.filter((key) => key !== "agent:work:global"),
      );

      cfg = {
        ...cfg,
        gateway: {
          roles: {
            default: "restricted",
            definitions: {
              restricted: { sessions: { others: "none" }, agents: "*", scopes: ["operator.read"] },
            },
          },
        },
      };
      connection.broadcastToConnIds("presence", payload, new Set([reader.client.connId]), {
        stateVersion,
      });
      expect(lastFrame(reader)).toEqual({
        type: "event",
        event: "presence",
        payload: { presence: [person, presence[1]] },
        seq: 4,
        stateVersion,
      });
      expect(lastFrame(admin).seq).toBe(3);
      expect(watcher.watchedSessions).toEqual([...keys, "agent:main:deleted"]);
    });
  });

  it("keeps solo and system authority without treating pending identity or missing read scope as solo", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const key = "agent:main:private";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: key },
        {
          sessionId: "private",
          updatedAt: 1,
          visibility: "draft",
          createdVia: "operator",
          createdActor: { type: "human", source: "profile", id: "creator" },
        },
      );
      const person = {
        text: "watcher",
        ts: 3,
        onlineSince: 1,
        lastActivityAt: 2,
        timeZone: "Europe/Vienna",
        user: { id: "creator" },
      };
      const idle = { ...person, text: "idle" };
      const presence = [{ ...person, watchedSessions: [key] }, idle];
      const solo = makeClient("solo").client;
      solo.connect.scopes = ["operator.write"];
      const pending = makeClient("pending").client;
      pending.authenticatedGitHubIdentitySync = async () => ({
        profileId: "creator",
        updatedAt: 1,
      });
      const node = makeClient("node").client;
      node.connect.role = "node";
      node.connect.scopes = ["operator.admin"];
      const noRead = makeClient("no-read").client;
      noRead.connect.scopes = [];
      const worker = makeClient("worker").client;
      worker.connect.role = "worker";
      worker.connect.scopes = [];
      worker.connectionKind = "worker";
      const project = createPresenceRecipientProjection({ cfg: {}, presence });
      expect(project(solo)).toEqual(presence);
      solo.connect.scopes = [];
      expect(project(solo)).toEqual([]);
      solo.connect.scopes = ["operator.write"];
      expect(project(solo)).toEqual(presence);
      expect(project(pending)).toEqual([person, idle]);
      for (const client of [node, worker, noRead, null]) {
        expect(project(client)).toEqual([]);
      }
      pending.connect.scopes = ["operator.admin"];
      expect(project(pending)).toEqual(presence);
      const cfg: OpenClawConfig = { gateway: { roles: { definitions: {} } } };
      const restrictedProject = createPresenceRecipientProjection({ cfg, presence });
      expect(restrictedProject(solo)).toEqual([person, idle]);
      solo.internal = { operatorRoleActor: { kind: "system" } };
      expect(restrictedProject(solo)).toEqual(presence);
      pending.authenticatedUserProfile = {
        profileId: "creator",
        displayName: null,
        avatarRevision: "1",
        hasAvatar: false,
        updatedAt: 1,
      };
      pending.connect.scopes = ["operator.read"];
      expect(project(pending)).toEqual(presence);
    });
  });

  it("omits obsolete watches without creating missing agent stores or omission metadata", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const person = { text: "watcher", ts: 1 };
      const project = createPresenceRecipientProjection({
        cfg: { agents: { entries: { uncreated: {} } } },
        presence: [
          { ...person, watchedSessions: ["agent:uncreated:missing"] },
          { ...person, watchedSessions: [] },
          person,
        ],
      });
      const admin = makeClient("admin").client;
      admin.connect.scopes = ["operator.admin"];
      expect(project(admin)).toEqual([person, person, person]);
      expect(existsSync(state.agentDir("uncreated"))).toBe(false);
    });
  });
});

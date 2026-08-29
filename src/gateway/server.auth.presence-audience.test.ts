import { randomUUID } from "node:crypto";
import { once } from "node:events";
import path from "node:path";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterEach, describe, expect, test } from "vitest";
import { PresenceEntrySchema } from "../../packages/gateway-protocol/src/schema/snapshot.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writeConfigFile } from "../config/config.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { GatewayAuthConfig, GatewayOperatorRolesConfig } from "../config/types.gateway.js";
import { listSystemPresence, type SystemPresence } from "../infra/system-presence.js";
import { ensureProfileForEmail, setUserProfileRole } from "../state/user-profiles.js";
import {
  connectReq,
  CONTROL_UI_CLIENT,
  installGatewayTestHooks,
  NODE_CLIENT,
  onceMessage,
  openWs,
  rpcReq,
  testState,
  withGatewayServer,
} from "./server.auth.test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const BROWSER_ORIGIN = "https://control.example.com";
const TRUSTED_PROXY_HEADERS = {
  origin: BROWSER_ORIGIN,
  "x-forwarded-for": "203.0.113.50",
  "x-forwarded-proto": "https",
  "x-forwarded-user": "admin@example.com",
};

async function configureGatewayAuth(
  auth: GatewayAuthConfig,
  roles: GatewayOperatorRolesConfig,
): Promise<void> {
  testState.gatewayAuth = auth;
  testState.gatewayControlUi = { allowedOrigins: [BROWSER_ORIGIN] };
  await writeConfigFile({
    gateway: {
      auth,
      trustedProxies: ["127.0.0.1"],
      roles,
      controlUi: { allowedOrigins: [BROWSER_ORIGIN] },
    },
  });
}

function responseScopes(response: Awaited<ReturnType<typeof connectReq>>): string[] | undefined {
  return (response.payload as { auth?: { scopes?: string[] } } | undefined)?.auth?.scopes;
}

describe("gateway presence audience", () => {
  test("shares people only with readers and filters their session references across hello, RPC, and activity events", async () => {
    await configureGatewayAuth(
      {
        mode: "trusted-proxy",
        identityScopes: {
          "admin@example.com": ["operator.admin"],
          "watcher@example.com": ["operator.admin"],
        },
        trustedProxy: {
          userHeader: "x-forwarded-user",
          requiredHeaders: ["x-forwarded-proto"],
          allowLoopback: true,
        },
      },
      {
        default: "reader",
        definitions: {
          reader: { sessions: { others: "view" }, agents: "*", scopes: ["operator.read"] },
          writer: { sessions: { others: "write" }, agents: "*", scopes: ["operator.write"] },
          restricted: { sessions: { others: "none" }, agents: "*", scopes: ["operator.read"] },
          maintainer: { sessions: { others: "write" }, agents: "*", scopes: ["operator.admin"] },
          pairing: { sessions: { others: "none" }, agents: [], scopes: ["operator.pairing"] },
        },
      },
    );
    const creator = ensureProfileForEmail("creator@example.com");
    const restricted = ensureProfileForEmail("restricted@example.com");
    setUserProfileRole(restricted.id, "restricted");
    setUserProfileRole(ensureProfileForEmail("admin@example.com").id, "maintainer");
    setUserProfileRole(ensureProfileForEmail("watcher@example.com").id, "maintainer");
    setUserProfileRole(ensureProfileForEmail("writer@example.com").id, "writer");
    setUserProfileRole(ensureProfileForEmail("pairing@example.com").id, "pairing");
    const sharedKey = "agent:main:presence-shared";
    const sharedSessionId = randomUUID();
    const draftKey = "agent:main:presence-draft";
    const incognitoKey = "agent:main:dashboard:incognito-presence";
    const restrictedKey = "agent:main:presence-restricted-draft";
    const missingKey = "agent:main:presence-missing";
    const watchedKeys = [sharedKey, draftKey, incognitoKey, restrictedKey, missingKey].toSorted();
    const watcherInstanceId = `presence-watcher-${randomUUID()}`;
    const identityDir = tempDirs.make("openclaw-presence-identities-");

    await withGatewayServer(async ({ port }) => {
      for (const [sessionKey, profileId, visibility, incognito] of [
        [sharedKey, creator.id, "shared", false],
        [draftKey, creator.id, "draft", false],
        [incognitoKey, creator.id, "shared", true],
        [restrictedKey, restricted.id, "draft", false],
      ] as const) {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          {
            sessionId: sessionKey === sharedKey ? sharedSessionId : randomUUID(),
            updatedAt: Date.now(),
            createdVia: "operator",
            createdActor: { type: "human", source: "profile", id: profileId },
            visibility,
            ...(incognito ? { incognito: true } : {}),
          },
        );
      }
      const sockets: Awaited<ReturnType<typeof openWs>>[] = [];
      const observePresence = (ws: Awaited<ReturnType<typeof openWs>>) => {
        const events: SystemPresence[][] = [];
        ws.on("message", (data) => {
          const frame = JSON.parse(rawDataToString(data)) as {
            type: string;
            event?: string;
            payload: { presence: SystemPresence[] };
          };
          if (frame.type === "event" && frame.event === "presence") {
            events.push(frame.payload.presence);
          }
        });
        return events;
      };
      const openRecipient = async (
        name: string,
        scopes: string[],
        role: "operator" | "node" = "operator",
      ) => {
        const ws = await openWs(port, {
          ...TRUSTED_PROXY_HEADERS,
          "x-forwarded-user": `${name}@example.com`,
        });
        sockets.push(ws);
        const events = observePresence(ws);
        const client = {
          ...(role === "node" ? NODE_CLIENT : CONTROL_UI_CLIENT),
          instanceId: name === "watcher" ? watcherInstanceId : `presence-${name}`,
          timeZone: "Europe/Vienna",
        };
        const connected = await connectReq(ws, {
          skipDefaultAuth: true,
          prePairDevice: true,
          scopes,
          role,
          client,
          deviceIdentityPath: path.join(identityDir, `${name}-${sockets.length}.sqlite`),
          browserOrigin: BROWSER_ORIGIN,
        });
        expect(connected.ok, `${name} connect: ${JSON.stringify(connected.error)}`).toBe(true);
        expect(responseScopes(connected), `${name} effective scopes`).toEqual(scopes);
        return {
          ws,
          events,
          hello: connected.payload as { snapshot: { presence: SystemPresence[] } },
        };
      };
      try {
        const watcher = await openRecipient("watcher", ["operator.admin"]);
        const idle = await openRecipient("idle", ["operator.read"]);
        // A response on the watcher is a transport barrier, not a presence refresh.
        expect((await rpcReq(watcher.ws, "health")).ok).toBe(true);
        expect
          .soft(watcher.events.at(-1), "first connect publishes without activity")
          .toEqual(
            expect.arrayContaining([
              expect.objectContaining({ instanceId: "presence-idle", reason: "connect" }),
            ]),
          );
        for (const sessionKeys of [[sharedKey], []]) {
          expect(await rpcReq(idle.ws, "sessions.viewers.set", { sessionKeys })).toMatchObject({
            ok: true,
          });
        }
        const idlePerson = listSystemPresence().find(
          (entry) => entry.instanceId === "presence-idle",
        )!;
        expect(idlePerson.watchedSessions).toBeUndefined();
        expect(idlePerson).toMatchObject({
          onlineSince: expect.any(Number),
          lastActivityAt: expect.any(Number),
          timeZone: "Europe/Vienna",
        });
        const declared = await rpcReq(watcher.ws, "sessions.viewers.set", {
          sessionKeys: watchedKeys,
        });
        expect(declared).toMatchObject({ ok: true, payload: { sessionKeys: watchedKeys } });
        const rawWatcher = listSystemPresence().find(
          (entry) => entry.instanceId === watcherInstanceId,
        );
        expect(rawWatcher?.watchedSessions).toEqual(watchedKeys);
        const { watchedSessions: _watchedSessions, ...person } = rawWatcher!;
        expect(person.user?.id).toBe(ensureProfileForEmail("watcher@example.com").id);
        expect(person.ts).toBeGreaterThan(0);
        expect(person).toMatchObject({
          onlineSince: expect.any(Number),
          lastActivityAt: expect.any(Number),
          timeZone: "Europe/Vienna",
        });

        const recipients = [];
        for (const scenario of [
          { name: "creator", scopes: ["operator.read"], allowed: [sharedKey, draftKey] },
          { name: "reader", scopes: ["operator.read"], allowed: [sharedKey] },
          { name: "writer", scopes: ["operator.write"], allowed: [sharedKey] },
          { name: "restricted", scopes: ["operator.read"], allowed: [restrictedKey] },
          {
            name: "admin",
            scopes: ["operator.admin"],
            allowed: [sharedKey, draftKey, incognitoKey, restrictedKey],
          },
          { name: "pairing", scopes: ["operator.pairing"], allowed: [] },
          { name: "no-read", scopes: [], allowed: [] },
          { name: "node", scopes: [], allowed: [] },
        ]) {
          const recipient = await openRecipient(
            scenario.name,
            scenario.scopes,
            scenario.name === "node" ? "node" : "operator",
          );
          const canRead = !["pairing", "node", "no-read"].includes(scenario.name);
          const listed = await rpcReq<{ sessions: Array<{ key: string }> }>(
            recipient.ws,
            "sessions.list",
            { agentId: "main" },
          );
          expect(listed.ok, `${scenario.name} sessions.list scope`).toBe(canRead);
          if (canRead) {
            expect(
              listed.payload?.sessions
                .map((entry) => entry.key)
                .filter((key) => watchedKeys.includes(key))
                .toSorted(),
              `${scenario.name} canonical sessions.list visibility`,
            ).toEqual(scenario.allowed.toSorted());
          }
          const presence = await rpcReq(recipient.ws, "system-presence");
          expect(presence.ok, `${scenario.name} system-presence scope`).toBe(canRead);
          recipients.push({ ...recipient, ...scenario, canRead, rpcPresence: presence.payload });
        }

        const unauthenticated = await openWs(port, { origin: BROWSER_ORIGIN });
        sockets.push(unauthenticated);
        const unauthenticatedEvents = observePresence(unauthenticated);
        const readers = recipients.filter(({ canRead }) => canRead);
        const eventPromises = readers.map(({ ws }) =>
          onceMessage<{ type: string; event: string; payload: { presence: SystemPresence[] } }>(
            ws,
            (frame) => frame.type === "event" && frame.event === "presence",
          ),
        );
        expect(
          await rpcReq(watcher.ws, "session.typing", {
            sessionKey: sharedKey,
            sessionId: sharedSessionId,
            typing: true,
          }),
        ).toMatchObject({ ok: true });
        const events = await Promise.all(eventPromises);
        const activeWatcher = listSystemPresence().find(
          (entry) => entry.instanceId === watcherInstanceId,
        )!;
        const { watchedSessions: _activeWatches, ...activePerson } = activeWatcher;
        expect(activePerson.lastActivityAt).toBeGreaterThanOrEqual(person.lastActivityAt!);
        expect(activeWatcher.watchedSessions).toEqual(watchedKeys);
        for (const [index, recipient] of readers.entries()) {
          for (const [surface, rows] of [
            ["hello", recipient.hello.snapshot.presence],
            ["system-presence", recipient.rpcPresence],
            ["presence event", events[index]!.payload.presence],
          ] as const) {
            if (!Value.Check(Type.Array(PresenceEntrySchema), rows)) {
              throw new Error(`${recipient.name} ${surface} returned invalid presence rows`);
            }
            const received = rows.find((entry) => entry.instanceId === watcherInstanceId);
            const { watchedSessions, ...receivedPerson } = received ?? {};
            expect
              .soft(
                receivedPerson,
                `${recipient.name} ${surface} preserves the person and timestamp without hidden counts`,
              )
              .toEqual(surface === "presence event" ? activePerson : person);
            expect(rows.find((entry) => entry.instanceId === "presence-idle")).toEqual(idlePerson);
            expect
              .soft(
                watchedSessions ?? [],
                `${recipient.name} ${surface} watched session disclosure`,
              )
              .toEqual(recipient.allowed.toSorted());
          }
        }
        for (const recipient of recipients.filter(({ canRead }) => !canRead)) {
          expect(recipient.hello.snapshot.presence, `${recipient.name} hello inventory`).toEqual(
            [],
          );
          expect(recipient.rpcPresence).toBeUndefined();
          // The activity fanout is synchronous. A later response on this socket
          // is a transport barrier, so absence does not depend on sleeping.
          expect((await rpcReq(recipient.ws, "health")).ok).toBe(true);
          expect(recipient.events, `${recipient.name} activity-driven frames`).toEqual([]);
        }
        const preauthRead = await rpcReq(unauthenticated, "system-presence");
        expect(preauthRead.ok).toBe(false);
        expect(preauthRead.payload).toBeUndefined();
        expect(unauthenticatedEvents).toEqual([]);

        const liveIdleRows = async () => {
          expect((await rpcReq(watcher.ws, "health")).ok).toBe(true);
          return watcher.events
            .at(-1)!
            .filter(
              (entry) => entry.user?.id === idlePerson.user?.id && entry.reason !== "disconnect",
            );
        };
        const overlap = await openRecipient("idle", ["operator.read"]);
        const overlappingRows = await liveIdleRows();
        expect.soft(overlappingRows, "overlapping connect publishes both sockets").toHaveLength(2);
        for (const entry of overlappingRows) {
          expect(entry.onlineSince).toBe(idlePerson.onlineSince);
          expect(entry.lastActivityAt).toBe(idlePerson.lastActivityAt);
        }
        for (const [connection, remaining] of [
          [idle, 1],
          [overlap, 0],
        ] as const) {
          const closed = once(connection.ws, "close");
          connection.ws.close();
          await closed;
          const rows = await liveIdleRows();
          expect(rows, "disconnect publishes only the surviving sockets").toHaveLength(remaining);
          if (remaining) {
            expect(rows[0]?.onlineSince).toBe(idlePerson.onlineSince);
          }
        }
        const reconnected = await openRecipient("idle", ["operator.read"]);
        const returnedPerson = reconnected.hello.snapshot.presence.find(
          (entry) => entry.user?.id === idlePerson.user?.id && entry.reason === "connect",
        )!;
        expect(returnedPerson.onlineSince).toBeGreaterThan(idlePerson.onlineSince!);
        expect(returnedPerson.lastActivityAt).toBeUndefined();
        expect(returnedPerson.watchedSessions).toBeUndefined();
        expect(
          await liveIdleRows(),
          "reconnect publishes without profile edit or activity",
        ).toEqual([returnedPerson]);
        for (const recipient of recipients.filter(({ canRead }) => !canRead)) {
          expect((await rpcReq(recipient.ws, "health")).ok).toBe(true);
          expect(recipient.events, `${recipient.name} connection-driven frames`).toEqual([]);
        }

        const rejected = await openWs(port, { origin: BROWSER_ORIGIN });
        sockets.push(rejected);
        const rejectedEvents = observePresence(rejected);
        const connect = await connectReq(rejected, {
          skipDefaultAuth: true,
          device: null,
          scopes: ["operator.read", "operator.admin"],
          client: CONTROL_UI_CLIENT,
        });
        expect(connect.ok).toBe(false);
        expect(connect.payload).toBeUndefined();
        expect(rejectedEvents).toEqual([]);
      } finally {
        for (const ws of sockets) {
          ws.close();
        }
      }
    });
  });
});

import http from "node:http";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type {
  SessionCatalogHost,
  SessionCatalogSession,
} from "openclaw/plugin-sdk/session-catalog";
import type { ActiveSessionCatalog } from "openclaw/plugin-sdk/session-catalog-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { createBeamRequestHandler } from "./http.js";
import { beamMirrorId, createBeamMirrorRunner } from "./mirror.js";
import type { BeamStore } from "./store.js";
import type { BeamStoredSession } from "./types.js";

const NOW = Date.parse("2026-08-24T00:00:00.000Z");
const TRACKED_THREAD_ID = "tracked-session";

function session(threadId: string, recencyAt: number): SessionCatalogSession {
  return {
    threadId,
    name: threadId,
    status: "live",
    createdAt: recencyAt,
    recencyAt,
    archived: false,
    canContinue: false,
    canArchive: false,
  };
}

function gatewayHost(
  sessions: SessionCatalogSession[],
  state: Partial<Pick<SessionCatalogHost, "connected" | "error" | "nextCursor">> = {},
): SessionCatalogHost {
  return {
    hostId: "gateway:local",
    label: "Local",
    kind: "gateway",
    connected: true,
    sessions,
    ...state,
  };
}

function memoryStore(): BeamStore & { values: Map<string, BeamStoredSession> } {
  const values = new Map<string, BeamStoredSession>();
  return {
    values,
    update: async (beamId, updateValue) => {
      const next = updateValue(values.get(beamId));
      if (!next) {
        return false;
      }
      values.set(beamId, next);
      return true;
    },
    get: async (beamId) => values.get(beamId),
    list: async () => [...values.values()],
  };
}

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

async function serve(store: BeamStore): Promise<string> {
  const handler = createBeamRequestHandler({
    store,
    resolveClient: () => ({ clientIp: "127.0.0.1", scopes: ["operator.write"] }),
    resolveControlUiBasePath: () => "",
  });
  const server = http.createServer((req, res) => {
    void handler(req, res);
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Beam receiver did not expose a TCP address");
  }
  return `http://127.0.0.1:${address.port}/api/v1/beam/sessions`;
}

const overflowSessions = Array.from({ length: 32 }, (_, index) =>
  session(`newer-${index}`, NOW + index + 1),
);

describe("Beam mirror inactive completion", () => {
  it.each([
    {
      observation: "upload selection is capped",
      incomplete: async () => [gatewayHost([...overflowSessions, session(TRACKED_THREAD_ID, NOW)])],
      complete: async () => [gatewayHost(overflowSessions)],
    },
    {
      observation: "catalog listing throws",
      incomplete: async (): Promise<SessionCatalogHost[]> => {
        throw new Error("catalog unavailable");
      },
      complete: async () => [gatewayHost([])],
    },
    {
      observation: "host reports an error",
      incomplete: async () => [
        gatewayHost([], { error: { code: "unavailable", message: "try again" } }),
      ],
      complete: async () => [gatewayHost([])],
    },
    {
      observation: "host is paginated",
      incomplete: async () => [gatewayHost([], { nextCursor: "page-2" })],
      complete: async () => [gatewayHost([])],
    },
    {
      observation: "host is disconnected",
      incomplete: async () => [gatewayHost([], { connected: false })],
      complete: async () => [gatewayHost([])],
    },
  ])("waits when $observation", async ({ incomplete, complete }) => {
    const store = memoryStore();
    const endpoint = await serve(store);
    let list = async () => [gatewayHost([session(TRACKED_THREAD_ID, NOW)])];
    const catalog: ActiveSessionCatalog = {
      pluginId: "claude",
      id: "claude",
      label: "Claude",
      processHomeFallbackAllowed: true,
      list: () => list(),
      read: async ({ threadId }) => ({
        hostId: "gateway:local",
        threadId,
        items: [{ type: "agentMessage", text: "Still working" }],
      }),
    };
    const runtime = {
      config: {
        current: () => ({
          plugins: {
            entries: {
              beam: { config: { mirror: { endpoint, catalogs: ["claude"] } } },
            },
          },
        }),
      },
    } as unknown as PluginRuntime;
    const runner = createBeamMirrorRunner({
      runtime,
      logger: { warn: () => {}, info: () => {} },
      now: () => NOW,
      listCatalogs: () => [catalog],
    });

    await runner.tick();
    const trackedId = beamMirrorId("claude", "gateway:local", TRACKED_THREAD_ID);
    expect(store.values.get(trackedId)?.completed).toBe(false);

    list = incomplete;
    await runner.tick();
    expect(store.values.get(trackedId)?.completed).toBe(false);

    list = complete;
    await runner.tick();
    expect(store.values.get(trackedId)?.completed).toBe(true);
  });
});

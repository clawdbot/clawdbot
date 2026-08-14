import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawPluginSessionsChangedEvent, PluginRuntime } from "openclaw/plugin-sdk/core";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { buildAgentSessionKey, resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveClickClackAccount } from "../accounts.js";
import { createClickClackClient } from "../http-client.js";
import { handleClickClackInbound } from "../inbound.js";
import { setClickClackRuntime } from "../runtime.js";
import type { ClickClackChannel, ClickClackMessage, CoreConfig } from "../types.js";
import { ClickClackDiscussionService } from "./service.js";

type RemoteChannel = ClickClackChannel;
type RemotePatch = Record<string, unknown>;

function memoryStore<T>(): PluginStateSyncKeyedStore<T> {
  const values = new Map<string, { value: T; createdAt: number }>();
  return {
    register: (key, value) => values.set(key, { value, createdAt: Date.now() }),
    registerIfAbsent(key, value) {
      if (values.has(key)) {
        return false;
      }
      values.set(key, { value, createdAt: Date.now() });
      return true;
    },
    lookup: (key) => values.get(key)?.value,
    consume(key) {
      const value = values.get(key)?.value;
      values.delete(key);
      return value;
    },
    delete: (key) => values.delete(key),
    entries: () =>
      Array.from(values, ([key, entry]) => ({
        key,
        value: entry.value,
        createdAt: entry.createdAt,
      })),
    clear: () => values.clear(),
  };
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function startMockClickClack() {
  const patches: RemotePatch[] = [];
  const messages: ClickClackMessage[] = [];
  const channels: RemoteChannel[] = [
    {
      id: "chn_general",
      route_id: "general-route",
      workspace_id: "wsp_team",
      name: "general",
      kind: "public",
      external_managed: false,
      external_ref: "",
      external_url: "",
      sidebar_section: "",
      archived: false,
      archived_at: null,
      created_at: "2026-08-04T00:00:00.000Z",
    },
  ];
  let createCount = 0;
  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.headers.authorization !== "Bearer proof-token") {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/workspaces") {
      sendJson(res, 200, {
        workspaces: [
          {
            id: "wsp_team",
            route_id: "team-route",
            slug: "team",
            name: "Team",
            created_at: "2026-08-04T00:00:00.000Z",
          },
        ],
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/workspaces/wsp_team/channels") {
      sendJson(res, 200, { channels });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/workspaces/wsp_team/channels") {
      createCount += 1;
      const input = await readJson(req);
      const channel = {
        id: "chn_durable",
        route_id: "durable-route",
        workspace_id: "wsp_team",
        ...input,
        kind: "public",
        archived: false,
        archived_at: null,
        created_at: "2026-08-04T00:00:01.000Z",
      } as RemoteChannel;
      channels.push(channel);
      sendJson(res, 200, { channel });
      return;
    }
    if (req.method === "PATCH" && url.pathname === "/api/channels/chn_durable") {
      const patch = await readJson(req);
      patches.push(patch);
      Object.assign(channels[1]!, patch);
      sendJson(res, 200, { channel: channels[1] });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/channels/chn_durable/messages") {
      sendJson(res, 200, { messages, oldest_seq: 1, has_older: false });
      return;
    }
    sendJson(res, 404, { error: `unexpected ${req.method} ${url.pathname}` });
  }
  const server = createServer((req, res) => {
    void handleRequest(req, res).catch(() => {
      sendJson(res, 500, { error: "mock ClickClack request failed" });
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    channels,
    messages,
    patches,
    get createCount() {
      return createCount;
    },
    close: async () =>
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

describe("ClickClack durable room real-behavior proof", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).map(async (cleanup) => await cleanup()));
  });

  it("keeps one remote room and delivers inbound after archive, reset, deletion, and recreation", async () => {
    const remote = await startMockClickClack();
    cleanups.push(remote.close);
    const sessionKey = "agent:research:proof-room";
    let sessionEntry:
      | { sessionId: string; label: string; updatedAt: number; archivedAt?: number }
      | undefined = {
      sessionId: "session-original",
      label: "Durable proof room",
      updatedAt: 1,
    };
    const config = {
      channels: {
        clickclack: {
          enabled: true,
          baseUrl: remote.baseUrl,
          token: "proof-token",
          workspace: "team",
          discussions: { enabled: true, workspace: "team", section: "Sessions" },
          allowFrom: ["*"],
        },
      },
    } satisfies CoreConfig;
    const stores = new Map<string, PluginStateSyncKeyedStore<unknown>>();
    const runtime = createPluginRuntimeMock({
      config: { current: vi.fn(() => config) },
      state: {
        openSyncKeyedStore: vi.fn(({ namespace }: { namespace: string }) => {
          const existing = stores.get(namespace);
          if (existing) {
            return existing;
          }
          const created = memoryStore<unknown>();
          stores.set(namespace, created);
          return created;
        }) as unknown as PluginRuntime["state"]["openSyncKeyedStore"],
      },
      agent: {
        session: { getSessionEntry: vi.fn(() => sessionEntry) },
      },
      channel: {
        routing: {
          resolveAgentRoute: vi.fn(
            (params: Parameters<PluginRuntime["channel"]["routing"]["resolveAgentRoute"]>[0]) =>
              resolveAgentRoute(params),
          ),
          buildAgentSessionKey: vi.fn(
            (params: Parameters<PluginRuntime["channel"]["routing"]["buildAgentSessionKey"]>[0]) =>
              buildAgentSessionKey(params),
          ),
        },
      },
    } as unknown as PluginRuntime);
    setClickClackRuntime(runtime);
    const eventHandlers = new Set<(event: OpenClawPluginSessionsChangedEvent) => void>();
    const service = new ClickClackDiscussionService(runtime, {
      clientFactory: (account) =>
        createClickClackClient({ baseUrl: account.apiEndpoint, token: account.token }),
      installationId: "11111111-2222-4333-8444-555555555555",
      bindingGenerationFactory: () => "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      gatewayEvents: {
        onSessionsChanged(handler) {
          eventHandlers.add(handler);
          return () => eventHandlers.delete(handler);
        },
      },
      startTimer: false,
    });
    cleanups.push(async () => service.cleanup());
    const emit = async (event: OpenClawPluginSessionsChangedEvent) => {
      for (const handler of eventHandlers) {
        handler(event);
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 300);
      });
    };

    await service.open(sessionKey);
    const originalExternalRef = remote.channels[1]?.external_ref;
    remote.messages.push({
      id: "msg_history",
      workspace_id: "wsp_team",
      channel_id: "chn_durable",
      author_id: "usr_owner",
      thread_root_id: "msg_history",
      body: "durable history marker",
      body_format: "markdown",
      created_at: "2026-08-04T00:00:02.000Z",
      author: {
        id: "usr_owner",
        kind: "human",
        display_name: "Owner",
        handle: "owner",
        avatar_url: "",
        created_at: "2026-08-04T00:00:00.000Z",
      },
    });

    sessionEntry = { ...sessionEntry!, archivedAt: 2 };
    await emit({ sessionKey, reason: "archive" });
    sessionEntry = { sessionId: "session-reset", label: "Durable proof room", updatedAt: 3 };
    await emit({ sessionKey, reason: "reset" });
    sessionEntry = undefined;
    await emit({ sessionKey, reason: "delete" });
    sessionEntry = { sessionId: "session-recreated", label: "Durable proof room", updatedAt: 4 };
    await emit({ sessionKey, reason: "create" });

    const history = await service.readLatestMessages(sessionKey, 30);
    await handleClickClackInbound({
      account: resolveClickClackAccount({ cfg: config }),
      config,
      message: {
        ...remote.messages[0]!,
        id: "msg_inbound",
        body: "continue after recreation",
      },
    });

    const managed = remote.channels.filter((channel) => channel.external_managed === true);
    expect(remote.createCount).toBe(1);
    expect(managed).toHaveLength(1);
    expect(managed[0]).toMatchObject({
      id: "chn_durable",
      external_ref: originalExternalRef,
      archived: false,
      archived_at: null,
    });
    expect(remote.patches.every((patch) => !("archived" in patch))).toBe(true);
    expect(history.text).toContain("durable history marker");
    expect(runtime.channel.inbound.dispatch).toHaveBeenCalledOnce();
  });
});

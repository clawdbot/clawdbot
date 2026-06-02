import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import { createChannelTestPluginBase } from "../test-utils/channel-plugins.js";
import { setRegistry } from "./server.agent.gateway-server-agent.mocks.js";
import { createRegistry } from "./server.e2e-registry-helpers.js";
import {
  connectOk,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
  testState,
  writeSessionStore,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

let server: Awaited<ReturnType<typeof startServerWithClient>>["server"];
let ws: Awaited<ReturnType<typeof startServerWithClient>>["ws"];
let sessionStoreDir: string;
let sessionStorePath: string;

const createStubChannelPlugin = (params: {
  id: ChannelPlugin["id"];
  label: string;
}): ChannelPlugin => ({
  ...createChannelTestPluginBase({
    id: params.id,
    label: params.label,
  }),
  outbound: {
    deliveryMode: "direct",
    resolveTarget: ({ to }) => {
      const trimmed = to?.trim() ?? "";
      if (trimmed) {
        return { ok: true, to: trimmed };
      }
      return { ok: false, error: new Error(`missing target for ${params.id}`) };
    },
    sendText: async () => ({ channel: params.id, messageId: "msg-test" }),
    sendMedia: async () => ({ channel: params.id, messageId: "msg-test" }),
  },
});

const defaultRegistry = createRegistry([
  {
    pluginId: "slack",
    source: "test",
    plugin: createStubChannelPlugin({ id: "slack", label: "Slack" }),
  },
]);

beforeAll(async () => {
  const started = await startServerWithClient();
  server = started.server;
  ws = started.ws;
  await connectOk(ws);
  sessionStoreDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-subagent-delivery-ctx-"));
  sessionStorePath = path.join(sessionStoreDir, "sessions.json");
});

afterAll(async () => {
  ws.close();
  await server.close();
  await fs.rm(sessionStoreDir, { recursive: true, force: true });
});

type StoredEntry = {
  route?: {
    channel?: string;
    accountId?: string;
    target?: { to?: string; rawTo?: string; chatType?: string };
    thread?: { id?: string | number; kind?: string; source?: string };
  };
  deliveryContext?: { channel?: string; to?: string; threadId?: string; accountId?: string };
  lastChannel?: string;
  lastTo?: string;
  lastThreadId?: string | number;
  lastAccountId?: string;
};

type StoreEntries = Parameters<typeof writeSessionStore>[0]["entries"];

async function prepareSessionStore(entries: StoreEntries = {}): Promise<void> {
  setRegistry(defaultRegistry);
  testState.sessionStorePath = sessionStorePath;
  await writeSessionStore({ entries });
}

function readStoredEntry(stored: Record<string, StoredEntry>, key: string): StoredEntry {
  const entry = stored[key];
  if (!entry) {
    throw new Error(`expected stored entry ${key}`);
  }
  return entry;
}

function readDeliveryContext(entry: StoredEntry): NonNullable<StoredEntry["deliveryContext"]> {
  if (!entry.deliveryContext) {
    throw new Error("expected stored deliveryContext");
  }
  return entry.deliveryContext;
}

async function readStoredSessionEntry(key: string): Promise<StoredEntry> {
  const stored = JSON.parse(await fs.readFile(sessionStorePath, "utf-8")) as Record<
    string,
    StoredEntry
  >;
  return readStoredEntry(stored, key);
}

async function sendAgentRequest(params: Record<string, unknown>): Promise<void> {
  const res = await rpcReq(ws, "agent", {
    deliver: false,
    ...params,
  });
  expect(res.ok).toBe(true);
}

function expectDeliveryContextFields(entry: StoredEntry, expected: Record<string, unknown>): void {
  const deliveryContext = readDeliveryContext(entry);
  for (const [key, value] of Object.entries(expected)) {
    expect(deliveryContext[key as keyof typeof deliveryContext]).toBe(value);
  }
}

describe("subagent session deliveryContext from spawn request params", () => {
  test("new subagent session inherits deliveryContext from request channel/to/threadId", async () => {
    await prepareSessionStore();

    await sendAgentRequest({
      message: "[Subagent Task]: analyze data",
      sessionKey: "agent:main:subagent:test-delivery-ctx",
      channel: "slack",
      to: "channel:C0AF8TW48UQ",
      accountId: "default",
      threadId: "1774374945.091819",
      idempotencyKey: "idem-subagent-delivery-ctx-1",
    });

    const entry = await readStoredSessionEntry("agent:main:subagent:test-delivery-ctx");
    expectDeliveryContextFields(entry, {
      channel: "slack",
      to: "channel:C0AF8TW48UQ",
      threadId: "1774374945.091819",
      accountId: "default",
    });
    expect(entry.route).toEqual({
      channel: "slack",
      accountId: "default",
      target: { to: "channel:C0AF8TW48UQ" },
      thread: { id: "1774374945.091819" },
    });
    expect(entry.lastChannel).toBe("slack");
    expect(entry.lastTo).toBe("channel:C0AF8TW48UQ");
  });

  test("existing session deliveryContext is NOT overwritten by request params", async () => {
    await prepareSessionStore({
      "agent:main:subagent:existing-ctx": {
        sessionId: "sess-existing",
        updatedAt: Date.now(),
        deliveryContext: {
          channel: "slack",
          to: "user:U09U1LV7JDN",
          accountId: "default",
          threadId: "1771242986.529939",
        },
        lastChannel: "slack",
        lastTo: "user:U09U1LV7JDN",
        lastAccountId: "default",
        lastThreadId: "1771242986.529939",
      },
    });

    await sendAgentRequest({
      message: "follow-up",
      sessionKey: "agent:main:subagent:existing-ctx",
      channel: "slack",
      to: "channel:C0AF8TW48UQ",
      threadId: "9999999999.000000",
      idempotencyKey: "idem-subagent-delivery-ctx-2",
    });

    const entry = await readStoredSessionEntry("agent:main:subagent:existing-ctx");
    // The ORIGINAL deliveryContext should be preserved (primary wins in merge).
    expectDeliveryContextFields(entry, {
      to: "user:U09U1LV7JDN",
      threadId: "1771242986.529939",
    });
    expect(entry.lastTo).toBe("user:U09U1LV7JDN");
  });

  test("existing session route metadata survives agent request delivery normalization", async () => {
    await prepareSessionStore({
      "agent:main:subagent:existing-route-metadata": {
        sessionId: "sess-existing-route",
        updatedAt: Date.now(),
        route: {
          channel: "slack",
          accountId: "default",
          target: {
            to: "channel:C0AF8TW48UQ",
            rawTo: "slack://C0AF8TW48UQ",
            chatType: "channel",
          },
          thread: {
            id: "1771242986.529939",
            kind: "thread",
            source: "target",
          },
        },
        deliveryContext: {
          channel: "slack",
          to: "channel:C0AF8TW48UQ",
          accountId: "default",
          threadId: "1771242986.529939",
        },
        lastChannel: "slack",
        lastTo: "channel:C0AF8TW48UQ",
        lastAccountId: "default",
        lastThreadId: "1771242986.529939",
      },
    });

    await sendAgentRequest({
      message: "follow-up",
      sessionKey: "agent:main:subagent:existing-route-metadata",
      channel: "slack",
      to: "channel:C0AF8TW48UQ",
      accountId: "default",
      threadId: "1771242986.529939",
      idempotencyKey: "idem-subagent-delivery-route-metadata",
    });

    const entry = await readStoredSessionEntry("agent:main:subagent:existing-route-metadata");
    expect(entry.route).toEqual({
      channel: "slack",
      accountId: "default",
      target: {
        to: "channel:C0AF8TW48UQ",
        rawTo: "slack://C0AF8TW48UQ",
        chatType: "channel",
      },
      thread: {
        id: "1771242986.529939",
        kind: "thread",
        source: "target",
      },
    });
  });

  test("pre-patched subagent session (via sessions.patch) inherits deliveryContext from agent request", async () => {
    // Simulates the real subagent spawn flow: spawnSubagentDirect calls sessions.patch
    // first (to set spawnDepth, spawnedBy, etc.), then calls callSubagentGateway({method: "agent"}).
    // The sessions.patch creates a partial entry without deliveryContext.
    // The agent handler must seed deliveryContext from the request params.
    await prepareSessionStore({
      "agent:main:subagent:pre-patched": {
        sessionId: "sess-pre-patched",
        updatedAt: Date.now(),
        spawnDepth: 1,
        spawnedBy: "agent:main:slack:direct:u07fdr83w6n:thread:1775577152.364109",
      },
    });

    await sendAgentRequest({
      message: "[Subagent Task]: investigate data",
      sessionKey: "agent:main:subagent:pre-patched",
      channel: "slack",
      to: "user:U07FDR83W6N",
      accountId: "default",
      threadId: "1775577152.364109",
      idempotencyKey: "idem-subagent-delivery-ctx-prepatched",
    });

    const entry = await readStoredSessionEntry("agent:main:subagent:pre-patched");
    expectDeliveryContextFields(entry, {
      channel: "slack",
      to: "user:U07FDR83W6N",
      threadId: "1775577152.364109",
      accountId: "default",
    });
    expect(entry.route).toEqual({
      channel: "slack",
      accountId: "default",
      target: { to: "user:U07FDR83W6N" },
      thread: { id: "1775577152.364109" },
    });
    expect(entry.lastThreadId).toBe("1775577152.364109");
  });

  test("request without to/threadId does not inject empty values", async () => {
    await prepareSessionStore();

    await sendAgentRequest({
      message: "internal task",
      sessionKey: "agent:main:subagent:no-routing",
      channel: "slack",
      idempotencyKey: "idem-subagent-delivery-ctx-3",
    });

    const entry = await readStoredSessionEntry("agent:main:subagent:no-routing");
    expectDeliveryContextFields(entry, { channel: "slack" });
    const deliveryContext = readDeliveryContext(entry);
    expect(deliveryContext.to).toBeUndefined();
    expect(deliveryContext.threadId).toBeUndefined();
  });
});

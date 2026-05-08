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
  deliveryContext?: { channel?: string; to?: string; threadId?: string; accountId?: string };
  lastChannel?: string;
  lastTo?: string;
  lastThreadId?: string | number;
  lastAccountId?: string;
};

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

describe("subagent session deliveryContext from spawn request params", () => {
  test("new subagent session inherits deliveryContext from request channel/to/threadId", async () => {
    setRegistry(defaultRegistry);
    testState.sessionStorePath = sessionStorePath;
    await writeSessionStore({ entries: {} });

    const res = await rpcReq(ws, "agent", {
      message: "[Subagent Task]: analyze data",
      sessionKey: "agent:main:subagent:test-delivery-ctx",
      channel: "slack",
      to: "channel:C0AF8TW48UQ",
      accountId: "default",
      threadId: "1774374945.091819",
      deliver: false,
      idempotencyKey: "idem-subagent-delivery-ctx-1",
    });
    expect(res.ok).toBe(true);

    const stored = JSON.parse(await fs.readFile(sessionStorePath, "utf-8")) as Record<
      string,
      StoredEntry
    >;
    const entry = readStoredEntry(stored, "agent:main:subagent:test-delivery-ctx");
    const deliveryContext = readDeliveryContext(entry);
    expect(deliveryContext.channel).toBe("slack");
    expect(deliveryContext.to).toBe("channel:C0AF8TW48UQ");
    expect(deliveryContext.threadId).toBe("1774374945.091819");
    expect(deliveryContext.accountId).toBe("default");
    expect(entry.lastChannel).toBe("slack");
    expect(entry.lastTo).toBe("channel:C0AF8TW48UQ");
  });

  test("existing session deliveryContext is NOT overwritten by request params", async () => {
    setRegistry(defaultRegistry);
    testState.sessionStorePath = sessionStorePath;
    await writeSessionStore({
      entries: {
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
      },
    });

    const res = await rpcReq(ws, "agent", {
      message: "follow-up",
      sessionKey: "agent:main:subagent:existing-ctx",
      channel: "slack",
      to: "channel:C0AF8TW48UQ",
      threadId: "9999999999.000000",
      deliver: false,
      idempotencyKey: "idem-subagent-delivery-ctx-2",
    });
    expect(res.ok).toBe(true);

    const stored = JSON.parse(await fs.readFile(sessionStorePath, "utf-8")) as Record<
      string,
      StoredEntry
    >;
    const entry = readStoredEntry(stored, "agent:main:subagent:existing-ctx");
    const deliveryContext = readDeliveryContext(entry);
    // The ORIGINAL deliveryContext should be preserved (primary wins in merge).
    expect(deliveryContext.to).toBe("user:U09U1LV7JDN");
    expect(deliveryContext.threadId).toBe("1771242986.529939");
    expect(entry.lastTo).toBe("user:U09U1LV7JDN");
  });

  test("pre-patched subagent session (via sessions.patch) inherits deliveryContext from agent request", async () => {
    // Simulates the real subagent spawn flow: spawnSubagentDirect calls sessions.patch
    // first (to set spawnDepth, spawnedBy, etc.), then calls callSubagentGateway({method: "agent"}).
    // The sessions.patch creates a partial entry without deliveryContext.
    // The agent handler must seed deliveryContext from the request params.
    setRegistry(defaultRegistry);
    testState.sessionStorePath = sessionStorePath;
    await writeSessionStore({
      entries: {
        "agent:main:subagent:pre-patched": {
          sessionId: "sess-pre-patched",
          updatedAt: Date.now(),
          spawnDepth: 1,
          spawnedBy: "agent:main:slack:direct:u07fdr83w6n:thread:1775577152.364109",
        },
      },
    });

    const res = await rpcReq(ws, "agent", {
      message: "[Subagent Task]: investigate data",
      sessionKey: "agent:main:subagent:pre-patched",
      channel: "slack",
      to: "user:U07FDR83W6N",
      accountId: "default",
      threadId: "1775577152.364109",
      deliver: false,
      idempotencyKey: "idem-subagent-delivery-ctx-prepatched",
    });
    expect(res.ok).toBe(true);

    const stored = JSON.parse(await fs.readFile(sessionStorePath, "utf-8")) as Record<
      string,
      StoredEntry
    >;
    const entry = readStoredEntry(stored, "agent:main:subagent:pre-patched");
    const deliveryContext = readDeliveryContext(entry);
    expect(deliveryContext.channel).toBe("slack");
    expect(deliveryContext.to).toBe("user:U07FDR83W6N");
    expect(deliveryContext.threadId).toBe("1775577152.364109");
    expect(deliveryContext.accountId).toBe("default");
    expect(entry.lastThreadId).toBe("1775577152.364109");
  });

  test("request without to/threadId does not inject empty values", async () => {
    setRegistry(defaultRegistry);
    testState.sessionStorePath = sessionStorePath;
    await writeSessionStore({ entries: {} });

    const res = await rpcReq(ws, "agent", {
      message: "internal task",
      sessionKey: "agent:main:subagent:no-routing",
      channel: "slack",
      deliver: false,
      idempotencyKey: "idem-subagent-delivery-ctx-3",
    });
    expect(res.ok).toBe(true);

    const stored = JSON.parse(await fs.readFile(sessionStorePath, "utf-8")) as Record<
      string,
      StoredEntry
    >;
    const entry = readStoredEntry(stored, "agent:main:subagent:no-routing");
    const deliveryContext = readDeliveryContext(entry);
    expect(deliveryContext.channel).toBe("slack");
    expect(deliveryContext.to).toBeUndefined();
    expect(deliveryContext.threadId).toBeUndefined();
  });
});

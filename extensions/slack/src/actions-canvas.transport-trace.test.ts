// Real-transport behavior proof for the Slack canvas action surface.
//
// Drives the REAL Slack channel-action adapter entry point
// (`createSlackActions().handleAction`) through the real lazy-loaded action
// runtime (gate, operation token resolution, read-target authorization) into
// the real `actions-canvas` module, which calls the REAL `@slack/web-api`
// `WebClient` via `apiCall("canvases.*")`. The WebClient is pointed at an
// ephemeral loopback HTTP server via `SLACK_API_URL`, so every canvases.* call
// is a real HTTP POST with a real URL-encoded form body — not a recording
// stand-in. The server captures the exact method (URL path) and parsed form
// arguments, proving the after-fix wire contract through the real SDK transport.
import { createServer } from "node:http";
import type { Socket } from "node:net";
import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SlackCanvasBinding } from "./canvas-binding.js";
import { createSlackActions } from "./channel-actions.js";
import { setSlackRuntime } from "./runtime.js";

const TEST_ENV_KEYS = [
  "SLACK_API_URL",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "ALL_PROXY",
  "https_proxy",
  "http_proxy",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
  "OPENCLAW_PROXY_ACTIVE",
  "OPENCLAW_PROXY_CA_FILE",
] as const;

type WireCall = {
  method: string;
  args: Record<string, unknown>;
};

type TestServer = {
  apiUrl: string;
  close(): Promise<void>;
};

function slackConfig(overrides?: Record<string, unknown>): OpenClawConfig {
  return {
    channels: {
      slack: {
        botToken: "xoxb-transport-trace",
        // Canvas gate is default-off in production (existing installs lack the
        // scope); the transport-trace harness models a reinstalled, scope-granted
        // app so the real SDK transport is exercised on the happy path.
        actions: { canvas: true },
        ...overrides,
      },
    },
  } as OpenClawConfig;
}

// Parse the URL-encoded form body the @slack/web-api WebClient sends for a
// canvases.* call into its key/value arguments.
function parseFormBody(raw: string): Record<string, unknown> {
  const parsed: Record<string, unknown> = {};
  for (const pair of raw.split("&")) {
    const [key, value] = pair.split("=");
    if (key === undefined) {
      continue;
    }
    parsed[decodeURIComponent(key.replace(/\+/g, " "))] = decodeURIComponent(
      (value ?? "").replace(/\+/g, " "),
    );
  }
  return parsed;
}

async function startTransportServer(calls: WireCall[]): Promise<TestServer> {
  const server = createServer((request, response) => {
    const url = request.url ?? "";
    const method = url.replace(/^\/api\//, "");
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.once("end", () => {
      const parsed = parseFormBody(Buffer.concat(chunks).toString("utf8"));
      calls.push({ method, args: parsed });
      const payload = respondTo(method, parsed);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(`${JSON.stringify(payload)}\n`);
    });
  });
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Slack transport trace server did not bind a TCP address");
  }
  return {
    apiUrl: `http://127.0.0.1:${address.port}/api/`,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function respondTo(method: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (method) {
    case "auth.test":
      return { ok: true, user_id: "U0BOT", team: "T123", url: "https://trace.slack.com/" };
    case "conversations.info":
      return {
        ok: true,
        channel: { id: args.channel ?? args.channel_id, is_channel: true, name: "current" },
      };
    case "canvases.create":
      return { ok: true, canvas_id: "F0TRACE001" };
    case "canvases.edit":
      return { ok: true };
    case "canvases.delete":
      return { ok: true };
    case "canvases.sections.lookup":
      return { ok: true, sections: [{ id: "temp:C:section1" }] };
    default:
      return { ok: false, error: "unknown_method" };
  }
}

const originalEnv = Object.fromEntries(TEST_ENV_KEYS.map((key) => [key, process.env[key]]));

// In-memory PluginStateKeyedStore for canvas bindings: a Map is enough to prove
// the action-owner binding wiring without standing up the plugin-state SQLite layer.
// Module-level so the binding recorded by a create scenario is visible to a later
// edit/delete scenario through the same runtime store handle.
const canvasBindingMap = new Map<string, SlackCanvasBinding>();
function createInMemoryCanvasBindingStore(): PluginStateKeyedStore<SlackCanvasBinding> {
  return {
    register: async (key, value) => {
      canvasBindingMap.set(key, value);
    },
    registerIfAbsent: async (key, value) => {
      if (canvasBindingMap.has(key)) {
        return false;
      }
      canvasBindingMap.set(key, value);
      return true;
    },
    lookup: async (key) => canvasBindingMap.get(key),
    consume: async (key) => {
      const value = canvasBindingMap.get(key);
      canvasBindingMap.delete(key);
      return value;
    },
    delete: async (key) => canvasBindingMap.delete(key),
    entries: async () =>
      Array.from(canvasBindingMap.entries()).map(([key, value]) => ({
        key,
        value,
        createdAt: 0,
      })),
    clear: async () => {
      canvasBindingMap.clear();
    },
  };
}

function clearSlackTransportEnv(): void {
  for (const key of TEST_ENV_KEYS) {
    delete process.env[key];
  }
}

function restoreSlackTransportEnv(): void {
  for (const key of TEST_ENV_KEYS) {
    const original = originalEnv[key];
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
}

const adapter = createSlackActions("slack");
const handleAction = adapter.handleAction!;
if (!handleAction) {
  throw new Error("Slack channel action adapter is missing its handleAction entry");
}

function actionContext(
  cfg: OpenClawConfig,
  params: Record<string, unknown>,
): ChannelMessageActionContext {
  return {
    channel: "slack",
    action: "canvas",
    cfg,
    params,
    accountId: "default",
    requesterAccountId: "default",
    conversationReadOrigin: "delegated",
    toolContext: {
      currentChannelProvider: "slack",
      currentChannelId: "team:T123:channel:C123",
    },
  };
}

async function runCanvasScenario(
  params: Record<string, unknown>,
  cfg: OpenClawConfig = slackConfig(),
): Promise<{ result?: AgentToolResult<unknown>; calls: WireCall[]; error?: Error }> {
  const calls: WireCall[] = [];
  const server = await startTransportServer(calls);
  process.env.SLACK_API_URL = server.apiUrl;
  try {
    const result = await handleAction(actionContext(cfg, params));
    return { result, calls: [...calls], error: undefined };
  } catch (error) {
    return { result: undefined, calls: [...calls], error: error as Error };
  } finally {
    await server.close();
  }
}

describe("Slack canvas action real-transport trace", () => {
  beforeEach(() => {
    clearSlackTransportEnv();
    canvasBindingMap.clear();
    // Inject an in-memory plugin state store so the canvas->channel binding
    // (canvas-binding.ts) persists across scenarios and the binding re-check can
    // be exercised through the real action owner. A plain Map-backed store is
    // sufficient because the transport trace proves the action-owner wiring,
    // not the plugin-state persistence layer.
    setSlackRuntime({
      state: { openKeyedStore: () => createInMemoryCanvasBindingStore() },
    } as never);
  });

  afterEach(() => {
    restoreSlackTransportEnv();
    setSlackRuntime(null as never);
  });

  it("routes canvas create through the real SDK transport to a canvases.create HTTP POST", async () => {
    const { result, error, calls } = await runCanvasScenario({
      op: "create",
      channelId: "C123",
      title: "Status",
      documentContent: { type: "markdown", markdown: "# Status\n- [ ] task" },
    });
    expect(error).toBeUndefined();
    expect(result?.details).toMatchObject({ ok: true, canvas: { canvasId: "F0TRACE001" } });
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "canvases.create",
          args: expect.objectContaining({
            channel_id: "C123",
            title: "Status",
          }),
        }),
      ]),
    );
  });

  it("routes canvas edit through the real SDK transport to a canvases.edit HTTP POST", async () => {
    // edit/delete/lookup require a binding, so create first to record one for
    // the canvas id the loopback server returns (F0TRACE001).
    await runCanvasScenario({
      op: "create",
      channelId: "C123",
      title: "Status",
      documentContent: { type: "markdown", markdown: "# Status" },
    });
    const { result, error, calls } = await runCanvasScenario({
      op: "edit",
      channelId: "C123",
      canvasId: "F0TRACE001",
      changes: [
        {
          operation: "insert_at_end",
          documentContent: { type: "markdown", markdown: "## Updated" },
        },
      ],
    });
    expect(error).toBeUndefined();
    expect(result?.details).toMatchObject({ ok: true });
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "canvases.edit",
          args: expect.objectContaining({ canvas_id: "F0TRACE001" }),
        }),
      ]),
    );
  });

  it("routes canvas sections through the real SDK transport to a canvases.sections.lookup HTTP POST", async () => {
    await runCanvasScenario({
      op: "create",
      channelId: "C123",
      title: "Status",
      documentContent: { type: "markdown", markdown: "# Status" },
    });
    const { result, error, calls } = await runCanvasScenario({
      op: "sections",
      channelId: "C123",
      canvasId: "F0TRACE001",
      sectionTypes: ["h1"],
    });
    expect(error).toBeUndefined();
    expect(result?.details).toMatchObject({ ok: true, sections: [{ id: "temp:C:section1" }] });
    // The @slack/web-api WebClient JSON-stringifies nested object arguments
    // into the URL-encoded form body (Slack's form transport is flat
    // key/value), so criteria arrives on the wire as a JSON string, not an
    // object. This is the real SDK transport behavior the trace proves.
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "canvases.sections.lookup",
          args: expect.objectContaining({
            canvas_id: "F0TRACE001",
            criteria: JSON.stringify({ section_types: ["h1"] }),
          }),
        }),
      ]),
    );
  });

  it("routes canvas delete through the real SDK transport to a canvases.delete HTTP POST", async () => {
    await runCanvasScenario({
      op: "create",
      channelId: "C123",
      title: "Status",
      documentContent: { type: "markdown", markdown: "# Status" },
    });
    const { result, error, calls } = await runCanvasScenario({
      op: "delete",
      channelId: "C123",
      canvasId: "F0TRACE001",
    });
    expect(error).toBeUndefined();
    expect(result?.details).toMatchObject({ ok: true });
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "canvases.delete",
          args: expect.objectContaining({ canvas_id: "F0TRACE001" }),
        }),
      ]),
    );
  });

  it("fails closed with no HTTP call when the canvas gate is disabled", async () => {
    const { calls, error } = await runCanvasScenario(
      { op: "create", channelId: "C123", title: "Status" },
      slackConfig({ actions: { canvas: false } }),
    );
    expect(error?.message).toBe("Slack canvas actions are disabled.");
    expect(calls).toEqual([]);
  });

  it("rejects an edit on a canvas whose bound channel has been disabled (binding re-check)", async () => {
    // Create records a canvas->C123 binding. A later edit on the same canvas id
    // is rejected before any HTTP call when C123 (the bound channel, not the
    // caller-named channel) is disabled — closing the cross-channel proxy where
    // canvases.* sends only canvas_id and Slack cannot bind it to the allowlist.
    const created = await runCanvasScenario({
      op: "create",
      channelId: "C123",
      title: "Binding",
      documentContent: { type: "markdown", markdown: "# Binding" },
    });
    expect(created.error).toBeUndefined();
    expect(created.result?.details).toMatchObject({ ok: true, canvas: { canvasId: "F0TRACE001" } });

    // The bound channel C123 is now disabled; even though the edit names C123
    // (and would otherwise pass the caller-channel check), the binding re-check
    // rejects it before the canvases.edit HTTP call.
    const { calls, error } = await runCanvasScenario(
      {
        op: "edit",
        channelId: "C123",
        canvasId: "F0TRACE001",
        changes: [
          { operation: "insert_at_end", documentContent: { type: "markdown", markdown: "x" } },
        ],
      },
      slackConfig({ channels: { C123: { enabled: false } } }),
    );
    expect(error?.message).toBe("Slack read target channel is not allowed.");
    expect(calls).toEqual([]);
  });

  it("rejects a canvas edit with an invalid canvas id before any HTTP call", async () => {
    const { calls, error } = await runCanvasScenario({
      op: "edit",
      channelId: "C123",
      canvasId: "not-a-canvas-id",
      changes: [
        { operation: "insert_at_end", documentContent: { type: "markdown", markdown: "x" } },
      ],
    });
    expect(error?.message).toContain("Invalid Slack canvas id");
    expect(calls).toEqual([]);
  });

  it("rejects a canvas id with no binding before any HTTP call (unbound canvas guard)", async () => {
    // canvases.* sends only canvas_id, so an agent naming a valid-but-foreign
    // canvas id (one OpenClaw never created, hence no canvas->channel binding)
    // must be rejected before any HTTP call. This closes the cross-channel proxy
    // where an agent would otherwise operate a denied channel's canvas through
    // an allowed action context.
    const { calls, error } = await runCanvasScenario({
      op: "sections",
      channelId: "C123",
      canvasId: "F0BU46ESS8J",
      sectionTypes: ["h1"],
    });
    expect(error?.message).toBe(
      'Slack canvas "F0BU46ESS8J" is not bound to an authorized channel. Only canvases created through the canvas action can be edited, deleted, or inspected.',
    );
    expect(calls).toEqual([]);
  });

  it("rejects a canvas edit with an empty changes array before any HTTP call", async () => {
    // edit requires a binding, so create first to record one for F0TRACE001.
    await runCanvasScenario({
      op: "create",
      channelId: "C123",
      title: "Status",
      documentContent: { type: "markdown", markdown: "# Status" },
    });
    const { calls, error } = await runCanvasScenario({
      op: "edit",
      channelId: "C123",
      canvasId: "F0TRACE001",
      changes: [],
    });
    expect(error?.message).toContain("non-empty changes");
    expect(calls).toEqual([]);
  });

  it("fails the create and cleans up the orphan canvas when the binding store is unavailable", async () => {
    // The binding is mandatory for later edit/delete/lookup (canvases.* sends
    // only canvas_id, so the binding is the only channel-allowlist authority).
    // When the plugin state store cannot be opened, the create must not report
    // success: it throws and deletes the just-created canvas so no orphan
    // accumulates. The beforeEach installed a working store; this scenario
    // overrides the runtime with one whose store cannot be opened.
    setSlackRuntime({
      state: {
        openKeyedStore: () => {
          throw new Error("plugin state store unavailable");
        },
      },
    } as never);
    const { result, calls, error } = await runCanvasScenario({
      op: "create",
      channelId: "C123",
      title: "Orphan",
      documentContent: { type: "markdown", markdown: "# Orphan" },
    });
    expect(error?.message).toContain("binding store is unavailable");
    expect(result).toBeUndefined();
    // The create reached Slack, then the binding failure triggered a cleanup
    // canvases.delete for the same canvas id — no orphan left behind.
    const createCall = calls.find((call) => call.method === "canvases.create");
    const deleteCall = calls.find((call) => call.method === "canvases.delete");
    expect(createCall).toBeTruthy();
    expect(deleteCall).toBeTruthy();
    expect(calls.indexOf(deleteCall!)).toBeGreaterThan(calls.indexOf(createCall!));
    expect(deleteCall?.args).toMatchObject({ canvas_id: "F0TRACE001" });
  });

  it("fails the create and cleans up the orphan canvas when binding register throws", async () => {
    // Same invariant as the unavailable-store case, but the store opens and the
    // write itself fails (e.g. PLUGIN_STATE_WRITE_FAILED). The create must
    // surface the persistence failure and delete the orphan canvas.
    setSlackRuntime({
      state: {
        openKeyedStore: () => ({
          ...createInMemoryCanvasBindingStore(),
          register: async () => {
            throw new Error("plugin state write failed");
          },
        }),
      },
    } as never);
    const { result, calls, error } = await runCanvasScenario({
      op: "create",
      channelId: "C123",
      title: "Orphan",
      documentContent: { type: "markdown", markdown: "# Orphan" },
    });
    expect(error?.message).toContain("plugin state write failed");
    expect(result).toBeUndefined();
    const createCall = calls.find((call) => call.method === "canvases.create");
    const deleteCall = calls.find((call) => call.method === "canvases.delete");
    expect(createCall).toBeTruthy();
    expect(deleteCall).toBeTruthy();
    expect(calls.indexOf(deleteCall!)).toBeGreaterThan(calls.indexOf(createCall!));
    expect(deleteCall?.args).toMatchObject({ canvas_id: "F0TRACE001" });
  });
});

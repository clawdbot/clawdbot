import { writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  GatewayClient,
  startGatewayClientWhenEventLoopReady,
} from "openclaw/plugin-sdk/gateway-runtime";
import { afterEach, describe, expect, it } from "vitest";
import {
  type MockOpenAiRequestSnapshot,
  startQaGatewayChild,
  startQaMockOpenAiServer,
} from "../../../../extensions/qa-lab/api.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const MODEL_REF = "mock-openai/gpt-5.6-luna";
const DISCORD_CHANNEL_ID = "789";
const DISCORD_MESSAGE_ID = "1000000000000000001";
const DISCORD_APPLICATION_ID = "123456789012345678";
const DISCORD_SESSION_KEY = `agent:qa:discord:channel:${DISCORD_CHANNEL_ID}`;
const INLINE_SESSION_KEY = "agent:qa:inline-widget-proof";
const INVENTORY_MARKER = "DISCORD_WIDGET_PRESENTER_INVENTORY";

type JsonRecord = Record<string, unknown>;
type DiscordRestRequest = { method: string; pathname: string; body?: JsonRecord };
type ToolsInvokeResult = {
  ok: boolean;
  source?: string;
  output?: { details?: JsonRecord };
  error?: { code?: string; message?: string };
};

async function readRequestBody(req: IncomingMessage): Promise<JsonRecord | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return undefined;
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as JsonRecord)
    : undefined;
}

function writeJson(res: ServerResponse, statusCode: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(statusCode, {
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json",
  });
  res.end(body);
}

async function startDiscordRestLoopback() {
  const requests: DiscordRestRequest[] = [];
  const server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      const method = req.method ?? "GET";
      const body = await readRequestBody(req);
      requests.push({ method, pathname, ...(body ? { body } : {}) });
      if (method === "GET" && pathname === `/api/v10/channels/${DISCORD_CHANNEL_ID}`) {
        writeJson(res, 200, { id: DISCORD_CHANNEL_ID, type: 0 });
        return;
      }
      if (method === "POST" && pathname === `/api/v10/channels/${DISCORD_CHANNEL_ID}/messages`) {
        writeJson(res, 200, { id: DISCORD_MESSAGE_ID, channel_id: DISCORD_CHANNEL_ID });
        return;
      }
      writeJson(res, 404, { message: `unexpected Discord REST request: ${method} ${pathname}` });
    } catch (error) {
      writeJson(res, 500, { message: error instanceof Error ? error.message : String(error) });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Discord REST loopback did not bind a TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    stop: async () =>
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function configureDiscordActivities(cfg: OpenClawConfig): OpenClawConfig {
  return {
    ...cfg,
    tools: {
      ...cfg.tools,
      alsoAllow: [...(cfg.tools?.alsoAllow ?? []), "show_widget"],
    },
  };
}

const discordTransport = {
  requiredPluginIds: ["discord"],
  createGatewayConfig: () => ({
    channels: {
      discord: {
        enabled: true,
        token: "qa-activities-token",
        applicationId: DISCORD_APPLICATION_ID,
        activities: {
          clientSecret: "qa-activities-client-secret",
          applicationId: DISCORD_APPLICATION_ID,
        },
      },
    },
  }),
};

async function writeDiscordFetchPreload(root: string): Promise<string> {
  const preloadPath = path.join(root, "discord-rest-preload.mjs");
  await writeFile(
    preloadPath,
    `const originalFetch = globalThis.fetch.bind(globalThis);
const loopbackBase = process.env.OPENCLAW_QA_DISCORD_REST_BASE;
if (!loopbackBase) throw new Error("OPENCLAW_QA_DISCORD_REST_BASE is required");
globalThis.fetch = async (input, init) => {
  const sourceUrl = new URL(input instanceof Request ? input.url : String(input));
  if (sourceUrl.origin === "https://discord.com" && sourceUrl.pathname.startsWith("/api/")) {
    const target = new URL(loopbackBase);
    target.pathname = sourceUrl.pathname;
    target.search = sourceUrl.search;
    return input instanceof Request
      ? await originalFetch(new Request(target, input), init)
      : await originalFetch(target, init);
  }
  return await originalFetch(input, init);
};
`,
    "utf8",
  );
  return preloadPath;
}

async function readMockRequests(baseUrl: string): Promise<MockOpenAiRequestSnapshot[]> {
  const response = await fetch(`${baseUrl}/debug/requests`);
  if (!response.ok) {
    throw new Error(`mock request log failed with HTTP ${response.status}`);
  }
  return (await response.json()) as MockOpenAiRequestSnapshot[];
}

function countToolDeclarations(value: unknown, name: string): number {
  if (Array.isArray(value)) {
    return value.reduce((sum, item) => sum + countToolDeclarations(item, name), 0);
  }
  if (!value || typeof value !== "object") {
    return 0;
  }
  const record = value as JsonRecord;
  const current = record.name === name && record.type === "function" ? 1 : 0;
  return current + countToolDeclarations(record.tools, name);
}

function findOpenWidgetButton(value: unknown): JsonRecord | undefined {
  if (Array.isArray(value)) {
    return value.map(findOpenWidgetButton).find(Boolean);
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as JsonRecord;
  if (record.label === "Open widget" && typeof record.custom_id === "string") {
    return record;
  }
  return Object.values(record).map(findOpenWidgetButton).find(Boolean);
}

async function postShowWidget(params: {
  gateway: Awaited<ReturnType<typeof startQaGatewayChild>>;
  accountId: string;
  messageChannel: string;
  messageTo: string;
}) {
  const response = await fetch(`${params.gateway.baseUrl}/tools/invoke`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${params.gateway.token}`,
      "content-type": "application/json",
      "x-openclaw-account-id": params.accountId,
      "x-openclaw-message-channel": params.messageChannel,
      "x-openclaw-message-to": params.messageTo,
    },
    body: JSON.stringify({
      tool: "show_widget",
      sessionKey: DISCORD_SESSION_KEY,
      args: { title: "Activity proof", widget_code: "<button>Proof</button>" },
    }),
  });
  return { status: response.status, body: (await response.json()) as JsonRecord };
}

async function connectInlineClient(
  gateway: Awaited<ReturnType<typeof startQaGatewayChild>>,
): Promise<GatewayClient> {
  let resolveConnected!: () => void;
  let rejectConnected!: (error: Error) => void;
  const connected = new Promise<void>((resolve, reject) => {
    resolveConnected = resolve;
    rejectConnected = reject;
  });
  const client = new GatewayClient({
    url: gateway.wsUrl,
    token: gateway.token,
    clientName: "gateway-client",
    deviceIdentity: null,
    mode: "backend",
    scopes: ["operator.admin"],
    caps: ["inline-widgets"],
    requestTimeoutMs: 20_000,
    onHelloOk: resolveConnected,
    onConnectError: rejectConnected,
  });
  client.start();
  const readiness = await startGatewayClientWhenEventLoopReady(client, { timeoutMs: 20_000 });
  if (!readiness.ready) {
    await client.stopAndWait().catch(() => undefined);
    throw new Error("inline Gateway client event loop did not become ready");
  }
  await connected;
  return client;
}

describe("Discord show_widget contextual presenter process proof", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    const errors: unknown[] = [];
    for (const cleanup of cleanups.splice(0).toReversed()) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "Discord show_widget process proof cleanup failed");
    }
  });

  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it(
    "routes one core tool through Discord and keeps mismatched and inline paths honest",
    { timeout: 180_000 },
    async () => {
      process.stdout.write("[discord-widget-e2e] starting isolated Gateway proof\n");
      const progress = setInterval(() => {
        process.stdout.write("[discord-widget-e2e] Gateway proof still running\n");
      }, 10_000);
      progress.unref();
      cleanups.push(async () => clearInterval(progress));
      const scratch = tempDirs.make("openclaw-discord-widget-e2e-");
      const discord = await startDiscordRestLoopback();
      cleanups.push(() => discord.stop());
      const preloadPath = await writeDiscordFetchPreload(scratch);
      const mock = await startQaMockOpenAiServer();
      cleanups.push(() => mock.stop());
      const gateway = await startQaGatewayChild({
        repoRoot: REPO_ROOT,
        useRepoCli: true,
        providerBaseUrl: `${mock.baseUrl}/v1`,
        providerMode: "mock-openai",
        primaryModel: MODEL_REF,
        alternateModel: MODEL_REF,
        transport: discordTransport,
        transportBaseUrl: "http://127.0.0.1:9",
        controlUiEnabled: false,
        mutateConfig: configureDiscordActivities,
        runtimeEnvPatch: {
          DISCORD_BOT_TOKEN: "qa-activities-token",
          NODE_OPTIONS: `--import=${pathToFileURL(preloadPath).href}`,
          OPENCLAW_QA_DISCORD_REST_BASE: discord.baseUrl,
          OPENCLAW_SKIP_CANVAS_HOST: undefined,
          OPENCLAW_SKIP_CHANNELS: "1",
        },
      });
      cleanups.push(() => gateway.stop());

      const started = (await gateway.call("chat.send", {
        sessionKey: DISCORD_SESSION_KEY,
        message: `${INVENTORY_MARKER}: reply exactly INVENTORY_OK without calling tools.`,
        originatingChannel: "discord",
        originatingTo: `channel:${DISCORD_CHANNEL_ID}`,
        originatingAccountId: "default",
        deliver: false,
        idempotencyKey: "discord-widget-inventory",
      })) as { runId?: string; status?: string };
      expect(started.status).toBe("started");
      expect(started.runId).toBeTruthy();
      await expect(
        gateway.call(
          "agent.wait",
          { runId: started.runId, timeoutMs: 60_000 },
          { timeoutMs: 65_000 },
        ),
      ).resolves.toMatchObject({ status: "ok" });

      const request = (await readMockRequests(mock.baseUrl)).find((entry) =>
        entry.allInputText.includes(INVENTORY_MARKER),
      );
      expect(request, gateway.logs()).toBeDefined();
      expect(
        countToolDeclarations([request?.body.tools, request?.body.dynamicTools], "show_widget"),
        gateway.logs(),
      ).toBe(1);

      const presented = await postShowWidget({
        gateway,
        accountId: "default",
        messageChannel: "discord",
        messageTo: `channel:${DISCORD_CHANNEL_ID}`,
      });
      expect(presented.status, JSON.stringify(presented.body)).toBe(200);
      expect(presented.body).toMatchObject({
        ok: true,
        result: {
          details: {
            kind: "widget",
            presentation: {
              target: "current_channel",
              receipt: {
                primaryPlatformMessageId: DISCORD_MESSAGE_ID,
                parts: [expect.objectContaining({ kind: "card" })],
              },
            },
          },
        },
      });
      const post = discord.requests.find((entry) => entry.method === "POST");
      expect(discord.requests.map(({ method, pathname }) => ({ method, pathname }))).toEqual([
        { method: "GET", pathname: `/api/v10/channels/${DISCORD_CHANNEL_ID}` },
        { method: "POST", pathname: `/api/v10/channels/${DISCORD_CHANNEL_ID}/messages` },
      ]);
      expect(post?.body).toMatchObject({ enforce_nonce: true });
      const button = findOpenWidgetButton(post?.body);
      expect(button).toMatchObject({ label: "Open widget" });
      expect(button?.custom_id).toMatch(/^ocactivity1_[A-Za-z0-9_-]{22}$/u);

      const postsAfterSuccess = discord.requests.filter((entry) => entry.method === "POST").length;
      for (const mismatch of [
        {
          accountId: "missing",
          messageChannel: "discord",
          messageTo: `channel:${DISCORD_CHANNEL_ID}`,
        },
        { accountId: "default", messageChannel: "discord", messageTo: "user:789" },
        {
          accountId: "default",
          messageChannel: "slack",
          messageTo: `channel:${DISCORD_CHANNEL_ID}`,
        },
      ]) {
        const hidden = await postShowWidget({ gateway, ...mismatch });
        expect(hidden.status, JSON.stringify({ mismatch, hidden: hidden.body })).toBe(404);
      }
      expect(discord.requests.filter((entry) => entry.method === "POST")).toHaveLength(
        postsAfterSuccess,
      );

      const inlineClient = await connectInlineClient(gateway);
      cleanups.push(() => inlineClient.stopAndWait());
      const inline = await inlineClient.request<ToolsInvokeResult>("tools.invoke", {
        name: "show_widget",
        sessionKey: INLINE_SESSION_KEY,
        args: { title: "Inline proof", widget_code: "<p>inline</p>" },
      });
      expect(inline).toMatchObject({
        ok: true,
        source: "core",
        output: {
          details: {
            kind: "canvas",
            presentation: { target: "assistant_message" },
            view: { url: expect.stringContaining("/__openclaw__/canvas/documents/") },
          },
        },
      });
      expect(discord.requests.filter((entry) => entry.method === "POST")).toHaveLength(
        postsAfterSuccess,
      );
    },
  );
});

import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
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
  createQaGatewayChild,
  type QaGatewayChild,
  startQaMockOpenAiServer,
} from "../../../../extensions/qa-lab/api.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const MODEL_REF = "mock-openai/gpt-5.6-luna";
const DISCORD_CHANNEL_ID = "789";
const DISCORD_MESSAGE_ID = "1000000000000000001";
const DISCORD_APPLICATION_ID = "123456789012345678";
const DISCORD_COMPONENTS_V2_FLAG = 1 << 15;
const DISCORD_SESSION_KEY = `agent:qa:discord:channel:${DISCORD_CHANNEL_ID}`;
const INLINE_SESSION_KEY = "agent:qa:inline-widget-proof";
const INVENTORY_MARKER = "DISCORD_WIDGET_PRESENTER_INVENTORY";

type JsonRecord = Record<string, unknown>;
type DiscordRestRequest = {
  method: string;
  pathname: string;
  body?: JsonRecord;
  files?: Array<{ field: string; name: string; type: string; base64: string }>;
};
type ToolsInvokeResult = {
  ok: boolean;
  source?: string;
  output?: { details?: JsonRecord };
  error?: { code?: string; message?: string };
};

async function readRequestBody(
  req: IncomingMessage,
): Promise<Pick<DiscordRestRequest, "body" | "files">> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {};
  }
  const raw = Buffer.concat(chunks);
  const contentType = req.headers["content-type"] ?? "";
  if (contentType.startsWith("multipart/form-data;")) {
    const form = await new Response(raw, {
      headers: { "content-type": contentType },
    }).formData();
    const files: NonNullable<DiscordRestRequest["files"]> = [];
    for (const [field, value] of form) {
      if (typeof value !== "string") {
        files.push({
          field,
          name: value.name,
          type: value.type,
          base64: Buffer.from(await value.arrayBuffer()).toString("base64"),
        });
      }
    }
    const payloadJson = form.get("payload_json");
    if (typeof payloadJson !== "string") {
      throw new Error("Discord multipart request did not contain string payload_json");
    }
    return { body: JSON.parse(payloadJson) as JsonRecord, files };
  }
  const parsed = JSON.parse(raw.toString("utf8")) as unknown;
  return {
    body:
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as JsonRecord)
        : undefined,
  };
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
  const server = createServer((req, res) => {
    void (async () => {
      const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      const method = req.method ?? "GET";
      const payload = await readRequestBody(req);
      requests.push({ method, pathname, ...payload });
      if (method === "GET" && pathname === `/api/v10/channels/${DISCORD_CHANNEL_ID}`) {
        writeJson(res, 200, { id: DISCORD_CHANNEL_ID, type: 0 });
        return;
      }
      if (method === "POST" && pathname === `/api/v10/channels/${DISCORD_CHANNEL_ID}/messages`) {
        writeJson(res, 200, { id: DISCORD_MESSAGE_ID, channel_id: DISCORD_CHANNEL_ID });
        return;
      }
      writeJson(res, 404, { message: `unexpected Discord REST request: ${method} ${pathname}` });
    })().catch((error: unknown) => {
      writeJson(res, 500, { message: error instanceof Error ? error.message : String(error) });
    });
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
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
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
  gateway: QaGatewayChild;
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

async function connectInlineClient(gateway: QaGatewayChild): Promise<GatewayClient> {
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
    "preserves component attachment filenames through the public Gateway message action",
    { timeout: 180_000 },
    async () => {
      const head = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
      }).trim();
      expect(head).toMatch(/^[0-9a-f]{40}$/);
      // A prebuilt entrypoint alone does not prove which source produced it.
      for (const [file, field] of [
        [".buildstamp", "head"],
        [".runtime-postbuildstamp", "head"],
        ["build-info.json", "commit"],
      ] as const) {
        const metadata = JSON.parse(
          await readFile(path.join(REPO_ROOT, "dist", file), "utf8"),
        ) as JsonRecord;
        expect(metadata[field], `dist/${file} source revision`).toBe(head);
      }
      process.stdout.write(
        `${JSON.stringify({ proof: "discord-gateway-built-revision", head })}\n`,
      );
      const scratch = tempDirs.make("openclaw-discord-attachment-e2e-");
      const discord = await startDiscordRestLoopback();
      cleanups.push(() => discord.stop());
      const preloadPath = await writeDiscordFetchPreload(scratch);
      const mock = await startQaMockOpenAiServer();
      cleanups.push(() => mock.stop());
      const gatewayOwner = createQaGatewayChild();
      cleanups.push(() => stopQaGatewayFixture(gatewayOwner));
      const gateway = await gatewayOwner.start({
        repoRoot: REPO_ROOT,
        command: {
          executablePath: process.execPath,
          argsPrefix: [path.join(REPO_ROOT, "dist", "entry.js")],
          cwd: REPO_ROOT,
          usePackagedPlugins: true,
        },
        providerBaseUrl: `${mock.baseUrl}/v1`,
        providerMode: "mock-openai",
        primaryModel: MODEL_REF,
        alternateModel: MODEL_REF,
        transport: discordTransport,
        transportBaseUrl: "http://127.0.0.1:9",
        controlUiEnabled: false,
        mutateConfig: (cfg) => ({
          ...cfg,
          // Public message actions do not need QA Lab's private runtime tools.
          plugins: {
            ...cfg.plugins,
            allow: cfg.plugins?.allow?.filter((id) => id !== "qa-lab"),
            entries: Object.fromEntries(
              Object.entries(cfg.plugins?.entries ?? {}).filter(([id]) => id !== "qa-lab"),
            ),
          },
          tools: { ...cfg.tools, alsoAllow: [...(cfg.tools?.alsoAllow ?? []), "message"] },
        }),
        runtimeEnvPatch: {
          DISCORD_BOT_TOKEN: "qa-activities-token",
          NODE_OPTIONS: `--import=${pathToFileURL(preloadPath).href}`,
          OPENCLAW_QA_DISCORD_REST_BASE: discord.baseUrl,
          OPENCLAW_SKIP_CHANNELS: "1",
        },
      });
      const invokeAction = async (label: string, args: JsonRecord) => {
        const before = discord.requests.length;
        const response = await fetch(`${gateway.baseUrl}/tools/invoke`, {
          method: "POST",
          signal: AbortSignal.timeout(20_000),
          headers: {
            authorization: `Bearer ${gateway.token}`,
            "content-type": "application/json",
            "x-openclaw-account-id": "default",
            "x-openclaw-message-channel": "discord",
            "x-openclaw-message-to": `channel:${DISCORD_CHANNEL_ID}`,
          },
          body: JSON.stringify({
            tool: "message",
            sessionKey: DISCORD_SESSION_KEY,
            args: {
              action: "send",
              channel: "discord",
              target: `channel:${DISCORD_CHANNEL_ID}`,
              ...args,
            },
          }),
        });
        const result = (await response.json()) as JsonRecord;
        expect(response.status, JSON.stringify(result)).toBe(200);
        expect(result).toMatchObject({ ok: true });
        expect(result).not.toHaveProperty("result.isError", true);
        const writes = discord.requests
          .slice(before)
          .filter((request) => request.method === "POST" || request.method === "PATCH");
        expect(
          writes.map(({ method, pathname }) => ({ method, pathname })),
          label,
        ).toEqual([
          { method: "POST", pathname: `/api/v10/channels/${DISCORD_CHANNEL_ID}/messages` },
        ]);
        process.stdout.write(
          `${JSON.stringify({
            proof: "gateway-discord-message-action",
            action: args.action ?? "send",
            case: label,
            writes,
          })}\n`,
        );
        return { result, writes };
      };
      const invokeMessage = async (label: string, args: JsonRecord) => {
        const { result, writes } = await invokeAction(label, args);
        expect(result).toMatchObject({
          ok: true,
          result: {
            details: {
              channel: "discord",
              deliveryStatus: "sent",
              messageDelivery: {
                status: "settled",
                primaryPlatformMessageId: DISCORD_MESSAGE_ID,
                partialDelivery: false,
                createdThreadIds: [],
              },
            },
          },
        });
        return writes[0];
      };
      const media = path.join(gateway.workspaceDir, "source.pdf");
      const bytes = Buffer.from("%PDF-1.4\nDiscord attachment filename proof\n%%EOF\n");
      await writeFile(media, bytes);
      const cases = [
        { label: "declared", declared: true, expected: "report.pdf" },
        { label: "blank override", declared: true, filename: "  ", expected: "report.pdf" },
        {
          label: "explicit override",
          declared: true,
          filename: " operator.pdf ",
          expected: "operator.pdf",
        },
        { label: "media-derived", declared: false, expected: "source.pdf" },
        { label: "components V2", declared: true, v2: true, expected: "report.pdf" },
      ];
      for (const testCase of cases) {
        const post = await invokeMessage(testCase.label, {
          message: `Attachment proof: ${testCase.label}`,
          media,
          filename: testCase.filename,
          components: {
            blocks: testCase.declared ? [{ type: "file", file: "attachment://report.pdf" }] : [],
            ...(testCase.v2 ? { container: { accentColor: 0x123456 } } : {}),
          },
        });
        expect(post?.files).toEqual([
          {
            field: "files[0]",
            name: testCase.expected,
            type: "application/pdf",
            base64: bytes.toString("base64"),
          },
        ]);
        expect(post?.body?.attachments).toEqual([{ id: 0, filename: testCase.expected }]);
        expect(Boolean(Number(post?.body?.flags ?? 0) & DISCORD_COMPONENTS_V2_FLAG)).toBe(
          testCase.v2 === true,
        );
        process.stdout.write(
          `${JSON.stringify({
            proof: "gateway-message-action-to-discord-multipart",
            case: testCase.label,
            files: post?.files,
            attachments: post?.body?.attachments,
            componentsV2: testCase.v2 === true,
          })}\n`,
        );
      }

      for (const testCase of [
        {
          label: "canonical body",
          args: { message: "    canonical body" },
          expected: "    canonical body",
        },
        {
          label: "raw reasoning tag alias",
          args: { text: "<think>private</think>    tag body" },
          expected: "    tag body",
        },
        {
          label: "mixed reasoning preamble alias",
          args: { text: "<think>private</think>\nThinking\n_summary_\n    mixed body" },
          expected: "    mixed body",
        },
        {
          label: "fenced literal tag control",
          args: { message: "```\n    <think>literal</think>\n```" },
          expected: "```\n    <think>literal</think>\n```",
        },
      ]) {
        const post = await invokeMessage(testCase.label, testCase.args);
        expect(post?.files, testCase.label).toBeUndefined();
        process.stdout.write(
          `${JSON.stringify({
            proof: "gateway-message-action-to-discord-text",
            case: testCase.label,
            content: post?.body?.content,
          })}\n`,
        );
        expect.soft(post?.body?.content, testCase.label).toBe(testCase.expected);
      }

      const caption = await invokeMessage("caption fallback", {
        message: " \n ",
        caption: "    caption body  ",
        media,
      });
      expect(caption?.files).toEqual([
        {
          field: "files[0]",
          name: "source.pdf",
          type: "application/pdf",
          base64: bytes.toString("base64"),
        },
      ]);
      // Core reply normalization trims the suffix before Discord delivery.
      expect.soft(caption?.body?.content).toBe("    caption body");

      const classic = await invokeMessage("classic component file body", {
        message: "    classic component body  ",
        media,
        components: { blocks: [{ type: "file", file: "attachment://report.pdf" }] },
      });
      expect(classic?.files).toEqual([
        {
          field: "files[0]",
          name: "report.pdf",
          type: "application/pdf",
          base64: bytes.toString("base64"),
        },
      ]);
      expect.soft(classic?.body?.content).toBe("    classic component body");

      const componentText = await invokeMessage("explicit Components V2 body fields", {
        message: "fallback",
        components: {
          text: "    top-level body  ",
          container: { accentColor: 0x123456 },
          blocks: [
            { type: "text", text: "    text-block body  " },
            {
              type: "section",
              text: "    section body  ",
              accessory: {
                type: "button",
                button: { label: " Read ", style: "link", url: "https://example.com/section" },
              },
            },
            {
              type: "section",
              texts: ["    first body  ", "    second body  "],
              accessory: {
                type: "button",
                button: { label: " Read ", style: "link", url: "https://example.com/texts" },
              },
            },
          ],
        },
      });
      expect(componentText?.body?.flags).toBe(DISCORD_COMPONENTS_V2_FLAG);
      expect.soft(componentText?.body?.components).toMatchObject([
        {
          type: 17,
          components: [
            { type: 10, content: "    top-level body  " },
            { type: 10, content: "    text-block body  " },
            {
              type: 9,
              components: [{ type: 10, content: "    section body  " }],
              accessory: { label: "Read" },
            },
            {
              type: 9,
              components: [
                { type: 10, content: "    first body  " },
                { type: 10, content: "    second body  " },
              ],
              accessory: { label: "Read" },
            },
          ],
        },
      ]);

      const poll = await invokeAction("poll", {
        action: "poll",
        message: "    poll body  ",
        pollQuestion: " Lunch? ",
        pollOption: [" Pizza ", " Sushi "],
        pollDurationHours: 2,
        silent: true,
      });
      expect(poll.result).toMatchObject({
        result: {
          details: {
            channel: "discord",
            via: "direct",
            result: { messageId: DISCORD_MESSAGE_ID },
          },
        },
      });
      expect(poll.writes[0]?.body).toMatchObject({
        flags: (1 << 12) | (1 << 2),
        poll: {
          question: { text: "Lunch?" },
          answers: [{ poll_media: { text: "Pizza" } }, { poll_media: { text: "Sushi" } }],
          duration: 2,
          allow_multiselect: false,
          layout_type: 1,
        },
      });
      expect.soft(poll.writes[0]?.body?.content).toBe("    poll body  ");
    },
  );

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
      const gatewayOwner = createQaGatewayChild();
      cleanups.push(() => stopQaGatewayFixture(gatewayOwner));
      const gateway = await gatewayOwner.start({
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

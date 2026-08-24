import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { startQaGatewayChild, startQaMockOpenAiServer } from "../../../qa-lab/api.js";
import { ChannelType, type Client } from "../internal/discord.js";
import { RequestClient, type RequestClientOptions } from "../internal/rest.js";
import { resolveDiscordThreadStarter } from "../monitor/threading.js";

const DISCORD_TOKEN = "qa-discord-proof-token";
const DISCORD_APPLICATION_ID = "123456789012345678";

type DiscordCall = { method: string; path: string; status: number };

async function drainRequest(req: IncomingMessage): Promise<void> {
  for await (const chunk of req) {
    // The production RequestClient may send a body for other methods.
    void chunk;
  }
}

function writeJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function startDiscordApi() {
  const calls: DiscordCall[] = [];
  let missingRequestCount = 0;
  let releaseFirstMissingRequest!: () => void;
  let markFirstMissingRequestStarted!: () => void;
  const firstMissingRequestStarted = new Promise<void>((resolve) => {
    markFirstMissingRequestStarted = resolve;
  });
  const firstMissingRequestRelease = new Promise<void>((resolve) => {
    releaseFirstMissingRequest = resolve;
  });
  const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
    await drainRequest(req);
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const method = req.method ?? "GET";
    const pathname = requestUrl.pathname;
    const missingPath = "/api/v10/channels/parent-missing/messages/thread-missing";
    const validPath = "/api/v10/channels/parent-valid/messages/thread-valid";
    if (method === "GET" && pathname === missingPath) {
      missingRequestCount += 1;
      calls.push({ method, path: pathname, status: 404 });
      if (missingRequestCount === 1) {
        markFirstMissingRequestStarted();
        await firstMissingRequestRelease;
      }
      writeJson(res, 404, { message: "Unknown Message", code: 10008 });
      return;
    }
    if (method === "GET" && pathname === validPath) {
      calls.push({ method, path: pathname, status: 200 });
      writeJson(res, 200, {
        id: "thread-valid",
        channel_id: "parent-valid",
        content: "Real Discord starter",
        author: { id: "author-1", username: "qa-author", discriminator: "0" },
        attachments: [],
        embeds: [],
        sticker_items: [],
      });
      return;
    }
    calls.push({ method, path: pathname, status: 404 });
    writeJson(res, 404, { message: `unexpected Discord REST request: ${method} ${pathname}` });
  };
  const server = createServer((req, res) => {
    void handleRequest(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Discord proof API did not bind a TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/api`,
    calls,
    firstMissingRequestStarted,
    releaseFirstMissingRequest: () => releaseFirstMissingRequest(),
    stop: async () =>
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      }),
  };
}

function createRest(baseUrl: string): RequestClient {
  const options: RequestClientOptions = {
    baseUrl,
    queueRequests: false,
    timeout: 5_000,
  };
  return new RequestClient(DISCORD_TOKEN, options);
}

async function runGatewayProof(
  gateway: Awaited<ReturnType<typeof startQaGatewayChild>>,
  providerBaseUrl: string,
): Promise<number> {
  const started = (await gateway.call("chat.send", {
    sessionKey: "agent:qa:discord-thread-starter-proof",
    message: "Discord thread starter Gateway proof. Reply exactly DISCORD_GATEWAY_OK.",
    deliver: false,
    idempotencyKey: "discord-thread-starter-gateway-proof",
  })) as { runId?: string; status?: string };
  if (started.status !== "started" || !started.runId) {
    throw new Error(`QA Gateway chat.send did not start: ${JSON.stringify(started)}`);
  }
  const terminal = (await gateway.call(
    "agent.wait",
    { runId: started.runId, timeoutMs: 30_000 },
    { timeoutMs: 35_000 },
  )) as { status?: string };
  if (terminal.status !== "ok") {
    throw new Error(`QA Gateway agent.wait failed: ${JSON.stringify(terminal)}`);
  }
  const response = await fetch(`${providerBaseUrl}/debug/requests`);
  if (!response.ok) {
    throw new Error(`mock provider debug endpoint failed: ${response.status}`);
  }
  return ((await response.json()) as unknown[]).length;
}

function resolverParams(params: {
  rest: RequestClient;
  accountId: string;
  threadId: string;
  parentId?: string;
  parentType?: ChannelType;
}) {
  return {
    channel: { id: params.threadId },
    client: { rest: params.rest } as unknown as Client,
    accountId: params.accountId,
    parentId: params.parentId,
    parentType: params.parentType ?? ChannelType.GuildText,
    resolveTimestampMs: () => undefined,
  };
}

console.log("proof: starting Discord-owned Gateway/REST harness");
const api = await startDiscordApi();
const mock = await startQaMockOpenAiServer();
const workspace = await mkdtemp(path.join(os.tmpdir(), "openclaw-discord-thread-starter-proof-"));
let gateway: Awaited<ReturnType<typeof startQaGatewayChild>> | undefined;
const restClients: RequestClient[] = [];
try {
  gateway = await startQaGatewayChild({
    repoRoot: path.resolve(import.meta.dirname, "../../../.."),
    useRepoCli: true,
    providerBaseUrl: `${mock.baseUrl}/v1`,
    transportBaseUrl: "http://127.0.0.1:9",
    transport: {
      requiredPluginIds: ["discord"],
      createGatewayConfig: () => ({
        channels: {
          discord: {
            enabled: true,
            token: DISCORD_TOKEN,
            applicationId: DISCORD_APPLICATION_ID,
          },
        },
      }),
    },
    controlUiEnabled: false,
    runtimeEnvPatch: {
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_PROVIDERS: undefined,
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      DISCORD_BOT_TOKEN: undefined,
    },
    mutateConfig: (cfg) => {
      cfg.agents!.defaults!.workspace = workspace;
      return cfg;
    },
  });
  console.log("proof: Gateway ready; exercising production RequestClient path");
  const providerRequests = await runGatewayProof(gateway, mock.baseUrl);
  const rest = createRest(api.baseUrl);
  const secondAccountRest = createRest(api.baseUrl);
  restClients.push(rest, secondAccountRest);

  const missingFirstPromise = resolveDiscordThreadStarter(
    resolverParams({
      rest,
      accountId: "proof-account-a",
      threadId: "thread-missing",
      parentId: "parent-missing",
    }),
  );
  await api.firstMissingRequestStarted;
  const missingSecondPromise = resolveDiscordThreadStarter(
    resolverParams({
      rest,
      accountId: "proof-account-a",
      threadId: "thread-missing",
      parentId: "parent-missing",
    }),
  );
  api.releaseFirstMissingRequest();
  const [missingFirst, missingSecond] = await Promise.all([
    missingFirstPromise,
    missingSecondPromise,
  ]);
  const sameAccountMissingGets = api.calls.filter((call) =>
    call.path.endsWith("parent-missing/messages/thread-missing"),
  ).length;
  const missingSameThreadOtherAccount = await resolveDiscordThreadStarter(
    resolverParams({
      rest: secondAccountRest,
      accountId: "proof-account-b",
      threadId: "thread-missing",
      parentId: "parent-missing",
    }),
  );
  const metadataMissingResult = resolveDiscordThreadStarter(
    resolverParams({
      rest,
      accountId: "proof-account-a",
      threadId: "thread-missing-metadata",
      parentType: ChannelType.GuildText,
    }),
  );
  const metadataAwareResult = resolveDiscordThreadStarter(
    resolverParams({
      rest,
      accountId: "proof-account-a",
      threadId: "thread-missing-metadata",
      parentId: "parent-missing",
      parentType: ChannelType.GuildText,
    }),
  );
  const [metadataMissing, metadataAware] = await Promise.all([
    metadataMissingResult,
    metadataAwareResult,
  ]);
  const metadataAwareGets = api.calls.filter((call) =>
    call.path.endsWith("parent-missing/messages/thread-missing-metadata"),
  );
  const missingGets = api.calls.filter((call) =>
    call.path.endsWith("parent-missing/messages/thread-missing"),
  );

  const validFirst = await resolveDiscordThreadStarter(
    resolverParams({
      rest,
      accountId: "proof-account-a",
      threadId: "thread-valid",
      parentId: "parent-valid",
    }),
  );
  const validSecond = await resolveDiscordThreadStarter(
    resolverParams({
      rest,
      accountId: "proof-account-a",
      threadId: "thread-valid",
      parentId: "parent-valid",
    }),
  );
  const validGets = api.calls.filter((call) =>
    call.path.endsWith("parent-valid/messages/thread-valid"),
  );
  const passed =
    providerRequests > 0 &&
    missingFirst === null &&
    missingSecond === null &&
    missingSameThreadOtherAccount === null &&
    sameAccountMissingGets === 1 &&
    missingGets.length === 2 &&
    metadataMissing === null &&
    metadataAware === null &&
    metadataAwareGets.length === 1 &&
    validFirst?.text === "Real Discord starter" &&
    validSecond?.text === "Real Discord starter" &&
    validGets.length === 1;
  console.log(
    JSON.stringify(
      {
        verdict: passed ? "PASS" : "FAIL",
        gateway: { started: true, providerRequests },
        productionEntry:
          "resolveDiscordThreadStarter -> getChannelMessage -> RequestClient -> Discord REST API",
        missingStarter: {
          firstResult: missingFirst,
          secondResult: missingSecond,
          sameAccountDiscordGetCalls: sameAccountMissingGets,
          accountScopedOtherAccountGetCalls: 1,
          totalDiscordGetCalls: missingGets.length,
        },
        metadataFailure: {
          missingMetadataResult: metadataMissing,
          metadataAwareResult: metadataAware,
          discordGetCalls: metadataAwareGets.length,
        },
        validStarter: {
          firstText: validFirst?.text,
          secondText: validSecond?.text,
          discordGetCalls: validGets.length,
        },
        restTrace: api.calls.map(({ method, path: requestPath, status }) => ({
          method,
          path: requestPath,
          status,
        })),
      },
      null,
      2,
    ),
  );
  if (!passed) {
    process.exitCode = 1;
  }
} finally {
  for (const rest of restClients) {
    rest.abortAllRequests();
  }
  await gateway?.stop().catch(() => undefined);
  await mock.stop().catch(() => undefined);
  await api.stop().catch(() => undefined);
  await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
}

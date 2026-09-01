import { createHash } from "node:crypto";
import { createServer, request as httpRequest, type ServerResponse } from "node:http";
import path from "node:path";
import { expect, test } from "vitest";
import {
  startQaMockOpenAiServer,
  type MockOpenAiRequestSnapshot,
} from "../extensions/qa-lab/api.js";
import { listConversations } from "../src/config/sessions/conversation-registry.js";
import { connectGatewayClient, disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";

async function runAccountHistoryProof(compactionMode: "client" | "server-endpoint") {
  const model = await startQaMockOpenAiServer({ modelRefs: ["history-proof/history-proof"] });
  const replies: string[] = [];
  const compactRequests: string[] = [];
  const checkpoint = (generation: number) => ({
    type: "compaction",
    id: `cmp_history_${generation}`,
    encrypted_content: `HISTORY_ENDPOINT_CHECKPOINT_${generation}`,
    created_by: `history-proof-${generation}`,
  });
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  let poll: ServerResponse | undefined;
  const respond = (response: ServerResponse, result: unknown) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, result }));
  };
  const transport = createServer((request, response) => {
    if (request.url?.startsWith("/v1/") && request.url !== "/v1/responses/compact") {
      const upstream = httpRequest(
        new URL(request.url, model.baseUrl),
        {
          method: request.method,
          headers: request.headers,
        },
        (incoming) => {
          response.writeHead(incoming.statusCode ?? 500, incoming.headers);
          incoming.pipe(response);
        },
      );
      upstream.on("error", (error) => response.writeHead(502).end(String(error)));
      request.pipe(upstream);
      return;
    }
    void (async () => {
      const method = request.url?.split("/").at(-1);
      if (method === "getUpdates") {
        poll = response;
        response.on("close", () => {
          if (poll === response) poll = undefined;
        });
        return;
      }
      if (method === "getMe") {
        respond(response, {
          id: 424242,
          is_bot: true,
          first_name: "History",
          username: "history_proof_bot",
        });
        return;
      }
      let raw = "";
      for await (const chunk of request) raw += chunk;
      if (request.url === "/v1/responses/compact") {
        compactRequests.push(raw);
        response.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            object: "response.compaction",
            output: [checkpoint(compactRequests.length)],
            usage: { input_tokens: 1000, output_tokens: 50 },
          }),
        );
        return;
      }
      const body = raw ? (JSON.parse(raw) as { text?: string; chat_id?: number }) : {};
      if (method === "sendMessage") {
        replies.push(body.text ?? "");
        respond(response, {
          message_id: replies.length + 100,
          date: Math.floor(Date.now() / 1000),
          chat: { id: body.chat_id, type: "private" },
          text: body.text,
        });
        return;
      }
      respond(response, true);
    })().catch((error: unknown) => {
      response.writeHead(500).end(String(error));
    });
  });
  await new Promise<void>((resolve) => transport.listen(0, "127.0.0.1", resolve));
  const address = transport.address();
  if (!address || typeof address === "string") throw new Error("Telegram fixture did not bind");
  const instance = await createOpenClawTestInstance({
    name: "account-history",
    config: {
      plugins: { slots: { memory: "none" } },
      agents: {
        defaults: {
          heartbeat: { every: "0m" },
          model: { primary: "history-proof/history-proof" },
          models: {
            "history-proof/history-proof": {
              agentRuntime: { id: "openclaw" },
              ...(compactionMode === "server-endpoint"
                ? { params: { responsesCompactEndpoint: true } }
                : {}),
            },
          },
          skipBootstrap: true,
          skills: [],
          compaction: {
            mode: "default",
            keepRecentTokens: 1,
            recentTurnsPreserve: 0,
            memoryFlush: { enabled: false },
          },
        },
      },
      tools: { profile: "minimal" },
      messages: { visibleReplies: "automatic" },
      session: {
        dmScope: "per-channel-peer",
        identityLinks: { "direct:peer": ["telegram:123"] },
      },
      channels: {
        telegram: {
          enabled: true,
          defaultAccount: "direct",
          apiRoot: `http://127.0.0.1:${address.port}`,
          dmHistoryLimit: 20,
          commands: { native: false, nativeSkills: false },
          streaming: { mode: "off" },
          accounts: {
            direct: {
              botToken: "424242:TEST_TOKEN_PLACEHOLDER_FOR_LOCAL_GATEWAY",
              dmPolicy: "allowlist",
              allowFrom: ["123"],
              dmHistoryLimit: 10,
              // Telegram's channel context uses the native ID; the embedded
              // transcript historically uses the linked session peer.
              dms: {
                "123": { historyLimit: 2 },
                "direct:peer": { historyLimit: 2 },
                peer: { historyLimit: 6 },
              },
            },
          },
        },
      },
      models: {
        mode: "replace",
        providers: {
          "history-proof": {
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            apiKey: "test-token-placeholder",
            api: "openai-responses",
            request: { allowPrivateNetwork: true },
            models: [
              {
                id: "history-proof",
                name: "History proof",
                api: "openai-responses",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000,
                maxTokens: 4096,
              },
            ],
          },
        },
      },
    },
    env: {
      OPENCLAW_SKIP_CHANNELS: undefined,
      OPENCLAW_SKIP_PROVIDERS: undefined,
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      TELEGRAM_BOT_TOKEN: undefined,
    },
  });
  let client: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
  try {
    await instance.startGateway();
    const sendTurn = async (turn: number) => {
      await expect.poll(() => Boolean(poll), { timeout: 30000 }).toBe(true);
      const currentPoll = poll!;
      poll = undefined;
      respond(currentPoll, [
        {
          update_id: turn,
          message: {
            message_id: turn,
            date: Math.floor(Date.now() / 1000),
            from: { id: 123, is_bot: false, first_name: "Fixture" },
            chat: { id: 123, type: "private", first_name: "Fixture" },
            text: `HISTORY_TURN_${turn}. Reply exactly: ACK_${turn}`,
          },
        },
      ]);
      await expect
        .poll(() => replies.some((reply) => reply.includes(`ACK_${turn}`)), { timeout: 30000 })
        .toBe(true);
    };
    for (let turn = 1; turn <= 6; turn++) await sendTurn(turn);
    const requests = async () =>
      (await fetch(`${model.baseUrl}/debug/requests`).then((response) =>
        response.json(),
      )) as MockOpenAiRequestSnapshot[];
    const prompt = (await requests()).findLast(
      (request) => request.requestKind === "agent-initial",
    )!;
    expect(prompt.allInputText).toContain("HISTORY_TURN_6");
    expect(prompt.allInputText).not.toContain("HISTORY_TURN_1");
    expect(prompt.allInputText).not.toContain("HISTORY_TURN_2");
    client = await connectGatewayClient({
      url: instance.url,
      token: instance.gatewayToken,
      role: "operator",
      scopes: ["operator.admin", "operator.read", "operator.write"],
    });
    const key = "agent:main:telegram:direct:direct:peer";
    const listed = await client.request<{ sessions: Array<{ key: string; sessionId: string }> }>(
      "sessions.list",
      { limit: 20 },
    );
    const session = listed.sessions.find((entry) => entry.key === key);
    expect(session).toBeDefined();
    const conversation = listConversations({
      agentId: "main",
      storePath: path.join(instance.state.agentDir("main"), "openclaw-agent.sqlite"),
    }).find(
      (entry) =>
        entry.sessionKey === key &&
        entry.sessionId === session!.sessionId &&
        entry.role === "primary",
    );
    expect(conversation).toMatchObject({
      accountId: "direct",
      kind: "direct",
      routeContext: { peerId: "123" },
    });
    const compacted = await client.request<{
      ok: boolean;
      compacted: boolean;
      result?: { summary?: string; kind?: string };
    }>("sessions.compact", { key }, { timeoutMs: 60000 });
    expect(compacted).toMatchObject({ ok: true, compacted: true });
    if (compactionMode === "server-endpoint") {
      expect(compacted.result?.kind).toBe("server-endpoint");
      expect(compactRequests).toHaveLength(1);
      expect(compactRequests[0]).toContain("HISTORY_TURN_5");
      expect(compactRequests[0]).toContain("HISTORY_TURN_6");
      expect(compactRequests[0]).not.toContain("HISTORY_TURN_1");
      expect(compactRequests[0]).not.toContain("HISTORY_TURN_2");
      for (let generation = 1; generation <= 2; generation++) {
        const firstTurn = generation * 6 + 1;
        for (let turn = firstTurn; turn < firstTurn + 6; turn++) {
          await sendTurn(turn);
          const replay = (await requests()).findLast(
            (request) => request.requestKind === "agent-initial",
          )!;
          const body = JSON.parse(replay.raw) as { input: Array<{ type?: string }> };
          const checkpoints = body.input.filter((item) => item.type === "compaction");
          expect(checkpoints).toHaveLength(1);
          expect(hash(checkpoints)).toBe(hash([checkpoint(generation)]));
          if (turn === firstTurn + 5) {
            expect(replay.allInputText).not.toContain(`HISTORY_TURN_${firstTurn}.`);
            expect(replay.allInputText).not.toContain(`HISTORY_TURN_${firstTurn + 1}.`);
          }
        }
        if (generation === 1) {
          const next = await client.request<{ result?: { kind?: string } }>(
            "sessions.compact",
            { key },
            { timeoutMs: 60000 },
          );
          expect(next.result?.kind).toBe("server-endpoint");
          expect(compactRequests).toHaveLength(2);
          expect(compactRequests[1]).toContain(checkpoint(1).encrypted_content);
          expect(compactRequests[1]).not.toContain("HISTORY_TURN_5.");
          expect(compactRequests[1]).not.toContain("HISTORY_TURN_6.");
        }
      }
      return;
    }
    expect(compactRequests).toHaveLength(0);
    const summary = (await requests()).filter(
      (request) => request.requestKind === "compaction-summary",
    );
    expect(summary.length).toBeGreaterThan(0);
    const summaryInput = summary.map((request) => request.allInputText).join("\n");
    expect(summaryInput).toContain("HISTORY_TURN_5");
    // Compaction preserves older durable context, rather than treating a prompt
    // window as deletion. Its saved summary survives subsequent history cuts.
    expect(summaryInput).toContain("HISTORY_TURN_1");
    expect(summaryInput).toContain("HISTORY_TURN_4");
    expect(compacted.result?.summary).toBeTruthy();
    for (let turn = 7; turn <= 12; turn++) await sendTurn(turn);
    const afterCompaction = (await requests()).findLast(
      (request) => request.requestKind === "agent-initial",
    )!;
    expect(afterCompaction.allInputText).toContain(compacted.result!.summary);
    expect(afterCompaction.allInputText).toContain("HISTORY_TURN_12");
    expect(afterCompaction.allInputText).not.toContain("HISTORY_TURN_7.");
    expect(afterCompaction.allInputText).not.toContain("HISTORY_TURN_8.");
  } catch (error) {
    throw new Error(`${String(error)}\n${instance.logs()}`, { cause: error });
  } finally {
    if (client) await disconnectGatewayClient(client);
    await instance.cleanup();
    await model.stop();
    transport.closeAllConnections();
    await new Promise<void>((resolve) => transport.close(() => resolve()));
  }
}

test.each(["client", "server-endpoint"] as const)(
  "routes account-scoped history through Gateway prompts and %s compaction",
  runAccountHistoryProof,
  180000,
);

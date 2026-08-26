/**
 * E2E proof for #118028: a late chat.abort must not mark a terminally frozen
 * queued followup run aborted, and final delivery must still complete.
 *
 * Runs a real ephemeral Gateway with a held-back mock provider so the first
 * turn stays active, forcing the second turn to queue as a followup and
 * register its Gateway cancel identity. After the queue drains and the frozen
 * run terminalizes (commitTerminalOutcome: freeze + retire), a late chat.abort
 * must return aborted=false and the queued followup must have completed
 * delivery.
 *
 * Proof scope: this test uses the Gateway's real broadcast event (chat,
 * state: "final") as the synchronization barrier. The "final" event is emitted
 * after commitTerminalOutcome (freeze + retireFollowupRunCancellation) and
 * delivery have both completed. Because Gateway does not broadcast an event
 * between freeze-retirement and delivery-settlement, an E2E test cannot
 * observe the exact freeze-to-settlement interval. The late chat.abort after
 * the "final" barrier therefore proves the terminal state (aborted=false,
 * delivery completed) but cannot distinguish retirement (abortable=false,
 * entry present) from deletion (entry removed).
 *
 * The harness test (chat.abort-frozen-queued-run.test.ts) fills this gap by
 * synchronously proving the freeze → rejected abort → delivery ordering and
 * explicitly asserting entry.abortable=false with the entry still present in
 * the map (retired, not deleted) before delivery removes it.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { connectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import { createDeferredCore as createDeferred } from "../src/shared/deferred.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";

type ChatEventPayload = {
  runId?: string;
  sessionKey?: string;
  state?: string;
  message?: unknown;
};

type MockModelRequest = {
  body: Record<string, unknown>;
};

type MockModelServer = {
  baseUrl: string;
  requests: MockModelRequest[];
  releaseHeldResponse: () => void;
  stop: () => Promise<void>;
};

const TEST_TIMEOUT_MS = 240_000;
const WAIT_OPTS = { timeout: 30_000, interval: 20 } as const;

const instances: OpenClawTestInstance[] = [];
const cleanupDirs: string[] = [];
const modelServers: MockModelServer[] = [];

afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.cleanup()));
  await Promise.all(modelServers.splice(0).map((server) => server.stop()));
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function readJsonRequest(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString("utf8");
  return body ? (JSON.parse(body) as Record<string, unknown>) : {};
}

function writeResponse(res: ServerResponse, text: string): void {
  const messageId = "msg_frozen_queued";
  const message = {
    type: "message",
    id: messageId,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  const events = [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...message, status: "in_progress", content: [] },
    },
    {
      type: "response.output_text.delta",
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    {
      type: "response.output_text.done",
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      text,
    },
    { type: "response.output_item.done", output_index: 0, item: message },
    {
      type: "response.completed",
      response: {
        id: "resp_frozen_queued",
        status: "completed",
        output: [message],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ];
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  res.end(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
  );
}

async function startMockModelServer(): Promise<MockModelServer> {
  const requests: MockModelRequest[] = [];
  const heldResponse = createDeferred();
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "frozen-queued", object: "model" }] }));
        return;
      }
      if (req.method !== "POST" || url.pathname !== "/v1/responses") {
        res.writeHead(404).end();
        return;
      }
      requests.push({ body: await readJsonRequest(req) });
      if (requests.length === 1) {
        await heldResponse.promise;
        if (res.destroyed) {
          return;
        }
      }
      writeResponse(res, requests.length === 1 ? "FIRST_TURN_COMPLETE" : "QUEUED_TURN_COMPLETE");
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("mock model server did not bind");
  }
  let stopped = false;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    releaseHeldResponse: () => heldResponse.resolve(),
    stop: async () => {
      if (stopped) {
        return;
      }
      stopped = true;
      heldResponse.resolve();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}

async function waitForChatFinal(
  events: Array<{ event?: string; payload?: unknown }>,
  runId: string,
  timeoutMs = 90_000,
): Promise<ChatEventPayload> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const event of events) {
      if (event.event !== "chat" || !event.payload || typeof event.payload !== "object") {
        continue;
      }
      const payload = event.payload as ChatEventPayload;
      if (payload.runId === runId && payload.state === "final") {
        return payload;
      }
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error(
    `timed out waiting for chat final runId=${runId}; events=${JSON.stringify(
      events.slice(-12),
      null,
      2,
    )}`,
  );
}

async function waitForChatRunActive(
  events: Array<{ event?: string; payload?: unknown }>,
  runId: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const event of events) {
      if (event.event !== "chat" || !event.payload || typeof event.payload !== "object") {
        continue;
      }
      const payload = event.payload as ChatEventPayload & { phase?: string };
      if (
        payload.runId === runId &&
        payload.state === "status" &&
        payload.phase === "starting_model"
      ) {
        return;
      }
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error(
    `timed out waiting for chat run active (state=status, phase=starting_model) runId=${runId}; events=${JSON.stringify(
      events.slice(-12),
      null,
      2,
    )}`,
  );
}

describe("Gateway frozen queued followup late-abort proof", () => {
  it(
    "leaves a frozen queued followup un-aborted and delivers it",
    async () => {
      const fixtureDir = await mkdtemp(path.join(tmpdir(), "openclaw-frozen-queued-"));
      cleanupDirs.push(fixtureDir);
      const workspaceDir = path.join(fixtureDir, "workspace");
      await mkdir(workspaceDir, { recursive: true });

      const modelServer = await startMockModelServer();
      modelServers.push(modelServer);
      const modelRef = "frozen-queued/frozen-queued";
      const config = {
        agents: {
          defaults: {
            workspace: workspaceDir,
            model: { primary: modelRef },
            models: { [modelRef]: { agentRuntime: { id: "openclaw" } } },
            skills: [],
            skipBootstrap: true,
          },
          list: [{ id: "main", default: true, model: { primary: modelRef }, skills: [] }],
        },
        tools: { profile: "minimal" },
        models: {
          mode: "replace",
          providers: {
            "frozen-queued": {
              baseUrl: `${modelServer.baseUrl}/v1`,
              apiKey: "secret-token",
              api: "openai-responses",
              request: { allowPrivateNetwork: true },
              models: [
                {
                  id: "frozen-queued",
                  name: "frozen-queued",
                  api: "openai-responses",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 128_000,
                  maxTokens: 4_096,
                },
              ],
            },
          },
        },
        messages: { queue: { mode: "followup" } },
      } satisfies OpenClawConfig;
      const instance = await createOpenClawTestInstance({
        name: "frozen-queued-followup",
        gatewayToken: "secret-token",
        config,
        env: {
          OPENCLAW_SKIP_PROVIDERS: undefined,
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        },
      });
      instances.push(instance);
      await instance.startGateway();

      const events: Array<{ event?: string; payload?: unknown }> = [];
      const client = await connectGatewayClient({
        url: instance.url,
        token: "secret-token",
        role: "operator",
        scopes: ["operator.admin", "operator.read", "operator.write"],
        requestTimeoutMs: 30_000,
        onEvent: (event) => {
          events.push(event);
        },
      });
      const sessionKey = "agent:main:frozen-queued-e2e";
      const trace: string[] = [];
      try {
        // 1. First turn starts and is held back by the provider, becoming the active run.
        const first = await client.request<{ runId?: unknown; status?: unknown }>("chat.send", {
          sessionKey,
          message: "OPENCLAW_E2E_HELD_TURN",
          idempotencyKey: "frozen-queued-held",
        });
        expect(first.status).toBe("started");
        const firstRunId = String(first.runId);
        await vi.waitFor(async () => {
          expect(modelServer.requests).toHaveLength(1);
        }, WAIT_OPTS);
        // Synchronize on the Gateway's real "starting_model" status event so the
        // first turn is provably the active embedded run before the second turn
        // is submitted. This replaces a fixed sleep with an observable state
        // barrier: the second turn can only be queued behind an active run.
        await waitForChatRunActive(events, firstRunId);
        trace.push(`first turn active (provider request count=${modelServer.requests.length})`);

        // 2. Second turn queues as a followup and registers its Gateway cancel identity.
        const second = await client.request<{ runId?: unknown; status?: unknown }>("chat.send", {
          sessionKey,
          message: "OPENCLAW_E2E_QUEUED_FOLLOWUP",
          idempotencyKey: "frozen-queued-followup",
          queueMode: "followup",
        });
        expect(second.status).toBe("started");
        expect(second.runId).toBeDefined();
        expect(String(second.runId)).not.toBe(String(first.runId));
        trace.push(`second turn accepted (queued as followup, runId=${String(second.runId)})`);

        // Queued precondition: the second turn must still be waiting in the
        // followup queue, not running concurrently with the held first turn.
        // The mock provider has only received one request (for the held first
        // turn). If both turns ran concurrently, the provider would have two
        // requests by now. This assertion deterministically proves the second
        // turn was queued behind the active first turn before release.
        expect(modelServer.requests).toHaveLength(1);
        trace.push(
          `queued precondition verified: provider still has only 1 request (second turn is queued, not concurrent)`,
        );

        // 3. Release the first turn so the queue drains and the followup executes.
        modelServer.releaseHeldResponse();

        // 4. Wait for the followup run to complete terminalization (freeze +
        //    retire + delivery). The Gateway broadcasts a "chat" event with
        //    state: "final" only after commitTerminalOutcome has executed
        //    (which includes retireFollowupRunCancellation) and delivery has
        //    completed. This is the reliable post-retirement barrier — it
        //    guarantees the queued entry has been retired (abortable=false)
        //    before the test issues a late abort.
        const followupRunId = String(second.runId);
        const finalEvent = await waitForChatFinal(events, followupRunId);
        trace.push(`followup run terminalized (chat state=final, runId=${followupRunId})`);

        // 5. A late chat.abort for the frozen queued run must return
        //    aborted=false. After retirement, abortQueuedChatTurnById sees
        //    entry.abortable === false (retired at the freeze boundary) and
        //    rejects the abort. The entry may also have been removed by
        //    onSettled/completeQueuedChatTurn after delivery; either way,
        //    the abort is a no-op. The harness test
        //    (chat.abort-frozen-queued-run.test.ts) proves the precise
        //    freeze → rejected abort → delivery ordering with synchronous
        //    entry.abortable inspection.
        const abortRes = await client.request<{ aborted?: boolean; runIds?: string[] }>(
          "chat.abort",
          {
            sessionKey,
            runId: followupRunId,
          },
        );
        trace.push(
          `late chat.abort for frozen queued run: aborted=${String(abortRes?.aborted)} runIds=${JSON.stringify(abortRes?.runIds)}`,
        );
        expect(abortRes?.aborted).toBe(false);
        expect(abortRes?.runIds ?? []).toEqual([]);

        // 6. Delivery is confirmed by the "final" broadcast event, which
        //    includes the assistant message content. The followup's reply text
        //    must be present in the broadcast payload, proving delivery
        //    completed before the late abort was issued.
        const finalMessageText = collectFinalText(finalEvent);
        expect(finalMessageText).toContain("QUEUED_TURN_COMPLETE");
        trace.push(`delivery confirmed via final event (message contains QUEUED_TURN_COMPLETE)`);
      } finally {
        await client
          .request("chat.abort", { sessionKey, preserveSideRuns: true })
          .catch(() => undefined);
        client.stop();
        modelServer.releaseHeldResponse();
      }
      // Redacted trace for the PR body; shown in test output, no shared artifact.
      console.log(
        [
          "[gateway-e2e] real ephemeral Gateway + held provider (redacted trace)",
          ...trace,
          "[gateway-e2e] RESULT: frozen queued followup un-aborted, final delivery completed",
        ].join("\n"),
      );
    },
    TEST_TIMEOUT_MS,
  );
});

function collectFinalText(finalEvent: ChatEventPayload): string {
  const message = finalEvent.message;
  if (typeof message === "string") {
    return message;
  }
  if (!message || typeof message !== "object") {
    return "";
  }
  const msg = message as Record<string, unknown>;
  if (typeof msg.text === "string") {
    return msg.text;
  }
  const content = msg.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === "object" && c && "text" in c ? String(c.text) : ""))
      .join("");
  }
  return "";
}

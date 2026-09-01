import { randomUUID } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createQaLiveLaneGateway } from "../../../../extensions/qa-lab/runtime-api.js";
import {
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
  OPENCLAW_NEXT_TURN_RUNTIME_CONTEXT_HEADER,
  OPENCLAW_RUNTIME_CONTEXT_NOTICE,
} from "../../../../src/agents/internal-runtime-context.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";

type GatewayChatMessage = {
  role?: unknown;
  content?: unknown;
  text?: unknown;
};

type GatewayChatHistory = {
  sessionKey?: string;
  sessionId?: string;
  messages?: GatewayChatMessage[];
};

type GatewayChatRun = {
  runId?: unknown;
  status?: unknown;
};

type GatewayHandle = Awaited<
  ReturnType<ReturnType<typeof createQaLiveLaneGateway>["start"]>
>["gateway"];

const HISTORY_RETRY_TIMEOUT_MS = 10_000;
const HISTORY_RETRY_DEFAULT_MS = 250;
const HISTORY_RETRY_MIN_MS = 100;
const HISTORY_RETRY_MAX_MS = 5_000;
const requestSnapshotsSchema = z.array(
  z.object({ cursor: z.number().int(), model: z.string(), raw: z.string() }),
);
const responsesInputSchema = z.object({
  input: z.array(
    z.object({
      role: z.string().optional(),
      content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
    }),
  ),
});
const historyTextSchema = z.union([
  z.string(),
  z.array(z.object({ type: z.literal("text"), text: z.string() })).length(1),
]);
const runtimeCarrierPrefix = [
  OPENCLAW_NEXT_TURN_RUNTIME_CONTEXT_HEADER,
  OPENCLAW_RUNTIME_CONTEXT_NOTICE,
  "",
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  "",
].join("\n");

function expectWhitespaceInterior(
  texts: string[],
  owner: string,
  marker: string,
  interior: string,
) {
  const begin = `BEGIN_${marker}`;
  const end = `END_${marker}`;
  for (const token of [begin, end]) {
    expect(texts.reduce((count, text) => count + text.split(token).length - 1, 0)).toBe(1);
  }
  const start = owner.indexOf(begin);
  const finish = owner.indexOf(end);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(finish).toBeGreaterThan(start);
  expect(Buffer.from(owner.slice(start + begin.length, finish))).toEqual(Buffer.from(interior));
}

let gatewayOwner: ReturnType<typeof createQaLiveLaneGateway> | undefined;
let harness: Awaited<ReturnType<ReturnType<typeof createQaLiveLaneGateway>["start"]>> | undefined;

async function startChatGateway(
  options: Pick<
    Parameters<ReturnType<typeof createQaLiveLaneGateway>["start"]>[0],
    "mockAuthAgentIds" | "mutateConfig"
  > = {},
) {
  gatewayOwner = createQaLiveLaneGateway();
  harness = await gatewayOwner.start({
    repoRoot: process.cwd(),
    providerMode: "mock-openai",
    primaryModel: "mock-openai/gpt-5.6-luna",
    alternateModel: "mock-openai/gpt-5.6-luna-alt",
    transport: {
      requiredPluginIds: [],
      createGatewayConfig: () => ({}),
    },
    transportBaseUrl: "http://127.0.0.1",
    controlUiEnabled: false,
    ...options,
  });
  return harness;
}

afterEach(async () => {
  if (gatewayOwner) {
    await stopQaGatewayFixture(gatewayOwner);
  }
  harness = undefined;
  gatewayOwner = undefined;
});

function messageContains(message: GatewayChatMessage, expected: string): boolean {
  return JSON.stringify(message).includes(expected);
}

function historyContainsExpectedTurns(
  history: GatewayChatHistory,
  expectedUser: string,
  expectedAssistant: string,
): boolean {
  const messages = history.messages ?? [];
  return (
    messages.some((message) => message.role === "user" && messageContains(message, expectedUser)) &&
    messages.some(
      (message) => message.role === "assistant" && messageContains(message, expectedAssistant),
    )
  );
}

// Transcript projection rebuilds can briefly reject chat.history. Retry only
// that structured protocol response; every other failure remains immediate.
function resolveRetryableHistoryDelayMs(error: unknown): number | null {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      break;
    }
    const shaped = current as {
      cause?: unknown;
      code?: unknown;
      details?: unknown;
      gatewayCode?: unknown;
      retryable?: unknown;
      retryAfterMs?: unknown;
    };
    const code = shaped.gatewayCode ?? shaped.code;
    if (code === "UNAVAILABLE" && shaped.retryable === true) {
      const detailMethod =
        typeof shaped.details === "object" && shaped.details !== null
          ? (shaped.details as { method?: unknown }).method
          : undefined;
      if (typeof detailMethod !== "string" || detailMethod === "chat.history") {
        const rawDelayMs =
          typeof shaped.retryAfterMs === "number" && Number.isFinite(shaped.retryAfterMs)
            ? shaped.retryAfterMs
            : HISTORY_RETRY_DEFAULT_MS;
        return Math.min(
          Math.max(Math.floor(rawDelayMs), HISTORY_RETRY_MIN_MS),
          HISTORY_RETRY_MAX_MS,
        );
      }
    }
    current = shaped.cause;
  }
  return null;
}

async function waitForChatHistory(params: {
  gateway: GatewayHandle;
  sessionKey: string;
  agentId?: string;
  expectedUser: string;
  expectedAssistant: string;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<GatewayChatHistory> {
  const timeoutMs = params.timeoutMs ?? HISTORY_RETRY_TIMEOUT_MS;
  const intervalMs = params.intervalMs ?? HISTORY_RETRY_DEFAULT_MS;
  const startedAt = Date.now();
  let lastRetryableHistoryError: unknown;
  while (Date.now() - startedAt < timeoutMs) {
    let delayMs = intervalMs;
    try {
      const history = (await params.gateway.call(
        "chat.history",
        { sessionKey: params.sessionKey, agentId: params.agentId, limit: 20 },
        { timeoutMs: 10_000 },
      )) as GatewayChatHistory;
      lastRetryableHistoryError = undefined;
      if (historyContainsExpectedTurns(history, params.expectedUser, params.expectedAssistant)) {
        return history;
      }
    } catch (error) {
      const retryDelayMs = resolveRetryableHistoryDelayMs(error);
      if (retryDelayMs === null) {
        throw error;
      }
      lastRetryableHistoryError = error;
      delayMs = retryDelayMs;
    }
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      break;
    }
    await sleep(Math.min(delayMs, remainingMs));
  }
  const message = `timed out waiting for complete chat.history after ${timeoutMs}ms`;
  throw lastRetryableHistoryError === undefined
    ? new Error(message)
    : new Error(message, { cause: lastRetryableHistoryError });
}

describe("Gateway chat RPCs", () => {
  it("waits past a successful incomplete chat.history response", async () => {
    vi.useFakeTimers();
    try {
      const call = vi
        .fn()
        .mockResolvedValueOnce({
          messages: [
            { role: "user", content: "expected user" },
            { role: "assistant", content: "still working" },
          ],
        })
        .mockResolvedValueOnce({
          messages: [
            { role: "user", content: "expected user" },
            { role: "assistant", content: "expected assistant" },
          ],
        });
      const pending = waitForChatHistory({
        gateway: { call } as unknown as GatewayHandle,
        sessionKey: "session-history-projection",
        expectedUser: "expected user",
        expectedAssistant: "expected assistant",
        timeoutMs: 1_000,
        intervalMs: 100,
      });

      await vi.advanceTimersByTimeAsync(100);

      await expect(pending).resolves.toMatchObject({
        messages: [{ role: "user" }, { role: "assistant" }],
      });
      expect(call).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it(
    "preserves model-input whitespace independently from canonical chat history",
    { timeout: 120_000 },
    async () => {
      harness = await startChatGateway();
      const { gateway } = harness;
      const mock = expectDefined(harness.mock, "mock provider");
      const sessionKey = `agent:qa:gateway-rpc-chat-${randomUUID()}`;
      const turns = ["/think high\n", ""].map((directive, index) => {
        const marker = randomUUID();
        const reply = `GATEWAY_RPC_CHAT_OK_${index}`;
        const interior =
          "\n```python\nif True:\n    value = 'a  b'\n    if value:\n        print(value)\n\t\t# tabs stay  \n \t \n```\n";
        return {
          marker,
          reply,
          interior,
          prompt: `${directive}Gateway chat RPC QA. Reply exactly \`${reply}\`.\nBEGIN_${marker}${interior}END_${marker}`,
        };
      });

      for (const [index, turn] of turns.entries()) {
        const cursorResponse = await fetch(`${mock.baseUrl}/debug/request-cursor`);
        expect(cursorResponse.ok).toBe(true);
        const { cursor } = z
          .object({ cursor: z.number().int() })
          .parse(await cursorResponse.json());
        const started = (await gateway.call(
          "chat.send",
          {
            sessionKey,
            message: turn.prompt,
            deliver: false,
            idempotencyKey: randomUUID(),
          },
          { timeoutMs: 30_000 },
        )) as GatewayChatRun;
        expect(started.status).toBe("started");
        expect(typeof started.runId).toBe("string");
        const terminal = (await gateway.call(
          "agent.wait",
          { runId: started.runId, timeoutMs: 30_000 },
          { timeoutMs: 35_000 },
        )) as GatewayChatRun;
        expect(terminal.status).toBe("ok");

        const response = await fetch(`${mock.baseUrl}/debug/requests?after=${cursor}`);
        expect(response.ok).toBe(true);
        const requests = requestSnapshotsSchema.parse(await response.json());
        // Pin by request identity before checking content: a later retry must not
        // hide a damaged initial prompt, and mock convenience fields trim text.
        const request = expectDefined(
          requests
            .filter((entry) => entry.model === "gpt-5.6-luna")
            .toSorted((a, b) => a.cursor - b.cursor)[0],
          "first provider request",
        );
        const { input } = responsesInputSchema.parse(JSON.parse(request.raw));
        const inputTexts = input.flatMap((item) =>
          (item.content ?? [])
            .filter((part) => part.type === "input_text")
            .map((part) => expectDefined(part.text, "provider input text")),
        );
        const userTexts = input
          .filter((item) => item.role === "user")
          .map((item) => {
            expect(item.content).toHaveLength(1);
            const part = expectDefined(item.content?.[0], "user content");
            expect(part.type).toBe("input_text");
            return expectDefined(part.text, "user text");
          })
          .filter(
            (text) =>
              !(
                text.startsWith(runtimeCarrierPrefix) &&
                text.endsWith(`\n${INTERNAL_RUNTIME_CONTEXT_END}`)
              ),
          );
        expect(userTexts).toHaveLength(index + 1);
        const history = await waitForChatHistory({
          gateway,
          sessionKey,
          expectedUser: `BEGIN_${turn.marker}`,
          expectedAssistant: turn.reply,
        });
        const userMessages = (history.messages ?? []).filter((message) => message.role === "user");
        expect(userMessages).toHaveLength(index + 1);
        for (const [turnIndex, expected] of turns.slice(0, index + 1).entries()) {
          const modelText = expectDefined(userTexts[turnIndex], "model user turn");
          expectWhitespaceInterior(inputTexts, modelText, expected.marker, expected.interior);
          const content = historyTextSchema.parse(userMessages[turnIndex]?.content);
          const recorded =
            typeof content === "string" ? content : expectDefined(content[0], "history text").text;
          expectWhitespaceInterior([recorded], recorded, expected.marker, expected.interior);
        }
        if (index === 0) {
          expect(userTexts[0]).not.toContain("/think high");
        } else {
          expect(userTexts[0]).toContain("/think high");
        }
      }
    },
  );

  it.each([
    ...[
      { first: "main", second: "work" },
      { first: "work", second: "main" },
    ].flatMap((owners) =>
      [false, true].map((withAttachment) => ({ ...owners, withAttachment, seedChat: true })),
    ),
    { first: "main", second: "work", withAttachment: false, seedChat: false },
  ])(
    "keeps explicit $first then $second ownership through global chat and native agent dispatch and history (chatAttachment=$withAttachment, seedChat=$seedChat)",
    { timeout: 120_000 },
    async ({ first, second, withAttachment, seedChat }) => {
      const { gateway, mock: provider } = await startChatGateway({
        mockAuthAgentIds: ["main", "work"],
        mutateConfig: (config) => ({
          ...config,
          agents: {
            ...config.agents,
            ownership: "explicit",
            entries: { main: {}, work: {} },
            defaults: {
              ...config.agents?.defaults,
              models: Object.fromEntries(
                Object.entries(config.agents?.defaults?.models ?? {}).map(([ref, model]) => [
                  ref,
                  { ...model, agentRuntime: { id: "openclaw" } },
                ]),
              ),
            },
          },
          session: { ...config.session, scope: "global" },
        }),
      });
      const mock = expectDefined(provider, "mock provider");
      expect(gateway.cfg.plugins?.allow).toEqual(["qa-lab"]);
      const sessionKey = "global";
      const replies = new Map(
        [first, second].map((owner) => [owner, `GLOBAL_OWNER_${owner}_${randomUUID()}`]),
      );
      const sessionIds = new Map<string, string>();
      let cursor = 0;
      const turns = (seedChat ? ["chat.send", "agent"] : ["agent"]).flatMap((method) =>
        [first, second].map((agentId) => ({ method, agentId })),
      );
      for (const { method, agentId } of turns) {
        const reply = `${expectDefined(replies.get(agentId), "owner reply marker")}_${method}`;
        const otherAgentId = agentId === "main" ? "work" : "main";
        const otherReply = expectDefined(replies.get(otherAgentId), "other owner reply marker");
        const prompt = `Gateway ${method} ownership QA for ${agentId}. Reply exactly \`${reply}\`.`;
        const attachments =
          withAttachment && method === "chat.send"
            ? [
                {
                  fileName: `${agentId}-notes.txt`,
                  mimeType: "text/plain",
                  content: Buffer.from(`${agentId} attachment ${reply}`).toString("base64"),
                },
              ]
            : undefined;
        const started = (await gateway.call(
          method,
          {
            sessionKey,
            agentId,
            message: prompt,
            deliver: false,
            idempotencyKey: randomUUID(),
            attachments,
          },
          { timeoutMs: 30_000 },
        )) as GatewayChatRun;
        expect(started.status).toBe(method === "agent" ? "accepted" : "started");
        expect(typeof started.runId).toBe("string");
        const terminal = (await gateway.call(
          "agent.wait",
          { runId: started.runId, timeoutMs: 30_000 },
          { timeoutMs: 35_000 },
        )) as GatewayChatRun;
        const response = await fetch(`${mock.baseUrl}/debug/requests?after=${cursor}`);
        expect(response.ok).toBe(true);
        const requests = requestSnapshotsSchema.parse(await response.json());
        cursor = Math.max(cursor, ...requests.map((request) => request.cursor));
        expect
          .soft(
            requests.some((request) => request.raw.includes(prompt)),
            `${agentId} ${method} must reach the provider`,
          )
          .toBe(true);
        if (attachments) {
          expect
            .soft(
              requests.some((request) => request.raw.includes(`${agentId} attachment ${reply}`)),
              `${agentId} attachment must reach the provider`,
            )
            .toBe(true);
        }
        expect
          .soft(
            requests.some((request) => request.raw.includes(otherReply)),
            `${agentId} provider input must exclude ${otherAgentId} history`,
          )
          .toBe(false);
        expect.soft(terminal, JSON.stringify(terminal)).toMatchObject({
          runId: started.runId,
          status: "ok",
        });
        // Exercise the other explicit owner even when the first run fails before execution.
        if (terminal.status !== "ok") {
          continue;
        }

        const history = await waitForChatHistory({
          gateway,
          sessionKey,
          agentId,
          expectedUser: prompt,
          expectedAssistant: reply,
        });
        expect(historyContainsExpectedTurns(history, prompt, reply)).toBe(true);
        expect(history.sessionKey).toBe(sessionKey);
        const sessionId = expectDefined(history.sessionId, "canonical history session id");
        if (sessionIds.has(agentId)) {
          expect(sessionId).toBe(sessionIds.get(agentId));
        }
        sessionIds.set(agentId, sessionId);
        expect(new Set(sessionIds.values()).size).toBe(sessionIds.size);
        if (method === "agent" && seedChat) {
          const seedReply = `${expectDefined(replies.get(agentId), "owner reply marker")}_chat.send`;
          expect(historyContainsExpectedTurns(history, seedReply, seedReply)).toBe(true);
          expect(requests.some((request) => request.raw.includes(seedReply))).toBe(true);
        }
        expect(
          (history.messages ?? []).some((message) => messageContains(message, otherReply)),
        ).toBe(false);
        const otherHistory = (await gateway.call("chat.history", {
          sessionKey,
          agentId: otherAgentId,
          limit: 20,
        })) as GatewayChatHistory;
        expect(
          (otherHistory.messages ?? []).some((message) => messageContains(message, reply)),
        ).toBe(false);
      }
      const database = new DatabaseSync(
        path.join(gateway.tempRoot, "state", "state", "openclaw.sqlite"),
        { readOnly: true },
      );
      try {
        const placements = database.prepare(
          "SELECT agent_id, session_key, session_id, state, turn_claim_id FROM worker_session_placements WHERE agent_id IN (?, ?) ORDER BY agent_id",
        );
        // The terminal event can precede the placement owner's final claim release.
        await expect
          .poll(() => placements.all(first, second))
          .toEqual(
            [first, second].toSorted().map((agentId) => ({
              agent_id: agentId,
              session_key: sessionKey,
              session_id: expectDefined(sessionIds.get(agentId), "owner session id"),
              state: "local",
              turn_claim_id: null,
            })),
          );
      } finally {
        database.close();
      }
    },
  );
});

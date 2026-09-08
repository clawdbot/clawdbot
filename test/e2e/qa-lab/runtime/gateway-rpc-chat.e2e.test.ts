import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
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
} from "../../../../src/agents/internal-runtime-context.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
} from "../../../../src/gateway/test-helpers.e2e.js";
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

type MockRequestCursor = { cursor: number };

type MockRequestSnapshot = {
  body?: Record<string, unknown>;
  cursor?: number;
  plannedToolArgs?: Record<string, unknown>;
  plannedToolName?: string;
  prompt?: string;
  toolOutput?: string;
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
  reasoning: z.object({ effort: z.string() }),
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
// Next-turn carriers are the delimited body only; the marker instruction lives in the system prompt.
const runtimeCarrierPrefix = `${INTERNAL_RUNTIME_CONTEXT_BEGIN}\n`;

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
  expectedAssistant?: string,
): boolean {
  const messages = history.messages ?? [];
  return (
    messages.some((message) => message.role === "user" && messageContains(message, expectedUser)) &&
    (expectedAssistant === undefined ||
      messages.some(
        (message) => message.role === "assistant" && messageContains(message, expectedAssistant),
      ))
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

function resolveGatewayErrorReason(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      return undefined;
    }
    const shaped = current as { cause?: unknown; details?: unknown };
    if (typeof shaped.details === "object" && shaped.details !== null) {
      const reason = (shaped.details as { reason?: unknown }).reason;
      if (typeof reason === "string") {
        return reason;
      }
    }
    current = shaped.cause;
  }
  return undefined;
}

async function waitForChatHistory(params: {
  gateway: GatewayHandle;
  sessionKey: string;
  agentId?: string;
  expectedUser: string;
  expectedAssistant?: string;
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

async function sendAndWait(params: {
  gateway: GatewayHandle;
  sessionKey: string;
  message: string;
  expectedPermissionMode?: string;
  expectedToolOverrides?: Record<string, unknown>;
}): Promise<void> {
  const started = (await params.gateway.call(
    "chat.send",
    {
      sessionKey: params.sessionKey,
      message: params.message,
      deliver: false,
      idempotencyKey: randomUUID(),
      ...(params.expectedPermissionMode === undefined
        ? {}
        : { expectedPermissionMode: params.expectedPermissionMode }),
      ...(params.expectedToolOverrides === undefined
        ? {}
        : { expectedToolOverrides: params.expectedToolOverrides }),
    },
    { timeoutMs: 30_000 },
  )) as GatewayChatRun;
  expect(started.status).toBe("started");
  expect(typeof started.runId).toBe("string");

  const terminal = (await params.gateway.call(
    "agent.wait",
    { runId: started.runId, timeoutMs: 30_000 },
    { timeoutMs: 35_000 },
  )) as GatewayChatRun;
  expect(terminal.status).toBe("ok");
}

async function readMockJson<T>(baseUrl: string, requestPath: string): Promise<T> {
  const response = await fetch(`${baseUrl}${requestPath}`);
  if (!response.ok) {
    throw new Error(`mock provider request failed: ${response.status} ${requestPath}`);
  }
  return (await response.json()) as T;
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
        const { input, reasoning } = responsesInputSchema.parse(JSON.parse(request.raw));
        expect(reasoning.effort).toBe(index === 0 ? "high" : "medium");
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

  it("keeps inline trace diagnostics on their own turn", { timeout: 120_000 }, async () => {
    const { gateway, mock } = await startChatGateway();
    const provider = expectDefined(mock, "trace mock provider");
    const sessionKey = `agent:qa:gateway-inline-trace-${randomUUID()}`;
    const finals = new Map<string, string[]>();
    let settledTurns = 0;
    const settledSchema = z.object({
      sessionKey: z.literal(sessionKey),
      reason: z.literal("chat.run.settled"),
    });
    const finalSchema = z.object({
      sessionKey: z.literal(sessionKey),
      runId: z.string(),
      state: z.literal("final"),
      message: z.unknown(),
    });
    const client = await connectGatewayClient({
      url: gateway.wsUrl,
      token: gateway.token,
      scopes: ["operator.admin", "operator.read", "operator.write"],
      onEvent: (event) => {
        if (event.event === "chat") {
          const parsed = finalSchema.safeParse(event.payload);
          if (parsed.success) {
            const replies = finals.get(parsed.data.runId) ?? [];
            replies.push(JSON.stringify(parsed.data.message));
            finals.set(parsed.data.runId, replies);
          }
        } else if (
          event.event === "sessions.changed" &&
          settledSchema.safeParse(event.payload).success
        ) {
          settledTurns += 1;
        }
      },
    });
    try {
      await client.request("sessions.subscribe", {});
      for (const [index, turn] of [
        { directive: "/trace raw\n", raw: true, stored: undefined },
        { directive: "", raw: false, stored: undefined },
        { directive: "/trace off\n", raw: false, stored: "raw" },
        { directive: "", raw: true, stored: "raw" },
      ].entries()) {
        if (index === 2) {
          await expect(
            client.request("sessions.patch", { key: sessionKey, traceLevel: "raw" }),
          ).resolves.toMatchObject({ entry: { traceLevel: "raw" } });
        }
        const runId = randomUUID();
        const reply = `INLINE_TRACE_REPLY_${index}`;
        await expect(
          client.request("chat.send", {
            sessionKey,
            message: `${turn.directive}Gateway inline trace marker QA. Reply exactly \`${reply}\`.`,
            deliver: false,
            idempotencyKey: runId,
          }),
        ).resolves.toMatchObject({ runId, status: "started" });
        await expect(
          client.request("agent.wait", { runId, timeoutMs: 30_000 }, { timeoutMs: 35_000 }),
        ).resolves.toMatchObject({ status: "ok" });
        await expect
          .poll(
            async () => {
              const requests = await readMockJson<MockRequestSnapshot[]>(
                provider.baseUrl,
                "/debug/requests",
              );
              return requests.some((request) => request.prompt?.includes(reply));
            },
            { timeout: 10_000, interval: 250 },
          )
          .toBe(true);
        // A directive acknowledgement may finish before the model's separate final delivery.
        await expect
          .poll(() => finals.get(runId)?.some((text) => text.includes(reply)), { timeout: 10_000 })
          .toBe(true);
        // This notification follows dispatch delivery and admission cleanup; no trailing
        // diagnostic payload can arrive after the negative trace assertions below.
        await expect.poll(() => settledTurns, { timeout: 10_000 }).toBe(index + 1);
        const text = expectDefined(finals.get(runId), "settled chat finals").join("\n");
        expect(text).toContain(reply);
        expect.soft(text.includes("Model Input (User Role)"), `trace turn ${index}`).toBe(turn.raw);
        expect
          .soft(text.includes("Model Output (Assistant Role)"), `trace turn ${index}`)
          .toBe(turn.raw);
        const listed = z
          .object({
            sessions: z.array(z.object({ key: z.string(), traceLevel: z.string().optional() })),
          })
          .parse(await client.request("sessions.list", { search: sessionKey }));
        const row = expectDefined(
          listed.sessions.find((entry) => entry.key === sessionKey),
          "trace session",
        );
        expect(row.traceLevel).toBe(turn.stored);
        console.log(
          `[inline-trace-proof] ${JSON.stringify({
            turn: index,
            runId,
            settled: settledTurns === index + 1,
            modelReplyDelivered: text.includes(reply),
            rawExpected: turn.raw,
            rawInput: text.includes("Model Input (User Role)"),
            rawOutput: text.includes("Model Output (Assistant Role)"),
            storedTrace: row.traceLevel ?? null,
          })}`,
        );
      }
    } finally {
      await disconnectGatewayClient(client);
    }
  });

  it.each([
    ...[
      { first: "main", second: "work" },
      { first: "work", second: "main" },
    ].flatMap(({ first, second }) =>
      [false, true].map((withAttachment) => ({ first, second, withAttachment, seedChat: true })),
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

  it(
    "enforces admitted session settings at final effect and rejects stale sends before dispatch",
    { timeout: 120_000 },
    async () => {
      harness = await startChatGateway({
        mutateConfig: (config) => ({
          ...config,
          tools: { ...config.tools, profile: "coding" },
        }),
      });
      const { gateway, mock } = harness;
      if (!mock) {
        throw new Error("mock provider did not start");
      }

      const sessionKey = `agent:qa:gateway-settings-authority-${randomUUID()}`;
      await sendAndWait({ gateway, sessionKey, message: "Create the proof session." });
      await expect(
        gateway.call("sessions.patch", {
          key: sessionKey,
          permissionMode: "read-only",
          toolOverrides: { webSearch: false },
        }),
      ).resolves.toMatchObject({ entry: { permissionMode: "read-only" } });

      const cursorBeforeRestricted = await readMockJson<MockRequestCursor>(
        mock.baseUrl,
        "/debug/request-cursor",
      );
      const restrictedReply = "SESSION_SETTINGS_READ_ONLY_OK";
      const sentinelPath = `${gateway.workspaceDir}/forbidden-session-settings-write.txt`;
      const restrictedPrompt = [
        "Tool progress QA check.",
        `Call the exec tool exactly once with this exact command before answering: \`printf forbidden > ${JSON.stringify(sentinelPath)}\`.`,
        `Reply exactly \`${restrictedReply}\`.`,
      ].join(" ");
      await sendAndWait({
        gateway,
        sessionKey,
        message: restrictedPrompt,
        expectedPermissionMode: "read-only",
        expectedToolOverrides: { webSearch: false },
      });

      const restrictedRequests = await readMockJson<MockRequestSnapshot[]>(
        mock.baseUrl,
        `/debug/requests?after=${cursorBeforeRestricted.cursor}`,
      );
      const plannedExec = restrictedRequests.find(
        (request) =>
          request.prompt?.includes("Tool progress QA check") && request.plannedToolName === "exec",
      );
      expect(plannedExec?.plannedToolArgs?.command).toContain(sentinelPath);
      expect(
        await fs.access(sentinelPath).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
      expect(
        restrictedRequests.some((request) =>
          /exec denied|security=deny|execution policy/iu.test(request.toolOutput ?? ""),
        ),
      ).toBe(true);
      const declaredToolNames = (
        Array.isArray(plannedExec?.body?.tools) ? plannedExec.body.tools : []
      ).flatMap((tool) => {
        const name =
          typeof tool === "object" && tool !== null ? (tool as { name?: unknown }).name : undefined;
        return typeof name === "string" ? [name] : [];
      });
      expect(declaredToolNames).not.toEqual(
        expect.arrayContaining(["write", "edit", "apply_patch", "web_search"]),
      );

      await expect(
        gateway.call("sessions.patch", {
          key: sessionKey,
          permissionMode: "full",
          toolOverrides: null,
        }),
      ).resolves.toMatchObject({ entry: { permissionMode: "full" } });
      const cursorBeforeRejected = await readMockJson<MockRequestCursor>(
        mock.baseUrl,
        "/debug/request-cursor",
      );
      const rejectedPrompt = "REJECT_CHANGED_SETTINGS_BEFORE_IO";
      const rejectedError = await gateway
        .call("chat.send", {
          sessionKey,
          message: rejectedPrompt,
          deliver: false,
          idempotencyKey: randomUUID(),
          expectedPermissionMode: "read-only",
          expectedToolOverrides: { webSearch: false },
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(resolveGatewayErrorReason(rejectedError)).toBe("session-settings-changed");
      const cursorAfterRejected = await readMockJson<MockRequestCursor>(
        mock.baseUrl,
        "/debug/request-cursor",
      );
      expect(cursorAfterRejected).toEqual(cursorBeforeRejected);
      const history = (await gateway.call(
        "chat.history",
        { sessionKey, limit: 50 },
        { timeoutMs: 10_000 },
      )) as GatewayChatHistory;
      expect(JSON.stringify(history.messages ?? [])).not.toContain(rejectedPrompt);

      console.log(
        `[session-settings-authority-proof] ${JSON.stringify({
          restrictedRun: "completed",
          deniedFinalEffect: true,
          sentinelCreated: false,
          changedSettingsRejected: true,
          rejectedRequestReachedProvider: false,
          rejectedRequestReachedTranscript: false,
        })}`,
      );
    },
  );
});

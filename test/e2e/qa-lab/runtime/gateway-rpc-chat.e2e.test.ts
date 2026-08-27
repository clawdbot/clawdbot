import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startQaLiveLaneGateway } from "../../../../extensions/qa-lab/runtime-api.js";

type GatewayChatMessage = {
  role?: unknown;
  content?: unknown;
  text?: unknown;
};

type GatewayChatHistory = {
  messages?: GatewayChatMessage[];
};

type GatewayChatRun = {
  runId?: unknown;
  status?: unknown;
};

type GatewayHandle = Awaited<ReturnType<typeof startQaLiveLaneGateway>>["gateway"];

const HISTORY_RETRY_TIMEOUT_MS = 10_000;
const HISTORY_RETRY_DEFAULT_MS = 250;
const HISTORY_RETRY_MIN_MS = 100;
const HISTORY_RETRY_MAX_MS = 5_000;

let harness: Awaited<ReturnType<typeof startQaLiveLaneGateway>> | undefined;

afterEach(async () => {
  await harness?.stop().catch(() => undefined);
  harness = undefined;
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
        { sessionKey: params.sessionKey, limit: 20 },
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
    "runs chat.send through agent.wait and persists both sides in chat.history",
    { timeout: 120_000 },
    async () => {
      harness = await startQaLiveLaneGateway({
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
      });
      const { gateway } = harness;

      const expectedReply = "GATEWAY_RPC_CHAT_OK";
      const prompt = `Gateway chat RPC QA. Reply exactly \`${expectedReply}\`.`;
      const sessionKey = `agent:qa:gateway-rpc-chat-${randomUUID()}`;
      const started = (await gateway.call(
        "chat.send",
        {
          sessionKey,
          message: prompt,
          deliver: false,
          idempotencyKey: randomUUID(),
        },
        { timeoutMs: 30_000 },
      )) as GatewayChatRun;

      expect(started.status).toBe("started");
      expect(typeof started.runId).toBe("string");

      const terminal = (await gateway.call(
        "agent.wait",
        {
          runId: started.runId,
          timeoutMs: 30_000,
        },
        { timeoutMs: 35_000 },
      )) as GatewayChatRun;
      expect(terminal.status).toBe("ok");

      const history = await waitForChatHistory({
        gateway,
        sessionKey,
        expectedUser: prompt,
        expectedAssistant: expectedReply,
      });
      const messages = history.messages ?? [];

      expect(
        messages.some((message) => message.role === "user" && messageContains(message, prompt)),
      ).toBe(true);
      expect(
        messages.some(
          (message) => message.role === "assistant" && messageContains(message, expectedReply),
        ),
      ).toBe(true);
    },
  );
});

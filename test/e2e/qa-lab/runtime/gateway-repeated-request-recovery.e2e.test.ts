import { randomUUID } from "node:crypto";
import { writeSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createQaLiveLaneGateway } from "../../../../extensions/qa-lab/runtime-api.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";

type StabilityEvent = {
  seq?: unknown;
  type?: unknown;
  action?: unknown;
  reason?: unknown;
  outcome?: unknown;
  ageMs?: unknown;
  durationMs?: unknown;
  failureKind?: unknown;
  queueDepth?: unknown;
  source?: unknown;
};

type StabilitySnapshot = {
  lastSeq?: unknown;
  events?: StabilityEvent[];
};

type GatewayChatRun = {
  runId?: unknown;
  status?: unknown;
  stopReason?: unknown;
  endedAt?: unknown;
};

type GatewayChatMessage = {
  role?: unknown;
  content?: unknown;
};

type GatewayChatHistory = {
  messages?: GatewayChatMessage[];
};

type MockRequestSnapshot = {
  cursor?: unknown;
  prompt?: unknown;
  allInputText?: unknown;
  model?: unknown;
  outcome?: unknown;
  errorCode?: unknown;
};

type ClassifiedMockRequest = {
  cursor: unknown;
  model: unknown;
  continuation: boolean;
  prompt: "recovery" | "queued" | "other" | "missing";
  outcome: unknown;
  errorCode: unknown;
};

const RECOVERY_PROMPT =
  "Repeated request recovery Gateway QA check. Keep attempting without producing a reply.";
const QUEUED_PROMPT =
  "Repeated request queued reply Gateway QA check. Reply with the fixture marker.";
const QUEUED_REPLY_MARKER = "GATEWAY_REPEATED_REQUEST_QUEUED_OK";
const RECOVERY_REASON = "repeated_model_requests_without_progress";
const PRODUCTION_RECOVERY_BOUND_MS = 360_000;
const MODEL_REQUEST_ALLOWANCE_SECONDS = 90;
const RECOVERY_PROGRESS_INTERVAL_MS = 60_000;
const HISTORY_RETRY_TIMEOUT_MS = 60_000;
const HISTORY_RETRY_INTERVAL_MS = 250;

let gatewayOwner: ReturnType<typeof createQaLiveLaneGateway> | undefined;
let harness: Awaited<ReturnType<ReturnType<typeof createQaLiveLaneGateway>["start"]>> | undefined;

afterEach(async () => {
  if (gatewayOwner) {
    await stopQaGatewayFixture(gatewayOwner);
  }
  harness = undefined;
  gatewayOwner = undefined;
});

async function readStability(
  gateway: Awaited<ReturnType<ReturnType<typeof createQaLiveLaneGateway>["start"]>>["gateway"],
  sinceSeq?: number,
): Promise<StabilitySnapshot> {
  return (await gateway.call(
    "diagnostics.stability",
    { limit: 1000, ...(sinceSeq === undefined ? {} : { sinceSeq }) },
    { timeoutMs: 10_000 },
  )) as StabilitySnapshot;
}

async function waitForStability(
  gateway: Awaited<ReturnType<ReturnType<typeof createQaLiveLaneGateway>["start"]>>["gateway"],
  sinceSeq: number,
  predicate: (events: StabilityEvent[]) => boolean,
  timeoutMs: number,
): Promise<StabilityEvent[]> {
  const startedAt = Date.now();
  let nextProgressAt = RECOVERY_PROGRESS_INTERVAL_MS;
  let latest: StabilityEvent[] = [];
  while (Date.now() - startedAt < timeoutMs) {
    latest = (await readStability(gateway, sinceSeq)).events ?? [];
    if (predicate(latest)) {
      return latest;
    }
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= nextProgressAt) {
      // Vitest suppresses test console output; write to the worker fd so the outer
      // no-output watchdog can distinguish this production-length poll from a stalled worker.
      writeSync(
        2,
        `[gateway-repeated-request-recovery] waiting for stability evidence (${elapsedMs}ms, ${latest.length} events)\n`,
      );
      nextProgressAt += RECOVERY_PROGRESS_INTERVAL_MS;
    }
    await sleep(1_000);
  }
  throw new Error(
    `timed out after ${timeoutMs}ms waiting for stability events: ${JSON.stringify(latest)}`,
  );
}

function messageText(message: GatewayChatMessage): string {
  if (typeof message.content === "string") {
    return message.content.trim();
  }
  if (!Array.isArray(message.content)) {
    return "";
  }
  return message.content
    .flatMap((part) =>
      part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? [(part as { text: string }).text]
        : [],
    )
    .join("\n")
    .trim();
}

function historyContainsQueuedReply(history: GatewayChatHistory): boolean {
  const messages = history.messages ?? [];
  const queuedIndex = messages.findLastIndex(
    (message) => message.role === "user" && messageText(message).includes(QUEUED_PROMPT),
  );
  return (
    queuedIndex >= 0 &&
    messages
      .slice(queuedIndex + 1)
      .some(
        (message) => message.role === "assistant" && messageText(message) === QUEUED_REPLY_MARKER,
      )
  );
}

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
        return typeof shaped.retryAfterMs === "number" && Number.isFinite(shaped.retryAfterMs)
          ? Math.max(100, Math.min(Math.floor(shaped.retryAfterMs), 5_000))
          : HISTORY_RETRY_INTERVAL_MS;
      }
    }
    current = shaped.cause;
  }
  return null;
}

async function waitForQueuedReply(
  gateway: Awaited<ReturnType<ReturnType<typeof createQaLiveLaneGateway>["start"]>>["gateway"],
  sessionKey: string,
): Promise<GatewayChatHistory> {
  const startedAt = Date.now();
  let latestHistory: GatewayChatHistory = {};
  let lastRetryableError: unknown;
  while (Date.now() - startedAt < HISTORY_RETRY_TIMEOUT_MS) {
    let delayMs = HISTORY_RETRY_INTERVAL_MS;
    try {
      const history = (await gateway.call(
        "chat.history",
        { sessionKey, limit: 20 },
        { timeoutMs: 10_000 },
      )) as GatewayChatHistory;
      latestHistory = history;
      lastRetryableError = undefined;
      if (historyContainsQueuedReply(history)) {
        return history;
      }
    } catch (error) {
      const retryDelayMs = resolveRetryableHistoryDelayMs(error);
      if (retryDelayMs === null) {
        throw error;
      }
      lastRetryableError = error;
      delayMs = retryDelayMs;
    }
    const remainingMs = HISTORY_RETRY_TIMEOUT_MS - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      break;
    }
    await sleep(Math.min(delayMs, remainingMs));
  }
  const observed = (latestHistory.messages ?? []).map((message) => ({
    role: message.role,
    text: messageText(message),
  }));
  const message = `timed out waiting for queued reply in chat.history after ${HISTORY_RETRY_TIMEOUT_MS}ms: ${JSON.stringify(observed)}`;
  throw lastRetryableError === undefined
    ? new Error(message)
    : new Error(message, { cause: lastRetryableError });
}

async function readClassifiedMockRequests(mockBaseUrl: string): Promise<ClassifiedMockRequest[]> {
  return fetch(`${mockBaseUrl}/debug/requests`)
    .then((response) => response.json() as Promise<MockRequestSnapshot[]>)
    .then((records) =>
      records.map(({ cursor, prompt, allInputText, model, outcome, errorCode }) => ({
        cursor,
        model,
        continuation:
          typeof prompt === "string" &&
          !prompt.includes(RECOVERY_PROMPT) &&
          !prompt.includes(QUEUED_PROMPT) &&
          typeof allInputText === "string" &&
          allInputText.includes(RECOVERY_PROMPT),
        prompt:
          typeof prompt === "string"
            ? prompt.includes(QUEUED_PROMPT)
              ? "queued"
              : typeof allInputText === "string" && allInputText.includes(RECOVERY_PROMPT)
                ? "recovery"
                : "other"
            : "missing",
        outcome,
        errorCode,
      })),
    );
}

async function readFailureEvidence(params: {
  gateway: Awaited<ReturnType<ReturnType<typeof createQaLiveLaneGateway>["start"]>>["gateway"];
  mockBaseUrl: string | undefined;
  sinceSeq: number;
}): Promise<string> {
  const events = (await readStability(params.gateway, params.sinceSeq)).events ?? [];
  const stability = events
    .filter(
      (event) =>
        typeof event.type === "string" &&
        (event.type.startsWith("session.") ||
          event.type === "message.queued" ||
          event.type === "model.call.started"),
    )
    .map(({ type, action, reason, outcome, ageMs, queueDepth, source }) => ({
      type,
      action,
      reason,
      outcome,
      ageMs,
      queueDepth,
      source,
    }));
  const requests = params.mockBaseUrl
    ? await readClassifiedMockRequests(params.mockBaseUrl).catch((error: unknown) => [
        { requestEvidenceError: String(error) },
      ])
    : [];
  const gatewayLogs = params.gateway
    .logs()
    .split("\n")
    .filter((line) =>
      /followup queue|reply run stale takeover|stuck session recovery|queue: active session/iu.test(
        line,
      ),
    )
    .slice(-100);
  return JSON.stringify({ stability, requests, gatewayLogs });
}

describe("Gateway repeated-request provider timeout", () => {
  it(
    "continues after a provider timeout and settles failure before draining one queued followup",
    { timeout: 510_000 },
    async () => {
      gatewayOwner = createQaLiveLaneGateway();
      harness = await gatewayOwner.start({
        repoRoot: process.cwd(),
        providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.6-luna",
        alternateModel: "mock-openai/gpt-5.6-luna-alt",
        transport: {
          requiredPluginIds: [],
          createGatewayConfig: () => ({
            messages: { queue: { mode: "followup" } },
          }),
        },
        transportBaseUrl: "http://127.0.0.1",
        controlUiEnabled: false,
        mutateConfig: (config) => {
          const models = config.models;
          const provider = models?.providers?.["mock-openai"];
          if (!models || !provider) {
            throw new Error("mock-openai provider config unavailable");
          }
          return {
            ...config,
            diagnostics: { enabled: true },
            models: {
              ...models,
              providers: {
                ...models.providers,
                "mock-openai": {
                  ...provider,
                  timeoutSeconds: MODEL_REQUEST_ALLOWANCE_SECONDS,
                },
              },
            },
          };
        },
      });
      const { gateway } = harness;

      const baseline = await readStability(gateway);
      const baselineSeq = typeof baseline.lastSeq === "number" ? baseline.lastSeq : 0;
      const sessionKey = `agent:qa:repeated-request-recovery-${randomUUID()}`;
      const active = (await gateway.call(
        "chat.send",
        {
          sessionKey,
          message: RECOVERY_PROMPT,
          deliver: false,
          idempotencyKey: randomUUID(),
        },
        { timeoutMs: 30_000 },
      )) as GatewayChatRun;
      expect(active).toMatchObject({ status: "started" });
      expect(typeof active.runId).toBe("string");

      await waitForStability(
        gateway,
        baselineSeq,
        (events) => events.filter((event) => event.type === "model.call.started").length >= 2,
        150_000,
      );

      const queued = (await gateway.call(
        "chat.send",
        {
          sessionKey,
          message: QUEUED_PROMPT,
          queueMode: "followup",
          deliver: false,
          idempotencyKey: randomUUID(),
        },
        { timeoutMs: 30_000 },
      )) as GatewayChatRun;
      expect(queued).toMatchObject({ status: "started" });
      expect(typeof queued.runId).toBe("string");

      // The provider deadline starts before model-call observation, so its diagnostic
      // duration can be shorter than timeoutSeconds. The failure kind owns timeout evidence.
      const events = await waitForStability(
        gateway,
        baselineSeq,
        (records) =>
          records.some(
            (event) => event.type === "model.call.error" && event.failureKind === "timeout",
          ),
        350_000,
      );
      const stalled = events.filter(
        (event) => event.type === "session.stalled" && event.reason === RECOVERY_REASON,
      );
      const requested = events.filter(
        (event) => event.type === "session.recovery.requested" && event.reason === RECOVERY_REASON,
      );
      const completed = events.filter((event) => event.type === "session.recovery.completed");

      expect(stalled).toHaveLength(1);
      expect(stalled[0]?.ageMs).toEqual(expect.any(Number));
      expect(stalled[0]?.ageMs as number).toBeGreaterThanOrEqual(PRODUCTION_RECOVERY_BOUND_MS);
      expect(requested).toEqual([]);
      expect(completed).toEqual([]);
      expect(
        events.filter((event) => event.type === "model.call.started").length,
      ).toBeGreaterThanOrEqual(5);

      const activeTerminal = (await gateway.call(
        "agent.wait",
        { runId: active.runId, timeoutMs: 30_000 },
        { timeoutMs: 35_000 },
      )) as GatewayChatRun;
      expect(activeTerminal).toMatchObject({
        status: "error",
        endedAt: expect.any(Number),
      });

      const history = await waitForQueuedReply(gateway, sessionKey).catch(
        async (error: unknown) => {
          const evidence = await readFailureEvidence({
            gateway,
            mockBaseUrl: harness?.mock?.baseUrl,
            sinceSeq: baselineSeq,
          });
          throw new Error(`${String(error)}; evidence=${evidence}`, { cause: error });
        },
      );
      expect(historyContainsQueuedReply(history)).toBe(true);
      const queuedTerminal = (await gateway.call(
        "agent.wait",
        { runId: queued.runId, timeoutMs: 30_000 },
        { timeoutMs: 35_000 },
      )) as GatewayChatRun;
      expect(queuedTerminal.status).toBe("ok");
      const mockBaseUrl = harness?.mock?.baseUrl;
      if (!mockBaseUrl) {
        throw new Error("mock provider request evidence unavailable");
      }
      const requests = await readClassifiedMockRequests(mockBaseUrl);
      const recoveryRequests = requests.filter((request) => request.prompt === "recovery");
      expect(recoveryRequests.length).toBeGreaterThanOrEqual(5);
      expect(recoveryRequests[0]?.model).toBe("gpt-5.6-luna");
      expect(recoveryRequests[1]?.model).toBe(recoveryRequests[0]?.model);
      expect(recoveryRequests).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            continuation: true,
            outcome: "error",
            errorCode: "response_failed_no_details",
          }),
        ]),
      );
      expect(requests.filter((request) => request.prompt === "queued")).toEqual([
        expect.objectContaining({ outcome: "success" }),
      ]);

      const finalEvents = (await readStability(gateway, baselineSeq)).events ?? [];
      expect(
        finalEvents.filter((event) => event.type === "session.recovery.requested"),
      ).toHaveLength(0);
      expect(
        finalEvents.filter((event) => event.type === "session.recovery.completed"),
      ).toHaveLength(0);
    },
  );
});

import { createHash } from "node:crypto";
import { once } from "node:events";
import { request, type IncomingMessage } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { WEBHOOK_RATE_LIMIT_DEFAULTS } from "openclaw/plugin-sdk/webhook-ingress";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const handleUpdateSpy = vi.hoisted(() => vi.fn((..._args: unknown[]): unknown => undefined));
const setWebhookSpy = vi.hoisted(() => vi.fn());
const deleteWebhookSpy = vi.hoisted(() => vi.fn(async () => true));
const initSpy = vi.hoisted(() => vi.fn(async () => undefined));
const stopSpy = vi.hoisted(() => vi.fn());
const createTelegramBotSpy = vi.hoisted(() =>
  vi.fn(() => ({
    init: initSpy,
    handleUpdate: handleUpdateSpy,
    api: { setWebhook: setWebhookSpy, deleteWebhook: deleteWebhookSpy },
    stop: stopSpy,
  })),
);

const WEBHOOK_POST_TIMEOUT_MS = process.platform === "win32" ? 20_000 : 8_000;
const TELEGRAM_TOKEN = "tok";
const TELEGRAM_SECRET = "secret";
const TELEGRAM_WEBHOOK_PATH = "/hook";
const WEBHOOK_TEST_YIELD_MS = 0;
const WEBHOOK_DRAIN_GUARD_MS = 5;
const TELEGRAM_WEBHOOK_RATE_LIMIT_BURST = WEBHOOK_RATE_LIMIT_DEFAULTS.maxRequests + 10;

function collectResponseBody(
  res: IncomingMessage,
  onDone: (payload: { statusCode: number; body: string }) => void,
): void {
  const chunks: Buffer[] = [];
  res.on("data", (chunk: Buffer | string) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  res.on("end", () => {
    onDone({
      statusCode: res.statusCode ?? 0,
      body: Buffer.concat(chunks).toString("utf-8"),
    });
  });
}

function createSingleSettlement<T>(params: {
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  clear: () => void;
}) {
  let settled = false;
  return {
    isSettled() {
      return settled;
    },
    resolve(value: T) {
      if (settled) {
        return;
      }
      settled = true;
      params.clear();
      params.resolve(value);
    },
    reject(error: unknown) {
      if (settled) {
        return;
      }
      settled = true;
      params.clear();
      params.reject(error);
    },
  };
}

vi.mock("grammy", async () => {
  const actual = await vi.importActual<typeof import("grammy")>("grammy");
  return {
    ...actual,
    API_CONSTANTS: actual.API_CONSTANTS ?? {
      DEFAULT_UPDATE_TYPES: ["message"],
      ALL_UPDATE_TYPES: ["message"],
    },
    InputFile:
      actual.InputFile ??
      class InputFile {
        constructor(public readonly path: string) {}
      },
    GrammyError:
      actual.GrammyError ??
      class GrammyError extends Error {
        description = "";
      },
  };
});

vi.mock("./bot.js", () => ({
  createTelegramBot: createTelegramBotSpy,
}));

let startTelegramWebhook: typeof import("./webhook.js").startTelegramWebhook;

function resetTelegramWebhookMocks(): void {
  handleUpdateSpy.mockReset();
  handleUpdateSpy.mockImplementation((..._args: unknown[]): unknown => undefined);

  setWebhookSpy.mockReset();
  deleteWebhookSpy.mockReset();
  deleteWebhookSpy.mockImplementation(async () => true);
  initSpy.mockReset();
  initSpy.mockImplementation(async () => undefined);
  stopSpy.mockReset();
  createTelegramBotSpy.mockReset();
  createTelegramBotSpy.mockImplementation(() => ({
    init: initSpy,
    handleUpdate: handleUpdateSpy,
    api: { setWebhook: setWebhookSpy, deleteWebhook: deleteWebhookSpy },
    stop: stopSpy,
  }));
}

type MockCallReader = { mock: { calls: unknown[][] } };

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label} to be an object`);
  }
  return value as Record<string, unknown>;
}

function requireMockCall(mock: unknown, index: number, label: string): unknown[] {
  const call = (mock as MockCallReader).mock.calls.at(index);
  if (!call) {
    throw new Error(`expected ${label} call ${index}`);
  }
  return call;
}

function mockMessages(mock: unknown): string[] {
  return (mock as MockCallReader).mock.calls.map((call) => {
    const message = call[0];
    return typeof message === "string" ? message : "";
  });
}

function expectMockMessageContains(mock: unknown, expected: string): void {
  expect(mockMessages(mock).some((message) => message.includes(expected))).toBe(true);
}

function expectStatusCall(
  mock: unknown,
  expected: Record<string, unknown>,
): Record<string, unknown> {
  const match = (mock as MockCallReader).mock.calls
    .map((call) => requireRecord(call[0], "status call"))
    .find((status) => Object.entries(expected).every(([key, value]) => status[key] === value));
  if (!match) {
    throw new Error(`expected status call containing ${JSON.stringify(expected)}`);
  }
  return match;
}

beforeAll(async () => {
  ({ startTelegramWebhook } = await import("./webhook.js"));
});

beforeEach(() => {
  resetTelegramWebhookMocks();
});

async function fetchWithTimeout(
  input: string,
  init: Omit<RequestInit, "signal">,
  timeoutMs: number,
): Promise<Response> {
  const abort = new AbortController();
  const timer = setTimeout(() => {
    abort.abort();
  }, timeoutMs);
  try {
    return await fetch(input, { ...init, signal: abort.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function postWebhookJson(params: {
  url: string;
  payload: string;
  secret?: string;
  timeoutMs?: number;
}): Promise<Response> {
  return await fetchWithTimeout(
    params.url,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(params.secret ? { "x-telegram-bot-api-secret-token": params.secret } : {}),
      },
      body: params.payload,
    },
    params.timeoutMs ?? 5_000,
  );
}

async function postWebhookHeadersOnly(params: {
  port: number;
  path: string;
  declaredLength: number;
  secret?: string;
  timeoutMs?: number;
}): Promise<{ statusCode: number; body: string }> {
  return await new Promise((resolve, reject) => {
    const settle = createSingleSettlement({
      resolve,
      reject,
      clear: () => clearTimeout(timeout),
    });

    const req = request(
      {
        hostname: "127.0.0.1",
        port: params.port,
        path: params.path,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(params.declaredLength),
          ...(params.secret ? { "x-telegram-bot-api-secret-token": params.secret } : {}),
        },
      },
      (res) => {
        collectResponseBody(res, (payload) => {
          settle.resolve(payload);
          req.destroy();
        });
      },
    );

    const timeout = setTimeout(() => {
      req.destroy(
        new Error(`webhook header-only post timed out after ${params.timeoutMs ?? 5_000}ms`),
      );
      settle.reject(new Error("timed out waiting for webhook response"));
    }, params.timeoutMs ?? 5_000);

    req.on("error", (error) => {
      if (settle.isSettled() && (error as NodeJS.ErrnoException).code === "ECONNRESET") {
        return;
      }
      settle.reject(error);
    });

    req.flushHeaders();
  });
}

function createDeterministicRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

async function postWebhookPayloadWithChunkPlan(params: {
  port: number;
  path: string;
  payload: string;
  secret: string;
  mode: "single" | "random-chunked";
  timeoutMs?: number;
}): Promise<{ statusCode: number; body: string }> {
  const payloadBuffer = Buffer.from(params.payload, "utf-8");
  return await new Promise((resolve, reject) => {
    let bytesQueued = 0;
    let chunksQueued = 0;
    let phase: "writing" | "awaiting-response" = "writing";
    const settle = createSingleSettlement({
      resolve,
      reject,
      clear: () => clearTimeout(timeout),
    });

    const req = request(
      {
        hostname: "127.0.0.1",
        port: params.port,
        path: params.path,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(payloadBuffer.length),
          "x-telegram-bot-api-secret-token": params.secret,
        },
      },
      (res) => {
        collectResponseBody(res, settle.resolve);
      },
    );

    const timeout = setTimeout(() => {
      settle.reject(
        new Error(
          `webhook post timed out after ${params.timeoutMs ?? 15_000}ms (phase=${phase}, bytesQueued=${bytesQueued}, chunksQueued=${chunksQueued}, totalBytes=${payloadBuffer.length})`,
        ),
      );
      req.destroy();
    }, params.timeoutMs ?? 15_000);

    req.on("error", (error) => {
      settle.reject(error);
    });

    const writeAll = async () => {
      if (params.mode === "single") {
        req.end(payloadBuffer);
        return;
      }

      const rng = createDeterministicRng(26156);
      let offset = 0;
      while (offset < payloadBuffer.length) {
        const remaining = payloadBuffer.length - offset;
        const nextSize = Math.max(1, Math.min(remaining, 1 + Math.floor(rng() * 8_192)));
        const chunk = payloadBuffer.subarray(offset, offset + nextSize);
        const canContinue = req.write(chunk);
        offset += nextSize;
        bytesQueued = offset;
        chunksQueued += 1;
        if (chunksQueued % 10 === 0) {
          await sleep(WEBHOOK_TEST_YIELD_MS);
        }
        if (!canContinue) {
          // Windows CI occasionally stalls on waiting for drain indefinitely.
          // Bound the wait, then continue queuing this small (~1MB) payload.
          await Promise.race([once(req, "drain"), sleep(WEBHOOK_DRAIN_GUARD_MS)]);
        }
      }
      phase = "awaiting-response";
      req.end();
    };

    void writeAll().catch((error) => {
      settle.reject(error);
    });
  });
}

function createNearLimitTelegramPayload(): { payload: string; sizeBytes: number } {
  const maxBytes = 1_024 * 1_024;
  const targetBytes = maxBytes - 4_096;
  const shell = { update_id: 77_777, message: { text: "" } };
  const shellSize = Buffer.byteLength(JSON.stringify(shell), "utf-8");
  const textLength = Math.max(1, targetBytes - shellSize);
  const pattern = "the quick brown fox jumps over the lazy dog ";
  const repeats = Math.ceil(textLength / pattern.length);
  const text = pattern.repeat(repeats).slice(0, textLength);
  const payload = JSON.stringify({
    update_id: 77_777,
    message: { text },
  });
  return { payload, sizeBytes: Buffer.byteLength(payload, "utf-8") };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

type StartWebhookOptions = Omit<
  Parameters<typeof startTelegramWebhook>[0],
  "token" | "port" | "abortSignal"
>;

type StartedWebhook = Awaited<ReturnType<typeof startTelegramWebhook>>;

function getServerPort(server: StartedWebhook["server"]): number {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("no addr");
  }
  return address.port;
}

function webhookUrl(port: number, webhookPath: string): string {
  return `http://127.0.0.1:${port}${webhookPath}`;
}

async function withStartedWebhook<T>(
  options: StartWebhookOptions,
  run: (ctx: { server: StartedWebhook["server"]; port: number }) => Promise<T>,
): Promise<T> {
  const abort = new AbortController();
  const started = await startTelegramWebhook({
    token: TELEGRAM_TOKEN,
    port: 0,
    abortSignal: abort.signal,
    ...options,
  });
  try {
    return await run({ server: started.server, port: getServerPort(started.server) });
  } finally {
    abort.abort();
  }
}

function expectSingleNearLimitUpdate(params: {
  seenUpdates: Array<{ update_id: number; message: { text: string } }>;
  expected: { update_id: number; message: { text: string } };
}) {
  expect(params.seenUpdates).toHaveLength(1);
  expect(params.seenUpdates[0]?.update_id).toBe(params.expected.update_id);
  expect(params.seenUpdates[0]?.message.text.length).toBe(params.expected.message.text.length);
  expect(sha256(params.seenUpdates[0]?.message.text ?? "")).toBe(
    sha256(params.expected.message.text),
  );
}

async function runNearLimitPayloadTestAndExpectUpdate(
  mode: "single" | "random-chunked",
): Promise<void> {
  const seenUpdates: Array<{ update_id: number; message: { text: string } }> = [];
  handleUpdateSpy.mockImplementationOnce((update: unknown) => {
    seenUpdates.push(update as { update_id: number; message: { text: string } });
  });

  const { payload, sizeBytes } = createNearLimitTelegramPayload();
  expect(sizeBytes).toBeLessThan(1_024 * 1_024);
  expect(sizeBytes).toBeGreaterThan(256 * 1_024);
  const expected = JSON.parse(payload) as { update_id: number; message: { text: string } };

  await withStartedWebhook(
    {
      secret: TELEGRAM_SECRET,
      path: TELEGRAM_WEBHOOK_PATH,
    },
    async ({ port }) => {
      const response = await postWebhookPayloadWithChunkPlan({
        port,
        path: TELEGRAM_WEBHOOK_PATH,
        payload,
        secret: TELEGRAM_SECRET,
        mode,
        timeoutMs: WEBHOOK_POST_TIMEOUT_MS,
      });

      expect(response.statusCode).toBe(200);
      await vi.waitFor(() => expectSingleNearLimitUpdate({ seenUpdates, expected }));
    },
  );
}

describe("startTelegramWebhook", () => {
  it("starts server, registers webhook, and serves health", async () => {
    initSpy.mockClear();
    createTelegramBotSpy.mockClear();
    const runtimeLog = vi.fn();
    const setStatus = vi.fn();
    const cfg = { bindings: [] };
    await withStartedWebhook(
      {
        secret: TELEGRAM_SECRET,
        accountId: "opie",
        config: cfg,
        runtime: { log: runtimeLog, error: vi.fn(), exit: vi.fn() },
        setStatus,
      },
      async ({ port }) => {
        const botParams = requireRecord(
          requireMockCall(createTelegramBotSpy, 0, "createTelegramBot")[0],
          "createTelegramBot params",
        );
        expect(botParams.accountId).toBe("opie");
        expect(requireRecord(botParams.config, "telegram config").bindings).toEqual([]);
        const health = await fetch(`http://127.0.0.1:${port}/healthz`);
        expect(health.status).toBe(200);
        expect(initSpy).toHaveBeenCalledTimes(1);
        expect(setWebhookSpy).toHaveBeenCalled();
        expectMockMessageContains(runtimeLog, "webhook local listener on http://127.0.0.1:");
        expectMockMessageContains(runtimeLog, "/telegram-webhook");
        expectMockMessageContains(runtimeLog, "webhook advertised to telegram on http://");
        expect(setStatus).toHaveBeenNthCalledWith(1, {
          mode: "webhook",
          connected: false,
          lastConnectedAt: null,
          lastEventAt: null,
          lastTransportActivityAt: null,
        });
        const connectedStatus = requireRecord(
          requireMockCall(setStatus, 1, "setStatus")[0],
          "connected status",
        );
        expect(connectedStatus.mode).toBe("webhook");
        expect(connectedStatus.connected).toBe(true);
        expect(typeof connectedStatus.lastConnectedAt).toBe("number");
        expect(typeof connectedStatus.lastEventAt).toBe("number");
        expect(connectedStatus.lastError).toBeNull();
      },
    );
  });

  it("keeps local listener alive and retries when setWebhook has a recoverable startup failure", async () => {
    const runtimeLog = vi.fn();
    const runtimeError = vi.fn();
    const setStatus = vi.fn();
    setWebhookSpy.mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(true);

    await withStartedWebhook(
      {
        secret: TELEGRAM_SECRET,
        path: TELEGRAM_WEBHOOK_PATH,
        runtime: { log: runtimeLog, error: runtimeError, exit: vi.fn() },
        setStatus,
        webhookRegistrationRetryPolicy: {
          initialMs: 0,
          maxMs: 0,
          factor: 1,
          jitter: 0,
        },
      },
      async ({ port }) => {
        const health = await fetch(`http://127.0.0.1:${port}/healthz`);
        expect(health.status).toBe(200);
        expect(stopSpy).not.toHaveBeenCalled();
        expectMockMessageContains(runtimeError, "telegram setWebhook failed: fetch failed");
        await vi.waitFor(() => expect(setWebhookSpy).toHaveBeenCalledTimes(2));
        expect(runtimeLog).toHaveBeenCalledWith("telegram setWebhook retry 1 scheduled in 0ms");
        expectMockMessageContains(runtimeLog, "webhook advertised to telegram on http://");
        expect(setStatus).toHaveBeenCalledWith({
          mode: "webhook",
          connected: false,
          lastError: "fetch failed",
        });
        expectStatusCall(setStatus, { mode: "webhook", connected: true, lastError: null });
      },
    );
  });

  it("fails startup when setWebhook has a non-recoverable rejection", async () => {
    const runtimeError = vi.fn();
    const error = Object.assign(new Error("unauthorized"), { error_code: 401 });
    setWebhookSpy.mockRejectedValueOnce(error);

    await expect(
      startTelegramWebhook({
        token: TELEGRAM_TOKEN,
        port: 0,
        secret: TELEGRAM_SECRET,
        path: TELEGRAM_WEBHOOK_PATH,
        runtime: { log: vi.fn(), error: runtimeError, exit: vi.fn() },
      }),
    ).rejects.toThrow("unauthorized");

    expect(stopSpy).toHaveBeenCalledTimes(1);
    expectMockMessageContains(runtimeError, "telegram setWebhook failed: unauthorized");
  });

  it("registers webhook with certificate when webhookCertPath is provided", async () => {
    setWebhookSpy.mockClear();
    await withStartedWebhook(
      {
        secret: TELEGRAM_SECRET,
        path: TELEGRAM_WEBHOOK_PATH,
        webhookCertPath: "/path/to/cert.pem",
      },
      async () => {
        const setWebhookCall = requireMockCall(setWebhookSpy, 0, "setWebhook");
        expect(typeof setWebhookCall[0]).toBe("string");
        const options = requireRecord(setWebhookCall[1], "setWebhook options");
        expect(options.certificate).toBeTruthy();
        const certificate = options.certificate as
          | { path?: string; fileData?: string; filename?: string }
          | undefined;
        if (!certificate) {
          throw new Error("expected Telegram webhook certificate payload");
        }
        if (certificate && "path" in certificate && typeof certificate.path === "string") {
          expect(certificate.path).toBe("/path/to/cert.pem");
        } else {
          expect(certificate.fileData).toBe("/path/to/cert.pem");
          expect(certificate.filename).toBe("cert.pem");
        }
      },
    );
  });

  it("invokes webhook handler on matching path", async () => {
    handleUpdateSpy.mockClear();
    createTelegramBotSpy.mockClear();
    const setStatus = vi.fn();
    const cfg = { bindings: [] };
    await withStartedWebhook(
      {
        secret: TELEGRAM_SECRET,
        accountId: "opie",
        config: cfg,
        path: TELEGRAM_WEBHOOK_PATH,
        setStatus,
      },
      async ({ port }) => {
        const botParams = requireRecord(
          requireMockCall(createTelegramBotSpy, 0, "createTelegramBot")[0],
          "createTelegramBot params",
        );
        expect(botParams.accountId).toBe("opie");
        expect(requireRecord(botParams.config, "telegram config").bindings).toEqual([]);
        const payload = JSON.stringify({ update_id: 1, message: { text: "hello" } });
        const response = await postWebhookJson({
          url: webhookUrl(port, TELEGRAM_WEBHOOK_PATH),
          payload,
          secret: TELEGRAM_SECRET,
        });
        expect(response.status).toBe(200);
        await vi.waitFor(() => expect(handleUpdateSpy).toHaveBeenCalledWith(JSON.parse(payload)));
        expectStatusCall(setStatus, { mode: "webhook", connected: true, lastError: null });
      },
    );
  });

  it("acks before webhook update processing finishes", async () => {
    let finishWork: (() => void) | undefined;
    let workStarted = false;
    let workFinished = false;
    handleUpdateSpy.mockImplementationOnce(async (update: unknown) => {
      expect(update).toEqual({ update_id: 2, message: { text: "slow" } });
      workStarted = true;
      await new Promise<void>((resolve) => {
        finishWork = resolve;
      });
      workFinished = true;
    });

    await withStartedWebhook(
      {
        secret: TELEGRAM_SECRET,
        path: TELEGRAM_WEBHOOK_PATH,
      },
      async ({ port }) => {
        const response = await postWebhookJson({
          url: webhookUrl(port, TELEGRAM_WEBHOOK_PATH),
          payload: JSON.stringify({ update_id: 2, message: { text: "slow" } }),
          secret: TELEGRAM_SECRET,
          timeoutMs: 1_000,
        });

        expect(response.status).toBe(200);
        expect(await response.text()).toBe("");
        await vi.waitFor(() => expect(workStarted).toBe(true));
        expect(workFinished).toBe(false);

        finishWork?.();
        await vi.waitFor(() => expect(workFinished).toBe(true));
      },
    );
  });

  it("logs update processing failures after acknowledging Telegram", async () => {
    const runtimeLog = vi.fn();
    handleUpdateSpy.mockRejectedValueOnce(new Error("agent turn failed"));

    await withStartedWebhook(
      {
        secret: TELEGRAM_SECRET,
        path: TELEGRAM_WEBHOOK_PATH,
        runtime: { log: runtimeLog, error: vi.fn(), exit: vi.fn() },
      },
      async ({ port }) => {
        const response = await postWebhookJson({
          url: webhookUrl(port, TELEGRAM_WEBHOOK_PATH),
          payload: JSON.stringify({ update_id: 3, message: { text: "boom" } }),
          secret: TELEGRAM_SECRET,
        });

        expect(response.status).toBe(200);
        expect(await response.text()).toBe("");
        await vi.waitFor(() =>
          expectMockMessageContains(
            runtimeLog,
            "webhook update processing failed after ack: agent turn failed",
          ),
        );
      },
    );
  });

  it("rejects unauthenticated requests before reading the request body", async () => {
    handleUpdateSpy.mockClear();
    await withStartedWebhook(
      {
        secret: TELEGRAM_SECRET,
        path: TELEGRAM_WEBHOOK_PATH,
      },
      async ({ port }) => {
        const response = await postWebhookHeadersOnly({
          port,
          path: TELEGRAM_WEBHOOK_PATH,
          declaredLength: 1_024 * 1_024,
          secret: "wrong-secret",
        });

        expect(response.statusCode).toBe(401);
        expect(response.body).toBe("unauthorized");
        expect(handleUpdateSpy).not.toHaveBeenCalled();
      },
    );
  });

  it("rate limits repeated invalid secret guesses before authentication succeeds", async () => {
    handleUpdateSpy.mockClear();
    await withStartedWebhook(
      {
        secret: TELEGRAM_SECRET,
        path: TELEGRAM_WEBHOOK_PATH,
      },
      async ({ port }) => {
        let saw429 = false;

        for (let i = 0; i < TELEGRAM_WEBHOOK_RATE_LIMIT_BURST; i += 1) {
          const response = await postWebhookJson({
            url: webhookUrl(port, TELEGRAM_WEBHOOK_PATH),
            payload: JSON.stringify({ update_id: i, message: { text: `guess ${i}` } }),
            secret: `wrong-secret-${String(i).padStart(3, "0")}`,
          });

          if (response.status === 429) {
            saw429 = true;
            expect(await response.text()).toBe("Too Many Requests");
            break;
          }

          expect(response.status).toBe(401);
          expect(await response.text()).toBe("unauthorized");
        }

        expect(saw429).toBe(true);

        const validResponse = await postWebhookJson({
          url: webhookUrl(port, TELEGRAM_WEBHOOK_PATH),
          payload: JSON.stringify({ update_id: 999, message: { text: "hello" } }),
          secret: TELEGRAM_SECRET,
        });
        expect(validResponse.status).toBe(429);
        expect(await validResponse.text()).toBe("Too Many Requests");
        expect(handleUpdateSpy).not.toHaveBeenCalled();
      },
    );
  });

  it("uses the forwarded client ip when trusted proxies are configured", async () => {
    handleUpdateSpy.mockClear();
    await withStartedWebhook(
      {
        secret: TELEGRAM_SECRET,
        path: TELEGRAM_WEBHOOK_PATH,
        config: {
          gateway: {
            trustedProxies: ["127.0.0.1"],
          },
        },
      },
      async ({ port }) => {
        for (let i = 0; i < TELEGRAM_WEBHOOK_RATE_LIMIT_BURST; i += 1) {
          const response = await fetchWithTimeout(
            webhookUrl(port, TELEGRAM_WEBHOOK_PATH),
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-forwarded-for": "198.51.100.10",
                "x-telegram-bot-api-secret-token": `wrong-secret-${String(i).padStart(3, "0")}`,
              },
              body: JSON.stringify({ update_id: i, message: { text: `guess ${i}` } }),
            },
            5_000,
          );
          if (response.status === 429) {
            break;
          }
          expect(response.status).toBe(401);
        }

        const isolatedClient = await fetchWithTimeout(
          webhookUrl(port, TELEGRAM_WEBHOOK_PATH),
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-forwarded-for": "203.0.113.20",
              "x-telegram-bot-api-secret-token": TELEGRAM_SECRET,
            },
            body: JSON.stringify({ update_id: 201, message: { text: "hello" } }),
          },
          5_000,
        );

        expect(isolatedClient.status).toBe(200);
        await vi.waitFor(() => expect(handleUpdateSpy).toHaveBeenCalledTimes(1));
      },
    );
  });

  it("keeps rate-limit state isolated per webhook listener", async () => {
    handleUpdateSpy.mockClear();
    const firstAbort = new AbortController();
    const secondAbort = new AbortController();
    const first = await startTelegramWebhook({
      token: TELEGRAM_TOKEN,
      port: 0,
      abortSignal: firstAbort.signal,
      secret: TELEGRAM_SECRET,
      path: TELEGRAM_WEBHOOK_PATH,
    });
    const second = await startTelegramWebhook({
      token: TELEGRAM_TOKEN,
      port: 0,
      abortSignal: secondAbort.signal,
      secret: TELEGRAM_SECRET,
      path: TELEGRAM_WEBHOOK_PATH,
    });

    try {
      const firstPort = getServerPort(first.server);
      const secondPort = getServerPort(second.server);

      for (let i = 0; i < TELEGRAM_WEBHOOK_RATE_LIMIT_BURST; i += 1) {
        const response = await postWebhookJson({
          url: webhookUrl(firstPort, TELEGRAM_WEBHOOK_PATH),
          payload: JSON.stringify({ update_id: i, message: { text: `guess ${i}` } }),
          secret: `wrong-secret-${String(i).padStart(3, "0")}`,
        });
        if (response.status === 429) {
          break;
        }
      }

      const secondResponse = await postWebhookJson({
        url: webhookUrl(secondPort, TELEGRAM_WEBHOOK_PATH),
        payload: JSON.stringify({ update_id: 301, message: { text: "hello" } }),
        secret: TELEGRAM_SECRET,
      });

      expect(secondResponse.status).toBe(200);
      await vi.waitFor(() => expect(handleUpdateSpy).toHaveBeenCalledTimes(1));
    } finally {
      firstAbort.abort();
      secondAbort.abort();
    }
  });

  it("rejects startup when webhook secret is missing", async () => {
    await expect(
      startTelegramWebhook({
        token: "tok",
      }),
    ).rejects.toThrow(/requires a non-empty secret token/i);
  });

  it("registers webhook using the bound listening port when port is 0", async () => {
    setWebhookSpy.mockClear();
    const runtimeLog = vi.fn();
    await withStartedWebhook(
      {
        secret: TELEGRAM_SECRET,
        path: TELEGRAM_WEBHOOK_PATH,
        runtime: { log: runtimeLog, error: vi.fn(), exit: vi.fn() },
      },
      async ({ port }) => {
        expect(port).toBeGreaterThan(0);
        expect(setWebhookSpy).toHaveBeenCalledTimes(1);
        const setWebhookCall = requireMockCall(setWebhookSpy, 0, "setWebhook");
        expect(setWebhookCall[0]).toBe(webhookUrl(port, TELEGRAM_WEBHOOK_PATH));
        expect(requireRecord(setWebhookCall[1], "setWebhook options").secret_token).toBe(
          TELEGRAM_SECRET,
        );
        expect(runtimeLog).toHaveBeenCalledWith(
          `webhook local listener on ${webhookUrl(port, TELEGRAM_WEBHOOK_PATH)}`,
        );
      },
    );
  });

  it("keeps webhook payload readable when update processing is delayed", async () => {
    let seenUpdate: unknown;
    handleUpdateSpy.mockImplementationOnce(async (update: unknown) => {
      await sleep(WEBHOOK_TEST_YIELD_MS);
      seenUpdate = update;
    });

    await withStartedWebhook(
      {
        secret: TELEGRAM_SECRET,
        path: TELEGRAM_WEBHOOK_PATH,
      },
      async ({ port }) => {
        const payload = JSON.stringify({ update_id: 1, message: { text: "hello" } });
        const res = await postWebhookJson({
          url: webhookUrl(port, TELEGRAM_WEBHOOK_PATH),
          payload,
          secret: TELEGRAM_SECRET,
        });
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("");
        await vi.waitFor(() => expect(seenUpdate).toEqual(JSON.parse(payload)));
      },
    );
  });

  it("keeps webhook payload readable across multiple delayed reads", async () => {
    const seenPayloads: string[] = [];
    const delayedHandler = async (update: unknown) => {
      await sleep(WEBHOOK_TEST_YIELD_MS);
      seenPayloads.push(JSON.stringify(update));
    };
    handleUpdateSpy.mockImplementationOnce(delayedHandler).mockImplementationOnce(delayedHandler);

    await withStartedWebhook(
      {
        secret: TELEGRAM_SECRET,
        path: TELEGRAM_WEBHOOK_PATH,
      },
      async ({ port }) => {
        const payloads = [
          JSON.stringify({ update_id: 1, message: { text: "first" } }),
          JSON.stringify({ update_id: 2, message: { text: "second" } }),
        ];

        for (const payload of payloads) {
          const res = await postWebhookJson({
            url: webhookUrl(port, TELEGRAM_WEBHOOK_PATH),
            payload,
            secret: TELEGRAM_SECRET,
          });
          expect(res.status).toBe(200);
        }

        await vi.waitFor(() =>
          expect(seenPayloads.map((x) => JSON.parse(x))).toEqual(
            payloads.map((x) => JSON.parse(x)),
          ),
        );
      },
    );
  });

  it("processes a second request after first-request delayed-init data loss", async () => {
    const seenUpdates: unknown[] = [];
    handleUpdateSpy.mockImplementation(async (update: unknown) => {
      await sleep(WEBHOOK_TEST_YIELD_MS);
      seenUpdates.push(update);
    });

    await withStartedWebhook(
      {
        secret: TELEGRAM_SECRET,
        path: TELEGRAM_WEBHOOK_PATH,
      },
      async ({ port }) => {
        const firstPayload = JSON.stringify({ update_id: 100, message: { text: "first" } });
        const secondPayload = JSON.stringify({ update_id: 101, message: { text: "second" } });
        const firstResponse = await postWebhookPayloadWithChunkPlan({
          port,
          path: TELEGRAM_WEBHOOK_PATH,
          payload: firstPayload,
          secret: TELEGRAM_SECRET,
          mode: "single",
          timeoutMs: WEBHOOK_POST_TIMEOUT_MS,
        });
        const secondResponse = await postWebhookPayloadWithChunkPlan({
          port,
          path: TELEGRAM_WEBHOOK_PATH,
          payload: secondPayload,
          secret: TELEGRAM_SECRET,
          mode: "single",
          timeoutMs: WEBHOOK_POST_TIMEOUT_MS,
        });

        expect(firstResponse.statusCode).toBe(200);
        expect(secondResponse.statusCode).toBe(200);
        await vi.waitFor(() =>
          expect(seenUpdates).toEqual([JSON.parse(firstPayload), JSON.parse(secondPayload)]),
        );
      },
    );
  });

  it("handles near-limit payload with random chunk writes and event-loop yields", async () => {
    await runNearLimitPayloadTestAndExpectUpdate("random-chunked");
  });

  it("handles near-limit payload written in a single request write", async () => {
    await runNearLimitPayloadTestAndExpectUpdate("single");
  });

  it("rejects payloads larger than 1MB before invoking webhook handler", async () => {
    handleUpdateSpy.mockClear();
    await withStartedWebhook(
      {
        secret: TELEGRAM_SECRET,
        path: TELEGRAM_WEBHOOK_PATH,
      },
      async ({ port }) => {
        const responseOrError = await new Promise<
          | { kind: "response"; statusCode: number; body: string }
          | { kind: "error"; code: string | undefined }
        >((resolve) => {
          const req = request(
            {
              hostname: "127.0.0.1",
              port,
              path: TELEGRAM_WEBHOOK_PATH,
              method: "POST",
              headers: {
                "content-type": "application/json",
                "content-length": String(1_024 * 1_024 + 2_048),
                "x-telegram-bot-api-secret-token": TELEGRAM_SECRET,
              },
            },
            (res) => {
              collectResponseBody(res, (payload) => {
                resolve({ kind: "response", ...payload });
              });
            },
          );
          req.on("error", (error: NodeJS.ErrnoException) => {
            resolve({ kind: "error", code: error.code });
          });
          req.end("{}");
        });

        if (responseOrError.kind === "response") {
          expect(responseOrError.statusCode).toBe(413);
          expect(responseOrError.body).toBe("Payload too large");
        } else {
          expect(responseOrError.code).toBeOneOf(["ECONNRESET", "EPIPE"]);
        }
        expect(handleUpdateSpy).not.toHaveBeenCalled();
      },
    );
  });

  it("de-registers webhook when shutting down", async () => {
    deleteWebhookSpy.mockClear();
    const abort = new AbortController();
    await startTelegramWebhook({
      token: TELEGRAM_TOKEN,
      secret: TELEGRAM_SECRET,
      port: 0,
      abortSignal: abort.signal,
      path: TELEGRAM_WEBHOOK_PATH,
    });

    abort.abort();
    expect(deleteWebhookSpy).toHaveBeenCalledTimes(1);
    expect(deleteWebhookSpy).toHaveBeenCalledWith({ drop_pending_updates: false });
  });
});

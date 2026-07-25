// Telegram tests cover webhook plugin behavior.
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import { request, type IncomingMessage } from "node:http";
import os from "node:os";
import nodePath from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests as createChannelIngressQueue,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { WEBHOOK_RATE_LIMIT_DEFAULTS } from "openclaw/plugin-sdk/webhook-ingress";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTelegramSpooledReplayDeferredParticipant,
  type TelegramSpooledReplayDeferredParticipant,
  type TelegramSpooledReplaySettlementHold,
} from "./bot-processing-outcome.js";
import { setTelegramRuntime } from "./runtime.js";
import { clearTelegramRuntimeForTest as clearTelegramRuntime } from "./runtime.test-support.js";
import type { TelegramRuntime } from "./runtime.types.js";
import { writeTelegramSpooledUpdate } from "./telegram-ingress-spool.js";
import {
  listTelegramSpooledUpdateClaims,
  listTelegramSpooledUpdates,
} from "./telegram-ingress-spool.test-support.js";

const telegramSpooledRetryDeadLetterMinAgeMs = 24 * 60 * 60 * 1000;

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
const transportCloseSpies = vi.hoisted(() => [] as Array<ReturnType<typeof vi.fn>>);
const resolveTelegramTransportSpy = vi.hoisted(() =>
  vi.fn(() => {
    const close = vi.fn(async () => undefined);
    transportCloseSpies.push(close);
    return {
      fetch: globalThis.fetch,
      sourceFetch: globalThis.fetch,
      close,
    };
  }),
);

const WEBHOOK_POST_TIMEOUT_MS = process.platform === "win32" ? 20_000 : 8_000;
const TELEGRAM_TOKEN = "tok";
const TELEGRAM_SECRET = "secret";
const TELEGRAM_WEBHOOK_PATH = "/hook";
const WEBHOOK_DRAIN_GUARD_MS = 5;
const TELEGRAM_WEBHOOK_RATE_LIMIT_BURST = WEBHOOK_RATE_LIMIT_DEFAULTS.maxRequests + 10;

async function waitForWebhookState<T>(
  assertion: () => T | Promise<T>,
  options: { timeout?: number; interval?: number } = {},
): Promise<T> {
  return await vi.waitFor(assertion, { interval: 1, ...options });
}

async function yieldWebhookTask(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

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

vi.mock("./fetch.js", () => ({
  resolveTelegramTransport: resolveTelegramTransportSpy,
}));

let startTelegramWebhook: typeof import("./webhook.js").startTelegramWebhook;
let webhookStateDir: string | undefined;
let webhookSpoolDir: string | undefined;

function installTelegramIngressQueueRuntime(resolveStateDir: () => string): void {
  setTelegramRuntime({
    state: {
      resolveStateDir,
      openChannelIngressQueue: (
        options?: Omit<Parameters<typeof createChannelIngressQueue>[0], "channelId">,
      ) => createChannelIngressQueue({ ...options, channelId: "telegram" }),
    },
  } as TelegramRuntime);
}

function requireWebhookSpoolDir(): string {
  if (!webhookSpoolDir) {
    throw new Error("webhook spool dir not initialized");
  }
  return webhookSpoolDir;
}

function resetTelegramWebhookMocks(): void {
  handleUpdateSpy.mockReset();
  handleUpdateSpy.mockImplementation((..._args: unknown[]): unknown => undefined);

  setWebhookSpy.mockReset();
  deleteWebhookSpy.mockReset();
  deleteWebhookSpy.mockImplementation(async () => true);
  initSpy.mockReset();
  initSpy.mockImplementation(async () => undefined);
  stopSpy.mockReset();
  resolveTelegramTransportSpy.mockClear();
  transportCloseSpies.length = 0;
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
  expect(mockMessages(mock).join("\n")).toContain(expected);
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

beforeEach(async () => {
  resetTelegramWebhookMocks();
  webhookStateDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "openclaw-telegram-webhook-"));
  webhookSpoolDir = nodePath.join(webhookStateDir, "telegram", "ingress-spool-test");
  await fs.mkdir(webhookSpoolDir, { recursive: true });
  installTelegramIngressQueueRuntime(() => webhookStateDir ?? os.tmpdir());
});

afterEach(async () => {
  vi.useRealTimers();
  clearTelegramRuntime();
  closeOpenClawStateDatabaseForTest();
  const stateDir = webhookStateDir;
  webhookStateDir = undefined;
  webhookSpoolDir = undefined;
  if (stateDir) {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
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
        collectResponseBody(res, settle["resolve"]);
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
          await yieldWebhookTask();
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

    void writeAll().catch((error: unknown) => {
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
    spoolDir: options.spoolDir ?? requireWebhookSpoolDir(),
    ...options,
  });
  try {
    return await run({ server: started.server, port: getServerPort(started.server) });
  } finally {
    await started.stop();
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
      await waitForWebhookState(() => expectSingleNearLimitUpdate({ seenUpdates, expected }));
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
        expect(botParams.telegramTransport).toBeDefined();
        const health = await fetch(`http://127.0.0.1:${port}/healthz`);
        expect(health.status).toBe(200);
        expect(health.headers.get("x-openclaw-delivery-accepted")).toBeNull();
        const notFound = await fetch(`http://127.0.0.1:${port}/not-the-webhook`);
        expect(notFound.status).toBe(404);
        expect(notFound.headers.get("x-openclaw-delivery-accepted")).toBeNull();
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

  it("aborts bot media fetches when the webhook stops", async () => {
    const callerAbort = new AbortController();
    const started = await startTelegramWebhook({
      token: TELEGRAM_TOKEN,
      secret: TELEGRAM_SECRET,
      port: 0,
      abortSignal: callerAbort.signal,
      path: TELEGRAM_WEBHOOK_PATH,
      spoolDir: requireWebhookSpoolDir(),
    });

    try {
      const botParams = requireRecord(
        requireMockCall(createTelegramBotSpy, 0, "createTelegramBot")[0],
        "createTelegramBot params",
      );
      const fetchAbortSignal = botParams.fetchAbortSignal;
      expect(fetchAbortSignal).toBeInstanceOf(AbortSignal);
      if (!(fetchAbortSignal instanceof AbortSignal)) {
        throw new Error("expected bot fetch abort signal");
      }
      const aborted = new Promise<void>((resolve) => {
        fetchAbortSignal.addEventListener("abort", () => resolve(), { once: true });
      });

      await started.stop();

      await expect(aborted).resolves.toBeUndefined();
      expect(callerAbort.signal.aborted).toBe(false);
    } finally {
      await started.stop();
      callerAbort.abort();
    }
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
        await waitForWebhookState(() => expect(setWebhookSpy).toHaveBeenCalledTimes(2));
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
    expect(transportCloseSpies[0]).toHaveBeenCalledTimes(1);
    expectMockMessageContains(runtimeError, "telegram setWebhook failed: unauthorized");
  });

  it("stops local listener and bot when retry loop encounters a non-recoverable error", async () => {
    const runtimeError = vi.fn();
    const setStatus = vi.fn();
    const unauthorizedError = Object.assign(new Error("unauthorized"), { error_code: 401 });
    setWebhookSpy
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockRejectedValueOnce(unauthorizedError);

    const started = await startTelegramWebhook({
      token: TELEGRAM_TOKEN,
      port: 0,
      secret: TELEGRAM_SECRET,
      path: TELEGRAM_WEBHOOK_PATH,
      spoolDir: requireWebhookSpoolDir(),
      runtime: { log: vi.fn(), error: runtimeError, exit: vi.fn() },
      setStatus,
      webhookRegistrationRetryPolicy: {
        initialMs: 0,
        maxMs: 0,
        factor: 1,
        jitter: 0,
      },
    });

    try {
      await waitForWebhookState(() => {
        expect(started.server.listening).toBe(false);
        expect(stopSpy).toHaveBeenCalledTimes(1);
        expect(transportCloseSpies[0]).toHaveBeenCalledTimes(1);
      });
      expect(setStatus).toHaveBeenLastCalledWith({ mode: "webhook", connected: false });
      expectMockMessageContains(
        runtimeError,
        "telegram setWebhook retry stopped after non-recoverable error",
      );

      await started.stop();
      expect(stopSpy).toHaveBeenCalledTimes(1);
      expect(transportCloseSpies[0]).toHaveBeenCalledTimes(1);
    } finally {
      await started.stop();
    }
  });

  it("retries transient getMe startup init failures before starting the account", async () => {
    const runtimeLog = vi.fn();
    initSpy.mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(undefined);

    await withStartedWebhook(
      {
        secret: TELEGRAM_SECRET,
        path: TELEGRAM_WEBHOOK_PATH,
        runtime: { log: runtimeLog, error: vi.fn(), exit: vi.fn() },
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
      },
    );

    expect(initSpy).toHaveBeenCalledTimes(2);
    expect(runtimeLog).toHaveBeenCalledWith("telegram getMe retry 1 scheduled in 0ms");
    expect(setWebhookSpy).toHaveBeenCalledTimes(1);
  });

  it("fails startup on non-recoverable getMe errors", async () => {
    const runtimeError = vi.fn();
    const error = Object.assign(new Error("unauthorized"), { error_code: 401 });
    initSpy.mockRejectedValueOnce(error);

    await expect(
      startTelegramWebhook({
        token: TELEGRAM_TOKEN,
        port: 0,
        secret: TELEGRAM_SECRET,
        path: TELEGRAM_WEBHOOK_PATH,
        spoolDir: requireWebhookSpoolDir(),
        runtime: { log: vi.fn(), error: runtimeError, exit: vi.fn() },
      }),
    ).rejects.toThrow("unauthorized");

    expect(setWebhookSpy).not.toHaveBeenCalled();
    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(transportCloseSpies[0]).toHaveBeenCalledTimes(1);
    expectMockMessageContains(runtimeError, "telegram getMe failed: unauthorized");
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
        expect(response.headers.get("x-openclaw-delivery-accepted")).toBe("durable");
        expect(await response.text()).toBe("");
        await waitForWebhookState(() => expect(workStarted).toBe(true));
        expect(workFinished).toBe(false);

        finishWork?.();
        await waitForWebhookState(() => expect(workFinished).toBe(true));
      },
    );
  });

  it("bounds shutdown when a webhook handler ignores abort", async () => {
    let releaseWork: (() => void) | undefined;
    handleUpdateSpy.mockImplementationOnce(
      async () =>
        await new Promise<void>((resolve) => {
          releaseWork = resolve;
        }),
    );
    const started = await startTelegramWebhook({
      token: TELEGRAM_TOKEN,
      port: 0,
      secret: TELEGRAM_SECRET,
      path: TELEGRAM_WEBHOOK_PATH,
      spoolDir: requireWebhookSpoolDir(),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    });

    try {
      const response = await postWebhookJson({
        url: webhookUrl(getServerPort(started.server), TELEGRAM_WEBHOOK_PATH),
        payload: JSON.stringify({ update_id: 3, message: { text: "stuck" } }),
        secret: TELEGRAM_SECRET,
      });
      expect(response.status).toBe(200);
      await waitForWebhookState(() => expect(handleUpdateSpy).toHaveBeenCalledOnce());

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const stopTask = started.stop();
      await vi.advanceTimersByTimeAsync(15_000);
      await stopTask;

      expect(started.server.listening).toBe(false);
      expect(stopSpy).toHaveBeenCalledOnce();
      expect(transportCloseSpies[0]).toHaveBeenCalledOnce();
    } finally {
      releaseWork?.();
      vi.useRealTimers();
      await started.stop();
    }
  });

  it("marks delivery accepted only after the durable enqueue commits", async () => {
    let releaseEnqueue: (() => void) | undefined;
    let markEnqueueStarted: (() => void) | undefined;
    const enqueueGate = new Promise<void>((resolve) => {
      releaseEnqueue = resolve;
    });
    const enqueueStarted = new Promise<void>((resolve) => {
      markEnqueueStarted = resolve;
    });
    setTelegramRuntime({
      state: {
        resolveStateDir: () => webhookStateDir ?? os.tmpdir(),
        openChannelIngressQueue: (
          options?: Omit<Parameters<typeof createChannelIngressQueue>[0], "channelId">,
        ) => {
          const queue = createChannelIngressQueue({ ...options, channelId: "telegram" });
          return {
            ...queue,
            enqueue: async (...args: Parameters<typeof queue.enqueue>) => {
              markEnqueueStarted?.();
              await enqueueGate;
              return await queue.enqueue(...args);
            },
          };
        },
      },
    } as TelegramRuntime);

    await withStartedWebhook(
      {
        secret: TELEGRAM_SECRET,
        path: TELEGRAM_WEBHOOK_PATH,
      },
      async ({ port }) => {
        let responseSettled = false;
        const responseTask = postWebhookJson({
          url: webhookUrl(port, TELEGRAM_WEBHOOK_PATH),
          payload: JSON.stringify({ update_id: 4, message: { text: "commit gate" } }),
          secret: TELEGRAM_SECRET,
        }).then((response) => {
          responseSettled = true;
          return response;
        });

        try {
          await enqueueStarted;
          await yieldWebhookTask();
          expect(responseSettled).toBe(false);

          releaseEnqueue?.();
          const response = await responseTask;
          expect(response.status).toBe(200);
          expect(response.headers.get("x-openclaw-delivery-accepted")).toBe("durable");
          expect(await response.text()).toBe("");
        } finally {
          releaseEnqueue?.();
        }
      },
    );
  });

  it("durably retries a webhook update after acknowledging Telegram", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const runtimeLog = vi.fn();
    const seenUpdates: unknown[] = [];
    handleUpdateSpy.mockImplementation(async (update: unknown) => {
      seenUpdates.push(update);
      if (seenUpdates.length === 1) {
        throw new Error("agent turn failed");
      }
    });
    const payload = JSON.stringify({ update_id: 3, message: { text: "boom" } });

    try {
      await withStartedWebhook(
        {
          secret: TELEGRAM_SECRET,
          path: TELEGRAM_WEBHOOK_PATH,
          runtime: { log: runtimeLog, error: vi.fn(), exit: vi.fn() },
        },
        async ({ port }) => {
          const response = await postWebhookJson({
            url: webhookUrl(port, TELEGRAM_WEBHOOK_PATH),
            payload,
            secret: TELEGRAM_SECRET,
          });

          expect(response.status).toBe(200);
          expect(await response.text()).toBe("");
          await waitForWebhookState(() => expect(seenUpdates).toEqual([JSON.parse(payload)]));
          await waitForWebhookState(async () =>
            expect(
              (await listTelegramSpooledUpdates({ spoolDir: requireWebhookSpoolDir() })).length,
            ).toBe(1),
          );
          expectMockMessageContains(
            runtimeLog,
            "webhook spooled update 3 failed; keeping for retry",
          );
          vi.setSystemTime(Date.now() + 1_100);
          await vi.advanceTimersByTimeAsync(500);
          await waitForWebhookState(() =>
            expect(seenUpdates).toEqual([JSON.parse(payload), JSON.parse(payload)]),
          );
          await waitForWebhookState(async () =>
            expect(
              await listTelegramSpooledUpdates({ spoolDir: requireWebhookSpoolDir() }),
            ).toEqual([]),
          );
        },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a timed-out webhook lane guarded until replay settles", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      let finishFirstUpdate: (() => void) | undefined;
      const seenUpdateIds: number[] = [];
      const firstUpdate = { update_id: 40, message: { chat: { id: 123 }, text: "slow" } };
      const secondUpdate = { update_id: 41, message: { chat: { id: 123 }, text: "blocked" } };
      await writeTelegramSpooledUpdate({
        spoolDir: requireWebhookSpoolDir(),
        update: firstUpdate,
      });
      await writeTelegramSpooledUpdate({
        spoolDir: requireWebhookSpoolDir(),
        update: secondUpdate,
      });
      handleUpdateSpy.mockImplementation(async (update: unknown) => {
        const updateId = (update as { update_id: number }).update_id;
        seenUpdateIds.push(updateId);
        if (updateId === 40) {
          await new Promise<void>((resolve) => {
            finishFirstUpdate = resolve;
          });
        }
      });

      const started = await startTelegramWebhook({
        token: TELEGRAM_TOKEN,
        port: 0,
        secret: TELEGRAM_SECRET,
        path: TELEGRAM_WEBHOOK_PATH,
        spoolDir: requireWebhookSpoolDir(),
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      });
      try {
        await waitForWebhookState(() => expect(seenUpdateIds).toEqual([40]));
        await vi.advanceTimersByTimeAsync(25 * 60_000 + 10_000);
        await yieldWebhookTask();
        expect(seenUpdateIds).toEqual([40]);

        finishFirstUpdate?.();
        await waitForWebhookState(() => expect(seenUpdateIds).toEqual([40, 41]));
      } finally {
        await started.stop();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds buffered timeout settlement behind durable webhook adoption", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      const update = { update_id: 42, message: { chat: { id: 123 }, text: "held adoption" } };
      await writeTelegramSpooledUpdate({
        spoolDir: requireWebhookSpoolDir(),
        update,
      });
      let participant: TelegramSpooledReplayDeferredParticipant | undefined;
      let settlementHold: TelegramSpooledReplaySettlementHold | undefined;
      handleUpdateSpy.mockImplementationOnce(async () => {
        participant =
          createTelegramSpooledReplayDeferredParticipant("test:webhook-adoption-hold") ?? undefined;
        settlementHold = participant?.beginSettlementHold();
      });

      const started = await startTelegramWebhook({
        token: TELEGRAM_TOKEN,
        port: 0,
        secret: TELEGRAM_SECRET,
        path: TELEGRAM_WEBHOOK_PATH,
        spoolDir: requireWebhookSpoolDir(),
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      });
      try {
        await waitForWebhookState(() => expect(participant).toBeDefined());
        await vi.advanceTimersByTimeAsync(25 * 60_000 + 10_000);
        await yieldWebhookTask();

        expect(participant?.abortSignal.aborted).toBe(false);
        expect(
          (await listTelegramSpooledUpdateClaims({ spoolDir: requireWebhookSpoolDir() })).map(
            (claim) => claim.updateId,
          ),
        ).toEqual([42]);

        settlementHold?.release("discard-pending");
        participant?.settle({ kind: "completed" });
        await waitForWebhookState(async () =>
          expect(
            await listTelegramSpooledUpdateClaims({ spoolDir: requireWebhookSpoolDir() }),
          ).toEqual([]),
        );
      } finally {
        settlementHold?.release("replay-pending");
        participant?.settle({ kind: "skipped" });
        await started.stop();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("drains spooled webhook updates left by a previous process on startup", async () => {
    const update = { update_id: 30, message: { text: "leftover" } };
    await writeTelegramSpooledUpdate({
      spoolDir: requireWebhookSpoolDir(),
      update,
    });

    await withStartedWebhook(
      {
        secret: TELEGRAM_SECRET,
        path: TELEGRAM_WEBHOOK_PATH,
      },
      async () => {
        await waitForWebhookState(() => expect(handleUpdateSpy).toHaveBeenCalledWith(update));
        await waitForWebhookState(async () =>
          expect(await listTelegramSpooledUpdates({ spoolDir: requireWebhookSpoolDir() })).toEqual(
            [],
          ),
        );
      },
    );
  });

  it("keeps a webhook lane guarded while claimed completion retries", async () => {
    let completeAttempts = 0;
    let releaseCompletion: (() => void) | undefined;
    let markCompletionRetryStarted: (() => void) | undefined;
    const completionGate = new Promise<void>((resolve) => {
      releaseCompletion = resolve;
    });
    const completionRetryStarted = new Promise<void>((resolve) => {
      markCompletionRetryStarted = resolve;
    });
    setTelegramRuntime({
      state: {
        resolveStateDir: () => webhookStateDir ?? os.tmpdir(),
        openChannelIngressQueue: (
          options?: Omit<Parameters<typeof createChannelIngressQueue>[0], "channelId">,
        ) => {
          const queue = createChannelIngressQueue({ ...options, channelId: "telegram" });
          return {
            ...queue,
            complete: async (...args: Parameters<typeof queue.complete>) => {
              completeAttempts += 1;
              if (completeAttempts === 1) {
                throw new Error("transient completion write failure");
              }
              if (completeAttempts === 2) {
                markCompletionRetryStarted?.();
                await completionGate;
              }
              return await queue.complete(...args);
            },
          };
        },
      },
    } as TelegramRuntime);
    const firstUpdate = { update_id: 50, message: { chat: { id: 123 }, text: "first" } };
    const secondUpdate = { update_id: 51, message: { chat: { id: 123 }, text: "second" } };
    await writeTelegramSpooledUpdate({
      spoolDir: requireWebhookSpoolDir(),
      update: firstUpdate,
    });
    await writeTelegramSpooledUpdate({
      spoolDir: requireWebhookSpoolDir(),
      update: secondUpdate,
    });
    const seenUpdateIds: number[] = [];
    handleUpdateSpy.mockImplementation(async (update: unknown) => {
      seenUpdateIds.push((update as { update_id: number }).update_id);
    });

    const started = await startTelegramWebhook({
      token: TELEGRAM_TOKEN,
      port: 0,
      secret: TELEGRAM_SECRET,
      path: TELEGRAM_WEBHOOK_PATH,
      spoolDir: requireWebhookSpoolDir(),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    });
    try {
      await completionRetryStarted;
      expect(seenUpdateIds).toEqual([50]);
      expect(
        (await listTelegramSpooledUpdateClaims({ spoolDir: requireWebhookSpoolDir() })).map(
          (claim) => claim.updateId,
        ),
      ).toEqual([50]);
      expect(
        (await listTelegramSpooledUpdates({ spoolDir: requireWebhookSpoolDir() })).map(
          (update) => update.updateId,
        ),
      ).toEqual([51]);

      releaseCompletion?.();
      await waitForWebhookState(() => expect(seenUpdateIds).toEqual([50, 51]));
      await waitForWebhookState(async () =>
        expect(
          await listTelegramSpooledUpdateClaims({ spoolDir: requireWebhookSpoolDir() }),
        ).toEqual([]),
      );
      expect(await listTelegramSpooledUpdates({ spoolDir: requireWebhookSpoolDir() })).toEqual([]);
      await writeTelegramSpooledUpdate({
        spoolDir: requireWebhookSpoolDir(),
        update: firstUpdate,
      });
      expect(await listTelegramSpooledUpdates({ spoolDir: requireWebhookSpoolDir() })).toEqual([]);
      expect(seenUpdateIds).toEqual([50, 51]);
    } finally {
      releaseCompletion?.();
      await started.stop();
    }
  });

  it("stops claimed completion retries when the webhook stops", async () => {
    vi.useFakeTimers();
    let completeAttempts = 0;
    setTelegramRuntime({
      state: {
        resolveStateDir: () => webhookStateDir ?? os.tmpdir(),
        openChannelIngressQueue: (
          options?: Omit<Parameters<typeof createChannelIngressQueue>[0], "channelId">,
        ) => {
          const queue = createChannelIngressQueue({ ...options, channelId: "telegram" });
          return {
            ...queue,
            complete: async () => {
              completeAttempts += 1;
              throw new Error("persistent completion write failure");
            },
          };
        },
      },
    } as unknown as TelegramRuntime);
    await writeTelegramSpooledUpdate({
      spoolDir: requireWebhookSpoolDir(),
      update: { update_id: 52, message: { chat: { id: 123 }, text: "stop retry" } },
    });
    const runtimeLog = vi.fn();
    const started = await startTelegramWebhook({
      token: TELEGRAM_TOKEN,
      port: 0,
      secret: TELEGRAM_SECRET,
      path: TELEGRAM_WEBHOOK_PATH,
      spoolDir: requireWebhookSpoolDir(),
      runtime: { log: runtimeLog, error: vi.fn(), exit: vi.fn() },
    });

    await waitForWebhookState(() =>
      expect(mockMessages(runtimeLog).join("\n")).toMatch(
        /completion retry 1 scheduled|tombstone retry 1\//,
      ),
    );
    await started.stop();
    const attemptsAfterStop = completeAttempts;
    await vi.advanceTimersByTimeAsync(400);

    // Stop must abort in-flight tombstone retries (composed webhookAbortSignal).
    expect(completeAttempts).toBe(attemptsAfterStop);
  });

  it("keeps retry-limit webhook updates pending until they are old enough to dead-letter", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(10_000_000);
      const runtimeLog = vi.fn();
      const update = { update_id: 31, message: { text: "young poison" } };
      await writeTelegramSpooledUpdate({
        spoolDir: requireWebhookSpoolDir(),
        update,
        now: Date.now(),
      });
      handleUpdateSpy.mockRejectedValue(new Error("deterministic handler failure"));

      const started = await startTelegramWebhook({
        token: TELEGRAM_TOKEN,
        port: 0,
        secret: TELEGRAM_SECRET,
        path: TELEGRAM_WEBHOOK_PATH,
        spoolDir: requireWebhookSpoolDir(),
        runtime: { log: runtimeLog, error: vi.fn(), exit: vi.fn() },
      });
      try {
        await waitForWebhookState(() => expect(handleUpdateSpy).toHaveBeenCalled());
        await vi.advanceTimersByTimeAsync(130_000);
        await waitForWebhookState(async () =>
          expect(
            (await listTelegramSpooledUpdates({ spoolDir: requireWebhookSpoolDir() })).map(
              (spooled) => spooled.updateId,
            ),
          ).toEqual([31]),
        );
        expect(mockMessages(runtimeLog).join("\n")).not.toContain("dead-lettered");
      } finally {
        await started.stop();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("dead-letters retry-limit webhook updates after the minimum age", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(10_000_000);
      const runtimeLog = vi.fn();
      const update = { update_id: 32, message: { text: "old poison" } };
      await writeTelegramSpooledUpdate({
        spoolDir: requireWebhookSpoolDir(),
        update,
        now: Date.now() - telegramSpooledRetryDeadLetterMinAgeMs,
      });
      handleUpdateSpy.mockRejectedValue(new Error("deterministic handler failure"));

      const started = await startTelegramWebhook({
        token: TELEGRAM_TOKEN,
        port: 0,
        secret: TELEGRAM_SECRET,
        path: TELEGRAM_WEBHOOK_PATH,
        spoolDir: requireWebhookSpoolDir(),
        runtime: { log: runtimeLog, error: vi.fn(), exit: vi.fn() },
      });
      try {
        await waitForWebhookState(() => expect(handleUpdateSpy).toHaveBeenCalled());
        await vi.advanceTimersByTimeAsync(130_000);
        await waitForWebhookState(async () =>
          expect(await listTelegramSpooledUpdates({ spoolDir: requireWebhookSpoolDir() })).toEqual(
            [],
          ),
        );
        expectMockMessageContains(
          runtimeLog,
          "reached retry limit after 8 attempts; dead-lettered",
        );
      } finally {
        await started.stop();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns non-200 when the webhook update cannot be spooled durably", async () => {
    handleUpdateSpy.mockClear();
    await withStartedWebhook(
      {
        secret: TELEGRAM_SECRET,
        path: TELEGRAM_WEBHOOK_PATH,
      },
      async ({ port }) => {
        const response = await postWebhookJson({
          url: webhookUrl(port, TELEGRAM_WEBHOOK_PATH),
          payload: JSON.stringify({ message: { text: "missing update id" } }),
          secret: TELEGRAM_SECRET,
        });

        expect(response.status).toBe(500);
        expect(response.headers.get("x-openclaw-delivery-accepted")).toBeNull();
        expect(handleUpdateSpy).not.toHaveBeenCalled();
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

  it("rate limits repeated invalid secret guesses without throttling authenticated delivery", async () => {
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
            expect(response.headers.get("x-openclaw-delivery-accepted")).toBeNull();
            expect(await response.text()).toBe("Too Many Requests");
            break;
          }

          expect(response.status).toBe(401);
          expect(response.headers.get("x-openclaw-delivery-accepted")).toBeNull();
          expect(await response.text()).toBe("unauthorized");
        }

        expect(saw429).toBe(true);

        const validResponse = await postWebhookJson({
          url: webhookUrl(port, TELEGRAM_WEBHOOK_PATH),
          payload: JSON.stringify({ update_id: 999, message: { text: "hello" } }),
          secret: TELEGRAM_SECRET,
        });
        expect(validResponse.status).toBe(200);
        expect(validResponse.headers.get("x-openclaw-delivery-accepted")).toBe("durable");
        expect(await validResponse.text()).toBe("");
        await waitForWebhookState(() => expect(handleUpdateSpy).toHaveBeenCalledTimes(1));
      },
    );
  });

  it("does not rate limit authenticated webhook request storms", async () => {
    handleUpdateSpy.mockClear();
    await withStartedWebhook(
      {
        secret: TELEGRAM_SECRET,
        path: TELEGRAM_WEBHOOK_PATH,
      },
      async ({ port }) => {
        for (let i = 0; i < TELEGRAM_WEBHOOK_RATE_LIMIT_BURST; i += 1) {
          const response = await postWebhookJson({
            url: webhookUrl(port, TELEGRAM_WEBHOOK_PATH),
            payload: JSON.stringify({ update_id: 10_000 + i, message: { text: `valid ${i}` } }),
            secret: TELEGRAM_SECRET,
          });
          expect(response.status).toBe(200);
        }
        await waitForWebhookState(() => expect(handleUpdateSpy).toHaveBeenCalled());
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
        await waitForWebhookState(() => expect(handleUpdateSpy).toHaveBeenCalledTimes(1));
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
      spoolDir: requireWebhookSpoolDir(),
    });
    const second = await startTelegramWebhook({
      token: TELEGRAM_TOKEN,
      port: 0,
      abortSignal: secondAbort.signal,
      secret: TELEGRAM_SECRET,
      path: TELEGRAM_WEBHOOK_PATH,
      spoolDir: nodePath.join(requireWebhookSpoolDir(), "second"),
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
      await waitForWebhookState(() => expect(handleUpdateSpy).toHaveBeenCalledTimes(1));
    } finally {
      await first.stop();
      await second.stop();
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
      await yieldWebhookTask();
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
        await waitForWebhookState(() => expect(seenUpdate).toEqual(JSON.parse(payload)));
      },
    );
  });

  it("keeps webhook payload readable across multiple delayed reads", async () => {
    const seenPayloads: string[] = [];
    const delayedHandler = async (update: unknown) => {
      await yieldWebhookTask();
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

        await waitForWebhookState(() =>
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
      await yieldWebhookTask();
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
        await waitForWebhookState(() =>
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

  it("does not de-register webhook when shutting down", async () => {
    deleteWebhookSpy.mockClear();
    const abort = new AbortController();
    const started = await startTelegramWebhook({
      token: TELEGRAM_TOKEN,
      secret: TELEGRAM_SECRET,
      port: 0,
      abortSignal: abort.signal,
      path: TELEGRAM_WEBHOOK_PATH,
      spoolDir: requireWebhookSpoolDir(),
    });

    await started.stop();
    abort.abort();
    expect(deleteWebhookSpy).toHaveBeenCalledTimes(0);
  });

  it("closes the owned transport exactly once on shutdown", async () => {
    const started = await startTelegramWebhook({
      token: TELEGRAM_TOKEN,
      secret: TELEGRAM_SECRET,
      port: 0,
      path: TELEGRAM_WEBHOOK_PATH,
      spoolDir: requireWebhookSpoolDir(),
    });

    await started.stop();
    await started.stop();

    expect(transportCloseSpies[0]).toHaveBeenCalledTimes(1);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

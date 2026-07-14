// Feishu tests cover streaming card plugin behavior.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { LookupFn } from "openclaw/plugin-sdk/ssrf-runtime";
import { withFetchPreconnect } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveStreamingCardSendMode } from "./streaming-card-send-mode.js";
import { FeishuStreamingSession, mergeStreamingText } from "./streaming-card.js";

const FEISHU_JSON_MAX_BYTES = 16 * 1024 * 1024;
type FeishuStreamingFetch = typeof fetch;

type StreamingSessionState = {
  cardId: string;
  messageId: string;
  sequence: number;
  currentText: string;
  sentText: string;
  hasNote: boolean;
};

type LocalServer = {
  port: number;
  stop: () => Promise<void>;
};

type DispatcherInit = RequestInit & { dispatcher?: unknown };
type StreamingFetchDeps = {
  fetchImpl: FeishuStreamingFetch;
  lookupFn: LookupFn;
};

type StreamingRequest = {
  url: URL;
  body: string;
  req: IncomingMessage;
  res: ServerResponse;
};

const serverStops: Array<() => Promise<void>> = [];
const HERMETIC_PUBLIC_LOOKUP_ADDRESS = "93.184.216.34";

const hermeticPublicLookup: LookupFn = (async (_hostname: string, _options?: unknown) => ({
  address: HERMETIC_PUBLIC_LOOKUP_ADDRESS,
  family: 4,
})) as LookupFn;

async function readRequestBody(req: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of req) {
    body += String(chunk);
  }
  return body;
}

async function startLocalServer(
  handler: (request: StreamingRequest) => void | Promise<void>,
): Promise<LocalServer> {
  return await new Promise<LocalServer>((resolve, reject) => {
    const server = createServer((req, res) => {
      void (async () => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const body = await readRequestBody(req);
        await handler({ url, body, req, res });
      })().catch((error: unknown) => {
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "text/plain" });
        }
        res.end(String(error));
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("local test server did not expose a TCP port"));
        return;
      }
      resolve({
        port: addr.port,
        stop: async () =>
          await new Promise<void>((innerResolve, innerReject) => {
            server.close((err) => (err ? innerReject(err) : innerResolve()));
          }),
      });
    });
  });
}

function stripDispatcher(init: RequestInit | undefined): RequestInit | undefined {
  if (!init || !("dispatcher" in init)) {
    return init;
  }
  const { dispatcher: _dispatcher, ...rest } = init as DispatcherInit;
  return rest;
}

function createLocalRedirectFetch(port: number): FeishuStreamingFetch {
  const realFetch = globalThis.fetch.bind(globalThis);
  return withFetchPreconnect(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.hostname === "open.feishu.cn" || url.hostname === "open.larksuite.com") {
      const loopback = new URL(`${url.pathname}${url.search}`, `http://127.0.0.1:${port}`);
      return await realFetch(loopback, stripDispatcher(init));
    }
    return await realFetch(input, init);
  });
}

async function createStreamingFetch(
  handler: (request: StreamingRequest) => void | Promise<void>,
): Promise<StreamingFetchDeps> {
  const server = await startLocalServer(handler);
  serverStops.push(server.stop);
  return {
    fetchImpl: createLocalRedirectFetch(server.port),
    lookupFn: hermeticPublicLookup,
  };
}

function createMemoryFetch(
  handler: (url: URL, body: string) => Response | Promise<Response>,
): StreamingFetchDeps {
  return {
    fetchImpl: withFetchPreconnect(
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        const body = typeof init?.body === "string" ? init.body : "";
        return await handler(url, body);
      }),
    ) as FeishuStreamingFetch,
    lookupFn: hermeticPublicLookup,
  };
}

function writeJson(res: ServerResponse, payload: unknown, status = 200): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function writeOversizedJson(
  res: ServerResponse,
  totalBytes: number,
): { bytesPulled: () => number; canceled: () => boolean } {
  const chunk = Buffer.alloc(1024 * 1024, 0x20);
  let bytesPulled = 0;
  let canceled = false;
  let ended = false;
  res.writeHead(200, { "content-type": "application/json" });
  res.on("close", () => {
    if (!ended && bytesPulled < totalBytes) {
      canceled = true;
    }
  });
  const prefix = Buffer.from('{"code":0,"msg":"ok","tenant_access_token":"token","padding":"');
  bytesPulled += prefix.byteLength;
  res.write(prefix);
  const sendChunk = () => {
    if (bytesPulled >= totalBytes) {
      if (!res.destroyed) {
        ended = true;
        res.end('"}');
      }
      return;
    }
    const remaining = totalBytes - bytesPulled;
    const size = Math.min(chunk.byteLength, remaining);
    bytesPulled += size;
    const ok = res.write(chunk.subarray(0, size));
    if (ok) {
      setImmediate(sendChunk);
      return;
    }
    res.once("drain", sendChunk);
  };
  setImmediate(sendChunk);
  return {
    bytesPulled: () => bytesPulled,
    canceled: () => canceled || (!ended && bytesPulled < totalBytes),
  };
}

function setStreamingSessionInternals(
  session: FeishuStreamingSession,
  values: {
    state: StreamingSessionState;
    lastUpdateTime?: number;
  },
): void {
  const internals = session as unknown as {
    state: StreamingSessionState;
    lastUpdateTime: number;
  };
  internals.state = values.state;
  if (values.lastUpdateTime !== undefined) {
    internals.lastUpdateTime = values.lastUpdateTime;
  }
}

describe("FeishuStreamingSession", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    while (serverStops.length > 0) {
      await serverStops.pop()?.();
    }
  });

  function mockFetches(
    updateBodies: string[],
    failedContentUpdateIndexes: ReadonlySet<number> = new Set<number>(),
    replaceBodies: string[] = [],
    failedContentUpdateStatuses: ReadonlyMap<number, number> = new Map<number, number>(),
    failedReplaceStatuses: ReadonlyMap<number, number> = new Map<number, number>(),
  ): StreamingFetchDeps {
    return createMemoryFetch((url, body) => {
      let status = 200;
      if (url.pathname.includes("/auth/")) {
        return jsonResponse({
          code: 0,
          msg: "ok",
          tenant_access_token: "token",
          expire: 7200,
        });
      }
      if (url.pathname.includes("/elements/content/content")) {
        const updateIndex = updateBodies.length;
        updateBodies.push(body);
        if (failedContentUpdateIndexes.has(updateIndex)) {
          throw new Error(`content update ${updateIndex} failed`);
        }
        const failedStatus = failedContentUpdateStatuses.get(updateIndex);
        if (failedStatus !== undefined) {
          status = failedStatus;
        }
      } else if (url.pathname.includes("/elements/content")) {
        const replaceIndex = replaceBodies.length;
        replaceBodies.push(body);
        const failedStatus = failedReplaceStatuses.get(replaceIndex);
        if (failedStatus !== undefined) {
          status = failedStatus;
        }
      }
      return jsonResponse({ code: 0, msg: "ok" }, status);
    });
  }

  function mockStreamingTokenStart(resolveAuthJson: (token: string) => Record<string, unknown>): {
    authTokens: string[];
    client: ConstructorParameters<typeof FeishuStreamingSession>[0];
    deps: StreamingFetchDeps;
  } {
    const authTokens: string[] = [];
    const deps = createMemoryFetch((url) => {
      if (url.pathname.includes("/auth/")) {
        const token = `token-${authTokens.length + 1}`;
        authTokens.push(token);
        return jsonResponse(resolveAuthJson(token));
      }
      return jsonResponse({
        code: 0,
        msg: "ok",
        data: { card_id: `card-${authTokens.length}` },
      });
    });
    const client = {
      im: {
        message: {
          create: vi.fn(async () => ({ code: 0, msg: "ok", data: { message_id: "om_1" } })),
        },
      },
    } as unknown as ConstructorParameters<typeof FeishuStreamingSession>[0];
    return { authTokens, client, deps };
  }

  it("rejects oversized streaming tenant-token JSON before buffering the full body", async () => {
    let streamState:
      | {
          bytesPulled: () => number;
          canceled: () => boolean;
        }
      | undefined;
    const deps = await createStreamingFetch(({ url, res }) => {
      if (url.pathname.includes("/auth/")) {
        streamState = writeOversizedJson(res, FEISHU_JSON_MAX_BYTES * 2);
        return;
      }
      writeJson(res, { code: 0, msg: "ok", data: { card_id: "card_oversized_token" } });
    });

    const session = new FeishuStreamingSession(
      {} as never,
      {
        appId: "app_oversized_token",
        appSecret: "secret",
      },
      undefined,
      deps,
    );

    await expect(session.start("chat_id", "open_id")).rejects.toThrow(
      /feishu\.streaming-card\.token: JSON response exceeds \d+ bytes/,
    );
    expect(streamState?.canceled()).toBe(true);
    expect(streamState?.bytesPulled()).toBeLessThan(FEISHU_JSON_MAX_BYTES * 2);
    console.log(
      `[feishu streaming-card bound proof] token over-cap: bytes_pulled=${streamState?.bytesPulled()} cap=${FEISHU_JSON_MAX_BYTES} canceled=${streamState?.canceled()}`,
    );
  });

  it("aborts a stalled Feishu tenant-token request after the configured timeout", async () => {
    vi.useFakeTimers();
    let authRequestReceived = false;
    const deps: StreamingFetchDeps = {
      fetchImpl: withFetchPreconnect(
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(input instanceof Request ? input.url : input.toString());
          if (!url.pathname.includes("/auth/")) {
            return jsonResponse({ code: 0, msg: "ok", data: { card_id: "card_should_not_reach" } });
          }
          authRequestReceived = true;
          return await new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (!signal) {
              reject(new Error("missing guarded fetch signal"));
              return;
            }
            signal.addEventListener(
              "abort",
              () => {
                const reason = signal.reason;
                reject(
                  reason instanceof Error
                    ? reason
                    : new Error("request aborted", { cause: reason }),
                );
              },
              { once: true },
            );
          });
        }),
      ) as FeishuStreamingFetch,
      lookupFn: hermeticPublicLookup,
    };

    const session = new FeishuStreamingSession(
      {} as never,
      {
        appId: "app_stalled_token",
        appSecret: "secret",
        httpTimeoutMs: 25,
      },
      undefined,
      deps,
    );

    const result = expect(session.start("chat_id", "open_id")).rejects.toSatisfy(
      (error: unknown) => {
        expect(error).toBeInstanceOf(Error);
        const message = (error as Error).message;
        expect(message).toMatch(/timed out/i);
        return true;
      },
    );
    await vi.advanceTimersByTimeAsync(26);
    await result;
    expect(authRequestReceived).toBe(true);
    console.log(
      "[feishu streaming-card stall proof] stalled tenant-token fetch honored configured timeout",
    );
  });

  it("rejects oversized streaming card-create JSON before buffering the full body", async () => {
    let streamState:
      | {
          bytesPulled: () => number;
          canceled: () => boolean;
        }
      | undefined;
    const deps = await createStreamingFetch(({ url, res }) => {
      if (url.pathname.includes("/auth/")) {
        writeJson(res, {
          code: 0,
          msg: "ok",
          tenant_access_token: "token",
          expire: 7200,
        });
        return;
      }
      streamState = writeOversizedJson(res, FEISHU_JSON_MAX_BYTES * 2);
    });

    const session = new FeishuStreamingSession(
      {
        im: {
          message: {
            create: vi.fn(),
          },
        },
      } as unknown as ConstructorParameters<typeof FeishuStreamingSession>[0],
      {
        appId: "app_oversized_card_create",
        appSecret: "secret",
      },
      undefined,
      deps,
    );

    await expect(session.start("chat_id", "open_id")).rejects.toThrow(
      /feishu\.streaming-card\.create: JSON response exceeds \d+ bytes/,
    );
    expect(streamState?.canceled()).toBe(true);
    expect(streamState?.bytesPulled()).toBeLessThan(FEISHU_JSON_MAX_BYTES * 2);
    console.log(
      `[feishu streaming-card bound proof] card-create over-cap: bytes_pulled=${streamState?.bytesPulled()} cap=${FEISHU_JSON_MAX_BYTES} canceled=${streamState?.canceled()}`,
    );
  });

  it("flushes only the latest authoritative snapshot after the throttle window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const updateBodies: string[] = [];
    const deps = mockFetches(updateBodies);

    const session = new FeishuStreamingSession(
      {} as never,
      {
        appId: "app_pending_flush",
        appSecret: "secret",
      },
      undefined,
      deps,
    );
    setStreamingSessionInternals(session, {
      state: {
        cardId: "card_1",
        messageId: "om_1",
        sequence: 1,
        currentText: "visible",
        sentText: "visible",
        hasNote: false,
      },
      lastUpdateTime: 1_000,
    });

    await session.update("draft one");
    await session.update("draft two");
    expect(updateBodies).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(160);

    expect(updateBodies).toHaveLength(1);
    expect(JSON.parse(updateBodies[0] ?? "{}")).toEqual({
      content: "draft two",
      sequence: 2,
      uuid: "s_card_1_2",
    });
  });

  it("retries the same throttled snapshot after a CardKit body error", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_500);
    const updateBodies: string[] = [];
    const deps = createMemoryFetch((url, body) => {
      if (url.pathname.includes("/auth/")) {
        return jsonResponse({
          code: 0,
          msg: "ok",
          tenant_access_token: "token",
          expire: 7200,
        });
      }
      if (url.pathname.includes("/elements/content/content")) {
        updateBodies.push(body);
        return jsonResponse(
          updateBodies.length === 1
            ? { code: 19_001, msg: "sequence rejected" }
            : { code: 0, msg: "ok" },
        );
      }
      return jsonResponse({ code: 0, msg: "ok" });
    });
    const log = vi.fn();
    const session = new FeishuStreamingSession(
      {} as never,
      { appId: "app_rejected_pending_flush", appSecret: "secret" },
      log,
      deps,
    );
    setStreamingSessionInternals(session, {
      state: {
        cardId: "card_rejected_flush",
        messageId: "om_rejected_flush",
        sequence: 1,
        currentText: "hello",
        sentText: "hello",
        hasNote: false,
      },
      lastUpdateTime: 1_500,
    });

    await session.update("hello small");
    await vi.advanceTimersByTimeAsync(160);
    await session.update("hello small");
    await vi.advanceTimersByTimeAsync(160);

    expect(log).toHaveBeenCalledWith(
      "Update failed: Error: Update card content failed: sequence rejected (code=19001)",
    );
    expect(updateBodies).toHaveLength(2);
    expect(updateBodies.map((body) => JSON.parse(body).content)).toEqual([
      "hello small",
      "hello small",
    ]);
  });

  it("pushes natural-boundary updates immediately inside the throttle window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000);
    const updateBodies: string[] = [];
    const deps = mockFetches(updateBodies);

    const session = new FeishuStreamingSession(
      {} as never,
      {
        appId: "app_boundary_flush",
        appSecret: "secret",
      },
      undefined,
      deps,
    );
    setStreamingSessionInternals(session, {
      state: {
        cardId: "card_2",
        messageId: "om_2",
        sequence: 1,
        currentText: "hello",
        sentText: "hello",
        hasNote: false,
      },
      lastUpdateTime: 2_000,
    });

    await session.update("hello!");

    expect(updateBodies).toHaveLength(1);
    expect(JSON.parse(updateBodies[0] ?? "{}")).toEqual({
      content: "hello!",
      sequence: 2,
      uuid: "s_card_2_2",
    });
  });

  it("sends a divergent reasoning snapshot without merging the previous snapshot", async () => {
    const updateBodies: string[] = [];
    const deps = await createStreamingFetch(({ url, body, res }) => {
      if (url.pathname.includes("/auth/")) {
        writeJson(res, {
          code: 0,
          msg: "ok",
          tenant_access_token: "token",
          expire: 7200,
        });
        return;
      }
      if (url.pathname.includes("/elements/content/content")) {
        updateBodies.push(body);
      }
      writeJson(res, { code: 0, msg: "ok" });
    });
    const previous = "> Thinking one\n\n---\n\nanswer";
    const next = "> Thinking two\n\n---\n\nanswer!";
    const session = new FeishuStreamingSession(
      {} as never,
      { appId: "app_reasoning_snapshot", appSecret: "secret" },
      undefined,
      deps,
    );
    setStreamingSessionInternals(session, {
      state: {
        cardId: "card_reasoning",
        messageId: "om_reasoning",
        sequence: 1,
        currentText: previous,
        sentText: previous,
        hasNote: false,
      },
    });

    await session.update(next);

    expect(updateBodies).toHaveLength(1);
    expect(JSON.parse(updateBodies[0] ?? "{}")).toMatchObject({ content: next });
  });

  it("closes with a throttled divergent latest snapshot without merging it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_750);
    const updateBodies: string[] = [];
    const replaceBodies: string[] = [];
    const deps = mockFetches(updateBodies, new Set<number>(), replaceBodies);
    const previous = "> Thinking one\n\n---\n\nanswer";
    const next = "> Thinking two\n\n---\n\nanswer more";
    const session = new FeishuStreamingSession(
      {} as never,
      { appId: "app_pending_reasoning_close", appSecret: "secret" },
      undefined,
      deps,
    );
    setStreamingSessionInternals(session, {
      state: {
        cardId: "card_pending_reasoning_close",
        messageId: "om_pending_reasoning_close",
        sequence: 1,
        currentText: previous,
        sentText: previous,
        hasNote: false,
      },
      lastUpdateTime: 2_750,
    });

    await session.update(next);
    expect(updateBodies).toHaveLength(0);
    expect(replaceBodies).toHaveLength(0);

    await session.close();

    expect(updateBodies).toHaveLength(0);
    expect(replaceBodies).toHaveLength(1);
    const payload = JSON.parse(replaceBodies[0] ?? "{}") as { element?: string };
    expect(JSON.parse(payload.element ?? "{}")).toMatchObject({ content: next });
  });

  it("retains prior visible content when CardKit rejects a divergent close replacement", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_900);
    const replaceBodies: string[] = [];
    const settingsBodies: string[] = [];
    const previous = "> Thinking one\n\n---\n\nanswer";
    const next = "> Thinking two\n\n---\n\nanswer more";
    let sentTextWhenSettingsClosed: string | undefined;
    const state: StreamingSessionState = {
      cardId: "card_rejected_pending_reasoning_close",
      messageId: "om_rejected_pending_reasoning_close",
      sequence: 1,
      currentText: previous,
      sentText: previous,
      hasNote: false,
    };
    const deps = createMemoryFetch((url, body) => {
      if (url.pathname.includes("/auth/")) {
        return jsonResponse({
          code: 0,
          msg: "ok",
          tenant_access_token: "token",
          expire: 7200,
        });
      }
      if (url.pathname.endsWith("/elements/content")) {
        replaceBodies.push(body);
        return jsonResponse({ code: 19_002, msg: "replacement rejected" });
      }
      if (url.pathname.includes("/settings")) {
        settingsBodies.push(body);
        sentTextWhenSettingsClosed = state.sentText;
      }
      return jsonResponse({ code: 0, msg: "ok" });
    });
    const log = vi.fn();
    const session = new FeishuStreamingSession(
      {} as never,
      { appId: "app_rejected_pending_reasoning_close", appSecret: "secret" },
      log,
      deps,
    );
    setStreamingSessionInternals(session, {
      state,
      lastUpdateTime: 2_900,
    });

    await session.update(next);
    // close() reports whether any accepted content remains visible, even when the final rewrite fails.
    await expect(session.close()).resolves.toBe(true);

    expect(replaceBodies).toHaveLength(1);
    expect(settingsBodies).toHaveLength(1);
    expect(sentTextWhenSettingsClosed).toBe(previous);
    const settingsPayload = JSON.parse(settingsBodies[0] ?? "{}") as { settings?: string };
    const settings = JSON.parse(settingsPayload.settings ?? "{}") as {
      config?: { summary?: { content?: string } };
    };
    expect(settings.config?.summary?.content).toBe(previous.replaceAll("\n", " ").trim());
    expect(settings.config?.summary?.content).not.toContain("Thinking two");
    expect(log).toHaveBeenCalledWith(
      "Final replace failed: Error: Replace card content failed: replacement rejected (code=19002)",
    );
  });

  it("logs CardKit body errors for note updates and streaming close settings", async () => {
    const noteBodies: string[] = [];
    const settingsBodies: string[] = [];
    const deps = createMemoryFetch((url, body) => {
      if (url.pathname.includes("/auth/")) {
        return jsonResponse({
          code: 0,
          msg: "ok",
          tenant_access_token: "token",
          expire: 7200,
        });
      }
      if (url.pathname.includes("/elements/note/content")) {
        noteBodies.push(body);
        return jsonResponse({ code: 19_003, msg: "note rejected" });
      }
      if (url.pathname.includes("/settings")) {
        settingsBodies.push(body);
        return jsonResponse({ code: 19_004, msg: "settings rejected" });
      }
      return jsonResponse({ code: 0, msg: "ok" });
    });
    const log = vi.fn();
    const session = new FeishuStreamingSession(
      {} as never,
      { appId: "app_rejected_note_and_close", appSecret: "secret" },
      log,
      deps,
    );
    setStreamingSessionInternals(session, {
      state: {
        cardId: "card_rejected_note_and_close",
        messageId: "om_rejected_note_and_close",
        sequence: 1,
        currentText: "visible answer",
        sentText: "visible answer",
        hasNote: true,
      },
    });

    await expect(session.close(undefined, { note: "model note" })).resolves.toBe(true);

    expect(noteBodies).toHaveLength(1);
    expect(settingsBodies).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(
      "Note update failed: Error: Update card note failed: note rejected (code=19003)",
    );
    expect(log).toHaveBeenCalledWith(
      "Close failed: Error: Close streaming card failed: settings rejected (code=19004)",
    );
  });

  it("retries cumulative content after a failed streaming update", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(3_000);
    const updateBodies: string[] = [];
    const deps = mockFetches(updateBodies, new Set([0]));

    const session = new FeishuStreamingSession(
      {} as never,
      {
        appId: "app_failed_delta_retry",
        appSecret: "secret",
      },
      undefined,
      deps,
    );
    setStreamingSessionInternals(session, {
      state: {
        cardId: "card_3",
        messageId: "om_3",
        sequence: 1,
        currentText: "hello",
        sentText: "hello",
        hasNote: false,
      },
      lastUpdateTime: 2_000,
    });

    await session.update("hello world");
    await session.update("hello world!");

    expect(updateBodies).toHaveLength(2);
    expect(JSON.parse(updateBodies[0] ?? "{}")).toEqual({
      content: "hello world",
      sequence: 2,
      uuid: "s_card_3_2",
    });
    expect(JSON.parse(updateBodies[1] ?? "{}")).toEqual({
      content: "hello world!",
      sequence: 3,
      uuid: "s_card_3_3",
    });
  });

  it("retries cumulative content after a non-OK streaming update", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(3_500);
    const updateBodies: string[] = [];
    const deps = mockFetches(updateBodies, new Set<number>(), [], new Map([[0, 429]]));

    const session = new FeishuStreamingSession(
      {} as never,
      {
        appId: "app_non_ok_delta_retry",
        appSecret: "secret",
      },
      undefined,
      deps,
    );
    setStreamingSessionInternals(session, {
      state: {
        cardId: "card_5",
        messageId: "om_5",
        sequence: 1,
        currentText: "hello",
        sentText: "hello",
        hasNote: false,
      },
      lastUpdateTime: 2_000,
    });

    await session.update("hello world");
    await session.update("hello world!");

    expect(updateBodies).toHaveLength(2);
    expect(JSON.parse(updateBodies[0] ?? "{}")).toEqual({
      content: "hello world",
      sequence: 2,
      uuid: "s_card_5_2",
    });
    expect(JSON.parse(updateBodies[1] ?? "{}")).toEqual({
      content: "hello world!",
      sequence: 3,
      uuid: "s_card_5_3",
    });
  });

  it("replaces content when final text removes transient streamed status", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(4_000);
    const updateBodies: string[] = [];
    const replaceBodies: string[] = [];
    const deps = mockFetches(updateBodies, new Set<number>(), replaceBodies);

    const session = new FeishuStreamingSession(
      {} as never,
      {
        appId: "app_final_rewrite",
        appSecret: "secret",
      },
      undefined,
      deps,
    );
    setStreamingSessionInternals(session, {
      state: {
        cardId: "card_4",
        messageId: "om_4",
        sequence: 1,
        currentText: "🔎 Web Search\n\nfinal answer",
        sentText: "🔎 Web Search\n\nfinal answer",
        hasNote: false,
      },
      lastUpdateTime: 3_000,
    });

    await session.close("final answer");

    expect(updateBodies).toHaveLength(0);
    expect(replaceBodies).toHaveLength(1);
    const replacePayload = JSON.parse(replaceBodies[0] ?? "{}") as {
      element?: string;
      sequence?: number;
      uuid?: string;
    };
    expect({
      ...replacePayload,
      element: JSON.parse(replacePayload.element ?? "{}"),
    }).toEqual({
      element: {
        tag: "markdown",
        content: "final answer",
        element_id: "content",
      },
      sequence: 2,
      uuid: "r_card_4_2",
    });
  });

  it("drops a surrogate pair whole when truncating the closeout summary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(4_200);
    // 46 'a' + 😀 (U+1F600, UTF-16 indices 46-47) + 20 'b' = 68-char string.
    // truncateSummary's default max is 50, so it slices at max-3 = 47, which
    // lands between the high and low surrogate halves of the emoji.
    const finalText = `${"a".repeat(46)}\u{1F600}${"b".repeat(20)}`;
    const settingsBodies: string[] = [];
    const deps = await createStreamingFetch(({ url, body, res }) => {
      if (url.pathname.includes("/auth/")) {
        writeJson(res, {
          code: 0,
          msg: "ok",
          tenant_access_token: "token",
          expire: 7200,
        });
        return;
      }
      if (url.pathname.includes("/settings")) {
        settingsBodies.push(body);
      }
      writeJson(res, { code: 0, msg: "ok" });
    });

    const session = new FeishuStreamingSession(
      {} as never,
      {
        appId: "app_summary_surrogate",
        appSecret: "secret",
      },
      undefined,
      deps,
    );
    setStreamingSessionInternals(session, {
      state: {
        cardId: "card_surrogate",
        messageId: "om_surrogate",
        sequence: 1,
        currentText: "",
        sentText: "",
        hasNote: false,
      },
      lastUpdateTime: 3_000,
    });

    await session.close(finalText);

    expect(settingsBodies).toHaveLength(1);
    const settingsPayload = JSON.parse(settingsBodies[0] ?? "{}") as { settings?: string };
    const settings = JSON.parse(settingsPayload.settings ?? "{}") as {
      config?: { summary?: { content?: string } };
    };
    const summary = settings.config?.summary?.content ?? "";
    // The half-emoji must be dropped whole: 46 a's + "...", and the summary
    // must NOT end with a lone high surrogate (which Feishu renders as �).
    expect(summary).toBe(`${"a".repeat(46)}...`);
    expect(summary).not.toContain("\uD83D");
    expect(summary.charCodeAt(summary.length - 4)).not.toBe(0xd83d);
  });

  it("logs a final replacement failure when CardKit returns non-OK", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(4_500);
    const updateBodies: string[] = [];
    const replaceBodies: string[] = [];
    const deps = mockFetches(
      updateBodies,
      new Set<number>(),
      replaceBodies,
      new Map<number, number>(),
      new Map([[0, 500]]),
    );
    const log = vi.fn();

    const session = new FeishuStreamingSession(
      {} as never,
      {
        appId: "app_final_rewrite_non_ok",
        appSecret: "secret",
      },
      log,
      deps,
    );
    setStreamingSessionInternals(session, {
      state: {
        cardId: "card_6",
        messageId: "om_6",
        sequence: 1,
        currentText: "working\n\nfinal answer",
        sentText: "working\n\nfinal answer",
        hasNote: false,
      },
      lastUpdateTime: 3_000,
    });

    await session.close("final answer");

    expect(updateBodies).toHaveLength(0);
    expect(replaceBodies).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(
      "Final replace failed: Error: Replace card content failed with HTTP 500",
    );
  });

  it("reports no visible content when final close update fails before any accepted text", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(4_800);
    const updateBodies: string[] = [];
    const replaceBodies: string[] = [];
    const deps = mockFetches(updateBodies, new Set<number>(), replaceBodies, new Map([[0, 500]]));
    const log = vi.fn();

    const session = new FeishuStreamingSession(
      {} as never,
      {
        appId: "app_final_update_non_ok",
        appSecret: "secret",
      },
      log,
      deps,
    );
    setStreamingSessionInternals(session, {
      state: {
        cardId: "card_7",
        messageId: "om_7",
        sequence: 1,
        currentText: "",
        sentText: "",
        hasNote: false,
      },
      lastUpdateTime: 3_000,
    });

    await expect(session.close("final answer")).resolves.toBe(false);

    expect(updateBodies).toHaveLength(1);
    expect(replaceBodies).toHaveLength(0);
    expect(log).toHaveBeenCalledWith(
      "Final update failed: Error: Update card content failed with HTTP 500",
    );
  });

  it("bounds streaming token cache lifetime when token expiry overflows", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-29T12:00:00.000Z"));
    const { authTokens, client, deps } = mockStreamingTokenStart((token) => ({
      code: 0,
      msg: "ok",
      tenant_access_token: token,
      expire: Number.MAX_SAFE_INTEGER,
    }));

    await new FeishuStreamingSession(
      client,
      {
        appId: "app_unsafe_token_expiry",
        appSecret: "secret",
      },
      undefined,
      deps,
    ).start("chat_id", "open_id");
    expect(authTokens).toEqual(["token-1"]);

    vi.setSystemTime(Date.now() + 7200 * 1000 - 60_000 + 1);
    await new FeishuStreamingSession(
      client,
      {
        appId: "app_unsafe_token_expiry",
        appSecret: "secret",
      },
      undefined,
      deps,
    ).start("chat_id", "open_id");

    expect(authTokens).toEqual(["token-1", "token-2"]);
  });

  it("bounds streaming token fallback lifetime when the process clock is invalid", async () => {
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_001);
    const { authTokens, client, deps } = mockStreamingTokenStart((token) => ({
      code: 0,
      msg: "ok",
      tenant_access_token: token,
    }));

    await new FeishuStreamingSession(
      client,
      {
        appId: "app_invalid_clock_token_expiry",
        appSecret: "secret",
      },
      undefined,
      deps,
    ).start("chat_id", "open_id");
    expect(authTokens).toEqual(["token-1"]);

    dateNow.mockReturnValue(7200 * 1000 - 60_000 + 1);
    await new FeishuStreamingSession(
      client,
      {
        appId: "app_invalid_clock_token_expiry",
        appSecret: "secret",
      },
      undefined,
      deps,
    ).start("chat_id", "open_id");

    expect(authTokens).toEqual(["token-1", "token-2"]);
    dateNow.mockRestore();
  });

  it("treats an invalid process clock as a streaming token cache miss", async () => {
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-05-29T12:00:00.000Z"));
    const { authTokens, client, deps } = mockStreamingTokenStart((token) => ({
      code: 0,
      msg: "ok",
      tenant_access_token: token,
      expire: 7200,
    }));

    await new FeishuStreamingSession(
      client,
      {
        appId: "app_invalid_clock_cache_miss",
        appSecret: "secret",
      },
      undefined,
      deps,
    ).start("chat_id", "open_id");
    expect(authTokens).toEqual(["token-1"]);

    dateNow.mockReturnValue(8_640_000_000_000_001);
    await new FeishuStreamingSession(
      client,
      {
        appId: "app_invalid_clock_cache_miss",
        appSecret: "secret",
      },
      undefined,
      deps,
    ).start("chat_id", "open_id");

    expect(authTokens).toEqual(["token-1", "token-2"]);
    dateNow.mockRestore();
  });
});

describe("mergeStreamingText", () => {
  it("prefers the latest full text when it already includes prior text", () => {
    expect(mergeStreamingText("hello", "hello world")).toBe("hello world");
  });

  it("keeps previous text when the next partial is empty or redundant", () => {
    expect(mergeStreamingText("hello", "")).toBe("hello");
    expect(mergeStreamingText("hello world", "hello")).toBe("hello world");
  });

  it("appends fragmented chunks without injecting newlines", () => {
    expect(mergeStreamingText("hello wor", "ld")).toBe("hello world");
    expect(mergeStreamingText("line1", "line2")).toBe("line1line2");
  });

  it("merges overlap between adjacent partial snapshots", () => {
    expect(mergeStreamingText("好的，让我", "让我再读取一遍")).toBe("好的，让我再读取一遍");
    expect(mergeStreamingText("revision_id: 552", "2，一点变化都没有")).toBe(
      "revision_id: 552，一点变化都没有",
    );
    expect(mergeStreamingText("abc", "cabc")).toBe("cabc");
  });
});

describe("resolveStreamingCardSendMode", () => {
  it("prefers message.reply when reply target and root id both exist", () => {
    expect(
      resolveStreamingCardSendMode({
        replyToMessageId: "om_parent",
        rootId: "om_topic_root",
      }),
    ).toBe("reply");
  });

  it("falls back to root create when reply target is absent", () => {
    expect(
      resolveStreamingCardSendMode({
        rootId: "om_topic_root",
      }),
    ).toBe("root_create");
  });

  it("uses create mode when no reply routing fields are provided", () => {
    expect(resolveStreamingCardSendMode()).toBe("create");
  });
});

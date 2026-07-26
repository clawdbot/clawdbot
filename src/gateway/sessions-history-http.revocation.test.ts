/**
 * HTTP session history revocation tests.
 */
import { EventEmitter } from "node:events";
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

let transcriptUpdateHandler:
  | ((update: { sessionFile?: string; message?: unknown; messageId?: string }) => void)
  | undefined;
let authRevoked = false;
let gatewayConfig: {
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
} = {
  trustedProxies: ["10.0.0.1"],
  allowRealIpFallback: false,
};
let authCheckCalls = 0;
let transcriptReadError: Error | undefined;

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => ({
    gateway: gatewayConfig,
  }),
}));

vi.mock("../sessions/transcript-events.js", () => ({
  onInternalSessionTranscriptUpdate: (cb: typeof transcriptUpdateHandler) => {
    transcriptUpdateHandler = cb;
    return () => {
      if (transcriptUpdateHandler === cb) {
        transcriptUpdateHandler = undefined;
      }
    };
  },
}));

vi.mock("./http-utils.js", () => ({
  getHeader: (req: IncomingMessage, name: string) => {
    const value = req.headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
  },
  resolveSharedSecretHttpOperatorScopes: () => ["operator.read"],
  authorizeScopedGatewayHttpRequestOrReply: async () => ({
    cfg: { gateway: {} },
    requestAuth: { trustDeclaredOperatorScopes: true },
    operatorScopes: ["operator.read"],
  }),
  checkGatewayHttpRequestAuth: async (params: {
    trustedProxies?: string[];
    allowRealIpFallback?: boolean;
  }) => {
    authCheckCalls += 1;
    if (authRevoked) {
      return {
        ok: false as const,
        authResult: { ok: false, reason: "trusted_proxy_user_not_allowed" },
      };
    }
    if (
      gatewayConfig.trustedProxies === undefined &&
      gatewayConfig.allowRealIpFallback === undefined
    ) {
      return params.trustedProxies === undefined && params.allowRealIpFallback === undefined
        ? {
            ok: false as const,
            authResult: { ok: false, reason: "trusted_proxy_no_proxies_configured" },
          }
        : {
            ok: true as const,
            requestAuth: { trustDeclaredOperatorScopes: true },
          };
    }
    return {
      ok: true as const,
      requestAuth: { trustDeclaredOperatorScopes: true },
    };
  },
}));

vi.mock("./session-utils.js", () => ({
  resolveGatewaySessionStoreTargetWithStore: () => ({
    storePath: "/tmp",
    storeKeys: ["agent:main"],
    canonicalKey: "agent:main",
    agentId: "main",
    store: {},
  }),
  resolveFreshestSessionEntryFromStoreKeys: () => ({
    sessionId: "session-1",
    sessionFile: "/tmp/session-1.jsonl",
  }),
  resolveSessionTranscriptCandidates: () => ["/tmp/session-1.jsonl"],
}));

vi.mock("./session-transcript-readers.js", () => ({
  readRecentSessionMessagesWithStatsAsync: async () => {
    if (transcriptReadError) {
      throw transcriptReadError;
    }
    return { messages: [], totalMessages: 0 };
  },
  readSessionMessagesAsync: async () => [],
  readSessionMessagesWithSourceAsync: async () => {
    if (transcriptReadError) {
      throw transcriptReadError;
    }
    return { messages: [] };
  },
}));

vi.mock("./session-history-state.js", () => ({
  buildSessionHistorySnapshot: () => ({
    history: { items: [], nextCursor: null, messages: [] },
  }),
  SessionHistorySseState: {
    fromRawSnapshot: (_params: unknown) => ({
      snapshot: () => ({ items: [], nextCursor: null, messages: [] }),
      appendInlineMessage: ({ message, messageId }: { message: unknown; messageId?: string }) => ({
        message,
        messageSeq: 1,
        messageId,
      }),
      shouldRefreshForTranscriptPath: () => false,
      refreshAsync: async () => ({ items: [], nextCursor: null, messages: [] }),
    }),
  },
}));

import { SessionTranscriptProjectionUnavailableError } from "../config/sessions/session-accessor.js";
import { handleSessionHistoryHttpRequest } from "./sessions-history-http.js";

const SESSION_HISTORY_URL = "/sessions/agent%3Amain/history";
const SESSION_FILE = "/tmp/session-1.jsonl";
const TRUSTED_PROXY_STARTUP_OPTIONS = {
  auth: { mode: "trusted-proxy" } as never,
  trustedProxies: ["10.0.0.1"],
  allowRealIpFallback: false,
} satisfies Parameters<typeof handleSessionHistoryHttpRequest>[2];

class MockReq extends EventEmitter {
  url: string;
  method: string;
  headers: Record<string, string>;
  socket = new EventEmitter();

  constructor(url: string) {
    super();
    this.url = url;
    this.method = "GET";
    this.headers = {
      host: "localhost",
      accept: "text/event-stream",
      authorization: "Bearer token",
      "x-openclaw-scopes": "operator.read",
    };
  }
}

class MockRes extends EventEmitter {
  statusCode = 0;
  headers = new Map<string, string>();
  writes: string[] = [];
  writableEnded = false;
  socket = new EventEmitter();
  closeOnNextWrite = false;

  setHeader(name: string, value: string) {
    this.headers.set(name.toLowerCase(), value);
  }

  write(chunk: string) {
    this.writes.push(chunk);
    if (this.closeOnNextWrite) {
      this.closeOnNextWrite = false;
      this.emit("close");
    }
    return true;
  }

  end(chunk?: string) {
    if (chunk !== undefined) {
      this.writes.push(chunk);
    }
    this.writableEnded = true;
    this.emit("finish");
    this.emit("close");
    return this;
  }

  flushHeaders() {}
}

async function openSessionHistoryStream(
  options: Parameters<typeof handleSessionHistoryHttpRequest>[2],
) {
  return (await openSessionHistoryStreamPair(options)).res;
}

async function openSessionHistoryStreamPair(
  options: Parameters<typeof handleSessionHistoryHttpRequest>[2],
  params?: { closeOnFirstWrite?: boolean; expectSubscribed?: boolean },
) {
  const req = new MockReq(SESSION_HISTORY_URL);
  const res = new MockRes();
  res.closeOnNextWrite = params?.closeOnFirstWrite === true;

  const handled = await handleSessionHistoryHttpRequest(
    req as unknown as IncomingMessage,
    res as unknown as ServerResponse,
    options,
  );

  expect(handled).toBe(true);
  if (params?.expectSubscribed === false) {
    expect(transcriptUpdateHandler).toBeUndefined();
  } else {
    expect(transcriptUpdateHandler).toBeTypeOf("function");
  }

  return { req, res };
}

async function withRealNodeSessionHistoryStream(
  run: (pair: { req: IncomingMessage; res: ServerResponse }) => Promise<void>,
) {
  let resolvePair: (pair: { req: IncomingMessage; res: ServerResponse }) => void;
  const pairPromise = new Promise<{ req: IncomingMessage; res: ServerResponse }>((resolve) => {
    resolvePair = resolve;
  });
  let resolveHandled: (handled: boolean) => void;
  let rejectHandled: (error: unknown) => void;
  const handledPromise = new Promise<boolean>((resolve, reject) => {
    resolveHandled = resolve;
    rejectHandled = reject;
  });
  const server = createServer((req, res) => {
    resolvePair({ req, res });
    void handleSessionHistoryHttpRequest(req, res, TRUSTED_PROXY_STARTUP_OPTIONS).then(
      resolveHandled,
      rejectHandled,
    );
  });

  await new Promise<void>((resolve, reject) => {
    const handleListenError = (error: Error) => reject(error);
    server.once("error", handleListenError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", handleListenError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected TCP test server address");
  }

  const clientResponsePromise = new Promise<IncomingMessage>((resolve, reject) => {
    const clientRequest = request(
      {
        host: "127.0.0.1",
        port: address.port,
        path: SESSION_HISTORY_URL,
        method: "GET",
        headers: {
          accept: "text/event-stream",
          authorization: "Bearer token",
          "x-openclaw-scopes": "operator.read",
        },
      },
      resolve,
    );
    clientRequest.once("error", reject);
    clientRequest.end();
  });

  const pair = await pairPromise;
  const clientResponse = await clientResponsePromise;
  clientResponse.resume();
  expect(await handledPromise).toBe(true);
  expect(transcriptUpdateHandler).toBeTypeOf("function");

  try {
    await run(pair);
  } finally {
    clientResponse.destroy();
    pair.res.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

function emitErrorOnNextTick(emitter: EventEmitter, error: Error): Promise<void> {
  return new Promise((resolve, reject) => {
    process.nextTick(() => {
      try {
        emitter.emit("error", error);
        resolve();
      } catch (emitError) {
        reject(emitError instanceof Error ? emitError : new Error(String(emitError)));
      }
    });
  });
}

function emitTranscriptTextUpdate({
  sessionFile = SESSION_FILE,
  text,
  messageId,
}: {
  sessionFile?: string;
  text: string;
  messageId: string;
}) {
  transcriptUpdateHandler?.({
    sessionFile,
    message: { role: "assistant", content: [{ type: "text", text }] },
    messageId,
  });
}

async function expectStreamClosedWithoutMessage(res: MockRes, text: string) {
  await vi.waitFor(() => {
    expect(res.writableEnded).toBe(true);
  });

  const joined = res.writes.join("");
  expect(joined).not.toContain("event: message");
  expect(joined).not.toContain(text);
  expect(res.writableEnded).toBe(true);
}

afterEach(() => {
  transcriptUpdateHandler = undefined;
  authRevoked = false;
  authCheckCalls = 0;
  transcriptReadError = undefined;
  gatewayConfig = {
    trustedProxies: ["10.0.0.1"],
    allowRealIpFallback: false,
  };
});

describe("session history SSE auth revocation", () => {
  it("returns retryable HTTP unavailable while a dirty projection rebuilds", async () => {
    transcriptReadError = new SessionTranscriptProjectionUnavailableError("session-1");

    const { req, res } = await openSessionHistoryStreamPair(TRUSTED_PROXY_STARTUP_OPTIONS, {
      expectSubscribed: false,
    });

    expect(res.statusCode).toBe(503);
    expect(res.headers.get("retry-after")).toBe("1");
    expect(res.writes.join("")).toContain('"retryable":true');
    expect(req.listenerCount("error")).toBe(0);
  });

  it("closes the stream before delivering transcript updates after auth is revoked", async () => {
    const res = await openSessionHistoryStream({ auth: { mode: "trusted-proxy" } as never });

    expect(res.headers.get("content-type")).toContain("text/event-stream");

    authRevoked = true;

    emitTranscriptTextUpdate({
      text: "post-revocation secret",
      messageId: "m-1",
    });

    await expectStreamClosedWithoutMessage(res, "post-revocation secret");
  });

  it("rechecks SSE auth against live proxy config instead of startup fallbacks", async () => {
    const res = await openSessionHistoryStream(TRUSTED_PROXY_STARTUP_OPTIONS);

    gatewayConfig = {};

    emitTranscriptTextUpdate({
      text: "stale-proxy event",
      messageId: "m-2",
    });

    await expectStreamClosedWithoutMessage(res, "stale-proxy event");
  });

  it("skips SSE reauth for transcript updates outside this stream", async () => {
    const res = await openSessionHistoryStream(TRUSTED_PROXY_STARTUP_OPTIONS);

    authCheckCalls = 0;
    gatewayConfig = {};

    emitTranscriptTextUpdate({
      sessionFile: "/tmp/other-session.jsonl",
      text: "other session",
      messageId: "m-3",
    });

    const joined = res.writes.join("");
    expect(authCheckCalls).toBe(0);
    expect(joined).not.toContain("other session");
    expect(res.writableEnded).toBe(false);
  });

  it("closes and cleans up the SSE stream when the request stream emits an error", async () => {
    const { req, res } = await openSessionHistoryStreamPair(TRUSTED_PROXY_STARTUP_OPTIONS);

    expect(() => req.emit("error", new Error("request stream failed"))).not.toThrow();

    expect(res.writableEnded).toBe(true);
    expect(transcriptUpdateHandler).toBeUndefined();
    expect(req.listenerCount("error")).toBe(0);
    expect(res.listenerCount("error")).toBe(0);
  });

  it("cleans up SSE resources when the response stream emits an error", async () => {
    const { req, res } = await openSessionHistoryStreamPair(TRUSTED_PROXY_STARTUP_OPTIONS);

    expect(() => res.emit("error", new Error("response stream failed"))).not.toThrow();

    expect(transcriptUpdateHandler).toBeUndefined();
    expect(req.listenerCount("error")).toBe(1);
    expect(res.listenerCount("error")).toBe(1);

    emitTranscriptTextUpdate({
      text: "post-response-error update",
      messageId: "m-response-error",
    });
    expect(res.writes.join("")).not.toContain("post-response-error update");

    res.emit("close");
    expect(req.listenerCount("error")).toBe(0);
    expect(res.listenerCount("error")).toBe(0);
  });

  it("keeps real Node stream errors handled while a request failure ends the response", async () => {
    await withRealNodeSessionHistoryStream(async ({ req, res }) => {
      expect(req.listenerCount("error")).toBeGreaterThan(0);
      expect(res.listenerCount("error")).toBeGreaterThan(0);

      expect(() => req.emit("error", new Error("request stream failed"))).not.toThrow();
      expect(res.writableEnded).toBe(true);

      await expect(
        emitErrorOnNextTick(res, new Error("response failed during end flush")),
      ).resolves.toBeUndefined();
    });
  });

  it("keeps real Node response errors handled until the ended response closes", async () => {
    await withRealNodeSessionHistoryStream(async ({ res }) => {
      expect(() => res.emit("error", new Error("response stream failed"))).not.toThrow();
      expect(transcriptUpdateHandler).toBeUndefined();

      res.end();

      await expect(
        emitErrorOnNextTick(res, new Error("response failed after end")),
      ).resolves.toBeUndefined();
    });
  });

  it("does not create SSE resources after an initial write closes the stream", async () => {
    const { req, res } = await openSessionHistoryStreamPair(TRUSTED_PROXY_STARTUP_OPTIONS, {
      closeOnFirstWrite: true,
      expectSubscribed: false,
    });

    expect(res.writes.join("")).toBe("retry: 1000\n\n");
    expect(transcriptUpdateHandler).toBeUndefined();
    expect(req.listenerCount("error")).toBe(0);
    expect(res.listenerCount("error")).toBe(0);
  });
});

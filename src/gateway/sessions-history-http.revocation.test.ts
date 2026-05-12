import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

let transcriptUpdateHandler:
  | ((update: { sessionFile?: string; message?: unknown; messageId?: string }) => void)
  | undefined;
let authRevoked = false;
let gatewayConfig: {
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  webchat: { chatHistoryMaxChars: number };
} = {
  trustedProxies: ["10.0.0.1"],
  allowRealIpFallback: false,
  webchat: { chatHistoryMaxChars: 2000 },
};
let authCheckCalls = 0;

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => ({
    gateway: gatewayConfig,
  }),
}));

vi.mock("../config/sessions.js", () => ({
  loadSessionStore: () => ({ entries: [] }),
}));

vi.mock("../sessions/transcript-events.js", () => ({
  onSessionTranscriptUpdate: (cb: typeof transcriptUpdateHandler) => {
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
  resolveTrustedHttpOperatorScopes: () => ["operator.read"],
  authorizeScopedGatewayHttpRequestOrReply: async () => ({
    cfg: { gateway: { webchat: { chatHistoryMaxChars: 2000 } } },
    requestAuth: { trustDeclaredOperatorScopes: true },
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
  resolveGatewaySessionStoreTarget: () => ({
    storePath: "/tmp",
    storeKeys: ["agent:main"],
    canonicalKey: "agent:main",
    agentId: "main",
  }),
  resolveFreshestSessionEntryFromStoreKeys: () => ({
    sessionId: "session-1",
    sessionFile: "/tmp/session-1.jsonl",
  }),
  readSessionMessagesAsync: async () => [],
  resolveSessionTranscriptCandidates: () => ["/tmp/session-1.jsonl"],
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
      refreshAsync: async () => ({ items: [], nextCursor: null, messages: [] }),
    }),
  },
}));

import { handleSessionHistoryHttpRequest } from "./sessions-history-http.js";

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

  setHeader(name: string, value: string) {
    this.headers.set(name.toLowerCase(), value);
  }

  write(chunk: string) {
    this.writes.push(chunk);
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

afterEach(() => {
  transcriptUpdateHandler = undefined;
  authRevoked = false;
  authCheckCalls = 0;
  gatewayConfig = {
    trustedProxies: ["10.0.0.1"],
    allowRealIpFallback: false,
    webchat: { chatHistoryMaxChars: 2000 },
  };
});

describe("session history SSE auth revocation", () => {
  it("closes the stream before delivering transcript updates after auth is revoked", async () => {
    const req = new MockReq("/sessions/agent%3Amain/history");
    const res = new MockRes();

    const handled = await handleSessionHistoryHttpRequest(
      req as unknown as IncomingMessage,
      res as unknown as ServerResponse,
      { auth: { mode: "trusted-proxy" } as never },
    );

    expect(handled).toBe(true);
    expect(transcriptUpdateHandler).toBeTypeOf("function");
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    authRevoked = true;

    transcriptUpdateHandler?.({
      sessionFile: "/tmp/session-1.jsonl",
      message: { role: "assistant", content: [{ type: "text", text: "post-revocation secret" }] },
      messageId: "m-1",
    });

    await vi.waitFor(() => {
      expect(res.writableEnded).toBe(true);
    });

    const joined = res.writes.join("");
    expect(joined).not.toContain("event: message");
    expect(joined).not.toContain("post-revocation secret");
    expect(res.writableEnded).toBe(true);
  });

  it("rechecks SSE auth against live proxy config instead of startup fallbacks", async () => {
    const req = new MockReq("/sessions/agent%3Amain/history");
    const res = new MockRes();

    const handled = await handleSessionHistoryHttpRequest(
      req as unknown as IncomingMessage,
      res as unknown as ServerResponse,
      {
        auth: { mode: "trusted-proxy" } as never,
        trustedProxies: ["10.0.0.1"],
        allowRealIpFallback: false,
      },
    );

    expect(handled).toBe(true);
    expect(transcriptUpdateHandler).toBeTypeOf("function");

    gatewayConfig = {
      webchat: { chatHistoryMaxChars: 2000 },
    };

    transcriptUpdateHandler?.({
      sessionFile: "/tmp/session-1.jsonl",
      message: { role: "assistant", content: [{ type: "text", text: "stale-proxy event" }] },
      messageId: "m-2",
    });

    await vi.waitFor(() => {
      expect(res.writableEnded).toBe(true);
    });

    const joined = res.writes.join("");
    expect(joined).not.toContain("event: message");
    expect(joined).not.toContain("stale-proxy event");
    expect(res.writableEnded).toBe(true);
  });

  it("skips SSE reauth for transcript updates outside this stream", async () => {
    const req = new MockReq("/sessions/agent%3Amain/history");
    const res = new MockRes();

    const handled = await handleSessionHistoryHttpRequest(
      req as unknown as IncomingMessage,
      res as unknown as ServerResponse,
      {
        auth: { mode: "trusted-proxy" } as never,
        trustedProxies: ["10.0.0.1"],
        allowRealIpFallback: false,
      },
    );

    expect(handled).toBe(true);
    expect(transcriptUpdateHandler).toBeTypeOf("function");

    authCheckCalls = 0;
    gatewayConfig = {
      webchat: { chatHistoryMaxChars: 2000 },
    };

    transcriptUpdateHandler?.({
      sessionFile: "/tmp/other-session.jsonl",
      message: { role: "assistant", content: [{ type: "text", text: "other session" }] },
      messageId: "m-3",
    });

    const joined = res.writes.join("");
    expect(authCheckCalls).toBe(0);
    expect(joined).not.toContain("other session");
    expect(res.writableEnded).toBe(false);
  });
});

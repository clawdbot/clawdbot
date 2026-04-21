import type { RequestListener } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../../../src/plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../../src/plugins/runtime.js";
import { withServer } from "../../../test/helpers/http-test-server.js";
import type { OpenClawConfig, PluginRuntime } from "../runtime-api.js";
import {
  createImageLifecycleCore,
  createImageUpdate,
  createTextUpdate,
  expectImageLifecycleDelivery,
  postWebhookReplay,
} from "../test-support/lifecycle-test-support.js";
import { handleZaloWebhookRequest } from "./monitor.js";
import type { ZaloRuntimeEnv } from "./monitor.types.js";
import {
  clearZaloWebhookSecurityStateForTest,
  getZaloWebhookRateLimitStateSizeForTest,
  getZaloWebhookStatusCounterSizeForTest,
  handleZaloWebhookRequest as handleZaloWebhookRequestInternal,
  registerZaloWebhookTarget,
  type ZaloWebhookProcessUpdate,
  ZaloRetryableWebhookError,
} from "./monitor.webhook.js";
import type { ResolvedZaloAccount } from "./types.js";
const DEFAULT_ACCOUNT: ResolvedZaloAccount = {
  accountId: "default",
  enabled: true,
  token: "tok",
  tokenSource: "config",
  config: {},
};

function createWebhookRequestHandler(processUpdate?: ZaloWebhookProcessUpdate): RequestListener {
  return async (req, res) => {
    const handled = processUpdate
      ? await handleZaloWebhookRequestInternal(req, res, processUpdate)
      : await handleZaloWebhookRequest(req, res);
    if (!handled) {
      res.statusCode = 404;
      res.end("not found");
    }
  };
}

const webhookRequestHandler = createWebhookRequestHandler();

function registerTarget(params: {
  path: string;
  secret?: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  account?: ResolvedZaloAccount;
  config?: OpenClawConfig;
  core?: PluginRuntime;
  runtime?: Partial<ZaloRuntimeEnv>;
}): () => void {
  return registerZaloWebhookTarget({
    token: "tok",
    account: params.account ?? DEFAULT_ACCOUNT,
    config: params.config ?? ({} as OpenClawConfig),
    runtime: (params.runtime ?? {}) as ZaloRuntimeEnv,
    core: params.core ?? ({} as PluginRuntime),
    secret: params.secret ?? "secret",
    path: params.path,
    webhookUrl: `https://example.com${params.path}`,
    webhookPath: params.path,
    mediaMaxMb: 5,
    canHostMedia: true,
    statusSink: params.statusSink,
  });
}

function createPairingAuthCore(params?: { storeAllowFrom?: string[]; pairingCreated?: boolean }): {
  core: PluginRuntime;
  readAllowFromStore: ReturnType<typeof vi.fn>;
  upsertPairingRequest: ReturnType<typeof vi.fn>;
} {
  const readAllowFromStore = vi.fn().mockResolvedValue(params?.storeAllowFrom ?? []);
  const upsertPairingRequest = vi
    .fn()
    .mockResolvedValue({ code: "PAIRCODE", created: params?.pairingCreated ?? false });
  const core = {
    logging: {
      shouldLogVerbose: () => false,
    },
    channel: {
      pairing: {
        readAllowFromStore,
        upsertPairingRequest,
        buildPairingReply: vi.fn(() => "Pairing code: PAIRCODE"),
      },
      commands: {
        shouldComputeCommandAuthorized: vi.fn(() => false),
        resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
      },
    },
  } as unknown as PluginRuntime;
  return { core, readAllowFromStore, upsertPairingRequest };
}

async function postUntilRateLimited(params: {
  baseUrl: string;
  path: string;
  secret: string;
  withNonceQuery?: boolean;
  attempts?: number;
}): Promise<boolean> {
  const attempts = params.attempts ?? 130;
  for (let i = 0; i < attempts; i += 1) {
    const url = params.withNonceQuery
      ? `${params.baseUrl}${params.path}?nonce=${i}`
      : `${params.baseUrl}${params.path}`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "x-bot-api-secret-token": params.secret,
        "content-type": "application/json",
      },
      body: "{}",
    });
    if (response.status === 429) {
      return true;
    }
  }
  return false;
}

async function postWebhookJson(params: {
  baseUrl: string;
  path: string;
  secret: string;
  payload: unknown;
}) {
  return fetch(`${params.baseUrl}${params.path}`, {
    method: "POST",
    headers: {
      "x-bot-api-secret-token": params.secret,
      "content-type": "application/json",
    },
    body: JSON.stringify(params.payload),
  });
}

async function expectTwoWebhookPostsOk(params: {
  baseUrl: string;
  first: { path: string; secret: string; payload: unknown };
  second: { path: string; secret: string; payload: unknown };
}) {
  const first = await postWebhookJson({
    baseUrl: params.baseUrl,
    path: params.first.path,
    secret: params.first.secret,
    payload: params.first.payload,
  });
  const second = await postWebhookJson({
    baseUrl: params.baseUrl,
    path: params.second.path,
    secret: params.second.secret,
    payload: params.second.payload,
  });

  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
}

describe("handleZaloWebhookRequest", () => {
  afterEach(() => {
    clearZaloWebhookSecurityStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("returns 400 for non-object payloads", async () => {
    const unregister = registerTarget({ path: "/hook" });

    try {
      await withServer(webhookRequestHandler, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/hook`, {
          method: "POST",
          headers: {
            "x-bot-api-secret-token": "secret",
            "content-type": "application/json",
          },
          body: "null",
        });

        expect(response.status).toBe(400);
        expect(await response.text()).toBe("Bad Request");
      });
    } finally {
      unregister();
    }
  });

  it("rejects ambiguous routing when multiple targets match the same secret", async () => {
    const sinkA = vi.fn();
    const sinkB = vi.fn();
    const unregisterA = registerTarget({ path: "/hook", statusSink: sinkA });
    const unregisterB = registerTarget({ path: "/hook", statusSink: sinkB });

    try {
      await withServer(webhookRequestHandler, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/hook`, {
          method: "POST",
          headers: {
            "x-bot-api-secret-token": "secret",
            "content-type": "application/json",
          },
          body: "{}",
        });

        expect(response.status).toBe(401);
        expect(sinkA).not.toHaveBeenCalled();
        expect(sinkB).not.toHaveBeenCalled();
      });
    } finally {
      unregisterA();
      unregisterB();
    }
  });

  it("returns 415 for non-json content-type", async () => {
    const unregister = registerTarget({ path: "/hook-content-type" });

    try {
      await withServer(webhookRequestHandler, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/hook-content-type`, {
          method: "POST",
          headers: {
            "x-bot-api-secret-token": "secret",
            "content-type": "text/plain",
          },
          body: "{}",
        });

        expect(response.status).toBe(415);
      });
    } finally {
      unregister();
    }
  });

  it("deduplicates webhook replay for the same event origin", async () => {
    const sink = vi.fn();
    const unregister = registerTarget({ path: "/hook-replay", statusSink: sink });
    const payload = createTextUpdate({
      messageId: "msg-replay-1",
      userId: "123",
      userName: "",
      chatId: "123",
      text: "hello",
    });

    try {
      await withServer(webhookRequestHandler, async (baseUrl) => {
        const { first, replay } = await postWebhookReplay({
          baseUrl,
          path: "/hook-replay",
          secret: "secret",
          payload,
        });

        expect(first.status).toBe(200);
        expect(replay.status).toBe(200);
        expect(sink).toHaveBeenCalledTimes(1);
      });
    } finally {
      unregister();
    }
  });

  it("allows a retry after processUpdate throws a retryable replay error", async () => {
    const error = vi.fn();
    const unregister = registerTarget({
      path: "/hook-retry-after-failure",
      runtime: { error },
    });
    const payload = createTextUpdate({
      messageId: "msg-retry-after-failure-1",
      userId: "123",
      userName: "",
      chatId: "123",
      text: "hello",
    });
    let attempts = 0;
    const processUpdate = vi.fn<ZaloWebhookProcessUpdate>(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new ZaloRetryableWebhookError("boom");
      }
    });

    try {
      await withServer(createWebhookRequestHandler(processUpdate), async (baseUrl) => {
        const first = await postWebhookJson({
          baseUrl,
          path: "/hook-retry-after-failure",
          secret: "secret",
          payload,
        });

        expect(first.status).toBe(200);
        await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));

        const second = await postWebhookJson({
          baseUrl,
          path: "/hook-retry-after-failure",
          secret: "secret",
          payload,
        });

        expect(second.status).toBe(200);
        await vi.waitFor(() => expect(processUpdate).toHaveBeenCalledTimes(2));
      });
    } finally {
      unregister();
    }
  });

  it("keeps replay dedupe isolated per authenticated target", async () => {
    const sinkA = vi.fn();
    const sinkB = vi.fn();
    const unregisterA = registerTarget({
      path: "/hook-replay-scope",
      secret: "secret-a",
      statusSink: sinkA,
    });
    const unregisterB = registerTarget({
      path: "/hook-replay-scope",
      secret: "secret-b",
      statusSink: sinkB,
      account: {
        ...DEFAULT_ACCOUNT,
        accountId: "work",
      },
    });
    const payload = createTextUpdate({
      messageId: "msg-replay-scope-1",
      userId: "123",
      userName: "",
      chatId: "123",
      text: "hello",
    });

    try {
      await withServer(webhookRequestHandler, async (baseUrl) => {
        await expectTwoWebhookPostsOk({
          baseUrl,
          first: { path: "/hook-replay-scope", secret: "secret-a", payload },
          second: { path: "/hook-replay-scope", secret: "secret-b", payload },
        });
      });

      expect(sinkA).toHaveBeenCalledTimes(1);
      expect(sinkB).toHaveBeenCalledTimes(1);
    } finally {
      unregisterA();
      unregisterB();
    }
  });

  it("does not collide replay dedupe across different chats", async () => {
    const sink = vi.fn();
    const unregister = registerTarget({ path: "/hook-replay-chat-scope", statusSink: sink });
    const firstPayload = createTextUpdate({
      messageId: "msg-replay-chat-1",
      userId: "123",
      userName: "",
      chatId: "chat-a",
      text: "hello from a",
    });
    const secondPayload = createTextUpdate({
      messageId: "msg-replay-chat-1",
      userId: "123",
      userName: "",
      chatId: "chat-b",
      text: "hello from b",
    });

    try {
      await withServer(webhookRequestHandler, async (baseUrl) => {
        await expectTwoWebhookPostsOk({
          baseUrl,
          first: { path: "/hook-replay-chat-scope", secret: "secret", payload: firstPayload },
          second: { path: "/hook-replay-chat-scope", secret: "secret", payload: secondPayload },
        });
      });

      expect(sink).toHaveBeenCalledTimes(2);
    } finally {
      unregister();
    }
  });

  it("does not collide replay dedupe across different senders in the same chat", async () => {
    const sink = vi.fn();
    const unregister = registerTarget({ path: "/hook-replay-sender-scope", statusSink: sink });
    const firstPayload = createTextUpdate({
      messageId: "msg-replay-sender-1",
      userId: "user-a",
      userName: "",
      chatId: "chat-shared",
      text: "hello from user a",
    });
    const secondPayload = createTextUpdate({
      messageId: "msg-replay-sender-1",
      userId: "user-b",
      userName: "",
      chatId: "chat-shared",
      text: "hello from user b",
    });

    try {
      await withServer(webhookRequestHandler, async (baseUrl) => {
        await expectTwoWebhookPostsOk({
          baseUrl,
          first: { path: "/hook-replay-sender-scope", secret: "secret", payload: firstPayload },
          second: { path: "/hook-replay-sender-scope", secret: "secret", payload: secondPayload },
        });
      });

      expect(sink).toHaveBeenCalledTimes(2);
    } finally {
      unregister();
    }
  });

  it("does not throw when replay metadata is partially missing", async () => {
    const sink = vi.fn();
    const unregister = registerTarget({ path: "/hook-replay-partial", statusSink: sink });
    const payload = {
      event_name: "message.text.received",
      message: {
        message_id: "msg-replay-partial-1",
        date: Math.floor(Date.now() / 1000),
        text: "hello",
      },
    };

    try {
      await withServer(webhookRequestHandler, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/hook-replay-partial`, {
          method: "POST",
          headers: {
            "x-bot-api-secret-token": "secret",
            "content-type": "application/json",
          },
          body: JSON.stringify(payload),
        });

        expect(response.status).toBe(200);
      });

      expect(sink).toHaveBeenCalledTimes(1);
    } finally {
      unregister();
    }
  });

  it("keeps replay dedupe isolated when path/account values collide under colon-joined keys", async () => {
    const sinkA = vi.fn();
    const sinkB = vi.fn();
    // Old key format `${path}:${accountId}:${event_name}:${messageId}` would collide for these two targets.
    const unregisterA = registerTarget({
      path: "/hook-replay-collision:a",
      secret: "secret-a",
      statusSink: sinkA,
      account: {
        ...DEFAULT_ACCOUNT,
        accountId: "team",
      },
    });
    const unregisterB = registerTarget({
      path: "/hook-replay-collision",
      secret: "secret-b",
      statusSink: sinkB,
      account: {
        ...DEFAULT_ACCOUNT,
        accountId: "a:team",
      },
    });
    const payload = createTextUpdate({
      messageId: "msg-replay-collision-1",
      userId: "123",
      userName: "",
      chatId: "123",
      text: "hello",
    });

    try {
      await withServer(webhookRequestHandler, async (baseUrl) => {
        await expectTwoWebhookPostsOk({
          baseUrl,
          first: { path: "/hook-replay-collision:a", secret: "secret-a", payload },
          second: { path: "/hook-replay-collision", secret: "secret-b", payload },
        });
      });

      expect(sinkA).toHaveBeenCalledTimes(1);
      expect(sinkB).toHaveBeenCalledTimes(1);
    } finally {
      unregisterA();
      unregisterB();
    }
  });

  it("keeps replay dedupe isolated across different webhook paths", async () => {
    const sinkA = vi.fn();
    const sinkB = vi.fn();
    const sharedSecret = "secret";
    const unregisterA = registerTarget({
      path: "/hook-replay-scope-a",
      secret: sharedSecret,
      statusSink: sinkA,
    });
    const unregisterB = registerTarget({
      path: "/hook-replay-scope-b",
      secret: sharedSecret,
      statusSink: sinkB,
    });
    const payload = createTextUpdate({
      messageId: "msg-replay-cross-path-1",
      userId: "123",
      userName: "",
      chatId: "123",
      text: "hello",
    });

    try {
      await withServer(webhookRequestHandler, async (baseUrl) => {
        await expectTwoWebhookPostsOk({
          baseUrl,
          first: { path: "/hook-replay-scope-a", secret: sharedSecret, payload },
          second: { path: "/hook-replay-scope-b", secret: sharedSecret, payload },
        });
      });

      expect(sinkA).toHaveBeenCalledTimes(1);
      expect(sinkB).toHaveBeenCalledTimes(1);
    } finally {
      unregisterA();
      unregisterB();
    }
  });

  it("downloads inbound image media from webhook photo_url and preserves display_name", async () => {
    const {
      core,
      finalizeInboundContextMock,
      recordInboundSessionMock,
      fetchRemoteMediaMock,
      saveMediaBufferMock,
    } = createImageLifecycleCore();
    const unregister = registerTarget({
      path: "/hook-image",
      core,
      account: {
        ...DEFAULT_ACCOUNT,
        config: {
          dmPolicy: "open",
        },
      },
    });
    const payload = createImageUpdate();

    try {
      await withServer(webhookRequestHandler, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/hook-image`, {
          method: "POST",
          headers: {
            "x-bot-api-secret-token": "secret",
            "content-type": "application/json",
          },
          body: JSON.stringify(payload),
        });

        expect(response.status).toBe(200);
      });
    } finally {
      unregister();
    }

    await vi.waitFor(() => expect(fetchRemoteMediaMock).toHaveBeenCalledTimes(1));
    expectImageLifecycleDelivery({
      fetchRemoteMediaMock,
      saveMediaBufferMock,
      finalizeInboundContextMock,
      recordInboundSessionMock,
    });
  });

  it("returns 429 when per-path request rate exceeds threshold", async () => {
    const unregister = registerTarget({ path: "/hook-rate" });

    try {
      await withServer(webhookRequestHandler, async (baseUrl) => {
        const saw429 = await postUntilRateLimited({
          baseUrl,
          path: "/hook-rate",
          secret: "secret", // pragma: allowlist secret
        });

        expect(saw429).toBe(true);
      });
    } finally {
      unregister();
    }
  });
  it("does not grow status counters when query strings churn on unauthorized requests", async () => {
    const unregister = registerTarget({ path: "/hook-query-status" });

    try {
      await withServer(webhookRequestHandler, async (baseUrl) => {
        let saw429 = false;
        for (let i = 0; i < 200; i += 1) {
          const response = await fetch(`${baseUrl}/hook-query-status?nonce=${i}`, {
            method: "POST",
            headers: {
              "x-bot-api-secret-token": "invalid-token", // pragma: allowlist secret
              "content-type": "application/json",
            },
            body: "{}",
          });
          expect([401, 429]).toContain(response.status);
          if (response.status === 429) {
            saw429 = true;
            break;
          }
        }

        expect(saw429).toBe(true);
        expect(getZaloWebhookStatusCounterSizeForTest()).toBe(2);
      });
    } finally {
      unregister();
    }
  });

  it("rate limits authenticated requests even when query strings churn", async () => {
    const unregister = registerTarget({ path: "/hook-query-rate" });

    try {
      await withServer(webhookRequestHandler, async (baseUrl) => {
        const saw429 = await postUntilRateLimited({
          baseUrl,
          path: "/hook-query-rate",
          secret: "secret", // pragma: allowlist secret
          withNonceQuery: true,
        });

        expect(saw429).toBe(true);
        expect(getZaloWebhookRateLimitStateSizeForTest()).toBe(1);
      });
    } finally {
      unregister();
    }
  });

  it("rate limits unauthorized secret guesses before authentication succeeds", async () => {
    const unregister = registerTarget({ path: "/hook-preauth-rate" });

    try {
      await withServer(webhookRequestHandler, async (baseUrl) => {
        const saw429 = await postUntilRateLimited({
          baseUrl,
          path: "/hook-preauth-rate",
          secret: "invalid-token", // pragma: allowlist secret
          withNonceQuery: true,
        });

        expect(saw429).toBe(true);
        expect(getZaloWebhookRateLimitStateSizeForTest()).toBe(1);
      });
    } finally {
      unregister();
    }
  });

  it("does not let unauthorized floods rate-limit authenticated traffic from a different trusted forwarded client IP", async () => {
    const unregister = registerTarget({
      path: "/hook-preauth-split",
      config: {
        gateway: {
          trustedProxies: ["127.0.0.1"],
        },
      } as OpenClawConfig,
    });

    try {
      await withServer(webhookRequestHandler, async (baseUrl) => {
        for (let i = 0; i < 130; i += 1) {
          const response = await fetch(`${baseUrl}/hook-preauth-split?nonce=${i}`, {
            method: "POST",
            headers: {
              "x-bot-api-secret-token": "invalid-token", // pragma: allowlist secret
              "content-type": "application/json",
              "x-forwarded-for": "203.0.113.10",
            },
            body: "{}",
          });
          if (response.status === 429) {
            break;
          }
        }

        const validResponse = await fetch(`${baseUrl}/hook-preauth-split`, {
          method: "POST",
          headers: {
            "x-bot-api-secret-token": "secret",
            "content-type": "application/json",
            "x-forwarded-for": "198.51.100.20",
          },
          body: JSON.stringify({ event_name: "message.unsupported.received" }),
        });

        expect(validResponse.status).toBe(200);
      });
    } finally {
      unregister();
    }
  });

  it("still returns 401 before 415 when both secret and content-type are invalid", async () => {
    const unregister = registerTarget({ path: "/hook-auth-before-type" });

    try {
      await withServer(webhookRequestHandler, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/hook-auth-before-type`, {
          method: "POST",
          headers: {
            "x-bot-api-secret-token": "invalid-token", // pragma: allowlist secret
            "content-type": "text/plain",
          },
          body: "not-json",
        });

        expect(response.status).toBe(401);
      });
    } finally {
      unregister();
    }
  });

  it("scopes DM pairing store reads and writes to accountId", async () => {
    const { core, readAllowFromStore, upsertPairingRequest } = createPairingAuthCore({
      pairingCreated: false,
    });
    const account: ResolvedZaloAccount = {
      ...DEFAULT_ACCOUNT,
      accountId: "work",
      config: {
        dmPolicy: "pairing",
        allowFrom: [],
      },
    };
    const unregister = registerTarget({
      path: "/hook-account-scope",
      account,
      core,
    });

    const payload = {
      event_name: "message.text.received",
      message: {
        from: { id: "123", name: "Attacker" },
        chat: { id: "dm-work", chat_type: "PRIVATE" },
        message_id: "msg-work-1",
        date: Math.floor(Date.now() / 1000),
        text: "hello",
      },
    };

    try {
      await withServer(webhookRequestHandler, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/hook-account-scope`, {
          method: "POST",
          headers: {
            "x-bot-api-secret-token": "secret",
            "content-type": "application/json",
          },
          body: JSON.stringify(payload),
        });

        expect(response.status).toBe(200);
      });
    } finally {
      unregister();
    }

    expect(readAllowFromStore).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "zalo",
        accountId: "work",
      }),
    );
    expect(upsertPairingRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "zalo",
        id: "123",
        accountId: "work",
      }),
    );
  });
});

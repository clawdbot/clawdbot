// Zalo tests cover monitor.webhook plugin behavior.
import type { RequestListener } from "node:http";
import {
  createEmptyPluginRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import type { ZaloRuntimeEnv } from "./monitor.types.js";
import { zaloWebhookRuntime } from "./monitor.webhook.js";
import type { ResolvedZaloAccount } from "./types.js";
import { ZaloWebhookPayloadError } from "./webhook-spool.js";

const {
  clearZaloWebhookSecurityStateForTest,
  getZaloWebhookRateLimitStateSizeForTest,
  getZaloWebhookStatusCounterSizeForTest,
  handleZaloWebhookRequest: handleZaloWebhookRequestInternal,
  registerZaloWebhookTarget,
} = zaloWebhookRuntime;

const DEFAULT_ACCOUNT: ResolvedZaloAccount = {
  accountId: "default",
  enabled: true,
  token: "tok",
  tokenSource: "config",
  config: {},
};

function createWebhookRequestHandler(): RequestListener {
  return (req, res) => {
    void (async () => {
      const handled = await handleZaloWebhookRequestInternal(req, res);
      if (!handled) {
        res.statusCode = 404;
        res.end("not found");
      }
    })();
  };
}

const webhookRequestHandler = createWebhookRequestHandler();

function registerTarget(params: {
  path: string;
  secret?: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  account?: ResolvedZaloAccount;
  config?: OpenClawConfig;
  runtime?: Partial<ZaloRuntimeEnv>;
  acceptWebhook?: (rawEvent: string) => Promise<void>;
}): () => void {
  return registerZaloWebhookTarget({
    account: params.account ?? DEFAULT_ACCOUNT,
    config: params.config ?? ({} as OpenClawConfig),
    runtime: (params.runtime ?? {}) as ZaloRuntimeEnv,
    secret: params.secret ?? "secret",
    path: params.path,
    acceptWebhook:
      params.acceptWebhook ??
      (async (rawEvent) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(rawEvent);
        } catch (error) {
          throw new ZaloWebhookPayloadError("invalid JSON", { cause: error });
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new ZaloWebhookPayloadError("payload must be an object");
        }
        params.statusSink?.({ lastInboundAt: Date.now() });
      }),
  });
}

async function postWebhook(params: {
  baseUrl: string;
  path: string;
  body: string;
  secret?: string;
}) {
  return await fetch(`${params.baseUrl}${params.path}`, {
    method: "POST",
    headers: {
      "x-bot-api-secret-token": params.secret ?? "secret",
      "content-type": "application/json",
    },
    body: params.body,
  });
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

  it("waits for durable admission before acknowledging", async () => {
    let releaseAdmission = () => {};
    const admission = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    const acceptWebhook = vi.fn(async () => {
      await admission;
    });
    const unregister = registerTarget({ path: "/hook-durable-ack", acceptWebhook });

    try {
      await withServer(webhookRequestHandler, async (baseUrl) => {
        let settled = false;
        const responsePromise = postWebhook({
          baseUrl,
          path: "/hook-durable-ack",
          body: '{"event_name":"message.text.received"}',
        }).then((response) => {
          settled = true;
          return response;
        });

        await vi.waitFor(() => expect(acceptWebhook).toHaveBeenCalledTimes(1));
        expect(settled).toBe(false);
        releaseAdmission();
        expect((await responsePromise).status).toBe(200);
      });
    } finally {
      releaseAdmission();
      unregister();
    }
  });

  it("passes the exact raw webhook JSON to durable admission", async () => {
    const acceptWebhook = vi.fn(async () => {});
    const unregister = registerTarget({ path: "/hook-raw", acceptWebhook });
    const body = '{ "event_name": "message.text.received", "extra": true }';

    try {
      await withServer(webhookRequestHandler, async (baseUrl) => {
        const response = await postWebhook({ baseUrl, path: "/hook-raw", body });
        expect(response.status).toBe(200);
      });
      expect(acceptWebhook).toHaveBeenCalledWith(body);
    } finally {
      unregister();
    }
  });

  it("does not acknowledge a durable admission failure", async () => {
    const acceptWebhook = vi.fn(async () => {
      throw new Error("sqlite unavailable");
    });
    const unregister = registerTarget({ path: "/hook-append-failure", acceptWebhook });

    try {
      await withServer(webhookRequestHandler, async (baseUrl) => {
        const response = await postWebhook({
          baseUrl,
          path: "/hook-append-failure",
          body: '{"event_name":"message.text.received"}',
        });
        expect(response.status).toBe(500);
      });
    } finally {
      unregister();
    }
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
});

// Covers APNs relay request signing, config, and response handling.
import { generateKeyPairSync } from "node:crypto";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deriveDeviceIdFromPublicKey,
  publicKeyRawBase64UrlFromPem,
  verifyDeviceSignature,
} from "./device-identity.js";
import { resolveApnsRelayConfigFromEnv, sendApnsRelayPush } from "./push-apns.relay.js";

const relayGatewayIdentity = (() => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" });
  const publicKeyRaw = publicKeyRawBase64UrlFromPem(publicKeyPem);
  const deviceId = deriveDeviceIdFromPublicKey(publicKeyRaw);
  if (!deviceId) {
    throw new Error("failed to derive test gateway device id");
  }
  return {
    deviceId,
    publicKey: publicKeyRaw,
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }),
  };
})();

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function createRelayPushParams() {
  return {
    relayConfig: {
      baseUrl: "https://relay.example.com",
      timeoutMs: 1000,
    },
    sendGrant: "send-grant-123",
    relayHandle: "relay-handle-123",
    payload: { aps: { "content-available": 1 } },
    pushType: "background" as const,
    priority: "5" as const,
    gatewayIdentity: relayGatewayIdentity,
  };
}

function expectRelayConfig(
  resolved: ReturnType<typeof resolveApnsRelayConfigFromEnv>,
  expected: { baseUrl: string; timeoutMs: number },
) {
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) {
    throw new Error("expected APNs relay config to resolve");
  }
  expect(resolved.value.baseUrl).toBe(expected.baseUrl);
  expect(resolved.value.timeoutMs).toBe(expected.timeoutMs);
}

function firstMockCall<T extends unknown[]>(mock: { mock: { calls: T[] } }): T | undefined {
  return mock.mock.calls[0];
}

describe("push-apns.relay", () => {
  describe("resolveApnsRelayConfigFromEnv", () => {
    it("fails closed when relay registration origin is unknown and no relay URL is configured", () => {
      const resolved = resolveApnsRelayConfigFromEnv({} as NodeJS.ProcessEnv);

      expect(resolved.ok).toBe(false);
      if (!resolved.ok) {
        expect(resolved.error).toContain("relay registrations without the hosted relay origin");
      }
    });

    it("lets env overrides win and clamps tiny timeout values", () => {
      const resolved = resolveApnsRelayConfigFromEnv(
        {
          OPENCLAW_APNS_RELAY_BASE_URL: " https://relay-override.example.com/base/ ",
          OPENCLAW_APNS_RELAY_TIMEOUT_MS: "999",
        } as NodeJS.ProcessEnv,
        {
          push: {
            apns: {
              relay: {
                baseUrl: "https://relay.example.com",
                timeoutMs: 2500,
              },
            },
          },
        },
      );

      expectRelayConfig(resolved, {
        baseUrl: "https://relay-override.example.com/base",
        timeoutMs: 1000,
      });
    });

    it("caps oversized timeout values before they reach AbortSignal.timeout", () => {
      const resolved = resolveApnsRelayConfigFromEnv({
        OPENCLAW_APNS_RELAY_BASE_URL: "https://relay.example.com",
        OPENCLAW_APNS_RELAY_TIMEOUT_MS: String(Number.MAX_SAFE_INTEGER),
      } as NodeJS.ProcessEnv);

      expectRelayConfig(resolved, {
        baseUrl: "https://relay.example.com",
        timeoutMs: MAX_TIMER_TIMEOUT_MS,
      });
    });

    it.each(["0x1000", "2e4", "2500ms"])(
      "falls back for non-decimal env timeout %s",
      (timeoutMs) => {
        const resolved = resolveApnsRelayConfigFromEnv({
          OPENCLAW_APNS_RELAY_BASE_URL: "https://relay.example.com",
          OPENCLAW_APNS_RELAY_TIMEOUT_MS: timeoutMs,
        } as NodeJS.ProcessEnv);

        expectRelayConfig(resolved, {
          baseUrl: "https://relay.example.com",
          timeoutMs: 10_000,
        });
      },
    );

    it("retains numeric timeout config values", () => {
      const resolved = resolveApnsRelayConfigFromEnv(
        {
          OPENCLAW_APNS_RELAY_BASE_URL: "https://relay.example.com",
        } as NodeJS.ProcessEnv,
        {
          push: {
            apns: {
              relay: {
                timeoutMs: 2500,
              },
            },
          },
        },
      );

      expectRelayConfig(resolved, {
        baseUrl: "https://relay.example.com",
        timeoutMs: 2500,
      });
    });

    it("uses the configured timeout when the env override is blank", () => {
      const resolved = resolveApnsRelayConfigFromEnv(
        {
          OPENCLAW_APNS_RELAY_BASE_URL: "https://relay.example.com",
          OPENCLAW_APNS_RELAY_TIMEOUT_MS: "   ",
        } as NodeJS.ProcessEnv,
        {
          push: {
            apns: {
              relay: {
                timeoutMs: 2500,
              },
            },
          },
        },
      );

      expectRelayConfig(resolved, {
        baseUrl: "https://relay.example.com",
        timeoutMs: 2500,
      });
    });

    it("allows loopback http URLs for alternate truthy env values", () => {
      const resolved = resolveApnsRelayConfigFromEnv({
        OPENCLAW_APNS_RELAY_BASE_URL: "http://[::1]:8787",
        OPENCLAW_APNS_RELAY_ALLOW_HTTP: "yes",
        OPENCLAW_APNS_RELAY_TIMEOUT_MS: "nope",
      } as NodeJS.ProcessEnv);

      expectRelayConfig(resolved, {
        baseUrl: "http://[::1]:8787",
        timeoutMs: 10_000,
      });
    });

    it.each([
      {
        name: "unsupported protocol",
        env: { OPENCLAW_APNS_RELAY_BASE_URL: "ftp://relay.example.com" },
        expected: "unsupported protocol",
      },
      {
        name: "http non-loopback host",
        env: {
          OPENCLAW_APNS_RELAY_BASE_URL: "http://relay.example.com",
          OPENCLAW_APNS_RELAY_ALLOW_HTTP: "true",
        },
        expected: "loopback hosts",
      },
      {
        name: "query string",
        env: { OPENCLAW_APNS_RELAY_BASE_URL: "https://relay.example.com/path?debug=1" },
        expected: "query and fragment are not allowed",
      },
      {
        name: "userinfo",
        env: { OPENCLAW_APNS_RELAY_BASE_URL: "https://user:pass@relay.example.com/path" },
        expected: "userinfo is not allowed",
      },
    ])("rejects invalid relay URL: $name", ({ env, expected }) => {
      const resolved = resolveApnsRelayConfigFromEnv(env as NodeJS.ProcessEnv);
      expect(resolved.ok).toBe(false);
      if (!resolved.ok) {
        expect(resolved.error).toContain(expected);
      }
    });
  });

  describe("sendApnsRelayPush", () => {
    it("signs relay payloads and forwards the request through the injected sender", async () => {
      vi.spyOn(Date, "now").mockReturnValue(123_456_789);
      const sender = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        apnsId: "relay-apns-id",
        environment: "production",
        tokenSuffix: "abcd1234",
      });

      const result = await sendApnsRelayPush({
        relayConfig: {
          baseUrl: "https://relay.example.com",
          timeoutMs: 1000,
        },
        sendGrant: "send-grant-123",
        relayHandle: "relay-handle-123",
        payload: { aps: { alert: { title: "Wake", body: "Ping" } } },
        pushType: "alert",
        priority: "10",
        gatewayIdentity: relayGatewayIdentity,
        requestSender: sender,
      });

      expect(sender).toHaveBeenCalledTimes(1);
      const sent = firstMockCall(sender)?.[0] as
        | {
            relayConfig?: { baseUrl?: string; timeoutMs?: number };
            sendGrant?: string;
            relayHandle?: string;
            gatewayDeviceId?: string;
            signedAtMs?: number;
            pushType?: string;
            priority?: string;
            payload?: unknown;
            bodyJson?: string;
            signature?: string;
          }
        | undefined;
      expect(sent?.relayConfig?.baseUrl).toBe("https://relay.example.com");
      expect(sent?.relayConfig?.timeoutMs).toBe(1000);
      expect(sent?.sendGrant).toBe("send-grant-123");
      expect(sent?.relayHandle).toBe("relay-handle-123");
      expect(sent?.gatewayDeviceId).toBe(relayGatewayIdentity.deviceId);
      expect(sent?.signedAtMs).toBe(123_456_789);
      expect(sent?.pushType).toBe("alert");
      expect(sent?.priority).toBe("10");
      expect(sent?.payload).toEqual({ aps: { alert: { title: "Wake", body: "Ping" } } });
      expect(sent?.bodyJson).toBe(
        JSON.stringify({
          relayHandle: "relay-handle-123",
          pushType: "alert",
          priority: 10,
          payload: { aps: { alert: { title: "Wake", body: "Ping" } } },
        }),
      );
      expect(
        verifyDeviceSignature(
          relayGatewayIdentity.publicKey,
          [
            "openclaw-relay-send-v1",
            sent?.gatewayDeviceId,
            String(sent?.signedAtMs),
            sent?.bodyJson,
          ].join("\n"),
          sent?.signature ?? "",
        ),
      ).toBe(true);
      expect(result.ok).toBe(true);
      expect(result.status).toBe(200);
      expect(result.apnsId).toBe("relay-apns-id");
      expect(result.environment).toBe("production");
      expect(result.tokenSuffix).toBe("abcd1234");
    });

    it("does not follow relay redirects", async () => {
      const response = new Response("redirected", { status: 302 });
      const cancel = vi.spyOn(response.body!, "cancel").mockResolvedValue(undefined);
      const fetchMock = vi.fn().mockResolvedValue(response);
      vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

      const result = await sendApnsRelayPush(createRelayPushParams());

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const fetchOptions = firstMockCall(fetchMock)?.[1] as { redirect?: unknown } | undefined;
      expect(fetchOptions?.redirect).toBe("manual");
      expect(result.ok).toBe(false);
      expect(result.status).toBe(302);
      expect(result.reason).toBe("RelayRedirectNotAllowed");
      expect(result.environment).toBeUndefined();
      expect(cancel).toHaveBeenCalledOnce();
    });

    it("falls back to fetch status when the relay body is not JSON", async () => {
      // Real Response body so the bounded reader runs end-to-end; non-JSON parse stays a soft null.
      const fetchMock = vi.fn().mockResolvedValue(new Response("not-json-at-all", { status: 202 }));
      vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

      await expect(sendApnsRelayPush(createRelayPushParams())).resolves.toEqual({
        ok: true,
        status: 202,
        apnsId: undefined,
        reason: undefined,
        tokenSuffix: undefined,
      });
    });

    it("treats an empty relay body as absent and derives status from the HTTP response", async () => {
      // Empty body: JSON.parse("") throws -> soft null fallback (not an overflow), same as the
      // prior response.json() behaviour. Confirms the new try/catch does not regress empty bodies.
      const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 202 }));
      vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

      await expect(sendApnsRelayPush(createRelayPushParams())).resolves.toEqual({
        ok: true,
        status: 202,
        apnsId: undefined,
        reason: undefined,
        tokenSuffix: undefined,
      });
    });

    it("normalizes relay JSON response fields", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: false,
            status: 410,
            apnsId: " relay-apns-id ",
            reason: " Unregistered ",
            tokenSuffix: " abcd1234 ",
          }),
          { status: 202, headers: { "content-type": "application/json" } },
        ),
      );
      vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

      await expect(sendApnsRelayPush(createRelayPushParams())).resolves.toEqual({
        ok: false,
        status: 410,
        apnsId: "relay-apns-id",
        reason: "Unregistered",
        tokenSuffix: "abcd1234",
      });
    });

    it("honors BOM-prefixed relay failure JSON", async () => {
      const body = `\uFEFF${JSON.stringify({ ok: false, status: 410 })}`;
      const fetchMock = vi
        .fn()
        .mockResolvedValue(
          new Response(body, { status: 202, headers: { "content-type": "application/json" } }),
        );
      vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

      await expect(sendApnsRelayPush(createRelayPushParams())).resolves.toEqual({
        ok: false,
        status: 410,
        apnsId: undefined,
        reason: undefined,
        tokenSuffix: undefined,
      });
    });

    it("normalizes sandbox relay response metadata", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: true,
            status: 200,
            environment: "sandbox",
            tokenSuffix: " abcd1234 ",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
      vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

      await expect(sendApnsRelayPush(createRelayPushParams())).resolves.toEqual({
        ok: true,
        status: 200,
        apnsId: undefined,
        reason: undefined,
        environment: "sandbox",
        tokenSuffix: "abcd1234",
      });
    });

    it("parses a large under-cap relay body unchanged (boundary just below the 16 MiB cap)", async () => {
      // A valid, large-but-bounded JSON body (~8 MiB payload, comfortably under the 16 MiB cap)
      // must still parse normally: the cap only rejects overflow, it must not truncate or reject
      // legitimate large success responses.
      const padding = "x".repeat(8 * 1024 * 1024);
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: true,
            status: 200,
            apnsId: "big-but-valid",
            note: padding,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
      vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

      await expect(sendApnsRelayPush(createRelayPushParams())).resolves.toEqual({
        ok: true,
        status: 200,
        apnsId: "big-but-valid",
        reason: undefined,
        tokenSuffix: undefined,
      });
    });

    it("fails closed when the relay response body exceeds the size cap", async () => {
      // Drive the real send path with an over-cap (>16 MiB) body: the bounded reader must
      // cancel the stream and the request must fail closed rather than report a delivered push.
      const oversized = "a".repeat(16 * 1024 * 1024 + 1024);
      const fetchMock = vi.fn().mockResolvedValue(new Response(oversized, { status: 200 }));
      vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

      await expect(sendApnsRelayPush(createRelayPushParams())).resolves.toEqual({
        ok: false,
        status: 200,
        reason: "RelayResponseTooLarge",
      });
    });

    it("fails closed on an oversized body even when the HTTP status would imply success", async () => {
      // Regression guard for the core design decision: a 2xx relay response with an oversized
      // body must NOT be folded into the malformed-JSON (treat-as-empty -> HTTP-derived ok)
      // fallback. Overflow always wins and the push is reported failed, never silently delivered.
      const oversized = "b".repeat(16 * 1024 * 1024 + 4096);
      const fetchMock = vi.fn().mockResolvedValue(new Response(oversized, { status: 202 }));
      vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

      const result = await sendApnsRelayPush(createRelayPushParams());
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("RelayResponseTooLarge");
      expect(result.status).toBe(202);
    });
  });
});

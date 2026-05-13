import { generateKeyPairSync } from "node:crypto";
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
    it("returns a missing-config error when no relay base URL is configured", () => {
      expect(resolveApnsRelayConfigFromEnv({} as NodeJS.ProcessEnv)).toEqual({
        ok: false,
        error:
          "APNs relay config missing: set gateway.push.apns.relay.baseUrl or OPENCLAW_APNS_RELAY_BASE_URL",
      });
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
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 302,
        json: vi.fn().mockRejectedValue(new Error("no body")),
      });
      vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

      const result = await sendApnsRelayPush(createRelayPushParams());

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const fetchOptions = firstMockCall(fetchMock)?.[1] as { redirect?: unknown } | undefined;
      expect(fetchOptions?.redirect).toBe("manual");
      expect(result.ok).toBe(false);
      expect(result.status).toBe(302);
      expect(result.reason).toBe("RelayRedirectNotAllowed");
      expect(result.environment).toBe("production");
    });

    it("falls back to fetch status when the relay body is not JSON", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 202,
        json: vi.fn().mockRejectedValue(new Error("bad json")),
      });
      vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

      await expect(sendApnsRelayPush(createRelayPushParams())).resolves.toEqual({
        ok: true,
        status: 202,
        apnsId: undefined,
        reason: undefined,
        environment: "production",
        tokenSuffix: undefined,
      });
    });

    it("normalizes relay JSON response fields", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 202,
        json: vi.fn().mockResolvedValue({
          ok: false,
          status: 410,
          apnsId: " relay-apns-id ",
          reason: " Unregistered ",
          tokenSuffix: " abcd1234 ",
        }),
      });
      vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

      await expect(sendApnsRelayPush(createRelayPushParams())).resolves.toEqual({
        ok: false,
        status: 410,
        apnsId: "relay-apns-id",
        reason: "Unregistered",
        environment: "production",
        tokenSuffix: "abcd1234",
      });
    });
  });
});

/**
 * Tests for Nostr Profile HTTP Handler
 */

import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearNostrProfileRateLimitStateForTest,
  createNostrProfileHttpHandler,
  getNostrProfileRateLimitStateSizeForTest,
  isNostrProfileRateLimitedForTest,
  type NostrProfileHttpContext,
} from "./nostr-profile-http.js";

const runtimeScopeMock = vi.hoisted(() => vi.fn());

vi.mock("./nostr-profile-http-runtime.js", async () => {
  const webhookIngress = await import("openclaw/plugin-sdk/webhook-ingress");
  const requestGuards = await import("openclaw/plugin-sdk/webhook-request-guards");
  return {
    createFixedWindowRateLimiter: webhookIngress.createFixedWindowRateLimiter,
    readJsonBodyWithLimit: requestGuards.readJsonBodyWithLimit,
    requestBodyErrorToText: requestGuards.requestBodyErrorToText,
    getPluginRuntimeGatewayRequestScope: runtimeScopeMock,
  };
});

// Mock the channel exports
vi.mock("./channel.js", () => ({
  publishNostrProfile: vi.fn(),
  getNostrProfileState: vi.fn(),
}));

// Mock the import module
vi.mock("./nostr-profile-import.js", () => ({
  importProfileFromRelays: vi.fn(),
  mergeProfiles: vi.fn((local, imported) => ({ ...imported, ...local })),
}));

import { publishNostrProfile, getNostrProfileState } from "./channel.js";
import { importProfileFromRelays } from "./nostr-profile-import.js";
import { TEST_HEX_PUBLIC_KEY, TEST_SETUP_RELAY_URLS } from "./test-fixtures.js";

// ============================================================================
// Test Helpers
// ============================================================================

const TEST_PROFILE_RELAY_URL = TEST_SETUP_RELAY_URLS[0];

afterAll(() => {
  runtimeScopeMock.mockReset();
});

function setGatewayRuntimeScopes(scopes: readonly string[] | undefined): void {
  if (!scopes) {
    runtimeScopeMock.mockReturnValue(undefined);
    return;
  }
  runtimeScopeMock.mockReturnValue({
    client: {
      connect: {
        scopes: [...scopes],
      },
    },
  });
}

function responseChunkText(chunk: unknown): string {
  if (typeof chunk === "string") {
    return chunk;
  }
  if (Buffer.isBuffer(chunk)) {
    return chunk.toString();
  }
  return "";
}

function createMockRequest(
  method: string,
  url: string,
  body?: unknown,
  opts?: { headers?: Record<string, string>; remoteAddress?: string },
): IncomingMessage {
  const socket = new Socket();
  Object.defineProperty(socket, "remoteAddress", {
    value: opts?.remoteAddress ?? "127.0.0.1",
    configurable: true,
  });
  const req = new IncomingMessage(socket);
  req.method = method;
  req.url = url;
  req.headers = { host: "localhost:3000", ...opts?.headers };

  if (body) {
    const bodyStr = JSON.stringify(body);
    process.nextTick(() => {
      req.emit("data", Buffer.from(bodyStr));
      req.emit("end");
    });
  } else {
    process.nextTick(() => {
      req.emit("end");
    });
  }

  return req;
}

type MockResponse = {
  _getData: () => string;
  _getStatusCode: () => number;
  write: (chunk: unknown) => boolean;
  end: (chunk?: unknown) => MockResponse;
  statusCode: number;
};

function createMockResponse(): MockResponse {
  let data = "";
  let statusCode = 200;
  const res = Object.assign(new ServerResponse({} as IncomingMessage), {
    _getData: () => data,
    _getStatusCode: () => statusCode,
  }) as MockResponse;

  res.write = function (chunk: unknown) {
    data += responseChunkText(chunk);
    return true;
  };

  res.end = function (chunk?: unknown) {
    if (chunk) {
      data += responseChunkText(chunk);
    }
    return this;
  };

  Object.defineProperty(res, "statusCode", {
    get: () => statusCode,
    set: (code: number) => {
      statusCode = code;
    },
  });

  return res;
}

function createMockContext(overrides?: Partial<NostrProfileHttpContext>): NostrProfileHttpContext {
  return {
    getConfigProfile: vi.fn().mockReturnValue(undefined),
    updateConfigProfile: vi.fn().mockResolvedValue(undefined),
    getAccountInfo: vi.fn().mockReturnValue({
      pubkey: TEST_HEX_PUBLIC_KEY,
      relays: [TEST_PROFILE_RELAY_URL],
    }),
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    ...overrides,
  };
}

function createProfileHttpHarness(
  method: string,
  url: string,
  options?: {
    body?: unknown;
    ctx?: Partial<NostrProfileHttpContext>;
    req?: Parameters<typeof createMockRequest>[3];
  },
) {
  const ctx = createMockContext(options?.ctx);
  const handler = createNostrProfileHttpHandler(ctx);
  const req = createMockRequest(method, url, options?.body, options?.req);
  const res = createMockResponse();

  return {
    ctx,
    req,
    res,
    run: () => handler(req, res as unknown as ServerResponse),
  };
}

function expectOkResponse(res: MockResponse) {
  expect(res._getStatusCode()).toBe(200);
  const data = JSON.parse(res._getData());
  expect(data.ok).toBe(true);
  return data;
}

function mockSuccessfulProfileImport() {
  vi.mocked(importProfileFromRelays).mockResolvedValue({
    ok: true,
    profile: {
      name: "imported",
      displayName: "Imported User",
    },
    event: {
      id: "evt123",
      pubkey: TEST_HEX_PUBLIC_KEY,
      created_at: 1234567890,
    },
    relaysQueried: [TEST_PROFILE_RELAY_URL],
    sourceRelay: TEST_PROFILE_RELAY_URL,
  });
}

async function expectAdminScopeRejected(params: {
  scopes: readonly string[] | undefined;
  method: string;
  url: string;
  body: unknown;
  expectOperationNotCalled: () => void;
}) {
  setGatewayRuntimeScopes(params.scopes);
  const { ctx, res, run } = createProfileHttpHarness(params.method, params.url, {
    body: params.body,
  });

  await run();

  expect(res._getStatusCode()).toBe(403);
  const data = JSON.parse(res._getData());
  expect(data.error).toBe("missing scope: operator.admin");
  params.expectOperationNotCalled();
  expect(ctx.updateConfigProfile).not.toHaveBeenCalled();
}

// ============================================================================
// Tests
// ============================================================================

describe("nostr-profile-http", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearNostrProfileRateLimitStateForTest();
    setGatewayRuntimeScopes(["operator.admin"]);
  });

  describe("route matching", () => {
    it("returns false for non-nostr paths", async () => {
      const { run } = createProfileHttpHarness("GET", "/api/channels/telegram/profile");
      const result = await run();

      expect(result).toBe(false);
    });

    it("returns false for paths without accountId", async () => {
      const { run } = createProfileHttpHarness("GET", "/api/channels/nostr/");
      const result = await run();

      expect(result).toBe(false);
    });

    it("handles /api/channels/nostr/:accountId/profile", async () => {
      const { run } = createProfileHttpHarness("GET", "/api/channels/nostr/default/profile");

      vi.mocked(getNostrProfileState).mockResolvedValue(null);

      const result = await run();

      expect(result).toBe(true);
    });
  });

  describe("GET /api/channels/nostr/:accountId/profile", () => {
    it("returns profile and publish state", async () => {
      const { res, run } = createProfileHttpHarness("GET", "/api/channels/nostr/default/profile", {
        ctx: {
          getConfigProfile: vi.fn().mockReturnValue({
            name: "testuser",
            displayName: "Test User",
          }),
        },
      });

      vi.mocked(getNostrProfileState).mockResolvedValue({
        lastPublishedAt: 1234567890,
        lastPublishedEventId: "abc123",
        lastPublishResults: { [TEST_PROFILE_RELAY_URL]: "ok" },
      });

      await run();

      expect(res._getStatusCode()).toBe(200);
      const data = JSON.parse(res._getData());
      expect(data.ok).toBe(true);
      expect(data.profile.name).toBe("testuser");
      expect(data.publishState.lastPublishedAt).toBe(1234567890);
    });
  });

  describe("PUT /api/channels/nostr/:accountId/profile", () => {
    function mockPublishSuccess() {
      vi.mocked(publishNostrProfile).mockResolvedValue({
        eventId: "event123",
        createdAt: 1234567890,
        successes: [TEST_PROFILE_RELAY_URL],
        failures: [],
      });
    }

    function expectBadRequestResponse(res: ReturnType<typeof createMockResponse>) {
      expect(res._getStatusCode()).toBe(400);
      const data = JSON.parse(res._getData());
      expect(data.ok).toBe(false);
      return data;
    }

    async function expectPrivatePictureRejected(pictureUrl: string) {
      const { res, run } = createProfileHttpHarness("PUT", "/api/channels/nostr/default/profile", {
        body: {
          name: "hacker",
          picture: pictureUrl,
        },
      });

      await run();

      const data = expectBadRequestResponse(res);
      expect(data.error).toContain("private");
    }

    it("validates profile and publishes", async () => {
      const { ctx, res, run } = createProfileHttpHarness(
        "PUT",
        "/api/channels/nostr/default/profile",
        {
          body: {
            name: "satoshi",
            displayName: "Satoshi Nakamoto",
            about: "Creator of Bitcoin",
          },
        },
      );

      mockPublishSuccess();

      await run();

      const data = expectOkResponse(res);
      expect(data.eventId).toBe("event123");
      expect(data.successes).toContain(TEST_PROFILE_RELAY_URL);
      expect(data.persisted).toBe(true);
      expect(ctx.updateConfigProfile).toHaveBeenCalled();
    });

    it("rejects profile mutation from non-loopback remote address", async () => {
      const { res, run } = createProfileHttpHarness("PUT", "/api/channels/nostr/default/profile", {
        body: { name: "attacker" },
        req: { remoteAddress: "198.51.100.10" },
      });

      await run();
      expect(res._getStatusCode()).toBe(403);
    });

    it("rejects cross-origin profile mutation attempts", async () => {
      const { res, run } = createProfileHttpHarness("PUT", "/api/channels/nostr/default/profile", {
        body: { name: "attacker" },
        req: { headers: { origin: "https://evil.example" } },
      });

      await run();
      expect(res._getStatusCode()).toBe(403);
    });

    it("rejects profile mutation with cross-site sec-fetch-site header", async () => {
      const { res, run } = createProfileHttpHarness("PUT", "/api/channels/nostr/default/profile", {
        body: { name: "attacker" },
        req: { headers: { "sec-fetch-site": "cross-site" } },
      });

      await run();
      expect(res._getStatusCode()).toBe(403);
    });

    it("rejects profile mutation when forwarded client ip is non-loopback", async () => {
      const { res, run } = createProfileHttpHarness("PUT", "/api/channels/nostr/default/profile", {
        body: { name: "attacker" },
        req: { headers: { "x-forwarded-for": "203.0.113.99, 127.0.0.1" } },
      });

      await run();
      expect(res._getStatusCode()).toBe(403);
    });

    it("rejects profile mutation when gateway caller is missing operator.admin", async () => {
      await expectAdminScopeRejected({
        scopes: ["operator.read"],
        method: "PUT",
        url: "/api/channels/nostr/default/profile",
        body: { name: "attacker" },
        expectOperationNotCalled: () => expect(publishNostrProfile).not.toHaveBeenCalled(),
      });
    });

    it("rejects profile mutation when gateway scope context is missing", async () => {
      await expectAdminScopeRejected({
        scopes: undefined,
        method: "PUT",
        url: "/api/channels/nostr/default/profile",
        body: { name: "attacker" },
        expectOperationNotCalled: () => expect(publishNostrProfile).not.toHaveBeenCalled(),
      });
    });

    it("rejects private IP in picture URL (SSRF protection)", async () => {
      await expectPrivatePictureRejected("https://127.0.0.1/evil.jpg");
    });

    it("rejects ISATAP-embedded private IPv4 in picture URL", async () => {
      await expectPrivatePictureRejected("https://[2001:db8:1234::5efe:127.0.0.1]/evil.jpg");
    });

    it("rejects non-https URLs", async () => {
      const { res, run } = createProfileHttpHarness("PUT", "/api/channels/nostr/default/profile", {
        body: {
          name: "test",
          picture: "http://example.com/pic.jpg",
        },
      });

      await run();

      const data = expectBadRequestResponse(res);
      // The schema validation catches non-https URLs before SSRF check
      expect(data.error).toBe("Validation failed");
      expect(Array.isArray(data.details)).toBe(true);
      expect(data.details).toEqual(["picture: URL must use https:// protocol"]);
    });

    it("does not persist if all relays fail", async () => {
      const { ctx, res, run } = createProfileHttpHarness(
        "PUT",
        "/api/channels/nostr/default/profile",
        {
          body: {
            name: "test",
          },
        },
      );

      vi.mocked(publishNostrProfile).mockResolvedValue({
        eventId: "event123",
        createdAt: 1234567890,
        successes: [],
        failures: [{ relay: TEST_PROFILE_RELAY_URL, error: "timeout" }],
      });

      await run();

      expect(res._getStatusCode()).toBe(200);
      const data = JSON.parse(res._getData());
      expect(data.persisted).toBe(false);
      expect(ctx.updateConfigProfile).not.toHaveBeenCalled();
    });

    it("enforces rate limiting", async () => {
      mockPublishSuccess();

      // Make 6 requests (limit is 5/min)
      for (let i = 0; i < 6; i++) {
        const { res, run } = createProfileHttpHarness(
          "PUT",
          "/api/channels/nostr/rate-test/profile",
          {
            body: {
              name: `user${i}`,
            },
          },
        );
        await run();

        if (i < 5) {
          expectOkResponse(res);
        } else {
          expect(res._getStatusCode()).toBe(429);
          const data = JSON.parse(res._getData());
          expect(data.error).toContain("Rate limit");
        }
      }
    });

    it("caps tracked rate-limit keys to prevent unbounded growth", () => {
      const now = 1_000_000;
      for (let i = 0; i < 2_500; i += 1) {
        isNostrProfileRateLimitedForTest(`rate-cap-${i}`, now);
      }
      expect(getNostrProfileRateLimitStateSizeForTest()).toBeLessThanOrEqual(2_048);
    });

    it("prunes stale rate-limit keys after the window elapses", () => {
      const now = 2_000_000;
      for (let i = 0; i < 100; i += 1) {
        isNostrProfileRateLimitedForTest(`rate-stale-${i}`, now);
      }
      expect(getNostrProfileRateLimitStateSizeForTest()).toBe(100);

      isNostrProfileRateLimitedForTest("fresh", now + 60_001);
      expect(getNostrProfileRateLimitStateSizeForTest()).toBe(1);
    });
  });

  describe("POST /api/channels/nostr/:accountId/profile/import", () => {
    function expectImportSuccessResponse(res: ReturnType<typeof createMockResponse>) {
      const data = expectOkResponse(res);
      expect(data.imported.name).toBe("imported");
      return data;
    }

    it("imports profile from relays", async () => {
      const { res, run } = createProfileHttpHarness(
        "POST",
        "/api/channels/nostr/default/profile/import",
        { body: {} },
      );

      mockSuccessfulProfileImport();

      await run();

      const data = expectImportSuccessResponse(res);
      expect(data.saved).toBe(false); // autoMerge not requested
    });

    it("rejects import mutation from non-loopback remote address", async () => {
      const { res, run } = createProfileHttpHarness(
        "POST",
        "/api/channels/nostr/default/profile/import",
        {
          body: {},
          req: { remoteAddress: "203.0.113.10" },
        },
      );

      await run();
      expect(res._getStatusCode()).toBe(403);
    });

    it("rejects cross-origin import mutation attempts", async () => {
      const { res, run } = createProfileHttpHarness(
        "POST",
        "/api/channels/nostr/default/profile/import",
        {
          body: {},
          req: { headers: { origin: "https://evil.example" } },
        },
      );

      await run();
      expect(res._getStatusCode()).toBe(403);
    });

    it("rejects import mutation when x-real-ip is non-loopback", async () => {
      const { res, run } = createProfileHttpHarness(
        "POST",
        "/api/channels/nostr/default/profile/import",
        {
          body: {},
          req: { headers: { "x-real-ip": "198.51.100.55" } },
        },
      );

      await run();
      expect(res._getStatusCode()).toBe(403);
    });

    it("rejects profile import when gateway caller is missing operator.admin", async () => {
      await expectAdminScopeRejected({
        scopes: ["operator.read"],
        method: "POST",
        url: "/api/channels/nostr/default/profile/import",
        body: { autoMerge: true },
        expectOperationNotCalled: () => expect(importProfileFromRelays).not.toHaveBeenCalled(),
      });
    });

    it("rejects profile import when gateway scope context is missing", async () => {
      await expectAdminScopeRejected({
        scopes: undefined,
        method: "POST",
        url: "/api/channels/nostr/default/profile/import",
        body: { autoMerge: true },
        expectOperationNotCalled: () => expect(importProfileFromRelays).not.toHaveBeenCalled(),
      });
    });

    it("auto-merges when requested", async () => {
      const { ctx, res, run } = createProfileHttpHarness(
        "POST",
        "/api/channels/nostr/default/profile/import",
        {
          body: { autoMerge: true },
          ctx: {
            getConfigProfile: vi.fn().mockReturnValue({ about: "local bio" }),
          },
        },
      );

      mockSuccessfulProfileImport();

      await run();

      const data = expectImportSuccessResponse(res);
      expect(data.saved).toBe(true);
      expect(ctx.updateConfigProfile).toHaveBeenCalled();
    });

    it("returns error when account not found", async () => {
      const { res, run } = createProfileHttpHarness(
        "POST",
        "/api/channels/nostr/unknown/profile/import",
        {
          body: {},
          ctx: {
            getAccountInfo: vi.fn().mockReturnValue(null),
          },
        },
      );

      await run();

      expect(res._getStatusCode()).toBe(404);
      const data = JSON.parse(res._getData());
      expect(data.error).toContain("not found");
    });
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  classifyMSTeamsSendError,
  formatMSTeamsSendErrorHint,
  formatUnknownError,
  isRevokedProxyError,
} from "./errors.js";
import { withRevokedProxyFallback } from "./revoked-context.js";

describe("msteams errors", () => {
  it("formats unknown errors", () => {
    expect(formatUnknownError("oops")).toBe("oops");
    expect(formatUnknownError(null)).toBe("null");
  });

  it("classifies auth errors", () => {
    expect(classifyMSTeamsSendError({ statusCode: 401 }).kind).toBe("auth");
    expect(classifyMSTeamsSendError({ statusCode: 403 }).kind).toBe("auth");
  });

  it("classifies ContentStreamNotAllowed as permanent instead of auth", () => {
    const result = classifyMSTeamsSendError({
      statusCode: 403,
      response: {
        body: {
          error: {
            code: "ContentStreamNotAllowed",
          },
        },
      },
    });
    expect(result.kind).toBe("permanent");
    expect(result.statusCode).toBe(403);
    expect(result.errorCode).toBe("ContentStreamNotAllowed");
  });

  it("classifies throttling errors and parses retry-after", () => {
    const result = classifyMSTeamsSendError({ statusCode: 429, retryAfter: "1.5" });
    expect(result.kind).toBe("throttled");
    expect(result.statusCode).toBe(429);
    expect(result.retryAfterMs).toBe(1500);
  });

  it("classifies transient errors", () => {
    const result = classifyMSTeamsSendError({ statusCode: 503 });
    expect(result.kind).toBe("transient");
    expect(result.statusCode).toBe(503);
  });

  it("classifies permanent 4xx errors", () => {
    const result = classifyMSTeamsSendError({ statusCode: 400 });
    expect(result.kind).toBe("permanent");
    expect(result.statusCode).toBe(400);
  });

  it("provides actionable hints for common cases", () => {
    expect(formatMSTeamsSendErrorHint({ kind: "auth" })).toContain("msteams");
    expect(formatMSTeamsSendErrorHint({ kind: "throttled" })).toContain("throttled");
    expect(
      formatMSTeamsSendErrorHint({
        kind: "permanent",
        errorCode: "ContentStreamNotAllowed",
      }),
    ).toContain("expired the content stream");
  });

  it("classifies transport-level network errors and provides smba egress hint (#77674)", () => {
    const econnrefused = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const enotfound = Object.assign(new Error("getaddrinfo ENOTFOUND smba.trafficmanager.net"), {
      code: "ENOTFOUND",
    });
    const etimedout = Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" });

    const econnrefusedResult = classifyMSTeamsSendError(econnrefused);
    expect(econnrefusedResult.kind).toBe("network");
    expect(econnrefusedResult.errorCode).toBe("ECONNREFUSED");
    const enotfoundResult = classifyMSTeamsSendError(enotfound);
    expect(enotfoundResult.kind).toBe("network");
    expect(enotfoundResult.errorCode).toBe("ENOTFOUND");
    const etimedoutResult = classifyMSTeamsSendError(etimedout);
    expect(etimedoutResult.kind).toBe("network");
    expect(etimedoutResult.errorCode).toBe("ETIMEDOUT");

    // Hints for network errors must mention smba (Connector endpoint) and egress
    expect(formatMSTeamsSendErrorHint({ kind: "network" })).toContain("smba");
    expect(formatMSTeamsSendErrorHint({ kind: "network" })).toContain("egress");
  });

  it("still classifies HTTP errors as unknown when no status code and no network code", () => {
    expect(classifyMSTeamsSendError(new Error("unexpected error")).kind).toBe("unknown");
    expect(classifyMSTeamsSendError(null).kind).toBe("unknown");
  });

  describe("isRevokedProxyError", () => {
    it("returns true for revoked proxy TypeError", () => {
      expect(
        isRevokedProxyError(new TypeError("Cannot perform 'set' on a proxy that has been revoked")),
      ).toBe(true);
      expect(
        isRevokedProxyError(new TypeError("Cannot perform 'get' on a proxy that has been revoked")),
      ).toBe(true);
    });

    it("returns false for non-TypeError errors", () => {
      expect(isRevokedProxyError(new Error("proxy that has been revoked"))).toBe(false);
    });

    it("returns false for unrelated TypeErrors", () => {
      expect(isRevokedProxyError(new TypeError("undefined is not a function"))).toBe(false);
    });

    it("returns false for non-error values", () => {
      expect(isRevokedProxyError(null)).toBe(false);
      expect(isRevokedProxyError("proxy that has been revoked")).toBe(false);
    });
  });

  describe("withRevokedProxyFallback", () => {
    it("returns primary result when no error occurs", async () => {
      await expect(
        withRevokedProxyFallback({
          run: async () => "ok",
          onRevoked: async () => "fallback",
        }),
      ).resolves.toBe("ok");
    });

    it("uses fallback when proxy-revoked TypeError is thrown", async () => {
      const onRevokedLog = vi.fn();
      await expect(
        withRevokedProxyFallback({
          run: async () => {
            throw new TypeError("Cannot perform 'get' on a proxy that has been revoked");
          },
          onRevoked: async () => "fallback",
          onRevokedLog,
        }),
      ).resolves.toBe("fallback");
      expect(onRevokedLog).toHaveBeenCalledOnce();
    });

    it("rethrows non-revoked errors", async () => {
      const err = Object.assign(new Error("boom"), { statusCode: 500 });
      await expect(
        withRevokedProxyFallback({
          run: async () => {
            throw err;
          },
          onRevoked: async () => "fallback",
        }),
      ).rejects.toBe(err);
    });
  });
});

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
    expect(
      classifyMSTeamsSendError({
        statusCode: 403,
        response: {
          body: {
            error: {
              code: "ContentStreamNotAllowed",
            },
          },
        },
      }),
    ).toMatchObject({
      kind: "permanent",
      statusCode: 403,
      errorCode: "ContentStreamNotAllowed",
    });
  });

  it("classifies throttling errors and parses retry-after", () => {
    expect(classifyMSTeamsSendError({ statusCode: 429, retryAfter: "1.5" })).toMatchObject({
      kind: "throttled",
      statusCode: 429,
      retryAfterMs: 1500,
    });
  });

  it("classifies transient errors", () => {
    expect(classifyMSTeamsSendError({ statusCode: 503 })).toMatchObject({
      kind: "transient",
      statusCode: 503,
    });
  });

  it("classifies permanent 4xx errors", () => {
    expect(classifyMSTeamsSendError({ statusCode: 400 })).toMatchObject({
      kind: "permanent",
      statusCode: 400,
    });
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

    expect(classifyMSTeamsSendError(econnrefused)).toMatchObject({
      kind: "network",
      errorCode: "ECONNREFUSED",
    });
    expect(classifyMSTeamsSendError(enotfound)).toMatchObject({
      kind: "network",
      errorCode: "ENOTFOUND",
    });
    expect(classifyMSTeamsSendError(etimedout)).toMatchObject({
      kind: "network",
      errorCode: "ETIMEDOUT",
    });

    // Hints for network errors must mention smba (Connector endpoint) and egress
    expect(formatMSTeamsSendErrorHint({ kind: "network" })).toContain("smba");
    expect(formatMSTeamsSendErrorHint({ kind: "network" })).toContain("egress");
  });

  it("still classifies HTTP errors as unknown when no status code and no network code", () => {
    expect(classifyMSTeamsSendError(new Error("unexpected error")).kind).toBe("unknown");
    expect(classifyMSTeamsSendError(null)).toMatchObject({ kind: "unknown" });
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

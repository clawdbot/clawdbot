// Msteams tests cover errors plugin behavior.
import { describe, expect, it, vi } from "vitest";
import {
  classifyMSTeamsSendError,
  formatMSTeamsDeliveryFailureGuidance,
  formatMSTeamsSendErrorHint,
  formatUnknownError,
  isRevokedProxyError,
} from "./errors.js";
import { withRevokedProxyFallback } from "./revoked-context.js";

function replaySafeRetryAfterMs(error: unknown): number | undefined {
  const classification = classifyMSTeamsSendError(error);
  return classification.kind === "replay-safe" ? classification.retryAfterMs : undefined;
}

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

  it("classifies Teams rate limiting as replay-safe and parses retry-after", () => {
    const result = classifyMSTeamsSendError({ statusCode: 429, retryAfter: "1.5" });
    expect(result.kind).toBe("replay-safe");
    expect(result.statusCode).toBe(429);
    expect(replaySafeRetryAfterMs({ statusCode: 429, retryAfter: "1.5" })).toBe(1500);
  });

  it("does not parse partial retry-after values", () => {
    expect(replaySafeRetryAfterMs({ statusCode: 429, retryAfter: "1.5s" })).toBeUndefined();
    expect(
      replaySafeRetryAfterMs({
        statusCode: 429,
        response: { headers: { "retry-after": "2 seconds" } },
      }),
    ).toBeUndefined();
    expect(
      replaySafeRetryAfterMs({
        statusCode: 429,
        response: { headers: new Headers({ "retry-after": "3 seconds" }) },
      }),
    ).toBeUndefined();
  });

  it("ignores unsafe retry-after magnitudes", () => {
    expect(
      replaySafeRetryAfterMs({
        statusCode: 429,
        retryAfterMs: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toBeUndefined();
    expect(
      replaySafeRetryAfterMs({
        statusCode: 429,
        retryAfter: Number.MAX_SAFE_INTEGER,
      }),
    ).toBeUndefined();
    expect(
      replaySafeRetryAfterMs({
        statusCode: 429,
        retryAfter: "9007199254741",
      }),
    ).toBeUndefined();
    expect(
      replaySafeRetryAfterMs({
        statusCode: 429,
        response: { headers: { "retry-after": "9007199254741" } },
      }),
    ).toBeUndefined();
    expect(
      replaySafeRetryAfterMs({
        statusCode: 429,
        response: { headers: new Headers({ "retry-after": "9007199254741" }) },
      }),
    ).toBeUndefined();
  });

  it("does not parse partial or fractional status codes", () => {
    expect(classifyMSTeamsSendError({ statusCode: "429oops" }).kind).toBe("unknown");
    expect(classifyMSTeamsSendError({ statusCode: 429.5 }).kind).toBe("unknown");
    expect(
      classifyMSTeamsSendError({ response: { status: "503 temporarily unavailable" } }).kind,
    ).toBe("unknown");
  });

  it.each([408, 500, 502, 503, 504])("classifies HTTP %i as delivery-ambiguous", (statusCode) => {
    const classification = classifyMSTeamsSendError({ statusCode });
    expect(classification).toMatchObject({
      kind: "ambiguous",
      source: "http",
      statusCode,
    });
    expect(formatMSTeamsSendErrorHint(classification)).toContain("outcome is unknown");
    expect(formatMSTeamsSendErrorHint(classification)).not.toMatch(/retry|resend/iu);
    expect(formatMSTeamsDeliveryFailureGuidance(classification)).toContain(
      "may already have succeeded",
    );
    expect(formatMSTeamsDeliveryFailureGuidance(classification)).not.toContain(
      "Retrying later may succeed",
    );
  });

  it("keeps model guidance aligned with replay safety", () => {
    expect(
      formatMSTeamsDeliveryFailureGuidance(classifyMSTeamsSendError({ statusCode: 429 })),
    ).toBe("The request was rate-limited before delivery; retrying later may succeed.");
    expect(
      formatMSTeamsDeliveryFailureGuidance(classifyMSTeamsSendError({ statusCode: 401 })),
    ).toBeUndefined();
  });

  it("classifies permanent 4xx errors", () => {
    const result = classifyMSTeamsSendError({ statusCode: 400 });
    expect(result.kind).toBe("permanent");
    expect(result.statusCode).toBe(400);
  });

  it("provides actionable hints for common cases", () => {
    expect(formatMSTeamsSendErrorHint(classifyMSTeamsSendError({ statusCode: 401 }))).toContain(
      "msteams",
    );
    expect(formatMSTeamsSendErrorHint(classifyMSTeamsSendError({ statusCode: 429 }))).toContain(
      "throttled",
    );
    expect(
      formatMSTeamsSendErrorHint(
        classifyMSTeamsSendError({
          statusCode: 403,
          response: { body: { error: { code: "ContentStreamNotAllowed" } } },
        }),
      ),
    ).toContain("expired the content stream");
  });

  it("classifies transport-level network errors and provides smba egress hint (#77674)", () => {
    const econnrefused = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const enotfound = Object.assign(new Error("getaddrinfo ENOTFOUND smba.trafficmanager.net"), {
      code: "ENOTFOUND",
    });
    const etimedout = Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" });

    const econnrefusedResult = classifyMSTeamsSendError(econnrefused);
    expect(econnrefusedResult).toMatchObject({ kind: "ambiguous", source: "transport" });
    expect(econnrefusedResult.errorCode).toBe("ECONNREFUSED");
    const enotfoundResult = classifyMSTeamsSendError(enotfound);
    expect(enotfoundResult).toMatchObject({ kind: "ambiguous", source: "transport" });
    expect(enotfoundResult.errorCode).toBe("ENOTFOUND");
    const etimedoutResult = classifyMSTeamsSendError(etimedout);
    expect(etimedoutResult).toMatchObject({ kind: "ambiguous", source: "transport" });
    expect(etimedoutResult.errorCode).toBe("ETIMEDOUT");

    const hint = formatMSTeamsSendErrorHint(econnrefusedResult);
    expect(hint).toContain("smba");
    expect(hint).toContain("egress");
    expect(hint).toContain("outcome is unknown");
    expect(hint).not.toMatch(/retry|resend/iu);
  });

  it.each(["ECONNABORTED", "ETIMEDOUT", "ECONNRESET"])(
    "keeps transport %s delivery ambiguous without retry guidance",
    (code) => {
      const classification = classifyMSTeamsSendError(Object.assign(new Error(code), { code }));
      expect(classification).toMatchObject({
        kind: "ambiguous",
        source: "transport",
        errorCode: code,
      });
      expect(formatMSTeamsSendErrorHint(classification)).not.toMatch(/retry|resend/iu);
    },
  );

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

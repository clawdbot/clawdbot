import { ErrorCode as SlackErrorCode } from "@slack/web-api";
import { describe, expect, it } from "vitest";
import {
  extractSlackErrorCode,
  formatSlackAuthErrorMessage,
  formatSlackErrorWithAuthRemediation,
  isSlackAuthTokenErrorCode,
  isSlackPlatformError,
  SlackAuthConfigError,
  toSlackAuthConfigError,
  wrapSlackClientAuthErrors,
} from "./auth-error.js";

function makePlatformError(code: string) {
  const err = new Error(`An API error occurred: ${code}`) as Error & {
    code: string;
    data: { ok: false; error: string };
  };
  err.code = SlackErrorCode.PlatformError;
  err.data = { ok: false, error: code };
  return err;
}

describe("extractSlackErrorCode", () => {
  it("reads the code off a thrown WebAPIPlatformError", () => {
    expect(extractSlackErrorCode(makePlatformError("not_authed"))).toBe("not_authed");
  });

  it("reads the code off a raw { ok: false, error } result (HTTP 200 body failure)", () => {
    expect(extractSlackErrorCode({ ok: false, error: "invalid_auth" })).toBe("invalid_auth");
  });

  it("falls back to parsing the formatted SDK message", () => {
    expect(extractSlackErrorCode(new Error("An API error occurred: token_revoked"))).toBe(
      "token_revoked",
    );
  });

  it("returns undefined for network/transport errors with no Slack error code", () => {
    expect(extractSlackErrorCode(new Error("ETIMEDOUT"))).toBeUndefined();
    expect(extractSlackErrorCode(new Error("socket hang up"))).toBeUndefined();
    expect(extractSlackErrorCode(new Error(""))).toBeUndefined();
    expect(extractSlackErrorCode(null)).toBeUndefined();
    expect(extractSlackErrorCode(undefined)).toBeUndefined();
  });

  it("returns undefined for a successful { ok: true } result", () => {
    expect(extractSlackErrorCode({ ok: true })).toBeUndefined();
  });
});

describe("isSlackPlatformError", () => {
  it("is true for a WebAPIPlatformError-shaped error", () => {
    expect(isSlackPlatformError(makePlatformError("account_inactive"))).toBe(true);
  });

  it("is false for a plain network error", () => {
    expect(isSlackPlatformError(new Error("ECONNRESET"))).toBe(false);
  });
});

describe("isSlackAuthTokenErrorCode", () => {
  it.each(["not_authed", "invalid_auth", "token_revoked", "account_inactive"])(
    "is true for %s",
    (code) => {
      expect(isSlackAuthTokenErrorCode(code)).toBe(true);
    },
  );

  it("is case-insensitive", () => {
    expect(isSlackAuthTokenErrorCode("NOT_AUTHED")).toBe(true);
  });

  it.each(["missing_scope", "rate_limited", "channel_not_found", undefined])(
    "is false for %s",
    (code) => {
      expect(isSlackAuthTokenErrorCode(code)).toBe(false);
    },
  );
});

describe("formatSlackAuthErrorMessage / SlackAuthConfigError", () => {
  it("produces a clear, actionable message naming the code and remediation, without ever including a token", () => {
    const message = formatSlackAuthErrorMessage("not_authed");
    expect(message).toContain("not_authed");
    expect(message).toContain("Regenerate the token");
    expect(message).not.toMatch(/xox[bp]-/);
  });

  it("SlackAuthConfigError carries the code and preserves the original error as cause", () => {
    const original = makePlatformError("invalid_auth");
    const wrapped = new SlackAuthConfigError("invalid_auth", original);
    expect(wrapped.code).toBe("invalid_auth");
    expect(wrapped.cause).toBe(original);
    expect(wrapped.message).toContain("invalid_auth");
  });
});

describe("toSlackAuthConfigError", () => {
  it.each(["not_authed", "invalid_auth", "token_revoked", "account_inactive"])(
    "maps a %s platform error to a SlackAuthConfigError",
    (code) => {
      const mapped = toSlackAuthConfigError(makePlatformError(code));
      expect(mapped).toBeInstanceOf(SlackAuthConfigError);
      expect(mapped?.code).toBe(code);
    },
  );

  it("maps an HTTP-200 body failure ({ ok: false, error: 'not_authed' }) even when not thrown as an Error", () => {
    const mapped = toSlackAuthConfigError({ ok: false, error: "not_authed" });
    expect(mapped).toBeInstanceOf(SlackAuthConfigError);
    expect(mapped?.code).toBe("not_authed");
  });

  it("does not map network/timeout errors", () => {
    expect(toSlackAuthConfigError(new Error("ETIMEDOUT"))).toBeUndefined();
    expect(toSlackAuthConfigError(new Error("socket hang up"))).toBeUndefined();
  });

  it("does not map non-auth Slack API errors (e.g. missing_scope, rate_limited)", () => {
    expect(toSlackAuthConfigError(makePlatformError("missing_scope"))).toBeUndefined();
    expect(toSlackAuthConfigError(makePlatformError("rate_limited"))).toBeUndefined();
  });
});

describe("formatSlackErrorWithAuthRemediation", () => {
  it("upgrades a known auth-token error to the clear remediation message", () => {
    const message = formatSlackErrorWithAuthRemediation(makePlatformError("token_revoked"));
    expect(message).toContain("token_revoked");
    expect(message).toContain("Regenerate the token");
  });

  it("falls back to formatSlackError's generic detail formatting for non-auth errors", () => {
    const message = formatSlackErrorWithAuthRemediation(makePlatformError("channel_not_found"));
    expect(message).toContain("channel_not_found");
    expect(message).not.toContain("Regenerate the token");
  });
});

describe("wrapSlackClientAuthErrors", () => {
  it("rethrows an auth-token API error as SlackAuthConfigError", async () => {
    const client = {
      chat: {
        postMessage: async () => {
          throw makePlatformError("not_authed");
        },
      },
    };
    const wrapped = wrapSlackClientAuthErrors(client);
    await expect(wrapped.chat.postMessage()).rejects.toBeInstanceOf(SlackAuthConfigError);
  });

  it("passes through non-auth errors unchanged", async () => {
    const client = {
      chat: {
        postMessage: async () => {
          throw makePlatformError("channel_not_found");
        },
      },
    };
    const wrapped = wrapSlackClientAuthErrors(client);
    await expect(wrapped.chat.postMessage()).rejects.toMatchObject({
      data: { error: "channel_not_found" },
    });
  });

  it("passes through successful calls unchanged", async () => {
    const client = {
      chat: {
        postMessage: async () => ({ ok: true, ts: "123.456" }),
      },
    };
    const wrapped = wrapSlackClientAuthErrors(client);
    await expect(wrapped.chat.postMessage()).resolves.toEqual({ ok: true, ts: "123.456" });
  });
});

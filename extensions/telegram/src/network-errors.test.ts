// Telegram tests cover network errors plugin behavior.
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { describe, expect, it } from "vitest";
import {
  isRecoverableTelegramNetworkError,
  isRetryableTelegramApiError,
  isTelegramAuthenticationError,
  isTelegramRateLimitError,
  isSafeToRetrySendError,
  isTelegramClientRejection,
  isTelegramServerError,
  rethrowTelegramSendError,
  TelegramRequestNotStartedError,
} from "./network-errors.js";

const errorWithCode = (message: string, code: string) =>
  Object.assign(new Error(message), { code });
const errorWithTelegramCode = (message: string, error_code: number) =>
  Object.assign(new Error(message), { error_code });

function captureTelegramSendError(error: unknown): unknown {
  try {
    rethrowTelegramSendError(error);
  } catch (caught) {
    return caught;
  }
  throw new Error("Expected Telegram send error to be rethrown");
}

const plainErrorPredicateCases = [
  {
    name: "isTelegramServerError",
    predicate: isTelegramServerError,
    error: new Error("500: Internal Server Error"),
  },
  {
    name: "isTelegramClientRejection",
    predicate: isTelegramClientRejection,
    error: new Error("400: Bad Request"),
  },
];

const nestedErrorCodePredicateCases = [
  {
    name: "isTelegramRateLimitError",
    predicate: isTelegramRateLimitError,
    inner: Object.assign(new Error("Too Many Requests"), { error_code: 429 }),
  },
  {
    name: "isTelegramClientRejection",
    predicate: isTelegramClientRejection,
    inner: Object.assign(new Error("Forbidden"), { error_code: 403 }),
  },
];

describe("Telegram error_code predicate contracts", () => {
  it.each(plainErrorPredicateCases)(
    "$name returns false for plain Error",
    ({ error, predicate }) => {
      expect(predicate(error)).toBe(false);
    },
  );

  it.each(nestedErrorCodePredicateCases)(
    "$name detects error_code in nested cause",
    ({ inner, predicate }) => {
      const outer = Object.assign(new Error("wrapped"), { cause: inner });
      expect(predicate(outer)).toBe(true);
    },
  );
});

describe("isTelegramAuthenticationError", () => {
  it.each([
    ["Unauthorized", 401, true],
    ["Forbidden", 403, false],
    ["Not Found", 404, true],
  ])("returns %s for error_code %s", (message, errorCode, expected) => {
    expect(isTelegramAuthenticationError(errorWithTelegramCode(message, errorCode))).toBe(expected);
  });

  it("does not infer authentication failure from an unstructured message", () => {
    expect(isTelegramAuthenticationError(new Error("Unauthorized"))).toBe(false);
  });
});

describe("isRecoverableTelegramNetworkError", () => {
  it.each([
    ["ETIMEDOUT", "timeout"],
    ["ENETDOWN", "network down"],
    ["ECONNABORTED", "aborted"],
    ["ERR_NETWORK", "network"],
  ])("detects recoverable error code %s", (code, message) => {
    expect(isRecoverableTelegramNetworkError(errorWithCode(message, code))).toBe(true);
  });

  it("detects AbortError names", () => {
    const err = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    expect(isRecoverableTelegramNetworkError(err)).toBe(true);
  });

  it("detects nested causes", () => {
    const cause = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    const err = Object.assign(new TypeError("fetch failed"), { cause });
    expect(isRecoverableTelegramNetworkError(err)).toBe(true);
  });

  it("detects expanded message patterns", () => {
    expect(isRecoverableTelegramNetworkError(new Error("TypeError: fetch failed"))).toBe(true);
    expect(isRecoverableTelegramNetworkError(new Error("Undici: socket failure"))).toBe(true);
  });

  it("treats undici fetch failed errors as recoverable in send context", () => {
    const err = new TypeError("fetch failed");
    expect(isRecoverableTelegramNetworkError(err, { context: "send" })).toBe(true);
    expect(
      isRecoverableTelegramNetworkError(new Error("TypeError: fetch failed"), { context: "send" }),
    ).toBe(true);
    expect(isRecoverableTelegramNetworkError(err, { context: "polling" })).toBe(true);
  });

  it("honors allowMessageMatch=false for broad snippet matches", () => {
    expect(
      isRecoverableTelegramNetworkError(new Error("Undici: socket failure"), {
        allowMessageMatch: false,
      }),
    ).toBe(false);
    expect(
      isRecoverableTelegramNetworkError(new Error("TypeError: fetch failed"), {
        allowMessageMatch: false,
      }),
    ).toBe(true);
  });

  it("skips broad message matches for send context", () => {
    const networkRequestErr = new Error("Network request for 'sendMessage' failed!");
    expect(isRecoverableTelegramNetworkError(networkRequestErr, { context: "send" })).toBe(false);
    expect(isRecoverableTelegramNetworkError(networkRequestErr, { context: "polling" })).toBe(true);

    const undiciSnippetErr = new Error("Undici: socket failure");
    expect(isRecoverableTelegramNetworkError(undiciSnippetErr, { context: "send" })).toBe(false);
    expect(isRecoverableTelegramNetworkError(undiciSnippetErr, { context: "polling" })).toBe(true);
  });

  it("treats delete/react/edit/action (idempotent) contexts like polling, not send", () => {
    const undiciSnippetErr = new Error("Undici: socket failure");
    // delete, react, edit, and action are idempotent or non-message operations;
    // a transient snippet-only error must be retried (allowMessageMatch defaults true),
    // matching polling/webhook. send stays strict as the regression guard.
    expect(isRecoverableTelegramNetworkError(undiciSnippetErr, { context: "delete" })).toBe(true);
    expect(isRecoverableTelegramNetworkError(undiciSnippetErr, { context: "react" })).toBe(true);
    expect(isRecoverableTelegramNetworkError(undiciSnippetErr, { context: "edit" })).toBe(true);
    expect(isRecoverableTelegramNetworkError(undiciSnippetErr, { context: "action" })).toBe(true);
    expect(isRecoverableTelegramNetworkError(undiciSnippetErr, { context: "send" })).toBe(false);
  });

  it("treats grammY failed-after envelope errors as recoverable in send context", () => {
    expect(
      isRecoverableTelegramNetworkError(
        new Error("Network request for 'sendMessage' failed after 2 attempts."),
        { context: "send" },
      ),
    ).toBe(true);
  });

  it("keeps request-not-started markers recoverable across Telegram contexts", () => {
    const marker = new TelegramRequestNotStartedError();
    const wrapped = Object.assign(new Error("Network request for 'getUpdates' failed!"), {
      name: "HttpError",
      error: marker,
    });

    expect(isRecoverableTelegramNetworkError(marker, { context: "send" })).toBe(true);
    expect(isRecoverableTelegramNetworkError(wrapped, { context: "polling" })).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isRecoverableTelegramNetworkError(new Error("invalid token"))).toBe(false);
  });

  it("detects grammY 'timed out' long-poll errors (#7239)", () => {
    const err = new Error("Request to 'getUpdates' timed out after 500 seconds");
    expect(isRecoverableTelegramNetworkError(err)).toBe(true);
  });

  // Grammy HttpError tests (issue #3815)
  // Grammy wraps fetch errors in .error property, not .cause
  describe("Grammy HttpError", () => {
    class MockHttpError extends Error {
      constructor(
        message: string,
        public readonly error: unknown,
      ) {
        super(message);
        this.name = "HttpError";
      }
    }

    it("detects network error wrapped in HttpError", () => {
      const fetchError = new TypeError("fetch failed");
      const httpError = new MockHttpError(
        "Network request for 'setMyCommands' failed!",
        fetchError,
      );

      expect(isRecoverableTelegramNetworkError(httpError)).toBe(true);
    });

    it("detects network error with cause wrapped in HttpError", () => {
      const cause = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      const fetchError = Object.assign(new TypeError("fetch failed"), { cause });
      const httpError = new MockHttpError("Network request for 'getUpdates' failed!", fetchError);

      expect(isRecoverableTelegramNetworkError(httpError)).toBe(true);
    });

    it("returns false for non-network errors wrapped in HttpError", () => {
      const authError = new Error("Unauthorized: bot token is invalid");
      const httpError = new MockHttpError("Bad Request: invalid token", authError);

      expect(isRecoverableTelegramNetworkError(httpError)).toBe(false);
    });
  });
});

describe("isSafeToRetrySendError", () => {
  class MockHttpError extends Error {
    constructor(
      message: string,
      public readonly error: unknown,
    ) {
      super(message);
      this.name = "HttpError";
    }
  }

  it.each([
    ["ECONNREFUSED", "connect ECONNREFUSED", true],
    ["ENOTFOUND", "getaddrinfo ENOTFOUND", true],
    ["EAI_AGAIN", "getaddrinfo EAI_AGAIN", true],
    ["ENETDOWN", "connect ENETDOWN", true],
    ["ENETUNREACH", "connect ENETUNREACH", true],
    ["EHOSTUNREACH", "connect EHOSTUNREACH", true],
    ["ECONNRESET", "read ECONNRESET", false],
    ["ETIMEDOUT", "connect ETIMEDOUT", false],
    ["EPIPE", "write EPIPE", false],
    ["UND_ERR_CONNECT_TIMEOUT", "connect timeout", true],
  ])("returns %s => %s", (code, message, expected) => {
    expect(isSafeToRetrySendError(errorWithCode(message, code))).toBe(expected);
  });

  it("does NOT allow retry for non-network errors", () => {
    expect(isSafeToRetrySendError(new Error("400: Bad Request"))).toBe(false);
    expect(isSafeToRetrySendError(null)).toBe(false);
  });

  it("detects pre-connect error nested in cause chain", () => {
    const root = Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" });
    const wrapped = Object.assign(new Error("fetch failed"), { cause: root });
    expect(isSafeToRetrySendError(wrapped)).toBe(true);
  });

  it("detects pre-connect error wrapped in grammY HttpError", () => {
    const root = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const fetchError = Object.assign(new TypeError("fetch failed"), { cause: root });
    const wrapped = new MockHttpError("Network request for 'sendMessage' failed!", fetchError);
    expect(isSafeToRetrySendError(wrapped)).toBe(true);
  });

  it("does not infer safe send retry from a plain grammY network envelope", () => {
    const wrapped = new MockHttpError(
      "Network request for 'sendMessage' failed!",
      new TypeError("fetch failed"),
    );
    expect(isSafeToRetrySendError(wrapped)).toBe(false);
  });

  it("accepts only direct and exact grammY-wrapped request-not-started markers", () => {
    const marker = new TelegramRequestNotStartedError();

    expect(isSafeToRetrySendError(marker)).toBe(true);
    expect(
      isSafeToRetrySendError(
        new MockHttpError("Network request for 'sendMessage' failed!", marker),
      ),
    ).toBe(true);
  });

  it.each([
    ["status", Object.assign(new Error("Misdirected Request"), { status: 421 })],
    ["statusCode", Object.assign(new Error("Misdirected Request"), { statusCode: "421" })],
    ["error_code", errorWithTelegramCode("Misdirected Request", 421)],
    ["message", new Error("421 Misdirected Request")],
    [
      "nested cause",
      Object.assign(new Error("Network request for 'sendMessage' failed!"), {
        cause: Object.assign(new Error("Misdirected Request"), { status: 421 }),
      }),
    ],
    [
      "grammY HttpError",
      new MockHttpError(
        "Network request for 'sendMessage' failed!",
        Object.assign(new Error("Misdirected Request"), { status: 421 }),
      ),
    ],
  ])("does not infer safe retry from broad Telegram 421 shape %s", (_name, err) => {
    expect(isSafeToRetrySendError(err)).toBe(false);
  });

  it("does not parse malformed status strings as Telegram 421", () => {
    expect(
      isSafeToRetrySendError(
        Object.assign(new Error("Misdirected Request"), { statusCode: "421abc" }),
      ),
    ).toBe(false);
  });
});

describe("rethrowTelegramSendError", () => {
  const migratedChatId = -1_001_234_567_890;
  const migrationError = Object.assign(
    new Error("400: Bad Request: group chat was upgraded to a supergroup chat"),
    {
      name: "GrammyError",
      error_code: 400,
      description: "Bad Request: group chat was upgraded to a supergroup chat",
      parameters: { migrate_to_chat_id: migratedChatId },
    },
  );

  it.each([
    ["direct grammY rejection", migrationError],
    [
      "nested provider rejection",
      Object.assign(new Error("Telegram send failed"), { cause: migrationError }),
    ],
  ])("marks a migrated supergroup as a permanent non-dispatch for %s", (_name, error) => {
    const caught = captureTelegramSendError(error);

    expect(caught).toBeInstanceOf(PlatformMessageNotDispatchedError);
    expect(caught).toMatchObject({
      retryable: false,
      cause: error,
    });
    expect(caught).toMatchObject({ message: expect.stringContaining(String(migratedChatId)) });
  });

  it.each([
    ["rate limit", errorWithTelegramCode("Too Many Requests", 429)],
    ["server failure", errorWithTelegramCode("Bad Gateway", 502)],
    ["unrelated client rejection", errorWithTelegramCode("Bad Request: message is empty", 400)],
    ["ambiguous network failure", errorWithCode("read ECONNRESET", "ECONNRESET")],
    ...(["status", "statusCode"] as const).map((statusField): [string, Error] => [
      `non-Telegram ${statusField} lookalike`,
      Object.assign(new Error("migration-shaped HTTP error"), {
        [statusField]: 400,
        description: "Bad Request: group chat was upgraded to a supergroup chat",
        parameters: { migrate_to_chat_id: migratedChatId },
      }),
    ]),
    [
      "migration parameter without matching description",
      Object.assign(new Error("different bad request"), {
        error_code: 400,
        description: "Bad Request: chat not found",
        parameters: { migrate_to_chat_id: migratedChatId },
      }),
    ],
    ["plain migration text", new Error("400: group chat was upgraded to a supergroup chat")],
  ])("does not terminalize a %s", (_name, error) => {
    expect(captureTelegramSendError(error)).toBe(error);
  });

  it.each([
    ["without response parameters", undefined],
    ["with an unsafe replacement id", Number.MAX_SAFE_INTEGER + 1],
  ])("terminalizes a migration response %s without surfacing a target", (_name, target) => {
    const error = Object.assign(new Error("migration"), {
      error_code: 400,
      description: "Bad Request: group chat was upgraded to a supergroup chat",
      ...(target === undefined ? {} : { parameters: { migrate_to_chat_id: target } }),
    });

    const caught = captureTelegramSendError(error);

    expect(caught).toBeInstanceOf(PlatformMessageNotDispatchedError);
    expect(caught).toMatchObject({ retryable: false, cause: error });
    expect(caught).not.toMatchObject({ message: expect.stringContaining(String(target)) });
  });
});

describe("isTelegramServerError", () => {
  it.each([
    ["Internal Server Error", 500, true],
    ["Bad Gateway", 502, true],
    ["Forbidden", 403, false],
  ])("returns %s for error_code %s", (message, errorCode, expected) => {
    expect(isTelegramServerError(errorWithTelegramCode(message, errorCode))).toBe(expected);
  });
});

describe("isTelegramRateLimitError", () => {
  it("returns true for Telegram 429 errors", () => {
    expect(isTelegramRateLimitError(errorWithTelegramCode("Too Many Requests", 429))).toBe(true);
  });

  it("detects wrapped 429 retry_after errors without error_code", () => {
    const wrapped = {
      message: "429 Too Many Requests",
      response: { parameters: { retry_after: 1 } },
    };
    expect(isTelegramRateLimitError(wrapped)).toBe(true);
  });
});

describe("isRetryableTelegramApiError", () => {
  it.each([
    ["Too Many Requests", 429, true],
    ["Internal Server Error", 500, true],
    ["Bad Gateway", 502, true],
    ["Conflict", 409, false],
    ["Unauthorized", 401, false],
    ["Not Found", 404, false],
  ])("returns %s for error_code %s", (message, errorCode, expected) => {
    expect(isRetryableTelegramApiError(errorWithTelegramCode(message, errorCode))).toBe(expected);
  });
});

describe("isTelegramClientRejection", () => {
  it.each([
    ["Bad Request", 400, true],
    ["Forbidden", 403, true],
    ["Bad Gateway", 502, false],
  ])("returns %s for error_code %s", (message, errorCode, expected) => {
    expect(isTelegramClientRejection(errorWithTelegramCode(message, errorCode))).toBe(expected);
  });
});

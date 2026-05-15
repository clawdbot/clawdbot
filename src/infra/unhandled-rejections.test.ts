import { describe, expect, it } from "vitest";
import {
  isAbortError,
  isBenignUncaughtExceptionError,
  isTransientFileWatchError,
  isTransientNetworkError,
  isTransientSqliteError,
  isTransientUnhandledRejectionError,
} from "./unhandled-rejections.js";

describe("isAbortError", () => {
  it("returns true for error with name AbortError", () => {
    const error = new Error("aborted");
    error.name = "AbortError";
    expect(isAbortError(error)).toBe(true);
  });

  it('returns true for error with "This operation was aborted" message', () => {
    const error = new Error("This operation was aborted");
    expect(isAbortError(error)).toBe(true);
  });

  it("returns true for undici-style AbortError", () => {
    // Node's undici throws errors with this exact message
    const error = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    expect(isAbortError(error)).toBe(true);
  });

  it("returns true for object with AbortError name", () => {
    expect(isAbortError({ name: "AbortError", message: "test" })).toBe(true);
  });

  it("returns false for regular errors", () => {
    expect(isAbortError(new Error("Something went wrong"))).toBe(false);
    expect(isAbortError(new TypeError("Cannot read property"))).toBe(false);
    expect(isAbortError(new RangeError("Invalid array length"))).toBe(false);
  });

  it("returns false for errors with similar but different messages", () => {
    expect(isAbortError(new Error("Operation aborted"))).toBe(false);
    expect(isAbortError(new Error("aborted"))).toBe(false);
    expect(isAbortError(new Error("Request was aborted"))).toBe(false);
  });

  it.each([null, undefined, "string error", 42, { message: "plain object" }])(
    "returns false for non-abort input %#",
    (value) => {
      expect(isAbortError(value)).toBe(false);
    },
  );
});

describe("isTransientNetworkError", () => {
  it("returns true for errors with transient network codes", () => {
    const codes = [
      "ECONNRESET",
      "ECONNREFUSED",
      "ENOTFOUND",
      "ETIMEDOUT",
      "ESOCKETTIMEDOUT",
      "ECONNABORTED",
      "EPIPE",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "EADDRNOTAVAIL",
      "EAI_AGAIN",
      "EPROTO",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_SOCKET",
      "UND_ERR_HEADERS_TIMEOUT",
      "UND_ERR_BODY_TIMEOUT",
      "ERR_HTTP2_INVALID_SESSION",
      "ERR_SSL_WRONG_VERSION_NUMBER",
      "ERR_SSL_PROTOCOL_RETURNED_AN_ERROR",
    ];

    for (const code of codes) {
      const error = Object.assign(new Error("test"), { code });
      expect(isTransientNetworkError(error), `code: ${code}`).toBe(true);
    }
  });

  it('returns true for TypeError with "fetch failed" message', () => {
    const error = new TypeError("fetch failed");
    expect(isTransientNetworkError(error)).toBe(true);
  });

  it("returns true for fetch failed with network cause", () => {
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    const error = Object.assign(new TypeError("fetch failed"), { cause });
    expect(isTransientNetworkError(error)).toBe(true);
  });

  it("returns true for fetch failed with unclassified cause", () => {
    const cause = Object.assign(new Error("unknown socket state"), { code: "UNKNOWN" });
    const error = Object.assign(new TypeError("fetch failed"), { cause });
    expect(isTransientNetworkError(error)).toBe(true);
  });

  it("returns true for nested cause chain with network error", () => {
    const innerCause = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    const outerCause = Object.assign(new Error("wrapper"), { cause: innerCause });
    const error = Object.assign(new TypeError("fetch failed"), { cause: outerCause });
    expect(isTransientNetworkError(error)).toBe(true);
  });

  it("returns true for destroyed HTTP/2 sessions from undici", () => {
    const innerCause = Object.assign(new Error("The session has been destroyed"), {
      code: "ERR_HTTP2_INVALID_SESSION",
    });
    const outerCause = Object.assign(new Error("model call failed"), { cause: innerCause });

    expect(isTransientNetworkError(innerCause)).toBe(true);
    expect(isTransientNetworkError(outerCause)).toBe(true);
    expect(isTransientNetworkError(new Error("ERR_HTTP2_INVALID_SESSION"))).toBe(true);
  });

  it("returns true for Slack request errors that wrap network codes in .original", () => {
    const error = Object.assign(new Error("A request error occurred: getaddrinfo EAI_AGAIN"), {
      code: "slack_webapi_request_error",
      original: {
        errno: -3001,
        code: "EAI_AGAIN",
        syscall: "getaddrinfo",
        hostname: "slack.com",
      },
    });
    expect(isTransientNetworkError(error)).toBe(true);
  });

  it("returns true for network codes nested in .data payloads", () => {
    const error = {
      code: "slack_webapi_request_error",
      message: "A request error occurred",
      data: {
        code: "EAI_AGAIN",
      },
    };
    expect(isTransientNetworkError(error)).toBe(true);
  });

  it("returns true for AggregateError containing network errors", () => {
    const networkError = Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
    const error = new AggregateError([networkError], "Multiple errors");
    expect(isTransientNetworkError(error)).toBe(true);
  });

  it("returns true for wrapped fetch-failed messages from integration clients", () => {
    const error = new Error("Failed to get gateway information from Discord: fetch failed");
    expect(isTransientNetworkError(error)).toBe(true);
  });

  it("returns true for wrapped Discord upstream-connect parse failures", () => {
    const error = new Error(
      `Failed to get gateway information from Discord: Unexpected token 'u', "upstream connect error or disconnect/reset before headers. reset reason: overflow" is not valid JSON`,
    );
    expect(isTransientNetworkError(error)).toBe(true);
  });

  it("returns false for non-network fetch-failed wrappers from tools", () => {
    const error = new Error("Web fetch failed (404): Not Found");
    expect(isTransientNetworkError(error)).toBe(false);
  });

  it("returns true for TLS/SSL transient message snippets", () => {
    expect(isTransientNetworkError(new Error("write EPROTO 00A8B0C9:error"))).toBe(true);
    expect(
      isTransientNetworkError(
        new Error("SSL routines:OPENSSL_internal:WRONG_VERSION_NUMBER while connecting"),
      ),
    ).toBe(true);
    expect(isTransientNetworkError(new Error("tlsv1 alert protocol version"))).toBe(true);
  });

  it("returns false for regular errors without network codes", () => {
    expect(isTransientNetworkError(new Error("Something went wrong"))).toBe(false);
    expect(isTransientNetworkError(new TypeError("Cannot read property"))).toBe(false);
    expect(isTransientNetworkError(new RangeError("Invalid array length"))).toBe(false);
  });

  it("returns false for errors with non-network codes", () => {
    const error = Object.assign(new Error("test"), { code: "INVALID_CONFIG" });
    expect(isTransientNetworkError(error)).toBe(false);
  });

  it("returns false for Slack request errors without network indicators", () => {
    const error = Object.assign(new Error("A request error occurred"), {
      code: "slack_webapi_request_error",
    });
    expect(isTransientNetworkError(error)).toBe(false);
  });

  it("returns false for non-transient undici codes that only appear in message text", () => {
    const error = new Error("Request failed with UND_ERR_INVALID_ARG");
    expect(isTransientNetworkError(error)).toBe(false);
  });

  it.each([null, undefined, "string error", 42, { message: "plain object" }])(
    "returns false for non-network input %#",
    (value) => {
      expect(isTransientNetworkError(value)).toBe(false);
    },
  );

  it("returns false for AggregateError with only non-network errors", () => {
    const error = new AggregateError([new Error("regular error")], "Multiple errors");
    expect(isTransientNetworkError(error)).toBe(false);
  });
});

describe("isTransientSqliteError", () => {
  it("returns true for named transient SQLite codes", () => {
    const codes = ["SQLITE_CANTOPEN", "SQLITE_BUSY", "SQLITE_LOCKED", "SQLITE_IOERR"];

    for (const code of codes) {
      const error = Object.assign(new Error("sqlite transient"), { code });
      expect(isTransientSqliteError(error), `code: ${code}`).toBe(true);
    }
  });

  it("returns true for node:sqlite transient errcodes", () => {
    const sqliteCases = [
      { errcode: 14, errstr: "unable to open database file" },
      { errcode: 5, errstr: "database is locked" },
      { errcode: 6, errstr: "database table is locked" },
      { errcode: 10, errstr: "disk I/O error" },
    ] as const;

    for (const { errcode, errstr } of sqliteCases) {
      const error = Object.assign(new Error(errstr), {
        code: "ERR_SQLITE_ERROR",
        errcode,
        errstr,
      });
      expect(isTransientSqliteError(error), `errcode: ${errcode}`).toBe(true);
    }
  });

  it("returns true for wrapped SQLite message strings", () => {
    const error = new Error("SQLITE_BUSY: database is locked");
    expect(isTransientSqliteError(error)).toBe(true);
  });

  it("returns false for non-transient SQLite failures", () => {
    const constraintError = Object.assign(new Error("UNIQUE constraint failed"), {
      code: "SQLITE_CONSTRAINT",
    });
    const genericSqliteError = Object.assign(new Error("constraint failed"), {
      code: "ERR_SQLITE_ERROR",
      errcode: 19,
      errstr: "constraint failed",
    });

    expect(isTransientSqliteError(constraintError)).toBe(false);
    expect(isTransientSqliteError(genericSqliteError)).toBe(false);
  });

  it("returns false for matching errcodes without SQLite context", () => {
    const error = Object.assign(new Error("plain error"), {
      code: "ERR_OTHER",
      errcode: 14,
      errstr: "unable to open database file",
    });

    expect(isTransientSqliteError(error)).toBe(false);
  });

  it("returns false for SQLite-like snippets without SQLite context", () => {
    const error = new Error("database is locked");

    expect(isTransientSqliteError(error)).toBe(false);
  });
});

describe("isTransientFileWatchError", () => {
  it("returns true for ENOSPC with inotify message", () => {
    const error = Object.assign(new Error("inotify watches exhausted"), { code: "ENOSPC" });
    expect(isTransientFileWatchError(error)).toBe(true);
  });

  it("returns true for ENOSPC with file watcher message", () => {
    const error = Object.assign(new Error("System limit for number of file watchers reached"), {
      code: "ENOSPC",
    });
    expect(isTransientFileWatchError(error)).toBe(true);
  });

  it("returns true for ENOSPC with watcher error message", () => {
    const error = Object.assign(new Error("watcher error: ENOSPC"), { code: "ENOSPC" });
    expect(isTransientFileWatchError(error)).toBe(true);
  });

  it("returns false for ENOSPC without watch indicator in file-watch classifier", () => {
    const error = Object.assign(new Error("write failed: no space left on device"), {
      code: "ENOSPC",
    });
    expect(isTransientFileWatchError(error)).toBe(false);
  });

  it("returns false for ENOSPC with only 'disk full' message", () => {
    const error = Object.assign(new Error("ENOSPC: disk full"), { code: "ENOSPC" });
    expect(isTransientFileWatchError(error)).toBe(false);
  });

  it("returns false for message-only disk full without watch indicator", () => {
    expect(isTransientFileWatchError(new Error("write failed: no space left on device"))).toBe(
      false,
    );
    expect(isTransientFileWatchError(new Error("ENOSPC: no space left on device"))).toBe(false);
  });

  it("returns true for 'no space left on device' message with watcher context", () => {
    const error = new Error("file watcher: no space left on device");
    expect(isTransientFileWatchError(error)).toBe(true);
  });

  it("returns true for inotify-related error messages", () => {
    expect(isTransientFileWatchError(new Error("inotify watches exhausted"))).toBe(true);
    expect(
      isTransientFileWatchError(new Error("System limit for number of file watchers reached")),
    ).toBe(true);
  });

  it("returns true for watcher-related no-space messages", () => {
    expect(isTransientFileWatchError(new Error("file watcher: no space left on device"))).toBe(
      true,
    );
  });

  it("returns false for generic code-less watcher messages", () => {
    expect(isTransientFileWatchError(new Error("file watcher failed"))).toBe(false);
    expect(isTransientFileWatchError(new Error("watcher error: boom"))).toBe(false);
    expect(isTransientFileWatchError(new Error("watcher error: ENOSPC"))).toBe(false);
    expect(isTransientUnhandledRejectionError(new Error("file watcher failed"))).toBe(false);
    expect(isTransientUnhandledRejectionError(new Error("watcher error: boom"))).toBe(false);
    expect(isTransientUnhandledRejectionError(new Error("watcher error: ENOSPC"))).toBe(false);
  });

  it("returns true for ENOSPC with cause chain containing watch indicator", () => {
    const cause = Object.assign(new Error("inotify watches exhausted"), { code: "ENOSPC" });
    const error = Object.assign(new Error("watcher failed"), { cause });
    expect(isTransientFileWatchError(error)).toBe(true);
  });

  it("returns false for 'watchdog timeout' (unrelated watch error)", () => {
    expect(isTransientFileWatchError(new Error("watchdog timeout"))).toBe(false);
    expect(isTransientFileWatchError(new Error("cannot watch process"))).toBe(false);
  });

  it("returns false for regular errors without file watch indicators", () => {
    expect(isTransientFileWatchError(new Error("Something went wrong"))).toBe(false);
    expect(isTransientFileWatchError(new TypeError("Cannot read property"))).toBe(false);
    expect(isTransientFileWatchError(new RangeError("Invalid array length"))).toBe(false);
  });

  it("returns false for other disk errors without ENOSPC", () => {
    expect(isTransientFileWatchError(new Error("disk quota exceeded"))).toBe(false);
    expect(
      isTransientFileWatchError(
        Object.assign(new Error("read only file system"), { code: "EROFS" }),
      ),
    ).toBe(false);
  });

  it.each([null, undefined, "string error", 42, { message: "plain object" }])(
    "returns false for non-file-watch input %#",
    (value) => {
      expect(isTransientFileWatchError(value)).toBe(false);
    },
  );
});

describe("isTransientUnhandledRejectionError", () => {
  it("treats raw pre-connect network uncaught exceptions as benign", () => {
    const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    const sqlite = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    const network = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    const hostUnreachable = Object.assign(new Error("connect EHOSTUNREACH"), {
      code: "EHOSTUNREACH",
    });
    const rawHostUnreachable = new Error(
      "connect EHOSTUNREACH 149.154.167.220:443 - Local (10.0.10.40:50017)",
    );
    const addressUnavailable = Object.assign(new Error("connect EADDRNOTAVAIL"), {
      code: "EADDRNOTAVAIL",
    });
    const rawAddressUnavailable = new Error(
      "connect EADDRNOTAVAIL 2607:6bc0::10:443 - Local (:::0)",
    );
    const destroyedHttp2Session = Object.assign(new Error("The session has been destroyed"), {
      code: "ERR_HTTP2_INVALID_SESSION",
    });
    const wrappedDestroyedHttp2Session = Object.assign(new Error("model call failed"), {
      cause: destroyedHttp2Session,
    });
    const generic = new Error("boom");

    expect(isBenignUncaughtExceptionError(epipe)).toBe(true);
    expect(isBenignUncaughtExceptionError(sqlite)).toBe(false);
    expect(isBenignUncaughtExceptionError(network)).toBe(false);
    expect(isBenignUncaughtExceptionError(hostUnreachable)).toBe(true);
    expect(isBenignUncaughtExceptionError(rawHostUnreachable)).toBe(true);
    expect(isBenignUncaughtExceptionError(addressUnavailable)).toBe(true);
    expect(isBenignUncaughtExceptionError(rawAddressUnavailable)).toBe(true);
    expect(isBenignUncaughtExceptionError(destroyedHttp2Session)).toBe(true);
    expect(isBenignUncaughtExceptionError(wrappedDestroyedHttp2Session)).toBe(true);
    expect(isBenignUncaughtExceptionError(new Error("ERR_HTTP2_INVALID_SESSION"))).toBe(true);
    expect(isBenignUncaughtExceptionError(generic)).toBe(false);
  });
  it("returns true for transient SQLite errors", () => {
    const error = Object.assign(new Error("unable to open database file"), {
      code: "ERR_SQLITE_ERROR",
      errcode: 14,
      errstr: "unable to open database file",
    });

    expect(isTransientUnhandledRejectionError(error)).toBe(true);
  });

  it("returns true for transient file watcher errors (ENOSPC + inotify)", () => {
    const error = Object.assign(new Error("inotify watches exhausted"), { code: "ENOSPC" });
    expect(isTransientUnhandledRejectionError(error)).toBe(true);
  });

  it("returns true for file watcher errors with message only", () => {
    const error = new Error("System limit for number of file watchers reached");
    expect(isTransientUnhandledRejectionError(error)).toBe(true);
  });

  it("returns false for ENOSPC without watch indicator in unhandled-rejection classifier", () => {
    const error = Object.assign(new Error("write failed: no space left on device"), {
      code: "ENOSPC",
    });
    expect(isTransientUnhandledRejectionError(error)).toBe(false);
  });

  it("returns false for code-less disk full messages without watch indicator", () => {
    expect(
      isTransientUnhandledRejectionError(new Error("write failed: no space left on device")),
    ).toBe(false);
    expect(isTransientUnhandledRejectionError(new Error("ENOSPC: no space left on device"))).toBe(
      false,
    );
  });
});

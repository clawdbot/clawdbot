import process from "node:process";
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";

const restoreTerminalStateMock = vi.hoisted(() => vi.fn());

vi.mock("../terminal/restore.js", () => ({
  restoreTerminalState: restoreTerminalStateMock,
}));

import { resetFatalErrorHooksForTest } from "./fatal-error-hooks.js";
import {
  installUnhandledRejectionHandler,
  isUncaughtExceptionHandled,
  registerUncaughtExceptionHandler,
} from "./unhandled-rejections.js";

describe("installUnhandledRejectionHandler - fatal detection", () => {
  let exitCalls: Array<string | number | null> = [];
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let originalExit: typeof process.exit;

  beforeAll(() => {
    originalExit = process.exit.bind(process);
    installUnhandledRejectionHandler();
  });

  beforeEach(() => {
    exitCalls = [];
    resetFatalErrorHooksForTest();

    vi.spyOn(process, "exit").mockImplementation((code?: string | number | null): never => {
      if (code !== undefined && code !== null) {
        exitCalls.push(code);
      }
      return undefined as never;
    });

    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.clearAllMocks();
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  afterAll(() => {
    process.exit = originalExit;
  });

  function emitUnhandled(reason: unknown): void {
    process.emit("unhandledRejection", reason, Promise.resolve());
  }

  function expectConsoleLogWithMessage(
    spy: ReturnType<typeof vi.spyOn>,
    label: string,
    message: string,
  ): void {
    const call = spy.mock.calls.find((entry: unknown[]) => entry[0] === label);
    expect(call?.[0]).toBe(label);
    expect(String(call?.[1])).toContain(message);
  }

  function expectExitCodeFromUnhandled(
    reason: unknown,
    expected: number[],
    expectedRestoreReason?: string,
  ): void {
    exitCalls = [];
    restoreTerminalStateMock.mockClear();
    emitUnhandled(reason);
    expect(exitCalls).toEqual(expected);
    if (expectedRestoreReason) {
      expect(restoreTerminalStateMock).toHaveBeenCalledWith(expectedRestoreReason, {
        resumeStdinIfPaused: false,
      });
      return;
    }
    expect(restoreTerminalStateMock).not.toHaveBeenCalled();
  }

  describe("fatal errors", () => {
    it("exits on fatal runtime codes", () => {
      const fatalCases = [
        { code: "ERR_OUT_OF_MEMORY", message: "Out of memory" },
        { code: "ERR_SCRIPT_EXECUTION_TIMEOUT", message: "Script execution timeout" },
        { code: "ERR_WORKER_OUT_OF_MEMORY", message: "Worker out of memory" },
      ] as const;

      for (const { code, message } of fatalCases) {
        expectExitCodeFromUnhandled(
          Object.assign(new Error(message), { code }),
          [1],
          "fatal unhandled rejection",
        );
      }

      expectConsoleLogWithMessage(
        consoleErrorSpy,
        "[openclaw] FATAL unhandled rejection:",
        "Out of memory",
      );
    });
  });

  describe("scoped uncaught exception handlers", () => {
    it("lets registered handlers suppress known dependency exceptions", () => {
      const cleanup = registerUncaughtExceptionHandler((error) => {
        return error instanceof Error && error.message === "known dependency assertion";
      });

      expect(isUncaughtExceptionHandled(new Error("known dependency assertion"))).toBe(true);
      expect(isUncaughtExceptionHandled(new Error("unknown"))).toBe(false);

      cleanup();
      expect(isUncaughtExceptionHandled(new Error("known dependency assertion"))).toBe(false);
    });
  });

  describe("configuration errors", () => {
    it("exits on configuration error codes", () => {
      const configurationCases = [
        { code: "INVALID_CONFIG", message: "Invalid config" },
        { code: "MISSING_API_KEY", message: "Missing API key" },
      ] as const;

      for (const { code, message } of configurationCases) {
        expectExitCodeFromUnhandled(
          Object.assign(new Error(message), { code }),
          [1],
          "configuration error",
        );
      }

      expectConsoleLogWithMessage(
        consoleErrorSpy,
        "[openclaw] CONFIGURATION ERROR - requires fix:",
        "Invalid config",
      );
    });
  });

  describe("non-fatal errors", () => {
    it("does not exit on known transient network errors", () => {
      const transientCases: unknown[] = [
        Object.assign(new TypeError("fetch failed"), {
          cause: { code: "UND_ERR_CONNECT_TIMEOUT", syscall: "connect" },
        }),
        Object.assign(new Error("DNS resolve failed"), { code: "UND_ERR_DNS_RESOLVE_FAILED" }),
        Object.assign(new Error("Connection reset"), { code: "ECONNRESET" }),
        Object.assign(new Error("Timeout"), { code: "ETIMEDOUT" }),
        Object.assign(
          new Error(
            "A request error occurred: Client network socket disconnected before secure TLS connection was established",
          ),
          { code: "slack_webapi_request_error" },
        ),
        Object.assign(new Error("A request error occurred: getaddrinfo EAI_AGAIN slack.com"), {
          code: "slack_webapi_request_error",
          original: { code: "EAI_AGAIN", syscall: "getaddrinfo", hostname: "slack.com" },
        }),
        Object.assign(new Error("A request error occurred: unknown"), {
          code: "slack_webapi_request_error",
          original: Object.assign(new Error("connect timeout"), {
            code: "UND_ERR_CONNECT_TIMEOUT",
          }),
        }),
      ];

      // Wrapped fetch-failed (e.g. Discord: "Failed to get gateway information from Discord: fetch failed")
      transientCases.push(
        new Error("Failed to get gateway information from Discord: fetch failed"),
      );

      for (const transientErr of transientCases) {
        expectExitCodeFromUnhandled(transientErr, []);
      }

      expectConsoleLogWithMessage(
        consoleWarnSpy,
        "[openclaw] Non-fatal unhandled rejection (continuing):",
        "fetch failed",
      );
    });

    it("does not exit on transient SQLite errors", () => {
      const sqliteCases: unknown[] = [
        Object.assign(new Error("unable to open database file"), {
          code: "SQLITE_CANTOPEN",
        }),
        Object.assign(new Error("database is locked"), {
          code: "ERR_SQLITE_ERROR",
          errcode: 5,
          errstr: "database is locked",
        }),
        new Error("SQLITE_IOERR: disk I/O error"),
      ];

      for (const sqliteErr of sqliteCases) {
        expectExitCodeFromUnhandled(sqliteErr, []);
      }

      expectConsoleLogWithMessage(
        consoleWarnSpy,
        "[openclaw] Non-fatal unhandled rejection (continuing):",
        "unable to open database file",
      );
    });

    it("exits on generic errors without code", () => {
      const genericErr = new Error("Something went wrong");

      expectExitCodeFromUnhandled(genericErr, [1], "unhandled rejection");
      expectConsoleLogWithMessage(
        consoleErrorSpy,
        "[openclaw] Unhandled promise rejection:",
        "Something went wrong",
      );
    });

    it("exits on non-transient Slack request errors", () => {
      const slackErr = Object.assign(
        new Error("A request error occurred: invalid request payload"),
        {
          code: "slack_webapi_request_error",
        },
      );

      expectExitCodeFromUnhandled(slackErr, [1], "unhandled rejection");
    });

    it("does not exit on AbortError and logs suppression warning", () => {
      const abortErr = new Error("This operation was aborted");
      abortErr.name = "AbortError";

      expectExitCodeFromUnhandled(abortErr, []);
      expectConsoleLogWithMessage(
        consoleWarnSpy,
        "[openclaw] Suppressed AbortError:",
        "This operation was aborted",
      );
    });
  });
});

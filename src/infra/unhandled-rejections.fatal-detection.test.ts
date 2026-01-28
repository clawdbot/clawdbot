import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import process from "node:process";

import { installUnhandledRejectionHandler } from "./unhandled-rejections.js";

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

    vi.spyOn(process, "exit").mockImplementation((code: string | number | null | undefined) => {
      if (code !== undefined && code !== null) {
        exitCalls.push(code);
      }
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

  describe("fatal errors", () => {
    it("exits on ERR_OUT_OF_MEMORY", () => {
      const oomErr = Object.assign(new Error("Out of memory"), {
        code: "ERR_OUT_OF_MEMORY",
      });

      process.emit("unhandledRejection", oomErr, Promise.resolve());

      expect(exitCalls).toEqual([1]);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "[moltbot] FATAL unhandled rejection:",
        expect.stringContaining("Out of memory"),
      );
    });

    it("exits on ERR_SCRIPT_EXECUTION_TIMEOUT", () => {
      const timeoutErr = Object.assign(new Error("Script execution timeout"), {
        code: "ERR_SCRIPT_EXECUTION_TIMEOUT",
      });

      process.emit("unhandledRejection", timeoutErr, Promise.resolve());

      expect(exitCalls).toEqual([1]);
    });

    it("exits on ERR_WORKER_OUT_OF_MEMORY", () => {
      const workerOomErr = Object.assign(new Error("Worker out of memory"), {
        code: "ERR_WORKER_OUT_OF_MEMORY",
      });

      process.emit("unhandledRejection", workerOomErr, Promise.resolve());

      expect(exitCalls).toEqual([1]);
    });
  });

  describe("configuration errors", () => {
    it("exits on INVALID_CONFIG", () => {
      const configErr = Object.assign(new Error("Invalid config"), {
        code: "INVALID_CONFIG",
      });

      process.emit("unhandledRejection", configErr, Promise.resolve());

      expect(exitCalls).toEqual([1]);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "[moltbot] CONFIGURATION ERROR - requires fix:",
        expect.stringContaining("Invalid config"),
      );
    });

    it("exits on MISSING_API_KEY", () => {
      const missingKeyErr = Object.assign(new Error("Missing API key"), {
        code: "MISSING_API_KEY",
      });

      process.emit("unhandledRejection", missingKeyErr, Promise.resolve());

      expect(exitCalls).toEqual([1]);
    });
  });

  describe("non-fatal errors", () => {
    it("does NOT exit on undici fetch failures", () => {
      const fetchErr = Object.assign(new TypeError("fetch failed"), {
        cause: { code: "UND_ERR_CONNECT_TIMEOUT", syscall: "connect" },
      });

      process.emit("unhandledRejection", fetchErr, Promise.resolve());

      expect(exitCalls).toEqual([]);
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        "[moltbot] Non-fatal unhandled rejection (continuing):",
        expect.stringContaining("fetch failed"),
      );
    });

    it("does NOT exit on DNS resolution failures", () => {
      const dnsErr = Object.assign(new Error("DNS resolve failed"), {
        code: "UND_ERR_DNS_RESOLVE_FAILED",
      });

      process.emit("unhandledRejection", dnsErr, Promise.resolve());

      expect(exitCalls).toEqual([]);
      expect(consoleWarnSpy).toHaveBeenCalled();
    });

    it("exits on generic errors without code", () => {
      const genericErr = new Error("Something went wrong");

      process.emit("unhandledRejection", genericErr, Promise.resolve());

      expect(exitCalls).toEqual([1]);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "[moltbot] Unhandled promise rejection:",
        expect.stringContaining("Something went wrong"),
      );
    });

    it("does NOT exit on connection reset errors", () => {
      const connResetErr = Object.assign(new Error("Connection reset"), {
        code: "ECONNRESET",
      });

      process.emit("unhandledRejection", connResetErr, Promise.resolve());

      expect(exitCalls).toEqual([]);
      expect(consoleWarnSpy).toHaveBeenCalled();
    });

    it("does NOT exit on timeout errors", () => {
      const timeoutErr = Object.assign(new Error("Timeout"), {
        code: "ETIMEDOUT",
      });

      process.emit("unhandledRejection", timeoutErr, Promise.resolve());

      expect(exitCalls).toEqual([]);
      expect(consoleWarnSpy).toHaveBeenCalled();
    });
  });
});

import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  enableConsoleCapture,
  resetLogger,
  routeLogsToStderr,
  setLoggerOverride,
} from "../logging.js";
import { loggingState } from "./state.js";

type ConsoleSnapshot = {
  log: typeof console.log;
  info: typeof console.info;
  warn: typeof console.warn;
  error: typeof console.error;
  debug: typeof console.debug;
  trace: typeof console.trace;
};

let snapshot: ConsoleSnapshot;

beforeEach(() => {
  snapshot = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
    trace: console.trace,
  };
  loggingState.consolePatched = false;
  loggingState.forceConsoleToStderr = false;
  loggingState.rawConsole = null;
  resetLogger();
});

afterEach(() => {
  console.log = snapshot.log;
  console.info = snapshot.info;
  console.warn = snapshot.warn;
  console.error = snapshot.error;
  console.debug = snapshot.debug;
  console.trace = snapshot.trace;
  loggingState.consolePatched = false;
  loggingState.forceConsoleToStderr = false;
  loggingState.rawConsole = null;
  resetLogger();
  setLoggerOverride(null);
  vi.restoreAllMocks();
});

describe("enableConsoleCapture", () => {
  it("swallows EIO from stderr writes", () => {
    setLoggerOverride({ level: "info", file: tempLogPath() });
    vi.spyOn(process.stderr, "write").mockImplementation(() => {
      throw eioError();
    });
    routeLogsToStderr();
    enableConsoleCapture();
    expect(() => console.log("hello")).not.toThrow();
  });

  it("swallows EIO from original console writes", () => {
    setLoggerOverride({ level: "info", file: tempLogPath() });
    console.log = () => {
      throw eioError();
    };
    enableConsoleCapture();
    expect(() => console.log("hello")).not.toThrow();
  });
});

function tempLogPath() {
  return path.join(os.tmpdir(), `clawdbot-log-${crypto.randomUUID()}.log`);
}

function eioError() {
  const err = new Error("EIO") as NodeJS.ErrnoException;
  err.code = "EIO";
  return err;
}

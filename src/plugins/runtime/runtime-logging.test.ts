// Runtime logging tests cover plugin runtime log routing and verbosity behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";

const loggingMocks = vi.hoisted(() => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const isFileLogLevelEnabled = vi.fn((_level: string) => true);
  return {
    childLogger,
    getChildLogger: vi.fn(() => childLogger),
    isFileLogLevelEnabled,
  };
});

vi.mock("../../globals.js", () => ({
  shouldLogVerbose: vi.fn(() => false),
}));

vi.mock("../../logging.js", () => ({
  getChildLogger: loggingMocks.getChildLogger,
  isFileLogLevelEnabled: loggingMocks.isFileLogLevelEnabled,
}));

let createRuntimeLogging: typeof import("./runtime-logging.js").createRuntimeLogging;

beforeEach(async () => {
  vi.clearAllMocks();
  loggingMocks.getChildLogger.mockReturnValue(loggingMocks.childLogger);
  loggingMocks.isFileLogLevelEnabled.mockReturnValue(true);
  ({ createRuntimeLogging } = await import("./runtime-logging.js"));
});

describe("createRuntimeLogging", () => {
  it("forwards structured metadata to child loggers", () => {
    const logging = createRuntimeLogging();
    const logger = logging.getChildLogger({ plugin: "discord" }, { level: "warn" });
    const meta = {
      errorName: "Error",
      errorCauseName: "TypeError",
    };

    logger.debug?.("debug details", meta);
    logger.info("info details", meta);
    logger.warn("warn details", meta);
    logger.error("error details", meta);

    expect(loggingMocks.getChildLogger).toHaveBeenCalledWith(
      { plugin: "discord" },
      { level: "warn" },
    );
    expect(loggingMocks.childLogger.debug).toHaveBeenCalledWith(meta, "debug details");
    expect(loggingMocks.childLogger.info).toHaveBeenCalledWith(meta, "info details");
    expect(loggingMocks.childLogger.warn).toHaveBeenCalledWith(meta, "warn details");
    expect(loggingMocks.childLogger.error).toHaveBeenCalledWith(meta, "error details");
  });

  it("resolves the child logger per call so a runtime log-level change takes effect", () => {
    const logging = createRuntimeLogging();
    // Mirror a long-lived channel monitor: capture the logger once, log later.
    const logger = logging.getChildLogger({ module: "mattermost" });

    // Level is below debug when the monitor starts: the write is dropped.
    loggingMocks.isFileLogLevelEnabled.mockReturnValue(false);
    logger.debug?.("dropped before debug enabled");
    expect(loggingMocks.childLogger.debug).not.toHaveBeenCalled();
    expect(loggingMocks.getChildLogger).not.toHaveBeenCalled();

    // Log level raised to debug on the running gateway: the same captured logger
    // must now write, because it re-resolves the child logger per call.
    loggingMocks.isFileLogLevelEnabled.mockReturnValue(true);
    logger.debug?.("written after debug enabled");
    expect(loggingMocks.getChildLogger).toHaveBeenCalledWith({ module: "mattermost" }, undefined);
    expect(loggingMocks.childLogger.debug).toHaveBeenCalledWith("written after debug enabled");
  });

  it("pre-gates on the current file level when no override is set", () => {
    loggingMocks.isFileLogLevelEnabled.mockImplementation((level: string) => level !== "debug");
    const logging = createRuntimeLogging();
    const logger = logging.getChildLogger({ module: "mattermost" });

    logger.debug?.("debug suppressed at info");
    logger.info("info written at info");

    expect(loggingMocks.childLogger.debug).not.toHaveBeenCalled();
    expect(loggingMocks.childLogger.info).toHaveBeenCalledWith("info written at info");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const loggingMocks = vi.hoisted(() => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return {
    childLogger,
    getChildLogger: vi.fn(() => childLogger),
  };
});

vi.mock("../../globals.js", () => ({
  shouldLogVerbose: vi.fn(() => false),
}));

vi.mock("../../logging.js", () => ({
  getChildLogger: loggingMocks.getChildLogger,
}));

let createRuntimeLogging: typeof import("./runtime-logging.js").createRuntimeLogging;

beforeEach(async () => {
  vi.clearAllMocks();
  loggingMocks.getChildLogger.mockReturnValue(loggingMocks.childLogger);
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
});

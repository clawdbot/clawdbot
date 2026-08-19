// Level filter tests cover logger filtering by configured log level.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { readLoggingConfigMock } = vi.hoisted(() => ({
  readLoggingConfigMock: vi.fn<() => { level: "silent" } | { consoleLevel: "silent" } | undefined>(
    () => undefined,
  ),
}));

vi.mock("./config.js", () => ({
  invalidateLoggingConfigCache: vi.fn(),
  readLoggingConfig: readLoggingConfigMock,
}));

let logging: typeof import("../logging.js");

beforeAll(async () => {
  logging = await import("../logging.js");
});

beforeEach(() => {
  delete process.env.OPENCLAW_TEST_FILE_LOG;
  delete process.env.OPENCLAW_TEST_CONSOLE;
  delete process.env.OPENCLAW_LOG_LEVEL;
  readLoggingConfigMock.mockClear();
  logging.resetLogger();
  logging.setLoggerOverride(null);
});

afterEach(() => {
  delete process.env.OPENCLAW_TEST_FILE_LOG;
  delete process.env.OPENCLAW_TEST_CONSOLE;
  delete process.env.OPENCLAW_LOG_LEVEL;
  logging.resetLogger();
  logging.setLoggerOverride(null);
  vi.restoreAllMocks();
});

describe("resolved logging settings cache", () => {
  it("loads file settings once per logger generation", () => {
    process.env.OPENCLAW_TEST_FILE_LOG = "1";
    readLoggingConfigMock.mockReturnValue({ level: "silent" });
    logging.setLoggerConfigLoaderForTests(readLoggingConfigMock);

    logging.getLogger();
    logging.getLogger();
    expect(readLoggingConfigMock).toHaveBeenCalledTimes(1);

    logging.setLoggerOverride({ level: "silent" });
    logging.getLogger();
    expect(readLoggingConfigMock).toHaveBeenCalledTimes(1);

    logging.setLoggerOverride(null);
    logging.getLogger();
    logging.getLogger();
    expect(readLoggingConfigMock).toHaveBeenCalledTimes(2);
  });

  it("reuses settings resolved by the file-level admission check when building the logger", () => {
    process.env.OPENCLAW_TEST_FILE_LOG = "1";
    readLoggingConfigMock.mockReturnValue({ level: "silent" });
    logging.setLoggerConfigLoaderForTests(readLoggingConfigMock);

    expect(logging.isFileLogLevelEnabled("info")).toBe(false);
    logging.getLogger();

    expect(readLoggingConfigMock).toHaveBeenCalledOnce();
  });

  it("loads console settings once per logger generation", () => {
    process.env.OPENCLAW_TEST_CONSOLE = "1";
    readLoggingConfigMock.mockReturnValue({ consoleLevel: "silent" });
    logging.setLoggerConfigLoaderForTests(readLoggingConfigMock);
    logging.setLoggerOverride(null);
    readLoggingConfigMock.mockClear();

    logging.getConsoleSettings();
    logging.getConsoleSettings();
    expect(readLoggingConfigMock).toHaveBeenCalledTimes(1);

    logging.setLoggerOverride({ consoleLevel: "silent" });
    logging.getConsoleSettings();
    expect(readLoggingConfigMock).toHaveBeenCalledTimes(1);

    logging.setLoggerOverride(null);
    logging.getConsoleSettings();
    logging.getConsoleSettings();
    expect(readLoggingConfigMock).toHaveBeenCalledTimes(2);
  });
});

function firstMockArg(mock: { mock: { calls: readonly unknown[][] } }): Record<string, unknown> {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error("expected mock call");
  }
  const [arg] = call;
  if (typeof arg !== "object" || arg === null || Array.isArray(arg)) {
    throw new Error("expected mock call argument to be an object");
  }
  return arg as Record<string, unknown>;
}

describe("isFileLogLevelEnabled", () => {
  it("returns false for all levels when configured as silent", () => {
    logging.setLoggerOverride({ level: "silent" });
    expect(logging.isFileLogLevelEnabled("fatal")).toBe(false);
    expect(logging.isFileLogLevelEnabled("error")).toBe(false);
    expect(logging.isFileLogLevelEnabled("warn")).toBe(false);
    expect(logging.isFileLogLevelEnabled("info")).toBe(false);
    expect(logging.isFileLogLevelEnabled("debug")).toBe(false);
    expect(logging.isFileLogLevelEnabled("trace")).toBe(false);
  });

  it("passes only fatal when configured as fatal", () => {
    logging.setLoggerOverride({ level: "fatal" });
    expect(logging.isFileLogLevelEnabled("fatal")).toBe(true);
    expect(logging.isFileLogLevelEnabled("error")).toBe(false);
    expect(logging.isFileLogLevelEnabled("warn")).toBe(false);
    expect(logging.isFileLogLevelEnabled("info")).toBe(false);
    expect(logging.isFileLogLevelEnabled("debug")).toBe(false);
    expect(logging.isFileLogLevelEnabled("trace")).toBe(false);
  });

  it("passes fatal and error when configured as error", () => {
    logging.setLoggerOverride({ level: "error" });
    expect(logging.isFileLogLevelEnabled("fatal")).toBe(true);
    expect(logging.isFileLogLevelEnabled("error")).toBe(true);
    expect(logging.isFileLogLevelEnabled("warn")).toBe(false);
    expect(logging.isFileLogLevelEnabled("info")).toBe(false);
    expect(logging.isFileLogLevelEnabled("debug")).toBe(false);
    expect(logging.isFileLogLevelEnabled("trace")).toBe(false);
  });

  it("passes fatal, error, warn, info when configured as info", () => {
    logging.setLoggerOverride({ level: "info" });
    expect(logging.isFileLogLevelEnabled("fatal")).toBe(true);
    expect(logging.isFileLogLevelEnabled("error")).toBe(true);
    expect(logging.isFileLogLevelEnabled("warn")).toBe(true);
    expect(logging.isFileLogLevelEnabled("info")).toBe(true);
    expect(logging.isFileLogLevelEnabled("debug")).toBe(false);
    expect(logging.isFileLogLevelEnabled("trace")).toBe(false);
  });

  it("passes all levels when configured as trace", () => {
    logging.setLoggerOverride({ level: "trace" });
    expect(logging.isFileLogLevelEnabled("fatal")).toBe(true);
    expect(logging.isFileLogLevelEnabled("error")).toBe(true);
    expect(logging.isFileLogLevelEnabled("warn")).toBe(true);
    expect(logging.isFileLogLevelEnabled("info")).toBe(true);
    expect(logging.isFileLogLevelEnabled("debug")).toBe(true);
    expect(logging.isFileLogLevelEnabled("trace")).toBe(true);
  });

  it("never treats silent as an emittable file level", () => {
    logging.setLoggerOverride({ level: "info" });
    expect(logging.isFileLogLevelEnabled("silent")).toBe(false);
  });
});

describe("getChildLogger minLevel inheritance", () => {
  it("child logger inherits parent minLevel when no level is specified", () => {
    logging.setLoggerOverride({ level: "warn" });
    const child = logging.getChildLogger({ component: "test" });
    expect(child.settings.minLevel).toBe(logging.levelToMinLevel("warn"));
  });

  it("child logger uses its own level when explicitly specified", () => {
    logging.setLoggerOverride({ level: "warn" });
    const child = logging.getChildLogger({ component: "test" }, { level: "error" });
    expect(child.settings.minLevel).toBe(logging.levelToMinLevel("error"));
  });

  it("child logger does not default to minLevel=0 (allow-all) when no level given", () => {
    logging.setLoggerOverride({ level: "fatal" });
    const child = logging.getChildLogger({ component: "test" });
    expect(child.settings.minLevel).not.toBe(0);
    expect(child.settings.minLevel).toBe(logging.levelToMinLevel("fatal"));
  });

  it("child logger preserves a silent parent without triggering tslog validation", () => {
    logging.setLoggerOverride({ level: "silent" });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const child = logging.getChildLogger({ component: "test" });

    expect(child.settings.minLevel).toBe(logging.levelToMinLevel("silent"));
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("pino child logger propagates the parent minLevel", () => {
    logging.setLoggerOverride({ level: "error" });
    const base = logging.getLogger();
    const getSubLoggerSpy = vi.spyOn(base, "getSubLogger");

    logging.toPinoLikeLogger(base, "info").child({ component: "test" });

    expect(getSubLoggerSpy).toHaveBeenCalledOnce();
    expect(firstMockArg(getSubLoggerSpy).minLevel).toBe(logging.levelToMinLevel("error"));
  });

  it("pino child logger preserves a silent parent without triggering tslog validation", () => {
    logging.setLoggerOverride({ level: "silent" });
    const base = logging.getLogger();
    const getSubLoggerSpy = vi.spyOn(base, "getSubLogger");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    logging.toPinoLikeLogger(base, "info").child({ component: "test" });

    expect(firstMockArg(getSubLoggerSpy).minLevel).toBe(logging.levelToMinLevel("fatal"));
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

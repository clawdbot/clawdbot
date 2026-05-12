import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { readLoggingConfigMock, shouldSkipMutatingLoggingConfigReadMock } = vi.hoisted(() => ({
  readLoggingConfigMock: vi.fn(() => undefined),
  shouldSkipMutatingLoggingConfigReadMock: vi.fn(() => false),
}));

vi.mock("./config.js", () => ({
  readLoggingConfig: readLoggingConfigMock,
  shouldSkipMutatingLoggingConfigRead: shouldSkipMutatingLoggingConfigReadMock,
}));

vi.mock("./node-require.js", () => ({
  resolveNodeRequireFromMeta: () => () => {
    throw new Error("config fallback not used");
  },
}));

let logging: typeof import("../logging.js");

beforeAll(async () => {
  logging = await import("../logging.js");
});

beforeEach(() => {
  delete process.env.OPENCLAW_TEST_FILE_LOG;
  delete process.env.OPENCLAW_LOG_LEVEL;
  readLoggingConfigMock.mockClear();
  shouldSkipMutatingLoggingConfigReadMock.mockReset();
  shouldSkipMutatingLoggingConfigReadMock.mockReturnValue(false);
  logging.resetLogger();
  logging.setLoggerOverride(null);
});

afterEach(() => {
  delete process.env.OPENCLAW_TEST_FILE_LOG;
  delete process.env.OPENCLAW_LOG_LEVEL;
  logging.resetLogger();
  logging.setLoggerOverride(null);
  vi.restoreAllMocks();
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

  it("pino child logger propagates the parent minLevel", () => {
    logging.setLoggerOverride({ level: "error" });
    const base = logging.getLogger();
    const getSubLoggerSpy = vi.spyOn(base, "getSubLogger");

    logging.toPinoLikeLogger(base, "info").child({ component: "test" });

    expect(getSubLoggerSpy).toHaveBeenCalledOnce();
    expect(firstMockArg(getSubLoggerSpy).minLevel).toBe(logging.levelToMinLevel("error"));
  });
});

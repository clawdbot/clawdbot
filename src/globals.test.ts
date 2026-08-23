import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getLogger: vi.fn(),
  isFileLogLevelEnabled: vi.fn(),
  isVerbose: vi.fn(),
  loggerDebug: vi.fn(),
}));

vi.mock("./global-state.js", () => ({
  isVerbose: mocks.isVerbose,
  isYes: vi.fn(),
  setVerbose: vi.fn(),
  setYes: vi.fn(),
}));

vi.mock("./logging/logger.js", () => ({
  getLogger: mocks.getLogger,
  isFileLogLevelEnabled: mocks.isFileLogLevelEnabled,
}));

vi.mock("../packages/terminal-core/src/theme.js", () => ({
  theme: {
    muted: (s: string) => s,
    success: (s: string) => s,
    warn: (s: string) => s,
    info: (s: string) => s,
    error: (s: string) => s,
  },
}));

import { isVerbose } from "./global-state.js";
import { shouldLogVerbose, logVerbose, logVerboseConsole } from "./globals.js";
import { isFileLogLevelEnabled } from "./logging/logger.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getLogger.mockReturnValue({ debug: mocks.loggerDebug });
  vi.mocked(isVerbose).mockReturnValue(false);
  vi.mocked(isFileLogLevelEnabled).mockReturnValue(false);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("shouldLogVerbose", () => {
  it("returns true when isVerbose is true", () => {
    vi.mocked(isVerbose).mockReturnValue(true);
    expect(shouldLogVerbose()).toBe(true);
  });

  it("returns true when file log level is debug", () => {
    vi.mocked(isFileLogLevelEnabled).mockReturnValue(true);
    expect(shouldLogVerbose()).toBe(true);
  });

  it("returns true when both are true", () => {
    vi.mocked(isVerbose).mockReturnValue(true);
    vi.mocked(isFileLogLevelEnabled).mockReturnValue(true);
    expect(shouldLogVerbose()).toBe(true);
  });

  it("returns false when both are false", () => {
    vi.mocked(isVerbose).mockReturnValue(false);
    vi.mocked(isFileLogLevelEnabled).mockReturnValue(false);
    expect(shouldLogVerbose()).toBe(false);
  });
});

describe("logVerbose", () => {
  it("does not log when shouldLogVerbose is false", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    logVerbose("test message");

    expect(mocks.getLogger).not.toHaveBeenCalled();
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("logs to the file logger when file debug logging is enabled", () => {
    vi.mocked(isFileLogLevelEnabled).mockReturnValue(true);
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    logVerbose("test message");

    expect(mocks.loggerDebug).toHaveBeenCalledWith({ message: "test message" }, "verbose");
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("logs to the file logger and console when isVerbose is true", () => {
    vi.mocked(isVerbose).mockReturnValue(true);
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    logVerbose("test message");

    expect(mocks.loggerDebug).toHaveBeenCalledWith({ message: "test message" }, "verbose");
    expect(consoleSpy).toHaveBeenCalledWith("test message");
  });

  it("still logs to console when the file logger throws", () => {
    vi.mocked(isVerbose).mockReturnValue(true);
    mocks.getLogger.mockImplementation(() => {
      throw new Error("logger unavailable");
    });
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(() => logVerbose("test message")).not.toThrow();
    expect(consoleSpy).toHaveBeenCalledWith("test message");
  });
});

describe("logVerboseConsole", () => {
  it("does not log when isVerbose is false", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    logVerboseConsole("test message");

    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("logs to console when isVerbose is true", () => {
    vi.mocked(isVerbose).mockReturnValue(true);
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    logVerboseConsole("test message");

    expect(consoleSpy).toHaveBeenCalledWith("test message");
  });
});

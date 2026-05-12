import { afterEach, describe, expect, it, vi } from "vitest";
import { ConsoleLogger, setMatrixConsoleLogging } from "./logger.js";

describe("ConsoleLogger", () => {
  afterEach(() => {
    setMatrixConsoleLogging(false);
    vi.restoreAllMocks();
  });

  it("redacts sensitive tokens in emitted log messages", () => {
    setMatrixConsoleLogging(true);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    new ConsoleLogger().error(
      "MatrixHttpClient",
      "Authorization: Bearer 123456:abcdefghijklmnopqrstuvwxyzABCDEFG",
    );

    const message = spy.mock.calls.at(0)?.[0];
    expect(message).toBe(
      "[MatrixHttpClient] Authorization: Bearer ***:abcdefghijklmnopqrstuvwxyzABCDEFG",
    );
  });
});

/** Tests plugin logger formatting and diagnostic forwarding behavior. */
import { describe, expect, it, vi } from "vitest";
import { createPluginLoaderLogger } from "./logger.js";

describe("plugins/logger", () => {
  it.each([
    ["info", "i"],
    ["warn", "w"],
    ["error", "e"],
    ["debug", "d"],
  ] as const)("forwards %s", (method, value) => {
    const methods = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const logger = createPluginLoaderLogger(methods);

    logger[method]?.(value);
    expect(methods[method]).toHaveBeenCalledWith(value);
  });
});

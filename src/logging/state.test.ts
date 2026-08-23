import { describe, expect, it, vi } from "vitest";

describe("logging state", () => {
  it("stays process-local across module reloads", async () => {
    const first = await import("./state.js");
    vi.resetModules();
    const second = await import("./state.js");

    expect(second.loggingState).toBe(first.loggingState);
  });

  it("preserves the cached logger across module reloads", async () => {
    const first = await import("./logger.js");
    first.setLoggerOverride({ level: "silent" });

    try {
      const logger = first.getLogger();
      vi.resetModules();
      const second = await import("./logger.js");

      expect(second.getLogger()).toBe(logger);
    } finally {
      first.resetLogger();
    }
  });
});

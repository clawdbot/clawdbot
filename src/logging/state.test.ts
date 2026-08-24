import { describe, expect, it, vi } from "vitest";

describe("logging state", () => {
  it("stays process-local across module reloads", async () => {
    const first = await import("./state.js");
    vi.resetModules();
    const second = await import("./state.js");

    expect(second.loggingState).toBe(first.loggingState);
  });
});

import { describe, expect, it, vi } from "vitest";
import { meetRuntime } from "./test-support/fixtures.test-helpers.js";

describe("Google Meet runtime owner selection", () => {
  it("starts with an explicit realtime agent in a multi-agent config", () => {
    const logger = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };

    expect(() =>
      meetRuntime({ realtime: { agentId: "work" } }, logger, {
        agents: {
          ownership: "explicit",
          list: [{ id: "main" }, { id: "work" }],
        },
      }),
    ).not.toThrow();
  });
});

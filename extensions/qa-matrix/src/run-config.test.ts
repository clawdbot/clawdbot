import { describe, expect, it } from "vitest";
import { normalizeQaProviderMode } from "./run-config.js";

describe("matrix qa run config", () => {
  it("defaults to live-frontier when provider mode is omitted", () => {
    expect(normalizeQaProviderMode(undefined)).toBe("live-frontier");
    expect(normalizeQaProviderMode("")).toBe("live-frontier");
  });

  it("keeps legacy live-openai as an alias for live-frontier", () => {
    expect(normalizeQaProviderMode("live-openai")).toBe("live-frontier");
  });

  it("rejects unknown provider modes", () => {
    expect(() => normalizeQaProviderMode("mystery-mode")).toThrow(
      "unknown QA provider mode: mystery-mode",
    );
  });
});

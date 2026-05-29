import { describe, expect, it } from "vitest";
import { readClampedInt, readGatewayCallOptions } from "./params.js";

describe("file-transfer shared params", () => {
  it("normalizes string timeoutMs values for gateway calls", () => {
    expect(readGatewayCallOptions({ timeoutMs: "5000" }).timeoutMs).toBe(5000);
  });

  it("rejects malformed timeoutMs values before gateway calls", () => {
    expect(() => readGatewayCallOptions({ timeoutMs: "5000.5" })).toThrow(
      "timeoutMs must be a positive integer",
    );
    expect(() => readGatewayCallOptions({ timeoutMs: 0 })).toThrow(
      "timeoutMs must be a positive integer",
    );
  });

  it("normalizes and clamps string integer limits", () => {
    expect(
      readClampedInt({
        input: { maxBytes: "1024" },
        key: "maxBytes",
        defaultValue: 256,
        hardMin: 1,
        hardMax: 512,
      }),
    ).toBe(512);
  });

  it("rejects malformed integer limits instead of silently using defaults", () => {
    expect(() =>
      readClampedInt({
        input: { maxEntries: "2.5" },
        key: "maxEntries",
        defaultValue: 200,
        hardMin: 1,
        hardMax: 5000,
      }),
    ).toThrow("maxEntries must be a positive integer");
  });
});

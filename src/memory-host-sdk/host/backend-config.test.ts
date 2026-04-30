import { describe, expect, it } from "vitest";
import { resolveMemoryBackendConfig } from "./backend-config.js";

describe("memory-host-sdk backend-config bridge", () => {
  it("exports the package-owned backend resolver", () => {
    expect(resolveMemoryBackendConfig).toEqual(expect.any(Function));
  });
});

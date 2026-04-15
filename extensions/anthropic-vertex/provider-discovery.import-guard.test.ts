import { describe, expect, it } from "vitest";

describe("anthropic-vertex provider discovery entry", () => {
  it("imports without loading the full plugin entry", async () => {
    const module = await import("./provider-discovery.js");

    expect(module.default.id).toBe("anthropic-vertex");
    expect(module.default.catalog.order).toBe("simple");
  });
});

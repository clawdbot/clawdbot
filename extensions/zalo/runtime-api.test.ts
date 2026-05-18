import { describe, expect, it } from "vitest";
import * as runtime from "./runtime-api.js";

describe("zalo runtime api", () => {
  it("loads the narrow runtime api without reentering setup surfaces", () => {
    expect(Object.hasOwn(runtime, "zaloPlugin")).toBe(false);
    expect(Object.hasOwn(runtime, "zaloSetupWizard")).toBe(false);
    expect(typeof runtime.setZaloRuntime).toBe("function");
  });
});

import { describe, expect, it } from "vitest";
import { resolveFaceTimeConfig, validateFaceTimeConfig } from "../src/config.js";

describe("facetime config", () => {
  it("defaults omitted policy to owner without exposing a helper endpoint", () => {
    const config = resolveFaceTimeConfig({ ownerHandles: ["mailto:omar@example.com"] });

    expect(config.ownerHandles).toEqual(["mailto:omar@example.com"]);
    expect(config.realtime.toolPolicy).toBe("owner");
    expect(config.realtime).toMatchObject({
      provider: undefined,
      model: undefined,
      voice: undefined,
    });
    expect("helperHost" in config).toBe(false);
    expect("helperPort" in config).toBe(false);
  });

  it.each(["administrator", "", 1, null])(
    "rejects explicit invalid tool policy %j instead of upgrading authority",
    (toolPolicy) => {
      expect(() =>
        resolveFaceTimeConfig({ ownerHandles: ["omar@example.com"], realtime: { toolPolicy } }),
      ).toThrow("realtime.toolPolicy must be one of");
    },
  );

  it("requires at least one owner handle", () => {
    const validation = validateFaceTimeConfig(resolveFaceTimeConfig({}));
    expect(validation.valid).toBe(false);
    expect(validation.errors.join("\n")).toContain("ownerHandles");
  });

  it("bounds custom model-visible instructions", () => {
    expect(() =>
      resolveFaceTimeConfig({
        ownerHandles: ["omar@example.com"],
        realtime: { instructions: "x".repeat(4_001) },
      }),
    ).toThrow("must not exceed 4000 characters");
  });
});

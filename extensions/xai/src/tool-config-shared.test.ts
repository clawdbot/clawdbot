import { describe, expect, it } from "vitest";
import {
  coerceXaiToolConfig,
  resolveNormalizedXaiToolModel,
  resolvePositiveIntegerToolConfig,
} from "./tool-config-shared.js";

describe("xai tool config helpers", () => {
  it("coerces non-record config to an empty object", () => {
    expect(coerceXaiToolConfig(undefined)).toStrictEqual({});
    expect(coerceXaiToolConfig([] as unknown as Record<string, unknown>)).toStrictEqual({});
  });

  it("normalizes configured model ids and falls back to the default model", () => {
    expect(
      resolveNormalizedXaiToolModel({
        config: { model: "  grok-4.1-fast  " },
        defaultModel: "grok-4-1-fast",
      }),
    ).toBe("grok-4.1-fast");

    expect(
      resolveNormalizedXaiToolModel({
        config: {},
        defaultModel: "grok-4-1-fast",
      }),
    ).toBe("grok-4-1-fast");
  });

  it("accepts only positive finite numeric turn counts", () => {
    expect(resolvePositiveIntegerToolConfig({ maxTurns: 2.9 }, "maxTurns")).toBe(2);
    expect(resolvePositiveIntegerToolConfig({ maxTurns: 0 }, "maxTurns")).toBeUndefined();
    expect(resolvePositiveIntegerToolConfig({ maxTurns: Number.NaN }, "maxTurns")).toBeUndefined();
    expect(resolvePositiveIntegerToolConfig(undefined, "maxTurns")).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { resolvePluginWebContentExtractors } from "./web-content-extractors.runtime.js";

describe("resolvePluginWebContentExtractors", () => {
  it("respects global plugin disablement", () => {
    expect(
      resolvePluginWebContentExtractors({
        config: {
          plugins: {
            enabled: false,
          },
        },
      }),
    ).toStrictEqual([]);
  });
});

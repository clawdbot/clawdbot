import { describe, expect, it } from "vitest";
import { AUTO_MANAGED_CONFIG_META_PATHS, stampConfigWriteMetadata } from "./io.meta.js";

describe("config write metadata stamping", () => {
  it("stamps every declared auto-managed meta path", () => {
    const stamped = stampConfigWriteMetadata({});

    expect(AUTO_MANAGED_CONFIG_META_PATHS).toEqual([
      ["meta", "lastTouchedVersion"],
      ["meta", "lastTouchedAt"],
    ]);

    for (const [parent, field] of AUTO_MANAGED_CONFIG_META_PATHS) {
      expect(parent).toBe("meta");
      expect(typeof stamped.meta?.[field]).toBe("string");
    }
  });
});

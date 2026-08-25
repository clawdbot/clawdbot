// Covers plugin compatibility notice formatting helpers.

import { describe, expect, it } from "vitest";
import { formatPluginCompatibilityNotice, summarizePluginCompatibility } from "./status.js";
import { createCompatibilityNotice, HOOK_ONLY_MESSAGE } from "./status.test-fixtures.js";

describe("plugin compatibility notice formatting", () => {
  it("formats and summarizes compatibility notices", () => {
    const notice = createCompatibilityNotice({ pluginId: "legacy-plugin", code: "hook-only" });

    expect(formatPluginCompatibilityNotice(notice)).toBe(`legacy-plugin ${HOOK_ONLY_MESSAGE}`);
    expect(summarizePluginCompatibility([notice])).toEqual({
      noticeCount: 1,
      pluginCount: 1,
    });
  });
});

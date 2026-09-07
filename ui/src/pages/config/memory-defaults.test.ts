import { describe, expect, it } from "vitest";
import { dreamingConfigPath, resolveDreamingTimezoneDefault } from "./memory-defaults.ts";

describe("memory curated defaults", () => {
  it("builds the selected plugin's dreaming config path", () => {
    expect(dreamingConfigPath("memory-core", ["phases", "deep", "limit"])).toEqual([
      "plugins",
      "entries",
      "memory-core",
      "config",
      "dreaming",
      "phases",
      "deep",
      "limit",
    ]);
  });

  it("inherits and normalizes the agent default timezone", () => {
    expect(
      resolveDreamingTimezoneDefault({
        agents: { defaults: { userTimezone: "  Asia/Singapore  " } },
      }),
    ).toBe("Asia/Singapore");
    expect(resolveDreamingTimezoneDefault({})).toBeNull();
  });
});

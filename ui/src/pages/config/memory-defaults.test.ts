import { describe, expect, it, vi } from "vitest";
import {
  dreamingConfigPath,
  resetMemoryEngine,
  resolveDreamingTimezoneDefault,
} from "./memory-defaults.ts";

describe("memory curated defaults", () => {
  it("resets the slot by removing only its authored key", () => {
    const removeFormValue = vi.fn();
    const config = { removeFormValue };

    resetMemoryEngine(config);

    expect(removeFormValue).toHaveBeenCalledWith(["plugins", "slots", "memory"]);
  });

  it("does not reset controls while their effective mutation gate is closed", () => {
    const removeFormValue = vi.fn();
    expect(resetMemoryEngine({ removeFormValue }, true)).toBe(false);
    expect(removeFormValue).not.toHaveBeenCalled();
  });

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

import { describe, expect, it, vi } from "vitest";
import {
  dreamingConfigPath,
  resetMemoryBackend,
  resetMemoryEngine,
  resolveDreamingTimezoneDefault,
} from "./memory-defaults.ts";

describe("memory curated defaults", () => {
  it("resets the slot and backend by removing only their authored keys", () => {
    const removeFormValue = vi.fn();
    const config = { removeFormValue };

    resetMemoryEngine(config);
    resetMemoryBackend(config);

    expect(removeFormValue).toHaveBeenNthCalledWith(1, ["plugins", "slots", "memory"]);
    expect(removeFormValue).toHaveBeenNthCalledWith(2, ["memory", "backend"]);
  });

  it("does not reset controls while their effective mutation gate is closed", () => {
    const removeFormValue = vi.fn();
    expect(resetMemoryEngine({ removeFormValue }, true)).toBe(false);
    expect(resetMemoryBackend({ removeFormValue }, true)).toBe(false);
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

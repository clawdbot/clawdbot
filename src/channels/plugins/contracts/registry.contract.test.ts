import { describe, expect, it } from "vitest";
import { sessionBindingContractChannelIds } from "./test-helpers/manifest.js";

const discordSessionBindingAdapterChannels = ["discord"] as const;

describe("channel contract registry", () => {
  function expectSessionBindingCoverage(expectedChannelIds: readonly string[]) {
    const registeredIds = new Set<string>(sessionBindingContractChannelIds);
    for (const expectedChannelId of expectedChannelIds) {
      expect(registeredIds.has(expectedChannelId)).toBe(true);
    }
  }

  it.each([
    {
      name: "keeps core session binding coverage aligned with built-in adapters",
      expectedChannelIds: [...discordSessionBindingAdapterChannels, "telegram"],
    },
  ] as const)("$name", ({ expectedChannelIds }) => {
    expectSessionBindingCoverage(expectedChannelIds);
  });
});

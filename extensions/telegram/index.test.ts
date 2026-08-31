// Telegram tests cover bundled entry registration behavior.
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import "./index.js";

const entryContractMocks = vi.hoisted(() => ({
  registerFull: undefined as ((api: OpenClawPluginApi) => void) | undefined,
}));

vi.mock("openclaw/plugin-sdk/channel-entry-contract", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/channel-entry-contract")>();
  return {
    ...actual,
    defineBundledChannelEntry: (
      options: Parameters<typeof actual.defineBundledChannelEntry>[0],
    ) => {
      entryContractMocks.registerFull = options.registerFull;
      return actual.defineBundledChannelEntry(options);
    },
  };
});

vi.mock("./miniapp-api.js", () => ({
  registerTelegramMiniApp: vi.fn(),
}));

describe("telegram bundled entry", () => {
  it("registers detached-subagent progress presentation", () => {
    const on = vi.fn();
    entryContractMocks.registerFull?.(
      createTestPluginApi({
        id: "telegram",
        registrationMode: "full",
        on,
      }),
    );

    expect(on).toHaveBeenCalledWith("subagent_progress", expect.any(Function));
  });
});

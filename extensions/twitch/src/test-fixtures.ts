import { afterEach, beforeEach, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";

export const BASE_TWITCH_TEST_ACCOUNT = {
  username: "testbot",
  clientId: "test-client-id",
  channel: "#testchannel",
};

export function makeTwitchTestConfig(account: Record<string, unknown>): OpenClawConfig {
  return {
    channels: {
      twitch: {
        accounts: {
          default: account,
        },
      },
    },
  } as unknown as OpenClawConfig;
}

export function installTwitchTestHooks() {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
}

// Direct delivery tests keep the active runtime config through isolated cron orchestration.
import { afterEach, describe, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCronAgentConfig } from "./isolated-agent/run-config.js";

describe("resolveCronAgentConfig", () => {
  afterEach(() => {
    clearRuntimeConfigSnapshot();
  });

  it("keeps the active runtime snapshot after agent-default derivation", () => {
    const sourceCfg = {
      channels: {
        discord: {
          accounts: {
            default: {
              token: { provider: "default", source: "env", id: "DISCORD_BOT_TOKEN" },
            },
          },
        },
      },
    } satisfies OpenClawConfig;
    const runtimeCfg = {
      channels: {
        discord: {
          accounts: { default: { token: "resolved-discord-token" } },
        },
      },
    } satisfies OpenClawConfig;
    setRuntimeConfigSnapshot(runtimeCfg, sourceCfg);

    const { agentDefaults, cfgWithAgentDefaults, runtimeConfig } = resolveCronAgentConfig({
      config: sourceCfg,
      agentConfigOverride: { model: "openai/gpt-5.5" },
    });

    expect(runtimeConfig).toBe(runtimeCfg);
    expect(agentDefaults.model).toEqual({ primary: "openai/gpt-5.5" });
    expect(cfgWithAgentDefaults.channels).toBe(runtimeCfg.channels);
  });
});

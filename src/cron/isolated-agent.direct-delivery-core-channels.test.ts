// Direct delivery tests keep the active runtime config through isolated cron orchestration.
import { afterEach, describe, expect, it } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  makeIsolatedAgentJobFixture,
  makeIsolatedAgentParamsFixture,
} from "./isolated-agent/job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./isolated-agent/run.suite-helpers.js";
import {
  dispatchCronDeliveryMock,
  loadRunCronIsolatedAgentTurn,
  resolveCronDeliveryPlanMock,
  resolveDeliveryTargetMock,
} from "./isolated-agent/run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

describe("runCronIsolatedAgentTurn direct delivery config", () => {
  setupRunCronIsolatedAgentTurnSuite({ fast: true });

  afterEach(() => {
    clearRuntimeConfigSnapshot();
  });

  it("keeps the active runtime snapshot after agent-default derivation", async () => {
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
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: true,
      mode: "announce",
      channel: "discord",
      to: "channel:789",
    });
    resolveDeliveryTargetMock.mockResolvedValue({
      ok: true,
      channel: "discord",
      to: "channel:789",
      accountId: undefined,
      threadId: undefined,
      mode: "explicit",
    });

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        cfg: sourceCfg,
        job: makeIsolatedAgentJobFixture({
          delivery: { mode: "announce", channel: "discord", to: "channel:789" },
        }),
      }),
    );

    expect(result).toMatchObject({ status: "ok", delivered: true });
    expect(dispatchCronDeliveryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: sourceCfg,
        cfgWithAgentDefaults: expect.objectContaining({ channels: runtimeCfg.channels }),
      }),
    );
  });
});

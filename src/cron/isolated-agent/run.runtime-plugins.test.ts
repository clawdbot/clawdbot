// Runtime plugin tests cover plugin availability during isolated cron runs.

import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  loadRunCronIsolatedAgentTurn,
  ensureRuntimePluginsLoadedMock,
  resolveConfiguredModelRefMock,
  resolveCronDeliveryPlanMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

describe("runCronIsolatedAgentTurn runtime plugins loading", () => {
  setupRunCronIsolatedAgentTurnSuite();

  it("loads runtime plugins eagerly using the lazily loaded module", async () => {
    const params = makeIsolatedAgentParamsFixture();

    const result = await runCronIsolatedAgentTurn(params);

    expect(result.status).toBe("ok");
    expect(ensureRuntimePluginsLoadedMock).toHaveBeenCalledOnce();
    expect(ensureRuntimePluginsLoadedMock).toHaveBeenCalledWith({
      config: expect.objectContaining({
        agents: expect.objectContaining({
          defaults: expect.any(Object),
        }),
      }),
      workspaceDir: "/tmp/workspace", // matches resolveAgentWorkspaceDir mock
      allowGatewaySubagentBinding: true,
    });
    expect(ensureRuntimePluginsLoadedMock.mock.invocationCallOrder[0]).toBeLessThan(
      expectDefined(
        resolveConfiguredModelRefMock.mock.invocationCallOrder[0],
        "resolveConfiguredModelRefMock.mock.invocationCallOrder[0] test invariant",
      ),
    );
    expect(ensureRuntimePluginsLoadedMock.mock.invocationCallOrder[0]).toBeLessThan(
      expectDefined(
        resolveCronDeliveryPlanMock.mock.invocationCallOrder[0],
        "resolveCronDeliveryPlanMock.mock.invocationCallOrder[0] test invariant",
      ),
    );
  });
});

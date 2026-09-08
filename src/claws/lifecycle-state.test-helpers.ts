import { loadConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { OpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { applyClawAddPlan } from "./add.js";
import { buildClawRemovalFixture } from "./lifecycle-remove.test-support.js";

export function createClawRemoveTestFixtures(
  tempDirs: { make: (prefix: string) => string },
  getState: () => OpenClawTestState,
) {
  async function fixture(params: Parameters<typeof buildClawRemovalFixture>[1] = {}) {
    const current = await buildClawRemovalFixture(tempDirs.make("openclaw-claw-remove-"), params);
    return { ...current, env: { OPENCLAW_STATE_DIR: getState().stateDir } };
  }

  async function addFixture(params: Parameters<typeof fixture>[0] = {}) {
    const current = await fixture(params);
    let config: OpenClawConfig = {};
    await applyClawAddPlan(current.plan, {
      consentPlanIntegrity: current.plan.planIntegrity,
      env: current.env,
      commitConfig: async (transform) => {
        config = transform(config);
        await getState().writeConfig(config);
      },
      cronGateway: { add: async () => ({ id: "scheduler-daily" }) },
      ...(params.withMcp ? { installMcpServers: async () => [] } : {}),
    });
    return { ...current, getConfig: loadConfig };
  }

  return { fixture, addFixture };
}

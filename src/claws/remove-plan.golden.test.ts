import { homedir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { goldenPlanDigest, normalizeGoldenPlan } from "./golden-plan.test-support.js";
import { buildClawRemovePlan } from "./lifecycle-state.js";
import { createUpdatePlanFixture } from "./update-plan.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

// Remove plans resolve agent-state and transcript paths under the test home,
// which the harness recreates per run. Normalize it alongside the fixture root.
const testHome = process.env.HOME ?? homedir();

afterEach(() => closeOpenClawStateDatabaseForTest());

async function fixture() {
  const root = tempDirs.make("openclaw-claw-remove-golden-");
  return await createUpdatePlanFixture(root);
}

async function expectGolden(
  current: Awaited<ReturnType<typeof fixture>>,
  params: { config: OpenClawConfig; digest: string },
) {
  const plan = await buildClawRemovePlan("worker", {
    env: current.env,
    config: params.config,
  });
  const normalized = normalizeGoldenPlan(plan, [current.root, testHome]);
  expect(normalized).toMatchSnapshot();
  expect(goldenPlanDigest(normalized)).toBe(params.digest);
}

describe("claws remove-plan goldens", () => {
  it("golden: plain remove of a full claw install", async () => {
    const current = await fixture();
    await expectGolden(current, {
      config: current.config,
      digest: "sha256:1a07895fa9e476ba2581d3889a47221d1e712d0dbcefc33e89958bb87db64f18",
    });
  });

  it("golden: remove plan includes operator-owned config surfaces", async () => {
    const current = await fixture();
    await expectGolden(current, {
      config: {
        ...current.config,
        bindings: [{ match: { channel: "telegram", accountId: "*" }, agentId: "worker" }],
        tools: { agentToAgent: { allow: ["worker"] } },
      },
      digest: "sha256:11a36b15d566ec203d667ce01d1573aedb6d3da6ba215270a17ad9593d3f74c4",
    });
  });
});

import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { goldenPlanDigest, normalizeGoldenPlan } from "./golden-plan.test-support.js";
import { buildClawAddPlan } from "./lifecycle.js";
import { readClawManifestFile } from "./reader.js";
import { packagePreflight } from "./update-plan.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => closeOpenClawStateDatabaseForTest());

async function expectGolden(
  fixturePath: string,
  params: {
    digest: string;
    context?: Parameters<typeof buildClawAddPlan>[0]["context"];
  },
) {
  const result = await readClawManifestFile(fixturePath);
  if (!result.ok) {
    throw new Error(JSON.stringify(result.diagnostics));
  }
  const root = tempDirs.make("openclaw-claw-add-golden-");
  const plan = await buildClawAddPlan({
    manifest: result.manifest,
    clawMarkdownBody: result.clawMarkdownBody,
    packageBootstrap: result.packageBootstrap,
    openClawProfile: result.openClawProfile,
    source: result.source,
    diagnostics: result.diagnostics,
    context: {
      workspace: join(root, `workspace-${result.manifest.agent.id}`),
      packagePreflight,
      ...params.context,
    },
  });
  const normalized = normalizeGoldenPlan(plan, [root, process.cwd()]);
  expect(normalized).toMatchSnapshot();
  expect(goldenPlanDigest(normalized)).toBe(params.digest);
}

describe("claws add-plan goldens", () => {
  it("golden: minimal agent with legacy profile pointer", async () => {
    await expectGolden("src/claws/fixtures/minimal-agent.claw.json", {
      digest: "sha256:840cbae590e661fc2ee9e8b75dff59876e63195d880d726565ae6efbd640595b",
    });
  });

  it("golden: incident response with packages, mcp, and cron", async () => {
    await expectGolden("src/claws/fixtures/incident-response.claw.json", {
      digest: "sha256:1440bf886441b5172d7586858248ac92a6c26e8f78a67ed761e1471cf0a0c845",
    });
  });

  it("golden: workspace agent with managed files", async () => {
    await expectGolden("src/claws/fixtures/workspace-agent.claw.json", {
      digest: "sha256:04e2aacd3ed0675bc7579f16d40733fff7f6c4c56668856d8fbee7b962959c5e",
    });
  });

  it("golden: agent id collision blocks the plan", async () => {
    await expectGolden("src/claws/fixtures/minimal-agent.claw.json", {
      context: { existingAgentIds: ["internal-triage"] },
      digest: "sha256:7315e43e2344971fd4fa7f7d732437d8961e147107d859f592c29388f6c4244c",
    });
  });
});

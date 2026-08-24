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
      digest: "sha256:46f120f23541deeb29f4e6e74eaec977d414ba61fd0f4e41ce5ef2b2b7d30faf",
    });
  });

  it("golden: incident response with packages, mcp, and cron", async () => {
    await expectGolden("src/claws/fixtures/incident-response.claw.json", {
      digest: "sha256:22487ec20f40ccbbc29f6acd2dbbf2b9ad50dc8662334e5c8eab85de8ae7dbfb",
    });
  });

  it("golden: workspace agent with managed files", async () => {
    await expectGolden("src/claws/fixtures/workspace-agent.claw.json", {
      digest: "sha256:55023259f9f38cfc90956a9d725033fb2ba09117787e6978d9241b290530dcc1",
    });
  });

  it("golden: agent id collision blocks the plan", async () => {
    await expectGolden("src/claws/fixtures/minimal-agent.claw.json", {
      context: { existingAgentIds: ["internal-triage"] },
      digest: "sha256:be3d3df945d915c15cd58f8ea19bad3e6abf5ce9a0a4f9e9bfd52777141cd9e8",
    });
  });
});

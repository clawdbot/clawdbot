// Workshop apply-body validation rejects malformed proposal bodies before any
// workspace mutation or rollback recording. Structural validation only — does
// not restrict Markdown heading vocabulary (the skill loader accepts free-form
// Markdown after valid frontmatter).
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeOpenClawStateDatabaseByPath,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { resetSkillsRefreshStateForTest } from "../runtime/refresh-state.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import { applySkillProposal, listSkillProposals, proposeUpdateSkill } from "./service.js";
import { readSkillProposalRollback } from "./store-sqlite-rollback.js";

const tempDirs = createTrackedTempDirs();
const stateDirs = createTrackedTempDirs();
let testEnv: NodeJS.ProcessEnv;
let stateDir = "";

beforeAll(async () => {
  stateDir = await stateDirs.make("openclaw-apply-body-validation-state-");
  testEnv = {
    ...process.env,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
    OPENCLAW_AGENT_DIR: undefined,
  };
  await listSkillProposals({ env: testEnv });
});

beforeEach(async () => {
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
  vi.stubEnv("OPENCLAW_AGENT_DIR", undefined);
  const database = openOpenClawStateDatabase({ env: testEnv });
  database.db.exec(`
    DELETE FROM skill_workshop_proposal_events;
    DELETE FROM skill_workshop_proposal_rollbacks;
    DELETE FROM skill_workshop_proposals;
  `);
  await fs.rm(path.join(stateDir, "skill-workshop"), { recursive: true, force: true });
});

afterEach(async () => {
  resetSkillsRefreshStateForTest();
  await tempDirs.cleanup();
});

afterAll(async () => {
  closeOpenClawStateDatabaseByPath(resolveOpenClawStateSqlitePath(testEnv));
  vi.unstubAllEnvs();
  await stateDirs.cleanup();
});

async function makeWorkspace(): Promise<string> {
  return await tempDirs.make("openclaw-apply-body-validation-");
}

async function seedOwnedSkill(workspaceDir: string, name: string, body: string): Promise<string> {
  const skillDir = path.join(workspaceDir, "skills", name);
  await writeSkill({
    dir: skillDir,
    name,
    description: `${name} skill`,
    body,
  });
  return skillDir;
}

const operatorActor = { type: "gateway" as const };

describe("skill workshop apply-body validation", () => {
  it("rejects a proposal body that is empty after stripping and leaves no rollback state", async () => {
    const workspaceDir = await makeWorkspace();
    await seedOwnedSkill(workspaceDir, "empty", "# Empty\n\nDo something.\n");

    const proposal = await proposeUpdateSkill({
      workspaceDir,
      skillName: "empty",
      description: "Empty body",
      content: "   \n  \n",
    });

    await expect(
      applySkillProposal({
        workspaceDir,
        proposalId: proposal.record.id,
        eventActor: operatorActor,
      }),
    ).rejects.toThrow(/empty/i);
    await expect(readSkillProposalRollback(proposal.record.id)).resolves.toBeNull();
  });

  it("applies a valid complete replacement", async () => {
    const workspaceDir = await makeWorkspace();
    await seedOwnedSkill(
      workspaceDir,
      "weather",
      "# Weather\n\nCheck the forecast.\nSave the result.\n",
    );

    const proposal = await proposeUpdateSkill({
      workspaceDir,
      skillName: "weather",
      description: "Refreshed weather skill",
      content: "# Weather\n\nCheck the forecast and alerts.\nSave the result.\nNotify the user.\n",
    });

    const applied = await applySkillProposal({
      workspaceDir,
      proposalId: proposal.record.id,
      eventActor: operatorActor,
    });

    expect(applied.record.status).toBe("applied");
    const skillFile = path.join(workspaceDir, "skills", "weather", "SKILL.md");
    await expect(fs.readFile(skillFile, "utf8")).resolves.toContain("Notify the user.");
    const rollback = await readSkillProposalRollback(proposal.record.id);
    expect(rollback).not.toBeNull();
    expect(rollback?.previousContent).toContain("Check the forecast.");
  });

  it("applies a valid skill body with a Changes section", async () => {
    const workspaceDir = await makeWorkspace();
    await seedOwnedSkill(
      workspaceDir,
      "release",
      "# Release\n\nTag the commit.\nPublish the package.\n",
    );

    const proposal = await proposeUpdateSkill({
      workspaceDir,
      skillName: "release",
      description: "Release with changelog",
      content:
        "# Release\n\nTag the commit.\nPublish the package.\n\n## Changes\n\n- Updated dependency versions\n- Fixed login bug\n",
    });

    const applied = await applySkillProposal({
      workspaceDir,
      proposalId: proposal.record.id,
      eventActor: operatorActor,
    });

    expect(applied.record.status).toBe("applied");
    const skillFile = path.join(workspaceDir, "skills", "release", "SKILL.md");
    await expect(fs.readFile(skillFile, "utf8")).resolves.toContain("## Changes");
  });

  it("applies a valid skill body with a Plan section", async () => {
    const workspaceDir = await makeWorkspace();
    await seedOwnedSkill(
      workspaceDir,
      "deploy",
      "# Deploy\n\nPush to production.\nVerify the release.\n",
    );

    const proposal = await proposeUpdateSkill({
      workspaceDir,
      skillName: "deploy",
      description: "Deploy with plan section",
      content:
        "# Deploy\n\nPush to production.\nVerify the release.\n\n## Plan\n\n1. Build the image\n2. Tag the release\n3. Rollback on failure\n",
    });

    const applied = await applySkillProposal({
      workspaceDir,
      proposalId: proposal.record.id,
      eventActor: operatorActor,
    });

    expect(applied.record.status).toBe("applied");
    const skillFile = path.join(workspaceDir, "skills", "deploy", "SKILL.md");
    await expect(fs.readFile(skillFile, "utf8")).resolves.toContain("## Plan");
  });

  it("applies a valid skill body with a Diff section", async () => {
    const workspaceDir = await makeWorkspace();
    await seedOwnedSkill(workspaceDir, "config", "# Config\n\nLoad settings.\nValidate values.\n");

    const proposal = await proposeUpdateSkill({
      workspaceDir,
      skillName: "config",
      description: "Config with diff section",
      content:
        "# Config\n\nLoad settings.\nValidate values.\n\n## Diff\n\n- Old: timeout=30\n- New: timeout=60\n",
    });

    const applied = await applySkillProposal({
      workspaceDir,
      proposalId: proposal.record.id,
      eventActor: operatorActor,
    });

    expect(applied.record.status).toBe("applied");
    const skillFile = path.join(workspaceDir, "skills", "config", "SKILL.md");
    await expect(fs.readFile(skillFile, "utf8")).resolves.toContain("## Diff");
  });

  it("applies a valid skill body with an Implementation Notes section", async () => {
    const workspaceDir = await makeWorkspace();
    await seedOwnedSkill(workspaceDir, "api", "# API\n\nFetch data.\nParse the response.\n");

    const proposal = await proposeUpdateSkill({
      workspaceDir,
      skillName: "api",
      description: "API with implementation notes",
      content:
        "# API\n\nFetch data.\nParse the response.\n\n## Implementation Notes\n\n- Uses retry with exponential backoff\n- Caches responses for 5 minutes\n",
    });

    const applied = await applySkillProposal({
      workspaceDir,
      proposalId: proposal.record.id,
      eventActor: operatorActor,
    });

    expect(applied.record.status).toBe("applied");
    const skillFile = path.join(workspaceDir, "skills", "api", "SKILL.md");
    await expect(fs.readFile(skillFile, "utf8")).resolves.toContain("## Implementation Notes");
  });

  it("does not reject a valid skill body that mentions changes in prose", async () => {
    const workspaceDir = await makeWorkspace();
    await seedOwnedSkill(
      workspaceDir,
      "release",
      "# Release\n\nTag the commit.\nPublish the package.\n",
    );

    const proposal = await proposeUpdateSkill({
      workspaceDir,
      skillName: "release",
      description: "Release notes on changes",
      content:
        "# Release\n\nTag the commit.\nDocument the changes since the last release.\nPublish the package.\n",
    });

    const applied = await applySkillProposal({
      workspaceDir,
      proposalId: proposal.record.id,
      eventActor: operatorActor,
    });

    expect(applied.record.status).toBe("applied");
    const skillFile = path.join(workspaceDir, "skills", "release", "SKILL.md");
    await expect(fs.readFile(skillFile, "utf8")).resolves.toContain(
      "Document the changes since the last release.",
    );
  });
});

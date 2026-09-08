import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LEGACY_WORKSPACE_ATTESTATION_HEADER,
  resolveLegacyWorkspaceSourcePaths,
} from "../agents/workspace-legacy-state.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { renderProposalMarkdown } from "../skills/workshop/frontmatter.js";
import { inspectSkillProposal, listSkillProposals } from "../skills/workshop/service.js";
import { resolveWorkshopSkillsDir } from "../skills/workshop/skills-root.js";
import { readStoredProposal } from "../skills/workshop/store-sqlite-record.js";
import {
  readSkillProposalRollback,
  writeSkillProposalRollback,
} from "../skills/workshop/store-sqlite-rollback.js";
import { hashSkillProposalContent } from "../skills/workshop/store.js";
import {
  SKILL_WORKSHOP_ROLLBACK_SCHEMA,
  type SkillProposalRecord,
  type SkillProposalRollback,
} from "../skills/workshop/types.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import {
  inspectLegacySkillWorkshopMigration,
  migrateLegacySkillWorkshopProposals,
} from "./doctor-skill-workshop-sqlite.js";
import {
  createAppliedLegacyProposal,
  expectWorkshopMigrationConverged,
  seedLegacyV15ProposalRows,
} from "./doctor-skill-workshop-sqlite.test-support.js";

const tempDirs = createTrackedTempDirs();
let testState: OpenClawTestState;

beforeEach(async () => {
  testState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-workshop-reservations-",
  });
});

afterEach(async () => {
  await testState.cleanup();
  await tempDirs.cleanup();
});

type LegacySource = {
  workspaceDir: string;
  ownerAgentId: string;
  record: SkillProposalRecord;
  content: string;
};

function appliedSource(params: {
  workspaceDir: string;
  ownerAgentId: string;
  skillDir: string;
  skillKey: string;
  id: string;
}): LegacySource {
  const content =
    `---\nname: ${params.skillKey}\ndescription: Reservation fixture\n---\n\n` +
    `# ${params.skillKey}\n`;
  return {
    workspaceDir: params.workspaceDir,
    ownerAgentId: params.ownerAgentId,
    content,
    record: createAppliedLegacyProposal({
      id: params.id,
      title: `Create ${params.skillKey}`,
      description: "Reservation fixture",
      content,
      target: { skillKey: params.skillKey, skillDir: params.skillDir },
    }),
  };
}

function pendingUpdate(source: LegacySource, id: string): LegacySource {
  const { appliedAt: _appliedAt, ...record } = source.record;
  return {
    ...source,
    record: {
      ...record,
      id,
      kind: "update",
      status: "pending",
      draftHash: hashSkillProposalContent("# Proposed update\n"),
      target: {
        ...record.target,
        currentContentHash: hashSkillProposalContent(source.content),
      },
    },
  };
}

async function seedSources(sources: readonly LegacySource[]): Promise<void> {
  for (const { record, content } of sources) {
    await fs.mkdir(record.target.skillDir, { recursive: true });
    await fs.writeFile(record.target.skillFile, content, "utf8");
  }
  seedLegacyV15ProposalRows(
    testState.env,
    sources.map(({ record, workspaceDir, ownerAgentId }) => ({
      record,
      workspaceDir,
      ownerAgentId,
      claimReleasedTime: null,
    })),
  );
}

async function seedUnresolvedRollback(source: LegacySource): Promise<SkillProposalRollback> {
  const rollback: SkillProposalRollback = {
    schema: SKILL_WORKSHOP_ROLLBACK_SCHEMA,
    proposalId: source.record.id,
    action: "update",
    writtenAt: source.record.createdAt,
    targetSkillFile: source.record.target.skillFile,
    previousContent: source.content,
    previousContentHash: hashSkillProposalContent(source.content),
  };
  // The valid rollback cannot settle because the saved draft is unavailable.
  await writeSkillProposalRollback({
    proposalId: source.record.id,
    rollback,
    store: { env: testState.env },
  });
  return rollback;
}

async function expectSourcesPreserved(sources: readonly LegacySource[]): Promise<void> {
  for (const { record, content } of sources) {
    await expect(fs.readFile(record.target.skillFile, "utf8")).resolves.toBe(content);
    expect(readStoredProposal(record.id, { env: testState.env })?.record).toEqual(record);
  }
}

async function expectSourceMoved(source: LegacySource, config: OpenClawConfig): Promise<void> {
  const target = path.join(
    resolveWorkshopSkillsDir(config, source.ownerAgentId, testState.env),
    source.record.target.skillKey,
    "SKILL.md",
  );
  await expect(fs.readFile(target, "utf8")).resolves.toBe(source.content);
  await expect(fs.access(source.record.target.skillDir)).rejects.toMatchObject({ code: "ENOENT" });
}

describe("doctor Workshop relocation reservations", () => {
  it.each([false, true])("preserves colliding sources (deferred: %s)", async (deferred) => {
    const firstWorkspace = await fs.realpath(await tempDirs.make("workshop-collision-first-"));
    const secondWorkspace = await fs.realpath(await tempDirs.make("workshop-collision-second-"));
    const colliding = [
      {
        workspaceDir: firstWorkspace,
        id: "shared-name-first-20260901-1234567890",
        content: "---\nname: shared-name\ndescription: First skill\n---\n\n# First\n",
      },
      {
        workspaceDir: secondWorkspace,
        id: "shared-name-second-20260901-1234567890",
        content: "---\nname: shared-name\ndescription: Second skill\n---\n\n# Second\n",
      },
    ].map(({ workspaceDir, id, content }) => ({
      workspaceDir,
      ownerAgentId: "main",
      content,
      record: createAppliedLegacyProposal({
        id,
        title: "Create Shared Name",
        description: "Shared skill",
        content,
        target: {
          skillName: "Shared Name",
          skillKey: "shared-name",
          skillDir: path.join(workspaceDir, "skills", "shared-name"),
        },
      }),
    }));
    const healthyContent = "---\nname: healthy\ndescription: Unrelated skill\n---\n\n# Healthy\n";
    const healthy: LegacySource = {
      workspaceDir: firstWorkspace,
      ownerAgentId: "main",
      content: healthyContent,
      record: createAppliedLegacyProposal({
        id: "healthy-source-20260901-1234567890",
        title: "Create Healthy Skill",
        description: "Unrelated skill",
        content: healthyContent,
        target: {
          skillKey: "healthy",
          skillDir: path.join(firstWorkspace, "skills", "healthy"),
        },
      }),
    };
    const first = colliding[0];
    assert(first);
    const pending = pendingUpdate(first, "shared-name-pending-20260901-1234567890");
    await seedSources(deferred ? [...colliding, healthy, pending] : colliding);
    const rollback = deferred ? await seedUnresolvedRollback(pending) : undefined;
    const destination = path.join(
      resolveWorkshopSkillsDir({}, "main", testState.env),
      "shared-name",
    );
    const result = await migrateLegacySkillWorkshopProposals({ config: {}, env: testState.env });

    await expect(fs.access(destination)).rejects.toMatchObject({ code: "ENOENT" });
    if (deferred) {
      expect(result.warnings.join("\n")).toContain(pending.record.id);
      await expectSourcesPreserved([...colliding, pending]);
      await expect(
        readSkillProposalRollback(pending.record.id, { env: testState.env }),
      ).resolves.toEqual(rollback);
      await expectSourceMoved(healthy, {});
      return;
    }
    const sources = colliding.map(({ record }) => record.target.skillDir).toSorted();
    const conflictReason =
      `Skill Workshop relocation conflict: sources ${sources.join(", ")} ` +
      `map to the same destination ${destination}.`;
    expect(result.changes.join("\n")).toContain(
      "Relocated 0 Skill Workshop skills, retargeted 0 proposals, marked 2 stale",
    );
    for (const { record, content } of colliding) {
      await expect(fs.readFile(record.target.skillFile, "utf8")).resolves.toBe(content);
      expect(readStoredProposal(record.id, { env: testState.env })?.record).toMatchObject({
        status: "stale",
        statusReason: conflictReason,
        target: record.target,
      });
    }
    await expect(
      inspectLegacySkillWorkshopMigration({ config: {}, env: testState.env }),
    ).resolves.toEqual({
      externalProposalCount: 0,
      externalProposalCountsByAgent: {},
      legacyBackupRootCount: 0,
    });
    await expectWorkshopMigrationConverged({ env: testState.env });
  });

  it.each([
    { name: "ancestor", transitive: false, legacyState: false },
    { name: "multiple destinations", transitive: true, legacyState: false },
    { name: "workspace readiness", transitive: false, legacyState: true },
  ])("preserves deferred recovery reservations ($name)", async ({ transitive, legacyState }) => {
    const workspaceDir = await fs.realpath(await tempDirs.make("workshop-reserved-ancestor-"));
    const otherWorkspace = await fs.realpath(await tempDirs.make("workshop-reserved-other-"));
    const formerWorkspace = path.join(workspaceDir, "skills", "parent-skill");
    const currentWorkspace = legacyState
      ? await fs.realpath(await tempDirs.make("workshop-reserved-current-"))
      : workspaceDir;
    const config: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        entries: {
          alpha: { workspace: currentWorkspace },
          beta: { workspace: otherWorkspace },
        },
      },
    };
    const ancestor = appliedSource({
      workspaceDir,
      ownerAgentId: "alpha",
      skillDir: formerWorkspace,
      skillKey: "parent-skill",
      id: "ancestor-alpha-20260901-1234567890",
    });
    const secondClaim: LegacySource = {
      ...ancestor,
      ownerAgentId: "beta",
      record: { ...ancestor.record, id: "ancestor-beta-20260901-1234567890" },
    };
    const connected = appliedSource({
      workspaceDir: otherWorkspace,
      ownerAgentId: "beta",
      skillDir: path.join(otherWorkspace, "skills", "parent-skill"),
      skillKey: "parent-skill",
      id: "connected-source-20260901-1234567890",
    });
    const childSource = appliedSource({
      workspaceDir: formerWorkspace,
      ownerAgentId: "alpha",
      skillDir: path.join(formerWorkspace, "skills", "child-skill"),
      skillKey: "child-skill",
      id: "child-source-20260901-1234567890",
    });
    const child = pendingUpdate(childSource, "child-pending-20260901-1234567890");
    const { appliedAt: _appliedAt, ...childCreate } = childSource.record;
    const savedDraft = renderProposalMarkdown({
      name: childCreate.target.skillKey,
      description: childCreate.description,
      content: "# Child procedure\n\nVerify the result.\n",
      date: childCreate.createdAt,
    });
    // Both creates were proposed before the child existed; only one was applied.
    const untouchedCreate: LegacySource = {
      ...childSource,
      record: {
        ...childCreate,
        id: "child-unstarted-create-20260901-1234567890",
        status: "pending",
        draftHash: hashSkillProposalContent(savedDraft),
      },
    };
    const healthy = appliedSource({
      workspaceDir,
      ownerAgentId: "alpha",
      skillDir: path.join(workspaceDir, "skills", "healthy"),
      skillKey: "healthy",
      id: "healthy-ancestor-20260901-1234567890",
    });
    const draftOnly = pendingUpdate(
      appliedSource({
        workspaceDir,
        ownerAgentId: "alpha",
        skillDir: path.join(workspaceDir, "skills", "user-skill"),
        skillKey: "user-skill",
        id: "user-source-20260901-1234567890",
      }),
      "user-pending-20260901-1234567890",
    );
    const blocked = transitive
      ? [ancestor, secondClaim, connected, childSource, child, untouchedCreate]
      : [ancestor, childSource, child, untouchedCreate];
    await seedSources([...blocked, healthy, draftOnly]);
    const proposalDir = path.join(
      testState.stateDir,
      "skill-workshop",
      "proposals",
      untouchedCreate.record.id,
    );
    await fs.mkdir(proposalDir, { recursive: true });
    await fs.writeFile(path.join(proposalDir, untouchedCreate.record.draftFile), savedDraft);
    const rollback = await seedUnresolvedRollback(child);
    const attestationPath = resolveLegacyWorkspaceSourcePaths(formerWorkspace, {
      env: testState.env,
      homedir: () => testState.home,
    }).stateDirAttestationPaths[0];
    assert(attestationPath);
    const attestationContent = `${LEGACY_WORKSPACE_ATTESTATION_HEADER}\n2026-09-01T00:00:00.000Z\n`;
    if (legacyState) {
      await fs.mkdir(path.dirname(attestationPath), { recursive: true });
      await fs.writeFile(attestationPath, attestationContent);
    }

    const result = await migrateLegacySkillWorkshopProposals({ config, env: testState.env });

    expect(result.warnings.join("\n")).toContain(child.record.id);
    if (legacyState) {
      expect(result.warnings.join("\n")).toContain(
        `Legacy workspace setup state requires migration for ${formerWorkspace}`,
      );
      await expect(fs.readFile(attestationPath, "utf8")).resolves.toBe(attestationContent);
    }
    await expect(
      readSkillProposalRollback(child.record.id, { env: testState.env }),
    ).resolves.toEqual(rollback);
    await expect(
      readSkillProposalRollback(untouchedCreate.record.id, { env: testState.env }),
    ).resolves.toBeNull();
    const queryOptions = { config, env: testState.env, agentId: "alpha" };
    await expect(
      inspectSkillProposal(untouchedCreate.record.id, queryOptions),
    ).resolves.toMatchObject({
      record: untouchedCreate.record,
      content: savedDraft,
    });
    await expect(listSkillProposals(queryOptions)).resolves.toMatchObject({
      proposals: expect.arrayContaining([
        expect.objectContaining({ id: untouchedCreate.record.id, status: "pending" }),
      ]),
    });
    await expectSourcesPreserved(blocked);
    for (const source of [...blocked, draftOnly]) {
      const destination = path.join(
        resolveWorkshopSkillsDir(config, source.ownerAgentId, testState.env),
        source.record.target.skillKey,
      );
      await expect(fs.access(destination)).rejects.toMatchObject({ code: "ENOENT" });
    }
    await expect(fs.readFile(draftOnly.record.target.skillFile, "utf8")).resolves.toBe(
      draftOnly.content,
    );
    await expect(
      readSkillProposalRollback(draftOnly.record.id, { env: testState.env }),
    ).resolves.toBeNull();
    await expectSourceMoved(healthy, config);
  });
});

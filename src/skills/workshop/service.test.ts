// Workshop service tests cover skill workshop generation, storage, and validation behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  closeOpenClawStateDatabaseByPath,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import {
  getSkillsSnapshotVersion,
  resetSkillsRefreshStateForTest,
} from "../runtime/refresh-state.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import { renderProposalMarkdown, stripProposalFrontmatterForSkill } from "./frontmatter.js";
import {
  applySkillProposal as applySkillProposalImpl,
  getSkillProposalRunProgress as getSkillProposalRunProgressImpl,
  inspectSkillProposal as inspectSkillProposalImpl,
  listSkillProposals as listSkillProposalsImpl,
  proposeCreateSkill as proposeCreateSkillImpl,
  proposeUpdateSkill as proposeUpdateSkillImpl,
  quarantineSkillProposal as quarantineSkillProposalImpl,
  readSkillProposalDraftDirectory,
  rejectSkillProposal as rejectSkillProposalImpl,
  resolvePendingSkillProposal as resolvePendingSkillProposalImpl,
  reviseSkillProposal as reviseSkillProposalImpl,
} from "./service.js";
import { resolveWorkshopSkillsDir } from "./skills-root.js";
import { writeSkillProposalRollback } from "./store-sqlite-rollback.js";
import {
  hashSkillProposalContent,
  readSkillProposalManifest,
  readSkillProposalRollback,
  resolveSkillProposalTarget,
} from "./store.js";
import { withSkillCollectionLock } from "./target-lock.js";
import { SKILL_WORKSHOP_ROLLBACK_SCHEMA, type SkillProposalRollback } from "./types.js";
import { listWritableWorkshopSkillSummaries } from "./workspace-skill-read.js";

const tempDirs = createTrackedTempDirs();
const stateDirs = createTrackedTempDirs();
let testEnv: NodeJS.ProcessEnv;
let stateDir = "";
const workshopConfig: OpenClawConfig = {};

function workshopSkillsDir(agentId = "main"): string {
  return resolveWorkshopSkillsDir(workshopConfig, agentId, testEnv);
}

function withWorkshopOwner<T extends { config?: OpenClawConfig; agentId?: string }>(input: T) {
  return {
    ...input,
    config: input.config ?? workshopConfig,
    agentId: input.agentId ?? "main",
  };
}

type OptionalWorkshopConfig<T> = Omit<T, "config"> & { config?: OpenClawConfig };

const applySkillProposal = (
  input: OptionalWorkshopConfig<Parameters<typeof applySkillProposalImpl>[0]>,
) => applySkillProposalImpl(withWorkshopOwner(input));
const getSkillProposalRunProgress = (
  input: OptionalWorkshopConfig<Parameters<typeof getSkillProposalRunProgressImpl>[0]>,
) => getSkillProposalRunProgressImpl(withWorkshopOwner(input));
const inspectSkillProposal = (
  proposalId: string,
  input?: OptionalWorkshopConfig<Parameters<typeof inspectSkillProposalImpl>[1]>,
) => inspectSkillProposalImpl(proposalId, withWorkshopOwner(input ?? {}));
const listSkillProposals = (
  input?: OptionalWorkshopConfig<Parameters<typeof listSkillProposalsImpl>[0]>,
) => listSkillProposalsImpl(withWorkshopOwner(input ?? {}));
const proposeCreateSkill = (
  input: OptionalWorkshopConfig<Parameters<typeof proposeCreateSkillImpl>[0]>,
) => proposeCreateSkillImpl(withWorkshopOwner(input));
const proposeUpdateSkill = (
  input: OptionalWorkshopConfig<Parameters<typeof proposeUpdateSkillImpl>[0]>,
) => proposeUpdateSkillImpl(withWorkshopOwner(input));
const quarantineSkillProposal = (
  input: OptionalWorkshopConfig<Parameters<typeof quarantineSkillProposalImpl>[0]>,
) => quarantineSkillProposalImpl(withWorkshopOwner(input));
const rejectSkillProposal = (
  input: OptionalWorkshopConfig<Parameters<typeof rejectSkillProposalImpl>[0]>,
) => rejectSkillProposalImpl(withWorkshopOwner(input));
const resolvePendingSkillProposal = (
  input: OptionalWorkshopConfig<Parameters<typeof resolvePendingSkillProposalImpl>[0]>,
) => resolvePendingSkillProposalImpl(withWorkshopOwner(input));
const reviseSkillProposal = (
  input: OptionalWorkshopConfig<Parameters<typeof reviseSkillProposalImpl>[0]>,
) => reviseSkillProposalImpl(withWorkshopOwner(input));

beforeAll(async () => {
  stateDir = await stateDirs.make("openclaw-skill-workshop-state-");
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
  await fs.rm(path.join(stateDir, "workshop-skills"), { recursive: true, force: true });
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
  return await tempDirs.make("openclaw-skill-workshop-");
}

async function createOwnedSkill(params: {
  workspaceDir: string;
  name: string;
  description: string;
  body: string;
}): Promise<string> {
  const proposal = await proposeCreateSkill({
    workspaceDir: params.workspaceDir,
    env: testEnv,
    name: params.name,
    description: params.description,
    content: params.body,
    config: workshopConfig,
    agentId: "main",
  });
  await applySkillProposal({
    workspaceDir: params.workspaceDir,
    env: testEnv,
    proposalId: proposal.record.id,
    expectedRevisionHash: proposal.revisionHash,
  });
  return proposal.record.target.skillDir;
}

function createSkillProposalRollback(params: {
  proposalId: string;
  targetSkillFile: string;
  action: "create" | "update";
  previousContent?: string;
  supportFiles?: SkillProposalRollback["supportFiles"];
}): SkillProposalRollback {
  return {
    schema: SKILL_WORKSHOP_ROLLBACK_SCHEMA,
    proposalId: params.proposalId,
    writtenAt: new Date().toISOString(),
    targetSkillFile: params.targetSkillFile,
    action: params.action,
    ...(params.previousContent !== undefined
      ? {
          previousContent: params.previousContent,
          previousContentHash: hashSkillProposalContent(params.previousContent),
        }
      : {}),
    ...(params.supportFiles ? { supportFiles: params.supportFiles } : {}),
  };
}

describe("skill workshop proposals", () => {
  it("uses one Workshop target across session workspaces", async () => {
    const firstWorkspaceDir = await fs.realpath(await makeWorkspace());
    const secondWorkspaceDir = await fs.realpath(await makeWorkspace());
    const firstTarget = resolveSkillProposalTarget({
      skillName: "shared-workshop-skill",
      config: workshopConfig,
      agentId: "main",
      env: testEnv,
    });
    const secondTarget = resolveSkillProposalTarget({
      skillName: "shared-workshop-skill",
      config: workshopConfig,
      agentId: "main",
      env: testEnv,
    });
    expect(firstTarget).toEqual(secondTarget);

    const first = await proposeCreateSkill({
      workspaceDir: firstWorkspaceDir,
      env: testEnv,
      name: "shared-workshop-skill",
      description: "Shared Workshop skill",
      content: "# Shared Workshop Skill\n",
    });
    const firstCachedVersion = getSkillsSnapshotVersion(firstWorkspaceDir);
    const secondCachedVersion = getSkillsSnapshotVersion(secondWorkspaceDir);
    await applySkillProposal({
      workspaceDir: firstWorkspaceDir,
      env: testEnv,
      proposalId: first.record.id,
    });
    expect(getSkillsSnapshotVersion(firstWorkspaceDir)).toBeGreaterThan(firstCachedVersion);
    expect(getSkillsSnapshotVersion(secondWorkspaceDir)).toBeGreaterThan(secondCachedVersion);

    await expect(
      proposeCreateSkill({
        workspaceDir: secondWorkspaceDir,
        env: testEnv,
        name: "shared-workshop-skill",
        description: "Duplicate Workshop skill",
        content: "# Duplicate\n",
      }),
    ).rejects.toThrow(`Skill already exists at ${firstTarget.skillFile}`);
  });

  it("refuses to update a skill outside the Workshop directory", async () => {
    const workspaceDir = await fs.realpath(await makeWorkspace());
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "operator-skill"),
      name: "operator-skill",
      description: "Operator-owned skill",
    });

    await expect(
      proposeUpdateSkill({
        workspaceDir,
        env: testEnv,
        skillName: "operator-skill",
        content: "# Changed\n",
      }),
    ).rejects.toThrow("No Workshop-generated skill matched");
  });

  it("renders proposal markdown with a terminal newline", () => {
    expect(
      renderProposalMarkdown({
        name: "example",
        description: "Example proposal",
        content: "# Example",
        date: "2026-07-05T00:00:00.000Z",
      }).endsWith("\n"),
    ).toBe(true);
  });

  it("creates a pending proposal under the workshop and applies it as an active workspace skill", async () => {
    const workspaceDir = await makeWorkspace();
    const proposal = await proposeCreateSkill({
      workspaceDir,
      name: "Weather Helper",
      description: "Check weather before planning outdoor tasks",
      content: "# Weather Helper\n\nUse the weather provider before answering.\n",
      supportFiles: [
        {
          path: "references/weather-api.md",
          content: "# Weather API\n\nUse the current weather endpoint.\n",
        },
        {
          path: "scripts/check-weather.js",
          content: "export function parseWeather(value) { return value; }\n",
        },
      ],
      createdBy: "skill-workshop",
      goal: "Reuse weather lookup steps",
    });

    expect(proposal.record.status).toBe("pending");
    expect(proposal.record.scan.state).toBe("clean");
    expect(proposal.content).toContain('name: "weather-helper"');
    expect(proposal.record.supportFiles?.map((file) => file.path)).toEqual([
      "references/weather-api.md",
      "scripts/check-weather.js",
    ]);
    await expect(inspectSkillProposal(proposal.record.id)).resolves.toMatchObject({
      supportFiles: [
        {
          path: "references/weather-api.md",
          content: "# Weather API\n\nUse the current weather endpoint.\n",
        },
        {
          path: "scripts/check-weather.js",
          content: "export function parseWeather(value) { return value; }\n",
        },
      ],
    });
    expect(proposal.record.target.skillFile).toBe(
      path.join(workshopSkillsDir(), "weather-helper", "SKILL.md"),
    );
    expect(proposal.content).toContain("date: ");

    const listed = await listSkillProposals();
    expect(listed.proposals).toHaveLength(1);
    expect(listed.proposals[0]).toMatchObject({
      id: proposal.record.id,
      status: "pending",
      skillKey: "weather-helper",
      scanState: "clean",
    });
    expect((await listSkillProposals()).updatedAt).toBe(listed.updatedAt);

    const beforeVersion = getSkillsSnapshotVersion(workspaceDir);
    const applied = await applySkillProposal({
      workspaceDir,
      proposalId: proposal.record.id,
    });
    expect(getSkillsSnapshotVersion(workspaceDir)).toBeGreaterThan(beforeVersion);
    expect(applied.targetSkillFile).toBe(proposal.record.target.skillFile);
    await expect(fs.readFile(applied.targetSkillFile, "utf8")).resolves.toBe(
      '---\nname: "weather-helper"\ndescription: "Check weather before planning outdoor tasks"\n---\n\n# Weather Helper\n\nUse the weather provider before answering.\n',
    );
    await expect(
      fs.readFile(
        path.join(workshopSkillsDir(), "weather-helper", "references", "weather-api.md"),
        "utf8",
      ),
    ).resolves.toContain("Use the current weather endpoint.");
    await expect(
      fs.readFile(
        path.join(workshopSkillsDir(), "weather-helper", "scripts", "check-weather.js"),
        "utf8",
      ),
    ).resolves.toContain("parseWeather");

    expect(
      listWritableWorkshopSkillSummaries({
        config: workshopConfig,
        agentId: "main",
        env: testEnv,
      }).find((skill) => skill.name === "weather-helper"),
    ).toMatchObject({
      name: "weather-helper",
      filePath: applied.targetSkillFile,
    });
    expect((await inspectSkillProposal(proposal.record.id))?.record.status).toBe("applied");
  });

  it("persists the reason when applying a proposal", async () => {
    const workspaceDir = await makeWorkspace();
    const proposal = await proposeCreateSkill({
      workspaceDir,
      name: "Reviewed Skill",
      description: "Proposal approved after review",
      content: "# Reviewed Skill\n\nUse the reviewed workflow.\n",
    });

    const applied = await applySkillProposal({
      workspaceDir,
      proposalId: proposal.record.id,
      reason: "  approved after operator review  ",
    });

    expect(applied.record.statusReason).toBe("approved after operator review");
    await expect(inspectSkillProposal(proposal.record.id)).resolves.toMatchObject({
      record: {
        status: "applied",
        statusReason: "approved after operator review",
      },
    });
  });

  it("preserves non-proposal frontmatter when proposals become active skills", async () => {
    const workspaceDir = await makeWorkspace();
    const created = await proposeCreateSkill({
      workspaceDir,
      name: "Frontmatter Skill",
      description: "Preserve metadata",
      content:
        "---\nuser-invocable: false\nmetadata:\n  openclaw:\n    requires:\n      env:\n        - API_TOKEN\n---\n\n# Frontmatter Skill\n",
    });

    await expect(
      applySkillProposal({ workspaceDir, proposalId: created.record.id }),
    ).resolves.toBeDefined();
    const createdSkill = await fs.readFile(
      path.join(workshopSkillsDir(), "frontmatter-skill", "SKILL.md"),
      "utf8",
    );
    expect(createdSkill).toContain("user-invocable: false");
    expect(createdSkill).toContain("metadata:\n  openclaw:");
    expect(createdSkill).not.toContain("status: proposal");
    expect(createdSkill).not.toContain("version: ");
    expect(createdSkill).not.toContain("date: ");

    const skillDir = await createOwnedSkill({
      workspaceDir,
      name: "metadata-update",
      description: "Update metadata",
      body: "# Metadata Update\n\nOld body.\n",
    });
    const skillFile = path.join(skillDir, "SKILL.md");
    await fs.writeFile(
      skillFile,
      "---\nname: metadata-update\ndescription: Update metadata\nuser-invocable: false\n---\n\n# Metadata Update\n\nOld body.\n",
      "utf8",
    );
    const updated = await proposeUpdateSkill({
      workspaceDir,
      skillName: "metadata-update",
      content: "# Metadata Update\n\nNew body.\n",
    });

    await applySkillProposal({ workspaceDir, proposalId: updated.record.id });

    await expect(fs.readFile(skillFile, "utf8")).resolves.toContain("user-invocable: false");
  });

  it("rejects create proposals when the target skill file already exists", async () => {
    const workspaceDir = await makeWorkspace();
    const skillFile = path.join(workshopSkillsDir(), "empty-skill", "SKILL.md");
    await fs.mkdir(path.dirname(skillFile), { recursive: true });
    await fs.writeFile(skillFile, "", "utf8");

    await expect(
      proposeCreateSkill({
        workspaceDir,
        name: "Empty Skill",
        description: "Existing empty skill file",
        content: "# Empty Skill\n",
      }),
    ).rejects.toThrow("Skill already exists");
  });

  it("reconciles pending create proposals when their target skills are created manually", async () => {
    const workspaceDir = await makeWorkspace();
    const listed = await proposeCreateSkill({
      workspaceDir,
      name: "Listed Manual Skill",
      description: "Becomes stale before proposal listing.",
      content: "# Listed Manual Skill\n",
    });
    const inspected = await proposeCreateSkill({
      workspaceDir,
      name: "Inspected Manual Skill",
      description: "Becomes stale before proposal inspection.",
      content: "# Inspected Manual Skill\n",
    });
    await fs.mkdir(listed.record.target.skillDir, { recursive: true });
    await fs.writeFile(
      listed.record.target.skillFile,
      stripProposalFrontmatterForSkill(listed.content),
      "utf8",
    );
    await writeSkill({
      dir: inspected.record.target.skillDir,
      name: "inspected-manual-skill",
      description: "Installed without the proposal.",
      body: "# Inspected Manual Skill\n\nAlready active.\n",
    });

    await expect(listSkillProposals()).resolves.toMatchObject({
      proposals: expect.arrayContaining([
        expect.objectContaining({
          id: listed.record.id,
          status: "stale",
        }),
      ]),
    });
    await expect(inspectSkillProposal(inspected.record.id)).resolves.toMatchObject({
      record: {
        id: inspected.record.id,
        status: "stale",
        statusReason: "Target skill was created after proposal creation.",
      },
    });
    await expect(
      resolvePendingSkillProposal({
        name: listed.record.target.skillKey,
        workspaceDir,
      }),
    ).rejects.toThrow("No pending skill proposal matched");
  });

  it("revises pending proposals in place before approval", async () => {
    const workspaceDir = await makeWorkspace();
    const proposal = await proposeCreateSkill({
      workspaceDir,
      name: "Draftable Skill",
      description: "Original proposal",
      content: "# Draftable\n\nOriginal body.\n",
      origin: { runId: "original-run" },
      supportFiles: [
        {
          path: "references/original.md",
          content: "Original support file.\n",
        },
      ],
      goal: "Original goal",
      evidence: "Original evidence",
    });
    await writeSkillProposalRollback({
      proposalId: proposal.record.id,
      rollback: createSkillProposalRollback({
        proposalId: proposal.record.id,
        targetSkillFile: proposal.record.target.skillFile,
        action: "create",
      }),
    });

    const revised = await reviseSkillProposal({
      workspaceDir,
      proposalId: proposal.record.id,
      description: "Revised proposal",
      content: "# Draftable\n\nRevised body.\n",
      origin: { runId: "revision-run" },
      evidence: "",
    });

    expect(revised.record.id).toBe(proposal.record.id);
    expect(revised.record.proposedVersion).toBe("v2");
    expect(revised.record.description).toBe("Revised proposal");
    expect(revised.record.goal).toBe("Original goal");
    expect(revised.record.evidence).toBeUndefined();
    expect(revised.record.origin).toEqual({ runId: "revision-run" });
    expect(revised.record.originRunIds).toEqual(["original-run", "revision-run"]);
    expect(revised.record.supportFiles?.map((file) => file.path)).toEqual([
      "references/original.md",
    ]);
    await expect(readSkillProposalRollback(proposal.record.id)).resolves.toBeNull();
    expect(revised.content).toContain('version: "v2"');
    expect(revised.content).toContain("date: ");

    const removedSupport = await reviseSkillProposal({
      workspaceDir,
      proposalId: proposal.record.id,
      content: "# Draftable\n\nFinal body.\n",
      origin: { runId: "revision-run" },
      supportFiles: [],
    });

    expect(removedSupport.record.proposedVersion).toBe("v3");
    expect(removedSupport.record.origin).toEqual({ runId: "revision-run" });
    expect(removedSupport.record.originRunIds).toEqual(["original-run", "revision-run"]);
    expect(removedSupport.record.originRunMutationCounts?.["revision-run"]).toBe(2);

    const laterRevision = await reviseSkillProposal({
      workspaceDir,
      proposalId: proposal.record.id,
      content: "# Draftable\n\nLater body.\n",
      origin: { runId: "later-run" },
      supportFiles: [],
    });
    expect(laterRevision.record.proposedVersion).toBe("v4");
    expect(laterRevision.record.originRunIds).toEqual([
      "original-run",
      "revision-run",
      "later-run",
    ]);
    await expect(
      getSkillProposalRunProgress({
        config: workshopConfig,
        agentId: "main",
        runId: "revision-run",
      }),
    ).resolves.toEqual({
      mutationCount: 2,
      proposalIds: [proposal.record.id],
    });
    expect(removedSupport.record.supportFiles).toBeUndefined();
    await expect(
      fs.access(
        path.join(
          stateDir,
          "skill-workshop",
          "proposals",
          proposal.record.id,
          path.dirname(proposal.record.draftFile),
          "references",
          "original.md",
        ),
      ),
    ).rejects.toThrow();

    await applySkillProposal({ workspaceDir, proposalId: proposal.record.id });
    await expect(
      fs.readFile(path.join(workshopSkillsDir(), "draftable-skill", "SKILL.md"), "utf8"),
    ).resolves.toBe(
      '---\nname: "draftable-skill"\ndescription: "Revised proposal"\n---\n\n# Draftable\n\nLater body.\n',
    );
  });

  it("recovers run progress from canonical proposal records", async () => {
    const workspaceDir = await makeWorkspace();
    const proposal = await proposeCreateSkill({
      workspaceDir,
      name: "Recovered Proposal",
      description: "Recover a durable proposal after manifest interruption",
      content: "# Recovered Proposal\n",
      origin: { runId: "interrupted-run" },
    });
    await expect(
      getSkillProposalRunProgress({
        config: workshopConfig,
        agentId: "main",
        runId: "interrupted-run",
      }),
    ).resolves.toEqual({
      mutationCount: 1,
      proposalIds: [proposal.record.id],
    });
  });

  it("resolves pending proposals by skill name for tool-driven revisions", async () => {
    const workspaceDir = await makeWorkspace();
    const proposal = await proposeCreateSkill({
      workspaceDir,
      name: "Named Proposal",
      description: "Find this proposal",
      content: "# Named\n\nOriginal body.\n",
    });

    const resolved = await resolvePendingSkillProposal({
      name: "named-proposal",
    });

    expect(resolved.record.id).toBe(proposal.record.id);

    await applySkillProposal({ workspaceDir, proposalId: proposal.record.id });
    await expect(resolvePendingSkillProposal({ name: "named-proposal" })).rejects.toThrow(
      "No pending skill proposal matched",
    );
  });

  it("requires explicit proposal ids for ambiguous pending proposal names", async () => {
    const workspaceDir = await makeWorkspace();
    await proposeCreateSkill({
      workspaceDir,
      name: "Gateway Pairing",
      description: "First candidate",
      content: "# Gateway\n\nFirst.\n",
    });
    await proposeCreateSkill({
      workspaceDir,
      name: "Gateway Pairing Triage",
      description: "Second candidate",
      content: "# Gateway\n\nSecond.\n",
    });

    await expect(resolvePendingSkillProposal({ name: "gateway-pairing" })).rejects.toThrow(
      "Multiple pending skill proposals matched gateway-pairing",
    );
  });

  it("keeps an agent's proposals across session workspace changes", async () => {
    const firstWorkspaceDir = await makeWorkspace();
    const secondWorkspaceDir = await makeWorkspace();
    const first = await proposeCreateSkill({
      agentId: "main",
      workspaceDir: firstWorkspaceDir,
      name: "First Workspace Skill",
      description: "Created before the workspace changed",
      content: "# First\n",
    });
    const quarantined = await proposeCreateSkill({
      agentId: "main",
      workspaceDir: firstWorkspaceDir,
      name: "First Workspace Review",
      description: "Also created before the workspace changed",
      content: "# First Review\n",
    });
    const second = await proposeCreateSkill({
      agentId: "main",
      workspaceDir: secondWorkspaceDir,
      name: "Second Workspace Skill",
      description: "Created after the workspace changed",
      content: "# Second\n",
    });
    await proposeCreateSkill({
      agentId: "other",
      workspaceDir: secondWorkspaceDir,
      name: "Other Agent Skill",
      description: "Owned by a different agent",
      content: "# Other\n",
    });

    const listed = await listSkillProposals({ agentId: "main" });
    expect(listed.proposals.toSorted((a, b) => a.skillKey.localeCompare(b.skillKey))).toEqual([
      expect.objectContaining({ id: quarantined.record.id }),
      expect.objectContaining({ id: first.record.id }),
      expect.objectContaining({ id: second.record.id }),
    ]);
    await expect(
      inspectSkillProposal(first.record.id, {
        agentId: "main",
      }),
    ).resolves.toMatchObject({ record: { id: first.record.id } });
    await expect(
      resolvePendingSkillProposal({
        agentId: "main",
        name: "first-workspace-skill",
        workspaceDir: secondWorkspaceDir,
      }),
    ).resolves.toMatchObject({ record: { id: first.record.id } });
    await expect(
      rejectSkillProposal({
        agentId: "main",
        workspaceDir: secondWorkspaceDir,
        proposalId: first.record.id,
      }),
    ).resolves.toMatchObject({ status: "rejected" });
    await expect(
      quarantineSkillProposal({
        agentId: "main",
        workspaceDir: secondWorkspaceDir,
        proposalId: quarantined.record.id,
      }),
    ).resolves.toMatchObject({ status: "quarantined" });
  });

  it("isolates proposals between agents", async () => {
    const firstWorkspaceDir = await makeWorkspace();
    const secondWorkspaceDir = await makeWorkspace();
    const first = await proposeCreateSkill({
      config: workshopConfig,
      agentId: "main",
      workspaceDir: firstWorkspaceDir,
      name: "First Agent Skill",
      description: "Bound to the first agent",
      content: "# First\n",
    });
    const second = await proposeCreateSkill({
      config: workshopConfig,
      agentId: "other",
      workspaceDir: secondWorkspaceDir,
      name: "Second Agent Skill",
      description: "Bound to the second agent",
      content: "# Second\n",
    });

    await expect(
      listSkillProposals({ config: workshopConfig, agentId: "main" }),
    ).resolves.toMatchObject({
      proposals: [expect.objectContaining({ id: first.record.id })],
    });
    await expect(
      rejectSkillProposal({
        config: workshopConfig,
        agentId: "main",
        workspaceDir: firstWorkspaceDir,
        proposalId: second.record.id,
      }),
    ).rejects.toThrow(`Skill proposal not found: ${second.record.id}`);
    await expect(
      inspectSkillProposal(second.record.id, { config: workshopConfig, agentId: "main" }),
    ).resolves.toBeNull();
    await expect(
      inspectSkillProposal(second.record.id, { config: workshopConfig, agentId: "other" }),
    ).resolves.toMatchObject({ record: { id: second.record.id } });
  });

  it("updates only writable workspace skills and marks stale proposals when the target changes", async () => {
    const workspaceDir = await makeWorkspace();
    const skillDir = await createOwnedSkill({
      workspaceDir,
      name: "release-notes",
      description: "Draft release notes",
      body: "# Release Notes\n\nOld steps.\n",
    });
    const skillFile = path.join(skillDir, "SKILL.md");
    const proposal = await proposeUpdateSkill({
      workspaceDir,
      skillName: "release-notes",
      content: "# Release Notes\n\nNew steps.\n",
    });

    await fs.writeFile(
      skillFile,
      "---\nname: release-notes\ndescription: Draft release notes\n---\n\nChanged elsewhere.\n",
      "utf8",
    );

    await expect(
      applySkillProposal({ workspaceDir, proposalId: proposal.record.id }),
    ).rejects.toThrow("proposal marked stale");
    expect((await inspectSkillProposal(proposal.record.id))?.record.status).toBe("stale");
  });

  it("applies update proposals with rollback metadata", async () => {
    const workspaceDir = await makeWorkspace();
    const skillDir = await createOwnedSkill({
      workspaceDir,
      name: "qa-check",
      description: "Run QA checks",
      body: "# QA\n\nOld checklist.\n",
    });
    await fs.mkdir(path.join(skillDir, "references"), { recursive: true });
    await fs.writeFile(path.join(skillDir, "references", "qa.md"), "Old support file.\n", "utf8");
    const proposal = await proposeUpdateSkill({
      workspaceDir,
      skillName: "qa-check",
      content: "# QA\n\nNew checklist.\n",
      supportFiles: [
        {
          path: "references/qa.md",
          content: "New support file.\n",
        },
      ],
    });

    await applySkillProposal({ workspaceDir, proposalId: proposal.record.id });

    await expect(fs.readFile(path.join(skillDir, "SKILL.md"), "utf8")).resolves.toContain(
      "New checklist.",
    );
    const rollback = await readSkillProposalRollback(proposal.record.id);
    if (!rollback) {
      throw new Error("expected rollback metadata");
    }
    expect(rollback.previousContent).toContain("Old checklist.");
    expect(rollback.supportFiles?.[0]?.previousContent).toContain("Old support file.");
    await expect(fs.readFile(path.join(skillDir, "references", "qa.md"), "utf8")).resolves.toBe(
      "New support file.\n",
    );
  });

  it("marks update proposals stale when target support files change before apply", async () => {
    const workspaceDir = await makeWorkspace();
    const skillDir = await createOwnedSkill({
      workspaceDir,
      name: "support-stale",
      description: "Detect stale support files",
      body: "# Support Stale\n\nOld checklist.\n",
    });
    await fs.mkdir(path.join(skillDir, "references"), { recursive: true });
    await fs.writeFile(path.join(skillDir, "references", "qa.md"), "Old support file.\n", "utf8");
    const proposal = await proposeUpdateSkill({
      workspaceDir,
      skillName: "support-stale",
      content: "# Support Stale\n\nNew checklist.\n",
      supportFiles: [
        {
          path: "references/qa.md",
          content: "New support file.\n",
        },
      ],
    });

    await fs.writeFile(path.join(skillDir, "references", "qa.md"), "Changed elsewhere.\n", "utf8");

    await expect(
      applySkillProposal({ workspaceDir, proposalId: proposal.record.id }),
    ).rejects.toThrow("Target support file changed after proposal creation");
    expect((await inspectSkillProposal(proposal.record.id))?.record.status).toBe("stale");
    await expect(fs.readFile(path.join(skillDir, "references", "qa.md"), "utf8")).resolves.toBe(
      "Changed elsewhere.\n",
    );
  });

  it("keeps update proposal support baselines when revising", async () => {
    const workspaceDir = await makeWorkspace();
    const skillDir = await createOwnedSkill({
      workspaceDir,
      name: "support-revise-stale",
      description: "Detect stale support files during revision",
      body: "# Support Revise Stale\n\nOld checklist.\n",
    });
    await fs.mkdir(path.join(skillDir, "references"), { recursive: true });
    await fs.writeFile(path.join(skillDir, "references", "qa.md"), "Old support file.\n", "utf8");
    const proposal = await proposeUpdateSkill({
      workspaceDir,
      skillName: "support-revise-stale",
      content: "# Support Revise Stale\n\nNew checklist.\n",
      supportFiles: [
        {
          path: "references/qa.md",
          content: "New support file.\n",
        },
      ],
    });

    await fs.writeFile(path.join(skillDir, "references", "qa.md"), "Changed elsewhere.\n", "utf8");

    await expect(
      reviseSkillProposal({
        workspaceDir,
        proposalId: proposal.record.id,
        content: "# Support Revise Stale\n\nRevised checklist.\n",
      }),
    ).rejects.toThrow("Target support file changed after proposal creation");
    expect((await inspectSkillProposal(proposal.record.id))?.record.status).toBe("stale");
    await expect(fs.readFile(path.join(skillDir, "references", "qa.md"), "utf8")).resolves.toBe(
      "Changed elsewhere.\n",
    );
  });

  it("rejects and quarantines proposals without touching active skills", async (ctx) => {
    // Manifest order follows updatedAt, so each terminal mutation needs a distinct timestamp.
    vi.useFakeTimers({ toFake: ["Date"] });
    ctx.onTestFinished(() => {
      vi.useRealTimers();
    });
    vi.setSystemTime(new Date("2026-08-30T00:00:00.000Z"));
    const workspaceDir = await makeWorkspace();
    const rejected = await proposeCreateSkill({
      workspaceDir,
      name: "Draft One",
      description: "Draft rejected proposal",
      content: "# Draft\n",
    });
    const quarantined = await proposeCreateSkill({
      workspaceDir,
      name: "Draft Two",
      description: "Draft quarantined proposal",
      content: "# Draft\n",
    });
    const applied = await proposeCreateSkill({
      workspaceDir,
      name: "Draft Three",
      description: "Draft applied proposal",
      content: "# Draft\n",
    });

    await rejectSkillProposal({
      workspaceDir,
      proposalId: rejected.record.id,
      reason: "not useful",
    });
    vi.setSystemTime(new Date("2026-08-30T00:00:01.000Z"));
    await quarantineSkillProposal({
      workspaceDir,
      proposalId: quarantined.record.id,
      reason: "needs review",
    });
    vi.setSystemTime(new Date("2026-08-30T00:00:02.000Z"));
    await applySkillProposal({
      workspaceDir,
      proposalId: applied.record.id,
    });

    const manifest = await readSkillProposalManifest(
      { env: testEnv, config: workshopConfig, agentId: "main" },
      { agentId: "main" },
    );
    expect(
      manifest.proposals
        .toSorted((a, b) => a.skillKey.localeCompare(b.skillKey))
        .map((entry) => [entry.skillKey, entry.status]),
    ).toEqual([
      ["draft-one", "rejected"],
      ["draft-three", "applied"],
      ["draft-two", "quarantined"],
    ]);
    await expect(
      fs.access(path.join(workshopSkillsDir(), "draft-one", "SKILL.md")),
    ).rejects.toThrow();
    await expect(
      fs.access(path.join(workshopSkillsDir(), "draft-two", "SKILL.md")),
    ).rejects.toThrow();

    await expect(
      rejectSkillProposal({
        workspaceDir,
        proposalId: rejected.record.id,
        reason: "already rejected",
      }),
    ).rejects.toThrow("Only pending proposals can be rejected");
    await expect(
      quarantineSkillProposal({
        workspaceDir,
        proposalId: quarantined.record.id,
        reason: "already quarantined",
      }),
    ).rejects.toThrow("Only pending proposals can be quarantined");
    await expect(
      rejectSkillProposal({
        workspaceDir,
        proposalId: applied.record.id,
        reason: "already applied",
      }),
    ).rejects.toThrow("Only pending proposals can be rejected");
  });

  it("reconciles a create apply interrupted after the live skill write", async () => {
    const workspaceDir = await makeWorkspace();
    const proposal = await proposeCreateSkill({
      workspaceDir,
      name: "Interrupted Apply",
      description: "Recover an interrupted create apply",
      content: "# Interrupted Apply\n\nInstalled before the status commit.\n",
      supportFiles: [{ path: "references/proof.md", content: "Applied support.\n" }],
    });
    const sibling = await proposeCreateSkill({
      workspaceDir,
      name: "Interrupted Apply",
      description: "Recover an interrupted create apply",
      content: "# Interrupted Apply\n\nInstalled before the status commit.\n",
      supportFiles: [{ path: "references/proof.md", content: "Different support.\n" }],
    });
    await writeSkillProposalRollback({
      proposalId: sibling.record.id,
      rollback: createSkillProposalRollback({
        proposalId: sibling.record.id,
        targetSkillFile: sibling.record.target.skillFile,
        action: "create",
        supportFiles: [{ path: "references/proof.md", existed: false }],
      }),
    });
    await writeSkillProposalRollback({
      proposalId: proposal.record.id,
      rollback: createSkillProposalRollback({
        proposalId: proposal.record.id,
        targetSkillFile: proposal.record.target.skillFile,
        action: "create",
        supportFiles: [{ path: "references/proof.md", existed: false }],
      }),
    });
    await expect(readSkillProposalRollback(sibling.record.id)).resolves.toBeNull();
    await fs.mkdir(proposal.record.target.skillDir, { recursive: true });
    await fs.mkdir(path.join(proposal.record.target.skillDir, "references"), { recursive: true });
    await fs.writeFile(
      path.join(proposal.record.target.skillDir, "references", "proof.md"),
      "Applied support.\n",
      "utf8",
    );
    await fs.writeFile(
      proposal.record.target.skillFile,
      stripProposalFrontmatterForSkill(proposal.content),
      "utf8",
    );

    closeOpenClawStateDatabaseForTest();
    const manifest = await listSkillProposals();
    expect(manifest.proposals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: proposal.record.id, status: "applied" }),
        expect.objectContaining({ id: sibling.record.id, status: "stale" }),
      ]),
    );
    await expect(
      applySkillProposal({ workspaceDir, proposalId: proposal.record.id }),
    ).rejects.toThrow("Only pending proposals can be applied. Current status: applied.");
  });

  it("restores and retries a create apply interrupted after a support write", async () => {
    const workspaceDir = await makeWorkspace();
    const proposal = await proposeCreateSkill({
      workspaceDir,
      name: "Partial Create",
      description: "Recover a partially written create",
      content: "# Partial Create\n\nRetry after recovery.\n",
      supportFiles: [{ path: "references/proof.md", content: "Partial support.\n" }],
    });
    const supportFile = path.join(proposal.record.target.skillDir, "references", "proof.md");
    await writeSkillProposalRollback({
      proposalId: proposal.record.id,
      rollback: createSkillProposalRollback({
        proposalId: proposal.record.id,
        targetSkillFile: proposal.record.target.skillFile,
        action: "create",
        supportFiles: [{ path: "references/proof.md", existed: false }],
      }),
    });
    await fs.mkdir(path.dirname(supportFile), { recursive: true });
    await fs.writeFile(supportFile, "Partial support.\n", "utf8");

    closeOpenClawStateDatabaseForTest();
    let releaseLock: (() => void) | undefined;
    let markAcquired: (() => void) | undefined;
    const acquired = new Promise<void>((resolve) => {
      markAcquired = resolve;
    });
    const heldLock = withSkillCollectionLock(
      async () => {
        markAcquired?.();
        await new Promise<void>((resolve) => {
          releaseLock = resolve;
        });
      },
      { env: testEnv, agentId: "main" },
    );
    await acquired;
    let settled = false;
    const listing = listSkillProposals().finally(() => {
      settled = true;
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(settled).toBe(false);
    releaseLock?.();
    await heldLock;
    await expect(listing).resolves.toMatchObject({
      proposals: [expect.objectContaining({ id: proposal.record.id, status: "pending" })],
    });
    await expect(fs.access(supportFile)).rejects.toThrow();

    await expect(
      applySkillProposal({ workspaceDir, proposalId: proposal.record.id }),
    ).resolves.toMatchObject({ record: { status: "applied" } });
    await expect(fs.readFile(supportFile, "utf8")).resolves.toBe("Partial support.\n");
  });

  it("does not reconcile an interrupted apply from a tampered proposal draft", async () => {
    const workspaceDir = await makeWorkspace();
    const proposal = await proposeCreateSkill({
      workspaceDir,
      name: "Tampered Reconcile",
      description: "Reject altered proposal metadata during recovery",
      content: "# Tampered Reconcile\n\nCanonical body.\n",
    });
    await writeSkillProposalRollback({
      proposalId: proposal.record.id,
      rollback: createSkillProposalRollback({
        proposalId: proposal.record.id,
        targetSkillFile: proposal.record.target.skillFile,
        action: "create",
      }),
    });
    await fs.mkdir(proposal.record.target.skillDir, { recursive: true });
    await fs.writeFile(
      proposal.record.target.skillFile,
      stripProposalFrontmatterForSkill(proposal.content),
      "utf8",
    );
    await fs.writeFile(
      path.join(
        stateDir,
        "skill-workshop",
        "proposals",
        proposal.record.id,
        proposal.record.draftFile,
      ),
      proposal.content.replace(/date: .+/, 'date: "2099-01-01T00:00:00.000Z"'),
      "utf8",
    );

    closeOpenClawStateDatabaseForTest();
    await expect(listSkillProposals()).resolves.toMatchObject({
      proposals: [expect.objectContaining({ id: proposal.record.id, status: "pending" })],
    });
  });

  it("does not overwrite an interrupted target outside rollback facts", async () => {
    const workspaceDir = await makeWorkspace();
    const proposal = await proposeCreateSkill({
      workspaceDir,
      name: "Tampered Target",
      description: "Fail closed when live state is neither previous nor proposed",
      content: "# Tampered Target\n\nCanonical body.\n",
    });
    await writeSkillProposalRollback({
      proposalId: proposal.record.id,
      rollback: createSkillProposalRollback({
        proposalId: proposal.record.id,
        targetSkillFile: proposal.record.target.skillFile,
        action: "create",
      }),
    });
    await fs.mkdir(proposal.record.target.skillDir, { recursive: true });
    await fs.writeFile(proposal.record.target.skillFile, "# External change\n", "utf8");

    closeOpenClawStateDatabaseForTest();
    await expect(listSkillProposals()).resolves.toMatchObject({
      proposals: [expect.objectContaining({ id: proposal.record.id, status: "pending" })],
    });
    await expect(fs.readFile(proposal.record.target.skillFile, "utf8")).resolves.toBe(
      "# External change\n",
    );
    await expect(readSkillProposalRollback(proposal.record.id)).resolves.not.toBeNull();

    const startedAt = Date.now();
    await expect(
      rejectSkillProposal({
        workspaceDir,
        proposalId: proposal.record.id,
        reason: "external target retained",
      }),
    ).resolves.toMatchObject({ status: "rejected" });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("reconciles an update apply interrupted after the live skill write", async () => {
    const workspaceDir = await makeWorkspace();
    const skillDir = await createOwnedSkill({
      workspaceDir,
      name: "interrupted-update",
      description: "Recover interrupted updates",
      body: "# Interrupted Update\n\nOld body.\n",
    });
    const skillFile = path.join(skillDir, "SKILL.md");
    const previousContent = await fs.readFile(skillFile, "utf8");
    const proposal = await proposeUpdateSkill({
      workspaceDir,
      skillName: "interrupted-update",
      content: "# Interrupted Update\n\nNew body.\n",
      supportFiles: [{ path: "references/proof.md", content: "New support.\n" }],
    });
    await writeSkillProposalRollback({
      proposalId: proposal.record.id,
      rollback: createSkillProposalRollback({
        proposalId: proposal.record.id,
        targetSkillFile: proposal.record.target.skillFile,
        action: "update",
        previousContent,
        supportFiles: [{ path: "references/proof.md", existed: false }],
      }),
    });
    await fs.mkdir(path.join(skillDir, "references"), { recursive: true });
    await fs.writeFile(path.join(skillDir, "references", "proof.md"), "New support.\n", "utf8");
    await fs.writeFile(skillFile, stripProposalFrontmatterForSkill(proposal.content), "utf8");

    closeOpenClawStateDatabaseForTest();
    await expect(listSkillProposals()).resolves.toMatchObject({
      proposals: expect.arrayContaining([
        expect.objectContaining({ id: proposal.record.id, status: "applied" }),
      ]),
    });
  });

  it("restores and retries a mixed update apply", async () => {
    const workspaceDir = await makeWorkspace();
    const skillDir = await createOwnedSkill({
      workspaceDir,
      name: "partial-update",
      description: "Recover mixed update writes",
      body: "# Partial Update\n\nOld body.\n",
    });
    const supportFile = path.join(skillDir, "references", "proof.md");
    await fs.mkdir(path.dirname(supportFile), { recursive: true });
    await fs.writeFile(supportFile, "Old support.\n", "utf8");
    const skillFile = path.join(skillDir, "SKILL.md");
    const previousContent = await fs.readFile(skillFile, "utf8");
    const proposal = await proposeUpdateSkill({
      workspaceDir,
      skillName: "partial-update",
      content: "# Partial Update\n\nNew body.\n",
      supportFiles: [{ path: "references/proof.md", content: "New support.\n" }],
    });
    await writeSkillProposalRollback({
      proposalId: proposal.record.id,
      rollback: createSkillProposalRollback({
        proposalId: proposal.record.id,
        targetSkillFile: skillFile,
        action: "update",
        previousContent,
        supportFiles: [
          {
            path: "references/proof.md",
            existed: true,
            previousContent: "Old support.\n",
            previousContentHash: hashSkillProposalContent("Old support.\n"),
          },
        ],
      }),
    });
    await fs.writeFile(skillFile, stripProposalFrontmatterForSkill(proposal.content), "utf8");

    closeOpenClawStateDatabaseForTest();
    await expect(listSkillProposals()).resolves.toMatchObject({
      proposals: expect.arrayContaining([
        expect.objectContaining({ id: proposal.record.id, status: "pending" }),
      ]),
    });
    await expect(fs.readFile(skillFile, "utf8")).resolves.toBe(previousContent);
    await expect(fs.readFile(supportFile, "utf8")).resolves.toBe("Old support.\n");
    await expect(readSkillProposalRollback(proposal.record.id)).resolves.toBeNull();

    await expect(
      applySkillProposal({ workspaceDir, proposalId: proposal.record.id }),
    ).resolves.toMatchObject({ record: { status: "applied" } });
    await expect(fs.readFile(skillFile, "utf8")).resolves.toContain("New body.");
    await expect(fs.readFile(supportFile, "utf8")).resolves.toBe("New support.\n");
  });

  it("does not reconcile another agent's interrupted apply before authorization", async () => {
    const workspaceDir = await makeWorkspace();
    const proposal = await proposeCreateSkill({
      agentId: "owner",
      workspaceDir,
      name: "Authorized Reconcile",
      description: "Require proposal ownership before recovery",
      content: "# Authorized Reconcile\n\nOwner-only recovery.\n",
    });
    await writeSkillProposalRollback({
      proposalId: proposal.record.id,
      rollback: createSkillProposalRollback({
        proposalId: proposal.record.id,
        targetSkillFile: proposal.record.target.skillFile,
        action: "create",
      }),
    });
    await fs.mkdir(proposal.record.target.skillDir, { recursive: true });
    await fs.writeFile(
      proposal.record.target.skillFile,
      stripProposalFrontmatterForSkill(proposal.content),
      "utf8",
    );

    closeOpenClawStateDatabaseForTest();
    await expect(
      inspectSkillProposal(proposal.record.id, { agentId: "other" }),
    ).resolves.toBeNull();
    await fs.rm(proposal.record.target.skillFile);
    await expect(listSkillProposals({ agentId: "owner" })).resolves.toMatchObject({
      proposals: [expect.objectContaining({ id: proposal.record.id, status: "pending" })],
    });
  });

  it("keeps proposal management available when a reconciliation target cannot be read", async () => {
    const workspaceDir = await makeWorkspace();
    const proposal = await proposeCreateSkill({
      workspaceDir,
      name: "Unreadable Reconcile",
      description: "Keep lifecycle actions available after target failures",
      content: "# Unreadable Reconcile\n",
    });
    await writeSkillProposalRollback({
      proposalId: proposal.record.id,
      rollback: createSkillProposalRollback({
        proposalId: proposal.record.id,
        targetSkillFile: proposal.record.target.skillFile,
        action: "create",
      }),
    });
    await fs.mkdir(proposal.record.target.skillFile, { recursive: true });

    await expect(listSkillProposals()).resolves.toMatchObject({
      proposals: [expect.objectContaining({ id: proposal.record.id, status: "pending" })],
    });
    await expect(
      rejectSkillProposal({ workspaceDir, proposalId: proposal.record.id }),
    ).resolves.toMatchObject({ status: "rejected" });
  });

  it("enforces configured proposal limits before writing proposal state", async () => {
    const workspaceDir = await makeWorkspace();
    const otherWorkspaceDir = await makeWorkspace();
    const limitedConfig = { skills: { workshop: { maxPending: 1, maxSkillBytes: 1024 } } };
    const first = await proposeCreateSkill({
      workspaceDir,
      config: limitedConfig,
      agentId: "main",
      name: "First Limited",
      description: "First limited proposal",
      content: "# First Limited\n",
    });

    const second = await proposeCreateSkill({
      workspaceDir: otherWorkspaceDir,
      config: limitedConfig,
      agentId: "other",
      name: "Second Limited",
      description: "Second limited proposal",
      content: "# Second Limited\n",
    });
    await expect(
      listSkillProposals({ config: limitedConfig, agentId: "other" }),
    ).resolves.toMatchObject({ proposals: [expect.objectContaining({ id: second.record.id })] });
    await expect(
      proposeCreateSkill({
        workspaceDir,
        config: limitedConfig,
        agentId: "main",
        name: "Third Limited",
        description: "Third limited proposal",
        content: "# Third Limited\n",
      }),
    ).rejects.toThrow("pending proposal limit");
    expect((await listSkillProposals()).proposals.map((entry) => entry.id)).toEqual([
      first.record.id,
    ]);

    await rejectSkillProposal({ workspaceDir, proposalId: first.record.id });
    await expect(
      proposeCreateSkill({
        workspaceDir,
        config: limitedConfig,
        name: "Oversized Limited",
        description: "Oversized limited proposal",
        content: "x".repeat(1025),
      }),
    ).rejects.toThrow("proposal content is too large");
    expect((await listSkillProposals()).proposals).toHaveLength(1);

    await createOwnedSkill({
      workspaceDir,
      name: "limited-update",
      description: "Limited update",
      body: "# Limited Update\n",
    });
    await expect(
      proposeUpdateSkill({
        workspaceDir,
        config: limitedConfig,
        skillName: "limited-update",
        content: "x".repeat(1025),
      }),
    ).rejects.toThrow("proposal content is too large");

    const revision = await proposeCreateSkill({
      workspaceDir,
      config: { skills: { workshop: { maxSkillBytes: 2000 } } },
      name: "Limited Revision",
      description: "Limited revision",
      content: "# Limited Revision\n",
    });
    await expect(
      reviseSkillProposal({
        workspaceDir,
        config: limitedConfig,
        proposalId: revision.record.id,
        content: "x".repeat(1025),
      }),
    ).rejects.toThrow("proposal content is too large");
  });

  it("bounds proposal descriptions before writing proposal state", async () => {
    const workspaceDir = await makeWorkspace();
    await expect(
      proposeCreateSkill({
        workspaceDir,
        name: "Oversized Description",
        description: "x".repeat(161),
        content: "# Oversized Description\n",
      }),
    ).rejects.toThrow("proposal description is too large");
    await expect(fs.access(path.join(stateDir, "skill-workshop"))).rejects.toThrow();

    const proposal = await proposeCreateSkill({
      workspaceDir,
      name: "Description Revision",
      description: "Short description",
      content: "# Description Revision\n",
    });
    await expect(
      reviseSkillProposal({
        workspaceDir,
        proposalId: proposal.record.id,
        description: "x".repeat(161),
        content: "# Description Revision\n",
      }),
    ).rejects.toThrow("proposal description is too large");

    const longDescriptionWorkspace = await makeWorkspace();
    const longDescriptionSkillDir = await createOwnedSkill({
      workspaceDir: longDescriptionWorkspace,
      name: "long-description-skill",
      description: "Initial description",
      body: "# Long Description Skill\n\nExisting body.\n",
    });
    await fs.writeFile(
      path.join(longDescriptionSkillDir, "SKILL.md"),
      `---\nname: long-description-skill\ndescription: ${"x".repeat(433)}\n---\n\n# Long Description Skill\n\nExisting body.\n`,
      "utf8",
    );

    const updateWithDerivedDescription = await proposeUpdateSkill({
      workspaceDir: longDescriptionWorkspace,
      skillName: "long-description-skill",
      content: "# Long Description Skill\n\nUpdated body.\n",
    });
    expect(
      Buffer.byteLength(updateWithDerivedDescription.record.description, "utf8"),
    ).toBeLessThanOrEqual(160);

    const updateWithSuppliedDescription = await proposeUpdateSkill({
      workspaceDir: longDescriptionWorkspace,
      skillName: "long-description-skill",
      description: "Short update description",
      content: "# Long Description Skill\n\nSecond updated body.\n",
    });
    expect(updateWithSuppliedDescription.record.description).toBe("Short update description");
    await expect(
      proposeUpdateSkill({
        workspaceDir: longDescriptionWorkspace,
        skillName: "long-description-skill",
        description: "x".repeat(161),
        content: "# Long Description Skill\n\nThird updated body.\n",
      }),
    ).rejects.toThrow("proposal description is too large");
  });

  it("quarantines unsafe proposals during apply", async () => {
    const workspaceDir = await makeWorkspace();
    const proposal = await proposeCreateSkill({
      workspaceDir,
      name: "Unsafe Skill",
      description: "Unsafe draft",
      content: "# Unsafe\n\n```ts\nimport { exec } from 'child_process';\nexec('whoami');\n```\n",
    });

    expect(proposal.record.scan.state).toBe("failed");
    await expect(
      applySkillProposal({ workspaceDir, proposalId: proposal.record.id }),
    ).rejects.toThrow("Proposal scan failed");
    expect((await inspectSkillProposal(proposal.record.id))?.record.status).toBe("quarantined");
  });

  it.each([
    "skill name",
    "description",
    "content",
    "support file",
    "support path",
    "goal",
    "evidence",
  ])(
    "rejects a recognized literal credential in %s before writing proposal state",
    async (surface) => {
      const workspaceDir = await makeWorkspace();
      const sample = `sk-proj-${"a".repeat(32)}`;
      const input = {
        workspaceDir,
        name: surface === "skill name" ? sample : "Credential Safety",
        description: surface === "description" ? sample : "Keep credentials out of skill proposals",
        content: surface === "content" ? `# Unsafe\n\n${sample}\n` : "# Safe content\n",
        ...(surface === "support file"
          ? { supportFiles: [{ path: "references/example.md", content: sample }] }
          : {}),
        ...(surface === "support path"
          ? { supportFiles: [{ path: `references/${sample}.md`, content: "Safe support.\n" }] }
          : {}),
        ...(surface === "goal" ? { goal: sample } : {}),
        ...(surface === "evidence" ? { evidence: sample } : {}),
      };

      await expect(proposeCreateSkill(input)).rejects.toThrow(
        "contains a recognized literal credential",
      );
      expect((await listSkillProposals()).proposals).toHaveLength(0);
    },
  );

  it("rejects literal credentials before update or revision writes", async () => {
    const workspaceDir = await makeWorkspace();
    const sample = `github_pat_${"a".repeat(32)}`;
    await createOwnedSkill({
      workspaceDir,
      name: "safe-skill",
      description: "A writable workspace skill",
      body: "# Safe Skill\n\nOriginal body.\n",
    });

    await expect(
      proposeUpdateSkill({
        workspaceDir,
        skillName: "safe-skill",
        description: sample,
        content: "# Safe Update\n\nNo credentials.\n",
      }),
    ).rejects.toThrow("contains a recognized literal credential");
    expect((await listSkillProposals()).proposals).toHaveLength(1);

    const proposal = await proposeCreateSkill({
      workspaceDir,
      name: "Safe Revision",
      description: "A safe pending proposal",
      content: "# Safe Revision\n\nOriginal proposal.\n",
    });
    await expect(
      reviseSkillProposal({
        workspaceDir,
        proposalId: proposal.record.id,
        description: sample,
        content: "# Safe Revision\n\nNo credentials.\n",
      }),
    ).rejects.toThrow("contains a recognized literal credential");
    const unchanged = await inspectSkillProposal(proposal.record.id);
    expect(unchanged?.record.proposedVersion).toBe("v1");
    expect(unchanged?.content).toContain("Original proposal.");
    expect(unchanged?.content).not.toContain(sample);
  });

  it("rejects unsafe support paths before creating proposal state", async () => {
    const workspaceDir = await makeWorkspace();

    await expect(
      proposeCreateSkill({
        workspaceDir,
        name: "Unsafe Support Path",
        description: "Reject traversal",
        content: "# Unsafe Support Path\n",
        supportFiles: [
          {
            path: "scripts/../references/escape.md",
            content: "bad\n",
          },
        ],
      }),
    ).rejects.toThrow("plain relative path segments");
    await expect(
      proposeCreateSkill({
        workspaceDir,
        name: "Conflicting Support Path",
        description: "Reject path conflicts",
        content: "# Conflicting Support Path\n",
        supportFiles: [
          {
            path: "references",
            content: "bad\n",
          },
          {
            path: "references/guide.md",
            content: "bad\n",
          },
        ],
      }),
    ).rejects.toThrow("below an allowed support directory");
    await expect(
      proposeCreateSkill({
        workspaceDir,
        name: "Nested Support Path",
        description: "Reject nested file conflicts",
        content: "# Nested Support Path\n",
        supportFiles: [
          {
            path: "references/guide",
            content: "bad\n",
          },
          {
            path: "references/guide/notes.md",
            content: "bad\n",
          },
        ],
      }),
    ).rejects.toThrow("cannot overlap");

    await expect(fs.access(path.join(stateDir, "skill-workshop"))).rejects.toThrow();
  });

  it("rejects non-text and executable proposal directory support files", async () => {
    const draftDir = path.join(await makeWorkspace(), "draft");
    await fs.mkdir(path.join(draftDir, "assets"), { recursive: true });
    await fs.writeFile(path.join(draftDir, "PROPOSAL.md"), "# Binary Asset\n", "utf8");
    await fs.writeFile(path.join(draftDir, "assets", "icon.png"), Buffer.from([0x89, 0x50]));

    await expect(readSkillProposalDraftDirectory(draftDir)).rejects.toThrow(
      "Proposal files must be UTF-8 text",
    );

    await fs.rm(path.join(draftDir, "assets", "icon.png"));
    await fs.mkdir(path.join(draftDir, "scripts"), { recursive: true });
    const scriptPath = path.join(draftDir, "scripts", "run.sh");
    await fs.writeFile(scriptPath, "#!/bin/sh\necho ok\n", "utf8");
    await fs.chmod(scriptPath, 0o755);

    await expect(readSkillProposalDraftDirectory(draftDir)).rejects.toThrow(
      "Proposal support files must not be executable",
    );
  });

  it("quarantines proposals with unsafe support file contents during apply", async () => {
    const workspaceDir = await makeWorkspace();
    const proposal = await proposeCreateSkill({
      workspaceDir,
      name: "Unsafe Support",
      description: "Unsafe support script",
      content: "# Unsafe Support\n",
      supportFiles: [
        {
          path: "scripts/run.js",
          content: "eval('2 + 2');\n",
        },
      ],
    });

    expect(proposal.record.scan.state).toBe("failed");
    await expect(
      applySkillProposal({ workspaceDir, proposalId: proposal.record.id }),
    ).rejects.toThrow("Proposal scan failed");
    expect((await inspectSkillProposal(proposal.record.id))?.record.status).toBe("quarantined");
    await expect(
      fs.access(path.join(workshopSkillsDir(), "unsafe-support", "scripts", "run.js")),
    ).rejects.toThrow();
  });

  it("rejects tampered support files during apply", async () => {
    const workspaceDir = await makeWorkspace();
    const proposal = await proposeCreateSkill({
      workspaceDir,
      name: "Tamper Guard",
      description: "Detect changed proposal support files",
      content: "# Tamper Guard\n",
      supportFiles: [
        {
          path: "references/check.md",
          content: "Original\n",
        },
      ],
    });
    await fs.writeFile(
      path.join(
        stateDir,
        "skill-workshop",
        "proposals",
        proposal.record.id,
        path.dirname(proposal.record.draftFile),
        "references",
        "check.md",
      ),
      "Changed\n",
      "utf8",
    );

    await expect(
      applySkillProposal({ workspaceDir, proposalId: proposal.record.id }),
    ).rejects.toThrow("changed without updating metadata");
    await expect(
      fs.access(path.join(workshopSkillsDir(), "tamper-guard", "SKILL.md")),
    ).rejects.toThrow();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

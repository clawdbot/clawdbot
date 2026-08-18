import path from "node:path";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PreparedWorkspaceSkillMutation } from "../lifecycle/workspace-skill-write.js";
import type {
  SkillCollectionPlanEntry,
  WritableSkillCollectionEntry,
} from "./collection-contracts.js";
import { stripProposalFrontmatterForSkill } from "./frontmatter.js";
import { createSkillProposalEvent, dispatchSkillProposalChanged } from "./plugin-hooks.js";
import { proposeCreateSkill } from "./service.js";
import { writeSkillProposalRollback } from "./store-sqlite-rollback.js";
import { commitPendingSkillProposalTransition } from "./store-sqlite-transition.js";
import {
  SKILL_WORKSHOP_ROLLBACK_SCHEMA,
  type SkillProposalReadResult,
  type SkillProposalRecord,
} from "./types.js";

export async function prepareCollectionCreateProposals(params: {
  workspaceDir: string;
  current: readonly WritableSkillCollectionEntry[];
  plan: readonly SkillCollectionPlanEntry[];
  prepared: readonly PreparedWorkspaceSkillMutation[];
  config?: OpenClawConfig;
  agentId?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<Map<string, SkillProposalReadResult>> {
  const currentNames = new Set(params.current.map((skill) => skill.name));
  const entries = new Map(
    params.plan
      .filter(
        (entry): entry is Extract<SkillCollectionPlanEntry, { action: "write" }> =>
          entry.action === "write" && !currentNames.has(entry.name),
      )
      .map((entry) => [entry.name, entry]),
  );
  const proposals = new Map<string, SkillProposalReadResult>();
  for (const mutation of params.prepared) {
    if (mutation.mode !== "create") {
      continue;
    }
    const entry = entries.get(path.basename(mutation.skillDir));
    if (!entry) {
      throw new Error(`Missing collection create decision for ${mutation.skillDir}.`);
    }
    const proposal = await proposeCreateSkill({
      workspaceDir: params.workspaceDir,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      ...(params.config ? { config: params.config } : {}),
      ...(params.env ? { env: params.env } : {}),
      eventActor: { type: "system", id: "skill-collection-review" },
      name: entry.name,
      description: entry.description,
      content: entry.content,
      createdBy: "skill-workshop",
      autonomousCapture: true,
    });
    if (stripProposalFrontmatterForSkill(proposal.content) !== mutation.skillFile.content) {
      throw new Error(`Collection create proposal changed prepared content: ${entry.name}`);
    }
    proposals.set(mutation.skillFile.filePath, proposal);
  }
  return proposals;
}

export async function promoteCollectionCreateProposal(params: {
  proposal: SkillProposalReadResult;
  workspaceDir: string;
  env?: NodeJS.ProcessEnv;
}): Promise<SkillProposalRecord> {
  const { record } = params.proposal;
  const now = new Date().toISOString();
  await writeSkillProposalRollback({
    proposalId: record.id,
    rollback: {
      schema: SKILL_WORKSHOP_ROLLBACK_SCHEMA,
      proposalId: record.id,
      writtenAt: now,
      targetSkillFile: record.target.skillFile,
      action: "create",
    },
    store: params.env ? { env: params.env } : {},
  });
  const applied: SkillProposalRecord = {
    ...record,
    status: "applied",
    updatedAt: now,
    appliedAt: now,
    statusReason: "Applied by automatic skill collection review.",
  };
  const event = createSkillProposalEvent({
    record: applied,
    type: "applied",
    actor: { type: "system", id: "skill-collection-review" },
    occurredAt: now,
    payload: { targetSkillFile: record.target.skillFile },
  });
  const commit = commitPendingSkillProposalTransition({
    expected: record,
    record: applied,
    event,
    store: params.env ? { env: params.env } : {},
    operationLabel: "skill-collection.proposal.apply",
  });
  if (commit.state !== "committed") {
    throw new Error(`Collection create proposal changed before apply: ${record.id}`);
  }
  if (commit.event) {
    await dispatchSkillProposalChanged({
      event: commit.event,
      record: applied,
      workspaceDir: params.workspaceDir,
      ...(record.origin?.agentId ? { agentId: record.origin.agentId } : {}),
    });
  }
  return applied;
}

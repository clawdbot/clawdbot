import { expectDefined } from "@openclaw/normalization-core";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isPathInside } from "../../infra/path-guards.js";
import { normalizeSkillIndexName } from "../discovery/skill-index.js";
import {
  assertInsideSkillsRoot,
  readWorkspaceSkillFile,
} from "../lifecycle/workspace-skill-write.js";
import { transitionPendingSkillProposalToStale } from "./apply-transition.js";
import { resolveSkillProposalName } from "./frontmatter.js";
import { dispatchSkillProposalChanged } from "./plugin-hooks.js";
import { resolveWorkshopSkillsDir } from "./skills-root.js";
import {
  SkillProposalDraftMissingError,
  readSkillProposal,
  readSkillProposalDraft,
  readSkillProposalManifest,
  readSkillProposalRecord,
  readSkillProposalRollback,
} from "./store.js";
import { withSkillProposalCommitLock } from "./target-lock.js";
import type {
  SkillProposalManifest,
  SkillProposalReadResult,
  SkillProposalRecord,
} from "./types.js";

type SkillProposalScopeOptions = {
  agentId: string;
  env?: NodeJS.ProcessEnv;
  config: OpenClawConfig;
};

type RequiredProposalReadOptions = {
  config: OpenClawConfig;
  reconcile?: boolean;
};

export async function listSkillProposals(
  options: SkillProposalScopeOptions,
): Promise<SkillProposalManifest> {
  const manifest = await readSkillProposalManifest(options, options);
  const missingDrafts = new Set<string>();
  // The agent collection lease bounds concurrent manifest reconciliation.
  for (const proposal of manifest.proposals) {
    if (proposal.status !== "pending") {
      continue;
    }
    try {
      const record = await readSkillProposalRecord(proposal.id, options, options, {
        config: options.config,
      });
      if (record) {
        await reconcilePendingSkillProposal(record, options);
      }
    } catch (error) {
      if (!(error instanceof SkillProposalDraftMissingError)) {
        throw error;
      }
      missingDrafts.add(error.proposalId);
    }
  }
  const reconciled = await readSkillProposalManifest(options, options);
  // Freshly read manifest rows are locally owned; mark degraded entries in place.
  for (const proposal of reconciled.proposals) {
    if (missingDrafts.has(proposal.id)) {
      proposal.degradedState = "draft-missing";
    }
  }
  return reconciled;
}

export async function getSkillProposalRunProgress(
  options: SkillProposalScopeOptions & { runId: string },
): Promise<{ mutationCount: number; proposalIds: string[] }> {
  const manifest = await readSkillProposalManifest(options, options);
  const ids: string[] = [];
  let mutationCount = 0;
  for (const proposal of manifest.proposals) {
    const record = await readSkillProposalRecord(proposal.id, options, options, {
      config: options.config,
    });
    if (!record) {
      continue;
    }
    if (record.origin?.runId === options.runId || record.originRunIds?.includes(options.runId)) {
      ids.push(record.id);
      mutationCount += record.originRunMutationCounts?.[options.runId] ?? 1;
    }
  }
  return { mutationCount, proposalIds: ids };
}

export async function inspectSkillProposal(
  proposalId: string,
  options: SkillProposalScopeOptions,
): Promise<SkillProposalReadResult | null> {
  const record = await readSkillProposalRecord(proposalId, options, options, {
    config: options.config,
  });
  if (!record) {
    return null;
  }
  await reconcilePendingSkillProposal(record, options);
  return await readSkillProposal(proposalId, options, options, { config: options.config });
}

export async function resolvePendingSkillProposal(input: {
  agentId: string;
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  proposalId?: string;
  name?: string;
  workspaceDir?: string;
}): Promise<SkillProposalReadResult> {
  let proposalId = normalizeOptionalString(input.proposalId);
  if (!proposalId) {
    const name = normalizeOptionalString(input.name);
    if (!name) {
      throw new Error("proposal_id or name required.");
    }
    const manifest = await listSkillProposals({
      agentId: input.agentId,
      env: input.env,
      config: input.config,
    });
    const matches = manifest.proposals.filter(
      (proposal) => proposal.status === "pending" && proposalMatchesName(proposal, name),
    );
    if (matches.length === 0) {
      throw new Error(`No pending skill proposal matched: ${name}`);
    }
    if (matches.length > 1) {
      const candidates = matches
        .slice(0, 8)
        .map((proposal) => `${proposal.id} (${resolveSkillProposalName(proposal.kind, proposal)})`)
        .join(", ");
      throw new Error(`Multiple pending skill proposals matched ${name}: ${candidates}`);
    }
    proposalId = expectDefined(matches[0], "matches capture group 0").id;
  }
  const matched = await inspectSkillProposal(proposalId, input);
  if (!matched) {
    throw new Error(`Skill proposal not found: ${proposalId}`);
  }
  if (matched.record.status !== "pending") {
    throw new Error(
      `Only pending proposals can be revised. Current status: ${matched.record.status}.`,
    );
  }
  return matched;
}

export async function readRequiredProposal(
  proposalId: string,
  env: NodeJS.ProcessEnv | undefined,
  agentId: string | undefined,
  readOptions: RequiredProposalReadOptions,
): Promise<SkillProposalReadResult> {
  const read = await readSkillProposal(
    proposalId,
    { env, agentId, config: readOptions.config },
    { agentId },
    readOptions,
  );
  if (!read) {
    throw new Error(`Skill proposal not found: ${proposalId}`);
  }
  return read;
}

async function reconcilePendingSkillProposal(
  record: SkillProposalRecord,
  options: SkillProposalScopeOptions,
): Promise<void> {
  if (record.status !== "pending") {
    return;
  }
  const workshopDir = resolveWorkshopSkillsDir(options.config, options.agentId, options.env);
  const transition = await withSkillProposalCommitLock(
    record,
    async () => {
      const current = await readSkillProposalRecord(record.id, options, options, {
        config: options.config,
        reconcile: false,
      });
      if (!current || current.status !== "pending") {
        return;
      }
      // List availability depends on the draft, not supporting-file integrity.
      // Read under the lease so revision cleanup cannot remove this generation.
      await readSkillProposalDraft(current, options);
      // Deferred proposals remain readable without access to their old targets.
      // Collision reconciliation only operates inside the owned Workshop root.
      if (
        current.kind !== "create" ||
        !isPathInside(workshopDir, current.target.skillFile) ||
        (await readSkillProposalRollback(current.id, options))
      ) {
        return;
      }
      assertInsideSkillsRoot(workshopDir, current.target.skillFile, "skill file");
      const targetContent = await readWorkspaceSkillFile(current.target.skillFile);
      if (targetContent === null) {
        return;
      }
      return transitionPendingSkillProposalToStale({
        record: current,
        reason: "Target skill was created after proposal creation.",
        input: {
          agentId: options.agentId,
          config: options.config,
          eventActor: { type: "system" },
          ...(options.env ? { env: options.env } : {}),
        },
      });
    },
    options,
  );
  if (transition) {
    await dispatchSkillProposalChanged({
      event: transition.event,
      record: transition.record,
      workspaceDir: workshopDir,
      agentId: options.agentId,
    });
  }
}

function proposalMatchesName(
  proposal: SkillProposalManifest["proposals"][number],
  name: string,
): boolean {
  const normalizedName = normalizeSkillIndexName(name);
  const candidates = [
    proposal.id,
    proposal.skillName,
    proposal.skillKey,
    proposal.title,
    proposal.description,
  ];
  return candidates.some((candidate) => {
    if (!candidate) {
      return false;
    }
    if (candidate === name || candidate.toLowerCase() === name.toLowerCase()) {
      return true;
    }
    const normalizedCandidate = normalizeSkillIndexName(candidate);
    return Boolean(
      normalizedName &&
      normalizedCandidate &&
      (normalizedCandidate === normalizedName ||
        normalizedCandidate.includes(normalizedName) ||
        normalizedName.includes(normalizedCandidate)),
    );
  });
}

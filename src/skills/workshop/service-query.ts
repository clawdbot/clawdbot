import { expectDefined } from "@openclaw/normalization-core";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeSkillIndexName } from "../discovery/skill-index.js";
import {
  assertInsideSkillsRoot,
  readWorkspaceSkillFile,
} from "../lifecycle/workspace-skill-write.js";
import { transitionPendingSkillProposalToStale } from "./apply-transition.js";
import { resolveSkillProposalName } from "./frontmatter.js";
import { dispatchSkillProposalChanged } from "./plugin-hooks.js";
import { hashSkillProposalRevision } from "./revision-hash.js";
import { resolveWorkshopSkillsDir } from "./skills-root.js";
import {
  SkillProposalDraftMissingError,
  readSkillProposal,
  readSkillProposalManifest,
  readSkillProposalRecord,
  readSkillProposalRollback,
} from "./store.js";
import { withSkillProposalCommitLock } from "./target-lock.js";
import type { SkillProposalManifest, SkillProposalReadResult } from "./types.js";

type SkillProposalScopeOptions = {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  config: OpenClawConfig;
};

type RequiredProposalReadOptions = {
  config: OpenClawConfig;
  reconcile?: boolean;
};

function storeOptions(
  env: NodeJS.ProcessEnv | undefined,
  agentId: string | undefined,
  config: OpenClawConfig,
) {
  return {
    ...(env ? { env } : {}),
    ...(agentId ? { agentId } : {}),
    config,
  };
}

function workshopSkillsDir(options: SkillProposalScopeOptions): string {
  if (!options.agentId) {
    throw new Error("Skill Workshop requires the active agent id.");
  }
  return resolveWorkshopSkillsDir(options.config, options.agentId, options.env);
}

function proposalScope(options: SkillProposalScopeOptions) {
  return options.agentId ? { agentId: options.agentId } : {};
}

export async function listSkillProposals(
  options: SkillProposalScopeOptions,
): Promise<SkillProposalManifest> {
  const store = storeOptions(options.env, options.agentId, options.config);
  const scope = proposalScope(options);
  const manifest = await readSkillProposalManifest(store, scope);
  const missingDrafts = new Set<string>();
  // The agent collection lease bounds concurrent manifest reconciliation.
  for (const proposal of manifest.proposals) {
    if (proposal.kind !== "create" || proposal.status !== "pending") {
      continue;
    }
    let read: SkillProposalReadResult | null;
    try {
      read = await readSkillProposal(proposal.id, store, scope, { config: options.config });
    } catch (error) {
      if (!(error instanceof SkillProposalDraftMissingError)) {
        throw error;
      }
      missingDrafts.add(error.proposalId);
      continue;
    }
    if (read) {
      await reconcilePendingCreateProposal(read, options);
    }
  }
  const reconciled = await readSkillProposalManifest(store, scope);
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
  const store = storeOptions(options.env, options.agentId, options.config);
  const manifest = await readSkillProposalManifest(store, options);
  const ids: string[] = [];
  let mutationCount = 0;
  for (const proposal of manifest.proposals) {
    const record = await readSkillProposalRecord(proposal.id, store, options, {
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
  const read = await readSkillProposal(
    proposalId,
    storeOptions(options.env, options.agentId, options.config),
    proposalScope(options),
    { config: options.config },
  );
  if (!read) {
    return null;
  }
  return await reconcilePendingCreateProposal(read, options);
}

export async function resolvePendingSkillProposal(input: {
  agentId?: string;
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  proposalId?: string;
  name?: string;
  workspaceDir?: string;
}): Promise<SkillProposalReadResult> {
  const proposalId = normalizeOptionalString(input.proposalId);
  if (proposalId) {
    const direct = await reconcilePendingCreateProposal(
      await readRequiredProposal(proposalId, input.env, input.agentId, {
        config: input.config,
      }),
      { agentId: input.agentId, env: input.env, config: input.config },
    );
    if (direct.record.status !== "pending") {
      throw new Error(
        `Only pending proposals can be revised. Current status: ${direct.record.status}.`,
      );
    }
    return direct;
  }
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
  const matched = await reconcilePendingCreateProposal(
    await readRequiredProposal(
      expectDefined(matches[0], "matches capture group 0").id,
      input.env,
      input.agentId,
      { config: input.config },
    ),
    { agentId: input.agentId, env: input.env, config: input.config },
  );
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
    storeOptions(env, agentId, readOptions.config),
    agentId ? { agentId } : {},
    readOptions,
  );
  if (!read) {
    throw new Error(`Skill proposal not found: ${proposalId}`);
  }
  return read;
}

async function reconcilePendingCreateProposal(
  read: SkillProposalReadResult,
  options: SkillProposalScopeOptions,
): Promise<SkillProposalReadResult> {
  if (read.record.kind !== "create" || read.record.status !== "pending") {
    return read;
  }
  const workshopDir = workshopSkillsDir(options);
  const store = storeOptions(options.env, options.agentId, options.config);
  const scope = proposalScope(options);
  const reconciled = await withSkillProposalCommitLock(
    read.record,
    async () => {
      const current = await readSkillProposal(read.record.id, store, scope, {
        config: options.config,
        reconcile: false,
      });
      if (!current || current.record.kind !== "create" || current.record.status !== "pending") {
        return { read: current ?? read };
      }
      assertInsideSkillsRoot(workshopDir, current.record.target.skillFile, "skill file");
      if (await readSkillProposalRollback(current.record.id, store)) {
        return { read: current };
      }
      const targetContent = await readWorkspaceSkillFile(current.record.target.skillFile);
      if (targetContent === null) {
        return { read: current };
      }
      const transition = transitionPendingSkillProposalToStale({
        record: current.record,
        reason: "Target skill was created after proposal creation.",
        input: {
          workspaceDir: workshopDir,
          ...(options.agentId ? { agentId: options.agentId } : {}),
          config: options.config,
          eventActor: { type: "system" },
          ...(options.env ? { env: options.env } : {}),
        },
      });
      return {
        read: {
          ...current,
          record: transition.record,
          revisionHash: hashSkillProposalRevision(transition.record),
        },
        transition,
      };
    },
    store,
  );
  if (reconciled.transition) {
    await dispatchSkillProposalChanged({
      event: reconciled.transition.event,
      record: reconciled.transition.record,
      workspaceDir: workshopDir,
      ...(options.agentId ? { agentId: options.agentId } : {}),
    });
  }
  return reconciled.read;
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

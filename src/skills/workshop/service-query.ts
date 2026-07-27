import { expectDefined } from "@openclaw/normalization-core";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeSkillIndexName } from "../discovery/skill-index.js";
import {
  readProposalSupportFiles,
  readSkillProposal,
  readSkillProposalManifest,
  readSkillProposalRecord,
} from "./store.js";
import type { SkillProposalManifest, SkillProposalReadResult } from "./types.js";

type SkillProposalScopeOptions = {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
};

function storeOptions(env?: NodeJS.ProcessEnv) {
  return env ? { env } : {};
}

export async function listSkillProposals(
  options: SkillProposalScopeOptions = {},
): Promise<SkillProposalManifest> {
  return await readSkillProposalManifest(storeOptions(options.env), {
    ...(options.agentId ? { agentId: options.agentId } : {}),
    ...(options.workspaceDir ? { workspaceDir: options.workspaceDir } : {}),
  });
}

export async function getSkillProposalRunProgress(
  options: SkillProposalScopeOptions & { runId: string },
): Promise<{ mutationCount: number; proposalIds: string[] }> {
  const store = storeOptions(options.env);
  const manifest = await readSkillProposalManifest(store, options);
  const ids: string[] = [];
  let mutationCount = 0;
  for (const proposal of manifest.proposals) {
    const record = await readSkillProposalRecord(proposal.id, store, options);
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
  options: SkillProposalScopeOptions = {},
): Promise<SkillProposalReadResult | null> {
  const read = await readSkillProposal(proposalId, storeOptions(options.env), options);
  if (!read) {
    return null;
  }
  return await hydrateProposalSupportFiles(read, options.env);
}

export async function resolvePendingSkillProposal(input: {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  proposalId?: string;
  name?: string;
  workspaceDir?: string;
}): Promise<SkillProposalReadResult> {
  const proposalId = normalizeOptionalString(input.proposalId);
  if (proposalId) {
    const direct = await readRequiredProposal(
      proposalId,
      input.workspaceDir,
      input.env,
      input.agentId,
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
    workspaceDir: input.workspaceDir,
    env: input.env,
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
      .map((proposal) => `${proposal.id} (${proposal.skillKey})`)
      .join(", ");
    throw new Error(`Multiple pending skill proposals matched ${name}: ${candidates}`);
  }
  const matched = await readRequiredProposal(
    expectDefined(matches[0], "matches capture group 0").id,
    input.workspaceDir,
    input.env,
    input.agentId,
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
  workspaceDir?: string,
  env?: NodeJS.ProcessEnv,
  agentId?: string,
): Promise<SkillProposalReadResult> {
  const read = await readSkillProposal(proposalId, storeOptions(env), {
    ...(agentId ? { agentId } : {}),
    ...(workspaceDir ? { workspaceDir } : {}),
  });
  if (!read) {
    throw new Error(`Skill proposal not found: ${proposalId}`);
  }
  return read;
}

async function hydrateProposalSupportFiles(
  read: SkillProposalReadResult,
  env?: NodeJS.ProcessEnv,
): Promise<SkillProposalReadResult> {
  const supportFiles = await readProposalSupportFiles(read.record, storeOptions(env));
  return supportFiles.length === 0
    ? read
    : {
        ...read,
        supportFiles: supportFiles.map((file) => ({ path: file.path, content: file.content })),
      };
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

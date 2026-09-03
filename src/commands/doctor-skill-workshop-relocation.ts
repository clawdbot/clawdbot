import { listAgentIds } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { readWorkspaceSkillFile } from "../skills/lifecycle/workspace-skill-write.js";
import { resolveSkillManifestMetadata } from "../skills/loading/frontmatter.js";
import { readSkillFrontmatterSafe } from "../skills/loading/local-loader.js";
import { resolveSkillDiscoveryLimits } from "../skills/loading/skill-root-discovery.js";
import { stripProposalFrontmatterForSkill } from "../skills/workshop/frontmatter.js";
import { hashSkillProposalContent, readSkillProposal } from "../skills/workshop/store.js";
import type { SkillProposalRecord } from "../skills/workshop/types.js";
import { inferWorkspaceOwnerAgentId } from "./doctor-skill-workshop-collection-backups.js";

export type OwnerAgentInference = {
  ownerAgentId?: string;
  unconfiguredOwnerAgentId?: string;
};

export function inferOwnerAgentId(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  record: SkillProposalRecord;
  workspaceDir: string;
  rowOwnerAgentId?: string | null;
}): OwnerAgentInference {
  let ownerAgentId: string | undefined;
  if (params.rowOwnerAgentId) {
    ownerAgentId = normalizeAgentId(params.rowOwnerAgentId);
  } else if (params.record.origin?.agentId) {
    ownerAgentId = normalizeAgentId(params.record.origin.agentId);
  } else if (params.record.origin?.sessionKey) {
    const sessionAgentId = parseAgentSessionKey(params.record.origin.sessionKey)?.agentId;
    if (sessionAgentId) {
      ownerAgentId = normalizeAgentId(sessionAgentId);
    }
  }
  ownerAgentId ??= inferWorkspaceOwnerAgentId(params.config, params.env, params.workspaceDir);
  if (!ownerAgentId) {
    return {};
  }
  return listAgentIds(params.config).includes(ownerAgentId)
    ? { ownerAgentId }
    : { unconfiguredOwnerAgentId: ownerAgentId };
}

export async function verifyRelocationDestination(params: {
  record: SkillProposalRecord;
  destinationSkillDir: string;
  destinationSkillFile: string;
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): Promise<boolean> {
  const content = await readWorkspaceSkillFile(params.destinationSkillFile);
  const frontmatter = readSkillFrontmatterSafe({
    rootDir: params.destinationSkillDir,
    filePath: params.destinationSkillFile,
    maxBytes: resolveSkillDiscoveryLimits(params.config).maxSkillFileBytes,
  });
  const name = frontmatter?.name?.trim();
  const skillKey = frontmatter
    ? (resolveSkillManifestMetadata(frontmatter)?.skillKey ?? name)?.trim()
    : undefined;
  let appliedContentHash = params.record.draftHash;
  try {
    const proposal = await readSkillProposal(
      params.record.id,
      { config: params.config, env: params.env },
      {},
      { config: params.config, reconcile: false },
    );
    if (proposal) {
      appliedContentHash = hashSkillProposalContent(
        stripProposalFrontmatterForSkill(proposal.content),
      );
    }
  } catch {
    // Legacy SQLite rows can have no proposal bundle. Their only available
    // content fact is the stored hash, which older migration fixtures used for
    // the applied file bytes.
  }
  return (
    content !== null &&
    hashSkillProposalContent(content) === appliedContentHash &&
    name === params.record.target.skillKey &&
    skillKey === params.record.target.skillKey
  );
}

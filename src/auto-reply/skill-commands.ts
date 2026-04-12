import fs from "node:fs";
import {
  listAgentIds,
  resolveAgentSkillsFilter,
  resolveAgentWorkspaceDir,
} from "../agents/agent-scope.js";
import { canExecRequestNode } from "../agents/exec-defaults.js";
import { buildWorkspaceSkillCommandSpecs, type SkillCommandSpec } from "../agents/skills.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logVerbose } from "../globals.js";
import { getRemoteSkillEligibility } from "../infra/skills-remote.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "../shared/string-coerce.js";
import { listReservedChatSlashCommandNames } from "./skill-commands-base.js";
export {
  listReservedChatSlashCommandNames,
  resolveSkillCommandInvocation,
} from "./skill-commands-base.js";

export function listSkillCommandsForWorkspace(params: {
  workspaceDir: string;
  cfg: OpenClawConfig;
  agentId?: string;
  skillFilter?: string[];
}): SkillCommandSpec[] {
  return buildWorkspaceSkillCommandSpecs(params.workspaceDir, {
    config: params.cfg,
    agentId: params.agentId,
    skillFilter: params.skillFilter,
    eligibility: {
      remote: getRemoteSkillEligibility({
        advertiseExecNode: canExecRequestNode({
          cfg: params.cfg,
          agentId: params.agentId,
        }),
      }),
    },
    reservedNames: listReservedChatSlashCommandNames(),
  });
}

function dedupeBySkillName(commands: SkillCommandSpec[]): SkillCommandSpec[] {
  const seen = new Set<string>();
  const out: SkillCommandSpec[] = [];
  for (const cmd of commands) {
    const key = normalizeOptionalLowercaseString(cmd.skillName);
    if (key && seen.has(key)) {
      continue;
    }
    if (key) {
      seen.add(key);
    }
    out.push(cmd);
  }
  return out;
}

export function listSkillCommandsForAgents(params: {
  cfg: OpenClawConfig;
  agentIds?: string[];
}): SkillCommandSpec[] {
  const mergeSkillFilters = (existing?: string[], incoming?: string[]): string[] | undefined => {
    // undefined = no allowlist (unrestricted); [] = explicit empty allowlist (no skills).
    // If any agent is unrestricted for this workspace, keep command discovery unrestricted.
    if (existing === undefined || incoming === undefined) {
      return undefined;
    }
    // An empty allowlist contributes no skills but does not widen the merge to unrestricted.
    if (existing.length === 0) {
      return Array.from(new Set(incoming));
    }
    if (incoming.length === 0) {
      return Array.from(new Set(existing));
    }
    return Array.from(new Set([...existing, ...incoming]));
  };

  const agentIds = params.agentIds ?? listAgentIds(params.cfg);
  const used = listReservedChatSlashCommandNames();
  const entries: SkillCommandSpec[] = [];
  // Group by canonical workspace to avoid duplicate registration when multiple
  // agents share the same directory (#5717), while still honoring per-agent filters.
  const workspaceFilters = new Map<string, { workspaceDir: string; skillFilter?: string[] }>();
  for (const agentId of agentIds) {
    const workspaceDir = resolveAgentWorkspaceDir(params.cfg, agentId);
    if (!fs.existsSync(workspaceDir)) {
      logVerbose(`Skipping agent "${agentId}": workspace does not exist: ${workspaceDir}`);
      continue;
    }
    let canonicalDir: string;
    try {
      canonicalDir = fs.realpathSync(workspaceDir);
    } catch {
      logVerbose(`Skipping agent "${agentId}": cannot resolve workspace: ${workspaceDir}`);
      continue;
    }
    const skillFilter = resolveAgentSkillsFilter(params.cfg, agentId);
    const existing = workspaceFilters.get(canonicalDir);
    if (existing) {
      existing.skillFilter = mergeSkillFilters(existing.skillFilter, skillFilter);
      continue;
    }
    workspaceFilters.set(canonicalDir, {
      workspaceDir,
      skillFilter,
    });
  }

  for (const { workspaceDir, skillFilter } of workspaceFilters.values()) {
    const commands = buildWorkspaceSkillCommandSpecs(workspaceDir, {
      config: params.cfg,
      skillFilter,
      eligibility: {
        remote: getRemoteSkillEligibility({
          advertiseExecNode: canExecRequestNode({
            cfg: params.cfg,
          }),
        }),
      },
      reservedNames: used,
    });
    for (const command of commands) {
      used.add(normalizeLowercaseStringOrEmpty(command.name));
      entries.push(command);
    }
  }
  return dedupeBySkillName(entries);
}

export const __testing = {
  dedupeBySkillName,
};

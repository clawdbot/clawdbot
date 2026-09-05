// Skill chat command discovery loads chat commands contributed by active skills.
import fs from "node:fs";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "@openclaw/normalization-core/string-coerce";
import { listAgentIds, resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import {
  type ExecPolicyOverrides,
  type ExecSessionDefaults,
  resolveNodeExecEligibility,
} from "../../agents/exec-defaults.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { loadBundledSkillEntryByName } from "../loading/workspace-skill-loader.js";
import { getRemoteSkillEligibility } from "../runtime/remote.js";
import type { SkillCommandSpec } from "../types.js";
import { resolveEffectiveAgentSkillFilter } from "./agent-filter.js";
import { listReservedChatSlashCommandNames } from "./chat-command-invocation.js";
import { buildWorkspaceSkillCommandSpecs } from "./command-specs.js";
export {
  expandExplicitSkillReferences,
  hasSkillReferenceCandidate,
  listReservedChatSlashCommandNames,
  resolveSkillCommandInvocation,
} from "./chat-command-invocation.js";

export function listSkillCommandsForWorkspace(params: {
  workspaceDir: string;
  cfg: OpenClawConfig;
  agentId?: string;
  skillFilter?: string[];
  sessionEntry?: ExecSessionDefaults &
    Pick<SessionEntry, "skillLibrarySelections" | "skillsSnapshot">;
  sessionKey?: string;
  execOverrides?: ExecPolicyOverrides;
  includeAllowlistHidden?: boolean;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
}): SkillCommandSpec[] {
  const nodeSkills = resolveNodeExecEligibility({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionEntry: params.sessionEntry,
    sessionKey: params.sessionKey,
    execOverrides: params.execOverrides,
  });
  const eligibility = {
    nodeSkills,
    remote: getRemoteSkillEligibility({ advertiseExecNode: nodeSkills.canExec }),
  };
  return buildWorkspaceSkillCommandSpecs(params.workspaceDir, {
    config: params.cfg,
    agentId: params.agentId,
    skillFilter: params.skillFilter,
    includeAllowlistHidden: params.includeAllowlistHidden,
    eligibility,
    pluginMetadataSnapshot: params.pluginMetadataSnapshot,
    librarySelections: params.sessionEntry?.skillLibrarySelections,
    reservedNames: listReservedChatSlashCommandNames(),
  });
}

/** Resolves one eligible bundled skill before normal workspace precedence is applied. */
export function findBundledSkillCommandForWorkspace(params: {
  workspaceDir: string;
  cfg: OpenClawConfig;
  skillName: string;
  agentId?: string;
  skillFilter?: string[];
  sessionEntry?: ExecSessionDefaults & Pick<SessionEntry, "skillsSnapshot">;
  sessionKey?: string;
  execOverrides?: ExecPolicyOverrides;
}): SkillCommandSpec | undefined {
  const nodeSkills = resolveNodeExecEligibility({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionEntry: params.sessionEntry,
    sessionKey: params.sessionKey,
    execOverrides: params.execOverrides,
  });
  const eligibility = {
    nodeSkills,
    remote: getRemoteSkillEligibility({ advertiseExecNode: nodeSkills.canExec }),
  };
  const entry = loadBundledSkillEntryByName(params.skillName, {
    config: params.cfg,
    agentId: params.agentId,
    skillFilter: params.skillFilter,
    eligibility,
  });
  if (!entry) {
    return undefined;
  }
  return buildWorkspaceSkillCommandSpecs(params.workspaceDir, {
    config: params.cfg,
    agentId: params.agentId,
    skillFilter: params.skillFilter,
    eligibility,
    entries: [entry],
    reservedNames: listReservedChatSlashCommandNames(),
  }).find(
    (command) =>
      command.skillSource === "bundled" &&
      command.skillName.trim().toLowerCase() === params.skillName.trim().toLowerCase(),
  );
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
  sessionEntry?: ExecSessionDefaults &
    Pick<SessionEntry, "skillLibrarySelections" | "skillsSnapshot">;
  sessionKey?: string;
  execOverrides?: ExecPolicyOverrides;
}): SkillCommandSpec[] {
  const agentIds = params.agentIds ?? listAgentIds(params.cfg);
  const used = listReservedChatSlashCommandNames();
  const entries: SkillCommandSpec[] = [];
  const hasSingleAgentContext = agentIds.length === 1;
  const workspaceAgents: Array<{
    agentId: string;
    workspaceDir: string;
    skillFilter?: string[];
  }> = [];
  for (const agentId of agentIds) {
    const workspaceDir = resolveAgentWorkspaceDir(params.cfg, agentId);
    if (!fs.existsSync(workspaceDir)) {
      logVerbose(`Skipping agent "${agentId}": workspace does not exist: ${workspaceDir}`);
      continue;
    }
    try {
      fs.realpathSync(workspaceDir);
    } catch {
      logVerbose(`Skipping agent "${agentId}": cannot resolve workspace: ${workspaceDir}`);
      continue;
    }
    workspaceAgents.push({
      agentId,
      workspaceDir,
      skillFilter: resolveEffectiveAgentSkillFilter(params.cfg, agentId),
    });
  }

  for (const { agentId, workspaceDir, skillFilter } of workspaceAgents) {
    if (hasSingleAgentContext && params.sessionEntry?.skillLibrarySelections?.length) {
      entries.push(
        ...listSkillCommandsForWorkspace({ ...params, workspaceDir, agentId, skillFilter }),
      );
      continue;
    }
    const nodeSkills = resolveNodeExecEligibility({
      cfg: params.cfg,
      agentId,
      ...(hasSingleAgentContext
        ? {
            sessionEntry: params.sessionEntry,
            sessionKey: params.sessionKey,
            execOverrides: params.execOverrides,
          }
        : {}),
    });
    const commands = buildWorkspaceSkillCommandSpecs(workspaceDir, {
      config: params.cfg,
      agentId,
      skillFilter,
      eligibility: {
        nodeSkills,
        remote: getRemoteSkillEligibility({
          advertiseExecNode: nodeSkills.canExec,
        }),
      },
      reservedNames: used,
    });
    for (const command of commands) {
      used.add(normalizeLowercaseStringOrEmpty(command.name));
      entries.push(command);
    }
  }
  return dedupeBySkillName(entries).toSorted((left, right) =>
    left.skillName.localeCompare(right.skillName, "en"),
  );
}

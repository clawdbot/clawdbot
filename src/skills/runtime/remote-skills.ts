import type { NodeSkillDescriptor } from "../../../packages/gateway-protocol/src/schema/nodes.js";
import { createSyntheticSourceInfo } from "../../agents/sessions/source-info.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveNodeIdFromNodeList } from "../../shared/node-resolve.js";
import { parseFrontmatter, resolveSkillInvocationPolicy } from "../loading/frontmatter.js";
import { computeSkillPromptVersion } from "../loading/skill-version.js";
import type { ParsedSkillFrontmatter, SkillEntry } from "../types.js";
import { bumpSkillsSnapshotVersion } from "./refresh-state.js";

type PreparedNodeSkill = NodeSkillDescriptor & {
  frontmatter: ParsedSkillFrontmatter;
};

type RemoteSkillNode = {
  nodeId: string;
  connId?: string;
  displayName?: string;
  connected: boolean;
  canExec: boolean;
  skills: PreparedNodeSkill[];
};

const remoteSkillNodes = new Map<string, RemoteSkillNode>();
const log = createSubsystemLogger("gateway/skills-remote");

function prepareNodeSkills(
  nodeId: string,
  skills: readonly NodeSkillDescriptor[],
): PreparedNodeSkill[] {
  const prepared: PreparedNodeSkill[] = [];
  for (const skill of skills) {
    try {
      const frontmatter = parseFrontmatter(skill.content);
      if (
        frontmatter.name?.trim() !== skill.name ||
        frontmatter.description?.trim() !== skill.description
      ) {
        log.warn(`dropped node skill with mismatched frontmatter: ${nodeId}/${skill.name}`);
        continue;
      }
      prepared.push({ ...skill, frontmatter });
    } catch (error) {
      log.warn(
        `dropped node skill with invalid frontmatter: ${nodeId}/${skill.name}: ${String(error)}`,
      );
    }
  }
  return prepared;
}

function sameSkills(
  left: readonly PreparedNodeSkill[],
  right: readonly PreparedNodeSkill[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (skill, index) =>
        skill.name === right[index]?.name &&
        skill.description === right[index]?.description &&
        skill.content === right[index]?.content,
    )
  );
}

export function recordRemoteSkillNodeInfo(node: {
  nodeId: string;
  connId?: string;
  displayName?: string;
  commands?: string[];
}): void {
  const existing = remoteSkillNodes.get(node.nodeId);
  const connectionChanged = Boolean(node.connId && existing?.connId !== node.connId);
  const displayChanged = existing?.displayName !== node.displayName;
  const canExec = node.commands?.includes("system.run") ?? existing?.canExec ?? false;
  const executionChanged = existing?.canExec !== canExec;
  remoteSkillNodes.set(node.nodeId, {
    nodeId: node.nodeId,
    connId: node.connId ?? existing?.connId,
    displayName: node.displayName,
    connected: true,
    canExec,
    skills: connectionChanged ? [] : (existing?.skills ?? []),
  });
  if (
    (connectionChanged || displayChanged || executionChanged) &&
    (existing?.skills.length ?? 0) > 0
  ) {
    bumpSkillsSnapshotVersion({ reason: "remote-node" });
  }
}

export function replaceRemoteNodeSkills(params: {
  nodeId: string;
  displayName?: string;
  skills: readonly NodeSkillDescriptor[];
}): void {
  const nextSkills = prepareNodeSkills(params.nodeId, params.skills);
  const existing = remoteSkillNodes.get(params.nodeId);
  const changed =
    !existing?.connected ||
    existing.displayName !== params.displayName ||
    !sameSkills(existing.skills, nextSkills);
  remoteSkillNodes.set(params.nodeId, {
    nodeId: params.nodeId,
    connId: existing?.connId,
    displayName: params.displayName ?? existing?.displayName,
    connected: true,
    canExec: existing?.canExec ?? false,
    skills: nextSkills,
  });
  if (changed) {
    bumpSkillsSnapshotVersion({ reason: "remote-node" });
  }
}

export function removeRemoteNodeSkills(nodeId: string): void {
  const existing = remoteSkillNodes.get(nodeId);
  remoteSkillNodes.delete(nodeId);
  if (existing?.skills.length) {
    bumpSkillsSnapshotVersion({ reason: "remote-node" });
  }
}

function sanitizeSkillNameFragment(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24)
      .replace(/-+$/g, "") || "node"
  );
}

function prefixedSkillName(params: {
  nodeId: string;
  baseName: string;
  usedNames: Set<string>;
}): string | null {
  const prefix = `${sanitizeSkillNameFragment(params.nodeId)}-`;
  for (let index = 0; index < 100; index += 1) {
    const suffix = index === 0 ? "" : `-${index + 1}`;
    const availableBaseLength = Math.max(1, 64 - prefix.length - suffix.length);
    const base = params.baseName.slice(0, availableBaseLength).replace(/-+$/g, "") || "skill";
    const candidate = `${prefix}${base}${suffix}`;
    if (!params.usedNames.has(candidate)) {
      return candidate;
    }
  }
  return null;
}

function remoteSkillLocation(nodeId: string, name: string): string {
  return `node://${encodeURIComponent(nodeId)}/skills/${name}/SKILL.md`;
}

function locatorNote(node: RemoteSkillNode, skillName: string): string {
  const label = node.displayName?.trim() || node.nodeId;
  const cwd = remoteSkillLocation(node.nodeId, skillName).slice(0, -"/SKILL.md".length);
  return `Node-hosted on ${label} (${node.nodeId}). Read this SKILL.md with the normal read tool at its exact node:// location; do not use file_fetch, which only accepts approved absolute node paths. If read is unavailable, use exec host=node node=${node.nodeId} with workdir=${cwd} to run cat SKILL.md. Run referenced files and bins with the same exec target and workdir; the node host resolves that locator to the node-local skill directory.`;
}

export function mergeRemoteNodeSkillEntries(
  localEntries: readonly SkillEntry[],
  options?: { canExec?: boolean; node?: string },
): SkillEntry[] {
  if (options?.canExec !== true) {
    return [...localEntries];
  }
  const connectedNodes = [...remoteSkillNodes.values()].filter(
    (node) => node.connected && node.canExec,
  );
  let boundNodeId: string | undefined;
  if (options.node) {
    try {
      boundNodeId = resolveNodeIdFromNodeList(connectedNodes, options.node);
    } catch {
      return [...localEntries];
    }
  }
  const remote = connectedNodes
    .filter((node) => !boundNodeId || node.nodeId === boundNodeId)
    .flatMap((node) => node.skills.map((skill) => ({ node, skill })))
    .toSorted(
      (left, right) =>
        left.skill.name.localeCompare(right.skill.name, "en") ||
        left.node.nodeId.localeCompare(right.node.nodeId, "en"),
    );
  if (remote.length === 0) {
    return [...localEntries];
  }

  const remoteNameCounts = new Map<string, number>();
  for (const { skill } of remote) {
    remoteNameCounts.set(skill.name, (remoteNameCounts.get(skill.name) ?? 0) + 1);
  }
  const localNames = new Set(localEntries.map((entry) => entry.skill.name));
  const usedNames = new Set(localNames);
  const remoteEntries: SkillEntry[] = [];
  for (const { node, skill } of remote) {
    const hasCollision = usedNames.has(skill.name) || (remoteNameCounts.get(skill.name) ?? 0) > 1;
    const exposedName = hasCollision
      ? prefixedSkillName({ nodeId: node.nodeId, baseName: skill.name, usedNames })
      : skill.name;
    if (!exposedName || usedNames.has(exposedName)) {
      log.warn(`dropped node skill with unresolved name collision: ${node.nodeId}/${skill.name}`);
      continue;
    }
    usedNames.add(exposedName);
    const filePath = remoteSkillLocation(node.nodeId, skill.name);
    const invocation = resolveSkillInvocationPolicy(skill.frontmatter);
    remoteEntries.push({
      skill: {
        name: exposedName,
        description: skill.description,
        locationNote: locatorNote(node, skill.name),
        readContent: skill.content,
        filePath,
        baseDir: filePath.slice(0, -"/SKILL.md".length),
        promptVersion: computeSkillPromptVersion(skill.content),
        source: "openclaw-node",
        sourceInfo: createSyntheticSourceInfo(filePath, {
          source: "openclaw-node",
          scope: "temporary",
          origin: "top-level",
          baseDir: filePath.slice(0, -"/SKILL.md".length),
        }),
        disableModelInvocation: invocation.disableModelInvocation,
      },
      frontmatter: skill.frontmatter,
      // Node-hosted v1 uses connected node execution as its eligibility boundary.
      // Gateway-local OS, bin, env, and config probes do not apply to node-owned context.
      invocation,
      disableCommandDispatch: true,
      exposure: {
        includeInRuntimeRegistry: true,
        includeInAvailableSkillsPrompt: !invocation.disableModelInvocation,
        userInvocable: invocation.userInvocable,
      },
    });
  }
  return [...localEntries, ...remoteEntries].toSorted((left, right) =>
    left.skill.name.localeCompare(right.skill.name, "en"),
  );
}

function resetRemoteNodeSkillsForTests(): void {
  remoteSkillNodes.clear();
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.remoteNodeSkillsTestApi")] = {
    resetRemoteNodeSkillsForTests,
  };
}

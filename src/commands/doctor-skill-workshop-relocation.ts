import fs from "node:fs/promises";
import path from "node:path";
import { listAgentIds, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { assertWorkspaceStateMigrationReady } from "../agents/workspace-legacy-state.js";
import { resolveCanonicalWorkspacePath } from "../agents/workspace-state-identity.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isMissingPathError } from "../infra/errors.js";
import { pathExists } from "../infra/fs-safe.js";
import { isPathInside } from "../infra/path-guards.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { readWorkspaceSkillFile } from "../skills/lifecycle/workspace-skill-write.js";
import { resolveSkillManifestMetadata } from "../skills/loading/frontmatter.js";
import { readSkillFrontmatterSafe } from "../skills/loading/local-loader.js";
import { resolveSkillDiscoveryLimits } from "../skills/loading/skill-root-discovery.js";
import { stripProposalFrontmatterForSkill } from "../skills/workshop/frontmatter.js";
import { readSkillProposalTargetTreeSha256 } from "../skills/workshop/proposal-bundle.js";
import { resolveWorkshopSkillsDir } from "../skills/workshop/skills-root.js";
import {
  hashSkillProposalContent,
  readSkillProposal,
  resolveSkillProposalTarget,
} from "../skills/workshop/store.js";
import type { SkillProposalRecord } from "../skills/workshop/types.js";
import { inferWorkspaceOwnerAgentId } from "./doctor-skill-workshop-collection-backups.js";

const INVALID_LEGACY_SKILL_REASON =
  "Skill Workshop could not load the applied legacy skill; the path stays in place and the proposal is stale.";

type OwnerAgentInference = {
  ownerAgentId?: string;
  unconfiguredOwnerAgentId?: string;
};

export function resolveLegacyWorkshopWorkspaceDir(
  skillDir: string,
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const source = path.resolve(skillDir);
  const configured = listAgentIds(config)
    .flatMap((agentId) => {
      const workspaceDir = path.resolve(resolveAgentWorkspaceDir(config, agentId, env));
      return [workspaceDir, resolveCanonicalWorkspacePath(workspaceDir)];
    })
    .toSorted((left, right) => right.length - left.length)
    .find((workspaceDir) =>
      [path.join(workspaceDir, "skills"), path.join(workspaceDir, ".agents", "skills")].some(
        (skillsRoot) => isPathInside(skillsRoot, source),
      ),
    );
  if (configured) {
    return configured;
  }
  // A recorded owner can outlive its workspace configuration. Resolve the old
  // skill-root layout without treating nested skill folders as workspaces.
  for (let directory = path.dirname(source); directory !== path.dirname(directory);) {
    if (path.basename(directory) === "skills") {
      const parent = path.dirname(directory);
      return path.basename(parent) === ".agents" ? path.dirname(parent) : parent;
    }
    directory = path.dirname(directory);
  }
  return undefined;
}

export function inferOwnerAgentId(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  record: SkillProposalRecord;
  workspaceDir: string | undefined;
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
  if (!ownerAgentId && params.workspaceDir) {
    ownerAgentId = inferWorkspaceOwnerAgentId(params.config, params.env, params.workspaceDir);
  }
  if (!ownerAgentId) {
    return {};
  }
  return listAgentIds(params.config).includes(ownerAgentId)
    ? { ownerAgentId }
    : { unconfiguredOwnerAgentId: ownerAgentId };
}

async function verifyRelocationDestination(params: {
  record: SkillProposalRecord;
  observedContentHashes: ReadonlySet<string>;
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
  if (content === null || skillKey !== params.record.target.skillKey) {
    return false;
  }
  const contentHash = hashSkillProposalContent(content);
  return contentHash === appliedContentHash || params.observedContentHashes.has(contentHash);
}

function retargetWorkshopProposal(
  record: SkillProposalRecord,
  target: ReturnType<typeof resolveSkillProposalTarget>,
): SkillProposalRecord {
  return {
    ...record,
    target: {
      ...record.target,
      skillDir: target.skillDir,
      skillFile: target.skillFile,
      source: "openclaw-workshop",
    },
    updatedAt: new Date().toISOString(),
  };
}

function staleWorkshopProposal(record: SkillProposalRecord, reason: string): SkillProposalRecord {
  const now = new Date().toISOString();
  return {
    ...record,
    status: "stale",
    updatedAt: now,
    staleAt: now,
    statusReason: reason,
  };
}

export type LegacyWorkshopProposal = {
  record: SkillProposalRecord;
  ownerAgentId: string | null;
};

export type WorkshopProposalUpdate = {
  record: SkillProposalRecord;
  ownerAgentId?: string;
};

type WorkshopRelocationPlan = {
  entry: LegacyWorkshopProposal;
  source: string;
  workspaceDir: string | undefined;
  ownerAgentId?: string;
  unconfiguredOwnerAgentId?: string;
  moveKey?: string;
  staleReason?: string;
};

type WorkshopMove = {
  source: string;
  workspaceDir: string;
  destination: string;
  operation: "move" | "remove-source" | "adopt";
  updates: WorkshopProposalUpdate[];
};

export async function planWorkshopRelocation(
  records: LegacyWorkshopProposal[],
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): Promise<{
  moves: WorkshopMove[];
  updates: WorkshopProposalUpdate[];
  externalProposalCount: number;
  externalProposalCountsByAgent: Record<string, number>;
  warnings: string[];
}> {
  const external = records.flatMap<WorkshopRelocationPlan>((entry) => {
    // Completed updates are history; only applied creates still claim a live skill.
    if (
      entry.record.status !== "pending" &&
      !(entry.record.status === "applied" && entry.record.kind === "create")
    ) {
      return [];
    }
    const source = path.resolve(entry.record.target.skillDir);
    const workspaceDir = resolveLegacyWorkshopWorkspaceDir(source, config, env);
    const owner = inferOwnerAgentId({
      config,
      env,
      record: entry.record,
      workspaceDir,
      rowOwnerAgentId: entry.ownerAgentId,
    });
    if (
      owner.ownerAgentId &&
      entry.ownerAgentId &&
      isPathInside(path.resolve(resolveWorkshopSkillsDir(config, owner.ownerAgentId, env)), source)
    ) {
      return [];
    }
    return [
      {
        entry,
        source,
        workspaceDir,
        ...(owner.ownerAgentId ? { ownerAgentId: owner.ownerAgentId } : {}),
        ...(owner.unconfiguredOwnerAgentId
          ? { unconfiguredOwnerAgentId: owner.unconfiguredOwnerAgentId }
          : {}),
        ...(owner.unconfiguredOwnerAgentId
          ? {
              staleReason: `Skill Workshop could not use unconfigured owning agent "${owner.unconfiguredOwnerAgentId}"; the legacy path stays in place and the proposal is stale.`,
            }
          : {}),
      },
    ];
  });
  const warnings: string[] = [];
  const deferredWorkspaces = new Set<string>();
  for (const workspaceDir of new Set(external.map((plan) => plan.workspaceDir))) {
    if (!workspaceDir) {
      continue;
    }
    try {
      assertWorkspaceStateMigrationReady({ workspaceDirs: [workspaceDir], env });
    } catch (error) {
      // Doctor owns legacy-file import. Leave every proposal for this workspace
      // unchanged until that import and its source cleanup have both finished.
      deferredWorkspaces.add(workspaceDir);
      warnings.push(String(error));
    }
  }
  const ready = external.filter(
    (plan) => !plan.workspaceDir || !deferredWorkspaces.has(plan.workspaceDir),
  );
  const movesByKey = new Map<string, WorkshopMove>();
  for (const plan of ready) {
    const { entry } = plan;
    const record = entry.record;
    if (!plan.ownerAgentId) {
      plan.staleReason ??=
        "Skill Workshop could not identify one owning agent; the legacy path stays in place and the proposal is stale.";
      continue;
    }
    if (record.kind !== "create" || record.status !== "applied") {
      continue;
    }
    if (!plan.workspaceDir) {
      plan.staleReason =
        "Skill Workshop could not identify the legacy workspace; the path stays in place and the proposal is stale.";
      continue;
    }
    const target = resolveSkillProposalTarget({
      skillName: record.target.skillKey,
      config,
      agentId: plan.ownerAgentId,
      env,
    });
    const moveKey = `${plan.source}\0${target.skillDir}`;
    plan.moveKey = moveKey;
    if (movesByKey.has(moveKey)) {
      continue;
    }
    let sourceStat: Awaited<ReturnType<typeof fs.lstat>> | undefined;
    try {
      // The workspace itself may be an alias. Below that root, inspect every
      // component before choosing either a move or copied-source removal.
      let directory = plan.workspaceDir;
      for (const segment of path.relative(plan.workspaceDir, plan.source).split(path.sep)) {
        directory = path.join(directory, segment);
        sourceStat = await fs.lstat(directory);
        if (sourceStat.isSymbolicLink()) {
          break;
        }
      }
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
      sourceStat = undefined;
    }
    if (sourceStat?.isSymbolicLink()) {
      plan.staleReason = `Skill Workshop no longer writes through symlinked skills; ${plan.source} stays a workspace skill.`;
      continue;
    }
    if (!sourceStat) {
      // The move is durable before metadata persistence; on rerun, adopt only its verified destination.
      if (await pathExists(target.skillFile)) {
        // Pending updates bind the live bytes they read, including earlier
        // applied improvements that no longer match the original create.
        const observedContentHashes = new Set(
          ready.flatMap((update) => {
            const updateTarget = update.entry.record.target;
            return update.ownerAgentId === plan.ownerAgentId &&
              update.source === plan.source &&
              update.entry.record.kind === "update" &&
              update.entry.record.status === "pending" &&
              updateTarget.skillKey === record.target.skillKey &&
              path.resolve(updateTarget.skillFile) === path.resolve(record.target.skillFile) &&
              updateTarget.currentContentHash
              ? [updateTarget.currentContentHash]
              : [];
          }),
        );
        if (
          !(await verifyRelocationDestination({
            record,
            observedContentHashes,
            destinationSkillDir: target.skillDir,
            destinationSkillFile: target.skillFile,
            config,
            env,
          }))
        ) {
          plan.staleReason =
            "Skill Workshop could not adopt the relocated skill: destination identity mismatch (content hash or frontmatter name/key); the proposal is stale.";
          continue;
        }
        movesByKey.set(moveKey, {
          source: plan.source,
          workspaceDir: plan.workspaceDir,
          destination: target.skillDir,
          operation: "adopt",
          updates: [],
        });
      } else {
        plan.staleReason =
          "Skill Workshop could not find the applied legacy skill; the proposal is stale.";
      }
      continue;
    }
    const frontmatter = readSkillFrontmatterSafe({
      rootDir: plan.source,
      filePath: path.join(plan.source, "SKILL.md"),
      maxBytes: resolveSkillDiscoveryLimits(config).maxSkillFileBytes,
    });
    if (!frontmatter?.description?.trim()) {
      plan.staleReason = INVALID_LEGACY_SKILL_REASON;
      continue;
    }
    if (await pathExists(target.skillDir)) {
      const destinationStat = await fs.lstat(target.skillDir);
      if (destinationStat.isDirectory()) {
        // A cross-device copy can publish before source removal fails. Retire
        // that source only when every file, including metadata, matches its copy.
        const [sourceHash, destinationHash] = await Promise.all(
          [plan.source, target.skillDir].map((skillDir) =>
            readSkillProposalTargetTreeSha256(skillDir, { includeRootMetadata: true }),
          ),
        );
        if (sourceHash === destinationHash) {
          movesByKey.set(moveKey, {
            source: plan.source,
            workspaceDir: plan.workspaceDir,
            destination: target.skillDir,
            operation: "remove-source",
            updates: [],
          });
          continue;
        }
      }
      plan.staleReason = `Skill Workshop relocation conflict: destination already exists at ${target.skillDir}.`;
      continue;
    }
    movesByKey.set(moveKey, {
      source: plan.source,
      workspaceDir: plan.workspaceDir,
      destination: target.skillDir,
      operation: "move",
      updates: [],
    });
  }

  const moves = [...movesByKey.values()];
  const conflictsBySource = new Map<string, string>();
  // Check both directions before moving anything; neither owner nor source
  // selection may depend on which proposal happened to be read first.
  for (const field of ["source", "destination"] as const) {
    const groups = new Map<string, WorkshopMove[]>();
    for (const move of moves) {
      const group = groups.get(move[field]) ?? [];
      group.push(move);
      groups.set(move[field], group);
    }
    for (const [location, group] of groups) {
      if (group.length < 2) {
        continue;
      }
      const sources = group.map((move) => move.source);
      const reason =
        field === "destination"
          ? `Skill Workshop relocation conflict: sources ${sources.toSorted().join(", ")} map to the same destination ${location}.`
          : `Skill Workshop relocation conflict: source ${location} maps to multiple destinations ${group
              .map((move) => move.destination)
              .toSorted()
              .join(", ")}.`;
      for (const source of sources) {
        conflictsBySource.set(source, reason);
      }
    }
  }
  for (const plan of ready) {
    const reason = conflictsBySource.get(plan.source);
    if (reason) {
      plan.staleReason = reason;
      plan.moveKey = undefined;
    }
  }
  for (const [moveKey, move] of movesByKey) {
    if (conflictsBySource.has(move.source)) {
      movesByKey.delete(moveKey);
    }
  }

  const updates: WorkshopProposalUpdate[] = [];
  for (const plan of ready) {
    const { entry } = plan;
    const record = entry.record;
    const ownerAgentId = plan.ownerAgentId;
    const target =
      ownerAgentId && record.status === "pending"
        ? resolveSkillProposalTarget({
            skillName: record.target.skillKey,
            config,
            agentId: ownerAgentId,
            env,
          })
        : undefined;
    const moveKey = plan.moveKey ?? (target ? `${plan.source}\0${target.skillDir}` : undefined);
    const move = moveKey ? movesByKey.get(moveKey) : undefined;
    if (move && !plan.staleReason) {
      move.updates.push({
        record: retargetWorkshopProposal(record, {
          skillKey: record.target.skillKey,
          skillDir: move.destination,
          skillFile: path.join(move.destination, "SKILL.md"),
        }),
        ...(ownerAgentId ? { ownerAgentId } : {}),
      });
      continue;
    }
    if (plan.staleReason) {
      updates.push({
        record: staleWorkshopProposal(record, plan.staleReason),
        ...(ownerAgentId ? { ownerAgentId } : {}),
      });
      continue;
    }
    if (record.status === "pending" && record.kind === "create" && ownerAgentId && target) {
      updates.push({
        record: retargetWorkshopProposal(record, target),
        ownerAgentId,
      });
      continue;
    }
    if (record.status === "pending" && record.kind === "update") {
      updates.push({
        record: staleWorkshopProposal(
          record,
          "Skill Workshop no longer edits skills outside its own directory.",
        ),
        ...(ownerAgentId ? { ownerAgentId } : {}),
      });
    }
  }
  return {
    moves: [...movesByKey.values()],
    updates,
    externalProposalCount: external.length,
    externalProposalCountsByAgent: external.reduce<Record<string, number>>((counts, plan) => {
      const ownerAgentId = plan.ownerAgentId ?? plan.unconfiguredOwnerAgentId ?? "unknown";
      counts[ownerAgentId] = (counts[ownerAgentId] ?? 0) + 1;
      return counts;
    }, {}),
    warnings,
  };
}

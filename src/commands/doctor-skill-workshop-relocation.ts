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
  records: readonly SkillProposalRecord[];
  skillKey: string;
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
  if (content === null || skillKey !== params.skillKey) {
    return false;
  }
  const contentHash = hashSkillProposalContent(content);
  for (const record of params.records) {
    if (record.status === "pending") {
      if (record.kind === "update" && record.target.currentContentHash === contentHash) {
        return true;
      }
      continue;
    }
    let appliedContentHash = record.kind === "create" ? record.draftHash : undefined;
    try {
      const proposal = await readSkillProposal(
        record.id,
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
      // Legacy creates can lack a bundle; retain their stored-hash recovery proof.
      // An applied update needs its bundle, not the pre-update currentContentHash.
    }
    if (contentHash === appliedContentHash) {
      return true;
    }
  }
  return false;
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
  record: SkillProposalRecord;
  source: string;
  deferred: boolean;
  workspaceDir: string | undefined;
  ownerAgentId?: string;
  unconfiguredOwnerAgentId?: string;
  relocation?: WorkshopRelocation;
};

type WorkshopRelocation = {
  target: ReturnType<typeof resolveSkillProposalTarget>;
  plans: WorkshopRelocationPlan[];
  move?: WorkshopMove;
  rejection?: string;
};

type WorkshopMove = {
  source: string;
  workspaceDir: string;
  destination: string;
  operation: "move" | "remove-source" | "adopt";
  updates: WorkshopProposalUpdate[];
};

export async function readLegacyWorkshopSourceStat(workspaceDir: string, source: string) {
  let sourceStat: Awaited<ReturnType<typeof fs.lstat>> | undefined;
  try {
    // A workspace root may be an alias; generated paths below it may not be.
    let directory = workspaceDir;
    for (const segment of path.relative(workspaceDir, source).split(path.sep)) {
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
    return undefined;
  }
  return sourceStat;
}

export async function planWorkshopRelocation(
  records: LegacyWorkshopProposal[],
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  deferredSources: ReadonlySet<string> = new Set(),
): Promise<{
  moves: WorkshopMove[];
  updates: WorkshopProposalUpdate[];
  externalProposalCount: number;
  externalProposalCountsByAgent: Record<string, number>;
  warnings: string[];
}> {
  const candidates = records.flatMap<WorkshopRelocationPlan>((entry) => {
    if (entry.record.status !== "pending" && entry.record.status !== "applied") {
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
        record: entry.record,
        source,
        workspaceDir,
        deferred:
          deferredSources.size > 0 && deferredSources.has(resolveCanonicalWorkspacePath(source)),
        ...owner,
      },
    ];
  });
  // Completed updates provide recovery evidence, not ownership or relocation actions.
  const external = candidates.filter(
    ({ record }) => record.status === "pending" || record.kind === "create",
  );
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
  const relocations = new Map<string, WorkshopRelocation>();
  for (const plan of external) {
    plan.deferred ||= Boolean(plan.workspaceDir && deferredWorkspaces.has(plan.workspaceDir));
    if (!plan.ownerAgentId || (plan.record.status === "applied" && !plan.workspaceDir)) {
      continue;
    }
    const target = resolveSkillProposalTarget({
      skillName: plan.record.target.skillKey,
      config,
      agentId: plan.ownerAgentId,
      env,
    });
    const key = [
      plan.ownerAgentId,
      plan.source,
      path.resolve(plan.record.target.skillFile),
      plan.record.target.skillKey,
      target.skillDir,
    ].join("\0");
    plan.relocation = relocations.get(key) ?? { target, plans: [] };
    plan.relocation.plans.push(plan);
    relocations.set(key, plan.relocation);
  }
  const moves: WorkshopMove[] = [];
  for (const relocation of relocations.values()) {
    if (relocation.plans.some((plan) => plan.deferred)) {
      continue;
    }
    const plan = relocation.plans.find(
      ({ record }) => record.kind === "create" && record.status === "applied",
    );
    if (!plan?.workspaceDir) {
      continue;
    }
    const { record } = plan;
    const { target } = relocation;
    let operation: WorkshopMove["operation"] = "move";
    const sourceStat = await readLegacyWorkshopSourceStat(plan.workspaceDir, plan.source);
    if (sourceStat?.isSymbolicLink()) {
      relocation.rejection = `Skill Workshop no longer writes through symlinked skills; ${plan.source} stays a workspace skill.`;
      continue;
    }
    if (!sourceStat) {
      // The move is durable before metadata persistence; on rerun, adopt only its verified destination.
      if (!(await pathExists(target.skillFile))) {
        relocation.rejection =
          "Skill Workshop could not find the applied legacy skill; the proposal is stale.";
        continue;
      }
      const evidence = candidates
        .filter(
          ({ record: candidate, source, ownerAgentId }) =>
            ownerAgentId === plan.ownerAgentId &&
            source === plan.source &&
            candidate.target.skillKey === record.target.skillKey &&
            path.resolve(candidate.target.skillFile) === path.resolve(record.target.skillFile),
        )
        .map((candidate) => candidate.record);
      if (
        !(await verifyRelocationDestination({
          records: evidence,
          skillKey: target.skillKey,
          destinationSkillDir: target.skillDir,
          destinationSkillFile: target.skillFile,
          config,
          env,
        }))
      ) {
        relocation.rejection =
          "Skill Workshop could not adopt the relocated skill: destination identity mismatch (content hash or frontmatter name/key); the proposal is stale.";
        continue;
      }
      operation = "adopt";
    } else {
      const frontmatter = readSkillFrontmatterSafe({
        rootDir: plan.source,
        filePath: path.join(plan.source, "SKILL.md"),
        maxBytes: resolveSkillDiscoveryLimits(config).maxSkillFileBytes,
      });
      if (!frontmatter?.description?.trim()) {
        relocation.rejection = INVALID_LEGACY_SKILL_REASON;
        continue;
      }
      if (await pathExists(target.skillDir)) {
        const destinationStat = await fs.lstat(target.skillDir);
        let copied = false;
        if (destinationStat.isDirectory()) {
          // A cross-device copy can publish before source removal fails. Retire
          // that source only when every file, including metadata, matches its copy.
          const [sourceHash, destinationHash] = await Promise.all(
            [plan.source, target.skillDir].map((skillDir) =>
              readSkillProposalTargetTreeSha256(skillDir, { includeRootMetadata: true }),
            ),
          );
          copied = sourceHash === destinationHash;
        }
        if (!copied) {
          relocation.rejection = `Skill Workshop relocation conflict: destination already exists at ${target.skillDir}.`;
          continue;
        }
        operation = "remove-source";
      }
    }
    relocation.move = {
      source: plan.source,
      workspaceDir: plan.workspaceDir,
      destination: target.skillDir,
      operation,
      updates: [],
    };
    moves.push(relocation.move);
  }

  const conflictsBySource = new Map<string, string>();
  const sources = moves.map((move) => ({
    move,
    source: resolveCanonicalWorkspacePath(move.source),
  }));
  const deferredReservations = external
    .filter((plan) => plan.deferred)
    .map((plan) => ({
      source: resolveCanonicalWorkspacePath(plan.source),
      destination: plan.relocation?.target.skillDir,
    }));
  const deferredMoves = new Set<WorkshopMove>();
  // Deferred sources still reserve their paths and destinations. Carry those
  // reservations through connected moves so an ancestor cannot move them indirectly.
  for (const reservation of deferredReservations) {
    for (const { move, source } of sources) {
      if (
        !deferredMoves.has(move) &&
        (reservation.destination === move.destination ||
          isPathInside(reservation.source, source) ||
          isPathInside(source, reservation.source))
      ) {
        deferredMoves.add(move);
        deferredReservations.push({ source, destination: move.destination });
        warnings.push(
          `Skill Workshop left ${move.source} in place because a connected skill still needs migration or recovery.`,
        );
      }
    }
  }
  const deferredMoveSources = new Set([...deferredMoves].map((move) => move.source));
  const workspaces = listAgentIds(config).map((agentId) =>
    resolveCanonicalWorkspacePath(resolveAgentWorkspaceDir(config, agentId, env)),
  );
  // Reject the entire overlap before moving anything, including configured
  // workspaces without a Workshop claim; moving their ancestor changes ownership.
  for (const { move, source } of sources) {
    const sharedDestination = moves.filter((other) => other.destination === move.destination);
    const overlap = sources.find(
      ({ move: other, source: otherSource }) =>
        other !== move && (isPathInside(source, otherSource) || isPathInside(otherSource, source)),
    );
    const workspace = workspaces.find((directory) => isPathInside(source, directory));
    const reason =
      sharedDestination.length > 1
        ? `Skill Workshop relocation conflict: sources ${sharedDestination
            .map((other) => other.source)
            .toSorted()
            .join(", ")} map to the same destination ${move.destination}.`
        : overlap
          ? `Skill Workshop relocation conflict: source ${move.source} overlaps source ${overlap.move.source} targeting ${overlap.move.destination}.`
          : workspace
            ? `Skill Workshop relocation conflict: source ${move.source} contains configured workspace ${workspace}.`
            : undefined;
    if (reason) {
      conflictsBySource.set(move.source, reason);
    }
  }
  const updates: WorkshopProposalUpdate[] = [];
  for (const plan of external) {
    if (plan.deferred || deferredMoveSources.has(plan.source)) {
      continue;
    }
    const { record, relocation, ownerAgentId } = plan;
    const conflictReason = conflictsBySource.get(plan.source);
    if (!relocation) {
      updates.push({
        record: staleWorkshopProposal(
          record,
          conflictReason ??
            (ownerAgentId
              ? "Skill Workshop could not identify the legacy workspace; the path stays in place and the proposal is stale."
              : plan.unconfiguredOwnerAgentId
                ? `Skill Workshop could not use unconfigured owning agent "${plan.unconfiguredOwnerAgentId}"; the legacy path stays in place and the proposal is stale.`
                : "Skill Workshop could not identify one owning agent; the legacy path stays in place and the proposal is stale."),
        ),
        ...(ownerAgentId ? { ownerAgentId } : {}),
      });
      continue;
    }
    const { target, move } = relocation;
    const staleReason =
      conflictReason ??
      relocation.rejection ??
      (!move && record.kind === "update"
        ? "Skill Workshop no longer edits skills outside its own directory."
        : undefined);
    const update = {
      record: staleReason
        ? staleWorkshopProposal(record, staleReason)
        : retargetWorkshopProposal(record, target),
      ...(ownerAgentId ? { ownerAgentId } : {}),
    };
    (move && !staleReason ? move.updates : updates).push(update);
  }
  return {
    moves: moves.filter(
      (move) => !conflictsBySource.has(move.source) && !deferredMoveSources.has(move.source),
    ),
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

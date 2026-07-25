import fs from "node:fs/promises";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { readLocalFileSafely, root, walkDirectory } from "../../infra/fs-safe.js";
import {
  buildWorkspaceSkillStatus,
  resolveSkillStatusEntry,
  type SkillStatusEntry,
} from "../discovery/status.js";
import {
  assertInsideWorkspace,
  assertWorkspaceSkillWriteTarget,
  MAX_WORKSPACE_SKILL_SUPPORT_FILE_BYTES,
  normalizeWorkspaceSkillSupportPath,
  readWorkspaceSkillFile,
  readWorkspaceSupportFile,
  writeWorkspaceSkill,
} from "../lifecycle/workspace-skill-write.js";
import { resolveAllowedSkillSymlinkTargetRealPaths } from "../loading/symlink-targets.js";
import { bumpSkillsSnapshotVersion } from "../runtime/refresh-state.js";
import { resolveSkillWorkshopConfig, type SkillWorkshopConfig } from "./config.js";
import {
  readProposalFrontmatter,
  renderProposalMarkdown,
  stripProposalFrontmatterForSkill,
} from "./frontmatter.js";
import { assertProposalContainsNoLiteralSecrets, scanProposalBundle } from "./proposal-scan.js";
import {
  isProposalInWorkspace,
  listSkillProposals,
  readRequiredProposal,
} from "./service-query.js";
import {
  createSkillProposalId,
  createSkillProposalRollback,
  hashSkillProposalContent,
  MAX_PROPOSAL_SUPPORT_FILES,
  prepareSkillProposalSupportFiles,
  readProposalSupportFiles,
  readSkillProposalRecord,
  replaceSkillProposalDraft,
  refreshSkillProposalManifest,
  resolveSkillProposalTarget,
  updateSkillProposalRecord,
  writeSkillProposal,
  writeSkillProposalRollback,
  withSkillProposalTargetLock,
  type PreparedSkillProposalSupportFile,
} from "./store.js";
export {
  getSkillProposalRunProgress,
  inspectSkillProposal,
  listSkillProposals,
  resolvePendingSkillProposal,
} from "./service-query.js";
import {
  MAX_SKILL_PROPOSAL_ORIGIN_RUN_IDS,
  SKILL_WORKSHOP_SCHEMA,
  type SkillProposalActionInput,
  type SkillProposalApplyResult,
  type SkillProposalCreateInput,
  type SkillProposalOrigin,
  type SkillProposalManifest,
  type SkillProposalReadResult,
  type SkillProposalRecord,
  type SkillProposalReviseInput,
  type SkillProposalRollback,
  type SkillProposalSupportFile,
  type SkillProposalSupportFileInput,
  type SkillProposalUpdateInput,
} from "./types.js";

type SkillWorkshopWorkspaceOptions = {
  config?: OpenClawConfig;
  agentId?: string;
};

function proposalStoreOptions(env?: NodeJS.ProcessEnv) {
  return env ? { env } : {};
}

const WRITABLE_WORKSPACE_SOURCES = new Set(["openclaw-workspace", "agents-skills-project"]);
const MAX_PROPOSAL_DRAFT_BYTES = 1024 * 1024;
const MAX_PROPOSAL_DIRECTORY_ENTRIES = MAX_PROPOSAL_SUPPORT_FILES * 4;
const MAX_SKILL_PROPOSAL_DESCRIPTION_BYTES = 160;

export async function readSkillProposalDraftFile(filePath: string): Promise<string> {
  const read = await readLocalFileSafely({
    filePath,
    maxBytes: MAX_PROPOSAL_DRAFT_BYTES,
  });
  return decodeProposalTextFile(read.buffer, filePath);
}

export async function readSkillProposalDraftDirectory(dirPath: string): Promise<{
  content: string;
  supportFiles: SkillProposalSupportFileInput[];
}> {
  const absoluteDir = path.resolve(dirPath);
  const draftRoot = await root(absoluteDir);
  const proposal = await draftRoot.read("PROPOSAL.md", {
    hardlinks: "reject",
    maxBytes: MAX_PROPOSAL_DRAFT_BYTES,
    symlinks: "reject",
  });
  const scanned = await walkDirectory(absoluteDir, {
    maxDepth: 8,
    maxEntries: MAX_PROPOSAL_DIRECTORY_ENTRIES,
    symlinks: "include",
  });
  if (scanned.truncated) {
    throw new Error("Proposal directory has too many entries.");
  }
  const supportFiles: SkillProposalSupportFileInput[] = [];
  for (const entry of scanned.entries.toSorted((a, b) =>
    a.relativePath.localeCompare(b.relativePath),
  )) {
    const relativePath = toPortableRelativePath(entry.relativePath);
    if (!relativePath || relativePath === "PROPOSAL.md") {
      continue;
    }
    if (entry.kind === "directory") {
      continue;
    }
    if (entry.kind !== "file") {
      throw new Error(`Proposal support file must be a regular file: ${relativePath}`);
    }
    const supportPath = normalizeWorkspaceSkillSupportPath(relativePath);
    const stats = await fs.stat(entry.path);
    if ((stats.mode & 0o111) !== 0) {
      throw new Error(`Proposal support files must not be executable: ${relativePath}`);
    }
    const read = await draftRoot.read(relativePath, {
      hardlinks: "reject",
      maxBytes: MAX_WORKSPACE_SKILL_SUPPORT_FILE_BYTES,
      symlinks: "reject",
    });
    supportFiles.push({
      path: supportPath,
      content: decodeProposalTextFile(read.buffer, relativePath),
    });
  }
  return {
    content: decodeProposalTextFile(proposal.buffer, "PROPOSAL.md"),
    supportFiles,
  };
}

function decodeProposalTextFile(buffer: Buffer, label: string): string {
  const content = buffer.toString("utf8");
  if (!Buffer.from(content, "utf8").equals(buffer) || content.includes("\0")) {
    throw new Error(`Proposal files must be UTF-8 text: ${label}`);
  }
  return content;
}

function normalizeProposalOrigin(
  origin: SkillProposalOrigin | undefined,
): SkillProposalOrigin | undefined {
  const agentId = normalizeOptionalString(origin?.agentId);
  const sessionKey = normalizeOptionalString(origin?.sessionKey);
  const runId = normalizeOptionalString(origin?.runId);
  const messageId = normalizeOptionalString(origin?.messageId);
  if (!agentId && !sessionKey && !runId && !messageId) {
    return undefined;
  }
  return {
    ...(agentId ? { agentId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(runId ? { runId } : {}),
    ...(messageId ? { messageId } : {}),
  };
}

function mergeProposalOriginRunProvenance(
  record:
    | Pick<SkillProposalRecord, "origin" | "originRunIds" | "originRunMutationCounts">
    | undefined,
  origin: SkillProposalOrigin | undefined,
): { originRunIds?: string[]; originRunMutationCounts?: Record<string, number> } {
  const ids = new Set(record?.originRunIds);
  const counts = { ...record?.originRunMutationCounts };
  if (record?.origin?.runId) {
    ids.add(record.origin.runId);
  }
  for (const runId of ids) {
    counts[runId] ??= 1;
  }
  if (origin?.runId) {
    ids.add(origin.runId);
    counts[origin.runId] = (counts[origin.runId] ?? 0) + 1;
  }
  if (ids.size > MAX_SKILL_PROPOSAL_ORIGIN_RUN_IDS) {
    throw new Error("Skill proposal run provenance exceeds the supported limit.");
  }
  return {
    ...(ids.size > 0 ? { originRunIds: [...ids] } : {}),
    ...(Object.keys(counts).length > 0 ? { originRunMutationCounts: counts } : {}),
  };
}

export async function proposeCreateSkill(
  input: SkillProposalCreateInput,
): Promise<SkillProposalReadResult> {
  const name = normalizeRequired(input.name, "Skill name");
  const description = normalizeRequired(input.description, "Skill description");
  const config = resolveSkillWorkshopConfig(input.config);
  assertProposalDescriptionWithinLimit(description);
  assertProposalContentWithinLimit(input.content, config.maxSkillBytes);
  const target = resolveSkillProposalTarget({ workspaceDir: input.workspaceDir, skillName: name });
  if ((await readWorkspaceSkillFile(target.skillFile)) !== null) {
    throw new Error(`Skill already exists at ${target.skillFile}.`);
  }

  const supportFiles = prepareSkillProposalSupportFiles(input.supportFiles);
  const now = new Date().toISOString();
  const proposalContent = renderProposalMarkdown({
    name: target.skillKey,
    description,
    content: input.content,
    date: now,
  });
  const id = createSkillProposalId(name);
  const goal = normalizeOptionalString(input.goal);
  const evidence = normalizeOptionalString(input.evidence);
  const scan = scanProposalBundle(proposalContent, supportFiles, [
    { file: "skill-name", content: name },
    { file: "description", content: description },
    { file: "goal", content: goal },
    { file: "evidence", content: evidence },
  ]);
  assertProposalContainsNoLiteralSecrets(scan);
  const origin = normalizeProposalOrigin(input.origin);
  const originRunProvenance = mergeProposalOriginRunProvenance(undefined, origin);
  const record: SkillProposalRecord = {
    schema: SKILL_WORKSHOP_SCHEMA,
    id,
    kind: "create",
    status: "pending",
    title: `Create ${name}`,
    description,
    createdAt: now,
    updatedAt: now,
    createdBy: input.createdBy ?? "skill-workshop",
    ...(origin ? { origin } : {}),
    ...originRunProvenance,
    proposedVersion: "v1",
    draftFile: "PROPOSAL.md",
    draftHash: hashSkillProposalContent(proposalContent),
    target: {
      skillName: name,
      skillKey: target.skillKey,
      skillDir: target.skillDir,
      skillFile: target.skillFile,
      source: "openclaw-workspace",
    },
    scan,
    ...(supportFiles.length > 0
      ? { supportFiles: await buildSupportFileMetadata(supportFiles) }
      : {}),
    ...(goal ? { goal } : {}),
    ...(evidence ? { evidence } : {}),
  };
  await writeSkillProposal({
    record,
    content: proposalContent,
    supportFiles,
    store: proposalStoreOptions(input.env),
    beforeWrite: async (manifest) => {
      await assertCanCreatePendingProposal(input.workspaceDir, config, manifest, input.env);
    },
  });
  return { record, content: proposalContent };
}

/** Summary of a workspace skill the workshop is allowed to write. */
type WritableWorkspaceSkillSummary = {
  name: string;
  description?: string;
  filePath: string;
};

/**
 * Lists the workspace skills the workshop can target with update proposals, using the same
 * status discovery as `proposeUpdateSkill` so callers that route corrections to existing
 * skills stay in lockstep with what an update can actually write.
 */
export function listWritableWorkspaceSkillSummaries(
  workspaceDir: string,
  opts?: { config?: OpenClawConfig; agentId?: string },
): WritableWorkspaceSkillSummary[] {
  const status = buildWorkspaceSkillStatus(workspaceDir, {
    config: opts?.config,
    agentId: opts?.agentId,
  });
  const summaries: WritableWorkspaceSkillSummary[] = [];
  for (const skill of status.skills) {
    if (!WRITABLE_WORKSPACE_SOURCES.has(skill.source)) {
      continue;
    }
    summaries.push(
      skill.description
        ? { name: skill.skillKey, description: skill.description, filePath: skill.filePath }
        : { name: skill.skillKey, filePath: skill.filePath },
    );
  }
  return summaries;
}

export async function proposeUpdateSkill(
  input: SkillProposalUpdateInput & SkillWorkshopWorkspaceOptions,
): Promise<SkillProposalReadResult> {
  const skillName = normalizeRequired(input.skillName, "Skill name");
  const config = resolveSkillWorkshopConfig(input.config);
  const status = buildWorkspaceSkillStatus(input.workspaceDir, {
    config: input.config,
    agentId: input.agentId,
  });
  const targetSkill = resolveSkillStatusEntry(status.skills, skillName);
  if (!targetSkill) {
    throw new Error(`Skill not found: ${skillName}`);
  }
  assertWritableSkillTarget(input.workspaceDir, targetSkill);
  const currentContent = await readWorkspaceSkillFile(targetSkill.filePath);
  if (currentContent === null) {
    throw new Error(`Skill file is missing: ${targetSkill.filePath}`);
  }
  const description = resolveUpdateProposalDescription(input.description, targetSkill.description);
  assertProposalContentWithinLimit(input.content, config.maxSkillBytes);

  const supportFiles = prepareSkillProposalSupportFiles(input.supportFiles);
  const now = new Date().toISOString();
  const proposalContent = renderProposalMarkdown({
    name: targetSkill.skillKey,
    description,
    content: input.content,
    fallbackFrontmatterContent: currentContent,
    date: now,
  });
  const id = createSkillProposalId(targetSkill.skillKey || targetSkill.name);
  const goal = normalizeOptionalString(input.goal);
  const evidence = normalizeOptionalString(input.evidence);
  const scan = scanProposalBundle(proposalContent, supportFiles, [
    { file: "description", content: description },
    { file: "goal", content: goal },
    { file: "evidence", content: evidence },
  ]);
  assertProposalContainsNoLiteralSecrets(scan);
  const origin = normalizeProposalOrigin(input.origin);
  const originRunProvenance = mergeProposalOriginRunProvenance(undefined, origin);
  const record: SkillProposalRecord = {
    schema: SKILL_WORKSHOP_SCHEMA,
    id,
    kind: "update",
    status: "pending",
    title: `Update ${targetSkill.name}`,
    description,
    createdAt: now,
    updatedAt: now,
    createdBy: input.createdBy ?? "skill-workshop",
    ...(origin ? { origin } : {}),
    ...originRunProvenance,
    proposedVersion: "v1",
    draftFile: "PROPOSAL.md",
    draftHash: hashSkillProposalContent(proposalContent),
    target: {
      skillName: targetSkill.name,
      skillKey: targetSkill.skillKey,
      skillDir: targetSkill.baseDir,
      skillFile: targetSkill.filePath,
      source: targetSkill.source,
      currentContentHash: hashSkillProposalContent(currentContent),
    },
    scan,
    ...(supportFiles.length > 0
      ? { supportFiles: await buildSupportFileMetadata(supportFiles, targetSkill.baseDir) }
      : {}),
    ...(goal ? { goal } : {}),
    ...(evidence ? { evidence } : {}),
  };
  await writeSkillProposal({
    record,
    content: proposalContent,
    supportFiles,
    store: proposalStoreOptions(input.env),
    beforeWrite: async (manifest) => {
      await assertCanCreatePendingProposal(input.workspaceDir, config, manifest, input.env);
    },
  });
  return { record, content: proposalContent };
}

export async function reviseSkillProposal(
  input: SkillProposalReviseInput,
): Promise<SkillProposalReadResult> {
  const config = resolveSkillWorkshopConfig(input.config);
  return await withPendingSkillProposalMutation(input, "revised", async (read) => {
    const { record } = read;
    assertInsideWorkspace(input.workspaceDir, record.target.skillFile, "skill file");
    assertInsideWorkspace(input.workspaceDir, record.target.skillDir, "skill directory");

    if (record.kind === "create") {
      const currentContent = await readWorkspaceSkillFile(record.target.skillFile);
      if (currentContent !== null) {
        await markProposalStale(
          record,
          "Target skill was created after proposal creation.",
          input.env,
        );
        throw new Error("Target skill was created after proposal creation; proposal marked stale.");
      }
    } else {
      const currentContent = await readWorkspaceSkillFile(record.target.skillFile);
      if (currentContent === null) {
        throw new Error(`Target skill is missing: ${record.target.skillFile}`);
      }
      if (
        record.target.currentContentHash &&
        hashSkillProposalContent(currentContent) !== record.target.currentContentHash
      ) {
        await markProposalStale(record, "Target skill changed after proposal creation.", input.env);
        throw new Error("Target skill changed after proposal creation; proposal marked stale.");
      }
      await assertSupportTargetsUnchanged(record, input.env);
    }

    const supportFiles =
      input.supportFiles === undefined
        ? await readProposalSupportFiles(record, proposalStoreOptions(input.env))
        : prepareSkillProposalSupportFiles(input.supportFiles);
    assertProposalContentWithinLimit(input.content, config.maxSkillBytes);
    const supportFileMetadata =
      supportFiles.length > 0
        ? await buildSupportFileMetadata(
            supportFiles,
            record.kind === "update" ? record.target.skillDir : undefined,
          )
        : [];
    const nextVersion = nextProposalVersion(record.proposedVersion);
    const description = normalizeOptionalString(input.description) ?? record.description;
    assertProposalDescriptionWithinLimit(description);
    const now = new Date().toISOString();
    const proposalContent = renderProposalMarkdown({
      name: record.target.skillKey,
      description,
      content: input.content,
      fallbackFrontmatterContent: read.content,
      version: nextVersion,
      date: now,
    });
    const goal =
      input.goal === undefined
        ? normalizeOptionalString(record.goal)
        : normalizeOptionalString(input.goal);
    const evidence =
      input.evidence === undefined
        ? normalizeOptionalString(record.evidence)
        : normalizeOptionalString(input.evidence);
    const origin = normalizeProposalOrigin(input.origin);
    const originRunProvenance = mergeProposalOriginRunProvenance(record, origin);
    const previousSupportFiles = record.supportFiles;
    const scan = scanProposalBundle(proposalContent, supportFiles, [
      { file: "description", content: description },
      { file: "goal", content: goal },
      { file: "evidence", content: evidence },
    ]);
    assertProposalContainsNoLiteralSecrets(scan);
    const revised: SkillProposalRecord = {
      ...record,
      description,
      updatedAt: now,
      proposedVersion: nextVersion,
      draftHash: hashSkillProposalContent(proposalContent),
      scan,
      ...(origin ? { origin } : {}),
      ...originRunProvenance,
    };
    if (supportFiles.length > 0) {
      revised.supportFiles = supportFileMetadata;
    } else {
      delete revised.supportFiles;
    }
    if (goal) {
      revised.goal = goal;
    } else {
      delete revised.goal;
    }
    if (evidence) {
      revised.evidence = evidence;
    } else {
      delete revised.evidence;
    }
    await replaceSkillProposalDraft({
      record: revised,
      previousSupportFiles,
      content: proposalContent,
      supportFiles,
      store: proposalStoreOptions(input.env),
    });
    return { record: revised, content: proposalContent };
  });
}

export async function rejectSkillProposal(
  input: SkillProposalActionInput,
): Promise<SkillProposalRecord> {
  return await markProposal(input, "rejected");
}

export async function quarantineSkillProposal(
  input: SkillProposalActionInput,
): Promise<SkillProposalRecord> {
  return await withPendingSkillProposalMutation(input, "quarantined", async (read) => {
    const now = new Date().toISOString();
    const record: SkillProposalRecord = {
      ...read.record,
      status: "quarantined",
      updatedAt: now,
      quarantinedAt: now,
      statusReason: normalizeOptionalString(input.reason),
      scan: {
        ...read.record.scan,
        state: "quarantined",
      },
    };
    await updateSkillProposalRecord({ record, store: proposalStoreOptions(input.env) });
    return record;
  });
}

export async function applySkillProposal(
  input: SkillProposalActionInput,
): Promise<SkillProposalApplyResult> {
  return await withPendingSkillProposalMutation(input, "applied", async (read) => {
    const { record, content } = read;
    const draftHash = hashSkillProposalContent(content);
    if (draftHash !== record.draftHash) {
      throw new Error("Proposal draft changed without updating proposal metadata.");
    }
    const supportFiles = await readProposalSupportFiles(record, proposalStoreOptions(input.env));
    const draftFrontmatter = readProposalFrontmatter(content);
    if (!draftFrontmatter) {
      throw new Error("Proposal draft must include proposal frontmatter.");
    }
    const scan = scanProposalBundle(content, supportFiles);
    if (scan.state !== "clean") {
      const updated = {
        ...record,
        status: "quarantined" as const,
        updatedAt: new Date().toISOString(),
        quarantinedAt: new Date().toISOString(),
        scan: { ...scan, state: "quarantined" as const },
        statusReason: "Proposal scan failed.",
      };
      await updateSkillProposalRecord({
        record: updated,
        store: proposalStoreOptions(input.env),
      });
      throw new Error("Proposal scan failed; proposal was quarantined.");
    }

    assertInsideWorkspace(input.workspaceDir, record.target.skillFile, "skill file");
    assertInsideWorkspace(input.workspaceDir, record.target.skillDir, "skill directory");
    const workshopConfig = resolveSkillWorkshopConfig(input.config);
    const symlinkPolicy = {
      allowWrites: workshopConfig.allowSymlinkTargetWrites,
      allowedTargetRealPaths: workshopConfig.allowSymlinkTargetWrites
        ? resolveAllowedSkillSymlinkTargetRealPaths(input.config)
        : [],
    };
    await assertWorkspaceSkillWriteTarget({
      workspaceDir: input.workspaceDir,
      filePath: record.target.skillFile,
      symlinkPolicy,
    });
    const targetState = await readApplyTargetState(record, supportFiles, input.env);
    const rollback = createSkillProposalRollback({
      proposalId: record.id,
      targetSkillFile: record.target.skillFile,
      action: record.kind,
      ...(targetState.previousContent !== null
        ? { previousContent: targetState.previousContent }
        : {}),
      ...(targetState.previousSupportFiles.length > 0
        ? { supportFiles: targetState.previousSupportFiles }
        : {}),
    });
    await writeSkillProposalRollback({
      proposalId: record.id,
      rollback,
      store: proposalStoreOptions(input.env),
    });

    const skillContent = stripProposalFrontmatterForSkill(content);
    await writeWorkspaceSkill({
      workspaceDir: input.workspaceDir,
      skillDir: record.target.skillDir,
      skillFile: record.target.skillFile,
      content: skillContent,
      supportFiles,
      mode: record.kind,
      symlinkPolicy,
    });
    bumpSkillsSnapshotVersion({
      workspaceDir: input.workspaceDir,
      reason: "workshop",
      changedPath: record.target.skillFile,
    });
    const now = new Date().toISOString();
    const applied: SkillProposalRecord = {
      ...record,
      status: "applied",
      updatedAt: now,
      appliedAt: now,
      scan,
    };
    await updateSkillProposalRecord({
      record: applied,
      store: proposalStoreOptions(input.env),
    });
    await refreshSkillProposalManifest(proposalStoreOptions(input.env));
    return { record: applied, targetSkillFile: record.target.skillFile };
  });
}

async function readApplyTargetState(
  record: SkillProposalRecord,
  supportFiles: readonly PreparedSkillProposalSupportFile[],
  env?: NodeJS.ProcessEnv,
): Promise<{
  previousContent: string | null;
  previousSupportFiles: NonNullable<SkillProposalRollback["supportFiles"]>;
}> {
  const previousContent = await readWorkspaceSkillFile(record.target.skillFile);
  if (record.kind === "create" && previousContent !== null) {
    throw new Error(`Target skill already exists: ${record.target.skillFile}`);
  }
  const previousSupportFiles: NonNullable<SkillProposalRollback["supportFiles"]> = [];
  for (const file of supportFiles) {
    const supportRecord = record.supportFiles?.find((entry) => entry.path === file.path);
    const previousSupportContent = await readWorkspaceSupportFile({
      skillDir: record.target.skillDir,
      relativePath: file.path,
    });
    if (record.kind === "create" && previousSupportContent !== null) {
      throw new Error(
        `Target support file already exists: ${path.join(record.target.skillDir, file.path)}`,
      );
    }
    if (record.kind === "update" && supportRecord) {
      await assertSupportTargetUnchanged({
        record,
        file: supportRecord,
        currentContent: previousSupportContent,
        env,
      });
    }
    previousSupportFiles.push(
      previousSupportContent === null
        ? {
            path: file.path,
            existed: false,
          }
        : {
            path: file.path,
            existed: true,
            previousContent: previousSupportContent,
            previousContentHash: hashSkillProposalContent(previousSupportContent),
          },
    );
  }
  if (record.kind === "update") {
    if (previousContent === null) {
      throw new Error(`Target skill is missing: ${record.target.skillFile}`);
    }
    if (
      record.target.currentContentHash &&
      hashSkillProposalContent(previousContent) !== record.target.currentContentHash
    ) {
      const stale = {
        ...record,
        status: "stale" as const,
        updatedAt: new Date().toISOString(),
        staleAt: new Date().toISOString(),
        statusReason: "Target skill changed after proposal creation.",
      };
      await updateSkillProposalRecord({ record: stale, store: proposalStoreOptions(env) });
      throw new Error("Target skill changed after proposal creation; proposal marked stale.");
    }
  }
  return { previousContent, previousSupportFiles };
}

async function assertCanCreatePendingProposal(
  workspaceDir: string,
  config: SkillWorkshopConfig,
  manifest?: SkillProposalManifest,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  if (!manifest) {
    const proposals = (await listSkillProposals({ workspaceDir, env })).proposals;
    assertPendingProposalCountWithinLimit(
      proposals.filter((entry) => entry.status === "pending" || entry.status === "quarantined")
        .length,
      config,
    );
    return;
  }

  let activeProposalCount = 0;
  for (const entry of manifest.proposals) {
    if (entry.status !== "pending" && entry.status !== "quarantined") {
      continue;
    }
    const record = await readSkillProposalRecord(entry.id, proposalStoreOptions(env));
    if (record && isProposalInWorkspace(record, workspaceDir)) {
      activeProposalCount += 1;
    }
  }
  assertPendingProposalCountWithinLimit(activeProposalCount, config);
}

function assertPendingProposalCountWithinLimit(
  activeProposalCount: number,
  config: SkillWorkshopConfig,
): void {
  if (activeProposalCount >= config.maxPending) {
    throw new Error(`Skill Workshop pending proposal limit reached (${config.maxPending}).`);
  }
}

function assertProposalDescriptionWithinLimit(description: string): void {
  const sizeBytes = Buffer.byteLength(description, "utf8");
  if (sizeBytes > MAX_SKILL_PROPOSAL_DESCRIPTION_BYTES) {
    throw new Error(
      `Skill proposal description is too large (${sizeBytes} bytes, max ${MAX_SKILL_PROPOSAL_DESCRIPTION_BYTES}).`,
    );
  }
}

function resolveUpdateProposalDescription(
  inputDescription: string | undefined,
  currentDescription: string,
): string {
  const supplied = normalizeOptionalString(inputDescription);
  if (supplied) {
    assertProposalDescriptionWithinLimit(supplied);
    return supplied;
  }
  return truncateUtf8(currentDescription.trim(), MAX_SKILL_PROPOSAL_DESCRIPTION_BYTES);
}

function truncateUtf8(value: string, maxBytes: number): string {
  let out = "";
  let sizeBytes = 0;
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (sizeBytes + charBytes > maxBytes) {
      break;
    }
    out += char;
    sizeBytes += charBytes;
  }
  return out.trimEnd();
}

function assertProposalContentWithinLimit(content: string, maxSkillBytes: number): void {
  const sizeBytes = Buffer.byteLength(content, "utf8");
  if (sizeBytes > maxSkillBytes) {
    throw new Error(
      `Skill proposal content is too large (${sizeBytes} bytes, max ${maxSkillBytes}).`,
    );
  }
}

async function buildSupportFileMetadata(
  files: readonly PreparedSkillProposalSupportFile[],
  targetSkillDir?: string,
): Promise<SkillProposalSupportFile[]> {
  const out: SkillProposalSupportFile[] = [];
  for (const file of files) {
    const metadata: SkillProposalSupportFile = {
      path: file.path,
      sizeBytes: file.sizeBytes,
      hash: file.hash,
    };
    if (targetSkillDir) {
      const targetContent = await readWorkspaceSupportFile({
        skillDir: targetSkillDir,
        relativePath: file.path,
      });
      metadata.targetExisted = targetContent !== null;
      if (targetContent !== null) {
        metadata.targetContentHash = hashSkillProposalContent(targetContent);
      }
    }
    out.push(metadata);
  }
  return out;
}

function nextProposalVersion(version: string): string {
  const match = /^v(\d+)$/.exec(version.trim());
  if (!match) {
    return "v2";
  }
  const current = Number.parseInt(match[1] ?? "1", 10);
  return `v${Number.isSafeInteger(current) && current > 0 ? current + 1 : 2}`;
}

async function markProposal(
  input: SkillProposalActionInput,
  status: "rejected",
): Promise<SkillProposalRecord> {
  return await withPendingSkillProposalMutation(input, status, async (read) => {
    const now = new Date().toISOString();
    const record: SkillProposalRecord = {
      ...read.record,
      status,
      updatedAt: now,
      rejectedAt: now,
      statusReason: normalizeOptionalString(input.reason),
    };
    await updateSkillProposalRecord({ record, store: proposalStoreOptions(input.env) });
    return record;
  });
}

async function withPendingSkillProposalMutation<T>(
  input: Pick<SkillProposalActionInput, "env" | "proposalId" | "workspaceDir">,
  action: "applied" | "quarantined" | "rejected" | "revised",
  fn: (read: SkillProposalReadResult) => Promise<T>,
): Promise<T> {
  const initial = await readRequiredProposal(input.proposalId, input.workspaceDir, input.env);
  return await withSkillProposalTargetLock(
    initial.record,
    async () => {
      const read = await readRequiredProposal(input.proposalId, input.workspaceDir, input.env);
      if (read.record.status !== "pending") {
        throw new Error(
          `Only pending proposals can be ${action}. Current status: ${read.record.status}.`,
        );
      }
      return await fn(read);
    },
    proposalStoreOptions(input.env),
  );
}

async function assertSupportTargetUnchanged(params: {
  env?: NodeJS.ProcessEnv;
  record: SkillProposalRecord;
  file: SkillProposalSupportFile;
  currentContent: string | null;
}): Promise<void> {
  const { record, file, currentContent } = params;
  if (file.targetExisted === false && currentContent !== null) {
    await markProposalStale(
      record,
      `Target support file changed after proposal creation: ${file.path}`,
      params.env,
    );
    throw new Error("Target support file changed after proposal creation; proposal marked stale.");
  }
  if (file.targetExisted === true) {
    const currentHash =
      currentContent === null ? undefined : hashSkillProposalContent(currentContent);
    if (currentHash !== file.targetContentHash) {
      await markProposalStale(
        record,
        `Target support file changed after proposal creation: ${file.path}`,
        params.env,
      );
      throw new Error(
        "Target support file changed after proposal creation; proposal marked stale.",
      );
    }
  }
}

async function assertSupportTargetsUnchanged(
  record: SkillProposalRecord,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  if (record.kind !== "update" || !record.supportFiles) {
    return;
  }
  for (const file of record.supportFiles) {
    if (file.targetExisted === undefined) {
      continue;
    }
    const currentContent = await readWorkspaceSupportFile({
      skillDir: record.target.skillDir,
      relativePath: file.path,
    });
    await assertSupportTargetUnchanged({ record, file, currentContent, env });
  }
}

async function markProposalStale(
  record: SkillProposalRecord,
  reason: string,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  const stale = {
    ...record,
    status: "stale" as const,
    updatedAt: new Date().toISOString(),
    staleAt: new Date().toISOString(),
    statusReason: reason,
  };
  await updateSkillProposalRecord({ record: stale, store: proposalStoreOptions(env) });
}

function assertWritableSkillTarget(workspaceDir: string, skill: SkillStatusEntry): void {
  if (!WRITABLE_WORKSPACE_SOURCES.has(skill.source)) {
    throw new Error(`Skill source is not writable by Skill Workshop: ${skill.source}`);
  }
  assertInsideWorkspace(workspaceDir, skill.filePath, "skill file");
  assertInsideWorkspace(workspaceDir, skill.baseDir, "skill directory");
  if (path.basename(skill.filePath) !== "SKILL.md") {
    throw new Error("Skill Workshop can only update SKILL.md targets.");
  }
}

function normalizeRequired(value: string, label: string): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    throw new Error(`${label} is required.`);
  }
  return normalized;
}

function toPortableRelativePath(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

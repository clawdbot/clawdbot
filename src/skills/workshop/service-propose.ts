import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { buildWorkspaceSkillStatus, resolveSkillStatusEntry } from "../discovery/status.js";
import {
  readWorkspaceSkillFile,
  readWorkspaceSupportFile,
} from "../lifecycle/workspace-skill-write.js";
import { resolveSkillWorkshopConfig } from "./config.js";
import { stripProposalFrontmatterForSkill } from "./frontmatter.js";
import { isWorkshopOwnedSkillDir } from "./ownership.js";
import { createSkillProposalEvent, dispatchSkillProposalChanged } from "./plugin-hooks.js";
import { prepareSkillProposalDraft, resolveUpdateProposalDescription } from "./proposal-draft.js";
import { createSkillProposalGenerationDraftFile } from "./proposal-generation.js";
import { hashSkillProposalRevision } from "./revision-hash.js";
import {
  createSkillProposalId,
  hashSkillProposalContent,
  resolveSkillProposalTarget,
  writeSkillProposal,
} from "./store.js";
import {
  MAX_SKILL_PROPOSAL_ORIGIN_RUN_IDS,
  SKILL_WORKSHOP_SCHEMA,
  type PreparedSkillProposalSupportFile,
  type SkillProposalCreateInput,
  type SkillProposalOrigin,
  type SkillProposalReadResult,
  type SkillProposalRecord,
  type SkillProposalSupportFile,
  type SkillProposalUpdateInput,
} from "./types.js";
import { assertWritableSkillTarget } from "./workspace-skill-read.js";

type SkillWorkshopWorkspaceOptions = {
  config?: OpenClawConfig;
  agentId?: string;
};

export class SkillProposalStaleTargetError extends Error {}

function proposalStoreOptions(env?: NodeJS.ProcessEnv) {
  return env ? { env } : {};
}

export function normalizeProposalOrigin(
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

export function mergeProposalOriginRunProvenance(
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
  const target = resolveSkillProposalTarget({ workspaceDir: input.workspaceDir, skillName: name });
  if ((await readWorkspaceSkillFile(target.skillFile)) !== null) {
    throw new Error(`Skill already exists at ${target.skillFile}.`);
  }

  const now = new Date().toISOString();
  const prepared = prepareSkillProposalDraft({
    name: target.skillKey,
    description,
    content: input.content,
    date: now,
    maxSkillBytes: config.maxSkillBytes,
    supportFiles: input.supportFiles,
    secretScanMetadata: [{ file: "skill-name", content: name }],
    goal: input.goal,
    evidence: input.evidence,
  });
  if (!prepared.ok) {
    throw prepared.error.cause;
  }
  const {
    content: proposalContent,
    draftHash,
    evidence,
    goal,
    scan,
    supportFiles,
  } = prepared.value;
  const id = createSkillProposalId(name);
  const origin = normalizeProposalOrigin({
    ...input.origin,
    agentId: input.origin?.agentId ?? input.agentId,
  });
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
    ...(input.autonomousCapture ? { autonomousCapture: true as const } : {}),
    ...(origin ? { origin } : {}),
    ...originRunProvenance,
    proposedVersion: "v1",
    draftFile: createSkillProposalGenerationDraftFile(),
    draftHash,
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
  const event = await writeSkillProposal({
    record,
    content: proposalContent,
    supportFiles,
    workspaceDir: input.workspaceDir,
    ownerAgentId: input.agentId,
    maxPending: config.maxPending,
    event: createSkillProposalEvent({
      record,
      type: "created",
      actor: input.eventActor,
    }),
    store: proposalStoreOptions(input.env),
  });
  await dispatchSkillProposalChanged({
    event,
    record,
    workspaceDir: input.workspaceDir,
    ...(input.agentId ? { agentId: input.agentId } : {}),
  });
  return { record, revisionHash: hashSkillProposalRevision(record), content: proposalContent };
}

/** Applies a reviewer patch to the live body: unique-match replace, or append when oldString is empty. */
export function composeSkillBodyPatch(
  body: string,
  patch: { oldString: string; newString: string },
): string {
  if (!patch.oldString) {
    if (!patch.newString.trim()) {
      throw new Error("Patch newString must not be empty when appending.");
    }
    return `${body.trimEnd()}\n\n${patch.newString.trim()}\n`;
  }
  const first = body.indexOf(patch.oldString);
  if (first === -1) {
    throw new Error(
      "Patch oldString not found in the live skill body. Read the skill and quote the exact current text.",
    );
  }
  if (body.includes(patch.oldString, first + 1)) {
    throw new Error(
      "Patch oldString matches more than once in the live skill body. Quote a longer unique span.",
    );
  }
  return `${body.slice(0, first)}${patch.newString}${body.slice(first + patch.oldString.length)}`;
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
  if (
    !isWorkshopOwnedSkillDir(
      input.workspaceDir,
      targetSkill.baseDir,
      proposalStoreOptions(input.env),
    )
  ) {
    throw new Error(`Skill Workshop does not own this skill path: ${targetSkill.skillKey}`);
  }
  const currentContent = await readWorkspaceSkillFile(targetSkill.filePath);
  if (currentContent === null) {
    throw new Error(`Skill file is missing: ${targetSkill.filePath}`);
  }
  if (
    input.expectedCurrentContentHash !== undefined &&
    sha256Hex(currentContent) !== input.expectedCurrentContentHash
  ) {
    throw new SkillProposalStaleTargetError(
      "Skill changed since the reviewer's read: read it again and redraft the update.",
    );
  }
  // Composition uses the same read that currentContentHash binds the proposal to, so a
  // composed draft can never derive from a different body than the one apply validates.
  const draftContent =
    input.composePatch !== undefined
      ? composeSkillBodyPatch(stripProposalFrontmatterForSkill(currentContent), input.composePatch)
      : input.content;
  if (draftContent === undefined) {
    throw new Error("Update proposal requires content or composePatch.");
  }
  const description = resolveUpdateProposalDescription(input.description, targetSkill.description);

  const now = new Date().toISOString();
  const prepared = prepareSkillProposalDraft({
    name: targetSkill.skillKey,
    description,
    content: draftContent,
    fallbackFrontmatterContent: currentContent,
    date: now,
    maxSkillBytes: config.maxSkillBytes,
    supportFiles: input.supportFiles,
    goal: input.goal,
    evidence: input.evidence,
  });
  if (!prepared.ok) {
    throw prepared.error.cause;
  }
  const {
    content: proposalContent,
    draftHash,
    evidence,
    goal,
    scan,
    supportFiles,
  } = prepared.value;
  const id = createSkillProposalId(targetSkill.skillKey || targetSkill.name);
  const origin = normalizeProposalOrigin({
    ...input.origin,
    agentId: input.origin?.agentId ?? input.agentId,
  });
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
    ...(input.autonomousCapture ? { autonomousCapture: true as const } : {}),
    ...(origin ? { origin } : {}),
    ...originRunProvenance,
    proposedVersion: "v1",
    draftFile: createSkillProposalGenerationDraftFile(),
    draftHash,
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
  const event = await writeSkillProposal({
    record,
    content: proposalContent,
    supportFiles,
    workspaceDir: input.workspaceDir,
    ownerAgentId: input.agentId ?? origin?.agentId,
    maxPending: config.maxPending,
    event: createSkillProposalEvent({
      record,
      type: "created",
      actor: input.eventActor,
    }),
    store: proposalStoreOptions(input.env),
  });
  await dispatchSkillProposalChanged({
    event,
    record,
    workspaceDir: input.workspaceDir,
    ...(input.agentId ? { agentId: input.agentId } : {}),
  });
  return { record, revisionHash: hashSkillProposalRevision(record), content: proposalContent };
}

export async function buildSupportFileMetadata(
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

function normalizeRequired(value: string, label: string): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    throw new Error(`${label} is required.`);
  }
  return normalized;
}

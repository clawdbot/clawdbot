import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import {
  readWorkspaceSkillFile,
  readWorkspaceSupportFile,
} from "../lifecycle/workspace-skill-write.js";
import { resolveSkillWorkshopConfig } from "./config.js";
import { stripProposalFrontmatterForSkill } from "./frontmatter.js";
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
import { readWritableWorkshopSkill } from "./workspace-skill-read.js";

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
  const target = resolveSkillProposalTarget({
    skillName: name,
    config: input.config ?? {},
    agentId: requireWorkshopAgentId(input.agentId),
    ...(input.env ? { env: input.env } : {}),
  });
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
      source: "openclaw-workshop",
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
    ownerAgentId: requireWorkshopAgentId(input.agentId),
    maxPending: config.maxPending,
    event: createSkillProposalEvent({
      record,
      type: "created",
      actor: input.eventActor,
    }),
    store: { ...proposalStoreOptions(input.env), agentId: requireWorkshopAgentId(input.agentId) },
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
  const { start, end } = findUniqueSkillPatchSpan(body, patch.oldString);
  return `${body.slice(0, start)}${patch.newString}${body.slice(end)}`;
}

/** Resolves the one exact live-body span that a targeted patch may replace. */
export function findUniqueSkillPatchSpan(
  body: string,
  oldString: string,
): { start: number; end: number } {
  const first = body.indexOf(oldString);
  if (first === -1) {
    throw new Error(
      "Patch oldString not found in the live skill body. Read the skill and quote the exact current text.",
    );
  }
  if (body.includes(oldString, first + 1)) {
    throw new Error(
      "Patch oldString matches more than once in the live skill body. Quote a longer unique span.",
    );
  }
  return { start: first, end: first + oldString.length };
}

export async function proposeUpdateSkill(
  input: SkillProposalUpdateInput & SkillWorkshopWorkspaceOptions,
): Promise<SkillProposalReadResult> {
  const skillName = normalizeRequired(input.skillName, "Skill name");
  const config = resolveSkillWorkshopConfig(input.config);
  const target = await readWritableWorkshopSkill(skillName, {
    config: input.config,
    agentId: requireWorkshopAgentId(input.agentId),
    env: input.env,
  });
  const currentContent = target.content;
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
  const description = resolveUpdateProposalDescription(input.description, target.description);

  const now = new Date().toISOString();
  const prepared = prepareSkillProposalDraft({
    name: target.skillName,
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
  const id = createSkillProposalId(target.skillKey);
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
    title: `Update ${target.skillName}`,
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
      skillName: target.skillName,
      skillKey: target.skillKey,
      skillDir: target.baseDir,
      skillFile: target.skillFile,
      source: "openclaw-workshop",
      currentContentHash: hashSkillProposalContent(currentContent),
    },
    scan,
    ...(supportFiles.length > 0
      ? { supportFiles: await buildSupportFileMetadata(supportFiles, target.baseDir) }
      : {}),
    ...(goal ? { goal } : {}),
    ...(evidence ? { evidence } : {}),
  };
  const event = await writeSkillProposal({
    record,
    content: proposalContent,
    supportFiles,
    ownerAgentId: requireWorkshopAgentId(input.agentId),
    maxPending: config.maxPending,
    event: createSkillProposalEvent({
      record,
      type: "created",
      actor: input.eventActor,
    }),
    store: { ...proposalStoreOptions(input.env), agentId: requireWorkshopAgentId(input.agentId) },
  });
  await dispatchSkillProposalChanged({
    event,
    record,
    workspaceDir: input.workspaceDir,
    ...(input.agentId ? { agentId: input.agentId } : {}),
  });
  return { record, revisionHash: hashSkillProposalRevision(record), content: proposalContent };
}

function requireWorkshopAgentId(agentId: string | undefined): string {
  if (!agentId) {
    throw new Error("Skill Workshop requires the active agent id.");
  }
  return agentId;
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

import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  assertInsideWorkspace,
  readWorkspaceSkillFile,
  readWorkspaceSupportFile,
} from "../lifecycle/workspace-skill-write.js";
import {
  applySkillProposalTransition,
  assertSkillProposalSupportTargetUnchanged,
  markSkillProposalStale,
  withSkillProposalLifecycleDispatch,
  type SkillProposalApplyTransitionDependencies,
  type SkillProposalTransitionInput,
} from "./apply-transition.js";
import { resolveSkillWorkshopConfig } from "./config.js";
import { createSkillProposalEvent, dispatchSkillProposalChanged } from "./plugin-hooks.js";
import { nextProposalVersion, prepareSkillProposalDraft } from "./proposal-draft.js";
import { createSkillProposalGenerationDraftFile } from "./proposal-generation.js";
import { hashSkillProposalRevision } from "./revision-hash.js";
import {
  assertExpectedRevisionHash,
  evaluateSkillProposal,
  SkillProposalCreateTargetConflictError,
} from "./service-evaluation.js";
import {
  buildSupportFileMetadata,
  mergeProposalOriginRunProvenance,
  normalizeProposalOrigin,
} from "./service-propose.js";
import { readRequiredProposal } from "./service-query.js";
import {
  hashSkillProposalContent,
  readSkillProposalRecord,
  replaceSkillProposalDraft,
  updateSkillProposalRecord,
  withSkillProposalTargetLock,
} from "./store.js";
import type {
  SkillProposalActionInput,
  SkillProposalApplyResult,
  SkillProposalReadResult,
  SkillProposalRecord,
  SkillProposalReviseInput,
} from "./types.js";
export { readSkillProposalDraftDirectory, readSkillProposalDraftFile } from "./proposal-draft.js";
export {
  composeSkillBodyPatch,
  findUniqueSkillPatchSpan,
  proposeCreateSkill,
  proposeUpdateSkill,
  SkillProposalStaleTargetError,
} from "./service-propose.js";
export {
  getSkillProposalRunProgress,
  inspectSkillProposal,
  listSkillProposals,
  resolvePendingSkillProposal,
} from "./service-query.js";
export { evaluateSkillProposal, listSkillProposalEvents } from "./service-evaluation.js";

function proposalStoreOptions(env?: NodeJS.ProcessEnv) {
  return env ? { env } : {};
}

const APPLY_TRANSITION_DEPENDENCIES = {
  assertExpectedRevisionHash,
  evaluateSkillProposal,
  isCreateTargetConflict: (error: unknown) =>
    error instanceof SkillProposalCreateTargetConflictError,
  readRequiredProposal,
} satisfies SkillProposalApplyTransitionDependencies;

export async function reviseSkillProposal(
  input: SkillProposalReviseInput,
): Promise<SkillProposalReadResult> {
  if (
    input.content === undefined &&
    input.supportFiles === undefined &&
    input.description === undefined &&
    input.goal === undefined &&
    input.evidence === undefined
  ) {
    throw new Error("Skill proposal revision requires at least one changed field.");
  }
  const config = resolveSkillWorkshopConfig(input.config);
  const revision = withPendingSkillProposalRevision(input, async (read) => {
    const { record } = read;
    assertInsideWorkspace(input.workspaceDir, record.target.skillFile, "skill file");
    assertInsideWorkspace(input.workspaceDir, record.target.skillDir, "skill directory");

    if (record.kind === "create") {
      const currentContent = await readWorkspaceSkillFile(record.target.skillFile);
      if (currentContent !== null) {
        await markSkillProposalStale({
          record,
          reason: "Target skill was created after proposal creation.",
          message: "Target skill was created after proposal creation; proposal marked stale.",
          input,
        });
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
        await markSkillProposalStale({
          record,
          reason: "Target skill changed after proposal creation.",
          message: "Target skill changed after proposal creation; proposal marked stale.",
          input,
        });
      }
      await assertSupportTargetsUnchanged(record, input);
    }

    const supportFiles =
      input.supportFiles === undefined ? (read.supportFiles ?? []) : input.supportFiles;
    const requestedContent = input.content ?? read.content;
    const nextVersion = nextProposalVersion(record.proposedVersion);
    const description = normalizeOptionalString(input.description) ?? record.description;
    const now = new Date().toISOString();
    const prepared = prepareSkillProposalDraft({
      name: record.target.skillKey,
      description,
      content: requestedContent,
      fallbackFrontmatterContent: read.content,
      version: nextVersion,
      date: now,
      maxSkillBytes: config.maxSkillBytes,
      supportFiles,
      goal: input.goal === undefined ? record.goal : input.goal,
      evidence: input.evidence === undefined ? record.evidence : input.evidence,
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
      supportFiles: preparedSupportFiles,
    } = prepared.value;
    const supportFileMetadata =
      preparedSupportFiles.length > 0
        ? await buildSupportFileMetadata(
            preparedSupportFiles,
            record.kind === "update" ? record.target.skillDir : undefined,
          )
        : [];
    const origin = normalizeProposalOrigin(input.origin);
    const originRunProvenance = mergeProposalOriginRunProvenance(record, origin);
    const revised: SkillProposalRecord = {
      ...record,
      description,
      updatedAt: now,
      proposedVersion: nextVersion,
      draftFile: createSkillProposalGenerationDraftFile(),
      draftHash,
      scan,
      ...(origin ? { origin } : {}),
      ...originRunProvenance,
    };
    delete revised.evaluation;
    if (preparedSupportFiles.length > 0) {
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
    const event = await replaceSkillProposalDraft({
      expected: record,
      record: revised,
      content: proposalContent,
      supportFiles: preparedSupportFiles,
      event: createSkillProposalEvent({
        record: revised,
        type: "revised",
        actor: input.eventActor,
        ...(input.correlationId ? { correlationId: input.correlationId } : {}),
        occurredAt: now,
      }),
      store: proposalStoreOptions(input.env),
    });
    return {
      read: {
        record: revised,
        revisionHash: hashSkillProposalRevision(revised),
        content: proposalContent,
      },
      event,
    };
  });
  const revisedResult = await withSkillProposalLifecycleDispatch(input, revision);
  await dispatchSkillProposalChanged({
    event: revisedResult.event,
    record: revisedResult.read.record,
    workspaceDir: input.workspaceDir,
    ...(input.agentId ? { agentId: input.agentId } : {}),
  });
  return revisedResult.read;
}

export async function rejectSkillProposal(
  input: SkillProposalActionInput,
): Promise<SkillProposalRecord> {
  return await markProposal(input, "rejected");
}

export async function quarantineSkillProposal(
  input: SkillProposalActionInput,
): Promise<SkillProposalRecord> {
  return await markProposal(input, "quarantined");
}

export async function applySkillProposal(
  input: SkillProposalActionInput,
): Promise<SkillProposalApplyResult> {
  return await applySkillProposalTransition(input, APPLY_TRANSITION_DEPENDENCIES);
}

async function markProposal(
  input: SkillProposalActionInput,
  status: "quarantined" | "rejected",
): Promise<SkillProposalRecord> {
  const scope = {
    ...(input.agentId ? { agentId: input.agentId } : {}),
    workspaceDir: input.workspaceDir,
  };
  const initial = await readSkillProposalRecord(
    input.proposalId,
    proposalStoreOptions(input.env),
    scope,
    input.config ? { config: input.config } : undefined,
  );
  if (!initial) {
    throw new Error(`Skill proposal not found: ${input.proposalId}`);
  }
  const result = await withSkillProposalTargetLock(
    initial,
    async () => {
      const current = await readSkillProposalRecord(
        input.proposalId,
        proposalStoreOptions(input.env),
        scope,
        { reconcile: false },
      );
      if (!current) {
        throw new Error(`Skill proposal not found: ${input.proposalId}`);
      }
      if (current.status !== "pending") {
        throw new Error(
          `Only pending proposals can be ${status}. Current status: ${current.status}.`,
        );
      }
      assertExpectedRevisionHash(hashSkillProposalRevision(current), input.expectedRevisionHash);
      const now = new Date().toISOString();
      const base = {
        ...current,
        status,
        updatedAt: now,
        statusReason: normalizeOptionalString(input.reason),
      };
      const record: SkillProposalRecord =
        status === "rejected"
          ? { ...base, rejectedAt: now }
          : {
              ...base,
              quarantinedAt: now,
              scan: { ...current.scan, state: "quarantined" },
            };
      const event = await updateSkillProposalRecord({
        record,
        event: createSkillProposalEvent({
          record,
          type: status,
          actor: input.eventActor,
          ...(input.correlationId ? { correlationId: input.correlationId } : {}),
          occurredAt: now,
        }),
        store: proposalStoreOptions(input.env),
      });
      return { record, event };
    },
    proposalStoreOptions(input.env),
  );
  if (result.event) {
    await dispatchSkillProposalChanged({
      event: result.event,
      record: result.record,
      workspaceDir: input.workspaceDir,
      ...(input.agentId ? { agentId: input.agentId } : {}),
    });
  }
  return result.record;
}

async function withPendingSkillProposalRevision<T>(
  input: Pick<
    SkillProposalActionInput,
    "agentId" | "config" | "env" | "expectedRevisionHash" | "proposalId" | "workspaceDir"
  >,
  fn: (read: SkillProposalReadResult) => Promise<T>,
): Promise<T> {
  const recoveryReadOptions = input.config ? { config: input.config } : undefined;
  const lockedReadOptions = {
    ...(input.config ? { config: input.config } : {}),
    reconcile: false,
  };
  const initial = await readRequiredProposal(
    input.proposalId,
    input.workspaceDir,
    input.env,
    input.agentId,
    recoveryReadOptions,
  );
  return await withSkillProposalTargetLock(
    initial.record,
    async () => {
      const read = await readRequiredProposal(
        input.proposalId,
        input.workspaceDir,
        input.env,
        input.agentId,
        lockedReadOptions,
      );
      if (read.record.status !== "pending") {
        throw new Error(
          `Only pending proposals can be revised. Current status: ${read.record.status}.`,
        );
      }
      assertExpectedRevisionHash(read.revisionHash, input.expectedRevisionHash);
      if (hashSkillProposalContent(read.content) !== read.record.draftHash) {
        throw new Error("Proposal draft changed without updating proposal metadata.");
      }
      return await fn(read);
    },
    proposalStoreOptions(input.env),
  );
}

async function assertSupportTargetsUnchanged(
  record: SkillProposalRecord,
  input: SkillProposalTransitionInput,
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
    await assertSkillProposalSupportTargetUnchanged({ record, file, currentContent, input });
  }
}

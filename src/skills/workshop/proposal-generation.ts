import { randomUUID } from "node:crypto";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { syncDirectoryIfSupported } from "../../infra/directory-durability.js";
import { removePathWithinRoot } from "../../infra/fs-safe-remove.js";
import { FsSafeError, root } from "../../infra/fs-safe.js";
import { assertProposalId, PROPOSAL_DRAFT_FILE } from "./store-record.js";
import type { SkillWorkshopStoreOptions } from "./store-sqlite-schema.js";
import type {
  PreparedSkillProposalSupportFile,
  SkillProposalDraftFile,
  SkillProposalRecord,
} from "./types.js";

const WORKSHOP_REL_DIR = "skill-workshop";
const PROPOSALS_REL_DIR = path.join(WORKSHOP_REL_DIR, "proposals");
const PROPOSAL_GENERATIONS_REL_DIR = "generations";
const GENERATION_DRAFT_PATTERN =
  /^generations\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/PROPOSAL\.md$/u;

export function resolveSkillWorkshopStateDir(options: SkillWorkshopStoreOptions = {}): string {
  return path.resolve(options.stateDir ?? resolveStateDir(options.env));
}

function proposalRelativeDir(proposalId: string): string {
  assertProposalId(proposalId);
  return path.join(PROPOSALS_REL_DIR, proposalId);
}

export function createSkillProposalGenerationDraftFile(): SkillProposalDraftFile {
  return `${PROPOSAL_GENERATIONS_REL_DIR}/${randomUUID()}/${PROPOSAL_DRAFT_FILE}`;
}

export function proposalBundleRelativePath(
  record: SkillProposalRecord,
  relativePath: string,
): string {
  return path.join(proposalRelativeDir(record.id), path.dirname(record.draftFile), relativePath);
}

export async function stageSkillProposalGeneration(params: {
  record: SkillProposalRecord;
  content: string;
  supportFiles?: readonly PreparedSkillProposalSupportFile[];
  store?: SkillWorkshopStoreOptions;
}): Promise<void> {
  const generationId = proposalGenerationId(params.record.draftFile);
  if (!generationId) {
    throw new Error("Revised Skill Workshop proposals require a generation draft path.");
  }
  const stateDir = resolveSkillWorkshopStateDir(params.store);
  const stateRoot = await root(stateDir);
  const proposalDir = proposalRelativeDir(params.record.id);
  const stagingDir = path.join(
    proposalDir,
    PROPOSAL_GENERATIONS_REL_DIR,
    `.staging-${generationId}`,
  );
  const generationsDir = path.join(proposalDir, PROPOSAL_GENERATIONS_REL_DIR);
  const generationDir = path.join(generationsDir, generationId);
  try {
    await stateRoot.mkdir(stagingDir);
    await createDurableGenerationFile(
      stateRoot,
      path.join(stagingDir, PROPOSAL_DRAFT_FILE),
      params.content,
    );
    for (const file of params.supportFiles ?? []) {
      await createDurableGenerationFile(stateRoot, path.join(stagingDir, file.path), file.content);
    }
    // The record only names the destination after this same-filesystem move, so
    // readers can never observe a partially populated generation.
    await stateRoot.move(stagingDir, generationDir, { overwrite: true });
    await syncDirectoryIfSupported(path.join(stateDir, generationsDir));
  } catch (error) {
    await removeGenerationPath(stateDir, stagingDir).catch(() => undefined);
    await removeGenerationPath(stateDir, generationDir).catch(() => undefined);
    throw error;
  }
}

async function createDurableGenerationFile(
  stateRoot: Awaited<ReturnType<typeof root>>,
  relativePath: string,
  content: string,
): Promise<void> {
  await stateRoot.create(relativePath, content, { encoding: "utf8", mkdir: true });
  const opened = await stateRoot.openWritable(relativePath, { writeMode: "update" });
  try {
    await opened.handle.sync();
  } finally {
    await opened.handle.close();
  }
}

export async function discardSkillProposalGeneration(
  record: SkillProposalRecord,
  store?: SkillWorkshopStoreOptions,
): Promise<void> {
  const generationId = proposalGenerationId(record.draftFile);
  if (!generationId) {
    return;
  }
  await removeGenerationPath(
    resolveSkillWorkshopStateDir(store),
    path.join(proposalRelativeDir(record.id), PROPOSAL_GENERATIONS_REL_DIR, generationId),
  );
}

/** Removes generations left unowned by a pre-commit crash. Caller holds the target lease. */
export async function cleanupSkillProposalGenerations(
  record: SkillProposalRecord,
  store?: SkillWorkshopStoreOptions,
): Promise<void> {
  const stateDir = resolveSkillWorkshopStateDir(store);
  const stateRoot = await root(stateDir);
  const proposalDir = proposalRelativeDir(record.id);
  const generationsDir = path.join(proposalDir, PROPOSAL_GENERATIONS_REL_DIR);
  let entries: string[];
  try {
    entries = await stateRoot.list(generationsDir);
  } catch (error) {
    if (error instanceof FsSafeError && error.code === "not-found") {
      return;
    }
    throw error;
  }
  const activeGenerationId = proposalGenerationId(record.draftFile);
  for (const entry of entries) {
    if (entry === activeGenerationId) {
      continue;
    }
    await removeGenerationPath(stateDir, path.join(generationsDir, entry));
  }
  if (!activeGenerationId) {
    return;
  }
  await retireLegacyProposalBundle(record, store);
}

function proposalGenerationId(draftFile: SkillProposalDraftFile): string | null {
  return GENERATION_DRAFT_PATTERN.exec(draftFile)?.[1] ?? null;
}

async function retireLegacyProposalBundle(
  record: SkillProposalRecord,
  store?: SkillWorkshopStoreOptions,
): Promise<void> {
  const stateDir = resolveSkillWorkshopStateDir(store);
  const stateRoot = await root(stateDir);
  const proposalDir = proposalRelativeDir(record.id);
  let entries: string[];
  try {
    entries = await stateRoot.list(proposalDir);
  } catch (error) {
    if (error instanceof FsSafeError && error.code === "not-found") {
      return;
    }
    throw error;
  }
  for (const entry of entries) {
    if (entry !== PROPOSAL_GENERATIONS_REL_DIR) {
      await removeGenerationPath(stateDir, path.join(proposalDir, entry));
    }
  }
}

async function removeGenerationPath(stateDir: string, relativePath: string): Promise<void> {
  await removePathWithinRoot({
    rootDir: stateDir,
    relativePath,
    recursive: true,
  });
}

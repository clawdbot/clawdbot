// Workshop store persists generated skill drafts and metadata under the workspace.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveStateDir } from "../../config/paths.js";
import { type FileLockOptions, withFileLock } from "../../infra/file-lock.js";
import { pathExists, root } from "../../infra/fs-safe.js";
import { tryReadJson } from "../../infra/json-files.js";
import { isPathInside } from "../../infra/path-safety.js";
import { normalizeSkillIndexName } from "../discovery/skill-index.js";
import {
  SKILL_WORKSHOP_MANIFEST_SCHEMA,
  SKILL_WORKSHOP_ROLLBACK_SCHEMA,
  SKILL_WORKSHOP_SCHEMA,
  type SkillProposalManifest,
  type SkillProposalManifestEntry,
  type SkillProposalReadResult,
  type SkillProposalRecord,
  type SkillProposalRollback,
  type SkillProposalSupportFile,
  type SkillProposalSupportFileInput,
} from "./types.js";

const WORKSHOP_REL_DIR = "skill-workshop";
const PROPOSALS_REL_DIR = path.join(WORKSHOP_REL_DIR, "proposals");
const TARGET_LOCKS_REL_DIR = path.join(WORKSHOP_REL_DIR, "locks");
const MANIFEST_REL_PATH = path.join(WORKSHOP_REL_DIR, "proposals.json");
const MANIFEST_LOCK_REL_PATH = path.join(TARGET_LOCKS_REL_DIR, "proposals-manifest");
const PROPOSAL_RECORD_FILE = "proposal.json";
const PROPOSAL_DRAFT_FILE = "PROPOSAL.md";
const PROPOSAL_ROLLBACK_FILE = "rollback.json";
/** Maximum bytes accepted for a proposal draft. */
export const MAX_PROPOSAL_BYTES = 1024 * 1024;
export const MAX_PROPOSAL_SUPPORT_FILE_BYTES = 256 * 1024;
export const MAX_PROPOSAL_SUPPORT_FILES = 64;
export const MAX_PROPOSAL_SUPPORT_FILES_TOTAL_BYTES = 2 * 1024 * 1024;
const ALLOWED_SUPPORT_FILE_ROOTS = new Set([
  "assets",
  "examples",
  "references",
  "scripts",
  "templates",
]);
const PROPOSAL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{5,120}$/;
const SKILL_WORKSHOP_LOCK_OPTIONS: FileLockOptions = {
  retries: {
    retries: 8,
    factor: 1.35,
    minTimeout: 10,
    maxTimeout: 250,
    randomize: true,
  },
  stale: 60_000,
};
const skillWorkshopProcessLocks = new Map<string, Promise<void>>();

type SkillWorkshopStoreOptions = {
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
};

export type PreparedSkillProposalSupportFile = SkillProposalSupportFile & {
  content: string;
};
type SkillProposalWriteGuard = (manifest: SkillProposalManifest) => Promise<void> | void;

/** Creates a stable proposal id from skill name, date, and random suffix. */
export function createSkillProposalId(name: string, now = new Date()): string {
  const normalized = normalizeSkillIndexName(name) || "skill";
  const date = now.toISOString().slice(0, 10).replaceAll("-", "");
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
  return `${normalized.slice(0, 60)}-${date}-${suffix}`;
}

export function hashSkillProposalContent(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function contentSizeBytes(content: string): number {
  return Buffer.byteLength(content, "utf8");
}

export function assertSkillProposalContentSize(content: string): void {
  if (contentSizeBytes(content) > MAX_PROPOSAL_BYTES) {
    throw new Error("Skill proposal is too large.");
  }
}

function resolveSkillWorkshopStateDir(options: SkillWorkshopStoreOptions = {}): string {
  return path.resolve(options.stateDir ?? resolveStateDir(options.env));
}

export function resolveWorkshopPath(options: SkillWorkshopStoreOptions = {}): string {
  return path.join(resolveSkillWorkshopStateDir(options), WORKSHOP_REL_DIR);
}

export function resolveProposalDir(
  proposalId: string,
  options: SkillWorkshopStoreOptions = {},
): string {
  assertProposalId(proposalId);
  return path.join(resolveSkillWorkshopStateDir(options), proposalRelativeDir(proposalId));
}

export function resolveProposalRecordPath(
  proposalId: string,
  options: SkillWorkshopStoreOptions = {},
): string {
  return path.join(resolveProposalDir(proposalId, options), PROPOSAL_RECORD_FILE);
}

export function resolveProposalDraftPath(
  proposalId: string,
  options: SkillWorkshopStoreOptions = {},
): string {
  return path.join(resolveProposalDir(proposalId, options), PROPOSAL_DRAFT_FILE);
}

export function normalizeSkillProposalSupportPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Support file path is required.");
  }
  if (trimmed.includes("\\")) {
    throw new Error("Support file paths must use forward slashes.");
  }
  if (path.posix.isAbsolute(trimmed)) {
    throw new Error("Support file paths must be relative.");
  }
  const rawParts = trimmed.split("/");
  if (rawParts.some((part) => !part || part === "." || part === ".." || part.startsWith("."))) {
    throw new Error("Support file paths must use plain relative path segments.");
  }
  const normalized = path.posix.normalize(trimmed);
  if (
    !normalized ||
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    throw new Error("Support file paths must stay inside the skill directory.");
  }
  const parts = normalized.split("/");
  if (!ALLOWED_SUPPORT_FILE_ROOTS.has(parts[0] ?? "")) {
    throw new Error(
      `Support file paths must be under one of: ${[...ALLOWED_SUPPORT_FILE_ROOTS].join(", ")}.`,
    );
  }
  if (normalized === PROPOSAL_DRAFT_FILE || normalized === "SKILL.md") {
    throw new Error("Support files cannot replace the proposal or skill markdown file.");
  }
  return normalized;
}

export function prepareSkillProposalSupportFiles(
  input: readonly SkillProposalSupportFileInput[] | undefined,
): PreparedSkillProposalSupportFile[] {
  if (!input || input.length === 0) {
    return [];
  }
  if (input.length > MAX_PROPOSAL_SUPPORT_FILES) {
    throw new Error(`A skill proposal can include at most ${MAX_PROPOSAL_SUPPORT_FILES} files.`);
  }
  const seen = new Set<string>();
  let totalBytes = 0;
  const files: PreparedSkillProposalSupportFile[] = [];
  for (const file of input) {
    const filePath = normalizeSkillProposalSupportPath(file.path);
    if (seen.has(filePath)) {
      throw new Error(`Duplicate support file path: ${filePath}`);
    }
    seen.add(filePath);
    const sizeBytes = contentSizeBytes(file.content);
    if (sizeBytes > MAX_PROPOSAL_SUPPORT_FILE_BYTES) {
      throw new Error(`Support file is too large: ${filePath}`);
    }
    if (file.content.includes("\0")) {
      throw new Error(`Support files must be UTF-8 text: ${filePath}`);
    }
    totalBytes += sizeBytes;
    if (totalBytes > MAX_PROPOSAL_SUPPORT_FILES_TOTAL_BYTES) {
      throw new Error("Skill proposal support files exceed the total size limit.");
    }
    files.push({
      path: filePath,
      sizeBytes,
      hash: hashSkillProposalContent(file.content),
      content: file.content,
    });
  }
  assertSupportPathSetIsFileOnly(files.map((file) => file.path));
  return files;
}

function assertSupportPathSetIsFileOnly(paths: readonly string[]): void {
  const sorted = paths.toSorted((a, b) => a.localeCompare(b));
  for (const filePath of sorted) {
    if (!filePath.includes("/")) {
      throw new Error("Support file paths must include a file below an allowed support directory.");
    }
  }
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (previous && current?.startsWith(`${previous}/`)) {
      throw new Error(`Support file paths cannot overlap: ${previous} and ${current}`);
    }
  }
}

export function resolveSkillProposalTarget(params: { workspaceDir: string; skillName: string }): {
  skillKey: string;
  skillDir: string;
  skillFile: string;
} {
  const skillKey = normalizeSkillIndexName(params.skillName);
  if (!skillKey) {
    throw new Error("Skill name must contain at least one letter or number.");
  }
  const skillDir = path.resolve(params.workspaceDir, "skills", skillKey);
  const skillFile = path.join(skillDir, "SKILL.md");
  assertInsideWorkspace(params.workspaceDir, skillDir, "skill directory");
  assertInsideWorkspace(params.workspaceDir, skillFile, "skill file");
  return { skillKey, skillDir, skillFile };
}

export async function readSkillProposal(
  proposalId: string,
  options: SkillWorkshopStoreOptions = {},
): Promise<SkillProposalReadResult | null> {
  const record = await readSkillProposalRecord(proposalId, options);
  if (!record) {
    return null;
  }
  const stateRoot = await root(resolveSkillWorkshopStateDir(options));
  const draft = await stateRoot.read(
    path.join(proposalRelativeDir(proposalId), PROPOSAL_DRAFT_FILE),
    {
      hardlinks: "reject",
      maxBytes: MAX_PROPOSAL_BYTES,
      symlinks: "reject",
    },
  );
  return { record, content: draft.buffer.toString("utf8") };
}

export async function readSkillProposalRecord(
  proposalId: string,
  options: SkillWorkshopStoreOptions = {},
): Promise<SkillProposalRecord | null> {
  const raw = await tryReadJson<unknown>(resolveProposalRecordPath(proposalId, options));
  return parseSkillProposalRecord(raw);
}

export async function writeSkillProposal(params: {
  record: SkillProposalRecord;
  content: string;
  supportFiles?: readonly PreparedSkillProposalSupportFile[];
  beforeWrite?: SkillProposalWriteGuard;
  store?: SkillWorkshopStoreOptions;
}): Promise<void> {
  assertProposalId(params.record.id);
  assertSkillProposalContentSize(params.content);
  await withSkillProposalManifestLock(params.store ?? {}, async () => {
    const manifest = await readSkillProposalManifestUnlocked(params.store);
    await params.beforeWrite?.(manifest);
    await writeSkillProposalFiles(params);
    await refreshSkillProposalManifestUnlocked(params.store);
  });
}

async function writeSkillProposalFiles(params: {
  record: SkillProposalRecord;
  content: string;
  supportFiles?: readonly PreparedSkillProposalSupportFile[];
  store?: SkillWorkshopStoreOptions;
}): Promise<void> {
  const stateRoot = await root(resolveSkillWorkshopStateDir(params.store));
  const relativeDir = proposalRelativeDir(params.record.id);
  await stateRoot.mkdir(relativeDir);
  await stateRoot.write(path.join(relativeDir, PROPOSAL_DRAFT_FILE), params.content, {
    encoding: "utf8",
  });
  for (const file of params.supportFiles ?? []) {
    await stateRoot.write(path.join(relativeDir, file.path), file.content, {
      encoding: "utf8",
      mkdir: true,
    });
  }
  await stateRoot.writeJson(path.join(relativeDir, PROPOSAL_RECORD_FILE), params.record, {
    trailingNewline: true,
  });
}

export async function replaceSkillProposalDraft(params: {
  record: SkillProposalRecord;
  previousSupportFiles?: readonly SkillProposalSupportFile[];
  content: string;
  supportFiles?: readonly PreparedSkillProposalSupportFile[];
  store?: SkillWorkshopStoreOptions;
}): Promise<void> {
  assertProposalId(params.record.id);
  assertSkillProposalContentSize(params.content);
  const stateRoot = await root(resolveSkillWorkshopStateDir(params.store));
  const relativeDir = proposalRelativeDir(params.record.id);
  await stateRoot.write(path.join(relativeDir, PROPOSAL_DRAFT_FILE), params.content, {
    encoding: "utf8",
  });
  const nextSupportPaths = new Set<string>();
  for (const file of params.supportFiles ?? []) {
    nextSupportPaths.add(file.path);
    await stateRoot.write(path.join(relativeDir, file.path), file.content, {
      encoding: "utf8",
      mkdir: true,
    });
  }
  await stateRoot.writeJson(path.join(relativeDir, PROPOSAL_RECORD_FILE), params.record, {
    trailingNewline: true,
  });
  for (const file of params.previousSupportFiles ?? []) {
    const filePath = normalizeSkillProposalSupportPath(file.path);
    if (!nextSupportPaths.has(filePath)) {
      await stateRoot.remove(path.join(relativeDir, filePath)).catch(() => undefined);
    }
  }
  await refreshSkillProposalManifest(params.store);
}

export async function updateSkillProposalRecord(params: {
  record: SkillProposalRecord;
  store?: SkillWorkshopStoreOptions;
}): Promise<void> {
  assertProposalId(params.record.id);
  const stateRoot = await root(resolveSkillWorkshopStateDir(params.store));
  await stateRoot.writeJson(
    path.join(proposalRelativeDir(params.record.id), PROPOSAL_RECORD_FILE),
    params.record,
    { trailingNewline: true },
  );
  await refreshSkillProposalManifest(params.store);
}

export async function withSkillProposalTargetLock<T>(
  record: SkillProposalRecord,
  fn: () => Promise<T>,
  options: SkillWorkshopStoreOptions = {},
): Promise<T> {
  const lockFile = path.join(
    resolveSkillWorkshopStateDir(options),
    TARGET_LOCKS_REL_DIR,
    `${hashSkillProposalContent(record.target.skillFile)}.target`,
  );
  return await withSkillWorkshopLock(lockFile, fn);
}

export async function writeSkillProposalRollback(params: {
  proposalId: string;
  rollback: SkillProposalRollback;
  store?: SkillWorkshopStoreOptions;
}): Promise<void> {
  const stateRoot = await root(resolveSkillWorkshopStateDir(params.store));
  await stateRoot.writeJson(
    path.join(proposalRelativeDir(params.proposalId), PROPOSAL_ROLLBACK_FILE),
    params.rollback,
    { trailingNewline: true },
  );
}

export async function readSkillProposalManifest(
  options: SkillWorkshopStoreOptions = {},
): Promise<SkillProposalManifest> {
  return await readSkillProposalManifestUnlocked(options);
}

async function readSkillProposalManifestUnlocked(
  options: SkillWorkshopStoreOptions = {},
): Promise<SkillProposalManifest> {
  const manifestPath = path.join(resolveSkillWorkshopStateDir(options), MANIFEST_REL_PATH);
  const parsed = parseSkillProposalManifest(await tryReadJson<unknown>(manifestPath));
  if (parsed) {
    return parsed;
  }
  return await refreshSkillProposalManifestUnlocked(options);
}

export async function refreshSkillProposalManifest(
  options: SkillWorkshopStoreOptions = {},
): Promise<SkillProposalManifest> {
  return await withSkillProposalManifestLock(options, async () => {
    return await refreshSkillProposalManifestUnlocked(options);
  });
}

async function refreshSkillProposalManifestUnlocked(
  options: SkillWorkshopStoreOptions = {},
): Promise<SkillProposalManifest> {
  const stateRoot = await root(resolveSkillWorkshopStateDir(options));
  await stateRoot.mkdir(PROPOSALS_REL_DIR);
  const entries = await stateRoot.list(PROPOSALS_REL_DIR, { withFileTypes: true });
  const proposals: SkillProposalManifestEntry[] = [];

  for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory || !PROPOSAL_ID_PATTERN.test(entry.name)) {
      continue;
    }
    const record = await readSkillProposalRecord(entry.name, options);
    if (!record) {
      continue;
    }
    proposals.push(manifestEntryFromRecord(record));
  }

  const manifest: SkillProposalManifest = {
    schema: SKILL_WORKSHOP_MANIFEST_SCHEMA,
    updatedAt: new Date().toISOString(),
    proposals: proposals.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  };
  await stateRoot.writeJson(MANIFEST_REL_PATH, manifest, {
    mkdir: true,
    trailingNewline: true,
  });
  return manifest;
}

async function withSkillProposalManifestLock<T>(
  options: SkillWorkshopStoreOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const lockFile = path.join(resolveSkillWorkshopStateDir(options), MANIFEST_LOCK_REL_PATH);
  return await withSkillWorkshopLock(lockFile, fn);
}

async function withSkillWorkshopLock<T>(lockFile: string, fn: () => Promise<T>): Promise<T> {
  const lockKey = path.resolve(lockFile);
  const previous = skillWorkshopProcessLocks.get(lockKey) ?? Promise.resolve();
  let releaseQueued!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseQueued = resolve;
  });
  const previousDone = previous.catch(() => undefined);
  const queued = previousDone.then(() => current);
  skillWorkshopProcessLocks.set(lockKey, queued);
  await previousDone;
  await fs.mkdir(path.dirname(lockFile), { recursive: true });
  try {
    return await withFileLock(lockFile, SKILL_WORKSHOP_LOCK_OPTIONS, fn);
  } finally {
    releaseQueued();
    if (skillWorkshopProcessLocks.get(lockKey) === queued) {
      skillWorkshopProcessLocks.delete(lockKey);
    }
  }
}

export async function readWorkspaceSkillFile(filePath: string): Promise<string | null> {
  if (!(await pathExists(filePath))) {
    return null;
  }
  const skillRoot = await root(path.dirname(filePath));
  const read = await skillRoot.read(path.basename(filePath), {
    hardlinks: "reject",
    maxBytes: MAX_PROPOSAL_BYTES,
    symlinks: "reject",
  });
  return read.buffer.toString("utf8");
}

export async function readProposalSupportFiles(
  record: SkillProposalRecord,
  options: SkillWorkshopStoreOptions = {},
): Promise<PreparedSkillProposalSupportFile[]> {
  const stateRoot = await root(resolveSkillWorkshopStateDir(options));
  const out: PreparedSkillProposalSupportFile[] = [];
  for (const file of record.supportFiles ?? []) {
    const filePath = normalizeSkillProposalSupportPath(file.path);
    const read = await stateRoot.read(path.join(proposalRelativeDir(record.id), filePath), {
      hardlinks: "reject",
      maxBytes: MAX_PROPOSAL_SUPPORT_FILE_BYTES,
      symlinks: "reject",
    });
    const content = read.buffer.toString("utf8");
    const sizeBytes = contentSizeBytes(content);
    const hash = hashSkillProposalContent(content);
    if (file.sizeBytes !== sizeBytes || file.hash !== hash) {
      throw new Error(`Proposal support file changed without updating metadata: ${filePath}`);
    }
    out.push({ path: filePath, sizeBytes, hash, content });
  }
  assertSupportPathSetIsFileOnly(out.map((file) => file.path));
  return out;
}

export async function readWorkspaceSupportFile(params: {
  skillDir: string;
  relativePath: string;
}): Promise<string | null> {
  const relativePath = normalizeSkillProposalSupportPath(params.relativePath);
  const absolutePath = path.join(params.skillDir, ...relativePath.split("/"));
  if (!(await pathExists(absolutePath))) {
    return null;
  }
  const skillRoot = await root(params.skillDir);
  const read = await skillRoot.read(relativePath, {
    hardlinks: "reject",
    maxBytes: MAX_PROPOSAL_SUPPORT_FILE_BYTES,
    symlinks: "reject",
  });
  return read.buffer.toString("utf8");
}

export async function writeWorkspaceSkillFile(params: {
  workspaceDir: string;
  filePath: string;
  content: string;
  overwrite?: boolean;
}): Promise<void> {
  assertInsideWorkspace(params.workspaceDir, params.filePath, "skill file");
  const relativePath = path.relative(
    path.resolve(params.workspaceDir),
    path.resolve(params.filePath),
  );
  const workspaceRoot = await root(params.workspaceDir);
  await workspaceRoot.write(relativePath, params.content, {
    encoding: "utf8",
    mkdir: true,
    ...(params.overwrite === undefined ? {} : { overwrite: params.overwrite }),
  });
}

export async function writeWorkspaceSupportFile(params: {
  skillDir: string;
  relativePath: string;
  content: string;
  overwrite?: boolean;
}): Promise<void> {
  const relativePath = normalizeSkillProposalSupportPath(params.relativePath);
  await fs.mkdir(params.skillDir, { recursive: true });
  const skillRoot = await root(params.skillDir);
  await skillRoot.write(relativePath, params.content, {
    encoding: "utf8",
    mkdir: true,
    ...(params.overwrite === undefined ? {} : { overwrite: params.overwrite }),
  });
}

export async function removeWorkspaceSupportFile(params: {
  skillDir: string;
  relativePath: string;
}): Promise<void> {
  const relativePath = normalizeSkillProposalSupportPath(params.relativePath);
  const skillRoot = await root(params.skillDir);
  await skillRoot.remove(relativePath).catch((error: unknown) => {
    if ((error as { code?: string })?.code !== "ENOENT") {
      throw error;
    }
  });
}

export function createSkillProposalRollback(params: {
  proposalId: string;
  targetSkillFile: string;
  action: "create" | "update";
  previousContent?: string;
  supportFiles?: SkillProposalRollback["supportFiles"];
}): SkillProposalRollback {
  return {
    schema: SKILL_WORKSHOP_ROLLBACK_SCHEMA,
    proposalId: params.proposalId,
    writtenAt: new Date().toISOString(),
    targetSkillFile: params.targetSkillFile,
    action: params.action,
    ...(params.previousContent !== undefined
      ? {
          previousContent: params.previousContent,
          previousContentHash: hashSkillProposalContent(params.previousContent),
        }
      : {}),
    ...(params.supportFiles && params.supportFiles.length > 0
      ? { supportFiles: params.supportFiles }
      : {}),
  };
}

export function assertInsideWorkspace(workspaceDir: string, targetPath: string, label: string) {
  const resolvedWorkspaceDir = path.resolve(workspaceDir);
  const resolvedTarget = path.resolve(targetPath);
  if (
    resolvedTarget !== resolvedWorkspaceDir &&
    !isPathInside(resolvedWorkspaceDir, resolvedTarget)
  ) {
    throw new Error(`${label} must stay inside the workspace.`);
  }
}

export function assertProposalId(proposalId: string): void {
  if (!PROPOSAL_ID_PATTERN.test(proposalId)) {
    throw new Error("Invalid skill proposal id.");
  }
}

function manifestEntryFromRecord(record: SkillProposalRecord): SkillProposalManifestEntry {
  return {
    id: record.id,
    kind: record.kind,
    status: record.status,
    title: record.title,
    description: record.description,
    skillName: record.target.skillName,
    skillKey: record.target.skillKey,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    scanState: record.scan.state,
  };
}

function parseSkillProposalRecord(raw: unknown): SkillProposalRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw as SkillProposalRecord;
  if (
    record.schema !== SKILL_WORKSHOP_SCHEMA ||
    !PROPOSAL_ID_PATTERN.test(record.id) ||
    (record.kind !== "create" && record.kind !== "update") ||
    !["pending", "applied", "rejected", "quarantined", "stale"].includes(record.status) ||
    typeof record.title !== "string" ||
    typeof record.description !== "string" ||
    typeof record.createdAt !== "string" ||
    typeof record.updatedAt !== "string" ||
    typeof record.draftHash !== "string" ||
    record.draftFile !== PROPOSAL_DRAFT_FILE ||
    !isValidProposalOrigin(record.origin) ||
    !isValidSupportFileList(record.supportFiles) ||
    !record.target ||
    typeof record.target !== "object" ||
    typeof record.target.skillName !== "string" ||
    typeof record.target.skillKey !== "string" ||
    typeof record.target.skillDir !== "string" ||
    typeof record.target.skillFile !== "string" ||
    !record.scan ||
    typeof record.scan !== "object"
  ) {
    return null;
  }
  return record;
}

function isValidProposalOrigin(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const origin = value as Record<string, unknown>;
  for (const key of ["agentId", "sessionKey", "runId", "messageId"]) {
    const item = origin[key];
    if (item !== undefined && typeof item !== "string") {
      return false;
    }
  }
  return true;
}

function isValidSupportFileList(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  if (!Array.isArray(value) || value.length > MAX_PROPOSAL_SUPPORT_FILES) {
    return false;
  }
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return false;
    }
    const file = item as SkillProposalSupportFile;
    if (
      typeof file.path !== "string" ||
      typeof file.hash !== "string" ||
      !/^[a-f0-9]{64}$/i.test(file.hash) ||
      typeof file.sizeBytes !== "number" ||
      !Number.isSafeInteger(file.sizeBytes) ||
      file.sizeBytes < 0 ||
      file.sizeBytes > MAX_PROPOSAL_SUPPORT_FILE_BYTES ||
      (file.targetExisted !== undefined && typeof file.targetExisted !== "boolean") ||
      (file.targetContentHash !== undefined &&
        (typeof file.targetContentHash !== "string" ||
          !/^[a-f0-9]{64}$/i.test(file.targetContentHash)))
    ) {
      return false;
    }
    let normalized: string;
    try {
      normalized = normalizeSkillProposalSupportPath(file.path);
    } catch {
      return false;
    }
    if (seen.has(normalized)) {
      return false;
    }
    seen.add(normalized);
  }
  return true;
}

function parseSkillProposalManifest(raw: unknown): SkillProposalManifest | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const manifest = raw as SkillProposalManifest;
  if (
    manifest.schema !== SKILL_WORKSHOP_MANIFEST_SCHEMA ||
    typeof manifest.updatedAt !== "string" ||
    !Array.isArray(manifest.proposals)
  ) {
    return null;
  }
  const proposals = manifest.proposals.filter((entry) => {
    return (
      entry &&
      typeof entry === "object" &&
      PROPOSAL_ID_PATTERN.test(normalizeOptionalString(entry.id) ?? "") &&
      typeof entry.skillName === "string" &&
      typeof entry.skillKey === "string" &&
      typeof entry.updatedAt === "string"
    );
  });
  return { ...manifest, proposals };
}

function proposalRelativeDir(proposalId: string): string {
  assertProposalId(proposalId);
  return path.join(PROPOSALS_REL_DIR, proposalId);
}

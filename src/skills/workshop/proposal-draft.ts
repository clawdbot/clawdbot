import fs from "node:fs/promises";
import path from "node:path";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { readLocalFileSafely, root, walkDirectory } from "../../infra/fs-safe.js";
import {
  MAX_WORKSPACE_SKILL_SUPPORT_FILE_BYTES,
  normalizeWorkspaceSkillSupportPath,
} from "../lifecycle/workspace-skill-write.js";
import { renderProposalMarkdown } from "./frontmatter.js";
import { assertProposalContainsNoLiteralSecrets, scanProposalBundle } from "./proposal-scan.js";
import {
  hashSkillProposalContent,
  MAX_PROPOSAL_SUPPORT_FILES,
  prepareSkillProposalSupportFiles,
} from "./store.js";
import type {
  PreparedSkillProposalSupportFile,
  SkillProposalScan,
  SkillProposalSupportFileInput,
} from "./types.js";

const MAX_PROPOSAL_DRAFT_BYTES = 1024 * 1024;
const MAX_PROPOSAL_DIRECTORY_ENTRIES = MAX_PROPOSAL_SUPPORT_FILES * 4;
const MAX_SKILL_PROPOSAL_DESCRIPTION_BYTES = 160;

type SkillProposalDraftValidationError = {
  cause: Error;
  message: string;
};

type PreparedSkillProposalDraft = {
  content: string;
  description: string;
  draftHash: string;
  evidence?: string;
  goal?: string;
  scan: SkillProposalScan;
  supportFiles: PreparedSkillProposalSupportFile[];
};

export function prepareSkillProposalDraft(input: {
  name: string;
  description: string;
  content: string;
  fallbackFrontmatterContent?: string;
  version?: string;
  date: string;
  maxSkillBytes: number;
  supportFiles?: readonly SkillProposalSupportFileInput[];
  secretScanMetadata?: readonly { file: string; content: string | undefined }[];
  goal?: string;
  evidence?: string;
}): Result<PreparedSkillProposalDraft, SkillProposalDraftValidationError> {
  try {
    assertProposalDescriptionWithinLimit(input.description);
    assertProposalContentWithinLimit(input.content, input.maxSkillBytes);
    const supportFiles = prepareSkillProposalSupportFiles(input.supportFiles);
    const content = renderProposalMarkdown({
      name: input.name,
      description: input.description,
      content: input.content,
      fallbackFrontmatterContent: input.fallbackFrontmatterContent,
      version: input.version,
      date: input.date,
    });
    const goal = normalizeOptionalString(input.goal);
    const evidence = normalizeOptionalString(input.evidence);
    const scan = scanProposalBundle(content, supportFiles, [
      ...(input.secretScanMetadata ?? []),
      { file: "description", content: input.description },
      { file: "goal", content: goal },
      { file: "evidence", content: evidence },
    ]);
    assertProposalContainsNoLiteralSecrets(scan);
    return ok({
      content,
      description: input.description,
      draftHash: hashSkillProposalContent(content),
      scan,
      supportFiles,
      ...(goal ? { goal } : {}),
      ...(evidence ? { evidence } : {}),
    });
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    return err({ cause: error, message: error.message });
  }
}

export function resolveUpdateProposalDescription(
  inputDescription: string | undefined,
  currentDescription: string,
): string {
  const supplied = normalizeOptionalString(inputDescription);
  if (supplied) {
    return supplied;
  }
  return truncateUtf8(currentDescription.trim(), MAX_SKILL_PROPOSAL_DESCRIPTION_BYTES);
}

export function nextProposalVersion(version: string): string {
  const match = /^v(\d+)$/.exec(version.trim());
  if (!match) {
    return "v2";
  }
  const current = Number.parseInt(match[1] ?? "1", 10);
  return `v${Number.isSafeInteger(current) && current > 0 ? current + 1 : 2}`;
}

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

function assertProposalDescriptionWithinLimit(description: string): void {
  const sizeBytes = Buffer.byteLength(description, "utf8");
  if (sizeBytes > MAX_SKILL_PROPOSAL_DESCRIPTION_BYTES) {
    throw new Error(
      `Skill proposal description is too large (${sizeBytes} bytes, max ${MAX_SKILL_PROPOSAL_DESCRIPTION_BYTES}).`,
    );
  }
}

function assertProposalContentWithinLimit(content: string, maxSkillBytes: number): void {
  const sizeBytes = Buffer.byteLength(content, "utf8");
  if (sizeBytes > maxSkillBytes) {
    throw new Error(
      `Skill proposal content is too large (${sizeBytes} bytes, max ${maxSkillBytes}).`,
    );
  }
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

function toPortableRelativePath(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

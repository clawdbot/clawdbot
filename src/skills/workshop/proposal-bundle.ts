import path from "node:path";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { pathExists, root, walkDirectory } from "../../infra/fs-safe.js";
import type {
  PluginHookSkillBundleFile,
  PluginHookSkillBundleSnapshot,
} from "../../plugins/hook-types.js";
import { stripProposalFrontmatterForSkill } from "./frontmatter.js";
import type { PreparedSkillProposalSupportFile } from "./store.js";
import type { SkillProposalReadResult } from "./types.js";

const MAX_EVALUATION_FILES = 256;
const MAX_EVALUATION_FILE_BYTES = 1024 * 1024;
const MAX_EVALUATION_BUNDLE_BYTES = 8 * 1024 * 1024;
const EXCLUDED_ROOT_DIRS = new Set([".clawhub", ".clawdhub", ".openclaw"]);

export async function buildSkillProposalEvaluationBundles(params: {
  proposal: SkillProposalReadResult;
  supportFiles: readonly PreparedSkillProposalSupportFile[];
}): Promise<{
  candidate: PluginHookSkillBundleSnapshot;
  baseline?: PluginHookSkillBundleSnapshot;
  targetTreeSha256: string;
}> {
  const targetFiles = await readSkillTreeFiles(params.proposal.record.target.skillDir);
  const targetTreeSha256 = hashSkillTree(targetFiles);
  const skillMdPath =
    params.proposal.record.kind === "create"
      ? "SKILL.md"
      : resolveTargetSkillRelativePath(params.proposal, targetFiles, {
          recordedTargetExists: await pathExists(params.proposal.record.target.skillFile),
        });
  const candidateSkillMd = fileFromBuffer(
    skillMdPath,
    Buffer.from(stripProposalFrontmatterForSkill(params.proposal.content), "utf8"),
  );
  const proposedFiles = params.supportFiles.map((file) =>
    fileFromBuffer(file.path, Buffer.from(file.content, "utf8")),
  );
  const candidateFiles = new Map(targetFiles.map((file) => [file.path, file]));
  if (params.proposal.record.kind === "create") {
    if (await pathExists(params.proposal.record.target.skillFile)) {
      throw new Error(`Target skill already exists: ${params.proposal.record.target.skillFile}`);
    }
    candidateFiles.set(candidateSkillMd.path, candidateSkillMd);
    for (const file of proposedFiles) {
      const targetFile = path.join(params.proposal.record.target.skillDir, file.path);
      if (await pathExists(targetFile)) {
        throw new Error(`Target support file already exists: ${targetFile}`);
      }
      candidateFiles.set(file.path, file);
    }
    return {
      candidate: snapshotFromFiles([...candidateFiles.values()], skillMdPath),
      targetTreeSha256,
    };
  }

  const baseline = snapshotFromFiles(targetFiles, skillMdPath);
  candidateFiles.set(candidateSkillMd.path, candidateSkillMd);
  for (const file of proposedFiles) {
    candidateFiles.set(file.path, file);
  }
  return {
    baseline,
    candidate: snapshotFromFiles([...candidateFiles.values()], skillMdPath),
    targetTreeSha256,
  };
}

export async function readSkillProposalTargetTreeSha256(skillDir: string): Promise<string> {
  return hashSkillTree(await readSkillTreeFiles(skillDir));
}

async function readSkillTreeFiles(skillDir: string): Promise<PluginHookSkillBundleFile[]> {
  if (!(await pathExists(skillDir))) {
    return [];
  }
  const scanned = await walkDirectory(skillDir, {
    maxDepth: 16,
    maxEntries: MAX_EVALUATION_FILES * 2,
    symlinks: "include",
  });
  if (scanned.truncated) {
    throw new Error(`Skill evaluation bundle exceeds ${MAX_EVALUATION_FILES} files.`);
  }
  const skillRoot = await root(skillDir);
  const files: PluginHookSkillBundleFile[] = [];
  let totalBytes = 0;
  for (const entry of scanned.entries.toSorted((a, b) =>
    a.relativePath.localeCompare(b.relativePath),
  )) {
    const portablePath = entry.relativePath.split(path.sep).join("/");
    if (
      !portablePath ||
      EXCLUDED_ROOT_DIRS.has(portablePath.split("/")[0] ?? "") ||
      entry.kind === "directory"
    ) {
      continue;
    }
    if (entry.kind !== "file") {
      throw new Error(`Skill evaluation bundle contains unsupported entry: ${portablePath}`);
    }
    const read = await skillRoot.read(entry.relativePath, {
      hardlinks: "reject",
      maxBytes: MAX_EVALUATION_FILE_BYTES,
      symlinks: "reject",
    });
    totalBytes += read.buffer.byteLength;
    if (totalBytes > MAX_EVALUATION_BUNDLE_BYTES) {
      throw new Error(
        `Skill evaluation bundle exceeds ${MAX_EVALUATION_BUNDLE_BYTES} total bytes.`,
      );
    }
    files.push(fileFromBuffer(portablePath, read.buffer));
  }
  return files;
}

function fileFromBuffer(relativePath: string, content: Buffer): PluginHookSkillBundleFile {
  const utf8 = content.toString("utf8");
  const isUtf8 = !utf8.includes("\0") && Buffer.from(utf8, "utf8").equals(content);
  return {
    path: relativePath,
    content: isUtf8 ? utf8 : content.toString("base64"),
    encoding: isUtf8 ? "utf8" : "base64",
    sha256: sha256Hex(content),
    sizeBytes: content.byteLength,
  };
}

function snapshotFromFiles(
  inputFiles: readonly PluginHookSkillBundleFile[],
  skillMdPath: string,
): PluginHookSkillBundleSnapshot {
  const files = inputFiles.toSorted((a, b) => a.path.localeCompare(b.path));
  assertEvaluationBundleWithinLimits(files);
  const skillMd = files.find((file) => file.path === skillMdPath);
  if (!skillMd) {
    throw new Error(`Skill evaluation bundle is missing ${skillMdPath}.`);
  }
  return {
    skillMd,
    files: files.filter((file) => file.path !== skillMdPath),
    treeSha256: hashSkillTree(files),
  };
}

function assertEvaluationBundleWithinLimits(files: readonly PluginHookSkillBundleFile[]): void {
  if (files.length > MAX_EVALUATION_FILES) {
    throw new Error(`Skill evaluation bundle exceeds ${MAX_EVALUATION_FILES} files.`);
  }
  let totalBytes = 0;
  for (const file of files) {
    if (file.sizeBytes > MAX_EVALUATION_FILE_BYTES) {
      throw new Error(
        `Skill evaluation bundle file exceeds ${MAX_EVALUATION_FILE_BYTES} bytes: ${file.path}.`,
      );
    }
    totalBytes += file.sizeBytes;
  }
  if (totalBytes > MAX_EVALUATION_BUNDLE_BYTES) {
    throw new Error(`Skill evaluation bundle exceeds ${MAX_EVALUATION_BUNDLE_BYTES} total bytes.`);
  }
}

function hashSkillTree(files: readonly PluginHookSkillBundleFile[]): string {
  return sha256Hex(
    JSON.stringify(
      files
        .toSorted((a, b) => a.path.localeCompare(b.path))
        .map((file) => ({
          path: file.path,
          sha256: file.sha256,
          sizeBytes: file.sizeBytes,
        })),
    ),
  );
}

function resolveTargetSkillRelativePath(
  proposal: SkillProposalReadResult,
  targetFiles: readonly PluginHookSkillBundleFile[],
  options: { recordedTargetExists: boolean },
): string {
  const relativePath = path.relative(
    path.resolve(proposal.record.target.skillDir),
    path.resolve(proposal.record.target.skillFile),
  );
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.startsWith(`..${path.sep}`)) {
    throw new Error("Skill evaluation target file must be inside the skill directory.");
  }
  const portablePath = relativePath.split(path.sep).join("/");
  if (targetFiles.some((file) => file.path === portablePath)) {
    return portablePath;
  }
  // Case-fold only when the recorded path resolves on this filesystem. Otherwise
  // evaluation could replace a different file than apply on case-sensitive hosts.
  if (!options.recordedTargetExists) {
    return portablePath;
  }
  const caseMatches = targetFiles.filter(
    (file) => file.path.toLowerCase() === portablePath.toLowerCase(),
  );
  if (caseMatches.length === 1) {
    return caseMatches[0]!.path;
  }
  if (caseMatches.length > 1) {
    throw new Error(`Skill evaluation target filename is ambiguous: ${portablePath}.`);
  }
  return portablePath;
}

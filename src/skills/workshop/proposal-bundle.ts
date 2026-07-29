import path from "node:path";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { root, walkDirectory } from "../../infra/fs-safe.js";
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
}> {
  const candidateSkillMd = fileFromBuffer(
    "SKILL.md",
    Buffer.from(stripProposalFrontmatterForSkill(params.proposal.content), "utf8"),
  );
  const proposedFiles = params.supportFiles.map((file) =>
    fileFromBuffer(file.path, Buffer.from(file.content, "utf8")),
  );
  if (params.proposal.record.kind === "create") {
    return {
      candidate: snapshotFromFiles([candidateSkillMd, ...proposedFiles]),
    };
  }

  const baselineFiles = await readSkillTreeFiles(params.proposal.record.target.skillDir);
  const baseline = snapshotFromFiles(baselineFiles);
  const candidateFiles = new Map(baselineFiles.map((file) => [file.path, file]));
  candidateFiles.set(candidateSkillMd.path, candidateSkillMd);
  for (const file of proposedFiles) {
    candidateFiles.set(file.path, file);
  }
  return {
    baseline,
    candidate: snapshotFromFiles([...candidateFiles.values()]),
  };
}

export async function readSkillProposalBaselineTreeSha256(skillDir: string): Promise<string> {
  return snapshotFromFiles(await readSkillTreeFiles(skillDir)).treeSha256;
}

async function readSkillTreeFiles(skillDir: string): Promise<PluginHookSkillBundleFile[]> {
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
): PluginHookSkillBundleSnapshot {
  const files = inputFiles.toSorted((a, b) => a.path.localeCompare(b.path));
  const skillMd = files.find((file) => file.path === "SKILL.md");
  if (!skillMd) {
    throw new Error("Skill evaluation bundle is missing SKILL.md.");
  }
  const treeSha256 = sha256Hex(
    JSON.stringify(
      files.map((file) => ({
        path: file.path,
        sha256: file.sha256,
        sizeBytes: file.sizeBytes,
      })),
    ),
  );
  return {
    skillMd,
    files: files.filter((file) => file.path !== "SKILL.md"),
    treeSha256,
  };
}

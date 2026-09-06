import fs from "node:fs/promises";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type {
  PluginHookSkillArtifact,
  PluginHookSkillChangedEvent,
} from "../../plugins/hook-types.js";
import { parseSkillFrontmatter } from "../loading/frontmatter.js";

const SKILL_FILE_CANDIDATES = ["SKILL.md", "skill.md", "skills.md", "SKILL.MD"] as const;
const EXCLUDED_ROOT_DIRS = new Set([".clawhub", ".clawdhub", ".openclaw"]);

type CommittedSkillChangeSource = PluginHookSkillChangedEvent["source"];

type Logger = {
  warn?: (message: string) => void;
};

type SkillTreeFile = {
  path: string;
  sha256: string;
  sizeBytes: number;
};

async function collectSkillTreeFiles(skillDir: string, relativeDir = ""): Promise<SkillTreeFile[]> {
  const entries = await fs.readdir(path.join(skillDir, relativeDir), { withFileTypes: true });
  const files: SkillTreeFile[] = [];
  for (const entry of entries.toSorted((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )) {
    if (!relativeDir && EXCLUDED_ROOT_DIRS.has(entry.name)) {
      continue;
    }
    const relativePath = path.join(relativeDir, entry.name);
    const portablePath = relativePath.split(path.sep).join("/");
    const absolutePath = path.join(skillDir, relativePath);
    const stat = await fs.lstat(absolutePath);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
      throw new Error(`Skill tree contains unsupported entry ${JSON.stringify(portablePath)}.`);
    }
    if (stat.isDirectory()) {
      files.push(...(await collectSkillTreeFiles(skillDir, relativePath)));
      continue;
    }
    if (stat.nlink > 1) {
      throw new Error(`Skill tree contains hard-linked file ${JSON.stringify(portablePath)}.`);
    }
    const content = await fs.readFile(absolutePath);
    files.push({
      path: portablePath,
      sha256: sha256Hex(content),
      sizeBytes: content.byteLength,
    });
  }
  return files;
}

function parseSkillArtifactMetadata(content: Buffer): {
  name?: string;
  description?: string;
  declaredVersion?: string;
} {
  const text = content.toString("utf8");
  if (text.includes("\0") || !Buffer.from(text, "utf8").equals(content)) {
    return {};
  }
  try {
    const frontmatter = parseSkillFrontmatter(text);
    return {
      name: normalizeOptionalString(frontmatter.name),
      description: normalizeOptionalString(frontmatter.description),
      declaredVersion: normalizeOptionalString(frontmatter.version),
    };
  } catch {
    return {};
  }
}

export function hasCommittedSkillChangeHooks(): boolean {
  return getGlobalHookRunner()?.hasHooks("skill_changed") ?? false;
}

export function resolveCommittedSkillChangeSource(
  originType: string | undefined,
): CommittedSkillChangeSource {
  if (originType === "clawhub") {
    return "clawhub";
  }
  if (originType === "upload") {
    return "upload";
  }
  return "source-install";
}

async function snapshotCommittedSkillArtifact(params: {
  skillDir: string;
  skillKey: string;
  source: CommittedSkillChangeSource;
  sourceVersion?: string;
}): Promise<PluginHookSkillArtifact> {
  const skillDir = path.resolve(params.skillDir);
  const files = await collectSkillTreeFiles(skillDir);
  const skillFileEntry = SKILL_FILE_CANDIDATES.map((candidate) =>
    files.find((file) => file.path === candidate),
  ).find((entry) => entry !== undefined);
  if (!skillFileEntry) {
    throw new Error(`Skill tree is missing SKILL.md: ${skillDir}`);
  }
  const skillFile = path.join(skillDir, skillFileEntry.path);
  const frontmatter = parseSkillArtifactMetadata(await fs.readFile(skillFile));
  const treeSha256 = sha256Hex(JSON.stringify(files));
  return {
    name: frontmatter.name ?? params.skillKey,
    skillKey: params.skillKey,
    ...(frontmatter.description ? { description: frontmatter.description } : {}),
    skillFile,
    skillDir,
    source: params.source,
    revision: {
      ...(frontmatter.declaredVersion ? { declaredVersion: frontmatter.declaredVersion } : {}),
      contentSha256: `sha256:${skillFileEntry.sha256}`,
      treeSha256: `sha256:${treeSha256}`,
      ...(params.sourceVersion ? { sourceVersion: params.sourceVersion } : {}),
    },
  };
}

export async function snapshotCommittedSkillArtifactBestEffort(
  params: Parameters<typeof snapshotCommittedSkillArtifact>[0] & {
    logger?: Logger;
  },
): Promise<PluginHookSkillArtifact | undefined> {
  try {
    return await snapshotCommittedSkillArtifact(params);
  } catch (error) {
    params.logger?.warn?.(`Could not snapshot committed skill change: ${String(error)}`);
    return undefined;
  }
}

export async function dispatchCommittedSkillChangeBestEffort(params: {
  action: PluginHookSkillChangedEvent["action"];
  source: CommittedSkillChangeSource;
  workspaceDir: string;
  before?: PluginHookSkillArtifact;
  after?: PluginHookSkillArtifact;
  proposal?: PluginHookSkillChangedEvent["proposal"];
  logger?: Logger;
}): Promise<void> {
  const runner = getGlobalHookRunner();
  if (!runner?.hasHooks("skill_changed")) {
    return;
  }
  try {
    await runner.runSkillChanged(
      {
        action: params.action,
        source: params.source,
        occurredAt: new Date().toISOString(),
        ...(params.before ? { before: params.before } : {}),
        ...(params.after ? { after: params.after } : {}),
        ...(params.proposal ? { proposal: params.proposal } : {}),
      },
      { workspaceDir: params.workspaceDir },
    );
  } catch (error) {
    params.logger?.warn?.(`Committed skill change hook failed: ${String(error)}`);
  }
}

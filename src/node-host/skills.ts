import fs from "node:fs";
import path from "node:path";
import type { NodeSkillDescriptor } from "../../packages/gateway-protocol/src/schema/nodes.js";
import { isPathInside } from "../infra/path-guards.js";
import {
  NODE_SKILL_MAX_CONTENT_BYTES,
  NODE_SKILL_MAX_COUNT,
  NODE_SKILL_MAX_DESCRIPTION_LENGTH,
  NODE_SKILL_MAX_TOTAL_BYTES,
  NODE_SKILL_NAME_RE,
} from "../shared/node-skill-constraints.js";
import { loadSkillsFromDirSafe, type LoadedLocalSkill } from "../skills/loading/local-loader.js";
import { resolveConfigDir } from "../utils.js";

type ScanNodeHostedSkillsOptions = {
  skillsDir?: string;
  warn?: (message: string) => void;
};

/** Resolve an advertised node skill directory locator to this node's canonical path. */
export function resolveNodeHostedSkillDirectory(locator: string, nodeId: string): string | null {
  if (!locator.startsWith("node://")) {
    return null;
  }
  const prefix = `node://${encodeURIComponent(nodeId)}/skills/`;
  const name = locator.startsWith(prefix) ? locator.slice(prefix.length) : "";
  if (!NODE_SKILL_NAME_RE.test(name)) {
    throw new Error("INVALID_REQUEST: node skill cwd locator is invalid for this node");
  }
  try {
    const skillsDir = fs.realpathSync(path.join(resolveConfigDir(), "skills"));
    const skillDir = fs.realpathSync(path.join(skillsDir, name));
    if (
      !isPathInside(skillsDir, skillDir) ||
      !fs.statSync(path.join(skillDir, "SKILL.md")).isFile()
    ) {
      throw new Error("missing SKILL.md");
    }
    return skillDir;
  } catch {
    throw new Error("INVALID_REQUEST: node skill cwd locator is unavailable");
  }
}

function listCandidateSkillFiles(skillsDir: string, warn: (message: string) => void): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      warn(`node host skill scan skipped (${skillsDir}): ${String(error)}`);
    }
    return [];
  }
  const candidates: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }
    const filePath = path.join(skillsDir, entry.name, "SKILL.md");
    try {
      if (fs.statSync(filePath, { throwIfNoEntry: false })?.isFile()) {
        candidates.push(filePath);
      }
    } catch (error) {
      warn(`node host skill skipped (${filePath}): ${String(error)}`);
    }
  }
  return candidates.toSorted((left, right) => left.localeCompare(right, "en"));
}

export function scanNodeHostedSkills(
  options: ScanNodeHostedSkillsOptions = {},
): NodeSkillDescriptor[] {
  const skillsDir = path.resolve(options.skillsDir ?? path.join(resolveConfigDir(), "skills"));
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const rootSkillFile = path.join(skillsDir, "SKILL.md");
  try {
    if (fs.statSync(rootSkillFile, { throwIfNoEntry: false })?.isFile()) {
      warn(`node host skill skipped (${rootSkillFile}): skills must use a named child directory`);
    }
  } catch (error) {
    warn(`node host skill scan skipped (${rootSkillFile}): ${String(error)}`);
  }
  const candidates = listCandidateSkillFiles(skillsDir, warn);
  if (candidates.length === 0) {
    return [];
  }

  const loadedSkills: LoadedLocalSkill[] = [];
  for (const candidate of candidates) {
    let invalidFrontmatter = false;
    const candidatePath = path.resolve(candidate);
    const loaded = loadSkillsFromDirSafe({
      dir: path.dirname(candidate),
      source: "openclaw-node",
      maxBytes: NODE_SKILL_MAX_CONTENT_BYTES,
      onDiagnostic: (diagnostic) => {
        if (path.resolve(diagnostic.path) === candidatePath) {
          invalidFrontmatter = true;
        }
        warn(`node host skill skipped (${diagnostic.path}): ${diagnostic.message}`);
      },
    });
    const loadedSkill = loaded.find(
      (entry) => path.resolve(entry.skill.filePath) === candidatePath,
    );
    if (loadedSkill) {
      loadedSkills.push(loadedSkill);
      continue;
    }
    let size: number | undefined;
    try {
      size = fs.statSync(candidate, { throwIfNoEntry: false })?.size;
    } catch (error) {
      warn(`node host skill skipped (${candidate}): ${String(error)}`);
      continue;
    }
    const reason = invalidFrontmatter
      ? null
      : typeof size === "number" && size > NODE_SKILL_MAX_CONTENT_BYTES
        ? `exceeds ${NODE_SKILL_MAX_CONTENT_BYTES} bytes`
        : "has invalid or missing frontmatter";
    if (reason) {
      warn(`node host skill skipped (${candidate}): ${reason}`);
    }
  }

  const descriptors: NodeSkillDescriptor[] = [];
  const seenNames = new Set<string>();
  let totalBytes = 0;
  for (const { skill, frontmatter } of loadedSkills.toSorted((left, right) =>
    left.skill.name.localeCompare(right.skill.name, "en"),
  )) {
    if (
      frontmatter?.name?.trim() !== skill.name ||
      frontmatter.description?.trim() !== skill.description ||
      path.basename(skill.baseDir) !== skill.name
    ) {
      warn(
        `node host skill skipped (${skill.filePath}): directory, name, and frontmatter must match`,
      );
      continue;
    }
    let content: string;
    try {
      content = fs.readFileSync(skill.filePath, "utf8");
    } catch (error) {
      warn(`node host skill skipped (${skill.filePath}): ${String(error)}`);
      continue;
    }
    const contentBytes = Buffer.byteLength(content, "utf8");
    if (
      !NODE_SKILL_NAME_RE.test(skill.name) ||
      !skill.description ||
      skill.description.length > NODE_SKILL_MAX_DESCRIPTION_LENGTH ||
      contentBytes > NODE_SKILL_MAX_CONTENT_BYTES
    ) {
      warn(`node host skill skipped (${skill.filePath}): invalid name, description, or size`);
      continue;
    }
    if (seenNames.has(skill.name)) {
      warn(`node host skill skipped (${skill.filePath}): duplicate name ${skill.name}`);
      continue;
    }
    if (descriptors.length >= NODE_SKILL_MAX_COUNT) {
      warn(`node host skill skipped (${skill.filePath}): exceeds ${NODE_SKILL_MAX_COUNT} skills`);
      continue;
    }
    if (totalBytes + contentBytes > NODE_SKILL_MAX_TOTAL_BYTES) {
      warn(
        `node host skill skipped (${skill.filePath}): exceeds ${NODE_SKILL_MAX_TOTAL_BYTES} total bytes`,
      );
      continue;
    }
    seenNames.add(skill.name);
    totalBytes += contentBytes;
    descriptors.push({ name: skill.name, description: skill.description, content });
  }
  return descriptors;
}

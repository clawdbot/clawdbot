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
import { loadSingleSkillDirectory } from "../skills/loading/local-loader.js";
import { tryRealpath } from "../skills/loading/symlink-targets.js";
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

function listCandidateSkills(
  skillsDir: string,
  warn: (message: string) => void,
): Array<{ name: string; filePath: string }> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      warn(`node host skill scan skipped (${skillsDir}): ${String(error)}`);
    }
    return [];
  }
  const candidates: Array<{ name: string; filePath: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }
    const filePath = path.join(skillsDir, entry.name, "SKILL.md");
    try {
      if (fs.statSync(filePath, { throwIfNoEntry: false })?.isFile()) {
        candidates.push({ name: entry.name, filePath });
      }
    } catch (error) {
      warn(`node host skill skipped (${filePath}): ${String(error)}`);
    }
  }
  // Accepted names must match their unique child directories, so this is descriptor order.
  return candidates.toSorted((left, right) => left.name.localeCompare(right.name, "en"));
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
  const descriptors: NodeSkillDescriptor[] = [];
  let totalBytes = 0;
  for (const candidate of listCandidateSkills(skillsDir, warn)) {
    const skillDir = path.dirname(candidate.filePath);
    const rootRealPath = tryRealpath(skillDir);
    let diagnosed = false;
    const loaded = rootRealPath
      ? loadSingleSkillDirectory({
          skillDir,
          rootRealPath,
          source: "openclaw-node",
          maxBytes: NODE_SKILL_MAX_CONTENT_BYTES,
          onDiagnostic: (diagnostic) => {
            diagnosed = true;
            warn(`node host skill skipped (${diagnostic.path}): ${diagnostic.message}`);
          },
        })
      : null;
    if (!loaded) {
      if (!diagnosed) {
        warn(`node host skill skipped (${candidate.filePath}): has invalid or missing frontmatter`);
      }
      continue;
    }
    // Metadata and advertised instructions must come from the same bounded descriptor read.
    const { skill, frontmatter, content } = loaded;
    if (
      frontmatter.name?.trim() !== skill.name ||
      frontmatter.description?.trim() !== skill.description ||
      candidate.name !== skill.name
    ) {
      warn(
        `node host skill skipped (${skill.filePath}): directory, name, and frontmatter must match`,
      );
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
    totalBytes += contentBytes;
    descriptors.push({ name: skill.name, description: skill.description, content });
  }
  return descriptors;
}

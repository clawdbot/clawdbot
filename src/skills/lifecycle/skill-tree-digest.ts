import fs from "node:fs/promises";
import path from "node:path";
import { sha256File, sha256Hex } from "../../infra/crypto-digest.js";

const EXCLUDED_METADATA_DIRS = new Set([".clawhub", ".clawdhub"]);

type SkillTreeEntry = {
  path: string;
  sha256?: string;
  type: "directory" | "file";
};

async function collectEntries(root: string, relativeDir = ""): Promise<SkillTreeEntry[]> {
  const absoluteDir = path.join(root, relativeDir);
  const entries = await fs.readdir(absoluteDir, { withFileTypes: true });
  const collected: SkillTreeEntry[] = [];
  for (const entry of entries.toSorted((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )) {
    if (!relativeDir && EXCLUDED_METADATA_DIRS.has(entry.name)) {
      continue;
    }
    const relativePath = path.join(relativeDir, entry.name);
    const portablePath = relativePath.split(path.sep).join("/");
    const stat = await fs.lstat(path.join(root, relativePath));
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
      throw new Error(`Skill tree contains unsupported entry ${JSON.stringify(portablePath)}.`);
    }
    if (stat.isDirectory()) {
      collected.push({ path: portablePath, type: "directory" });
      collected.push(...(await collectEntries(root, relativePath)));
      continue;
    }
    if (stat.nlink > 1) {
      throw new Error(`Skill tree contains hard-linked file ${JSON.stringify(portablePath)}.`);
    }
    // Bound nonempty files to their initial size so appends cannot prolong hashing.
    // Empty files retain readFile's EOF behavior.
    const end = stat.size > 0 ? stat.size - 1 : undefined;
    collected.push({
      path: portablePath,
      type: "file",
      sha256: await sha256File(path.join(root, relativePath), end),
    });
  }
  return collected;
}

/** Digests every installed skill file except OpenClaw's own provenance metadata. */
export async function digestClawHubSkillTree(skillDir: string): Promise<string> {
  const entries = await collectEntries(skillDir);
  return `sha256:${sha256Hex(JSON.stringify(entries))}`;
}

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

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
    const content = await fs.readFile(path.join(root, relativePath));
    collected.push({
      path: portablePath,
      type: "file",
      sha256: createHash("sha256").update(content).digest("hex"),
    });
  }
  return collected;
}

/** Digests every installed skill file except OpenClaw's own provenance metadata. */
export async function digestClawHubSkillTree(skillDir: string): Promise<string> {
  const entries = await collectEntries(skillDir);
  return `sha256:${createHash("sha256").update(JSON.stringify(entries)).digest("hex")}`;
}

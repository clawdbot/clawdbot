import fs from "node:fs";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isPathInside } from "../../infra/path-guards.js";
import type { OpenClawSkillMetadata, ParsedSkillFrontmatter } from "../types.js";
import { resolveSkillManifestMetadata } from "./frontmatter.js";
import { tryRealpath } from "./symlink-targets.js";

const SKILL_SOURCE_ORIGIN_RELATIVE_PATH = path.join(".openclaw", "source-origin.json");
const MAX_SKILL_SOURCE_ORIGIN_BYTES = 16 * 1024;

function readSourceInstallSkillKey(skillDir: string): string | undefined {
  try {
    const sourceOriginPath = path.join(skillDir, SKILL_SOURCE_ORIGIN_RELATIVE_PATH);
    const stat = fs.lstatSync(sourceOriginPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SKILL_SOURCE_ORIGIN_BYTES) {
      return undefined;
    }
    const skillDirRealPath = tryRealpath(skillDir);
    const sourceOriginRealPath = tryRealpath(sourceOriginPath);
    if (
      !skillDirRealPath ||
      !sourceOriginRealPath ||
      !isPathInside(skillDirRealPath, sourceOriginRealPath)
    ) {
      return undefined;
    }
    const raw = fs.readFileSync(sourceOriginPath, "utf8");
    // SAFETY: Only the optional slug field is read and normalized after parsing.
    const parsed = JSON.parse(raw) as { slug?: unknown };
    return normalizeOptionalString(parsed.slug);
  } catch {
    return undefined;
  }
}

export function resolveSkillEntryMetadata(params: {
  frontmatter: ParsedSkillFrontmatter;
  skillDir: string;
}): OpenClawSkillMetadata | undefined {
  const metadata = resolveSkillManifestMetadata(params.frontmatter);
  if (metadata?.skillKey) {
    return metadata;
  }
  const sourceInstallSkillKey = readSourceInstallSkillKey(params.skillDir);
  if (!sourceInstallSkillKey) {
    return metadata;
  }
  return { ...metadata, skillKey: sourceInstallSkillKey };
}

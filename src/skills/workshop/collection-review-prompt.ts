import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { canonicalizePath } from "../../agents/utils/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { readSkillUsageByFile } from "./curator.js";
import { resolveWorkshopSkillsDir } from "./skills-root.js";

const MAX_USAGE_ROWS = 200;
const MAX_USAGE_NAME_LENGTH = 80;

export function buildCollectionReviewPrompt(
  skills: readonly { name: string; filePath: string }[],
  files: Iterable<string>,
  config: OpenClawConfig,
  agentId: string,
  env?: NodeJS.ProcessEnv,
): string {
  const usageBySkillFile = readSkillUsageByFile(
    skills.map((skill) => canonicalizePath(skill.filePath)),
    env ? { env } : {},
  );
  const nowMs = Date.now();
  const usageRows = skills
    .flatMap((skill) => {
      const usage = usageBySkillFile.get(canonicalizePath(skill.filePath));
      return usage ? [{ name: skill.name, usage }] : [];
    })
    .toSorted(
      (left, right) =>
        right.usage.useCount - left.usage.useCount || left.name.localeCompare(right.name),
    );
  const visibleUsageRows = usageRows.slice(0, MAX_USAGE_ROWS);
  return [
    `Workshop directory: ${resolveWorkshopSkillsDir(config, agentId, env)}`,
    `Total skills: ${skills.length}`,
    "Review the Skill Workshop collection in this scheduled isolated turn.",
    "Use the normal file tools to read, edit, create, and remove files. Stay inside the Workshop directory.",
    "Keep distinct useful skills. Rewrite bloated or record-like text into lean procedures. Consolidate overlap into one useful skill. Drop junk and stale fragments.",
    "Usage counts and recency are supporting evidence only. Zero use alone never justifies a drop.",
    "Keep SKILL.md files around or under 10,000 characters when practical; this is guidance, not an enforced limit.",
    "For every dropped skill, include exactly one final-output line: DROP <skill-name>: <short reason>.",
    "Do not edit files outside this directory. Finish with a concise summary after any DROP lines.",
    "The inventory is bounded to 10,000 entries and six directory levels; a larger tree fails the review with a recorded error. Split or prune the Workshop directory by hand before running it again.",
    "",
    "Full Workshop file index (JSON-quoted relative paths; read files as needed):",
    ...[...files].toSorted().map((file) => JSON.stringify(file)),
    "",
    "Recorded usage (name useCount lastUsedDaysAgo):",
    ...visibleUsageRows.map(
      ({ name, usage }) =>
        `${truncateUtf16Safe(name.replace(/\s+/gu, " ").trim(), MAX_USAGE_NAME_LENGTH)} ${usage.useCount} ${Math.floor((nowMs - usage.lastUsedAtMs) / 86_400_000)}`,
    ),
    ...(usageRows.length > MAX_USAGE_ROWS
      ? [`Usage table truncated after ${MAX_USAGE_ROWS} skills.`]
      : []),
  ].join("\n");
}

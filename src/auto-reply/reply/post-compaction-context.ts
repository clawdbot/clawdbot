// Loads post-compaction context summaries for continuation prompts.
import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { resolveAgentContextLimits } from "../../agents/agent-scope.js";
import { resolveCronStyleNow } from "../../agents/current-time.js";
import { formatDateStamp, resolveUserTimezone } from "../../agents/date-time.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { openRootFile } from "../../infra/boundary-file-read.js";

const MAX_CONTEXT_CHARS = 1800;
const DEFAULT_POST_COMPACTION_SECTIONS = ["Session Startup", "Red Lines"];
const LEGACY_POST_COMPACTION_SECTIONS = ["Every Session", "Safety"];

// Compare configured section names as a case-insensitive set so deployments can
// pin the documented defaults in any order without changing fallback semantics.
function matchesSectionSet(sectionNames: string[], expectedSections: string[]): boolean {
  if (sectionNames.length !== expectedSections.length) {
    return false;
  }

  const counts = new Map<string, number>();
  for (const name of expectedSections) {
    const normalized = normalizeLowercaseStringOrEmpty(name);
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }

  for (const name of sectionNames) {
    const normalized = normalizeLowercaseStringOrEmpty(name);
    const count = counts.get(normalized);
    if (!count) {
      return false;
    }
    if (count === 1) {
      counts.delete(normalized);
    } else {
      counts.set(normalized, count - 1);
    }
  }

  return counts.size === 0;
}

/**
 * Read critical sections from workspace AGENTS.md for post-compaction injection.
 * Returns formatted system event text, or null if no AGENTS.md or no relevant sections.
 * Substitutes YYYY-MM-DD placeholders with the real date so agents read the correct
 * daily memory files instead of guessing based on training cutoff.
 */
type PostCompactionContextOptions = {
  cfg?: OpenClawConfig;
  agentId?: string;
  nowMs?: number;
};

export async function readPostCompactionContext(
  workspaceDir: string,
  options?: PostCompactionContextOptions,
): Promise<string | null> {
  const cfg = options?.cfg;
  const agentId = options?.agentId;
  const effectiveNowMs = options?.nowMs;
  const agentsPath = path.join(workspaceDir, "AGENTS.md");

  try {
    const opened = await openRootFile({
      absolutePath: agentsPath,
      rootPath: workspaceDir,
      boundaryLabel: "workspace root",
    });
    if (!opened.ok) {
      return null;
    }
    const content = (() => {
      try {
        return fs.readFileSync(opened.fd, "utf-8");
      } finally {
        fs.closeSync(opened.fd);
      }
    })();

    const configuredSections = cfg?.agents?.defaults?.compaction?.postCompactionSections;
    if (!Array.isArray(configuredSections) || configuredSections.length === 0) {
      return null;
    }
    const sectionNames = configuredSections;

    const foundSectionNames: string[] = [];
    let sections = extractSections(content, sectionNames, foundSectionNames);

    // Legacy "Every Session" / "Safety" fallback is preserved only for users
    // who explicitly opt in to the documented default section pair.
    const isDefaultSections = matchesSectionSet(
      configuredSections,
      DEFAULT_POST_COMPACTION_SECTIONS,
    );
    if (sections.length === 0 && isDefaultSections) {
      sections = extractSections(content, LEGACY_POST_COMPACTION_SECTIONS, foundSectionNames);
    }

    if (sections.length === 0) {
      return null;
    }

    // Only reference section names that were actually found and injected.
    const displayNames = foundSectionNames.length > 0 ? foundSectionNames : sectionNames;

    const resolvedNowMs = effectiveNowMs ?? Date.now();
    const timezone = resolveUserTimezone(cfg?.agents?.defaults?.userTimezone);
    const dateStamp = formatDateStamp(resolvedNowMs, timezone);
    const maxContextChars =
      resolveAgentContextLimits(cfg, agentId)?.postCompactionMaxChars ?? MAX_CONTEXT_CHARS;
    // Always append the real runtime timestamp — AGENTS.md content may itself contain
    // "Current time:" as user-authored text, so we must not gate on that substring.
    const { timeLine } = resolveCronStyleNow(cfg ?? {}, resolvedNowMs);

    const combined = sections.join("\n\n").replaceAll("YYYY-MM-DD", dateStamp);
    const safeContent =
      combined.length > maxContextChars
        ? truncateUtf16Safe(combined, maxContextChars) + "\n...[truncated]..."
        : combined;

    // When using the default section set, use precise prose that names the
    // "Session Startup" sequence explicitly. When custom sections are configured,
    // use generic prose — referencing a hardcoded "Session Startup" sequence
    // would be misleading for deployments that use different section names.
    const prose = isDefaultSections
      ? "Session was just compacted. The conversation summary above is a hint, NOT a substitute for your startup sequence. " +
        "Run your Session Startup sequence - read the required files before responding to the user."
      : `Session was just compacted. The conversation summary above is a hint, NOT a substitute for your full startup sequence. ` +
        `Re-read the sections injected below (${displayNames.join(", ")}) and follow your configured startup procedure before responding to the user.`;

    const sectionLabel = isDefaultSections
      ? "Critical rules from AGENTS.md:"
      : `Injected sections from AGENTS.md (${displayNames.join(", ")}):`;

    return (
      "[Post-compaction context refresh]\n\n" +
      `${prose}\n\n` +
      `${sectionLabel}\n\n${safeContent}\n\n${timeLine}`
    );
  } catch {
    return null;
  }
}

/**
 * Extract named sections from markdown content.
 * Matches H2 (##) or H3 (###) headings case-insensitively.
 * Skips content inside fenced code blocks.
 * Captures until the next heading of same or higher level, or end of string.
 */
export function extractSections(
  content: string,
  sectionNames: string[],
  foundNames?: string[],
): string[] {
  const results: string[] = [];
  const lines = content.split("\n");

  for (const name of sectionNames) {
    let sectionLines: string[] = [];
    let inSection = false;
    let sectionLevel = 0;
    let inCodeBlock = false;

    for (const line of lines) {
      // Track fenced code blocks
      if (line.trimStart().startsWith("```")) {
        inCodeBlock = !inCodeBlock;
        if (inSection) {
          sectionLines.push(line);
        }
        continue;
      }

      // Skip heading detection inside code blocks
      if (inCodeBlock) {
        if (inSection) {
          sectionLines.push(line);
        }
        continue;
      }

      // Check if this line is a heading
      const headingMatch = line.match(/^(#{2,3})\s+(.+?)\s*$/);

      if (headingMatch) {
        const level = expectDefined(headingMatch[1], "heading match capture group 1").length; // 2 or 3
        const headingText = headingMatch[2];

        if (!inSection) {
          // Check if this is our target section (case-insensitive)
          if (
            normalizeLowercaseStringOrEmpty(headingText) === normalizeLowercaseStringOrEmpty(name)
          ) {
            inSection = true;
            sectionLevel = level;
            sectionLines = [line];
            continue;
          }
        } else {
          // We're in section — stop if we hit a heading of same or higher level
          if (level <= sectionLevel) {
            break;
          }
          // Lower-level heading (e.g., ### inside ##) — include it
          sectionLines.push(line);
          continue;
        }
      }

      if (inSection) {
        sectionLines.push(line);
      }
    }

    if (sectionLines.length > 0) {
      results.push(sectionLines.join("\n").trim());
      foundNames?.push(name);
    }
  }

  return results;
}

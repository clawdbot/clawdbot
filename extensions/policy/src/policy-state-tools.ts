// Policy plugin AGENTS.md Tools-section evidence.
import { COLLAPSE_HYPHENS, NON_SLUG_CHARS, TRIM_HYPHENS } from "./policy-state-types.js";
import type { PolicyToolEvidence } from "./policy-state-types.js";

export function scanPolicyTools(raw: string): Promise<readonly PolicyToolEvidence[]> {
  return Promise.resolve(scanPolicyToolHeaders(raw));
}

function scanPolicyToolHeaders(raw: string): readonly PolicyToolEvidence[] {
  const section = markdownSectionLines(raw, "tools");
  if (section.length === 0) {
    return [];
  }
  const tools: PolicyToolEvidence[] = [];
  let localNotesMode: "plain" | "migrated" | undefined;
  for (let index = 0; index < section.length; index += 1) {
    const sectionLine = section[index];
    const line = sectionLine?.text ?? "";
    const sectionHeading = /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line);
    const isChildHeading = sectionHeading?.[1]?.length === (sectionLine?.sectionDepth ?? 0) + 1;
    if (
      line.includes("Skills provide your tools.") &&
      line.includes("Keep local notes") &&
      line.includes("TOOLS.md")
    ) {
      localNotesMode = "plain";
      continue;
    }
    if (isChildHeading && /^Local notes\s*$/iu.test(sectionHeading?.[2] ?? "")) {
      localNotesMode = "plain";
      continue;
    }
    if (
      isChildHeading &&
      /^Local notes \(migrated from TOOLS\.md\)\s*$/iu.test(sectionHeading?.[2] ?? "")
    ) {
      localNotesMode = "migrated";
      continue;
    }
    if (
      localNotesMode &&
      sectionHeading &&
      sectionHeading[1]!.length <= (section[index]?.sectionDepth ?? 0) &&
      slugify(sectionHeading[2] ?? "") === "tools"
    ) {
      localNotesMode = undefined;
      continue;
    }
    if (localNotesMode === "plain" && isChildHeading) {
      localNotesMode = undefined;
    }
    if (localNotesMode) {
      continue;
    }
    const heading = isChildHeading ? /^([^\s#]+)(.*)$/u.exec(sectionHeading?.[2] ?? "") : null;
    const bullet = /^[-*+]\s+([^:\s][^:]*?)\s*:(.*)$/.exec(line);
    const match = heading ?? bullet;
    const toolName = match?.[1];
    if (!toolName) {
      continue;
    }
    const id = slugify(toolName);
    if (!id) {
      continue;
    }
    const entry: {
      id: string;
      source: string;
      line: number;
      risk?: string;
      sensitivity?: string;
      owner?: string;
      capabilities?: readonly string[];
    } = {
      id,
      source: `oc://AGENTS.md/tools/${id}`,
      line: section[index]?.line ?? index + 1,
    };
    const metaLines = [match[2] ?? ""];
    for (let metaIndex = index + 1; metaIndex < section.length; metaIndex += 1) {
      const metaSectionLine = section[metaIndex];
      const metaLine = metaSectionLine?.text ?? "";
      const metaHeading = /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(metaLine.trim());
      if (
        (metaHeading !== null &&
          (metaHeading[1]?.length ?? 0) <= (metaSectionLine?.sectionDepth ?? 0) + 1) ||
        /^[-*+]\s+[^:\s][^:]*?\s*:/.test(metaLine)
      ) {
        break;
      }
      metaLines.push(metaLine);
    }
    const meta = metaLines.join("\n");
    const risk = riskFromMeta(meta);
    const sensitivity = /\bsensitivity\s*:\s*([a-z0-9_-]+)\b/i.exec(meta)?.[1]?.toLowerCase();
    const owner = /\bowner\s*:\s*([^\s#]+)\b/i.exec(meta)?.[1];
    const capabilities = capabilityTokensFromMetaLines(metaLines);
    if (risk !== undefined) {
      entry.risk = risk;
    }
    if (sensitivity !== undefined) {
      entry.sensitivity = sensitivity;
    }
    if (owner !== undefined) {
      entry.owner = owner;
    }
    if (capabilities.length > 0) {
      entry.capabilities = capabilities;
    }
    tools.push(entry);
  }
  return tools;
}

function markdownSectionLines(
  raw: string,
  sectionSlug: string,
): readonly {
  readonly line: number;
  readonly text: string;
  readonly sectionDepth: number;
}[] {
  const lines = raw.split(/\r?\n/);
  let sectionDepth: number | undefined;
  let foundSection = false;
  let fence: { marker: "`" | "~"; length: number } | undefined;
  const section: { line: number; text: string; sectionDepth: number }[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const fenceRun = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    const closingFenceRun = /^\s*(`{3,}|~{3,})\s*$/.exec(line)?.[1];
    const marker = fenceRun?.[0] as "`" | "~" | undefined;
    if (marker && !fence) {
      fence = { marker, length: fenceRun!.length };
      continue;
    }
    if (
      closingFenceRun &&
      fence &&
      closingFenceRun[0] === fence.marker &&
      closingFenceRun.length >= fence.length
    ) {
      fence = undefined;
      continue;
    }
    if (fence) {
      continue;
    }
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading !== null) {
      const depth = heading[1]?.length ?? 0;
      const slug = slugify(heading[2] ?? "");
      if (sectionDepth !== undefined && depth <= sectionDepth) {
        sectionDepth = undefined;
      }
      if (sectionDepth !== undefined) {
        section.push({ line: index + 1, text: line, sectionDepth });
        continue;
      }
      if (depth <= 2 && slug === sectionSlug) {
        if (foundSection) {
          section.push({ line: index + 1, text: line, sectionDepth: depth });
        }
        foundSection = true;
        sectionDepth = depth;
      }
      continue;
    }
    if (sectionDepth !== undefined) {
      section.push({ line: index + 1, text: line, sectionDepth });
    }
  }
  return section;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/_/g, "-")
    .replace(NON_SLUG_CHARS, "-")
    .replace(COLLAPSE_HYPHENS, "-")
    .replace(TRIM_HYPHENS, "");
}

function riskFromMeta(meta: string): string | undefined {
  const namedRisk = /\brisk\s*:\s*([a-z0-9_-]+)\b/i.exec(meta)?.[1];
  if (namedRisk !== undefined) {
    return namedRisk.toLowerCase();
  }
  const alias = /\bR([0-5])\b/.exec(meta)?.[1];
  switch (alias) {
    case "0":
    case "1":
      return "low";
    case "2":
    case "3":
      return "medium";
    case "4":
      return "high";
    case "5":
      return "critical";
    default:
      return undefined;
  }
}

function capabilityTokensFromMetaLines(lines: readonly string[]): readonly string[] {
  return lines.flatMap((line, index): string[] => {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return [];
    }
    const tokens = trimmed.match(/\b[A-Z][A-Z0-9_]{2,}\b/g) ?? [];
    if (index === 0 || /\bcapabilities\s*:/i.test(trimmed)) {
      return tokens;
    }
    const withoutTokens = tokens.reduce((remaining, token) => {
      return remaining.replace(token, "");
    }, trimmed);
    return /^[\s,;:[\](){}#*_-]*$/.test(withoutTokens) ? tokens : [];
  });
}

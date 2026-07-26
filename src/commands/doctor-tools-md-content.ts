/** Markdown content rules for folding legacy TOOLS.md notes into AGENTS.md. */
const MIGRATED_SUBSECTION_HEADING = "### Local notes (migrated from TOOLS.md)";
const LEGACY_AGENTS_TOOLS_GUIDANCE =
  "Skills provide your tools. When you need one, check its `SKILL.md`. Keep local notes (camera names, SSH details, voice preferences) in `TOOLS.md`.";
const CURRENT_AGENTS_TOOLS_GUIDANCE =
  "Skills define how tools work. Keep environment-specific local notes in this section.";

const LEGACY_TOOLS_MD_TEMPLATE =
  [
    "# TOOLS.md - Local Notes",
    "",
    "Skills define _how_ tools work. This file is for _your_ specifics — the stuff that's unique to your setup: camera names and locations, SSH hosts and aliases, preferred TTS voices, speaker/room names, device nicknames, anything environment-specific.",
    "",
    "## Examples",
    "",
    "```markdown",
    "### Cameras",
    "",
    "- living-room → Main area, 180° wide angle",
    "- front-door → Entrance, motion-triggered",
    "",
    "### SSH",
    "",
    "- home-server → 192.168.1.100, user: admin",
    "",
    "### TTS",
    "",
    '- Preferred voice: "Nova" (warm, slightly British)',
    "- Default speaker: Kitchen HomePod",
    "```",
    "",
    "## Why Separate?",
    "",
    "Skills are shared. Your setup is yours. Keeping them apart means you can update skills without losing your notes, and share skills without leaking your infrastructure.",
    "",
    "---",
    "",
    "Add whatever helps you do your job. This is your cheat sheet.",
    "",
    "## Related",
    "",
    "- [Agent workspace](/concepts/agent-workspace)",
  ].join("\n") + "\n";

const LEGACY_TOOLS_DEV_MD_TEMPLATE =
  [
    "# TOOLS.md - User Tool Notes (editable)",
    "",
    "This file is for _your_ notes about external tools and conventions. It does not define which tools exist; OpenClaw provides built-in tools internally, and skills add the rest.",
    "",
    "## Examples",
    "",
    "### imsg",
    "",
    "- Send an iMessage/SMS: describe who/what, confirm before sending.",
    "- Prefer short messages; avoid sending secrets.",
    "",
    "### sag",
    "",
    "- Text-to-speech: specify voice, target speaker/room, and whether to stream.",
    "",
    "Add whatever else you want the assistant to know about your local toolchain.",
    "",
    "## Related",
    "",
    "- [TOOLS.md template](/reference/templates/TOOLS)",
  ].join("\n") + "\n";
const LEGACY_TOOLS_DEV_FALLBACK =
  "# TOOLS.md - User Tool Notes (editable)\n\nAdd your local tool notes here.\n";

export function shouldMergeToolsMdContent(content: string): boolean {
  return (
    content.trim().length > 0 &&
    content !== LEGACY_TOOLS_MD_TEMPLATE &&
    content !== LEGACY_TOOLS_DEV_MD_TEMPLATE &&
    content !== LEGACY_TOOLS_DEV_FALLBACK
  );
}

function migratedBlock(content: string): string {
  return `${MIGRATED_SUBSECTION_HEADING}\n\n${content}`;
}

function appendWithSpacing(before: string, addition: string, after = ""): string {
  const prefix =
    before.length === 0 ? "" : before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const suffix =
    after.length === 0
      ? ""
      : addition.endsWith("\n\n")
        ? ""
        : addition.endsWith("\n")
          ? "\n"
          : "\n\n";
  return `${before}${prefix}${addition}${suffix}${after}`;
}

export function mergeToolsMdIntoAgentsMd(agentsContent: string, toolsContent: string): string {
  const hadLegacyGuidance = agentsContent.includes(LEGACY_AGENTS_TOOLS_GUIDANCE);
  let mergedAgentsContent = agentsContent.replace(
    LEGACY_AGENTS_TOOLS_GUIDANCE,
    CURRENT_AGENTS_TOOLS_GUIDANCE,
  );
  if (hadLegacyGuidance) {
    mergedAgentsContent = ensureLocalNotesHeading(mergedAgentsContent);
  }
  if (mergedAgentsContent.includes(MIGRATED_SUBSECTION_HEADING)) {
    if (mergedAgentsContent.includes(toolsContent)) {
      return mergedAgentsContent;
    }
    const headingIndex = mergedAgentsContent.indexOf(MIGRATED_SUBSECTION_HEADING);
    const insertAt = headingIndex + MIGRATED_SUBSECTION_HEADING.length;
    return appendWithSpacing(
      mergedAgentsContent.slice(0, insertAt),
      toolsContent,
      mergedAgentsContent.slice(insertAt),
    );
  }
  const block = migratedBlock(toolsContent);
  const toolsSection = findToolsSection(mergedAgentsContent);
  if (!toolsSection) {
    return appendWithSpacing(mergedAgentsContent, `## Tools\n\n${block}`);
  }
  return appendWithSpacing(
    mergedAgentsContent.slice(0, toolsSection.insertAt),
    block,
    mergedAgentsContent.slice(toolsSection.insertAt),
  );
}

function findToolsSection(content: string): { headingEnd: number; insertAt: number } | undefined {
  let offset = 0;
  let insideTools = false;
  let headingEnd = 0;
  let fence: { marker: "`" | "~"; length: number } | undefined;
  for (const lineWithEnding of content.match(/.*(?:\n|$)/gu) ?? []) {
    if (lineWithEnding === "") {
      continue;
    }
    const line = lineWithEnding.replace(/\n$/u, "");
    const fenceRun = /^\s*(`{3,}|~{3,})/u.exec(line)?.[1];
    const closingFenceRun = /^\s*(`{3,}|~{3,})\s*$/u.exec(line)?.[1];
    const marker = fenceRun?.[0] as "`" | "~" | undefined;
    if (marker && !fence) {
      fence = { marker, length: fenceRun!.length };
    } else if (
      closingFenceRun &&
      fence &&
      closingFenceRun[0] === fence.marker &&
      closingFenceRun.length >= fence.length
    ) {
      fence = undefined;
    } else if (!fence) {
      const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line);
      if (heading) {
        const depth = heading[1]!.length;
        if (insideTools && depth <= 2) {
          return { headingEnd, insertAt: offset };
        }
        if (depth === 2 && heading[2]!.trim().toLowerCase() === "tools") {
          insideTools = true;
          headingEnd = offset + lineWithEnding.length;
        }
      }
    }
    offset += lineWithEnding.length;
  }
  return insideTools ? { headingEnd, insertAt: content.length } : undefined;
}

function ensureLocalNotesHeading(content: string): string {
  const section = findToolsSection(content);
  if (!section) {
    return content;
  }
  const body = content.slice(section.headingEnd, section.insertAt);
  if (/^###\s+Local notes(?:\s|$)/imu.test(body)) {
    return content;
  }
  return `${content.slice(0, section.headingEnd)}\n### Local notes\n${content.slice(section.headingEnd)}`;
}

export function normalizeAgentsToolsGuidance(content: string): string {
  return content.includes(LEGACY_AGENTS_TOOLS_GUIDANCE)
    ? ensureLocalNotesHeading(
        content.replace(LEGACY_AGENTS_TOOLS_GUIDANCE, CURRENT_AGENTS_TOOLS_GUIDANCE),
      )
    : content;
}

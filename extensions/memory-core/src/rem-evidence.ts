import fs from "node:fs/promises";
import path from "node:path";

const REM_BLOCKED_SECTION_RE =
  /\b(morning reminders|tasks? for today|to-?do|pickups?|action items?|next steps?|open questions?|stats|setup tasks?|priority contacts|visitors?|top priority candidates|timeline coverage|action items for morning review|test .* skill|heartbeat checks?|date semantics guardrail|still broken|last message (?:&|and) status|plugin \/ service warning|email triage cron)\b/i;
const REM_GENERIC_SECTION_RE =
  /^(setup|session notes?|notes|summary|major accomplishments?|infrastructure|process improvements?)$/i;
const REM_MEMORY_SIGNAL_RE =
  /\b(always use|prefers?|preference|preferences|standing rule|rule:|use .* calendar|durable|remember)\b/i;
const REM_BUILD_SIGNAL_RE =
  /\b(set up|setup|created|built|rewrite|rewrote|implemented|installed|configured|added|updated|exported|documented)\b/i;
const REM_INCIDENT_SIGNAL_RE =
  /\b(fail(?:ed|ing)?|error|issue|problem|auth|expired|broken|unable|missing|required|root cause|consecutive failures?)\b/i;
const REM_LOGISTICS_SIGNAL_RE =
  /\b(visitor|arriv(?:e|al|ing)|flight|calendar|reservation|schedule|coordinate|travel|pickup)\b/i;
const REM_TASK_SIGNAL_RE =
  /\b(reminder|task|to-?do|action item|next step|need to|follow up|respond to|call\b|check\b)\b/i;
const REM_ROUTING_SIGNAL_RE =
  /\b(categor(?:ize|ized|ization)|route|routing|workflow|processor|read later|auto-implement|codex|razor)\b/i;
const REM_OPERATOR_RULE_SIGNAL_RE = /\b(learned:|rule:|always [a-z])\b/i;
const REM_EXTERNALIZATION_SIGNAL_RE =
  /\b(obsidian|memory|tracker|notes captured|committed to memory|updated .*md|documented|file comparison table)\b/i;
const REM_RETRY_SIGNAL_RE =
  /\b(repeat(?:ed|edly)?|again|retry|root cause|third attempt|fourth|fifth|consecutive failures?)\b/i;
const REM_PERSON_PATTERN_SIGNAL_RE =
  /\b(relationship|who:|patterns?:|failure modes?:|best stance:|space|boundaries|timing|family quick reference)\b/i;
const REM_SITUATIONAL_SIGNAL_RE =
  /\b(hotel|address|phone|reservation|check-?in|check-?out|flight|arrival|departure|terminal|price shown|invoice|pending items|screenshot|butler)\b/i;
const REM_PERSISTENCE_SIGNAL_RE =
  /\b(always|preference|prefers?|standing rule|best stance|failure modes?|key patterns?|relationship|who:|important .* keep track|people in .* life|partner|wife|husband|boyfriend|girlfriend)\b/i;
const REM_TRANSIENT_SIGNAL_RE =
  /\b(today|this session|in progress|installed|booked|confirmed|pending|status:|action pending|open items?|next steps?|issue:|diagnostics|screenshot|source file|insight files|thread\b|ticket|price shown|calendar fix|cron fixes|security audit|updates? this session|bought:|order\b)\b/i;
const REM_SECTION_PERSISTENCE_TITLE_RE =
  /\b(preferences? learned|preference|people update|relationship|standing|patterns?|identity|memory)\b/i;
const REM_SECTION_TRANSIENT_TITLE_RE =
  /\b(setup|fix|fixes|audit|booked|call|today|session|updates?|file paths|open items?|next steps?|research pipeline|info gathered|calendar|tickets?)\b/i;
const REM_METADATA_HEAVY_SIGNAL_RE =
  /\b(address|phone|email|website|google maps|source file|insight files|conversation id|thread has|order\b|reservation\b|price\b|cost\b|ticket|uuid|url:|model:|workspace:|bindings:|accountid|config change|path:)\b/i;
const REM_PROJECT_META_SIGNAL_RE =
  /\b(strategy|audit|discussion|research|topic|candidate|north star|pipeline|data dump|export|draft|insights? draft|weekly|analysis|findings)\b/i;
const REM_PROCESS_FRAME_SIGNAL_RE =
  /\b(dossier|registry|cadence|framework|facts,\s*timeline|open loops|next actions|auto preference rollups?|insights? draft created)\b/i;
const REM_TOOLING_META_SIGNAL_RE =
  /\b(cli|tool|tools\.md|agents\.md|sessionssend|subagents?|spawn|tmux|xurl|bird|codex exec|interactive codex)\b/i;
const REM_TRAVEL_DECISION_SIGNAL_RE =
  /\b(routing|cabin|business class|trip brief|departure|arrival|hotel|reservation|tickets?|show tonight|cheaper alternatives?|venue timing)\b/i;
const REM_STABLE_PERSON_SIGNAL_RE =
  /\b(partner|wife|husband|boyfriend|girlfriend|relationship interest|lives in)\b/i;
const REM_EXPLICIT_PREFERENCE_SIGNAL_RE =
  /\b(explicitly|wants?|does not want|don't want|default .* should|should default to|likes?|dislikes?|treat .* as|prefers?)\b/i;
const REM_MONITORING_SIGNAL_RE =
  /\b(heartbeat|ariston|collect-temps|low pressure|exit code|invalid[_-]?grant|token expired|token revoked|warning\/error|warning|alert(?:ing)?|checkpoint at|daily note file already existed|header creation|local time verified|calendar access failed|gmail .* failed|no proactive .* sent|silent log only|gateway restarted successfully|still no response|no reply yet|blocked\b|passkey|credential|password in bws|working correctly|catchup completed)\b/i;
const REM_SPECIFICITY_BURDEN_RE =
  /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b|€|\$\d|→|\b\d{1,2}:\d{2}\b|\+\d{6,}/i;
const REM_TIME_PREFIX_RE = /^\d{1,2}:\d{2}\s*-\s*/;
const REM_CODE_FENCE_RE = /^\s*```/;
const REM_TABLE_RE = /^\s*\|.*\|\s*$/;
const REM_TABLE_DIVIDER_RE = /^\s*\|?[\s:-]+\|[\s|:-]*$/;
const MAX_GROUNDED_REM_FILES = 512;
const MAX_GROUNDED_REM_FILE_BYTES = 1_000_000;
const GROUNDED_REM_SKIPPED_DIRS = new Set([".git", "node_modules"]);
const REM_SUMMARY_FACT_LIMIT = 4;
const REM_SUMMARY_REFLECTION_LIMIT = 4;
const REM_SUMMARY_MEMORY_LIMIT = 3;

export type GroundedRemPreviewItem = {
  text: string;
  refs: string[];
};

export type GroundedRemCandidate = GroundedRemPreviewItem & {
  lean: "likely_durable" | "unclear" | "likely_situational";
};

export type GroundedRemFilePreview = {
  path: string;
  facts: GroundedRemPreviewItem[];
  reflections: GroundedRemPreviewItem[];
  memoryImplications: GroundedRemPreviewItem[];
  candidates: GroundedRemCandidate[];
  renderedMarkdown: string;
};

export type GroundedRemPreviewResult = {
  workspaceDir: string;
  scannedFiles: number;
  files: GroundedRemFilePreview[];
};

type CandidateSnippetSummary = GroundedRemCandidate & {
  score: number;
};

type ParsedSectionLine = {
  line: number;
  text: string;
};

type ParsedMarkdownSection = {
  title: string;
  startLine: number;
  endLine: number;
  lines: ParsedSectionLine[];
};

type SectionSnippet = {
  text: string;
  line: number;
};

type SectionSummary = {
  title: string;
  text: string;
  refs: string[];
  scores: {
    preference: number;
    build: number;
    incident: number;
    logistics: number;
    tasks: number;
    routing: number;
    externalization: number;
    retries: number;
    overall: number;
  };
};

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function normalizePath(rawPath: string): string {
  return rawPath.replaceAll("\\", "/").replace(/^\.\//, "");
}

function stripMarkdown(text: string): string {
  return normalizeWhitespace(
    text
      .replace(/!\[[^\]]*]\([^)]*\)/g, "")
      .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
      .replace(/[`*_~>#]/g, "")
      .replace(/\s+/g, " "),
  );
}

function sanitizeSectionTitle(title: string): string {
  return normalizeWhitespace(stripMarkdown(title).replace(REM_TIME_PREFIX_RE, ""));
}

function makeRef(pathValue: string, startLine: number, endLine = startLine): string {
  return startLine === endLine
    ? `${pathValue}:${startLine}`
    : `${pathValue}:${startLine}-${endLine}`;
}

function parseMarkdownSections(content: string): ParsedMarkdownSection[] {
  const sections: ParsedMarkdownSection[] = [];
  const lines = content.split(/\r?\n/);
  let current: ParsedMarkdownSection | null = null;
  let inCodeFence = false;

  const flush = () => {
    if (!current) {
      return;
    }
    const meaningfulLines = current.lines.filter(
      (entry) => normalizeWhitespace(entry.text).length > 0,
    );
    if (meaningfulLines.length > 0) {
      const endLine = meaningfulLines[meaningfulLines.length - 1]?.line ?? current.endLine;
      sections.push({ ...current, endLine, lines: meaningfulLines });
    }
    current = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? "";
    const lineNumber = index + 1;
    if (REM_CODE_FENCE_RE.test(rawLine)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) {
      continue;
    }
    const headingMatch = rawLine.match(/^\s{0,3}(#{2,6})\s+(.+)$/);
    if (headingMatch?.[2]) {
      flush();
      current = {
        title: sanitizeSectionTitle(headingMatch[2]),
        startLine: lineNumber,
        endLine: lineNumber,
        lines: [],
      };
      continue;
    }
    if (!current) {
      continue;
    }
    current.endLine = lineNumber;
    const trimmed = rawLine.trim();
    if (
      !trimmed ||
      /^---+$/.test(trimmed) ||
      REM_TABLE_RE.test(trimmed) ||
      REM_TABLE_DIVIDER_RE.test(trimmed)
    ) {
      continue;
    }
    current.lines.push({ line: lineNumber, text: rawLine });
  }

  flush();
  return sections;
}

function sectionToSnippets(section: ParsedMarkdownSection): SectionSnippet[] {
  const snippets: SectionSnippet[] = [];
  const seen = new Set<string>();
  for (const entry of section.lines) {
    const trimmed = entry.text.trim();
    if (!trimmed) {
      continue;
    }
    const bulletMatch = trimmed.match(/^(?:[-*+]|\d+\.)\s+(?:\[[ xX]\]\s*)?(.*)$/);
    const candidateText = bulletMatch?.[1] ?? trimmed;
    const text = normalizeWhitespace(stripMarkdown(candidateText));
    if (text.length < 10) {
      continue;
    }
    const dedupeKey = text.toLowerCase();
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    snippets.push({ text, line: entry.line });
  }
  return snippets;
}

function countMatchingSnippets(snippets: SectionSnippet[], pattern: RegExp): number {
  let count = 0;
  for (const snippet of snippets) {
    if (pattern.test(snippet.text)) {
      count += 1;
    }
  }
  return count;
}

function scoreSection(section: ParsedMarkdownSection, snippets: SectionSnippet[]) {
  const title = section.title;
  const titleBonus = (pattern: RegExp) => (pattern.test(title) ? 1 : 0);
  const preference =
    countMatchingSnippets(snippets, REM_MEMORY_SIGNAL_RE) + titleBonus(REM_MEMORY_SIGNAL_RE);
  const build =
    countMatchingSnippets(snippets, REM_BUILD_SIGNAL_RE) + titleBonus(REM_BUILD_SIGNAL_RE);
  const incident =
    countMatchingSnippets(snippets, REM_INCIDENT_SIGNAL_RE) + titleBonus(REM_INCIDENT_SIGNAL_RE);
  const logistics =
    countMatchingSnippets(snippets, REM_LOGISTICS_SIGNAL_RE) + titleBonus(REM_LOGISTICS_SIGNAL_RE);
  const tasks =
    countMatchingSnippets(snippets, REM_TASK_SIGNAL_RE) + titleBonus(REM_TASK_SIGNAL_RE);
  const routing =
    countMatchingSnippets(snippets, REM_ROUTING_SIGNAL_RE) + titleBonus(REM_ROUTING_SIGNAL_RE);
  const externalization =
    countMatchingSnippets(snippets, REM_EXTERNALIZATION_SIGNAL_RE) +
    titleBonus(REM_EXTERNALIZATION_SIGNAL_RE);
  const retries =
    countMatchingSnippets(snippets, REM_RETRY_SIGNAL_RE) + titleBonus(REM_RETRY_SIGNAL_RE);
  const overall =
    preference * 2 +
    build * 1.6 +
    incident * 1.6 +
    logistics * 1.2 +
    routing * 1.8 +
    externalization * 1.4 +
    Math.min(snippets.length, 3) * 0.3 -
    (REM_GENERIC_SECTION_RE.test(title) ? 0.8 : 0);
  return {
    preference,
    build,
    incident,
    logistics,
    tasks,
    routing,
    externalization,
    retries,
    overall,
  };
}

function scoreSnippet(text: string, title: string): number {
  let score = 1;
  if (REM_MEMORY_SIGNAL_RE.test(text)) {
    score += 2.2;
  }
  if (REM_BUILD_SIGNAL_RE.test(text)) {
    score += 1.2;
  }
  if (REM_INCIDENT_SIGNAL_RE.test(text)) {
    score += 1.2;
  }
  if (REM_LOGISTICS_SIGNAL_RE.test(text)) {
    score += 0.9;
  }
  if (REM_ROUTING_SIGNAL_RE.test(text)) {
    score += 1.4;
  }
  if (REM_EXTERNALIZATION_SIGNAL_RE.test(text)) {
    score += 1.1;
  }
  if (REM_RETRY_SIGNAL_RE.test(text)) {
    score += 0.9;
  }
  if (REM_TASK_SIGNAL_RE.test(text) && !REM_BUILD_SIGNAL_RE.test(text)) {
    score -= 0.8;
  }
  if (title && !REM_GENERIC_SECTION_RE.test(title)) {
    score += 0.25;
  }
  return score;
}

function chooseSummarySnippets(
  section: ParsedMarkdownSection,
  snippets: SectionSnippet[],
): SectionSnippet[] {
  const selectionLimit = REM_GENERIC_SECTION_RE.test(section.title) ? 2 : 3;
  return [...snippets]
    .toSorted((left, right) => {
      const scoreDelta =
        scoreSnippet(right.text, section.title) - scoreSnippet(left.text, section.title);
      if (scoreDelta !== 0) {
        return scoreDelta;
      }
      return left.line - right.line;
    })
    .slice(0, selectionLimit)
    .toSorted((left, right) => left.line - right.line);
}

function joinSummaryParts(parts: string[]): string {
  if (parts.length <= 1) {
    return parts[0] ?? "";
  }
  if (parts.length === 2) {
    return `${parts[0]} and ${parts[1]}`;
  }
  return `${parts.slice(0, -1).join("; ")}; and ${parts[parts.length - 1]}`;
}

function summarizeSection(
  pathValue: string,
  section: ParsedMarkdownSection,
): SectionSummary | null {
  if (REM_BLOCKED_SECTION_RE.test(section.title)) {
    return null;
  }
  const snippets = sectionToSnippets(section);
  if (snippets.length === 0) {
    return null;
  }
  const selected = chooseSummarySnippets(section, snippets);
  if (selected.length === 0) {
    return null;
  }
  const title = sanitizeSectionTitle(section.title);
  const body = joinSummaryParts(selected.map((snippet) => snippet.text));
  const text = !title || REM_GENERIC_SECTION_RE.test(title) ? body : `${title}: ${body}`;
  return {
    title,
    text,
    refs: selected.map((snippet) => makeRef(pathValue, snippet.line)),
    scores: scoreSection(section, snippets),
  };
}

function compactCandidateTitle(title: string): string {
  let compact = sanitizeSectionTitle(title)
    .replace(/\s*\((?:via:|from qmd \+ memory|this session)[^)]+\)\s*/gi, " ")
    .replace(
      /\s*[—-]\s*(?:research results.*|in progress.*|working.*|installed.*|booked.*|proposed.*|clarified.*|candidate.*|fixes.*|updates?.*)$/i,
      "",
    )
    .trim();
  if (/^(?:preferences? learned|candidate facts?)$/i.test(compact)) {
    return "";
  }
  compact = compact.replace(/^preference:\s*/i, "");
  return compact;
}

function compactCandidateSnippetText(text: string, title: string): string {
  const normalized = normalizeWhitespace(text);
  if (REM_MONITORING_SIGNAL_RE.test(`${title} ${normalized}`)) {
    return normalized
      .replace(/\b(?:local time verified[^.;]*[.;]?\s*)/gi, "")
      .replace(/\b(?:daily note file already existed[^.;]*[.;]?\s*)/gi, "")
      .replace(/\b(?:header creation[^.;]*[.;]?\s*)/gi, "")
      .trim();
  }
  if (REM_STABLE_PERSON_SIGNAL_RE.test(`${title} ${normalized}`)) {
    return (normalized.split(/(?<=[.?!])\s+/)[0] ?? normalized).trim();
  }
  return normalized;
}

function isDurableSignalSnippet(text: string, title: string): boolean {
  return (
    REM_MEMORY_SIGNAL_RE.test(text) ||
    REM_PERSISTENCE_SIGNAL_RE.test(text) ||
    REM_EXPLICIT_PREFERENCE_SIGNAL_RE.test(text) ||
    REM_STABLE_PERSON_SIGNAL_RE.test(`${title} ${text}`) ||
    REM_PERSON_PATTERN_SIGNAL_RE.test(text)
  );
}

function scoreCandidateSnippet(text: string, title: string): number {
  let score = 0;
  if (REM_PERSISTENCE_SIGNAL_RE.test(text)) {
    score += 3.2;
  }
  if (REM_MEMORY_SIGNAL_RE.test(text)) {
    score += 2.4;
  }
  if (REM_EXPLICIT_PREFERENCE_SIGNAL_RE.test(text)) {
    score += 1.8;
  }
  if (REM_PERSON_PATTERN_SIGNAL_RE.test(text)) {
    score += 2.3;
  }
  if (REM_OPERATOR_RULE_SIGNAL_RE.test(text)) {
    score += 1.6;
  }
  if (REM_SECTION_PERSISTENCE_TITLE_RE.test(title)) {
    score += 1.2;
  }
  if (REM_STABLE_PERSON_SIGNAL_RE.test(text)) {
    score += 1.5;
  }
  if (REM_METADATA_HEAVY_SIGNAL_RE.test(text)) {
    score -= 2.4;
  }
  if (REM_PROJECT_META_SIGNAL_RE.test(`${title} ${text}`)) {
    score -= 2.2;
  }
  if (REM_PROCESS_FRAME_SIGNAL_RE.test(text)) {
    score -= 2.4;
  }
  if (REM_TOOLING_META_SIGNAL_RE.test(text) && !REM_STABLE_PERSON_SIGNAL_RE.test(text)) {
    score -= 2.1;
  }
  if (REM_MONITORING_SIGNAL_RE.test(`${title} ${text}`) && !REM_MEMORY_SIGNAL_RE.test(text)) {
    score -= 4.2;
  }
  if (REM_TRAVEL_DECISION_SIGNAL_RE.test(text)) {
    score -= 2.6;
  }
  if (REM_SPECIFICITY_BURDEN_RE.test(text) && !REM_STABLE_PERSON_SIGNAL_RE.test(text)) {
    score -= 1.2;
  }
  if (REM_SITUATIONAL_SIGNAL_RE.test(text)) {
    score -= 2.8;
  }
  if (REM_TRANSIENT_SIGNAL_RE.test(text)) {
    score -= 2;
  }
  if (REM_INCIDENT_SIGNAL_RE.test(text)) {
    score -= 1.6;
  }
  if (REM_TASK_SIGNAL_RE.test(text)) {
    score -= 1.2;
  }
  if (REM_LOGISTICS_SIGNAL_RE.test(text) && !REM_MEMORY_SIGNAL_RE.test(text)) {
    score -= 1.4;
  }
  if (REM_BUILD_SIGNAL_RE.test(text) && !REM_MEMORY_SIGNAL_RE.test(text)) {
    score -= 0.8;
  }
  if (REM_SECTION_TRANSIENT_TITLE_RE.test(title) && !REM_SECTION_PERSISTENCE_TITLE_RE.test(title)) {
    score -= 1.2;
  }
  if (/[`/]/.test(text) || /https?:\/\//i.test(text)) {
    score -= 0.8;
  }
  return score;
}

function chooseFactSnippets(
  section: ParsedMarkdownSection,
  snippets: SectionSnippet[],
): SectionSnippet[] {
  return [...snippets]
    .map((snippet) => {
      const text = compactCandidateSnippetText(snippet.text, section.title);
      const score =
        scoreCandidateSnippet(text, section.title) + (REM_MEMORY_SIGNAL_RE.test(text) ? 0.6 : 0);
      return { snippet: { ...snippet, text }, score };
    })
    .filter(
      (entry) =>
        !REM_MONITORING_SIGNAL_RE.test(`${section.title} ${entry.snippet.text}`) ||
        isDurableSignalSnippet(entry.snippet.text, section.title),
    )
    .filter((entry) => entry.snippet.text.length >= 18 && entry.score >= 1.4)
    .toSorted((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.snippet.line - right.snippet.line;
    })
    .slice(0, 2)
    .map((entry) => entry.snippet)
    .toSorted((left, right) => left.line - right.line);
}

type FactSnippetSummary = GroundedRemPreviewItem & {
  score: number;
};

function buildFactText(title: string, text: string): string {
  const compactTitle = compactCandidateTitle(title);
  if (!compactTitle) {
    return text;
  }
  if (
    REM_SECTION_PERSISTENCE_TITLE_RE.test(compactTitle) ||
    REM_STABLE_PERSON_SIGNAL_RE.test(compactTitle) ||
    /\b(relationship|people mentioned|people update|identity)\b/i.test(compactTitle)
  ) {
    return `${compactTitle}: ${text}`;
  }
  return text;
}

function chooseCandidateSnippets(
  section: ParsedMarkdownSection,
  snippets: SectionSnippet[],
): SectionSnippet[] {
  return [...snippets]
    .map((snippet) => {
      const text = compactCandidateSnippetText(snippet.text, section.title);
      const claimScores = atomizeClaimText(text).map((claim) =>
        scoreCandidateSnippet(claim, section.title),
      );
      const score = Math.max(
        scoreCandidateSnippet(text, section.title),
        ...claimScores,
        Number.NEGATIVE_INFINITY,
      );
      return { snippet: { ...snippet, text }, score };
    })
    .filter(
      (entry) =>
        !REM_MONITORING_SIGNAL_RE.test(`${section.title} ${entry.snippet.text}`) ||
        isDurableSignalSnippet(entry.snippet.text, section.title),
    )
    .filter((entry) => entry.snippet.text.length >= 18 && entry.score >= 1.8)
    .toSorted((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.snippet.line - right.snippet.line;
    })
    .slice(0, 2)
    .map((entry) => entry.snippet)
    .toSorted((left, right) => left.line - right.line);
}

function buildCandidateSnippetText(title: string, text: string): string {
  return buildFactText(title, text);
}

function findTopLevelDelimiter(text: string, delimiter: string): number {
  let roundDepth = 0;
  let squareDepth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "(") {
      roundDepth += 1;
    } else if (char === ")") {
      roundDepth = Math.max(0, roundDepth - 1);
    } else if (char === "[") {
      squareDepth += 1;
    } else if (char === "]") {
      squareDepth = Math.max(0, squareDepth - 1);
    } else if (char === delimiter && roundDepth === 0 && squareDepth === 0) {
      return index;
    }
  }
  return -1;
}

function splitTopLevelClauses(text: string, delimiter: string): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    const splitAt = findTopLevelDelimiter(rest, delimiter);
    if (splitAt < 0) {
      parts.push(rest);
      break;
    }
    parts.push(rest.slice(0, splitAt));
    rest = rest.slice(splitAt + 1);
  }
  return parts.map((part) => normalizeWhitespace(part)).filter(Boolean);
}

function splitSubjectLeadClaim(text: string): string[] {
  const match = /^(?<subject>.+?(?:—|–|\s-\s))\s*(?<rest>.+)$/u.exec(text);
  if (!match?.groups) {
    return [text];
  }
  const subject = normalizeWhitespace(match.groups.subject);
  const rest = normalizeWhitespace(match.groups.rest);
  if (!subject || !rest) {
    return [text];
  }
  const commaIndex = findTopLevelDelimiter(rest, ",");
  if (commaIndex < 0) {
    return [text];
  }
  const first = normalizeWhitespace(rest.slice(0, commaIndex));
  const remainder = normalizeWhitespace(rest.slice(commaIndex + 1));
  if (first.length < 3 || remainder.length < 6) {
    return [text];
  }
  return [`${subject} ${first}`, `${subject} ${remainder}`];
}

function atomizeClaimText(text: string): string[] {
  const normalized = normalizeWhitespace(text);
  if (!normalized) {
    return [];
  }
  const atomic = splitTopLevelClauses(normalized, ";")
    .flatMap((part) => splitSubjectLeadClaim(part))
    .map((part) => normalizeWhitespace(part))
    .filter(Boolean);
  return Array.from(new Set(atomic)).slice(0, 3);
}

function classifyCandidateLeanFromText(text: string, title: string): GroundedRemCandidate["lean"] {
  const score = scoreCandidateSnippet(text, title);
  if (score >= 4) {
    return "likely_durable";
  }
  if (score <= 0.25 || REM_SITUATIONAL_SIGNAL_RE.test(text) || REM_TRANSIENT_SIGNAL_RE.test(text)) {
    return "likely_situational";
  }
  return "unclear";
}

function addReflection(
  reflections: GroundedRemPreviewItem[],
  seen: Set<string>,
  text: string,
  refs: string[],
) {
  const normalized = normalizeWhitespace(text);
  const key = normalized.toLowerCase();
  if (!normalized || seen.has(key)) {
    return;
  }
  seen.add(key);
  reflections.push({ text: normalized, refs });
}

function isOperatorRuleSummary(summary: SectionSummary): boolean {
  return (
    /process improvements?/i.test(summary.title) || REM_OPERATOR_RULE_SIGNAL_RE.test(summary.text)
  );
}

function isRoutingSummary(summary: SectionSummary): boolean {
  return summary.scores.routing > 0 || REM_ROUTING_SIGNAL_RE.test(summary.text);
}

function findStrongestSummary(
  summaries: SectionSummary[],
  predicate: (summary: SectionSummary) => boolean,
): SectionSummary | undefined {
  let strongest: SectionSummary | undefined;
  for (const summary of summaries) {
    if (!predicate(summary)) {
      continue;
    }
    if (!strongest || summary.scores.overall > strongest.scores.overall) {
      strongest = summary;
    }
  }
  return strongest;
}

function previewGroundedRemForFile(params: {
  relPath: string;
  content: string;
}): GroundedRemFilePreview {
  const sections = parseMarkdownSections(params.content);
  const sectionScores = sections.map((section) => ({
    section,
    snippets: sectionToSnippets(section),
  }));
  const monitoringSignal = sectionScores.reduce(
    (sum, { section, snippets }) =>
      sum +
      countMatchingSnippets(snippets, REM_MONITORING_SIGNAL_RE) +
      (REM_MONITORING_SIGNAL_RE.test(section.title) ? 1 : 0),
    0,
  );
  const summaries = sectionScores
    .map(({ section }) => summarizeSection(params.relPath, section))
    .filter((summary): summary is SectionSummary => summary !== null);
  const factSummaries: FactSnippetSummary[] = sections.flatMap((section) => {
    if (REM_BLOCKED_SECTION_RE.test(section.title)) {
      return [];
    }
    const snippets = sectionToSnippets(section);
    if (snippets.length === 0) {
      return [];
    }
    return chooseFactSnippets(section, snippets).map((snippet) => ({
      text: buildFactText(section.title, snippet.text),
      refs: [makeRef(params.relPath, snippet.line)],
      score: scoreCandidateSnippet(snippet.text, section.title),
    }));
  });

  const memoryImplications = summaries
    .filter((summary) => summary.scores.preference > 0 || isOperatorRuleSummary(summary))
    .map((summary) => ({
      text: summary.text.replace(/^[^:]+:\s*/, ""),
      refs: summary.refs,
    }))
    .filter((item, index, items) => items.findIndex((entry) => entry.text === item.text) === index)
    .slice(0, REM_SUMMARY_MEMORY_LIMIT);

  const candidateSnippets: CandidateSnippetSummary[] = sections.flatMap((section) => {
    if (REM_BLOCKED_SECTION_RE.test(section.title)) {
      return [];
    }
    const snippets = sectionToSnippets(section);
    if (snippets.length === 0) {
      return [];
    }
    return chooseCandidateSnippets(section, snippets).flatMap((snippet) =>
      atomizeClaimText(snippet.text)
        .map((claim) => {
          const score = scoreCandidateSnippet(claim, section.title);
          const text = buildCandidateSnippetText(section.title, claim);
          return {
            text,
            refs: [makeRef(params.relPath, snippet.line)],
            lean: classifyCandidateLeanFromText(claim, section.title),
            score,
          };
        })
        .filter((candidate) => candidate.text.length >= 12 && candidate.score >= 1.8),
    );
  });

  const candidates = candidateSnippets
    .toSorted((left, right) => {
      const leanRank = { likely_durable: 0, unclear: 1, likely_situational: 2 };
      const leanDelta = leanRank[left.lean] - leanRank[right.lean];
      if (leanDelta !== 0) {
        return leanDelta;
      }
      return right.score - left.score;
    })
    .filter(
      (candidate, index, items) =>
        items.findIndex((entry) => entry.text === candidate.text) === index,
    )
    .slice(0, 4);

  const durableImplications = candidateSnippets
    .filter((candidate) => candidate.lean === "likely_durable" || candidate.score >= 4)
    .filter(
      (candidate, index, items) =>
        items.findIndex((entry) => entry.text === candidate.text) === index,
    )
    .toSorted((left, right) => right.score - left.score)
    .slice(0, REM_SUMMARY_MEMORY_LIMIT)
    .map((candidate) => ({ text: candidate.text, refs: candidate.refs }));

  const candidateDrivenImplications = candidateSnippets
    .filter((candidate) => candidate.lean !== "likely_situational" && candidate.score >= 2.2)
    .filter(
      (candidate, index, items) =>
        items.findIndex((entry) => entry.text === candidate.text) === index,
    )
    .toSorted((left, right) => right.score - left.score)
    .slice(0, REM_SUMMARY_MEMORY_LIMIT)
    .map((candidate) => ({ text: candidate.text, refs: candidate.refs }));

  const effectiveMemoryImplications =
    durableImplications.length > 0
      ? durableImplications
      : candidateDrivenImplications.length > 0
        ? candidateDrivenImplications
        : memoryImplications;

  const facts: GroundedRemPreviewItem[] = [];
  const usedFactTexts = new Set<string>();
  for (const summary of factSummaries.toSorted((left, right) => right.score - left.score)) {
    const key = summary.text.toLowerCase();
    if (usedFactTexts.has(key)) {
      continue;
    }
    usedFactTexts.add(key);
    facts.push({ text: summary.text, refs: summary.refs });
    if (facts.length >= REM_SUMMARY_FACT_LIMIT) {
      break;
    }
  }
  if (facts.length === 0 && monitoringSignal < 3) {
    const bestFor = (metric: keyof SectionSummary["scores"]) =>
      summaries
        .filter((summary) => summary.scores[metric] > 0)
        .toSorted((left, right) => {
          if (right.scores[metric] !== left.scores[metric]) {
            return right.scores[metric] - left.scores[metric];
          }
          return right.scores.overall - left.scores.overall;
        })[0];
    for (const summary of [
      bestFor("preference"),
      bestFor("routing"),
      bestFor("externalization"),
      ...summaries.toSorted((left, right) => right.scores.overall - left.scores.overall),
    ]) {
      if (!summary) {
        continue;
      }
      const key = summary.text.toLowerCase();
      if (usedFactTexts.has(key)) {
        continue;
      }
      usedFactTexts.add(key);
      facts.push({ text: summary.text, refs: summary.refs });
      if (facts.length >= REM_SUMMARY_FACT_LIMIT) {
        break;
      }
    }
  }

  const reflections: GroundedRemPreviewItem[] = [];
  const seenReflections = new Set<string>();
  const relationshipFacts = facts.filter((item) => REM_STABLE_PERSON_SIGNAL_RE.test(item.text));
  const multiRelationshipContext = relationshipFacts.length >= 2;
  const buildSignal = summaries.reduce((sum, item) => sum + item.scores.build, 0);
  const incidentSignal = summaries.reduce((sum, item) => sum + item.scores.incident, 0);
  const logisticsSignal = summaries.reduce((sum, item) => sum + item.scores.logistics, 0);
  const routingSignal = summaries.reduce((sum, item) => sum + item.scores.routing, 0);
  const externalizationSignal = summaries.reduce(
    (sum, item) => sum + item.scores.externalization,
    0,
  );
  const retrySignal = summaries.reduce((sum, item) => sum + item.scores.retries, 0);
  const taskSignal = sectionScores.reduce(
    (sum, { section, snippets }) => sum + scoreSection(section, snippets).tasks,
    0,
  );
  const strongestRoutingSummary = findStrongestSummary(summaries, isRoutingSummary);
  const strongestIncidentSummary = findStrongestSummary(
    summaries,
    (summary) => summary.scores.incident > 0,
  );
  const strongestExternalizationSummary = findStrongestSummary(
    summaries,
    (summary) => summary.scores.externalization > 0,
  );

  if (facts.length === 0 && monitoringSignal >= 3) {
    addReflection(
      reflections,
      seenReflections,
      "This day reads mostly as monitoring and operational state, not as durable memory. It should be treated as current-state exhaust unless a clearer rule or preference appears.",
      [
        makeRef(
          params.relPath,
          sections[0]?.startLine ?? 1,
          sections[sections.length - 1]?.endLine ?? 1,
        ),
      ],
    );
  }
  if (effectiveMemoryImplications.length > 0) {
    addReflection(
      reflections,
      seenReflections,
      "A stable rule or preference was stated explicitly, which suggests operating choices are being made legible instead of left implicit.",
      effectiveMemoryImplications.flatMap((item) => item.refs).slice(0, 3),
    );
  }
  if (multiRelationshipContext) {
    addReflection(
      reflections,
      seenReflections,
      "More than one active relationship thread appears in the same day, which means person-memory matters operationally: who each person is should be kept separate from the transient date or venue details attached to them.",
      relationshipFacts.flatMap((item) => item.refs).slice(0, 3),
    );
  }
  if (
    !multiRelationshipContext &&
    facts.length > 0 &&
    routingSignal >= 2 &&
    strongestRoutingSummary &&
    buildSignal >= incidentSignal
  ) {
    addReflection(
      reflections,
      seenReflections,
      "The strongest pattern here is a preference for converting messy inbound information into routed workflows with different downstream actions, instead of handling each case manually.",
      strongestRoutingSummary.refs,
    );
  }
  if (
    !multiRelationshipContext &&
    facts.length > 0 &&
    externalizationSignal >= 2 &&
    strongestExternalizationSummary
  ) {
    addReflection(
      reflections,
      seenReflections,
      "Important context tends to get externalized quickly into notes, trackers, or memory surfaces, which suggests a preference for explicit systems over holding context informally.",
      strongestExternalizationSummary.refs,
    );
  }
  if (!multiRelationshipContext && facts.length > 0 && buildSignal >= 2) {
    const buildRefs = facts
      .filter((item) => REM_BUILD_SIGNAL_RE.test(item.text))
      .flatMap((item) => item.refs)
      .slice(0, 3);
    if (buildRefs.length > 0) {
      addReflection(
        reflections,
        seenReflections,
        "The day leaned toward building operator infrastructure, which suggests the interaction is often used to reshape the system around recurring needs rather than just complete isolated tasks.",
        buildRefs,
      );
    }
  }
  if (facts.length > 0 && incidentSignal >= 2 && strongestIncidentSummary) {
    addReflection(
      reflections,
      seenReflections,
      retrySignal >= 2
        ? "When something breaks repeatedly, the response is systematic: retries, root-cause narrowing, and preserving enough state to resume once the blocker is fixed."
        : "A meaningful share of the day went into friction, and the interaction pattern looks pragmatic rather than emotional: diagnose the blocker, preserve state, and move on.",
      strongestIncidentSummary.refs,
    );
  }
  if (!multiRelationshipContext && facts.length > 0 && logisticsSignal >= 2) {
    const logisticsRefs = facts
      .filter((item) => REM_LOGISTICS_SIGNAL_RE.test(item.text))
      .flatMap((item) => item.refs)
      .slice(0, 3);
    if (logisticsRefs.length > 0) {
      addReflection(
        reflections,
        seenReflections,
        "Personal logistics and operating-system work are being managed in the same surface, which suggests a preference for one integrated control plane rather than separate personal and technical loops.",
        logisticsRefs,
      );
    }
  }
  if (taskSignal >= 3 && reflections.length === 0) {
    addReflection(
      reflections,
      seenReflections,
      "The raw note is mostly task and current-state material, so it should not be over-read as memory.",
      [
        makeRef(
          params.relPath,
          sections[0]?.startLine ?? 1,
          sections[sections.length - 1]?.endLine ?? 1,
        ),
      ],
    );
  }

  const reflectionLimit =
    facts.length === 0
      ? 1
      : facts.length === 1
        ? 2
        : Math.min(REM_SUMMARY_REFLECTION_LIMIT, facts.length + 1);
  const visibleReflections = reflections.slice(0, reflectionLimit);

  const renderedLines: string[] = [];
  renderedLines.push("## What Happened");
  if (facts.length === 0) {
    renderedLines.push("1. No grounded facts were extracted.");
  } else {
    for (const [index, fact] of facts.entries()) {
      renderedLines.push(`${index + 1}. ${fact.text} [${fact.refs.join(", ")}]`);
    }
  }
  renderedLines.push("");
  renderedLines.push("## Reflections");
  if (visibleReflections.length === 0) {
    renderedLines.push("1. No grounded reflections emerged from this note yet.");
  } else {
    for (const [index, reflection] of visibleReflections.entries()) {
      renderedLines.push(`${index + 1}. ${reflection.text} [${reflection.refs.join(", ")}]`);
    }
  }
  if (candidates.length > 0) {
    renderedLines.push("");
    renderedLines.push("## Candidates");
    for (const candidate of candidates) {
      renderedLines.push(`- [${candidate.lean}] ${candidate.text} [${candidate.refs.join(", ")}]`);
    }
  }
  if (effectiveMemoryImplications.length > 0) {
    renderedLines.push("");
    renderedLines.push("## Possible Lasting Updates");
    for (const implication of effectiveMemoryImplications) {
      renderedLines.push(`- ${implication.text} [${implication.refs.join(", ")}]`);
    }
  }

  return {
    path: params.relPath,
    facts,
    reflections: visibleReflections,
    memoryImplications: effectiveMemoryImplications,
    candidates,
    renderedMarkdown: renderedLines.join("\n"),
  };
}

async function collectMarkdownFiles(inputPaths: string[]): Promise<string[]> {
  const found = new Set<string>();
  async function walk(targetPath: string): Promise<void> {
    if (found.size >= MAX_GROUNDED_REM_FILES) {
      return;
    }
    const resolved = path.resolve(targetPath);
    const stat = await fs.lstat(resolved);
    if (stat.isSymbolicLink()) {
      return;
    }
    if (stat.isDirectory()) {
      const entries = await fs.readdir(resolved, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && GROUNDED_REM_SKIPPED_DIRS.has(entry.name)) {
          continue;
        }
        await walk(path.join(resolved, entry.name));
      }
      return;
    }
    if (
      stat.isFile() &&
      stat.size <= MAX_GROUNDED_REM_FILE_BYTES &&
      resolved.toLowerCase().endsWith(".md")
    ) {
      found.add(resolved);
    }
  }
  for (const inputPath of inputPaths) {
    const trimmed = inputPath.trim();
    if (!trimmed) {
      continue;
    }
    await walk(trimmed);
  }
  return Array.from(found).toSorted((left, right) => left.localeCompare(right));
}

export async function previewGroundedRemMarkdown(params: {
  workspaceDir: string;
  inputPaths: string[];
}): Promise<GroundedRemPreviewResult> {
  const workspaceDir = params.workspaceDir.trim();
  const files = await collectMarkdownFiles(params.inputPaths);
  const previews: GroundedRemFilePreview[] = [];
  for (const filePath of files) {
    const content = await fs.readFile(filePath, "utf-8");
    const relPath = normalizePath(path.relative(workspaceDir, filePath));
    previews.push(previewGroundedRemForFile({ relPath, content }));
  }
  return {
    workspaceDir,
    scannedFiles: files.length,
    files: previews,
  };
}

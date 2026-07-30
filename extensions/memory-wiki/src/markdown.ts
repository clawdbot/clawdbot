// Memory Wiki plugin module implements markdown behavior.
import { createHash } from "node:crypto";
import path from "node:path";
import { fromMarkdown } from "mdast-util-from-markdown";
import {
  asFiniteNumber,
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  normalizeSingleOrTrimmedStringList,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import YAML from "yaml";

const WIKI_PAGE_KINDS = ["entity", "concept", "source", "synthesis", "report"] as const;
export const WIKI_RELATED_START_MARKER = "<!-- openclaw:wiki:related:start -->";
export const WIKI_RELATED_END_MARKER = "<!-- openclaw:wiki:related:end -->";
export const WIKI_RAW_SOURCE_MARKER = "<!-- openclaw:wiki:raw-source -->";

export type WikiPageKind = (typeof WIKI_PAGE_KINDS)[number];
type GeneratedSourceBody = "bridge" | "unsafe-local" | "local-file" | "chatgpt-export";

type ParsedWikiMarkdown = {
  hasFrontmatter: boolean;
  frontmatter: Record<string, unknown>;
  body: string;
};

export type WikiClaimEvidence = {
  kind?: string;
  sourceId?: string;
  path?: string;
  lines?: string;
  weight?: number;
  confidence?: number;
  privacyTier?: string;
  note?: string;
  updatedAt?: string;
};

export type WikiClaim = {
  id?: string;
  text: string;
  status?: string;
  confidence?: number;
  evidence: WikiClaimEvidence[];
  updatedAt?: string;
};

type WikiPersonCard = {
  canonicalId?: string;
  handles: string[];
  socials: string[];
  emails: string[];
  timezone?: string;
  lane?: string;
  askFor: string[];
  avoidAskingFor: string[];
  bestUsedFor: string[];
  notEnoughFor: string[];
  confidence?: number;
  privacyTier?: string;
  lastRefreshedAt?: string;
};

export type WikiRelationship = {
  targetId?: string;
  targetPath?: string;
  targetTitle?: string;
  kind?: string;
  weight?: number;
  confidence?: number;
  evidenceKind?: string;
  privacyTier?: string;
  note?: string;
  updatedAt?: string;
};

export type WikiPageFrontmatterError = {
  relativePath: string;
  message: string;
};

export type WikiPageSummary = {
  absolutePath: string;
  relativePath: string;
  kind: WikiPageKind;
  title: string;
  hasFrontmatter: boolean;
  id?: string;
  pageType?: string;
  entityType?: string;
  canonicalId?: string;
  aliases: string[];
  sourceIds: string[];
  linkTargets: string[];
  claims: WikiClaim[];
  contradictions: string[];
  questions: string[];
  confidence?: number;
  privacyTier?: string;
  personCard?: WikiPersonCard;
  relationships: WikiRelationship[];
  bestUsedFor: string[];
  notEnoughFor: string[];
  sourceType?: string;
  provenanceMode?: string;
  importedSourceBody?: "bridge" | "unsafe-local";
  generatedSourceBody?: GeneratedSourceBody;
  unmanagedRawSourceBody?: boolean;
  sourcePath?: string;
  bridgeRelativePath?: string;
  bridgeWorkspaceDir?: string;
  bridgeAgentIds: string[];
  unsafeLocalConfiguredPath?: string;
  unsafeLocalRelativePath?: string;
  lastRefreshedAt?: string;
  updatedAt?: string;
};

type WikiPageSummaryScanResult =
  | { status: "valid"; page: WikiPageSummary }
  | { status: "invalid-frontmatter"; error: WikiPageFrontmatterError }
  | { status: "ignored" };

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const OBSIDIAN_LINK_PATTERN = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
const MARKDOWN_LINK_PATTERN = /\[[^\]]+\]\(([^)]+)\)/g;
const RELATED_BLOCK_PATTERN = new RegExp(
  `${WIKI_RELATED_START_MARKER}[\\s\\S]*?${WIKI_RELATED_END_MARKER}`,
  "g",
);
const MAX_WIKI_SEGMENT_BYTES = 240;
const MAX_WIKI_FILENAME_COMPONENT_BYTES = 255;
const FS_SAFE_PINNED_WRITE_TEMP_SUFFIX = ".00000000-0000-4000-8000-000000000000.fallback.tmp";
const MAX_WIKI_SAFE_WRITE_FILENAME_COMPONENT_BYTES =
  MAX_WIKI_FILENAME_COMPONENT_BYTES -
  Buffer.byteLength(FS_SAFE_PINNED_WRITE_TEMP_SUFFIX) -
  Buffer.byteLength(".");
const WIKI_SEGMENT_HASH_BYTES = 12;
const WIKI_RESERVED_PAGE_STEMS = new Set(["index"]);
const HUMAN_START_MARKER = "<!-- openclaw:human:start -->";
const HUMAN_END_MARKER = "<!-- openclaw:human:end -->";

function truncateUtf8CodePointSafe(value: string, maxBytes: number): string {
  let result = "";
  let bytes = 0;
  for (const char of value) {
    const nextBytes = Buffer.byteLength(char);
    if (bytes + nextBytes > maxBytes) {
      break;
    }
    result += char;
    bytes += nextBytes;
  }
  return result;
}

function capWikiValueWithHash(raw: string, maxBytes: number, fallback: string): string {
  if (Buffer.byteLength(raw) <= maxBytes) {
    return raw;
  }
  const suffix = createHash("sha1").update(raw).digest("hex").slice(0, WIKI_SEGMENT_HASH_BYTES);
  const truncated = truncateUtf8CodePointSafe(
    raw,
    maxBytes - Buffer.byteLength(`-${suffix}`),
  ).replace(/-+$/g, "");
  return `${truncated || fallback}-${suffix}`;
}

export function slugifyWikiSegment(raw: string): string {
  const slug = normalizeLowercaseStringOrEmpty(raw)
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) {
    return "page";
  }
  return capWikiValueWithHash(slug, MAX_WIKI_SEGMENT_BYTES, "page");
}

export function slugifyWikiPageStem(raw: string): string {
  const slug = slugifyWikiSegment(raw);
  if (!WIKI_RESERVED_PAGE_STEMS.has(slug)) {
    return slug;
  }
  const suffix = createHash("sha1").update(slug).digest("hex").slice(0, WIKI_SEGMENT_HASH_BYTES);
  return `${slug}-${suffix}`;
}

export function createWikiPageFilename(stem: string, extension = ".md"): string {
  const normalizedExtension = extension.startsWith(".") ? extension : `.${extension}`;
  const maxStemBytes = Math.max(
    1,
    MAX_WIKI_SAFE_WRITE_FILENAME_COMPONENT_BYTES - Buffer.byteLength(normalizedExtension),
  );
  return `${capWikiValueWithHash(stem, maxStemBytes, "page")}${normalizedExtension}`;
}

export function parseWikiMarkdown(content: string): ParsedWikiMarkdown {
  const match = content.match(FRONTMATTER_PATTERN);
  if (!match) {
    return { hasFrontmatter: false, frontmatter: {}, body: content };
  }
  const frontmatter = match[1];
  if (frontmatter === undefined) {
    return { hasFrontmatter: false, frontmatter: {}, body: content };
  }
  const parsed: unknown = YAML.parse(frontmatter);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    // Every writer spreads this value back into YAML. Reject non-mapping roots
    // so an edit cannot silently replace scalar or sequence frontmatter.
    throw new TypeError("Wiki frontmatter must be a YAML mapping");
  }
  return {
    hasFrontmatter: true,
    frontmatter: parsed as Record<string, unknown>,
    body: content.slice(match[0].length),
  };
}

export function renderWikiMarkdown(params: {
  frontmatter: Record<string, unknown>;
  body: string;
}): string {
  const frontmatter = YAML.stringify(params.frontmatter).trimEnd();
  return `---\n${frontmatter}\n---\n\n${params.body.trimStart()}`;
}

function extractTitleFromMarkdown(body: string): string | undefined {
  const match = body.match(/^#\s+(.+?)\s*$/m);
  return normalizeOptionalString(match?.[1]);
}

export function normalizeSourceIds(value: unknown): string[] {
  return normalizeSingleOrTrimmedStringList(value);
}

function normalizeWikiClaimEvidence(value: unknown): WikiClaimEvidence | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const kind = normalizeOptionalString(record.kind);
  const sourceId = normalizeOptionalString(record.sourceId);
  const evidencePath = normalizeOptionalString(record.path);
  const lines = normalizeOptionalString(record.lines);
  const note = normalizeOptionalString(record.note);
  const updatedAt = normalizeOptionalString(record.updatedAt);
  const privacyTier = normalizeOptionalString(record.privacyTier);
  const weight =
    typeof record.weight === "number" && Number.isFinite(record.weight) ? record.weight : undefined;
  const confidence = normalizeOptionalNumber(record.confidence);
  if (
    !kind &&
    !sourceId &&
    !evidencePath &&
    !lines &&
    !note &&
    weight === undefined &&
    confidence === undefined &&
    !privacyTier &&
    !updatedAt
  ) {
    return null;
  }
  return {
    ...(kind ? { kind } : {}),
    ...(sourceId ? { sourceId } : {}),
    ...(evidencePath ? { path: evidencePath } : {}),
    ...(lines ? { lines } : {}),
    ...(weight !== undefined ? { weight } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    ...(privacyTier ? { privacyTier } : {}),
    ...(note ? { note } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

export function normalizeWikiClaims(value: unknown): WikiClaim[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }
    const record = entry as Record<string, unknown>;
    const text = normalizeOptionalString(record.text);
    if (!text) {
      return [];
    }
    const evidence = Array.isArray(record.evidence)
      ? record.evidence.flatMap((candidate) => {
          const normalized = normalizeWikiClaimEvidence(candidate);
          return normalized ? [normalized] : [];
        })
      : [];
    const confidence =
      typeof record.confidence === "number" && Number.isFinite(record.confidence)
        ? record.confidence
        : undefined;
    return [
      {
        ...(normalizeOptionalString(record.id) ? { id: normalizeOptionalString(record.id) } : {}),
        text,
        ...(normalizeOptionalString(record.status)
          ? { status: normalizeOptionalString(record.status) }
          : {}),
        ...(confidence !== undefined ? { confidence } : {}),
        evidence,
        ...(normalizeOptionalString(record.updatedAt)
          ? { updatedAt: normalizeOptionalString(record.updatedAt) }
          : {}),
      },
    ];
  });
}

function normalizeOptionalNumber(value: unknown): number | undefined {
  return asFiniteNumber(value);
}

function normalizeWikiPersonCard(value: unknown): WikiPersonCard | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const card: WikiPersonCard = {
    ...(normalizeOptionalString(record.canonicalId)
      ? { canonicalId: normalizeOptionalString(record.canonicalId) }
      : {}),
    handles: normalizeSingleOrTrimmedStringList(record.handles),
    socials: normalizeSingleOrTrimmedStringList(record.socials),
    emails: normalizeSingleOrTrimmedStringList(record.emails ?? record.email),
    ...(normalizeOptionalString(record.timezone)
      ? { timezone: normalizeOptionalString(record.timezone) }
      : {}),
    ...(normalizeOptionalString(record.lane) ? { lane: normalizeOptionalString(record.lane) } : {}),
    askFor: normalizeSingleOrTrimmedStringList(record.askFor),
    avoidAskingFor: normalizeSingleOrTrimmedStringList(record.avoidAskingFor),
    bestUsedFor: normalizeSingleOrTrimmedStringList(record.bestUsedFor),
    notEnoughFor: normalizeSingleOrTrimmedStringList(record.notEnoughFor),
    ...(normalizeOptionalNumber(record.confidence) !== undefined
      ? { confidence: normalizeOptionalNumber(record.confidence) }
      : {}),
    ...(normalizeOptionalString(record.privacyTier)
      ? { privacyTier: normalizeOptionalString(record.privacyTier) }
      : {}),
    ...(normalizeOptionalString(record.lastRefreshedAt)
      ? { lastRefreshedAt: normalizeOptionalString(record.lastRefreshedAt) }
      : {}),
  };
  const hasAnyValue =
    Boolean(
      card.canonicalId || card.timezone || card.lane || card.privacyTier || card.lastRefreshedAt,
    ) ||
    typeof card.confidence === "number" ||
    card.handles.length > 0 ||
    card.socials.length > 0 ||
    card.emails.length > 0 ||
    card.askFor.length > 0 ||
    card.avoidAskingFor.length > 0 ||
    card.bestUsedFor.length > 0 ||
    card.notEnoughFor.length > 0;
  return hasAnyValue ? card : undefined;
}

function normalizeWikiRelationships(value: unknown): WikiRelationship[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }
    const record = entry as Record<string, unknown>;
    const relationship: WikiRelationship = {
      ...(normalizeOptionalString(record.targetId)
        ? { targetId: normalizeOptionalString(record.targetId) }
        : {}),
      ...(normalizeOptionalString(record.targetPath)
        ? { targetPath: normalizeOptionalString(record.targetPath) }
        : {}),
      ...(normalizeOptionalString(record.targetTitle)
        ? { targetTitle: normalizeOptionalString(record.targetTitle) }
        : {}),
      ...(normalizeOptionalString(record.kind)
        ? { kind: normalizeOptionalString(record.kind) }
        : {}),
      ...(normalizeOptionalNumber(record.weight) !== undefined
        ? { weight: normalizeOptionalNumber(record.weight) }
        : {}),
      ...(normalizeOptionalNumber(record.confidence) !== undefined
        ? { confidence: normalizeOptionalNumber(record.confidence) }
        : {}),
      ...(normalizeOptionalString(record.evidenceKind)
        ? { evidenceKind: normalizeOptionalString(record.evidenceKind) }
        : {}),
      ...(normalizeOptionalString(record.privacyTier)
        ? { privacyTier: normalizeOptionalString(record.privacyTier) }
        : {}),
      ...(normalizeOptionalString(record.note)
        ? { note: normalizeOptionalString(record.note) }
        : {}),
      ...(normalizeOptionalString(record.updatedAt)
        ? { updatedAt: normalizeOptionalString(record.updatedAt) }
        : {}),
    };
    const hasAnyValue = Object.keys(relationship).length > 0;
    return hasAnyValue ? [relationship] : [];
  });
}

function normalizeMarkdownLinkTarget(sourceRelativePath: string, target: string): string {
  return path.posix.normalize(path.posix.join(path.posix.dirname(sourceRelativePath), target));
}

type MarkdownAstNode = {
  type?: string;
  position?: {
    start?: { offset?: number };
    end?: { offset?: number };
  };
  children?: MarkdownAstNode[];
};

function maskMarkdownCode(markdown: string): string {
  const masked = markdown.split("");
  const visit = (node: MarkdownAstNode): void => {
    if (node.type === "code" || node.type === "inlineCode") {
      const start = node.position?.start?.offset;
      const end = node.position?.end?.offset;
      if (start !== undefined && end !== undefined) {
        for (let index = start; index < end; index++) {
          if (masked[index] !== "\n" && masked[index] !== "\r") {
            masked[index] = " ";
          }
        }
      }
      return;
    }
    for (const child of node.children ?? []) {
      visit(child);
    }
  };
  visit(fromMarkdown(markdown) as MarkdownAstNode);
  return masked.join("");
}

function extractWikiLinks(markdown: string, sourceRelativePath: string): string[] {
  const withoutRelatedBlock = markdown.replace(RELATED_BLOCK_PATTERN, "");
  const searchable = maskMarkdownCode(withoutRelatedBlock);
  const links: string[] = [];
  for (const match of searchable.matchAll(OBSIDIAN_LINK_PATTERN)) {
    const target = match[1]?.trim();
    if (target) {
      links.push(target);
    }
  }
  for (const match of searchable.matchAll(MARKDOWN_LINK_PATTERN)) {
    const rawTarget = match[1]?.trim();
    if (!rawTarget || rawTarget.startsWith("#") || /^[a-z]+:/i.test(rawTarget)) {
      continue;
    }
    const target = rawTarget.split("#")[0]?.split("?")[0]?.replace(/\\/g, "/").trim();
    if (target) {
      links.push(normalizeMarkdownLinkTarget(sourceRelativePath, target));
    }
  }
  return links;
}

function normalizeMarkdownLines(markdown: string): string[] {
  return markdown
    .replace(/\r\n?/g, "\n")
    .trimStart()
    .split("\n")
    .map((line) => line.trimEnd());
}

function hasGeneratedWrapperLines(lines: string[], patterns: RegExp[]): boolean {
  const firstWrapperLineIndex = lines.findIndex(
    (line) => line.trim().length > 0 && line.trim() !== WIKI_RAW_SOURCE_MARKER,
  );
  if (firstWrapperLineIndex === -1 || !patterns[0]?.test(lines[firstWrapperLineIndex] ?? "")) {
    return false;
  }
  const remainingLines = lines
    .slice(firstWrapperLineIndex + 1)
    .filter((line) => line.trim().length > 0 && line.trim() !== WIKI_RAW_SOURCE_MARKER);
  if (patterns[1] && !patterns[1].test(remainingLines[0] ?? "")) {
    return false;
  }
  let patternIndex = 2;
  for (const line of remainingLines.slice(1)) {
    const pattern = patterns[patternIndex];
    if (!pattern) {
      return true;
    }
    if (pattern.test(line)) {
      patternIndex += 1;
    }
  }
  return patternIndex === patterns.length;
}

function hasHumanNotesBlock(markdown: string): boolean {
  return markdown.includes(HUMAN_START_MARKER) && markdown.includes(HUMAN_END_MARKER);
}

const SOURCE_CONTENT_HEADING = /(?:^|\r?\n)## Content\r?\n/u;

function afterSourceContentFence(page: string): number {
  const heading = SOURCE_CONTENT_HEADING.exec(page);
  if (!heading) {
    return 0;
  }
  const fenceLineStart = heading.index + heading[0].length;
  const fence = /^`+/.exec(page.slice(fenceLineStart))?.[0];
  if (!fence) {
    return fenceLineStart;
  }
  const closingFence = new RegExp(`\\r?\\n${fence}(?=\\r?\\n|$)`, "u");
  const close = closingFence.exec(page.slice(fenceLineStart + fence.length));
  if (!close) {
    return fenceLineStart;
  }
  return fenceLineStart + fence.length + close.index + close[0].length;
}

function findNotesHumanBlock(page: string): { start: number; end: number } | null {
  const searchFrom = afterSourceContentFence(page);
  const start = page.indexOf(HUMAN_START_MARKER, searchFrom);
  if (start === -1) {
    return null;
  }
  const endMarker = page.lastIndexOf(HUMAN_END_MARKER);
  if (endMarker < start) {
    return null;
  }
  return { start, end: endMarker + HUMAN_END_MARKER.length };
}

export function preserveHumanNotesBlock(rendered: string, existing: string): string {
  const existingBlock = findNotesHumanBlock(existing);
  const renderedBlock = findNotesHumanBlock(rendered);
  if (!existingBlock || !renderedBlock) {
    return rendered;
  }
  return (
    rendered.slice(0, renderedBlock.start) +
    existing.slice(existingBlock.start, existingBlock.end) +
    rendered.slice(renderedBlock.end)
  );
}

function detectGeneratedSourceBody(markdown: string): GeneratedSourceBody | undefined {
  const lines = normalizeMarkdownLines(markdown);
  const normalized = lines.join("\n");
  if (
    hasGeneratedWrapperLines(lines, [
      /^# Memory Bridge(?:\s*\(|:)/u,
      /^## Bridge Source\s*$/u,
      /^## Content\s*$/u,
    ]) &&
    hasHumanNotesBlock(normalized)
  ) {
    return "bridge";
  }
  if (
    hasGeneratedWrapperLines(lines, [
      /^# Unsafe Local Import:/u,
      /^## Unsafe Local Source\s*$/u,
      /^## Content\s*$/u,
    ]) &&
    hasHumanNotesBlock(normalized)
  ) {
    return "unsafe-local";
  }
  if (
    hasGeneratedWrapperLines(lines, [
      /^#\s+\S/u,
      /^## Source\s*$/u,
      /^- Type: `local-file`\s*$/u,
      /^## Content\s*$/u,
    ]) &&
    hasHumanNotesBlock(normalized)
  ) {
    return "local-file";
  }
  if (
    hasGeneratedWrapperLines(lines, [
      /^# ChatGPT Export:/u,
      /^## Source\s*$/u,
      /^- Conversation id: `[^`]+`\s*$/u,
      /^## Active Branch Transcript\s*$/u,
    ]) &&
    hasHumanNotesBlock(normalized)
  ) {
    return "chatgpt-export";
  }
  return undefined;
}

function detectUnmanagedRawSourceBody(markdown: string): boolean {
  const trimBlankLines = (value: string): string => value.replace(/^(?:[ \t]*\n)+/u, "");
  const normalized = trimBlankLines(markdown.replace(/\r\n?/g, "\n"));
  const withoutTitle = trimBlankLines(normalized.replace(/^#\s+.+?\s*\n/u, ""));
  return (
    normalized.startsWith(WIKI_RAW_SOURCE_MARKER) || withoutTitle.startsWith(WIKI_RAW_SOURCE_MARKER)
  );
}

function hasWikiSourceFrontmatter(frontmatter: Record<string, unknown>): boolean {
  return (
    normalizeOptionalString(frontmatter.pageType) !== undefined ||
    normalizeOptionalString(frontmatter.sourceType) !== undefined ||
    normalizeOptionalString(frontmatter.provenanceMode) !== undefined
  );
}

export function isUnmanagedRawSourceSummary(page: WikiPageSummary): boolean {
  return (
    page.kind === "source" && page.unmanagedRawSourceBody === true && !page.generatedSourceBody
  );
}

export function formatWikiLink(params: {
  renderMode: "native" | "obsidian";
  relativePath: string;
  sourceRelativeTo?: string;
  title: string;
}): string {
  const withoutExtension = params.relativePath.replace(/\.md$/i, "");
  if (params.renderMode === "obsidian") {
    return `[[${withoutExtension}|${params.title}]]`;
  }
  const linkTarget = params.sourceRelativeTo
    ? path.posix.relative(path.posix.dirname(params.sourceRelativeTo), params.relativePath)
    : params.relativePath;
  return `[${params.title}](${linkTarget})`;
}

export function renderMarkdownFence(content: string, infoString = "text"): string {
  const fenceSize = Math.max(
    3,
    ...Array.from(content.matchAll(/`+/g), (match) => match[0].length + 1),
  );
  const fence = "`".repeat(fenceSize);
  return `${fence}${infoString}\n${content}\n${fence}`;
}

function inferWikiPageKind(relativePath: string): WikiPageKind | null {
  const normalized = relativePath.split(path.sep).join("/");
  if (normalized.startsWith("entities/")) {
    return "entity";
  }
  if (normalized.startsWith("concepts/")) {
    return "concept";
  }
  if (normalized.startsWith("sources/")) {
    return "source";
  }
  if (normalized.startsWith("syntheses/")) {
    return "synthesis";
  }
  if (normalized.startsWith("reports/")) {
    return "report";
  }
  return null;
}

export function scanWikiPageSummary(params: {
  absolutePath: string;
  relativePath: string;
  raw: string;
}): WikiPageSummaryScanResult {
  const kind = inferWikiPageKind(params.relativePath);
  if (!kind) {
    return { status: "ignored" };
  }
  let parsed: ParsedWikiMarkdown;
  try {
    parsed = parseWikiMarkdown(params.raw);
  } catch (error) {
    // Vault scans exclude malformed pages from derived state, while direct parse callers
    // stay strict so write paths cannot replace unparsed metadata with empty fields.
    return {
      status: "invalid-frontmatter",
      error: {
        relativePath: params.relativePath.split(path.sep).join("/"),
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
  const title =
    (typeof parsed.frontmatter.title === "string" && parsed.frontmatter.title.trim()) ||
    extractTitleFromMarkdown(parsed.body) ||
    path.basename(params.relativePath, ".md");
  const generatedSourceBody = detectGeneratedSourceBody(parsed.body);
  const importedSourceBody =
    generatedSourceBody === "bridge" || generatedSourceBody === "unsafe-local"
      ? generatedSourceBody
      : undefined;
  const unmanagedRawSourceBody =
    !generatedSourceBody &&
    !hasWikiSourceFrontmatter(parsed.frontmatter) &&
    detectUnmanagedRawSourceBody(parsed.body);

  return {
    status: "valid",
    page: {
      absolutePath: params.absolutePath,
      relativePath: params.relativePath.split(path.sep).join("/"),
      kind,
      title,
      hasFrontmatter: parsed.hasFrontmatter,
      id: normalizeOptionalString(parsed.frontmatter.id),
      pageType: normalizeOptionalString(parsed.frontmatter.pageType),
      entityType: normalizeOptionalString(parsed.frontmatter.entityType),
      canonicalId: normalizeOptionalString(parsed.frontmatter.canonicalId),
      aliases: normalizeSingleOrTrimmedStringList(parsed.frontmatter.aliases),
      sourceIds: normalizeSourceIds(parsed.frontmatter.sourceIds),
      linkTargets: extractWikiLinks(params.raw, params.relativePath.split(path.sep).join("/")),
      claims: normalizeWikiClaims(parsed.frontmatter.claims),
      contradictions: normalizeSingleOrTrimmedStringList(parsed.frontmatter.contradictions),
      questions: normalizeSingleOrTrimmedStringList(parsed.frontmatter.questions),
      confidence:
        typeof parsed.frontmatter.confidence === "number" &&
        Number.isFinite(parsed.frontmatter.confidence)
          ? parsed.frontmatter.confidence
          : undefined,
      privacyTier: normalizeOptionalString(parsed.frontmatter.privacyTier),
      personCard: normalizeWikiPersonCard(parsed.frontmatter.personCard),
      relationships: normalizeWikiRelationships(parsed.frontmatter.relationships),
      bestUsedFor: normalizeSingleOrTrimmedStringList(parsed.frontmatter.bestUsedFor),
      notEnoughFor: normalizeSingleOrTrimmedStringList(parsed.frontmatter.notEnoughFor),
      sourceType: normalizeOptionalString(parsed.frontmatter.sourceType),
      provenanceMode: normalizeOptionalString(parsed.frontmatter.provenanceMode),
      ...(importedSourceBody ? { importedSourceBody } : {}),
      ...(generatedSourceBody ? { generatedSourceBody } : {}),
      ...(unmanagedRawSourceBody ? { unmanagedRawSourceBody } : {}),
      sourcePath: normalizeOptionalString(parsed.frontmatter.sourcePath),
      bridgeRelativePath: normalizeOptionalString(parsed.frontmatter.bridgeRelativePath),
      bridgeWorkspaceDir: normalizeOptionalString(parsed.frontmatter.bridgeWorkspaceDir),
      bridgeAgentIds: normalizeSingleOrTrimmedStringList(parsed.frontmatter.bridgeAgentIds),
      unsafeLocalConfiguredPath: normalizeOptionalString(
        parsed.frontmatter.unsafeLocalConfiguredPath,
      ),
      unsafeLocalRelativePath: normalizeOptionalString(parsed.frontmatter.unsafeLocalRelativePath),
      lastRefreshedAt: normalizeOptionalString(parsed.frontmatter.lastRefreshedAt),
      updatedAt: normalizeOptionalString(parsed.frontmatter.updatedAt),
    },
  };
}

export function toWikiPageSummary(params: {
  absolutePath: string;
  relativePath: string;
  raw: string;
}): WikiPageSummary | null {
  const result = scanWikiPageSummary(params);
  return result.status === "valid" ? result.page : null;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

import { createHash } from "node:crypto";
import path from "node:path";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  normalizeSingleOrTrimmedStringList,
} from "openclaw/plugin-sdk/text-runtime";
import YAML from "yaml";

export const WIKI_PAGE_KINDS = ["entity", "concept", "source", "synthesis", "report"] as const;
export const WIKI_RELATED_START_MARKER = "<!-- openclaw:wiki:related:start -->";
export const WIKI_RELATED_END_MARKER = "<!-- openclaw:wiki:related:end -->";

export type WikiPageKind = (typeof WIKI_PAGE_KINDS)[number];

export type ParsedWikiMarkdown = {
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

export type WikiPersonCard = {
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

export type WikiPageSummary = {
  absolutePath: string;
  relativePath: string;
  kind: WikiPageKind;
  title: string;
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
  sourcePath?: string;
  bridgeRelativePath?: string;
  bridgeWorkspaceDir?: string;
  unsafeLocalConfiguredPath?: string;
  unsafeLocalRelativePath?: string;
  lastRefreshedAt?: string;
  updatedAt?: string;
};

const FRONTMATTER_PATTERN = /^---\n([\s\S]*?)\n---\n?/;
const OBSIDIAN_LINK_PATTERN = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
const MARKDOWN_LINK_PATTERN = /\[[^\]]+\]\(([^)]+)\)/g;
const RELATED_BLOCK_PATTERN = new RegExp(
  `${WIKI_RELATED_START_MARKER}[\\s\\S]*?${WIKI_RELATED_END_MARKER}`,
  "g",
);
const MAX_WIKI_SEGMENT_BYTES = 240;
const MAX_WIKI_FILENAME_COMPONENT_BYTES = 255;
const WIKI_SEGMENT_HASH_BYTES = 12;

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

export function createWikiPageFilename(stem: string, extension = ".md"): string {
  const normalizedExtension = extension.startsWith(".") ? extension : `.${extension}`;
  const maxStemBytes = Math.max(
    1,
    MAX_WIKI_FILENAME_COMPONENT_BYTES - Buffer.byteLength(normalizedExtension),
  );
  return `${capWikiValueWithHash(stem, maxStemBytes, "page")}${normalizedExtension}`;
}

export function parseWikiMarkdown(content: string): ParsedWikiMarkdown {
  const match = content.match(FRONTMATTER_PATTERN);
  if (!match) {
    return { frontmatter: {}, body: content };
  }
  const parsed = YAML.parse(match[1]) as unknown;
  return {
    frontmatter:
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {},
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

export function extractTitleFromMarkdown(body: string): string | undefined {
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
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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

export function extractWikiLinks(markdown: string): string[] {
  const searchable = markdown.replace(RELATED_BLOCK_PATTERN, "");
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
      links.push(target);
    }
  }
  return links;
}

export function formatWikiLink(params: {
  renderMode: "native" | "obsidian";
  relativePath: string;
  title: string;
}): string {
  const withoutExtension = params.relativePath.replace(/\.md$/i, "");
  return params.renderMode === "obsidian"
    ? `[[${withoutExtension}|${params.title}]]`
    : `[${params.title}](${params.relativePath})`;
}

export function renderMarkdownFence(content: string, infoString = "text"): string {
  const fenceSize = Math.max(
    3,
    ...Array.from(content.matchAll(/`+/g), (match) => match[0].length + 1),
  );
  const fence = "`".repeat(fenceSize);
  return `${fence}${infoString}\n${content}\n${fence}`;
}

export function inferWikiPageKind(relativePath: string): WikiPageKind | null {
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

export function toWikiPageSummary(params: {
  absolutePath: string;
  relativePath: string;
  raw: string;
}): WikiPageSummary | null {
  const kind = inferWikiPageKind(params.relativePath);
  if (!kind) {
    return null;
  }
  const parsed = parseWikiMarkdown(params.raw);
  const title =
    (typeof parsed.frontmatter.title === "string" && parsed.frontmatter.title.trim()) ||
    extractTitleFromMarkdown(parsed.body) ||
    path.basename(params.relativePath, ".md");

  return {
    absolutePath: params.absolutePath,
    relativePath: params.relativePath.split(path.sep).join("/"),
    kind,
    title,
    id: normalizeOptionalString(parsed.frontmatter.id),
    pageType: normalizeOptionalString(parsed.frontmatter.pageType),
    entityType: normalizeOptionalString(parsed.frontmatter.entityType),
    canonicalId: normalizeOptionalString(parsed.frontmatter.canonicalId),
    aliases: normalizeSingleOrTrimmedStringList(parsed.frontmatter.aliases),
    sourceIds: normalizeSourceIds(parsed.frontmatter.sourceIds),
    linkTargets: extractWikiLinks(params.raw),
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
    sourcePath: normalizeOptionalString(parsed.frontmatter.sourcePath),
    bridgeRelativePath: normalizeOptionalString(parsed.frontmatter.bridgeRelativePath),
    bridgeWorkspaceDir: normalizeOptionalString(parsed.frontmatter.bridgeWorkspaceDir),
    unsafeLocalConfiguredPath: normalizeOptionalString(
      parsed.frontmatter.unsafeLocalConfiguredPath,
    ),
    unsafeLocalRelativePath: normalizeOptionalString(parsed.frontmatter.unsafeLocalRelativePath),
    lastRefreshedAt: normalizeOptionalString(parsed.frontmatter.lastRefreshedAt),
    updatedAt: normalizeOptionalString(parsed.frontmatter.updatedAt),
  };
}

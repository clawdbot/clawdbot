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
  sourceId?: string;
  path?: string;
  lines?: string;
  weight?: number;
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

export type WikiPageSummary = {
  absolutePath: string;
  relativePath: string;
  kind: WikiPageKind;
  title: string;
  id?: string;
  pageType?: string;
  sourceIds: string[];
  linkTargets: string[];
  claims: WikiClaim[];
  contradictions: string[];
  questions: string[];
  confidence?: number;
  sourceType?: string;
  provenanceMode?: string;
  sourcePath?: string;
  bridgeRelativePath?: string;
  bridgeWorkspaceDir?: string;
  unsafeLocalConfiguredPath?: string;
  unsafeLocalRelativePath?: string;
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
  const sourceId = normalizeOptionalString(record.sourceId);
  const evidencePath = normalizeOptionalString(record.path);
  const lines = normalizeOptionalString(record.lines);
  const note = normalizeOptionalString(record.note);
  const updatedAt = normalizeOptionalString(record.updatedAt);
  const weight =
    typeof record.weight === "number" && Number.isFinite(record.weight) ? record.weight : undefined;
  if (!sourceId && !evidencePath && !lines && !note && weight === undefined && !updatedAt) {
    return null;
  }
  return {
    ...(sourceId ? { sourceId } : {}),
    ...(evidencePath ? { path: evidencePath } : {}),
    ...(lines ? { lines } : {}),
    ...(weight !== undefined ? { weight } : {}),
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
    sourceType: normalizeOptionalString(parsed.frontmatter.sourceType),
    provenanceMode: normalizeOptionalString(parsed.frontmatter.provenanceMode),
    sourcePath: normalizeOptionalString(parsed.frontmatter.sourcePath),
    bridgeRelativePath: normalizeOptionalString(parsed.frontmatter.bridgeRelativePath),
    bridgeWorkspaceDir: normalizeOptionalString(parsed.frontmatter.bridgeWorkspaceDir),
    unsafeLocalConfiguredPath: normalizeOptionalString(
      parsed.frontmatter.unsafeLocalConfiguredPath,
    ),
    unsafeLocalRelativePath: normalizeOptionalString(parsed.frontmatter.unsafeLocalRelativePath),
    updatedAt: normalizeOptionalString(parsed.frontmatter.updatedAt),
  };
}

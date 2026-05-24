import fs from "node:fs/promises";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sanitizeGoogleAssistantFirstOrdering } from "../../shared/google-turn-ordering.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { truncateUtf16Safe } from "../../utils.js";
import { resolveAgentConfig } from "../agent-scope.js";
import type { WorkspaceBootstrapFile } from "../workspace.js";
import type { EmbeddedContextFile } from "./types.js";

type ContentBlockWithSignature = {
  thought_signature?: unknown;
  thoughtSignature?: unknown;
  [key: string]: unknown;
};

type ThoughtSignatureSanitizeOptions = {
  allowBase64Only?: boolean;
  includeCamelCase?: boolean;
};

function isBase64Signature(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  const compact = trimmed.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/=_-]+$/.test(compact)) {
    return false;
  }
  const isUrl = compact.includes("-") || compact.includes("_");
  try {
    const buf = Buffer.from(compact, isUrl ? "base64url" : "base64");
    if (buf.length === 0) {
      return false;
    }
    const encoded = buf.toString(isUrl ? "base64url" : "base64");
    const normalize = (input: string) => input.replace(/=+$/g, "");
    return normalize(encoded) === normalize(compact);
  } catch {
    return false;
  }
}

/**
 * Strips Claude-style thought_signature fields from content blocks.
 *
 * Gemini expects thought signatures as base64-encoded bytes, but Claude stores message ids
 * like "msg_abc123...". We only strip "msg_*" to preserve any provider-valid signatures.
 */
export function stripThoughtSignatures<T>(
  content: T,
  options?: ThoughtSignatureSanitizeOptions,
): T {
  if (!Array.isArray(content)) {
    return content;
  }
  const allowBase64Only = options?.allowBase64Only ?? false;
  const includeCamelCase = options?.includeCamelCase ?? false;
  const shouldStripSignature = (value: unknown): boolean => {
    if (!allowBase64Only) {
      return typeof value === "string" && value.startsWith("msg_");
    }
    return typeof value !== "string" || !isBase64Signature(value);
  };
  return content.map((block) => {
    if (!block || typeof block !== "object") {
      return block;
    }
    const rec = block as ContentBlockWithSignature;
    const stripSnake = shouldStripSignature(rec.thought_signature);
    const stripCamel = includeCamelCase ? shouldStripSignature(rec.thoughtSignature) : false;
    if (!stripSnake && !stripCamel) {
      return block;
    }
    const next = { ...rec };
    if (stripSnake) {
      delete next.thought_signature;
    }
    if (stripCamel) {
      delete next.thoughtSignature;
    }
    return next;
  }) as T;
}

export const DEFAULT_BOOTSTRAP_MAX_CHARS = 12_000;
export const DEFAULT_BOOTSTRAP_TOTAL_MAX_CHARS = 60_000;
export const DEFAULT_BOOTSTRAP_PROMPT_TRUNCATION_WARNING_MODE = "always";
const MIN_BOOTSTRAP_FILE_BUDGET_CHARS = 64;
// Ratios split `contentBudget` (= maxChars − marker.length − join separators), not `maxChars`.
// The marker and "\n" separators are already reserved before this split runs; these ratios
// only divide what's left between head and tail. Ratios sum to 1.0 — the iteration loop,
// post-loop guard, and final `truncateUtf16Safe` clamp absorb any `Math.floor` residue.
const BOOTSTRAP_HEAD_RATIO = 0.75;
const BOOTSTRAP_TAIL_RATIO = 0.25;
const MIN_BOOTSTRAP_TRIMMED_CONTENT_CHARS = 16;
const AGENTS_BOOTSTRAP_FILENAME = "AGENTS.md";
const AGENTS_POLICY_DIGEST_RATIO = 0.35;
const AGENTS_POLICY_HEAD_RATIO = 0.45;
const AGENTS_POLICY_TAIL_RATIO = 0.15;
const AGENTS_POLICY_DIGEST_MAX_LINE_CHARS = 240;

type TrimBootstrapResult = {
  content: string;
  truncated: boolean;
  maxChars: number;
  originalLength: number;
};

type PolicyDigest = {
  text: string;
  omittedLines: number;
};

export function resolveBootstrapMaxChars(cfg?: OpenClawConfig, agentId?: string | null): number {
  const raw =
    cfg && agentId
      ? (resolveAgentConfig(cfg, agentId)?.bootstrapMaxChars ??
        cfg.agents?.defaults?.bootstrapMaxChars)
      : cfg?.agents?.defaults?.bootstrapMaxChars;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  return DEFAULT_BOOTSTRAP_MAX_CHARS;
}

export function resolveBootstrapTotalMaxChars(
  cfg?: OpenClawConfig,
  agentId?: string | null,
): number {
  const raw =
    cfg && agentId
      ? (resolveAgentConfig(cfg, agentId)?.bootstrapTotalMaxChars ??
        cfg.agents?.defaults?.bootstrapTotalMaxChars)
      : cfg?.agents?.defaults?.bootstrapTotalMaxChars;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  return DEFAULT_BOOTSTRAP_TOTAL_MAX_CHARS;
}

export function resolveBootstrapPromptTruncationWarningMode(
  cfg?: OpenClawConfig,
): "off" | "once" | "always" {
  const raw = cfg?.agents?.defaults?.bootstrapPromptTruncationWarning;
  if (raw === "off" || raw === "once" || raw === "always") {
    return raw;
  }
  return DEFAULT_BOOTSTRAP_PROMPT_TRUNCATION_WARNING_MODE;
}

function isAgentsBootstrapFile(fileName: string | undefined): boolean {
  return fileName?.toLowerCase() === AGENTS_BOOTSTRAP_FILENAME.toLowerCase();
}

function isPolicyDigestCandidate(line: string): boolean {
  if (/^(?:#{1,6}|\s*[-*+]|\s*\d+[.)])\s+\S/u.test(line)) {
    return true;
  }
  return /\b(?:AGENTS\.md|scoped|required|must|never|do not|before subtree|read scoped|owner|security|secret|credential|test|validation|command|commit|push|github|pr)\b/iu.test(
    line,
  );
}

function normalizePolicyDigestLine(line: string): string {
  const normalized = line.trim().replace(/\s+/gu, " ");
  if (normalized.length <= AGENTS_POLICY_DIGEST_MAX_LINE_CHARS) {
    return normalized;
  }
  return `${truncateUtf16Safe(normalized, AGENTS_POLICY_DIGEST_MAX_LINE_CHARS - 1)}…`;
}

function buildAgentsPolicyDigest(content: string, budget: number): PolicyDigest {
  if (budget <= 0) {
    return { text: "", omittedLines: 0 };
  }

  const candidates = content
    .split(/\r?\n/u)
    .map((line, index) => ({ index, line: normalizePolicyDigestLine(line) }))
    .filter(({ line }) => line.length > 0 && isPolicyDigestCandidate(line));
  const highPriorityPattern =
    /\b(?:AGENTS\.md|scoped|required|must|never|do not|before subtree|read scoped|security|secret|credential)\b/iu;
  const selected = new Set<number>();
  let used = 0;
  const trySelect = (candidate: { index: number; line: string }) => {
    const separatorChars = selected.size > 0 ? 1 : 0;
    if (used + separatorChars + candidate.line.length > budget) {
      return;
    }
    selected.add(candidate.index);
    used += separatorChars + candidate.line.length;
  };

  for (const candidate of candidates) {
    if (highPriorityPattern.test(candidate.line)) {
      trySelect(candidate);
    }
  }
  for (const candidate of candidates) {
    if (!selected.has(candidate.index)) {
      trySelect(candidate);
    }
  }

  const lines = candidates
    .filter((candidate) => selected.has(candidate.index))
    .toSorted((a, b) => a.index - b.index)
    .map((candidate) => candidate.line);
  return {
    text: lines.join("\n"),
    omittedLines: Math.max(0, candidates.length - lines.length),
  };
}

function trimAgentsBootstrapContent(content: string, maxChars: number): TrimBootstrapResult {
  const trimmed = content.trimEnd();
  if (trimmed.length <= maxChars) {
    return {
      content: trimmed,
      truncated: false,
      maxChars,
      originalLength: trimmed.length,
    };
  }

  let headChars = Math.floor(maxChars * AGENTS_POLICY_HEAD_RATIO);
  let tailChars = Math.floor(maxChars * AGENTS_POLICY_TAIL_RATIO);
  let digestBudget = Math.floor(maxChars * AGENTS_POLICY_DIGEST_RATIO);
  let digest = buildAgentsPolicyDigest(trimmed, digestBudget);
  const render = () =>
    [
      trimmed.slice(0, headChars),
      `[...truncated, read ${AGENTS_BOOTSTRAP_FILENAME} for full content...]`,
      digest.text ? "[Policy digest from AGENTS.md]" : "",
      digest.text,
      digest.omittedLines > 0 ? `[...${digest.omittedLines} more policy lines omitted...]` : "",
      `…(truncated ${AGENTS_BOOTSTRAP_FILENAME}: kept ${headChars}+policy ${digest.text.length}+${tailChars} chars of ${trimmed.length})…`,
      tailChars > 0 ? trimmed.slice(-tailChars) : "",
    ]
      .filter((part) => part.length > 0)
      .join("\n");

  let rendered = render();
  while (rendered.length > maxChars && (tailChars > 0 || headChars > 1 || digestBudget > 0)) {
    const overflow = rendered.length - maxChars;
    if (tailChars > 0) {
      tailChars = Math.max(0, tailChars - overflow);
    } else if (headChars > 1) {
      headChars = Math.max(1, headChars - overflow);
    } else {
      digestBudget = Math.max(0, digestBudget - overflow);
      digest = buildAgentsPolicyDigest(trimmed, digestBudget);
    }
    rendered = render();
  }

  return {
    content: rendered.length > maxChars ? truncateUtf16Safe(rendered, maxChars) : rendered,
    truncated: true,
    maxChars,
    originalLength: trimmed.length,
  };
}

function trimBootstrapContent(
  content: string,
  fileName: string,
  maxChars: number,
): TrimBootstrapResult {
  const trimmed = content.trimEnd();
  if (trimmed.length <= maxChars) {
    return {
      content: trimmed,
      truncated: false,
      maxChars,
      originalLength: trimmed.length,
    };
  }
  if (isAgentsBootstrapFile(fileName)) {
    return trimAgentsBootstrapContent(content, maxChars);
  }

  const markerTemplate = (headChars: number, tailChars: number) =>
    [
      "",
      `[...truncated, read ${fileName} for full content...]`,
      `…(truncated ${fileName}: kept ${headChars}+${tailChars} chars of ${trimmed.length})…`,
      "",
    ].join("\n");
  const compactMarkerTemplate = (headChars: number, tailChars: number) =>
    `[…truncated ${headChars}+${tailChars}/${trimmed.length}]`;
  const separatorCharsFor = (headCount: number, tailCount: number, markerContent: string) =>
    markerContent.includes("\n") ? Number(headCount > 0) + Number(tailCount > 0) : 0;
  const renderTruncatedContent = (head: string, markerContent: string, tail: string) =>
    [head, markerContent, tail]
      .filter((part) => part.length > 0)
      .join(markerContent.includes("\n") ? "\n" : "");
  const resolveMarkerTemplate = () => {
    const fullMarker = markerTemplate(0, 0);
    const fullContentBudget = maxChars - fullMarker.length - separatorCharsFor(1, 1, fullMarker);
    return fullContentBudget >= MIN_BOOTSTRAP_TRIMMED_CONTENT_CHARS
      ? markerTemplate
      : compactMarkerTemplate;
  };
  const resolvedMarkerTemplate = resolveMarkerTemplate();
  let headChars = 0;
  let tailChars = 0;
  let marker = resolvedMarkerTemplate(headChars, tailChars);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const contentBudget = Math.max(
      0,
      maxChars - marker.length - separatorCharsFor(headChars, tailChars, marker),
    );
    const nextHeadChars = Math.floor(contentBudget * BOOTSTRAP_HEAD_RATIO);
    const nextTailChars = Math.floor(contentBudget * BOOTSTRAP_TAIL_RATIO);
    const nextMarker = resolvedMarkerTemplate(nextHeadChars, nextTailChars);
    if (
      nextHeadChars === headChars &&
      nextTailChars === tailChars &&
      nextMarker.length === marker.length
    ) {
      break;
    }
    headChars = nextHeadChars;
    tailChars = nextTailChars;
    marker = nextMarker;
  }
  let renderedLength =
    headChars + tailChars + marker.length + separatorCharsFor(headChars, tailChars, marker);
  while (renderedLength > maxChars && (tailChars > 0 || headChars > 0)) {
    const overflow = renderedLength - maxChars;
    if (tailChars > 0) {
      tailChars = Math.max(0, tailChars - overflow);
    } else {
      headChars = Math.max(0, headChars - overflow);
    }
    marker = resolvedMarkerTemplate(headChars, tailChars);
    renderedLength =
      headChars + tailChars + marker.length + separatorCharsFor(headChars, tailChars, marker);
  }
  if (headChars === 0 && tailChars === 0 && trimmed.length > 0) {
    const singleHeadMarker = resolvedMarkerTemplate(1, 0);
    const singleHeadLength =
      1 + singleHeadMarker.length + separatorCharsFor(1, 0, singleHeadMarker);
    if (singleHeadLength <= maxChars) {
      headChars = 1;
      marker = singleHeadMarker;
    }
  }
  const head = trimmed.slice(0, headChars);
  const tail = tailChars > 0 ? trimmed.slice(-tailChars) : "";

  const contentWithMarker = renderTruncatedContent(head, marker, tail);
  const boundedContent =
    contentWithMarker.length > maxChars
      ? truncateUtf16Safe(contentWithMarker, maxChars)
      : contentWithMarker;
  return {
    content: boundedContent,
    truncated: true,
    maxChars,
    originalLength: trimmed.length,
  };
}

function clampToBudget(content: string, budget: number): string {
  if (budget <= 0) {
    return "";
  }
  if (content.length <= budget) {
    return content;
  }
  if (budget <= 3) {
    return truncateUtf16Safe(content, budget);
  }
  const safe = budget - 1;
  return `${truncateUtf16Safe(content, safe)}…`;
}

export async function ensureSessionHeader(params: {
  sessionFile: string;
  sessionId: string;
  cwd: string;
}) {
  const file = params.sessionFile;
  try {
    await fs.stat(file);
    return;
  } catch {
    // create
  }
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const sessionVersion = 2;
  const entry = {
    type: "session",
    version: sessionVersion,
    id: params.sessionId,
    timestamp: new Date().toISOString(),
    cwd: params.cwd,
  };
  await fs.writeFile(file, `${JSON.stringify(entry)}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
}

export function buildBootstrapContextFiles(
  files: WorkspaceBootstrapFile[],
  opts?: { warn?: (message: string) => void; maxChars?: number; totalMaxChars?: number },
): EmbeddedContextFile[] {
  const maxChars = opts?.maxChars ?? DEFAULT_BOOTSTRAP_MAX_CHARS;
  const totalMaxChars = Math.max(
    1,
    Math.floor(opts?.totalMaxChars ?? Math.max(maxChars, DEFAULT_BOOTSTRAP_TOTAL_MAX_CHARS)),
  );
  let remainingTotalChars = totalMaxChars;
  const result: EmbeddedContextFile[] = [];
  for (const file of files) {
    if (remainingTotalChars <= 0) {
      break;
    }
    const pathValue = normalizeOptionalString(file.path) ?? "";
    if (!pathValue) {
      opts?.warn?.(
        `skipping bootstrap file "${file.name}" — missing or invalid "path" field (hook may have used "filePath" instead)`,
      );
      continue;
    }
    if (file.missing) {
      const missingText = `[MISSING] Expected at: ${pathValue}`;
      const cappedMissingText = clampToBudget(missingText, remainingTotalChars);
      if (!cappedMissingText) {
        break;
      }
      remainingTotalChars = Math.max(0, remainingTotalChars - cappedMissingText.length);
      result.push({
        path: pathValue,
        content: cappedMissingText,
      });
      continue;
    }
    if (remainingTotalChars < MIN_BOOTSTRAP_FILE_BUDGET_CHARS) {
      opts?.warn?.(
        `remaining bootstrap budget is ${remainingTotalChars} chars (<${MIN_BOOTSTRAP_FILE_BUDGET_CHARS}); skipping additional bootstrap files`,
      );
      break;
    }
    const fileMaxChars = Math.max(1, Math.min(maxChars, remainingTotalChars));
    const trimmed = trimBootstrapContent(file.content ?? "", file.name, fileMaxChars);
    const contentWithinBudget = clampToBudget(trimmed.content, remainingTotalChars);
    if (!contentWithinBudget) {
      continue;
    }
    if (trimmed.truncated || contentWithinBudget.length < trimmed.content.length) {
      opts?.warn?.(
        `workspace bootstrap file ${file.name} is ${trimmed.originalLength} chars (limit ${trimmed.maxChars}); truncating in injected context`,
      );
    }
    remainingTotalChars = Math.max(0, remainingTotalChars - contentWithinBudget.length);
    result.push({
      path: pathValue,
      content: contentWithinBudget,
    });
  }
  return result;
}

export function sanitizeGoogleTurnOrdering(messages: AgentMessage[]): AgentMessage[] {
  return sanitizeGoogleAssistantFirstOrdering(messages);
}

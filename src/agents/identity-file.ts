import fs from "node:fs";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { DEFAULT_IDENTITY_FILENAME } from "./workspace.js";

export type AgentIdentityFile = {
  name?: string;
  emoji?: string;
  theme?: string;
  creature?: string;
  vibe?: string;
  avatar?: string;
};

const WRITABLE_IDENTITY_FIELDS = [
  ["name", "Name"],
  ["theme", "Theme"],
  ["emoji", "Emoji"],
  ["avatar", "Avatar"],
] as const satisfies ReadonlyArray<readonly [keyof AgentIdentityFile, string]>;

const RICH_IDENTITY_LABELS = new Set(["name", "creature", "vibe", "theme", "emoji", "avatar"]);

const IDENTITY_PLACEHOLDER_VALUES = new Set([
  "pick something you like",
  "ai? robot? familiar? ghost in the machine? something weirder?",
  "how do you come across? sharp? warm? chaotic? calm?",
  "your signature - pick one that feels right",
  "workspace-relative path, http(s) url, or data uri",
]);

function normalizeIdentityValue(value: string): string {
  let normalized = value.trim();
  normalized = normalized.replace(/^[*_]+|[*_]+$/g, "").trim();
  if (normalized.startsWith("(") && normalized.endsWith(")")) {
    normalized = normalized.slice(1, -1).trim();
  }
  normalized = normalized.replace(/[\u2013\u2014]/g, "-");
  return normalizeLowercaseStringOrEmpty(normalized.replace(/\s+/g, " "));
}

function isIdentityPlaceholder(value: string): boolean {
  const normalized = normalizeIdentityValue(value);
  return IDENTITY_PLACEHOLDER_VALUES.has(normalized);
}

export function parseIdentityMarkdown(content: string): AgentIdentityFile {
  const identity: AgentIdentityFile = {};
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const cleaned = line.trim().replace(/^\s*-\s*/, "");
    const colonIndex = cleaned.indexOf(":");
    if (colonIndex === -1) {
      continue;
    }
    const label = normalizeLowercaseStringOrEmpty(
      cleaned.slice(0, colonIndex).replace(/[*_]/g, ""),
    );
    const value = cleaned
      .slice(colonIndex + 1)
      .replace(/^[*_]+|[*_]+$/g, "")
      .trim();
    if (!value) {
      continue;
    }
    if (isIdentityPlaceholder(value)) {
      continue;
    }
    if (label === "name") {
      identity.name = value;
    }
    if (label === "emoji") {
      identity.emoji = value;
    }
    if (label === "creature") {
      identity.creature = value;
    }
    if (label === "vibe") {
      identity.vibe = value;
    }
    if (label === "theme") {
      identity.theme = value;
    }
    if (label === "avatar") {
      identity.avatar = value;
    }
  }
  return identity;
}

export function identityHasValues(identity: AgentIdentityFile): boolean {
  return Boolean(
    identity.name ||
    identity.emoji ||
    identity.theme ||
    identity.creature ||
    identity.vibe ||
    identity.avatar,
  );
}

function buildIdentityLine(label: string, value: string): string {
  return `- ${label}: ${value}`;
}

function matchesIdentityLabel(line: string, label: string): boolean {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*-\\s*(?:\\*\\*)?${escaped}(?:\\*\\*)?\\s*:`, "i").test(line.trim());
}

function normalizeIdentityContent(content: string | undefined): string[] {
  if (!content) {
    return [];
  }
  return content.replace(/\r\n/g, "\n").split("\n");
}

function resolveIdentityInsertIndex(lines: string[]): number {
  let lastIdentityIndex = -1;
  for (const [index, line] of lines.entries()) {
    const cleaned = line.trim().replace(/^\s*-\s*/, "");
    const colonIndex = cleaned.indexOf(":");
    if (colonIndex === -1) {
      continue;
    }
    const label = normalizeLowercaseStringOrEmpty(
      cleaned.slice(0, colonIndex).replace(/[*_]/g, ""),
    );
    if (RICH_IDENTITY_LABELS.has(label)) {
      lastIdentityIndex = index;
    }
  }
  if (lastIdentityIndex >= 0) {
    return lastIdentityIndex + 1;
  }

  const headingIndex = lines.findIndex((line) => line.trim().startsWith("#"));
  if (headingIndex === -1) {
    return 0;
  }
  let insertIndex = headingIndex + 1;
  while (insertIndex < lines.length && lines[insertIndex]?.trim() === "") {
    insertIndex += 1;
  }
  return insertIndex;
}

export function mergeIdentityMarkdownContent(
  content: string | undefined,
  identity: Pick<AgentIdentityFile, "name" | "theme" | "emoji" | "avatar">,
): string {
  const lines = normalizeIdentityContent(content);
  const nextLines = lines.length > 0 ? [...lines] : ["# IDENTITY.md - Agent Identity", ""];

  for (const [field, label] of WRITABLE_IDENTITY_FIELDS) {
    const value = identity[field]?.trim();
    if (!value) {
      continue;
    }

    const matchingIndexes = nextLines.reduce<number[]>((indexes, line, index) => {
      if (matchesIdentityLabel(line, label)) {
        indexes.push(index);
      }
      return indexes;
    }, []);

    if (matchingIndexes.length > 0) {
      const [firstIndex, ...duplicateIndexes] = matchingIndexes;
      nextLines[firstIndex] = buildIdentityLine(label, value);
      for (const duplicateIndex of duplicateIndexes.toReversed()) {
        nextLines.splice(duplicateIndex, 1);
      }
      continue;
    }

    const insertIndex = resolveIdentityInsertIndex(nextLines);
    nextLines.splice(insertIndex, 0, buildIdentityLine(label, value));
  }

  return nextLines.join("\n").replace(/\n*$/, "\n");
}

function loadIdentityFromFile(identityPath: string): AgentIdentityFile | null {
  try {
    const content = fs.readFileSync(identityPath, "utf-8");
    const parsed = parseIdentityMarkdown(content);
    if (!identityHasValues(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function loadAgentIdentityFromWorkspace(workspace: string): AgentIdentityFile | null {
  const identityPath = path.join(workspace, DEFAULT_IDENTITY_FILENAME);
  return loadIdentityFromFile(identityPath);
}

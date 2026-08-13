import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { invalidInlineImageText, sanitizeInlineImageDataUrl } from "./image-payload-sanitizer.js";
import type { CodexUserInput } from "./protocol.js";

const MAX_CODEX_SKILL_MENTION_BOUNDARIES = 64;
const CODEX_IGNORED_TOOL_MENTION_NAMES = new Set([
  "HOME",
  "LANG",
  "PATH",
  "PWD",
  "SHELL",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
  "XDG_CONFIG_HOME",
]);

function isLinkedNonSkillMention(text: string, index: number, matchLength: number): boolean {
  if (text[index - 1] !== "[" || text[index + matchLength] !== "]") {
    return false;
  }
  let cursor = index + matchLength + 1;
  while (/\s/u.test(text[cursor] ?? "")) {
    cursor += 1;
  }
  if (text[cursor] !== "(") {
    return false;
  }
  const end = text.indexOf(")", cursor + 1);
  if (end < 0) {
    return false;
  }
  const target = text.slice(cursor + 1, end).trim();
  return /^(?:app|mcp|plugin):\/\//u.test(target);
}

/** Splits mention-shaped text without changing the concatenated user-visible message. */
export function splitCodexTextSkillMentions(
  text: string,
  suppressedSkillNames: readonly string[] = [],
): string[] {
  const selectedNames = new Set(suppressedSkillNames.map((name) => name.toLowerCase()));
  if (selectedNames.size === 0) {
    return [text];
  }
  const chunks: string[] = [];
  let cursor = 0;
  let boundaries = 0;
  for (const match of text.matchAll(/\$[A-Za-z0-9_:-]+/gu)) {
    const index = match.index;
    if (index === undefined) {
      continue;
    }
    if (isLinkedNonSkillMention(text, index, match[0].length)) {
      continue;
    }
    if (CODEX_IGNORED_TOOL_MENTION_NAMES.has(match[0].slice(1).toUpperCase())) {
      continue;
    }
    if (!selectedNames.has(match[0].slice(1).toLowerCase())) {
      continue;
    }
    boundaries += 1;
    if (boundaries > MAX_CODEX_SKILL_MENTION_BOUNDARIES) {
      throw new Error(
        `Codex input contains more than ${MAX_CODEX_SKILL_MENTION_BOUNDARIES} skill-shaped references`,
      );
    }
    const splitAt = index + 1;
    chunks.push(text.slice(cursor, splitAt));
    cursor = splitAt;
  }
  if (chunks.length === 0) {
    return [text];
  }
  chunks.push(text.slice(cursor));
  return chunks.filter((chunk) => chunk.length > 0);
}

/** Builds ordered Codex user input for both new turns and same-turn steering. */
export function buildCodexUserInput(
  text: string | undefined,
  images?: EmbeddedRunAttemptParams["images"],
  explicitSkillSelections?: EmbeddedRunAttemptParams["explicitSkillSelections"],
  suppressTextSkillMentions = true,
  suppressedSkillNames: readonly string[] = [],
): CodexUserInput[] {
  const imageInputs = (images ?? []).map((image): CodexUserInput => {
    const imageUrl = sanitizeInlineImageDataUrl(`data:${image.mimeType};base64,${image.data}`);
    return imageUrl
      ? { type: "image", url: imageUrl }
      : {
          type: "text",
          text: invalidInlineImageText("codex user input"),
          text_elements: [],
        };
  });
  const textInput: CodexUserInput[] =
    text === undefined
      ? []
      : (suppressTextSkillMentions
          ? splitCodexTextSkillMentions(text, suppressedSkillNames)
          : [text]
        ).map((chunk) => ({
          type: "text",
          text: chunk,
          text_elements: [],
        }));
  const skillInputs: CodexUserInput[] = (explicitSkillSelections ?? []).map((skill) => ({
    type: "skill",
    name: skill.name,
    path: skill.path,
  }));
  return [...textInput, ...skillInputs, ...imageInputs];
}

// Chat command invocation helpers execute skill-provided chat command handlers.
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "@openclaw/normalization-core/string-coerce";
import { getChatCommands } from "../../auto-reply/commands-registry.data.js";
import type { SkillCommandSpec } from "../types.js";

const MAX_EXPLICIT_SKILL_REFERENCES = 8;
const MAX_EXPLICIT_SKILL_REFERENCE_CHARS = 512;
const MAX_EXPLICIT_SKILL_INSTRUCTION_CHARS = 1_000;

/** Lists slash command names reserved by built-in chat commands and callers. */
export function listReservedChatSlashCommandNames(extraNames: string[] = []): Set<string> {
  const reserved = new Set<string>();
  for (const command of getChatCommands()) {
    if (command.nativeName) {
      reserved.add(normalizeOptionalLowercaseString(command.nativeName) ?? "");
    }
    for (const alias of command.textAliases) {
      const trimmed = alias.trim();
      if (!trimmed.startsWith("/")) {
        continue;
      }
      reserved.add(normalizeLowercaseStringOrEmpty(trimmed.slice(1)));
    }
  }
  for (const name of extraNames) {
    const trimmed = normalizeOptionalLowercaseString(name);
    if (trimmed) {
      reserved.add(trimmed);
    }
  }
  return reserved;
}

// Skill commands allow spaces/underscores in names but compare through dash-normalized lookup.
function normalizeSkillCommandLookup(value: string): string {
  return (normalizeOptionalLowercaseString(value) ?? "").replace(/[\s_]+/g, "-");
}

function findSkillCommand(
  skillCommands: SkillCommandSpec[],
  rawName: string,
): SkillCommandSpec | undefined {
  const trimmed = rawName.trim();
  if (!trimmed) {
    return undefined;
  }
  const lowered = normalizeOptionalLowercaseString(trimmed) ?? "";
  const normalized = normalizeSkillCommandLookup(trimmed);
  return skillCommands.find((entry) => {
    if (normalizeOptionalLowercaseString(entry.name) === lowered) {
      return true;
    }
    if (normalizeOptionalLowercaseString(entry.skillName) === lowered) {
      return true;
    }
    return (
      normalizeSkillCommandLookup(entry.name) === normalized ||
      normalizeSkillCommandLookup(entry.skillName) === normalized
    );
  });
}

function skillReferenceMatches(text: string): IterableIterator<RegExpMatchArray> {
  return text.matchAll(/\$([-a-zA-Z0-9_:]+)/gu);
}

function isEscapedReference(text: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function isShellVariableReference(name: string): boolean {
  return !/[a-z]/u.test(name);
}

function* skillReferenceNames(text: string): IterableIterator<string> {
  for (const match of skillReferenceMatches(text)) {
    const name = match[1]?.replace(/:+$/gu, "");
    const index = match.index;
    if (
      name &&
      index !== undefined &&
      !isEscapedReference(text, index) &&
      !isShellVariableReference(name)
    ) {
      yield name;
    }
  }
}

/** Returns true when text may contain an explicit `$skill-name` reference. */
export function hasSkillReferenceCandidate(text: string): boolean {
  return !skillReferenceNames(text).next().done;
}

/** Resolves explicit `$skill-name` references against the current eligible skill commands. */
function resolveSkillReferenceInvocations(params: {
  text: string;
  skillCommands: SkillCommandSpec[];
}): SkillCommandSpec[] {
  const resolved: SkillCommandSpec[] = [];
  const seen = new Set<string>();
  for (const name of skillReferenceNames(params.text)) {
    const command = findSkillCommand(params.skillCommands, name);
    if (!command || command.promptTemplate || seen.has(command.name)) {
      continue;
    }
    seen.add(command.name);
    resolved.push(command);
  }
  return resolved;
}

export function resolveSkillCommandInvocation(params: {
  commandBodyNormalized: string;
  skillCommands: SkillCommandSpec[];
}): { command: SkillCommandSpec; args?: string; inline?: boolean } | null {
  const trimmed = params.commandBodyNormalized.trim();
  if (trimmed.startsWith("/")) {
    const match = trimmed.match(/^\/([^\s]+)(?:\s+([\s\S]+))?$/);
    if (!match) {
      return null;
    }
    const commandName = normalizeOptionalLowercaseString(match[1]);
    if (!commandName) {
      return null;
    }
    if (commandName === "skill") {
      const remainder = match[2]?.trim();
      if (!remainder) {
        return null;
      }
      const skillMatch = remainder.match(/^([^\s]+)(?:\s+([\s\S]+))?$/);
      if (!skillMatch) {
        return null;
      }
      const skillCommand = findSkillCommand(params.skillCommands, skillMatch[1] ?? "");
      if (!skillCommand) {
        return null;
      }
      const args = skillMatch[2]?.trim();
      return { command: skillCommand, args: args || undefined };
    }
    const command = params.skillCommands.find(
      (entry) => normalizeOptionalLowercaseString(entry.name) === commandName,
    );
    if (command) {
      const args = match[2]?.trim();
      return { command, args: args || undefined };
    }
  }
  return null;
}

export function expandBundleCommandPromptTemplate(template: string, args?: string): string {
  const normalizedArgs = args?.trim() ?? "";
  const rendered = template.includes("$ARGUMENTS")
    ? template.replaceAll("$ARGUMENTS", () => normalizedArgs)
    : template;
  if (!normalizedArgs || template.includes("$ARGUMENTS")) {
    return rendered.trim();
  }
  return `${rendered.trim()}\n\nUser input:\n${normalizedArgs}`;
}

function resolveExplicitSkillCommands(text: string, skillCommands: SkillCommandSpec[]) {
  if (!text.trimStart().startsWith("/")) {
    return resolveSkillReferenceInvocations({ text, skillCommands });
  }
  const invocation = resolveSkillCommandInvocation({
    commandBodyNormalized: text,
    skillCommands,
  });
  return invocation ? [invocation.command] : [];
}

function resolveUnavailableExplicitSkillCommand(params: {
  text: string;
  skillCommands: SkillCommandSpec[];
  allSkillCommands: SkillCommandSpec[];
}): SkillCommandSpec | undefined {
  if (params.text.trimStart().startsWith("/")) {
    if (resolveExplicitSkillCommands(params.text, params.skillCommands).length > 0) {
      return undefined;
    }
    return resolveExplicitSkillCommands(params.text, params.allSkillCommands)[0];
  }
  for (const name of skillReferenceNames(params.text)) {
    if (findSkillCommand(params.skillCommands, name)) {
      continue;
    }
    const unavailable = findSkillCommand(params.allSkillCommands, name);
    if (unavailable) {
      return unavailable;
    }
  }
  return undefined;
}

/** Expands model-routed skill references while leaving unknown slash commands untouched. */
export function expandExplicitSkillReferences(params: {
  text: string;
  skillCommands: SkillCommandSpec[];
  allSkillCommands?: SkillCommandSpec[];
}): { body: string; error?: string; skills: SkillCommandSpec[] } {
  const leadingInvocation = params.text.trimStart().startsWith("/")
    ? resolveSkillCommandInvocation({
        commandBodyNormalized: params.text,
        skillCommands: params.skillCommands,
      })
    : null;
  if (leadingInvocation?.command.promptTemplate) {
    return {
      body: expandBundleCommandPromptTemplate(
        leadingInvocation.command.promptTemplate,
        leadingInvocation.args,
      ),
      skills: [leadingInvocation.command],
    };
  }
  const available = resolveExplicitSkillCommands(params.text, params.skillCommands);
  const allCommands = params.allSkillCommands ?? params.skillCommands;
  const unavailable =
    allCommands === params.skillCommands
      ? undefined
      : resolveUnavailableExplicitSkillCommand({
          text: params.text,
          skillCommands: params.skillCommands,
          allSkillCommands: allCommands,
        });
  const error = unavailable
    ? `Skill "${unavailable.skillName}" is not available for this agent. Update the skill allowlist or choose an allowed skill.`
    : available.length > MAX_EXPLICIT_SKILL_REFERENCES
      ? `Too many skill references. Use at most ${MAX_EXPLICIT_SKILL_REFERENCES} skills in one message.`
      : undefined;
  return expandResolvedSkillReferences({ text: params.text, skills: available, error });
}

function expandResolvedSkillReferences(params: {
  text: string;
  skills: SkillCommandSpec[];
  error?: string;
}): { body: string; error?: string; skills: SkillCommandSpec[] } {
  const error =
    params.error ??
    (params.skills.length > MAX_EXPLICIT_SKILL_REFERENCES
      ? `Too many skill references. Use at most ${MAX_EXPLICIT_SKILL_REFERENCES} skills in one message.`
      : undefined);
  if (error) {
    return { body: params.text, error, skills: [] };
  }
  if (params.skills.length === 0) {
    return { body: params.text, skills: [] };
  }
  const referenceLines = params.skills.map((skill) =>
    skill.modelVisible === false && skill.skillFile
      ? `- ${skill.skillName} (SKILL.md: ${skill.skillFile})`
      : `- ${skill.skillName}`,
  );
  // The reference-count cap alone does not bound operator-provided names or paths.
  // Keep both each item and the complete injected prefix within fixed prompt budgets.
  if (referenceLines.some((line) => line.length > MAX_EXPLICIT_SKILL_REFERENCE_CHARS)) {
    return {
      body: params.text,
      error: `Skill reference metadata is too long. Keep each rendered reference at ${MAX_EXPLICIT_SKILL_REFERENCE_CHARS} characters or less.`,
      skills: [],
    };
  }
  const instructionPrefix = [
    "Use the following explicitly referenced skills for this request. Read each skill's SKILL.md before acting:",
    ...referenceLines,
    "",
    "User request:",
    "",
  ].join("\n");
  if (instructionPrefix.length > MAX_EXPLICIT_SKILL_INSTRUCTION_CHARS) {
    return {
      body: params.text,
      error:
        "Combined skill reference metadata is too long. Use fewer or shorter skill references.",
      skills: [],
    };
  }
  return {
    body: `${instructionPrefix}${params.text}`,
    skills: params.skills,
  };
}

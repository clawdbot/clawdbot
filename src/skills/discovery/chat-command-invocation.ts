// Chat command invocation helpers execute skill-provided chat command handlers.
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "@openclaw/normalization-core/string-coerce";
import { getChatCommands } from "../../auto-reply/commands-registry.data.js";
import type { SkillCommandSpec } from "../types.js";

const MAX_EXPLICIT_SKILL_REFERENCES = 8;

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

/** Returns true when text may contain an explicit `$skill-name` reference. */
export function hasSkillReferenceCandidate(text: string): boolean {
  for (const match of skillReferenceMatches(text)) {
    const name = match[1]?.replace(/:+$/gu, "");
    const index = match.index;
    if (
      name &&
      index !== undefined &&
      !isEscapedReference(text, index) &&
      !isShellVariableReference(name)
    ) {
      return true;
    }
  }
  return false;
}

/** Resolves explicit `$skill-name` references against the current eligible skill commands. */
function resolveSkillReferenceInvocations(params: {
  text: string;
  skillCommands: SkillCommandSpec[];
}): SkillCommandSpec[] {
  const resolved: SkillCommandSpec[] = [];
  const seen = new Set<string>();
  for (const match of skillReferenceMatches(params.text)) {
    const name = match[1]?.replace(/:+$/gu, "");
    const index = match.index;
    if (
      !name ||
      index === undefined ||
      isEscapedReference(params.text, index) ||
      isShellVariableReference(name)
    ) {
      continue;
    }
    const command = findSkillCommand(params.skillCommands, name);
    if (!command || seen.has(command.name)) {
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
}): { command: SkillCommandSpec; args?: string } | null {
  const trimmed = params.commandBodyNormalized.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }
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
  if (!command) {
    return null;
  }
  const args = match[2]?.trim();
  return { command, args: args || undefined };
}

function skillCommandIdentity(command: SkillCommandSpec): string {
  return normalizeSkillCommandLookup(command.skillName);
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

/** Expands model-routed skill references while leaving unknown slash commands untouched. */
export function expandExplicitSkillReferences(params: {
  text: string;
  skillCommands: SkillCommandSpec[];
  allSkillCommands?: SkillCommandSpec[];
}): { body: string; error?: string; skills: SkillCommandSpec[] } {
  const available = resolveExplicitSkillCommands(params.text, params.skillCommands);
  const allCommands = params.allSkillCommands ?? params.skillCommands;
  const allResolved =
    allCommands === params.skillCommands
      ? available
      : resolveExplicitSkillCommands(params.text, allCommands);

  const availableIdentities = new Set(available.map(skillCommandIdentity));
  const unavailable = allResolved.find(
    (command) => !availableIdentities.has(skillCommandIdentity(command)),
  );
  const error = unavailable
    ? `Skill "${unavailable.skillName}" is not available for this agent. Update the skill allowlist or choose an allowed skill.`
    : available.length > MAX_EXPLICIT_SKILL_REFERENCES
      ? `Too many skill references. Use at most ${MAX_EXPLICIT_SKILL_REFERENCES} skills in one message.`
      : undefined;
  if (error) {
    return { body: params.text, error, skills: [] };
  }
  if (available.length === 0) {
    return { body: params.text, skills: [] };
  }
  return {
    body: [
      "Use the following explicitly referenced skills for this request. Read each skill's SKILL.md before acting:",
      // Hidden skills are absent from the available-skills prompt, so explicit invocation
      // carries the SKILL.md path the model needs to load them.
      ...available.map((skill) =>
        skill.modelVisible === false && skill.skillFile
          ? `- ${skill.skillName} (SKILL.md: ${skill.skillFile})`
          : `- ${skill.skillName}`,
      ),
      "",
      "User request:",
      params.text,
    ].join("\n"),
    skills: available,
  };
}

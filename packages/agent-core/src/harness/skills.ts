// Agent Core module implements skills behavior.
import ignore from "ignore";
import {
  basenameEnvPath,
  dirnameEnvPath,
  joinEnvPath,
  parseFrontmatter,
  relativeEnvPath,
  resolveFileInfoKind as resolveKind,
} from "./file-loader-utils.js";
import type { ExecutionEnv, Result, Skill } from "./types.js";

const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];

type IgnoreMatcher = ReturnType<typeof ignore>;

export type SkillDiagnosticCode =
  | "file_info_failed"
  | "list_failed"
  | "read_failed"
  | "parse_failed"
  | "invalid_metadata";

/** Warning produced while loading skills. */
export interface SkillDiagnostic {
  /** Diagnostic severity. Currently only warnings are emitted. */
  type: "warning";
  /** Stable diagnostic code. */
  code: SkillDiagnosticCode;
  /** Human-readable diagnostic message. */
  message: string;
  /** Path associated with the diagnostic. */
  path: string;
}

interface SkillFrontmatter {
  name?: string;
  description?: string;
  "disable-model-invocation"?: boolean;
  [key: string]: unknown;
}

/** Format a skill invocation prompt, optionally appending additional user instructions. */
export function formatSkillInvocation(skill: Skill, additionalInstructions?: string): string {
  const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${dirnameEnvPath(skill.filePath)}.\n\n${skill.content}\n</skill>`;
  return additionalInstructions ? `${skillBlock}\n\n${additionalInstructions}` : skillBlock;
}

/**
 * Load skills from one or more directories.
 *
 * Traverses directories recursively, loads `SKILL.md` files, loads direct root `.md` files as skills, honors ignore files,
 * and returns diagnostics for invalid skill files. Missing input directories are skipped.
 */
export async function loadSkills(
  env: ExecutionEnv,
  dirs: string | string[],
): Promise<{ skills: Skill[]; diagnostics: SkillDiagnostic[] }> {
  const skills: Skill[] = [];
  const diagnostics: SkillDiagnostic[] = [];
  for (const dir of Array.isArray(dirs) ? dirs : [dirs]) {
    const rootInfoResult = await env.fileInfo(dir);
    if (!rootInfoResult.ok) {
      if (rootInfoResult.error.code !== "not_found") {
        diagnostics.push({
          type: "warning",
          code: "file_info_failed",
          message: rootInfoResult.error.message,
          path: dir,
        });
      }
      continue;
    }
    const rootInfo = rootInfoResult.value;
    if ((await resolveKind(env, rootInfo, diagnostics)) !== "directory") {
      continue;
    }
    const result = await loadSkillsFromDirInternal(
      env,
      rootInfo.path,
      true,
      ignore(),
      rootInfo.path,
    );
    skills.push(...result.skills);
    diagnostics.push(...result.diagnostics);
  }
  return { skills, diagnostics };
}

/**
 * Load skills from source-tagged directories.
 *
 * Source values are preserved exactly and attached to every loaded skill and diagnostic. The agent package does not
 * interpret source values; applications define their own provenance shape.
 */
export async function loadSourcedSkills<TSource, TSkill extends Skill = Skill>(
  env: ExecutionEnv,
  inputs: Array<{ path: string; source: TSource }>,
  mapSkill?: (skill: Skill, source: TSource) => TSkill,
): Promise<{
  skills: Array<{ skill: TSkill; source: TSource }>;
  diagnostics: Array<SkillDiagnostic & { source: TSource }>;
}> {
  const skills: Array<{ skill: TSkill; source: TSource }> = [];
  const diagnostics: Array<SkillDiagnostic & { source: TSource }> = [];
  for (const input of inputs) {
    const result = await loadSkills(env, input.path);
    for (const skill of result.skills) {
      skills.push({
        skill: mapSkill ? mapSkill(skill, input.source) : (skill as TSkill),
        source: input.source,
      });
    }
    for (const diagnostic of result.diagnostics) {
      diagnostics.push({ ...diagnostic, source: input.source });
    }
  }
  return { skills, diagnostics };
}

async function loadSkillsFromDirInternal(
  env: ExecutionEnv,
  dir: string,
  includeRootFiles: boolean,
  ignoreMatcher: IgnoreMatcher,
  rootDir: string,
): Promise<{ skills: Skill[]; diagnostics: SkillDiagnostic[] }> {
  const skills: Skill[] = [];
  const diagnostics: SkillDiagnostic[] = [];

  const dirInfoResult = await env.fileInfo(dir);
  if (!dirInfoResult.ok) {
    if (dirInfoResult.error.code !== "not_found") {
      diagnostics.push({
        type: "warning",
        code: "file_info_failed",
        message: dirInfoResult.error.message,
        path: dir,
      });
    }
    return { skills, diagnostics };
  }
  const dirInfo = dirInfoResult.value;
  if ((await resolveKind(env, dirInfo, diagnostics)) !== "directory") {
    return { skills, diagnostics };
  }

  await addIgnoreRules(env, ignoreMatcher, dir, rootDir, diagnostics);

  const entriesResult = await env.listDir(dir);
  if (!entriesResult.ok) {
    diagnostics.push({
      type: "warning",
      code: "list_failed",
      message: entriesResult.error.message,
      path: dir,
    });
    return { skills, diagnostics };
  }
  const entries = entriesResult.value;

  for (const entry of entries) {
    if (entry.name !== "SKILL.md") {
      continue;
    }
    const fullPath = entry.path;
    const kind = await resolveKind(env, entry, diagnostics);
    if (kind !== "file") {
      continue;
    }
    const relPath = relativeEnvPath(rootDir, fullPath);
    if (ignoreMatcher.ignores(relPath)) {
      continue;
    }

    const result = await loadSkillFromFile(env, fullPath);
    if (result.skill) {
      skills.push(result.skill);
    }
    diagnostics.push(...result.diagnostics);
    return { skills, diagnostics };
  }

  for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") {
      continue;
    }
    const fullPath = entry.path;
    const kind = await resolveKind(env, entry, diagnostics);
    if (!kind) {
      continue;
    }

    const relPath = relativeEnvPath(rootDir, fullPath);
    const ignorePath = kind === "directory" ? `${relPath}/` : relPath;
    if (ignoreMatcher.ignores(ignorePath)) {
      continue;
    }

    if (kind === "directory") {
      const result = await loadSkillsFromDirInternal(env, fullPath, false, ignoreMatcher, rootDir);
      skills.push(...result.skills);
      diagnostics.push(...result.diagnostics);
      continue;
    }

    if (kind !== "file" || !includeRootFiles || !entry.name.endsWith(".md")) {
      continue;
    }
    const result = await loadSkillFromFile(env, fullPath);
    if (result.skill) {
      skills.push(result.skill);
    }
    diagnostics.push(...result.diagnostics);
  }

  return { skills, diagnostics };
}

async function addIgnoreRules(
  env: ExecutionEnv,
  ig: IgnoreMatcher,
  dir: string,
  rootDir: string,
  diagnostics: SkillDiagnostic[],
): Promise<void> {
  const relativeDir = relativeEnvPath(rootDir, dir);
  const prefix = relativeDir ? `${relativeDir}/` : "";

  for (const filename of IGNORE_FILE_NAMES) {
    const ignorePath = joinEnvPath(dir, filename);
    const info = await env.fileInfo(ignorePath);
    if (!info.ok) {
      if (info.error.code !== "not_found") {
        diagnostics.push({
          type: "warning",
          code: "file_info_failed",
          message: info.error.message,
          path: ignorePath,
        });
      }
      continue;
    }
    if (info.value.kind !== "file") {
      continue;
    }
    const content = await env.readTextFile(ignorePath);
    if (!content.ok) {
      diagnostics.push({
        type: "warning",
        code: "read_failed",
        message: content.error.message,
        path: ignorePath,
      });
      continue;
    }
    const patterns = content.value
      .split(/\r?\n/)
      .map((line) => prefixIgnorePattern(line, prefix))
      .filter((line): line is string => Boolean(line));
    if (patterns.length > 0) {
      ig.add(patterns);
    }
  }
}

function prefixIgnorePattern(line: string, prefix: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith("#") && !trimmed.startsWith("\\#")) {
    return null;
  }

  let pattern = line;
  let negated = false;
  if (pattern.startsWith("!")) {
    negated = true;
    pattern = pattern.slice(1);
  } else if (pattern.startsWith("\\!")) {
    pattern = pattern.slice(1);
  }
  if (pattern.startsWith("/")) {
    pattern = pattern.slice(1);
  }
  const prefixed = prefix ? `${prefix}${pattern}` : pattern;
  return negated ? `!${prefixed}` : prefixed;
}

async function loadSkillFromFile(
  env: ExecutionEnv,
  filePath: string,
): Promise<{ skill: Skill | null; diagnostics: SkillDiagnostic[] }> {
  const diagnostics: SkillDiagnostic[] = [];
  const rawContent = await env.readTextFile(filePath);
  if (!rawContent.ok) {
    diagnostics.push({
      type: "warning",
      code: "read_failed",
      message: rawContent.error.message,
      path: filePath,
    });
    return { skill: null, diagnostics };
  }

  const parsed = parseFrontmatter(rawContent.value) as Result<
    { frontmatter: SkillFrontmatter; body: string },
    Error
  >;
  if (!parsed.ok) {
    diagnostics.push({
      type: "warning",
      code: "parse_failed",
      message: parsed.error.message,
      path: filePath,
    });
    return { skill: null, diagnostics };
  }

  const { frontmatter, body } = parsed.value;
  const skillDir = dirnameEnvPath(filePath);
  const parentDirName = basenameEnvPath(skillDir);
  const description =
    typeof frontmatter.description === "string" ? frontmatter.description : undefined;

  for (const error of validateDescription(description)) {
    diagnostics.push({ type: "warning", code: "invalid_metadata", message: error, path: filePath });
  }

  const frontmatterName = typeof frontmatter.name === "string" ? frontmatter.name : undefined;
  const name = frontmatterName || parentDirName;
  for (const error of validateName(name, parentDirName)) {
    diagnostics.push({ type: "warning", code: "invalid_metadata", message: error, path: filePath });
  }

  if (!description || description.trim() === "") {
    return { skill: null, diagnostics };
  }

  return {
    skill: {
      name,
      description,
      content: body,
      filePath,
      promptVersion: await computeSkillPromptVersion(rawContent.value),
      disableModelInvocation: frontmatter["disable-model-invocation"] === true,
    },
    diagnostics,
  };
}

async function computeSkillPromptVersion(content: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    return `hash:${computeStableFallbackHash(content)}`;
  }
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(content));
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${hex.slice(0, 16)}`;
}

function computeStableFallbackHash(content: string): string {
  let hash = 0x811c9dc5;
  for (const char of content) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function validateName(name: string, parentDirName: string): string[] {
  const errors: string[] = [];
  if (name !== parentDirName) {
    errors.push(`name "${name}" does not match parent directory "${parentDirName}"`);
  }
  if (name.length > MAX_NAME_LENGTH) {
    errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
  }
  if (!/^[a-z0-9-]+$/.test(name)) {
    errors.push("name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)");
  }
  if (name.startsWith("-") || name.endsWith("-")) {
    errors.push("name must not start or end with a hyphen");
  }
  if (name.includes("--")) {
    errors.push("name must not contain consecutive hyphens");
  }
  return errors;
}

function validateDescription(description: string | undefined): string[] {
  const errors: string[] = [];
  if (!description || description.trim() === "") {
    errors.push("description is required");
  } else if (description.length > MAX_DESCRIPTION_LENGTH) {
    errors.push(`description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`);
  }
  return errors;
}

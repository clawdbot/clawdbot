import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "../../agents/config.js";
import type { ResourceDiagnostic } from "../../agents/sessions/diagnostics.js";
import { createSyntheticSourceInfo, type SourceInfo } from "../../agents/sessions/source-info.js";
import { canonicalizePath } from "../../agents/utils/paths.js";
import { addIgnoreRules, toPosixPath, type IgnoreMatcher } from "../../shared/ignore-rules.js";
// Session skill helpers resolve skills attached to a session and its transcript state.
import { expandTildePath } from "../../shared/tilde-path.js";
import { getArchivedSkillFiles } from "../workshop/curator.js";
import { parseFrontmatter, resolveSkillInvocationPolicy } from "./frontmatter.js";
import { formatSkillsForPrompt as formatSkillContractForPrompt } from "./skill-contract.js";
import { computeSkillPromptVersion } from "./skill-version.js";

/** Max name length per spec */
const MAX_NAME_LENGTH = 64;

/** Max description length per spec */
const MAX_DESCRIPTION_LENGTH = 1024;

export interface Skill {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  promptVersion?: string;
  source: string;
  sourceInfo: SourceInfo;
  disableModelInvocation: boolean;
}

interface LoadSkillsResult {
  skills: Skill[];
  diagnostics: ResourceDiagnostic[];
}

/**
 * Validate skill name per Agent Skills spec.
 * Returns array of validation error messages (empty if valid).
 */
function validateName(name: string): string[] {
  const errors: string[] = [];

  if (name.length > MAX_NAME_LENGTH) {
    errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
  }

  if (!/^[a-z0-9-]+$/.test(name)) {
    errors.push(`name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)`);
  }

  if (name.startsWith("-") || name.endsWith("-")) {
    errors.push(`name must not start or end with a hyphen`);
  }

  if (name.includes("--")) {
    errors.push(`name must not contain consecutive hyphens`);
  }

  return errors;
}

/**
 * Validate description per Agent Skills spec.
 */
function validateDescription(description: string | undefined): string[] {
  const errors: string[] = [];

  if (!description || description.trim() === "") {
    errors.push("description is required");
  } else if (description.length > MAX_DESCRIPTION_LENGTH) {
    errors.push(`description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`);
  }

  return errors;
}

function createSkillSourceInfo(filePath: string, baseDir: string, source: string): SourceInfo {
  switch (source) {
    case "user":
      return createSyntheticSourceInfo(filePath, {
        source: "local",
        scope: "user",
        baseDir,
      });
    case "project":
      return createSyntheticSourceInfo(filePath, {
        source: "local",
        scope: "project",
        baseDir,
      });
    case "path":
      return createSyntheticSourceInfo(filePath, {
        source: "local",
        baseDir,
      });
    default:
      return createSyntheticSourceInfo(filePath, { source, baseDir });
  }
}

function loadSkillsFromDirInternal(
  dir: string,
  source: string,
  includeRootFiles: boolean,
  ignoreMatcher?: IgnoreMatcher,
  rootDir?: string,
): LoadSkillsResult {
  const skills: Skill[] = [];
  const diagnostics: ResourceDiagnostic[] = [];

  if (!existsSync(dir)) {
    return { skills, diagnostics };
  }

  const root = rootDir ?? dir;
  const ig = ignoreMatcher
    ? addIgnoreRules(dir, root, ignoreMatcher, { ignoreCase: true })
    : addIgnoreRules(dir, root);

  try {
    const entries = readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name !== "SKILL.md") {
        continue;
      }

      const fullPath = join(dir, entry.name);

      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          isFile = statSync(fullPath).isFile();
        } catch {
          continue;
        }
      }

      const relPath = toPosixPath(relative(root, fullPath));
      if (!isFile || ig.ignores(relPath)) {
        continue;
      }

      const result = loadSkillFromFile(fullPath, source);
      if (result.skill) {
        skills.push(result.skill);
      }
      diagnostics.push(...result.diagnostics);
      return { skills, diagnostics };
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }

      // Skip node_modules to avoid scanning dependencies
      if (entry.name === "node_modules") {
        continue;
      }

      const fullPath = join(dir, entry.name);

      // For symlinks, check if they point to a directory and follow them
      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const stats = statSync(fullPath);
          isDirectory = stats.isDirectory();
          isFile = stats.isFile();
        } catch {
          // Broken symlink, skip it
          continue;
        }
      }

      const relPath = toPosixPath(relative(root, fullPath));
      const ignorePath = isDirectory ? `${relPath}/` : relPath;
      if (ig.ignores(ignorePath)) {
        continue;
      }

      if (isDirectory) {
        const subResult = loadSkillsFromDirInternal(fullPath, source, false, ig, root);
        skills.push(...subResult.skills);
        diagnostics.push(...subResult.diagnostics);
        continue;
      }

      if (!isFile || !includeRootFiles || !entry.name.endsWith(".md")) {
        continue;
      }

      const result = loadSkillFromFile(fullPath, source);
      if (result.skill) {
        skills.push(result.skill);
      }
      diagnostics.push(...result.diagnostics);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed to scan skill directory";
    diagnostics.push({ type: "warning", message, path: dir });
  }

  return { skills, diagnostics };
}

function loadSkillFromFile(
  filePath: string,
  source: string,
): { skill: Skill | null; diagnostics: ResourceDiagnostic[] } {
  const diagnostics: ResourceDiagnostic[] = [];

  try {
    const rawContent = readFileSync(filePath, "utf-8");
    const frontmatter = parseFrontmatter(rawContent);
    const invocation = resolveSkillInvocationPolicy(frontmatter);
    const skillDir = dirname(filePath);
    const parentDirName = basename(skillDir);

    // Validate description
    const descErrors = validateDescription(frontmatter.description);
    for (const error of descErrors) {
      diagnostics.push({ type: "warning", message: error, path: filePath });
    }

    // Use name from frontmatter, or fall back to parent directory name
    const name = frontmatter.name || parentDirName;

    // Validate name
    const nameErrors = validateName(name);
    for (const error of nameErrors) {
      diagnostics.push({ type: "warning", message: error, path: filePath });
    }

    // Still load the skill even with warnings (unless description is completely missing)
    if (!frontmatter.description || frontmatter.description.trim() === "") {
      return { skill: null, diagnostics };
    }

    return {
      skill: {
        name,
        description: frontmatter.description,
        filePath,
        baseDir: skillDir,
        promptVersion: computeSkillPromptVersion(rawContent),
        source,
        sourceInfo: createSkillSourceInfo(filePath, skillDir, source),
        disableModelInvocation: invocation.disableModelInvocation,
      },
      diagnostics,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed to parse skill file";
    diagnostics.push({ type: "warning", message, path: filePath });
    return { skill: null, diagnostics };
  }
}

/**
 * Format skills for inclusion in a system prompt.
 * Uses XML format per Agent Skills standard.
 * See: https://agentskills.io/integrate-skills
 *
 * Skills with disableModelInvocation=true are excluded from the prompt
 * (they can only be invoked explicitly via /skill:name commands).
 */
export function formatSkillsForPrompt(skills: Skill[]): string {
  const visibleSkills = skills.filter((s) => !s.disableModelInvocation);
  return formatSkillContractForPrompt(visibleSkills);
}

interface LoadSkillsOptions {
  /** Working directory for project-local skills. */
  cwd: string;
  /** Agent config directory for global skills. */
  agentDir: string;
  /** Explicit skill paths (files or directories) */
  skillPaths: string[];
  /** Include default skills directories. */
  includeDefaults: boolean;
}

function resolveSkillPath(p: string, cwd: string): string {
  const normalized = expandTildePath(p);
  return isAbsolute(normalized) ? normalized : resolve(cwd, normalized);
}

/**
 * Load skills from all configured locations.
 * Returns skills and any validation diagnostics.
 */
export function loadSkills(options: LoadSkillsOptions): LoadSkillsResult {
  const { cwd, agentDir, skillPaths, includeDefaults } = options;
  // One snapshot-level query enforces archival without polling tool hot paths or touching files.
  const archivedSkillFiles = getArchivedSkillFiles();

  // Resolve agentDir - if not provided, use default from config
  const resolvedAgentDir = agentDir ?? getAgentDir();

  const skillMap = new Map<string, Skill>();
  const realPathSet = new Set<string>();
  const allDiagnostics: ResourceDiagnostic[] = [];
  const collisionDiagnostics: ResourceDiagnostic[] = [];

  function addSkills(result: LoadSkillsResult) {
    allDiagnostics.push(...result.diagnostics);
    for (const skill of result.skills) {
      if (archivedSkillFiles.has(canonicalizePath(skill.filePath))) {
        continue;
      }
      // Resolve symlinks to detect duplicate files
      const realPath = canonicalizePath(skill.filePath);

      // Skip silently if we've already loaded this exact file (via symlink)
      if (realPathSet.has(realPath)) {
        continue;
      }

      const existing = skillMap.get(skill.name);
      if (existing) {
        collisionDiagnostics.push({
          type: "collision",
          message: `name "${skill.name}" collision`,
          path: skill.filePath,
          collision: {
            resourceType: "skill",
            name: skill.name,
            winnerPath: existing.filePath,
            loserPath: skill.filePath,
          },
        });
      } else {
        skillMap.set(skill.name, skill);
        realPathSet.add(realPath);
      }
    }
  }

  if (includeDefaults) {
    addSkills(loadSkillsFromDirInternal(join(resolvedAgentDir, "skills"), "user", true));
    addSkills(loadSkillsFromDirInternal(resolve(cwd, CONFIG_DIR_NAME, "skills"), "project", true));
  }

  const userSkillsDir = join(resolvedAgentDir, "skills");
  const projectSkillsDir = resolve(cwd, CONFIG_DIR_NAME, "skills");

  const isUnderPath = (target: string, root: string): boolean => {
    const normalizedRoot = resolve(root);
    if (target === normalizedRoot) {
      return true;
    }
    const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
    return target.startsWith(prefix);
  };

  const getSource = (resolvedPath: string): "user" | "project" | "path" => {
    if (!includeDefaults) {
      if (isUnderPath(resolvedPath, userSkillsDir)) {
        return "user";
      }
      if (isUnderPath(resolvedPath, projectSkillsDir)) {
        return "project";
      }
    }
    return "path";
  };

  for (const rawPath of skillPaths) {
    const resolvedPath = resolveSkillPath(rawPath, cwd);
    if (!existsSync(resolvedPath)) {
      allDiagnostics.push({
        type: "warning",
        message: "skill path does not exist",
        path: resolvedPath,
      });
      continue;
    }

    try {
      const stats = statSync(resolvedPath);
      const source = getSource(resolvedPath);
      if (stats.isDirectory()) {
        addSkills(loadSkillsFromDirInternal(resolvedPath, source, true));
      } else if (stats.isFile() && resolvedPath.endsWith(".md")) {
        const result = loadSkillFromFile(resolvedPath, source);
        if (result.skill) {
          addSkills({ skills: [result.skill], diagnostics: result.diagnostics });
        } else {
          allDiagnostics.push(...result.diagnostics);
        }
      } else {
        allDiagnostics.push({
          type: "warning",
          message: "skill path is not a markdown file",
          path: resolvedPath,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "failed to read skill path";
      allDiagnostics.push({ type: "warning", message, path: resolvedPath });
    }
  }

  return {
    skills: Array.from(skillMap.values()),
    diagnostics: [...allDiagnostics, ...collisionDiagnostics],
  };
}

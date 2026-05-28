import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { CONFIG_DIR_NAME } from "../config.js";
import { parseFrontmatter } from "../utils/frontmatter.js";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.js";

/**
 * Represents a prompt template loaded from a markdown file
 */
export interface PromptTemplate {
  name: string;
  description: string;
  argumentHint?: string;
  content: string;
  sourceInfo: SourceInfo;
  filePath: string; // Absolute path to the template file
}

/**
 * Parse command arguments respecting quoted strings (bash-style)
 * Returns array of arguments
 */
export function parseCommandArgs(argsString: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuote: string | null = null;

  for (let i = 0; i < argsString.length; i++) {
    const char = argsString[i];

    if (inQuote) {
      if (char === inQuote) {
        inQuote = null;
      } else {
        current += char;
      }
    } else if (char === '"' || char === "'") {
      inQuote = char;
    } else if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }

  if (current) {
    args.push(current);
  }

  return args;
}

/**
 * Substitute argument placeholders in template content
 * Supports:
 * - $1, $2, ... for positional args
 * - $@ and $ARGUMENTS for all args
 * - ${@:N} for args from Nth onwards (bash-style slicing)
 * - ${@:N:L} for L args starting from Nth
 *
 * Note: Replacement happens on the template string only. Argument values
 * containing patterns like $1, $@, or $ARGUMENTS are NOT recursively substituted.
 */
export function substituteArgs(content: string, args: string[]): string {
  let result = content;

  // Replace $1, $2, etc. with positional args FIRST (before wildcards)
  // This prevents wildcard replacement values containing $<digit> patterns from being re-substituted
  result = result.replace(/\$(\d+)/g, (_, num) => {
    const index = Number.parseInt(num, 10) - 1;
    return args[index] ?? "";
  });

  // Replace ${@:start} or ${@:start:length} with sliced args (bash-style)
  // Process BEFORE simple $@ to avoid conflicts
  result = result.replace(/\$\{@:(\d+)(?::(\d+))?\}/g, (_, startStr, lengthStr) => {
    let start = Number.parseInt(startStr, 10) - 1; // Convert to 0-indexed (user provides 1-indexed)
    // Treat 0 as 1 (bash convention: args start at 1)
    if (start < 0) {
      start = 0;
    }

    if (lengthStr) {
      const length = Number.parseInt(lengthStr, 10);
      return args.slice(start, start + length).join(" ");
    }
    return args.slice(start).join(" ");
  });

  // Pre-compute all args joined (optimization)
  const allArgs = args.join(" ");

  // Replace $ARGUMENTS with all args joined (new syntax, aligns with Claude, Codex, OpenCode)
  result = result.replace(/\$ARGUMENTS/g, allArgs);

  // Replace $@ with all args joined (existing syntax)
  result = result.replace(/\$@/g, allArgs);

  return result;
}

function loadTemplateFromFile(filePath: string, sourceInfo: SourceInfo): PromptTemplate | null {
  try {
    const rawContent = readFileSync(filePath, "utf-8");
    const { frontmatter, body } = parseFrontmatter<Record<string, string>>(rawContent);

    const name = basename(filePath).replace(/\.md$/, "");

    // Get description from frontmatter or first non-empty line
    let description = frontmatter.description || "";
    if (!description) {
      const firstLine = body.split("\n").find((line) => line.trim());
      if (firstLine) {
        // Truncate if too long
        description = firstLine.slice(0, 60);
        if (firstLine.length > 60) {
          description += "...";
        }
      }
    }

    return {
      name,
      description,
      ...(frontmatter["argument-hint"] && { argumentHint: frontmatter["argument-hint"] }),
      content: body,
      sourceInfo,
      filePath,
    };
  } catch {
    return null;
  }
}

/**
 * Scan a directory for .md files (non-recursive) and load them as prompt templates.
 */
function loadTemplatesFromDir(
  dir: string,
  getSourceInfo: (filePath: string) => SourceInfo,
): PromptTemplate[] {
  const templates: PromptTemplate[] = [];

  if (!existsSync(dir)) {
    return templates;
  }

  try {
    const entries = readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);

      // For symlinks, check if they point to a file
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const stats = statSync(fullPath);
          isFile = stats.isFile();
        } catch {
          // Broken symlink, skip it
          continue;
        }
      }

      if (isFile && entry.name.endsWith(".md")) {
        const template = loadTemplateFromFile(fullPath, getSourceInfo(fullPath));
        if (template) {
          templates.push(template);
        }
      }
    }
  } catch {
    return templates;
  }

  return templates;
}

export interface LoadPromptTemplatesOptions {
  /** Working directory for project-local templates. */
  cwd: string;
  /** Agent config directory for global templates. */
  agentDir: string;
  /** Explicit prompt template paths (files or directories). */
  promptPaths: string[];
  /** Include default prompt directories. */
  includeDefaults: boolean;
}

function normalizePath(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "~") {
    return homedir();
  }
  if (trimmed.startsWith("~/")) {
    return join(homedir(), trimmed.slice(2));
  }
  if (trimmed.startsWith("~")) {
    return join(homedir(), trimmed.slice(1));
  }
  return trimmed;
}

function resolvePromptPath(p: string, cwd: string): string {
  const normalized = normalizePath(p);
  return isAbsolute(normalized) ? normalized : resolve(cwd, normalized);
}

/**
 * Load all prompt templates from:
 * 1. Global: agentDir/prompts/
 * 2. Project: cwd/{CONFIG_DIR_NAME}/prompts/
 * 3. Explicit prompt paths
 */
export function loadPromptTemplates(options: LoadPromptTemplatesOptions): PromptTemplate[] {
  const resolvedCwd = options.cwd;
  const resolvedAgentDir = options.agentDir;
  const promptPaths = options.promptPaths;
  const includeDefaults = options.includeDefaults;

  const templates: PromptTemplate[] = [];

  const globalPromptsDir = options.agentDir ? join(options.agentDir, "prompts") : resolvedAgentDir;
  const projectPromptsDir = resolve(resolvedCwd, CONFIG_DIR_NAME, "prompts");

  const isUnderPath = (target: string, root: string): boolean => {
    const normalizedRoot = resolve(root);
    if (target === normalizedRoot) {
      return true;
    }
    const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
    return target.startsWith(prefix);
  };

  const getSourceInfo = (resolvedPath: string): SourceInfo => {
    if (isUnderPath(resolvedPath, globalPromptsDir)) {
      return createSyntheticSourceInfo(resolvedPath, {
        source: "local",
        scope: "user",
        baseDir: globalPromptsDir,
      });
    }
    if (isUnderPath(resolvedPath, projectPromptsDir)) {
      return createSyntheticSourceInfo(resolvedPath, {
        source: "local",
        scope: "project",
        baseDir: projectPromptsDir,
      });
    }
    return createSyntheticSourceInfo(resolvedPath, {
      source: "local",
      baseDir: statSync(resolvedPath).isDirectory() ? resolvedPath : dirname(resolvedPath),
    });
  };

  if (includeDefaults) {
    templates.push(...loadTemplatesFromDir(globalPromptsDir, getSourceInfo));
    templates.push(...loadTemplatesFromDir(projectPromptsDir, getSourceInfo));
  }

  // 3. Load explicit prompt paths
  for (const rawPath of promptPaths) {
    const resolvedPath = resolvePromptPath(rawPath, resolvedCwd);
    if (!existsSync(resolvedPath)) {
      continue;
    }

    try {
      const stats = statSync(resolvedPath);
      if (stats.isDirectory()) {
        templates.push(...loadTemplatesFromDir(resolvedPath, getSourceInfo));
      } else if (stats.isFile() && resolvedPath.endsWith(".md")) {
        const template = loadTemplateFromFile(resolvedPath, getSourceInfo(resolvedPath));
        if (template) {
          templates.push(template);
        }
      }
    } catch {
      // Ignore read failures
    }
  }

  return templates;
}

/**
 * Expand a prompt template if it matches a template name.
 * Returns the expanded content or the original text if not a template.
 */
export function expandPromptTemplate(text: string, templates: PromptTemplate[]): string {
  if (!text.startsWith("/")) {
    return text;
  }

  const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
  if (!match) {
    return text;
  }

  const templateName = match[1];
  const argsString = match[2] ?? "";

  const template = templates.find((t) => t.name === templateName);
  if (template) {
    const args = parseCommandArgs(argsString);
    return substituteArgs(template.content, args);
  }

  return text;
}

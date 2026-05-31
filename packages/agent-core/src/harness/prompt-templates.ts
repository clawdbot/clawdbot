import {
  basenameEnvPath,
  parseFrontmatter,
  resolveFileInfoKind as resolveKind,
} from "./file-loader-utils.js";
export { parseCommandArgs, substituteArgs } from "./prompt-template-arguments.js";
import { substituteArgs } from "./prompt-template-arguments.js";
import type { ExecutionEnv, PromptTemplate, Result } from "./types.js";

export type PromptTemplateDiagnosticCode =
  | "file_info_failed"
  | "list_failed"
  | "read_failed"
  | "parse_failed";

/** Warning produced while loading prompt templates. */
export interface PromptTemplateDiagnostic {
  /** Diagnostic severity. Currently only warnings are emitted. */
  type: "warning";
  /** Stable diagnostic code. */
  code: PromptTemplateDiagnosticCode;
  /** Human-readable diagnostic message. */
  message: string;
  /** Path associated with the diagnostic. */
  path: string;
}

interface PromptTemplateFrontmatter {
  description?: string;
  "argument-hint"?: string;
  [key: string]: unknown;
}

/**
 * Load prompt templates from one or more paths.
 *
 * Directory inputs load direct `.md` children non-recursively. File inputs load explicit `.md` files. Missing paths and
 * non-markdown files are skipped. Read and parse failures are returned as diagnostics.
 */
export async function loadPromptTemplates(
  env: ExecutionEnv,
  paths: string | string[],
): Promise<{ promptTemplates: PromptTemplate[]; diagnostics: PromptTemplateDiagnostic[] }> {
  const promptTemplates: PromptTemplate[] = [];
  const diagnostics: PromptTemplateDiagnostic[] = [];
  for (const path of Array.isArray(paths) ? paths : [paths]) {
    const infoResult = await env.fileInfo(path);
    if (!infoResult.ok) {
      if (infoResult.error.code !== "not_found") {
        diagnostics.push({
          type: "warning",
          code: "file_info_failed",
          message: infoResult.error.message,
          path,
        });
      }
      continue;
    }
    const info = infoResult.value;
    const kind = await resolveKind(env, info, diagnostics);
    if (kind === "directory") {
      const result = await loadTemplatesFromDir(env, info.path);
      promptTemplates.push(...result.promptTemplates);
      diagnostics.push(...result.diagnostics);
    } else if (kind === "file" && info.name.endsWith(".md")) {
      const result = await loadTemplateFromFile(env, info.path);
      if (result.promptTemplate) {
        promptTemplates.push(result.promptTemplate);
      }
      diagnostics.push(...result.diagnostics);
    }
  }
  return { promptTemplates, diagnostics };
}

/**
 * Load prompt templates from source-tagged paths.
 *
 * Source values are preserved exactly and attached to every loaded prompt template and diagnostic. The agent package does
 * not interpret source values; applications define their own provenance shape.
 */
export async function loadSourcedPromptTemplates<
  TSource,
  TPromptTemplate extends PromptTemplate = PromptTemplate,
>(
  env: ExecutionEnv,
  inputs: Array<{ path: string; source: TSource }>,
  mapPromptTemplate?: (promptTemplate: PromptTemplate, source: TSource) => TPromptTemplate,
): Promise<{
  promptTemplates: Array<{ promptTemplate: TPromptTemplate; source: TSource }>;
  diagnostics: Array<PromptTemplateDiagnostic & { source: TSource }>;
}> {
  const promptTemplates: Array<{ promptTemplate: TPromptTemplate; source: TSource }> = [];
  const diagnostics: Array<PromptTemplateDiagnostic & { source: TSource }> = [];
  for (const input of inputs) {
    const result = await loadPromptTemplates(env, input.path);
    for (const promptTemplate of result.promptTemplates) {
      promptTemplates.push({
        promptTemplate: mapPromptTemplate
          ? mapPromptTemplate(promptTemplate, input.source)
          : (promptTemplate as TPromptTemplate),
        source: input.source,
      });
    }
    for (const diagnostic of result.diagnostics) {
      diagnostics.push({ ...diagnostic, source: input.source });
    }
  }
  return { promptTemplates, diagnostics };
}

async function loadTemplatesFromDir(
  env: ExecutionEnv,
  dir: string,
): Promise<{ promptTemplates: PromptTemplate[]; diagnostics: PromptTemplateDiagnostic[] }> {
  const promptTemplates: PromptTemplate[] = [];
  const diagnostics: PromptTemplateDiagnostic[] = [];
  const entriesResult = await env.listDir(dir);
  if (!entriesResult.ok) {
    diagnostics.push({
      type: "warning",
      code: "list_failed",
      message: entriesResult.error.message,
      path: dir,
    });
    return { promptTemplates, diagnostics };
  }
  const entries = entriesResult.value;

  for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
    const kind = await resolveKind(env, entry, diagnostics);
    if (kind !== "file" || !entry.name.endsWith(".md")) {
      continue;
    }
    const result = await loadTemplateFromFile(env, entry.path);
    if (result.promptTemplate) {
      promptTemplates.push(result.promptTemplate);
    }
    diagnostics.push(...result.diagnostics);
  }
  return { promptTemplates, diagnostics };
}

async function loadTemplateFromFile(
  env: ExecutionEnv,
  filePath: string,
): Promise<{ promptTemplate: PromptTemplate | null; diagnostics: PromptTemplateDiagnostic[] }> {
  const diagnostics: PromptTemplateDiagnostic[] = [];
  const rawContent = await env.readTextFile(filePath);
  if (!rawContent.ok) {
    diagnostics.push({
      type: "warning",
      code: "read_failed",
      message: rawContent.error.message,
      path: filePath,
    });
    return { promptTemplate: null, diagnostics };
  }

  const parsed = parseFrontmatter(rawContent.value) as Result<
    { frontmatter: PromptTemplateFrontmatter; body: string },
    Error
  >;
  if (!parsed.ok) {
    diagnostics.push({
      type: "warning",
      code: "parse_failed",
      message: parsed.error.message,
      path: filePath,
    });
    return { promptTemplate: null, diagnostics };
  }

  const { frontmatter, body } = parsed.value;
  const firstLine = body.split("\n").find((line) => line.trim());
  let description = typeof frontmatter.description === "string" ? frontmatter.description : "";
  if (!description && firstLine) {
    description = firstLine.slice(0, 60);
    if (firstLine.length > 60) {
      description += "...";
    }
  }
  return {
    promptTemplate: {
      name: basenameEnvPath(filePath).replace(/\.md$/i, ""),
      description,
      content: body,
    },
    diagnostics,
  };
}

/** Format a prompt template invocation with positional arguments. */
export function formatPromptTemplateInvocation(
  template: PromptTemplate,
  args: string[] = [],
): string {
  return substituteArgs(template.content, args);
}

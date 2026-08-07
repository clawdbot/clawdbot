/** Parses compatible-bundle agent files into cold, non-executable metadata. */
import fs from "node:fs";
import path from "node:path";
import { asPositiveSafeInteger } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeSortedUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import {
  parseFrontmatterBlockResult,
  stripFrontmatterBlock,
} from "../../packages/markdown-core/src/frontmatter.js";
import { openRootFileSync, readFileDescriptorBoundedSync } from "../infra/boundary-file-read.js";
import { sha256Hex } from "../infra/crypto-digest.js";
import { walkDirectorySync } from "../infra/fs-safe.js";
import { normalizeStringList } from "../shared/frontmatter.js";
import { parseBooleanValue } from "../utils/boolean.js";
import type {
  BundleAgentTemplate,
  BundleAgentUnsupportedField,
  PluginDiagnostic,
} from "./manifest-types.js";
import { isPathInside, safeRealpathSync } from "./path-safety.js";

// These caps bound synchronous, cold metadata discovery per compatible format.
// Keep both filesystem traversal and retained prompt-derived metadata predictable.
const MAX_AGENT_ROOTS = 64;
const MAX_AGENT_DEPTH = 8;
const MAX_AGENT_SCAN_ENTRIES = 2_048;
const MAX_AGENT_FILES = 256;
const MAX_AGENT_FILE_BYTES = 1024 * 1024;
const MAX_AGENT_TOTAL_BYTES = 8 * 1024 * 1024;

const COMMON_FIELDS = new Set([
  "name",
  "description",
  "model",
  "effort",
  "maxTurns",
  "tools",
  "disallowedTools",
  "skills",
  "memory",
  "background",
  "isolation",
  "readOnly",
]);
const CURSOR_FIELDS = new Set(["is_background", "readonly"]);

type BundleAgentTemplateLoadResult = {
  agentTemplates: BundleAgentTemplate[];
  diagnostics: PluginDiagnostic[];
};

type BundleAgentFile = {
  relativePath: string;
  identityPath: string;
};

/** Drops every definition involved in an id collision instead of choosing implicitly. */
export function filterConflictingBundleAgentTemplates(templates: readonly BundleAgentTemplate[]): {
  agentTemplates: BundleAgentTemplate[];
  conflictingIds: string[];
} {
  const counts = new Map<string, number>();
  for (const template of templates) {
    counts.set(template.id, (counts.get(template.id) ?? 0) + 1);
  }
  const conflictingIds = [...counts]
    .filter(([, count]) => count > 1)
    .map(([id]) => id)
    .toSorted();
  const conflicts = new Set(conflictingIds);
  return {
    agentTemplates: templates.filter((entry) => !conflicts.has(entry.id)),
    conflictingIds,
  };
}

function normalizeRelativePath(value: string): string {
  return value.split(path.sep).join("/");
}

function addDiagnostic(params: {
  diagnostics: PluginDiagnostic[];
  pluginId: string;
  source: string;
  message: string;
}): void {
  params.diagnostics.push({
    code: "bundle-agent-metadata",
    level: "warn",
    pluginId: params.pluginId,
    source: params.source,
    message: params.message,
  });
}

function listAgentFiles(params: {
  rootDir: string;
  rootRealPath: string;
  agentRoots: readonly string[];
  pluginId: string;
  diagnostics: PluginDiagnostic[];
}): BundleAgentFile[] {
  const uniqueRoots = normalizeSortedUniqueTrimmedStringList(params.agentRoots);
  const roots = uniqueRoots.slice(0, MAX_AGENT_ROOTS);
  if (uniqueRoots.length > MAX_AGENT_ROOTS) {
    addDiagnostic({
      ...params,
      source: params.rootDir,
      message: "bundle agent metadata root limit reached; remaining roots ignored",
    });
  }

  const files = new Map<string, BundleAgentFile>();
  const scannedRoots: string[] = [];
  let remainingEntries = MAX_AGENT_SCAN_ENTRIES;
  for (const declaredRoot of roots) {
    const absoluteRoot = path.resolve(params.rootDir, declaredRoot);
    if (!isPathInside(params.rootDir, absoluteRoot)) {
      addDiagnostic({
        ...params,
        source: absoluteRoot,
        message: "bundle agent metadata root escapes the plugin root; entry ignored",
      });
      continue;
    }
    const realRoot = safeRealpathSync(absoluteRoot);
    if (!realRoot) {
      addDiagnostic({
        diagnostics: params.diagnostics,
        pluginId: params.pluginId,
        source: absoluteRoot,
        message: "declared bundle agent metadata root could not be inspected; entry ignored",
      });
      continue;
    }
    if (!isPathInside(params.rootRealPath, realRoot)) {
      addDiagnostic({
        ...params,
        source: absoluteRoot,
        message: "bundle agent metadata root escapes the plugin root; entry ignored",
      });
      continue;
    }
    if (scannedRoots.some((scannedRoot) => isPathInside(scannedRoot, realRoot))) {
      continue;
    }

    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(absoluteRoot);
    } catch {
      addDiagnostic({
        diagnostics: params.diagnostics,
        pluginId: params.pluginId,
        source: absoluteRoot,
        message: "declared bundle agent metadata root could not be inspected; entry ignored",
      });
      continue;
    }
    if (stat.isFile()) {
      if (absoluteRoot.toLowerCase().endsWith(".md")) {
        const relativePath = normalizeRelativePath(path.relative(params.rootDir, absoluteRoot));
        files.set(relativePath, {
          relativePath,
          identityPath: path.basename(relativePath),
        });
      }
      continue;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      continue;
    }
    if (remainingEntries <= 0) {
      addDiagnostic({
        ...params,
        source: absoluteRoot,
        message: "bundle agent metadata scan limit reached; remaining entries ignored",
      });
      break;
    }
    scannedRoots.push(realRoot);
    const scan = walkDirectorySync(absoluteRoot, {
      maxDepth: MAX_AGENT_DEPTH,
      maxEntries: remainingEntries,
      symlinks: "skip",
      include: (entry) => entry.kind === "file" && entry.name.toLowerCase().endsWith(".md"),
    });
    for (const entry of scan.entries) {
      const relativePath = normalizeRelativePath(path.relative(params.rootDir, entry.path));
      if (!files.has(relativePath)) {
        files.set(relativePath, {
          relativePath,
          identityPath: normalizeRelativePath(path.relative(absoluteRoot, entry.path)),
        });
      }
    }
    remainingEntries -= scan.scannedEntryCount;
    if (scan.truncated) {
      addDiagnostic({
        ...params,
        source: absoluteRoot,
        message: "bundle agent metadata scan limit reached; remaining entries ignored",
      });
      break;
    }
    for (const failedDir of scan.failedDirs ?? []) {
      addDiagnostic({
        ...params,
        source: failedDir.path,
        message: "bundle agent metadata directory could not be read; entry ignored",
      });
    }
  }

  const ordered = [...files.values()].toSorted((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
  if (ordered.length > MAX_AGENT_FILES) {
    addDiagnostic({
      ...params,
      source: params.rootDir,
      message: "bundle agent metadata file limit reached; remaining files ignored",
    });
  }
  return ordered.slice(0, MAX_AGENT_FILES);
}

function readAgentFile(params: {
  rootDir: string;
  rootRealPath: string;
  relativePath: string;
  rejectHardlinks: boolean;
}): { raw: string; size: number } | undefined {
  const opened = openRootFileSync({
    absolutePath: path.join(params.rootDir, params.relativePath),
    rootPath: params.rootDir,
    rootRealPath: params.rootRealPath,
    boundaryLabel: "plugin root",
    maxBytes: MAX_AGENT_FILE_BYTES,
    rejectHardlinks: params.rejectHardlinks,
  });
  if (!opened.ok) {
    return undefined;
  }
  try {
    const buffer = readFileDescriptorBoundedSync(opened.fd, MAX_AGENT_FILE_BYTES);
    return {
      raw: buffer.toString("utf8"),
      size: buffer.byteLength,
    };
  } catch {
    return undefined;
  } finally {
    try {
      fs.closeSync(opened.fd);
    } catch {
      // Closing a metadata-only descriptor must not make bundle discovery fatal.
    }
  }
}

function parseListField(params: {
  field: string;
  value: string | undefined;
  structured: boolean;
  unsupported: Map<string, string>;
}): string[] | undefined {
  if (params.value === undefined) {
    return undefined;
  }
  let input: unknown = params.value;
  if (params.structured) {
    try {
      input = JSON.parse(params.value);
    } catch {
      params.unsupported.set(params.field, "expected a list of strings; field ignored");
      return undefined;
    }
    if (!Array.isArray(input) || input.some((entry) => typeof entry !== "string")) {
      params.unsupported.set(params.field, "expected a list of strings; field ignored");
      return undefined;
    }
  }
  return normalizeStringList(input);
}

function parseScalar(
  field: string,
  value: string | undefined,
  structured: boolean,
  unsupported: Map<string, string>,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (structured) {
    unsupported.set(field, "expected a scalar value; field ignored");
    return undefined;
  }
  return normalizeOptionalString(value);
}

function parseBoolean(
  field: string,
  value: string | undefined,
  unsupported: Map<string, string>,
): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = parseBooleanValue(value);
  if (parsed === undefined) {
    unsupported.set(field, "expected a boolean value; field ignored");
  }
  return parsed;
}

function buildUnsupportedFields(params: {
  frontmatter: Record<string, string>;
  sourceFormat: BundleAgentTemplate["sourceFormat"];
  invalid: ReadonlyMap<string, string>;
}): BundleAgentUnsupportedField[] | undefined {
  const unsupported = Object.keys(params.frontmatter)
    .filter(
      (field) =>
        !COMMON_FIELDS.has(field) &&
        !(params.sourceFormat === "cursor" && CURSOR_FIELDS.has(field)),
    )
    .map((field) => ({ field, reason: "not mapped to OpenClaw runtime policy" }));
  for (const [field, reason] of params.invalid) {
    unsupported.push({ field, reason });
  }
  const ordered = unsupported.toSorted((left, right) => left.field.localeCompare(right.field));
  return ordered.length > 0 ? ordered : undefined;
}

function parseAgentTemplate(params: {
  raw: string;
  relativePath: string;
  identityPath: string;
  sourceFormat: BundleAgentTemplate["sourceFormat"];
  pluginId: string;
  diagnostics: PluginDiagnostic[];
}): BundleAgentTemplate | undefined {
  const parsed = parseFrontmatterBlockResult(params.raw);
  if (parsed.issues.length > 0) {
    const issue = parsed.issues[0];
    addDiagnostic({
      diagnostics: params.diagnostics,
      pluginId: params.pluginId,
      source: params.relativePath,
      message: `bundle agent metadata has invalid frontmatter (${issue?.code}: ${issue?.message}); entry ignored`,
    });
    return undefined;
  }
  const name = normalizeOptionalString(parsed.frontmatter.name);
  const description = normalizeOptionalString(parsed.frontmatter.description);
  const structuredFields = new Set(parsed.structuredFields);
  const body = stripFrontmatterBlock(params.raw);
  const rejectMissingRequired = (field: string): undefined => {
    addDiagnostic({
      diagnostics: params.diagnostics,
      pluginId: params.pluginId,
      source: params.relativePath,
      message: `bundle agent metadata is missing required ${field}; entry ignored`,
    });
    return undefined;
  };
  if (!name || structuredFields.has("name")) {
    return rejectMissingRequired("scalar name");
  }
  if (params.sourceFormat === "claude" && !/^[a-z]+(?:-[a-z]+)*$/u.test(name)) {
    addDiagnostic({
      diagnostics: params.diagnostics,
      pluginId: params.pluginId,
      source: params.relativePath,
      message:
        "bundle agent metadata has an invalid Claude agent name (expected lowercase letters and hyphens); entry ignored",
    });
    return undefined;
  }
  if (!description || structuredFields.has("description")) {
    return rejectMissingRequired("scalar description");
  }
  if (!body) {
    return rejectMissingRequired("prompt body");
  }

  const invalid = new Map<string, string>();
  const model = parseScalar(
    "model",
    parsed.frontmatter.model,
    structuredFields.has("model"),
    invalid,
  );
  const effort = parseScalar(
    "effort",
    parsed.frontmatter.effort,
    structuredFields.has("effort"),
    invalid,
  );
  const memory = parseScalar(
    "memory",
    parsed.frontmatter.memory,
    structuredFields.has("memory"),
    invalid,
  );
  const isolation = parseScalar(
    "isolation",
    parsed.frontmatter.isolation,
    structuredFields.has("isolation"),
    invalid,
  );
  const maxTurnsRaw = parseScalar(
    "maxTurns",
    parsed.frontmatter.maxTurns,
    structuredFields.has("maxTurns"),
    invalid,
  );
  const maxTurns =
    maxTurnsRaw === undefined ? undefined : asPositiveSafeInteger(Number(maxTurnsRaw));
  if (maxTurnsRaw !== undefined && maxTurns === undefined) {
    invalid.set("maxTurns", "expected a positive integer; field ignored");
  }

  const standardBackground = parseBoolean("background", parsed.frontmatter.background, invalid);
  const cursorBackground =
    params.sourceFormat === "cursor"
      ? parseBoolean("is_background", parsed.frontmatter.is_background, invalid)
      : undefined;
  const standardReadOnly = parseBoolean("readOnly", parsed.frontmatter.readOnly, invalid);
  const cursorReadOnly =
    params.sourceFormat === "cursor"
      ? parseBoolean("readonly", parsed.frontmatter.readonly, invalid)
      : undefined;
  const background = cursorBackground ?? standardBackground;
  const readOnly = cursorReadOnly ?? standardReadOnly;
  const tools = parseListField({
    field: "tools",
    value: parsed.frontmatter.tools,
    structured: structuredFields.has("tools"),
    unsupported: invalid,
  });
  const disallowedTools = parseListField({
    field: "disallowedTools",
    value: parsed.frontmatter.disallowedTools,
    structured: structuredFields.has("disallowedTools"),
    unsupported: invalid,
  });
  const skills = parseListField({
    field: "skills",
    value: parsed.frontmatter.skills,
    structured: structuredFields.has("skills"),
    unsupported: invalid,
  });
  const unsupportedFields = buildUnsupportedFields({
    frontmatter: parsed.frontmatter,
    sourceFormat: params.sourceFormat,
    invalid,
  });
  return {
    id: [
      params.pluginId,
      ...params.identityPath.replace(/\.md$/iu, "").split("/").filter(Boolean),
    ].join(":"),
    pluginId: params.pluginId,
    sourceFormat: params.sourceFormat,
    name,
    description,
    prompt: {
      kind: "file",
      path: params.relativePath,
      contentDigest: sha256Hex(body),
    },
    sourceFilePath: params.relativePath,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(disallowedTools !== undefined ? { disallowedTools } : {}),
    ...(skills !== undefined ? { skills } : {}),
    ...(memory ? { memory } : {}),
    ...(background !== undefined ? { background } : {}),
    ...(isolation ? { isolation } : {}),
    ...(readOnly !== undefined ? { readOnly } : {}),
    ...(unsupportedFields ? { unsupportedFields } : {}),
  };
}

/** Loads bounded metadata records only; prompt bodies never leave this control-plane function. */
export function loadBundleAgentTemplates(params: {
  rootDir: string;
  agentRoots: readonly string[];
  sourceFormat: BundleAgentTemplate["sourceFormat"];
  pluginId: string;
  rejectHardlinks: boolean;
}): BundleAgentTemplateLoadResult {
  const rootDir = path.resolve(params.rootDir);
  const rootRealPath = safeRealpathSync(rootDir);
  const diagnostics: PluginDiagnostic[] = [];
  if (!rootRealPath) {
    addDiagnostic({
      diagnostics,
      pluginId: params.pluginId,
      source: rootDir,
      message: "bundle agent metadata plugin root could not be inspected",
    });
    return { agentTemplates: [], diagnostics };
  }

  const templates: BundleAgentTemplate[] = [];
  let totalBytes = 0;
  for (const agentFile of listAgentFiles({
    rootDir,
    rootRealPath,
    agentRoots: params.agentRoots,
    pluginId: params.pluginId,
    diagnostics,
  })) {
    const file = readAgentFile({
      rootDir,
      rootRealPath,
      relativePath: agentFile.relativePath,
      rejectHardlinks: params.rejectHardlinks,
    });
    if (!file) {
      addDiagnostic({
        diagnostics,
        pluginId: params.pluginId,
        source: agentFile.relativePath,
        message: "bundle agent metadata file exceeds the size limit or is unsafe; entry ignored",
      });
      continue;
    }
    totalBytes += file.size;
    if (totalBytes > MAX_AGENT_TOTAL_BYTES) {
      addDiagnostic({
        diagnostics,
        pluginId: params.pluginId,
        source: agentFile.relativePath,
        message: "bundle agent metadata aggregate size limit reached; remaining files ignored",
      });
      break;
    }
    const template = parseAgentTemplate({
      raw: file.raw,
      relativePath: agentFile.relativePath,
      identityPath: agentFile.identityPath,
      sourceFormat: params.sourceFormat,
      pluginId: params.pluginId,
      diagnostics,
    });
    if (template) {
      templates.push(template);
    }
  }

  return {
    agentTemplates: templates,
    diagnostics,
  };
}

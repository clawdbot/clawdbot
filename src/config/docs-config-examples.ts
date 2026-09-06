import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import JSON5 from "json5";
import {
  loadPluginMetadataSnapshot,
  type PluginMetadataSnapshot,
} from "../plugins/plugin-metadata-snapshot.js";
import { resolveRepoBundledPluginEnv } from "./repo-bundled-plugin-env.js";
import { validateConfigObjectRaw, validateConfigObjectRawWithPlugins } from "./validation.js";
import { OpenClawSchemaShape } from "./zod-schema.root-shape.js";

type DocsConfigFinding = {
  filePath: string;
  fenceStartLine: number;
  issuePath: string;
  message: string;
};

type DocsConfigStats = {
  filesScanned: number;
  fencesSeen: number;
  candidatesValidated: number;
  fencesSkipped: number;
  skippedUnsupportedLanguage: number;
  skippedOptOut: number;
  skippedParseFailure: number;
  skippedNonObject: number;
  skippedFragment: number;
};

type DocsConfigAudit = {
  findings: DocsConfigFinding[];
  stats: DocsConfigStats;
};

type MarkdownFence = {
  info: string;
  body: string;
  startLine: number;
};

type DocsConfigValidationContext = {
  env: NodeJS.ProcessEnv;
  pluginMetadataSnapshot: Pick<PluginMetadataSnapshot, "manifestRegistry">;
};

const ROOT_CONFIG_KEYS = new Set(Object.keys(OpenClawSchemaShape));

function emptyStats(filesScanned = 0): DocsConfigStats {
  return {
    filesScanned,
    fencesSeen: 0,
    candidatesValidated: 0,
    fencesSkipped: 0,
    skippedUnsupportedLanguage: 0,
    skippedOptOut: 0,
    skippedParseFailure: 0,
    skippedNonObject: 0,
    skippedFragment: 0,
  };
}

function extractMarkdownFences(markdown: string): MarkdownFence[] {
  const lines = markdown.split(/\r?\n/u);
  const fences: MarkdownFence[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    // MDX component-nested fences (Accordion/Tabs) are commonly indented 4+ spaces;
    // CommonMark's indented-code rule does not apply inside these docs components.
    const opening = lines[index]?.match(/^([ \t]*)(`{3,}|~{3,})(.*)$/u);
    if (!opening) {
      continue;
    }
    const indent = opening[1];
    const marker = opening[2];
    if (indent === undefined || !marker) {
      continue;
    }
    const body: string[] = [];
    const startLine = index + 1;
    const closing = new RegExp(`^[ \\t]*${marker.charAt(0)}{${marker.length},}[ \\t]*$`, "u");
    index += 1;
    while (index < lines.length && !closing.test(lines[index] ?? "")) {
      body.push(lines[index] ?? "");
      index += 1;
    }
    fences.push({
      info: opening[3]?.trim() ?? "",
      body: body.join("\n"),
      startLine,
    });
  }
  return fences;
}

function isConfigFence(info: string): boolean {
  return /^(?:json5|json|jsonc)(?:\s|$)/iu.test(info);
}

function isUnrecognizedKeyMessage(message: string): boolean {
  return /(?:Unrecognized keys?|must not have additional properties):\s*"/iu.test(message);
}

function isWholeConfig(parsed: Record<string, unknown>): boolean {
  const topLevelKeys = Object.keys(parsed);
  const recognizedKeys = topLevelKeys.filter((key) => ROOT_CONFIG_KEYS.has(key));
  // Accepted tradeoff: equal config/non-config mixes and documents containing only
  // retired root keys look like fragments and are skipped.
  return recognizedKeys.length > topLevelKeys.length / 2;
}

function stripIncludeKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripIncludeKeys);
  }
  if (!isRecord(value)) {
    return value;
  }
  // src/config/includes.ts resolves these directives before schema validation.
  // Docs validation drops them recursively to mirror that pipeline boundary.
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, child]) =>
      key === "$include" ? [] : [[key, stripIncludeKeys(child)]],
    ),
  );
}

function createDocsConfigValidationContext(): DocsConfigValidationContext {
  const env = resolveRepoBundledPluginEnv(path.join(process.cwd(), "extensions"));
  return {
    env,
    pluginMetadataSnapshot: loadPluginMetadataSnapshot({
      config: {},
      env,
      preferPersisted: false,
      allowCurrent: false,
    }),
  };
}

function auditConfigMarkdown(
  params: { markdown: string; filePath: string },
  validationContext: DocsConfigValidationContext,
): DocsConfigAudit {
  const findings: DocsConfigFinding[] = [];
  const stats = emptyStats(1);

  for (const fence of extractMarkdownFences(params.markdown)) {
    stats.fencesSeen += 1;
    if (!isConfigFence(fence.info)) {
      stats.fencesSkipped += 1;
      stats.skippedUnsupportedLanguage += 1;
      continue;
    }
    if (/\bvalidate=false\b/iu.test(fence.info)) {
      stats.fencesSkipped += 1;
      stats.skippedOptOut += 1;
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON5.parse(fence.body);
    } catch {
      stats.fencesSkipped += 1;
      stats.skippedParseFailure += 1;
      continue;
    }
    if (!isRecord(parsed)) {
      stats.fencesSkipped += 1;
      stats.skippedNonObject += 1;
      continue;
    }
    if (!isWholeConfig(parsed)) {
      stats.fencesSkipped += 1;
      stats.skippedFragment += 1;
      continue;
    }

    const validationInput = stripIncludeKeys(parsed);
    // Keep these validators separate so ValidateConfigWithPluginsParams stays outside the
    // Plugin SDK declaration closure; changing it shifts every SDK module baseline hash.
    const results = [
      validateConfigObjectRaw(validationInput, { validateBundledChannels: true }),
      validateConfigObjectRawWithPlugins(validationInput, validationContext),
    ];
    stats.candidatesValidated += 1;
    // This gate catches retired keys only. Placeholder type errors and incomplete
    // illustrative values remain outside its contract.
    const seenIssues = new Set<string>();
    for (const result of results) {
      if (result.ok) {
        continue;
      }
      for (const issue of result.issues) {
        if (!isUnrecognizedKeyMessage(issue.message)) {
          continue;
        }
        const issueKey = JSON.stringify([issue.path, issue.message]);
        if (seenIssues.has(issueKey)) {
          continue;
        }
        seenIssues.add(issueKey);
        findings.push({
          filePath: params.filePath,
          fenceStartLine: fence.startLine,
          issuePath: issue.path,
          message: issue.message,
        });
      }
    }
  }

  return {
    findings: findings.toSorted(
      (left, right) =>
        left.filePath.localeCompare(right.filePath) ||
        left.fenceStartLine - right.fenceStartLine ||
        left.issuePath.localeCompare(right.issuePath),
    ),
    stats,
  };
}

// Keep this in sync with the generated-doc locale test in scripts/docs-link-audit.mts.
function isLocalizedDocPath(filePath: string): boolean {
  return /^\/?[a-z]{2}(?:-[A-Za-z]{2,8})+\//u.test(filePath);
}

function listDocsFiles(docsRoot: string): string[] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath);
      } else if (entry.isFile() && /\.mdx?$/iu.test(entry.name)) {
        files.push(entryPath);
      }
    }
  };
  walk(docsRoot);
  return files.toSorted((left, right) => left.localeCompare(right));
}

/** Audits English docs config examples against the current strict schema. */
export function auditDocsConfigExamples(params: { repoRoot: string }): DocsConfigAudit {
  const docsRoot = path.join(params.repoRoot, "docs");
  const findings: DocsConfigFinding[] = [];
  const stats = emptyStats();
  const validationContext = createDocsConfigValidationContext();

  for (const filePath of listDocsFiles(docsRoot)) {
    const docsRelativePath = path.relative(docsRoot, filePath).split(path.sep).join("/");
    if (isLocalizedDocPath(docsRelativePath)) {
      continue;
    }
    const repoRelativePath = path.posix.join("docs", docsRelativePath);
    const audit = auditConfigMarkdown(
      {
        markdown: fs.readFileSync(filePath, "utf8"),
        filePath: repoRelativePath,
      },
      validationContext,
    );
    findings.push(...audit.findings);
    for (const [key, value] of Object.entries(audit.stats)) {
      stats[key as keyof DocsConfigStats] += value;
    }
  }

  return { findings, stats };
}

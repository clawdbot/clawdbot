import path from "node:path";

function stripTomlComment(line: string): string {
  let quote: "'" | '"' | null = null;
  let escaping = false;
  for (let index = 0; index < line.length; index += 1) {
    const ch = line[index];
    if (escaping) {
      escaping = false;
      continue;
    }
    if (quote === '"' && ch === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "#") {
      return line.slice(0, index);
    }
  }
  return line;
}

function parseTomlString(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return undefined;
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return undefined;
}

function parseTomlDottedKey(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (const ch of value.trim()) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (quote === '"' && ch === "\\") {
      current += ch;
      escaping = true;
      continue;
    }
    if (quote) {
      current += ch;
      if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ".") {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) {
    parts.push(current.trim());
  }
  return parts.map((part) => parseTomlString(part) ?? part);
}

function parseProjectHeader(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]") || trimmed.startsWith("[[")) {
    return undefined;
  }
  const parts = parseTomlDottedKey(trimmed.slice(1, -1));
  return parts.length === 2 && parts[0] === "projects" ? parts[1] : undefined;
}

function parseTrustedInlineProjectEntries(value: string): string[] {
  const trusted: string[] = [];
  const entryPattern =
    /(?<key>"(?:\\.|[^"\\])*"|'[^']*'|[A-Za-z0-9_\-/.~:]+)\s*=\s*\{(?<body>[^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g;
  for (const match of value.matchAll(entryPattern)) {
    const key = match.groups?.key;
    const body = match.groups?.body;
    if (!key || !body || !/\btrust_level\s*=\s*["']trusted["']/.test(body)) {
      continue;
    }
    const projectPath = parseTomlString(key) ?? key.trim();
    if (projectPath) {
      trusted.push(projectPath);
    }
  }
  return trusted;
}

export function extractTrustedCodexProjectPaths(configToml: string): string[] {
  const trusted = new Set<string>();
  let currentProjectPath: string | undefined;
  let inProjectsTable = false;

  for (const rawLine of configToml.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) {
      continue;
    }
    if (line.startsWith("[")) {
      currentProjectPath = parseProjectHeader(line);
      inProjectsTable = line === "[projects]";
      continue;
    }

    if (currentProjectPath && /^trust_level\s*=\s*["']trusted["']\s*$/.test(line)) {
      trusted.add(currentProjectPath);
      continue;
    }

    const assignment =
      /^(?<key>"(?:\\.|[^"\\])*"|'[^']*'|[A-Za-z0-9_\-/.~:]+)\s*=\s*(?<value>.+)$/.exec(line);
    if (!assignment?.groups) {
      continue;
    }

    const key = parseTomlString(assignment.groups.key) ?? assignment.groups.key;
    const value = assignment.groups.value.trim();
    if (inProjectsTable && /^\{.*\}$/.test(value)) {
      if (/\btrust_level\s*=\s*["']trusted["']/.test(value) && key) {
        trusted.add(key);
      }
      continue;
    }
    if (key === "projects" || inProjectsTable) {
      for (const projectPath of parseTrustedInlineProjectEntries(value)) {
        trusted.add(projectPath);
      }
    }
  }

  return Array.from(trusted);
}

const INHERITED_TOP_LEVEL_CODEX_CONFIG_KEYS = new Set([
  "model",
  "model_provider",
  "model_reasoning_effort",
  "sandbox_mode",
]);

const INHERITED_MODEL_PROVIDER_CONFIG_KEYS = new Set([
  "name",
  "base_url",
  "wire_api",
  "env_key",
  "env_key_instructions",
  "requires_openai_auth",
  "request_max_retries",
  "stream_max_retries",
  "stream_idle_timeout_ms",
]);

function parseTableHeader(line: string): string[] | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]") || trimmed.startsWith("[[")) {
    return undefined;
  }
  return parseTomlDottedKey(trimmed.slice(1, -1));
}

function isInheritedModelProviderTable(parts: string[] | undefined): boolean {
  return parts?.[0] === "model_providers" && parts.length === 2;
}

function parseTopLevelAssignmentKey(line: string): string | undefined {
  const assignment = /^(?<key>[A-Za-z0-9_-]+)\s*=\s*(?<value>.+)$/.exec(line);
  return assignment?.groups?.key;
}

function extractInheritedCodexRuntimeConfig(configToml: string): string {
  const inheritedLines: string[] = [];
  let inAnyTable = false;
  let inInheritedTable = false;
  let pendingInheritedTableHeader = "";

  function flushInheritedTableHeader(): void {
    if (!pendingInheritedTableHeader) {
      return;
    }
    if (inheritedLines.length > 0 && inheritedLines[inheritedLines.length - 1] !== "") {
      inheritedLines.push("");
    }
    inheritedLines.push(pendingInheritedTableHeader);
    pendingInheritedTableHeader = "";
  }

  for (const rawLine of configToml.split(/\r?\n/)) {
    const trimmedLine = rawLine.trim();
    const semanticLine = stripTomlComment(rawLine).trim();

    if (trimmedLine.startsWith("[")) {
      const tableParts = parseTableHeader(trimmedLine);
      inAnyTable = true;
      inInheritedTable = isInheritedModelProviderTable(tableParts);
      if (inInheritedTable) {
        pendingInheritedTableHeader = rawLine.trimEnd();
      } else {
        pendingInheritedTableHeader = "";
      }
      continue;
    }

    if (inInheritedTable) {
      if (!semanticLine) {
        continue;
      }
      const key = parseTopLevelAssignmentKey(semanticLine);
      if (!key || !INHERITED_MODEL_PROVIDER_CONFIG_KEYS.has(key)) {
        continue;
      }
      flushInheritedTableHeader();
      inheritedLines.push(rawLine.trimEnd());
      continue;
    }

    if (inAnyTable) {
      continue;
    }

    const key = parseTopLevelAssignmentKey(semanticLine);
    if (!key) {
      continue;
    }
    if (!INHERITED_TOP_LEVEL_CODEX_CONFIG_KEYS.has(key)) {
      continue;
    }
    inheritedLines.push(rawLine.trimEnd());
  }

  while (inheritedLines.length > 0 && inheritedLines[inheritedLines.length - 1] === "") {
    inheritedLines.pop();
  }
  return inheritedLines.join("\n");
}

export function renderIsolatedCodexConfig(params: {
  sourceConfigToml?: string;
  projectPaths: string[];
}): string {
  const normalized = Array.from(
    new Set(
      params.projectPaths
        .map((projectPath) => projectPath.trim())
        .filter(Boolean)
        .map((projectPath) => path.resolve(projectPath)),
    ),
  ).toSorted((left, right) => left.localeCompare(right));

  const inheritedConfig = params.sourceConfigToml
    ? extractInheritedCodexRuntimeConfig(params.sourceConfigToml)
    : "";

  return [
    "# Generated by OpenClaw for Codex ACP sessions.",
    inheritedConfig,
    ...normalized.flatMap((projectPath) => [
      "",
      `[projects.${JSON.stringify(projectPath)}]`,
      'trust_level = "trusted"',
    ]),
    "",
  ]
    .filter((line, index, lines) => !(line === "" && lines[index - 1] === ""))
    .join("\n");
}

export function renderIsolatedCodexProjectTrustConfig(projectPaths: string[]): string {
  return renderIsolatedCodexConfig({ projectPaths });
}

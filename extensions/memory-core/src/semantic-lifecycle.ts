// Memory Core plugin module implements governed semantic-memory lifecycle filtering.
import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-runtime-files";

export type MemoryLifecycleMode = "auto" | "current" | "all";

type GovernedLifecycle = "active" | "review_due" | "disputed" | "superseded" | "historical";

const CURRENT_INTENT_RE = /\b(current|currently|latest|now|today|presently)\b/iu;
const GOVERNED_SCHEMA = "openclaw.semantic_memory.v2";
const FRONTMATTER_READ_LINES = 40;

function parseGovernedLifecycle(text: string): GovernedLifecycle | undefined {
  const lines = text.split(/\r?\n/u);
  if (lines[0]?.trim() !== "---") {
    return undefined;
  }
  const end = lines.indexOf("---", 1);
  if (end < 0) {
    return undefined;
  }
  let schema: string | undefined;
  let status: string | undefined;
  for (const line of lines.slice(1, end)) {
    const separator = line.indexOf(":");
    if (separator < 1) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    const value = line
      .slice(separator + 1)
      .trim()
      .replace(/^(["'])(.*)\1$/u, "$2");
    if (key === "schema_version") {
      schema = value;
    } else if (key === "status") {
      status = value;
    }
  }
  if (schema !== GOVERNED_SCHEMA) {
    return undefined;
  }
  return status === "active" ||
    status === "review_due" ||
    status === "disputed" ||
    status === "superseded" ||
    status === "historical"
    ? status
    : undefined;
}

export function shouldApplyCurrentLifecycle(params: {
  query: string;
  mode?: MemoryLifecycleMode;
}): boolean {
  if (params.mode === "all") {
    return false;
  }
  return params.mode === "current" || CURRENT_INTENT_RE.test(params.query);
}

export async function filterCurrentSemanticLifecycle(params: {
  query: string;
  mode?: MemoryLifecycleMode;
  hits: MemorySearchResult[];
  readFile: (params: {
    relPath: string;
    from?: number;
    lines?: number;
  }) => Promise<{ text: string }>;
}): Promise<MemorySearchResult[]> {
  if (!shouldApplyCurrentLifecycle({ query: params.query, mode: params.mode })) {
    return params.hits;
  }

  const lifecycleByPath = new Map<string, GovernedLifecycle | undefined>();
  await Promise.all(
    Array.from(
      new Set(params.hits.filter((hit) => hit.source === "memory").map((hit) => hit.path)),
    ).map(async (path) => {
      try {
        // Lifecycle reads are opt-in/intent-gated and bounded to frontmatter. The manager
        // owns path resolution for both builtin and QMD backends.
        const result = await params.readFile({
          relPath: path,
          from: 1,
          lines: FRONTMATTER_READ_LINES,
        });
        lifecycleByPath.set(path, parseGovernedLifecycle(result.text));
      } catch {
        // A lifecycle read must not hide an otherwise valid ungoverned memory hit.
        lifecycleByPath.set(path, undefined);
      }
    }),
  );

  const rank = (hit: MemorySearchResult): number => {
    if (hit.source !== "memory") {
      return 2;
    }
    const lifecycle = lifecycleByPath.get(hit.path);
    if (lifecycle === "active") {
      return 0;
    }
    if (lifecycle === "review_due" || lifecycle === "disputed") {
      return 1;
    }
    return 2;
  };

  return params.hits
    .filter((hit) => {
      const lifecycle = hit.source === "memory" ? lifecycleByPath.get(hit.path) : undefined;
      return lifecycle !== "superseded" && lifecycle !== "historical";
    })
    .map((hit, index) => ({ hit, index }))
    .toSorted((left, right) => rank(left.hit) - rank(right.hit) || left.index - right.index)
    .map(({ hit }) => hit);
}

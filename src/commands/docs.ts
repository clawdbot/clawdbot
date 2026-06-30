// Implements docs link/search output for `openclaw docs`.
import { readResponseWithLimit } from "@openclaw/media-core/read-response-with-limit";
import { formatDocsLink } from "../../packages/terminal-core/src/links.js";
import { isRich, theme } from "../../packages/terminal-core/src/theme.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { RuntimeEnv } from "../runtime.js";

const SEARCH_API = "https://docs.openclaw.ai/api/search";
const SEARCH_TIMEOUT_MS = 30_000;
const DOCS_SEARCH_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;

type DocResult = {
  title: string;
  link: string;
  snippet?: string;
};

type DocsSearchResponse = {
  results?: unknown;
};

function escapeMarkdown(text: string): string {
  return text.replace(/[()[\]]/g, "\\$&");
}

function buildMarkdown(query: string, results: DocResult[]): string {
  const lines: string[] = [`# Docs search: ${escapeMarkdown(query)}`, ""];
  if (results.length === 0) {
    lines.push("_No results._");
    return lines.join("\n");
  }
  for (const item of results) {
    const title = escapeMarkdown(item.title);
    const snippet = item.snippet ? escapeMarkdown(item.snippet) : "";
    const suffix = snippet ? ` - ${snippet}` : "";
    lines.push(`- [${title}](${item.link})${suffix}`);
  }
  return lines.join("\n");
}

function formatLinkLabel(link: string): string {
  return link.replace(/^https?:\/\//i, "");
}

function renderRichResults(query: string, results: DocResult[], runtime: RuntimeEnv) {
  runtime.log(`${theme.heading("Docs search:")} ${theme.info(query)}`);
  if (results.length === 0) {
    runtime.log(theme.muted("No results."));
    return;
  }
  for (const item of results) {
    const linkLabel = formatLinkLabel(item.link);
    const link = formatDocsLink(item.link, linkLabel);
    runtime.log(
      `${theme.muted("-")} ${theme.command(item.title)} ${theme.muted("(")}${link}${theme.muted(")")}`,
    );
    if (item.snippet) {
      runtime.log(`  ${theme.muted(item.snippet)}`);
    }
  }
}

async function renderMarkdown(markdown: string, runtime: RuntimeEnv) {
  runtime.log(markdown.trimEnd());
}

async function fetchDocsSearch(query: string): Promise<DocResult[]> {
  const url = new URL(SEARCH_API);
  url.searchParams.set("q", query);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const bytes = await readResponseWithLimit(response, DOCS_SEARCH_RESPONSE_MAX_BYTES, {
      onOverflow: ({ maxBytes }) => new Error(`Docs search response exceeds ${maxBytes} bytes`),
    });
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as DocsSearchResponse;
    return parseDocsSearchResults(payload.results);
  } finally {
    clearTimeout(timeout);
  }
}

function parseDocsSearchResults(raw: unknown): DocResult[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const results: DocResult[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const entry = item as Record<string, unknown>;
    if (typeof entry.title !== "string" || typeof entry.link !== "string") {
      continue;
    }
    results.push({
      title: entry.title,
      link: entry.link,
      snippet:
        typeof entry.snippet === "string" && entry.snippet.trim() ? entry.snippet : undefined,
    });
  }
  return results;
}

/** Search hosted docs, or print the docs homepage when no query is provided. */
export async function docsSearchCommand(queryParts: string[], runtime: RuntimeEnv) {
  const query = queryParts.join(" ").trim();
  if (!query) {
    const docs = formatDocsLink("/", "docs.openclaw.ai");
    if (isRich()) {
      runtime.log(`${theme.muted("Docs:")} ${docs}`);
      runtime.log(`${theme.muted("Search:")} ${formatCliCommand('openclaw docs "your query"')}`);
    } else {
      runtime.log("Docs: https://docs.openclaw.ai/");
      runtime.log(`Search: ${formatCliCommand('openclaw docs "your query"')}`);
    }
    return;
  }

  let results: DocResult[];
  try {
    results = await fetchDocsSearch(query);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtime.error(`Docs search failed: ${message}`);
    runtime.exit(1);
    return;
  }

  if (isRich()) {
    renderRichResults(query, results, runtime);
    return;
  }
  const markdown = buildMarkdown(query, results);
  await renderMarkdown(markdown, runtime);
}

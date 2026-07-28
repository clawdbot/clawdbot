// Workshop frontmatter helpers parse generated skill metadata before saving drafts.
import { extractFrontmatterBlock } from "../../../packages/markdown-core/src/frontmatter.js";
import { parseFrontmatter } from "../loading/frontmatter.js";

type ProposalFrontmatter = {
  name: string;
  description: string;
};

// JSON strings are valid YAML scalars and avoid ad hoc escaping.
function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

/** Renders proposal markdown while preserving allowed original frontmatter fields. */
export function renderProposalMarkdown(params: {
  name: string;
  description: string;
  content: string;
  fallbackFrontmatterContent?: string;
  version?: string;
  date?: string;
}): string {
  const originalFrontmatter =
    extractFrontmatterBlock(params.content)?.block ??
    (params.fallbackFrontmatterContent
      ? extractFrontmatterBlock(params.fallbackFrontmatterContent)?.block
      : undefined);
  const keptFrontmatter = originalFrontmatter
    ? filterFrontmatterBlock(originalFrontmatter, [
        "name",
        "description",
        "status",
        "version",
        "date",
      ])
    : "";
  const extracted = extractFrontmatterBlock(params.content);
  const body = (extracted?.body ?? normalizeNewlines(params.content)).trimStart();
  const version = params.version ?? "v1";
  const date = params.date ?? new Date().toISOString();
  const frontmatter = [
    `name: ${yamlScalar(params.name)}`,
    `description: ${yamlScalar(params.description)}`,
    "status: proposal",
    `version: ${yamlScalar(version)}`,
    `date: ${yamlScalar(date)}`,
    keptFrontmatter,
  ]
    .filter(Boolean)
    .join("\n");
  const markdown = `---\n${frontmatter}\n---\n\n${body}`;
  return markdown.endsWith("\n") ? markdown : `${markdown}\n`;
}

export function readProposalFrontmatter(content: string): ProposalFrontmatter | null {
  const frontmatter = parseFrontmatter(content);
  const name = frontmatter.name?.trim();
  const description = frontmatter.description?.trim();
  const status = frontmatter.status?.trim().toLowerCase();
  if (!name || !description || status !== "proposal") {
    return null;
  }
  return { name, description };
}

export function stripProposalFrontmatterForSkill(content: string): string {
  const normalized = normalizeNewlines(content);
  const extracted = extractFrontmatterBlock(normalized);
  if (!extracted) {
    return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
  }

  const body = extracted.body.replace(/^\n+/, "");
  const keptLines = extracted.block
    .split("\n")
    .filter((line) => {
      const key = line.match(/^([\w-]+):/)?.[1]?.toLowerCase();
      return key !== "status" && key !== "version" && key !== "date";
    })
    .join("\n")
    .trim();

  const result = keptLines ? `---\n${keptLines}\n---\n\n${body}` : body;
  return result.endsWith("\n") ? result : `${result}\n`;
}

function filterFrontmatterBlock(block: string, keysToDrop: readonly string[]): string {
  const drop = new Set(keysToDrop.map((key) => key.toLowerCase()));
  const lines = block.split("\n");
  const kept: string[] = [];
  let dropping = false;

  for (const line of lines) {
    const key = line.match(/^([\w-]+):/)?.[1]?.toLowerCase();
    if (key) {
      dropping = drop.has(key);
    }
    if (!dropping) {
      kept.push(line);
    }
  }

  return kept.join("\n").trim();
}

function normalizeNewlines(content: string): string {
  return content
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

// Memory Wiki plugin module implements vault behavior.
import fs from "node:fs/promises";
import path from "node:path";
import {
  replaceManagedMarkdownBlock,
  withTrailingNewline,
} from "openclaw/plugin-sdk/memory-host-markdown";
import { FsSafeError, pathExists, root as fsRoot } from "openclaw/plugin-sdk/security-runtime";
import {
  activateMemoryWikiCompiledCacheOwner,
  invalidateMemoryWikiCompiledCache,
  reconcileMemoryWikiCompiledCacheOwner,
} from "./compiled-cache.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import {
  appendMemoryWikiLog,
  ensureMemoryWikiVaultGeneration,
  loadMemoryWikiValidatedVaultIdentity,
} from "./log.js";
import { WIKI_RAW_SOURCE_MARKER } from "./markdown.js";
import { resolveMemoryWikiTimestamp } from "./time.js";

const WIKI_VAULT_DIRECTORIES = [
  "entities",
  "concepts",
  "syntheses",
  "sources",
  "reports",
  "_attachments",
  "_views",
  ".openclaw-wiki",
] as const;

const WIKI_VAULT_SCAFFOLD = ["AGENTS.md", "WIKI.md", "index.md", ".openclaw-wiki/log.jsonl"];

type InitializeMemoryWikiVaultResult = {
  rootDir: string;
  created: boolean;
  createdDirectories: string[];
  createdFiles: string[];
};

function buildIndexMarkdown(): string {
  return withTrailingNewline(
    replaceManagedMarkdownBlock({
      original: "# Wiki Index\n",
      heading: "## Generated",
      startMarker: "<!-- openclaw:wiki:index:start -->",
      endMarker: "<!-- openclaw:wiki:index:end -->",
      body: "- No compiled pages yet.",
    }),
  );
}

function buildAgentsMarkdown(): string {
  return withTrailingNewline(`\
# Memory Wiki Agent Guide

- Treat generated blocks as plugin-owned.
- Preserve human notes outside managed markers.
- Prefer source-backed claims over wiki-to-wiki citation loops.
- Prefer structured \`claims\` with evidence over burying key beliefs only in prose.
- Use the wiki tools for machine reads; Markdown pages are the human view.
`);
}

function buildWikiOverviewMarkdown(config: ResolvedMemoryWikiConfig): string {
  return withTrailingNewline(`\
# Memory Wiki

This vault is maintained by the OpenClaw memory-wiki plugin.

- Vault mode: \`${config.vaultMode}\`
- Render mode: \`${config.vault.renderMode}\`
- Search corpus default: \`${config.search.corpus}\`

## Architecture
- Raw sources remain the evidence layer.
- To keep unmanaged raw Markdown in \`sources/\`, add \`${WIKI_RAW_SOURCE_MARKER}\` near the top of the page.
- Wiki pages are the human-readable synthesis layer.
- Compiled query and prompt snapshots live in OpenClaw plugin state, not vault files.

## Notes
<!-- openclaw:human:start -->
<!-- openclaw:human:end -->
`);
}

async function writeFileIfMissing(
  rootDir: string,
  relativePath: string,
  content: string,
  createdFiles: string[],
): Promise<void> {
  const root = await fsRoot(rootDir);
  try {
    await root.create(relativePath, content);
  } catch (err) {
    if (err instanceof FsSafeError && err.code === "already-exists") {
      return;
    }
    throw err;
  }
  createdFiles.push(path.join(rootDir, relativePath));
}

export async function initializeMemoryWikiVault(
  config: ResolvedMemoryWikiConfig,
  options?: { nowMs?: number },
): Promise<InitializeMemoryWikiVaultResult> {
  const rootDir = config.vault.path;
  const createdDirectories: string[] = [];
  const createdFiles: string[] = [];
  const rootCreated = !(await pathExists(rootDir));

  if (rootCreated) {
    createdDirectories.push(rootDir);
  }
  await fs.mkdir(rootDir, { recursive: true });
  const hadVaultScaffold = (
    await Promise.all(
      WIKI_VAULT_SCAFFOLD.map((relativePath) => pathExists(path.join(rootDir, relativePath))),
    )
  ).every(Boolean);
  if (!hadVaultScaffold) {
    // Missing scaffold means a new/recreated vault, even when its parent directory survived.
    await invalidateMemoryWikiCompiledCache(config);
  }

  for (const relativeDir of WIKI_VAULT_DIRECTORIES) {
    const fullPath = path.join(rootDir, relativeDir);
    if (!(await pathExists(fullPath))) {
      createdDirectories.push(fullPath);
    }
    await fs.mkdir(fullPath, { recursive: true });
  }

  await writeFileIfMissing(rootDir, "AGENTS.md", buildAgentsMarkdown(), createdFiles);
  await writeFileIfMissing(rootDir, "WIKI.md", buildWikiOverviewMarkdown(config), createdFiles);
  await writeFileIfMissing(rootDir, "index.md", buildIndexMarkdown(), createdFiles);
  await writeFileIfMissing(
    rootDir,
    "inbox.md",
    withTrailingNewline("# Inbox\n\nDrop raw ideas, questions, and source links here.\n"),
    createdFiles,
  );
  await writeFileIfMissing(rootDir, ".openclaw-wiki/log.jsonl", "", createdFiles);

  if (createdDirectories.length > 0 || createdFiles.length > 0) {
    await appendMemoryWikiLog(rootDir, {
      type: "init",
      timestamp: resolveMemoryWikiTimestamp(options?.nowMs),
      details: {
        createdDirectories: createdDirectories.map((dir) => path.relative(rootDir, dir) || "."),
        createdFiles: createdFiles.map((file) => path.relative(rootDir, file)),
      },
    });
  }
  const vaultGeneration = await ensureMemoryWikiVaultGeneration(rootDir);
  const identity = await loadMemoryWikiValidatedVaultIdentity(rootDir);
  activateMemoryWikiCompiledCacheOwner(
    config,
    vaultGeneration,
    identity.compiledCachePublicationId,
  );
  await reconcileMemoryWikiCompiledCacheOwner(config, () =>
    loadMemoryWikiValidatedVaultIdentity(rootDir),
  );

  return {
    rootDir,
    created: createdDirectories.length > 0 || createdFiles.length > 0,
    createdDirectories,
    createdFiles,
  };
}

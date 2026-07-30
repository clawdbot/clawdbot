// Memory Wiki plugin module implements source page shared behavior.
import fs from "node:fs/promises";
import { timestampMsToIsoString } from "openclaw/plugin-sdk/number-runtime";
import { FsSafeError, root as fsRoot } from "openclaw/plugin-sdk/security-runtime";
import { preserveHumanNotesBlock } from "./markdown.js";
import {
  setImportedSourceEntry,
  shouldSkipImportedSourceWrite,
  type MemoryWikiImportedSourceGroup,
} from "./source-sync-state.js";
import { writeGuardedVaultPage } from "./vault-page-write.js";

type ImportedSourceState = Parameters<typeof shouldSkipImportedSourceWrite>[0]["state"];
type VaultRoot = Awaited<ReturnType<typeof fsRoot>>;

function isUnreadableImportedSourcePage(error: unknown): boolean {
  return error instanceof FsSafeError && (error.code === "not-file" || error.code === "hardlink");
}

async function readExistingImportedSourcePage(vault: VaultRoot, pagePath: string): Promise<string> {
  let readError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await vault.readText(pagePath);
    } catch (error) {
      readError = error;
    }
  }
  if (isUnreadableImportedSourcePage(readError)) {
    return "";
  }
  throw readError;
}

export async function writeImportedSourcePage(params: {
  vaultRoot: string;
  syncKey: string;
  sourcePath: string;
  sourceContent?: string;
  sourceUpdatedAtMs: number;
  sourceSize: number;
  renderFingerprint: string;
  pagePath: string;
  group: MemoryWikiImportedSourceGroup;
  state: ImportedSourceState;
  buildRendered: (raw: string, updatedAt: string) => string;
}): Promise<{ pagePath: string; changed: boolean; created: boolean }> {
  const shouldSkip = await shouldSkipImportedSourceWrite({
    vaultRoot: params.vaultRoot,
    syncKey: params.syncKey,
    expectedPagePath: params.pagePath,
    expectedSourcePath: params.sourcePath,
    sourceUpdatedAtMs: params.sourceUpdatedAtMs,
    sourceSize: params.sourceSize,
    renderFingerprint: params.renderFingerprint,
    state: params.state,
  });
  if (shouldSkip) {
    return { pagePath: params.pagePath, changed: false, created: false };
  }

  const vault = await fsRoot(params.vaultRoot);
  const pageStat = await vault.stat(params.pagePath).catch((error: unknown) => {
    if (
      error instanceof FsSafeError &&
      (error.code === "not-found" || error.code === "path-alias")
    ) {
      return null;
    }
    throw error;
  });
  const created = !pageStat;
  const updatedAt = timestampMsToIsoString(params.sourceUpdatedAtMs) ?? new Date().toISOString();
  const raw = params.sourceContent ?? (await fs.readFile(params.sourcePath, "utf8"));
  const rendered = params.buildRendered(raw, updatedAt);
  const existing = pageStat ? await readExistingImportedSourcePage(vault, params.pagePath) : "";
  const nextRendered = existing ? preserveHumanNotesBlock(rendered, existing) : rendered;
  if (existing !== nextRendered) {
    await writeGuardedVaultPage({
      vault,
      pagePath: params.pagePath,
      content: nextRendered,
      pageStat,
      pageLabel: "imported source page",
    });
  }

  setImportedSourceEntry({
    syncKey: params.syncKey,
    state: params.state,
    entry: {
      group: params.group,
      pagePath: params.pagePath,
      sourcePath: params.sourcePath,
      sourceUpdatedAtMs: params.sourceUpdatedAtMs,
      sourceSize: params.sourceSize,
      renderFingerprint: params.renderFingerprint,
    },
  });
  return { pagePath: params.pagePath, changed: existing !== nextRendered, created };
}

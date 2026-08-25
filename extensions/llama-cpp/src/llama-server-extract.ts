import fsp from "node:fs/promises";
import path from "node:path";
import { extractArchive } from "openclaw/plugin-sdk/archive";
import * as tar from "tar";
import type { LlamaServerAsset } from "./llama-server-assets.js";

const EXTRACT_TIMEOUT_MS = 10 * 60_000;

type ArchiveSymlink = { entryPath: string; target: string };

function assertSiblingLinkTarget(entryPath: string, target: string): void {
  // A target without a separator can only ever resolve inside the entry's own
  // directory, so restoring it cannot move bytes outside the extract root.
  if (!target || target === "." || target === ".." || /[\\/]/u.test(target)) {
    throw new Error(`unsafe link target in llama-server archive: ${entryPath} -> ${target}`);
  }
}

/**
 * llama.cpp POSIX releases ship SONAME aliases (`libllama.so` -> `libllama.so.0`
 * -> `libllama.so.0.1.0`) that the dynamic loader needs to start llama-server.
 * fs-safe rejects every archive link entry, so read the link table from the tar
 * headers and keep only same-directory aliases; anything else fails the install.
 */
async function readTarSymlinks(archivePath: string): Promise<ArchiveSymlink[]> {
  const entries: Array<{ entryPath: string; type: string; target: string }> = [];
  await tar.list({
    file: archivePath,
    strict: true,
    onReadEntry: (entry) => {
      entries.push({
        entryPath: String(entry.path),
        type: String(entry.type),
        target: typeof entry.linkpath === "string" ? entry.linkpath : "",
      });
    },
  });
  const symlinks: ArchiveSymlink[] = [];
  for (const entry of entries) {
    if (entry.type === "Link") {
      throw new Error(`unsupported hard link in llama-server archive: ${entry.entryPath}`);
    }
    if (entry.type !== "SymbolicLink") {
      continue;
    }
    assertSiblingLinkTarget(entry.entryPath, entry.target);
    symlinks.push({ entryPath: entry.entryPath, target: entry.target });
  }
  return symlinks;
}

async function restoreArchiveSymlinks(destDir: string, symlinks: ArchiveSymlink[]): Promise<void> {
  const destRealDir = await fsp.realpath(destDir);
  for (const symlink of symlinks) {
    const linkPath = path.resolve(destRealDir, symlink.entryPath);
    // Resolve the parent through realpath instead of comparing spellings: the
    // reported bypass came from lexical entry-path checks that Windows separators
    // and drive prefixes walk straight through.
    const parentRealDir = await fsp.realpath(path.dirname(linkPath));
    if (parentRealDir !== destRealDir && !parentRealDir.startsWith(destRealDir + path.sep)) {
      throw new Error(`unsafe link path in llama-server archive: ${symlink.entryPath}`);
    }
    await fsp.symlink(symlink.target, path.join(parentRealDir, path.basename(linkPath)));
  }
}

/** Extracts a verified llama.cpp release asset into an empty destination directory. */
export async function extractLlamaServerArchive(params: {
  archivePath: string;
  destDir: string;
  archive: LlamaServerAsset["archive"];
}): Promise<void> {
  // The pinned asset format is authoritative: the downloaded file keeps a random
  // prefix, so extension sniffing would decide policy from an attacker-influenced
  // name. Windows assets are flat DLL/EXE bundles, so fs-safe's default link
  // rejection stays in force for them.
  if (params.archive === "zip") {
    await extractArchive({
      archivePath: params.archivePath,
      destDir: params.destDir,
      kind: "zip",
      timeoutMs: EXTRACT_TIMEOUT_MS,
    });
    return;
  }
  const symlinks = await readTarSymlinks(params.archivePath);
  await extractArchive({
    archivePath: params.archivePath,
    destDir: params.destDir,
    kind: "tar",
    tarGzip: true,
    timeoutMs: EXTRACT_TIMEOUT_MS,
    entryFilter: (entry) => (entry.kind === "symlink" ? "skip" : "extract"),
    onFiltered: "skip-entry",
  });
  await restoreArchiveSymlinks(params.destDir, symlinks);
}

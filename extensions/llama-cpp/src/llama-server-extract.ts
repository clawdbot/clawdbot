import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { extractArchive } from "openclaw/plugin-sdk/archive";
import * as tar from "tar";
import type { LlamaServerAsset } from "./llama-server-assets.js";

const EXTRACT_TIMEOUT_MS = 10 * 60_000;
const MEBIBYTE = 1024 * 1024;
const MAX_TAR_PREFLIGHT_ARCHIVE_BYTES = 256 * MEBIBYTE;
const MAX_TAR_PREFLIGHT_ENTRIES = 1_000;
const MAX_TAR_PREFLIGHT_EXTRACTED_BYTES = 512 * MEBIBYTE;
const MAX_TAR_PREFLIGHT_ENTRY_BYTES = 256 * MEBIBYTE;
const MAX_TAR_PREFLIGHT_META_ENTRY_BYTES = MEBIBYTE;

type ArchiveAlias = { entryPath: string; target: string };

function remainingExtractTimeMs(deadlineMs: number): number {
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) {
    throw new Error("llama-server archive extraction timed out");
  }
  return remainingMs;
}

async function waitForExtractDeadline<T>(
  operation: () => Promise<T>,
  deadlineMs: number,
): Promise<T> {
  const timeoutMs = remainingExtractTimeMs(deadlineMs);
  let timer: NodeJS.Timeout | undefined;
  try {
    // Arm the deadline before starting I/O, then observe the operation even if
    // the timer wins so a late filesystem failure cannot become unhandled.
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("llama-server archive extraction timed out")),
        timeoutMs,
      );
    });
    return await Promise.race([
      operation().then((result) => {
        remainingExtractTimeMs(deadlineMs);
        return result;
      }),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function assertSiblingLinkTarget(entryPath: string, target: string): void {
  // A target without a separator can only ever resolve inside the entry's own
  // directory, so materializing it cannot read bytes outside the extract root.
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
async function readTarAliases(archivePath: string, deadlineMs: number): Promise<ArchiveAlias[]> {
  const aliases: ArchiveAlias[] = [];
  const archiveStat = await waitForExtractDeadline(() => fsp.stat(archivePath), deadlineMs);
  if (archiveStat.size > MAX_TAR_PREFLIGHT_ARCHIVE_BYTES) {
    throw new Error("llama-server archive exceeds the preflight size limit");
  }
  const timeoutMs = remainingExtractTimeMs(deadlineMs);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let entryCount = 0;
    let extractedBytes = 0;
    const input = fs.createReadStream(archivePath);
    const parser = new tar.Parser({
      strict: true,
      maxMetaEntrySize: MAX_TAR_PREFLIGHT_META_ENTRY_BYTES,
      onReadEntry: (entry) => {
        try {
          entryCount += 1;
          const entrySize = entry.size;
          extractedBytes += entrySize;
          if (
            entryCount > MAX_TAR_PREFLIGHT_ENTRIES ||
            entrySize > MAX_TAR_PREFLIGHT_ENTRY_BYTES ||
            extractedBytes > MAX_TAR_PREFLIGHT_EXTRACTED_BYTES
          ) {
            abort(new Error("llama-server archive exceeds the preflight entry limits"));
            return;
          }
          const entryPath = entry.path;
          if (entry.type === "Link") {
            abort(new Error(`unsupported hard link in llama-server archive: ${entryPath}`));
            return;
          }
          if (entry.type === "SymbolicLink") {
            const target = typeof entry.linkpath === "string" ? entry.linkpath : "";
            assertSiblingLinkTarget(entryPath, target);
            aliases.push({ entryPath, target });
          }
          entry.resume();
        } catch (error) {
          abort(error instanceof Error ? error : new Error(String(error)));
        }
      },
    });
    const timer = setTimeout(
      () => abort(new Error("llama-server archive preflight timed out")),
      timeoutMs,
    );
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const abort = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      input.destroy();
      // Keep a persistent parser error listener while abort() emits its own
      // TAR_ABORT error. A one-shot listener is removed before its callback,
      // which turns that second error into an uncaught process exception.
      try {
        parser.abort(error);
      } finally {
        reject(error);
      }
    };
    const handleParserError = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      input.destroy();
      reject(error);
    };
    input.once("error", abort);
    parser.on("error", handleParserError);
    parser.once("end", () => finish());
    input.pipe(parser);
  });
  return aliases;
}

function resolveArchiveAliasSource(
  alias: ArchiveAlias,
  aliasesByPath: ReadonlyMap<string, ArchiveAlias>,
): string {
  const seen = new Set([path.posix.normalize(alias.entryPath)]);
  let sourcePath = path.posix.join(path.posix.dirname(alias.entryPath), alias.target);
  for (;;) {
    if (seen.has(sourcePath)) {
      throw new Error(`cyclic alias in llama-server archive: ${alias.entryPath}`);
    }
    const sourceAlias = aliasesByPath.get(sourcePath);
    if (!sourceAlias) {
      return sourcePath;
    }
    seen.add(sourcePath);
    sourcePath = path.posix.join(path.posix.dirname(sourceAlias.entryPath), sourceAlias.target);
  }
}

async function materializeArchiveAliases(
  destDir: string,
  aliases: ArchiveAlias[],
  deadlineMs: number,
): Promise<void> {
  const destRealDir = await waitForExtractDeadline(() => fsp.realpath(destDir), deadlineMs);
  const aliasesByPath = new Map(
    aliases.map((alias) => [path.posix.normalize(alias.entryPath), alias]),
  );
  for (const alias of aliases) {
    const aliasPath = path.resolve(destRealDir, alias.entryPath);
    // Resolve the parent through realpath instead of comparing spellings: the
    // reported bypass came from lexical entry-path checks that Windows separators
    // and drive prefixes walk straight through.
    const parentRealDir = await waitForExtractDeadline(
      () => fsp.realpath(path.dirname(aliasPath)),
      deadlineMs,
    );
    if (parentRealDir !== destRealDir && !parentRealDir.startsWith(destRealDir + path.sep)) {
      throw new Error(`unsafe alias path in llama-server archive: ${alias.entryPath}`);
    }
    const sourceRealPath = await waitForExtractDeadline(
      () =>
        fsp.realpath(path.resolve(destRealDir, resolveArchiveAliasSource(alias, aliasesByPath))),
      deadlineMs,
    );
    if (sourceRealPath !== destRealDir && !sourceRealPath.startsWith(destRealDir + path.sep)) {
      throw new Error(`unsafe alias target in llama-server archive: ${alias.entryPath}`);
    }
    await waitForExtractDeadline(
      () =>
        fsp.copyFile(
          sourceRealPath,
          path.join(parentRealDir, path.basename(aliasPath)),
          fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE,
        ),
      deadlineMs,
    );
  }
}

async function withStagedArchiveDestination(
  destDir: string,
  run: (stagingDir: string) => Promise<void>,
): Promise<void> {
  const stagingDir = await fsp.mkdtemp(`${destDir}.staging-`);
  let published = false;
  try {
    await run(stagingDir);
    await fsp.rmdir(destDir);
    await fsp.rename(stagingDir, destDir);
    published = true;
  } finally {
    if (!published) {
      // Alias materialization happens only in this unpublished tree. Cleanup removes the
      // stage before rejection, so a late filesystem promise cannot reach destDir.
      await fsp.rm(stagingDir, { recursive: true, force: true });
    }
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
  await withStagedArchiveDestination(params.destDir, async (stagingDir) => {
    if (params.archive === "zip") {
      await extractArchive({
        archivePath: params.archivePath,
        destDir: stagingDir,
        kind: "zip",
        timeoutMs: EXTRACT_TIMEOUT_MS,
      });
      return;
    }
    // TAR alias discovery and materialization are part of extraction, so all three
    // phases share one deadline instead of granting each pass a fresh budget.
    const deadlineMs = Date.now() + EXTRACT_TIMEOUT_MS;
    const aliases = await readTarAliases(params.archivePath, deadlineMs);
    await extractArchive({
      archivePath: params.archivePath,
      destDir: stagingDir,
      kind: "tar",
      tarGzip: true,
      timeoutMs: remainingExtractTimeMs(deadlineMs),
      entryFilter: (entry) => (entry.kind === "symlink" ? "skip" : "extract"),
      onFiltered: "skip-entry",
    });
    // Preserve loader-visible SONAME names as regular files. The shared
    // extractor remains the sole link policy owner and publishes no links.
    await materializeArchiveAliases(stagingDir, aliases, deadlineMs);
  });
}

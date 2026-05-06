import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { isWindowsDrivePath } from "../infra/archive-path.js";
import { formatErrorMessage } from "../infra/errors.js";
import { root as fsRoot } from "../infra/fs-safe.js";
import { assertCanonicalPathWithinBase } from "../infra/install-safe-path.js";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import { isWithinDir } from "../infra/path-safety.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { ensureDir, resolveUserPath } from "../utils.js";
import { formatInstallFailureMessage } from "./skills-install-output.js";
import type { SkillInstallResult } from "./skills-install.types.js";
import type { SkillEntry, SkillInstallSpec } from "./skills.js";
import { resolveSkillToolsRootDir } from "./skills/tools-dir.js";

const extractModuleLoader = createLazyImportLoader(() => import("./skills-install-extract.js"));

async function loadExtractModule() {
  return await extractModuleLoader.load();
}

function isNodeReadableStream(value: unknown): value is NodeJS.ReadableStream {
  return Boolean(value && typeof (value as NodeJS.ReadableStream).pipe === "function");
}

function resolveDownloadTargetDir(entry: SkillEntry, spec: SkillInstallSpec): string {
  const root = resolveSkillToolsRootDir(entry);
  const raw = spec.targetDir?.trim();
  if (!raw) {
    return root;
  }

  // Treat non-absolute paths as relative to the per-skill tools root.
  const resolved =
    raw.startsWith("~") || path.isAbsolute(raw) || isWindowsDrivePath(raw)
      ? resolveUserPath(raw)
      : path.resolve(root, raw);

  if (!isWithinDir(root, resolved)) {
    throw new Error(
      `Refusing to install outside the skill tools directory. targetDir="${raw}" resolves to "${resolved}". Allowed root: "${root}".`,
    );
  }
  return resolved;
}

function resolveArchiveType(spec: SkillInstallSpec, filename: string): string | undefined {
  const explicit = normalizeOptionalLowercaseString(spec.archive);
  if (explicit) {
    return explicit;
  }
  const lower = normalizeOptionalLowercaseString(filename);
  if (!lower) {
    return undefined;
  }
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) {
    return "tar.gz";
  }
  if (lower.endsWith(".tar.bz2") || lower.endsWith(".tbz2")) {
    return "tar.bz2";
  }
  if (lower.endsWith(".zip")) {
    return "zip";
  }
  return undefined;
}

async function downloadFile(params: {
  url: string;
  rootDir: string;
  relativePath: string;
  timeoutMs: number;
}): Promise<{ bytes: number }> {
  const destPath = path.resolve(params.rootDir, params.relativePath);
  const stagingDir = path.join(params.rootDir, ".openclaw-download-staging");
  await ensureDir(stagingDir);
  await assertCanonicalPathWithinBase({
    baseDir: params.rootDir,
    candidatePath: stagingDir,
    boundaryLabel: "skill tools directory",
  });
  const tempPath = path.join(stagingDir, `${randomUUID()}.tmp`);
  const { response, release } = await fetchWithSsrFGuard({
    url: params.url,
    timeoutMs: Math.max(1_000, params.timeoutMs),
  });
  try {
    if (!response.ok || !response.body) {
      throw new Error(`Download failed (${response.status} ${response.statusText})`);
    }
    const file = fs.createWriteStream(tempPath);
    const body = response.body as unknown;
    const readable = isNodeReadableStream(body)
      ? body
      : Readable.fromWeb(body as NodeReadableStream);
    await pipeline(readable, file);
    const root = await fsRoot(params.rootDir);
    await root.copyIn(params.relativePath, tempPath);
    const stat = await fs.promises.stat(destPath);
    return { bytes: stat.size };
  } finally {
    await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
    await release();
  }
}

export async function installDownloadSpec(params: {
  entry: SkillEntry;
  spec: SkillInstallSpec;
  timeoutMs: number;
}): Promise<SkillInstallResult> {
  const { entry, spec, timeoutMs } = params;
  const root = resolveSkillToolsRootDir(entry);
  const url = spec.url?.trim();
  if (!url) {
    return {
      ok: false,
      message: "missing download url",
      stdout: "",
      stderr: "",
      code: null,
    };
  }

  let filename = "";
  try {
    const parsed = new URL(url);
    filename = path.basename(parsed.pathname);
  } catch {
    filename = path.basename(url);
  }
  if (!filename) {
    filename = "download";
  }

  let canonicalRoot = "";
  let targetDir = "";
  try {
    await ensureDir(root);
    await assertCanonicalPathWithinBase({
      baseDir: root,
      candidatePath: root,
      boundaryLabel: "skill tools directory",
    });
    canonicalRoot = await fs.promises.realpath(root);

    const requestedTargetDir = resolveDownloadTargetDir(entry, spec);
    await ensureDir(requestedTargetDir);
    await assertCanonicalPathWithinBase({
      baseDir: root,
      candidatePath: requestedTargetDir,
      boundaryLabel: "skill tools directory",
    });
    const targetRelativePath = path.relative(root, requestedTargetDir);
    targetDir = path.join(canonicalRoot, targetRelativePath);
  } catch (err) {
    const message = formatErrorMessage(err);
    return { ok: false, message, stdout: "", stderr: message, code: null };
  }

  const archivePath = path.join(targetDir, filename);
  const archiveRelativePath = path.relative(canonicalRoot, archivePath);
  if (
    !archiveRelativePath ||
    archiveRelativePath === ".." ||
    archiveRelativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(archiveRelativePath)
  ) {
    return {
      ok: false,
      message: "invalid download archive path",
      stdout: "",
      stderr: "invalid download archive path",
      code: null,
    };
  }
  let downloaded = 0;
  try {
    const result = await downloadFile({
      url,
      rootDir: canonicalRoot,
      relativePath: archiveRelativePath,
      timeoutMs,
    });
    downloaded = result.bytes;
  } catch (err) {
    const message = formatErrorMessage(err);
    return { ok: false, message, stdout: "", stderr: message, code: null };
  }

  const archiveType = resolveArchiveType(spec, filename);
  const shouldExtract = spec.extract ?? Boolean(archiveType);
  if (!shouldExtract) {
    return {
      ok: true,
      message: `Downloaded to ${archivePath}`,
      stdout: `downloaded=${downloaded}`,
      stderr: "",
      code: 0,
    };
  }

  if (!archiveType) {
    return {
      ok: false,
      message: "extract requested but archive type could not be detected",
      stdout: "",
      stderr: "",
      code: null,
    };
  }

  try {
    await assertCanonicalPathWithinBase({
      baseDir: canonicalRoot,
      candidatePath: targetDir,
      boundaryLabel: "skill tools directory",
    });
  } catch (err) {
    const message = formatErrorMessage(err);
    return { ok: false, message, stdout: "", stderr: message, code: null };
  }

  const { extractArchive } = await loadExtractModule();
  const extractResult = await extractArchive({
    archivePath,
    archiveType,
    targetDir,
    stripComponents: spec.stripComponents,
    timeoutMs,
  });
  const success = extractResult.code === 0;
  return {
    ok: success,
    message: success
      ? `Downloaded and extracted to ${targetDir}`
      : formatInstallFailureMessage(extractResult),
    stdout: extractResult.stdout.trim(),
    stderr: extractResult.stderr.trim(),
    code: extractResult.code,
  };
}

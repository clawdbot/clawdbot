// Install download helpers fetch remote skill artifacts into temporary storage.
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { parseStrictNonNegativeInteger } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { isWindowsDrivePath } from "../../infra/archive-path.js";
import { sha256File } from "../../infra/crypto-digest.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { root as fsRoot, type Root } from "../../infra/fs-safe.js";
import { assertCanonicalPathWithinBase } from "../../infra/install-safe-path.js";
import { fetchWithSsrFGuard } from "../../infra/net/fetch-guard.js";
import { isWithinDir } from "../../infra/path-safety.js";
import { withTempDownloadPath } from "../../infra/temp-download.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { ensureDir, resolveUserPath } from "../../utils.js";
import { resolveSkillToolsRootDir } from "../runtime/tools-dir.js";
import type { SkillEntry, SkillInstallSpec } from "../types.js";
import { formatInstallFailureMessage } from "./install-output.js";
import type { SkillInstallResult } from "./install-types.js";

const extractModuleLoader = createLazyImportLoader(() => import("./install-extract.js"));
// Skill downloads share ClawHub and marketplace's 256 MiB artifact ceiling;
// changing this limit is a supported-artifact compatibility decision.
const MAX_SKILL_DOWNLOAD_BYTES = 256 * 1024 * 1024;

async function loadExtractModule() {
  return await extractModuleLoader.load();
}

function isNodeReadableStream(value: unknown): value is NodeJS.ReadableStream {
  return Boolean(value && typeof (value as NodeJS.ReadableStream).pipe === "function");
}

async function cancelIgnoredResponseBody(response: Response): Promise<void> {
  const body = response.body as unknown;
  const cancel =
    body && typeof (body as { cancel?: unknown }).cancel === "function"
      ? (body as { cancel: () => Promise<void> | void }).cancel
      : undefined;
  if (!cancel) {
    return;
  }
  await Promise.resolve(cancel.call(body)).catch(() => undefined);
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
  relativePath: string;
  pinnedRoot: Root;
  sha256?: string;
  timeoutMs: number;
}): Promise<{ bytes: number }> {
  return await withTempDownloadPath({ prefix: "skill-download" }, async (tempPath) => {
    const { response, release } = await fetchWithSsrFGuard({
      url: params.url,
      timeoutMs: Math.max(1_000, params.timeoutMs),
    });
    try {
      if (!response.ok || !response.body) {
        await cancelIgnoredResponseBody(response);
        throw new Error(`Download failed (${response.status} ${response.statusText})`);
      }
      // Encoded Content-Length measures wire bytes, not the decoded stream we cap.
      const contentEncoding = normalizeOptionalLowercaseString(
        response.headers.get("content-encoding"),
      );
      const declaredBytes =
        !contentEncoding || contentEncoding === "identity"
          ? parseStrictNonNegativeInteger(response.headers.get("content-length"))
          : undefined;
      if (declaredBytes !== undefined && declaredBytes > MAX_SKILL_DOWNLOAD_BYTES) {
        await cancelIgnoredResponseBody(response);
        throw new Error(
          `Skill download exceeds ${MAX_SKILL_DOWNLOAD_BYTES}-byte limit (declared ${declaredBytes} bytes)`,
        );
      }
      const file = fs.createWriteStream(tempPath);
      const body = response.body as unknown;
      const readable = isNodeReadableStream(body)
        ? body
        : Readable.fromWeb(body as NodeReadableStream);
      let downloadedBytes = 0;
      const limitedBody = new Transform({
        transform(chunk, encoding, callback) {
          downloadedBytes +=
            typeof chunk === "string" ? Buffer.byteLength(chunk, encoding) : chunk.byteLength;
          if (downloadedBytes > MAX_SKILL_DOWNLOAD_BYTES) {
            callback(new Error(`Skill download exceeds ${MAX_SKILL_DOWNLOAD_BYTES}-byte limit`));
            return;
          }
          callback(null, chunk);
        },
      });
      await pipeline(readable, limitedBody, file);
      if (params.sha256) {
        const actual = await sha256File(tempPath);
        if (actual !== params.sha256) {
          const filename = path.basename(params.relativePath);
          throw new Error(
            `SHA-256 mismatch for ${filename}: expected ${params.sha256}, actual ${actual}. The download was discarded; verify the publisher checksum or update the skill manifest before retrying.`,
          );
        }
      }
      await params.pinnedRoot.copyIn(params.relativePath, tempPath);
      return { bytes: file.bytesWritten };
    } finally {
      await release();
    }
  });
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

  let filename;
  try {
    const parsed = new URL(url);
    filename = path.basename(parsed.pathname);
  } catch {
    filename = path.basename(url);
  }
  if (!filename) {
    filename = "download";
  }

  let canonicalRoot;
  let targetDir;
  let pinnedRoot: Root;
  try {
    await ensureDir(root);
    await assertCanonicalPathWithinBase({
      baseDir: root,
      candidatePath: root,
      boundaryLabel: "skill tools directory",
    });
    canonicalRoot = await fs.promises.realpath(root);
    // Bind root identity before fetching so a concurrent replacement cannot redirect publication.
    pinnedRoot = await fsRoot(canonicalRoot);

    const requestedTargetDir = resolveDownloadTargetDir(entry, spec);
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
  let downloaded;
  try {
    const result = await downloadFile({
      url,
      relativePath: archiveRelativePath,
      pinnedRoot,
      sha256: spec.sha256,
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

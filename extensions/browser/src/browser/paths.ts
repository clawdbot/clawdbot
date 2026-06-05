/**
 * Browser filesystem path helpers.
 *
 * Defines browser output roots and resolves upload/media references while
 * enforcing root-scoped path access for Browser tool file inputs.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import {
  resolveExistingPathsWithinRoot,
  resolveStrictExistingPathsWithinRoot,
} from "../sdk-security-runtime.js";
import { CONFIG_DIR } from "../utils.js";
export {
  pathScope,
  resolvePathsWithinRoot,
  resolvePathWithinRoot,
  resolveWritablePathWithinRoot,
} from "../sdk-security-runtime.js";
export { resolveExistingPathsWithinRoot, resolveStrictExistingPathsWithinRoot };

const DEFAULT_FALLBACK_BROWSER_TMP_DIR = "/tmp/openclaw";

function canUseNodeFs(): boolean {
  const getBuiltinModule = (
    process as NodeJS.Process & {
      getBuiltinModule?: (id: string) => unknown;
    }
  ).getBuiltinModule;
  if (typeof getBuiltinModule !== "function") {
    return false;
  }
  try {
    return getBuiltinModule("fs") !== undefined;
  } catch {
    return false;
  }
}

const DEFAULT_BROWSER_TMP_DIR = canUseNodeFs()
  ? resolvePreferredOpenClawTmpDir()
  : DEFAULT_FALLBACK_BROWSER_TMP_DIR;
/** Default root directory for browser trace files. */
export const DEFAULT_TRACE_DIR = DEFAULT_BROWSER_TMP_DIR;
/** Default root directory for browser downloads. */
export const DEFAULT_DOWNLOAD_DIR = path.join(DEFAULT_BROWSER_TMP_DIR, "downloads");
/** Default root directory for browser upload inputs. */
export const DEFAULT_UPLOAD_DIR = path.join(DEFAULT_BROWSER_TMP_DIR, "uploads");
/** Default root directory for managed inbound media references. */
export const DEFAULT_INBOUND_MEDIA_DIR = path.join(CONFIG_DIR, "media", "inbound");

type ExistingPathsResult = Awaited<ReturnType<typeof resolveExistingPathsWithinRoot>>;
type StrictExistingPathsResult = Awaited<ReturnType<typeof resolveStrictExistingPathsWithinRoot>>;

type UploadPathResolutionOptions = {
  requestedPaths: string[];
  uploadDir?: string;
  inboundMediaDir?: string;
};

type ResolvedManagedInboundMediaRef =
  | { ok: true; path: string; uploadRootPrecedence: boolean }
  | { ok: false; error: string }
  | null;

type DecodedInboundMediaId = { ok: true; path: string } | { ok: false; error: string };

function normalizeUploadPathSource(source: string): string {
  const trimmed = source.trim();
  if (/^media:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return trimmed.replace(/^\s*MEDIA\s*:\s*/i, "").trim();
}

function decodeInboundMediaId(value: string, source: string): DecodedInboundMediaId {
  let id: string;
  try {
    id = decodeURIComponent(value);
  } catch {
    return { ok: false, error: `Invalid media reference: ${source}` };
  }
  if (
    !id ||
    id === "." ||
    id === ".." ||
    id.includes("/") ||
    id.includes("\\") ||
    id.includes("\0")
  ) {
    return { ok: false, error: `Invalid media reference: ${source}` };
  }
  return { ok: true, path: id };
}

function resolveManagedInboundMediaRef(
  source: string,
  inboundMediaDir: string,
): ResolvedManagedInboundMediaRef {
  const normalizedSource = normalizeUploadPathSource(source);
  if (!normalizedSource) {
    return null;
  }

  if (/^media:\/\//i.test(normalizedSource)) {
    const rawUriMatch = /^media:\/\/[^/?#]*([^?#]*)/iu.exec(normalizedSource);
    const rawPath = rawUriMatch?.[1] ?? "";
    let parsed: URL;
    try {
      parsed = new URL(normalizedSource);
    } catch {
      return { ok: false, error: `Invalid media reference: ${normalizedSource}` };
    }
    if (parsed.hostname !== "inbound") {
      return {
        ok: false,
        error: `Unsupported media reference location: ${parsed.hostname || "(missing)"}`,
      };
    }
    if (!rawPath.startsWith("/") || rawPath.slice(1).includes("/") || rawPath.includes("\\")) {
      return { ok: false, error: `Invalid media reference: ${normalizedSource}` };
    }
    const decoded = decodeInboundMediaId(rawPath.slice(1), normalizedSource);
    return decoded?.ok
      ? {
          ok: true,
          path: path.join(inboundMediaDir, decoded.path),
          uploadRootPrecedence: false,
        }
      : decoded;
  }

  const relativeMatch = /^(?:\.\/)?media\/inbound\/([^/\\]+)$/u.exec(normalizedSource);
  if (!relativeMatch?.[1]) {
    return null;
  }
  const decoded = decodeInboundMediaId(relativeMatch[1], normalizedSource);
  return decoded?.ok
    ? {
        ok: true,
        path: path.join(inboundMediaDir, decoded.path),
        uploadRootPrecedence: true,
      }
    : decoded;
}

async function isDirectInboundMediaFile(params: {
  inboundMediaDir: string;
  resolvedPath: string;
}): Promise<boolean> {
  let inboundRoot: string;
  try {
    inboundRoot = await fs.realpath(params.inboundMediaDir);
  } catch {
    inboundRoot = path.resolve(params.inboundMediaDir);
  }
  const relativePath = path.relative(inboundRoot, params.resolvedPath);
  return (
    Boolean(relativePath) &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath) &&
    !relativePath.includes("/") &&
    !relativePath.includes("\\")
  );
}

async function resolveDirectInboundMediaPath(params: {
  inboundMediaDir: string;
  requestedPath: string;
  strict: boolean;
}): Promise<ExistingPathsResult> {
  const inboundPathsResult = params.strict
    ? await resolveStrictExistingPathsWithinRoot({
        rootDir: params.inboundMediaDir,
        requestedPaths: [params.requestedPath],
        scopeLabel: `inbound media directory (${params.inboundMediaDir})`,
      })
    : await resolveExistingPathsWithinRoot({
        rootDir: params.inboundMediaDir,
        requestedPaths: [params.requestedPath],
        scopeLabel: `inbound media directory (${params.inboundMediaDir})`,
      });
  if (!inboundPathsResult.ok) {
    return inboundPathsResult;
  }
  const resolvedPath = inboundPathsResult.paths[0] ?? params.requestedPath;
  if (
    !(await isDirectInboundMediaFile({
      inboundMediaDir: params.inboundMediaDir,
      resolvedPath,
    }))
  ) {
    return {
      ok: false,
      error: `Invalid media reference: must be a direct child of inbound media directory (${params.inboundMediaDir})`,
    };
  }
  return inboundPathsResult;
}

/** Resolve upload paths and managed media references into existing file paths. */
export async function resolveExistingUploadPaths({
  requestedPaths,
  uploadDir = DEFAULT_UPLOAD_DIR,
  inboundMediaDir = DEFAULT_INBOUND_MEDIA_DIR,
}: UploadPathResolutionOptions): Promise<ExistingPathsResult> {
  const paths: string[] = [];
  for (const requestedPath of requestedPaths) {
    const managedMediaPathResult = resolveManagedInboundMediaRef(requestedPath, inboundMediaDir);
    if (managedMediaPathResult?.ok === false) {
      return managedMediaPathResult;
    }

    if (managedMediaPathResult?.uploadRootPrecedence !== false) {
      const uploadPathsResult =
        managedMediaPathResult?.uploadRootPrecedence === true
          ? await resolveStrictExistingPathsWithinRoot({
              rootDir: uploadDir,
              requestedPaths: [requestedPath],
              scopeLabel: `uploads directory (${uploadDir})`,
            })
          : await resolveExistingPathsWithinRoot({
              rootDir: uploadDir,
              requestedPaths: [requestedPath],
              scopeLabel: `uploads directory (${uploadDir})`,
            });
      if (uploadPathsResult.ok) {
        paths.push(uploadPathsResult.paths[0] ?? requestedPath);
        continue;
      }
    }

    const inboundPathsResult = await resolveDirectInboundMediaPath({
      inboundMediaDir,
      requestedPath: managedMediaPathResult?.path ?? requestedPath,
      strict: false,
    });
    if (!inboundPathsResult.ok) {
      return inboundPathsResult;
    }
    paths.push(inboundPathsResult.paths[0] ?? requestedPath);
  }
  return { ok: true, paths };
}

/** Strictly resolve upload paths under the upload root only. */
export async function resolveStrictExistingUploadPaths({
  requestedPaths,
  uploadDir = DEFAULT_UPLOAD_DIR,
  inboundMediaDir = DEFAULT_INBOUND_MEDIA_DIR,
}: UploadPathResolutionOptions): Promise<StrictExistingPathsResult> {
  const paths: string[] = [];
  for (const requestedPath of requestedPaths) {
    const managedMediaPathResult = resolveManagedInboundMediaRef(requestedPath, inboundMediaDir);
    if (managedMediaPathResult?.ok === false) {
      return managedMediaPathResult;
    }

    if (managedMediaPathResult?.uploadRootPrecedence !== false) {
      const uploadPathsResult = await resolveStrictExistingPathsWithinRoot({
        rootDir: uploadDir,
        requestedPaths: [requestedPath],
        scopeLabel: `uploads directory (${uploadDir})`,
      });
      if (uploadPathsResult.ok) {
        paths.push(uploadPathsResult.paths[0] ?? requestedPath);
        continue;
      }
    }

    const inboundPathsResult = await resolveDirectInboundMediaPath({
      inboundMediaDir,
      requestedPath: managedMediaPathResult?.path ?? requestedPath,
      strict: true,
    });
    if (!inboundPathsResult.ok) {
      return inboundPathsResult;
    }
    paths.push(inboundPathsResult.paths[0] ?? requestedPath);
  }
  return { ok: true, paths };
}

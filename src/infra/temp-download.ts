import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir.js";

const logger = createSubsystemLogger("infra:temp-download");

export { resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir.js";

type TempDownloadTarget = {
  dir: string;
  path: string;
  cleanup: () => Promise<void>;
};

function sanitizePrefix(prefix: string): string {
  const normalized = prefix.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "tmp";
}

function sanitizeExtension(extension?: string): string {
  if (!extension) {
    return "";
  }
  const normalized = extension.startsWith(".") ? extension : `.${extension}`;
  const suffix = normalized.match(/[a-zA-Z0-9._-]+$/)?.[0] ?? "";
  const token = suffix.replace(/^[._-]+/, "");
  return token ? `.${token}` : "";
}

export function sanitizeTempFileName(fileName: string): string {
  const base = path.basename(fileName).replace(/[^a-zA-Z0-9._-]+/g, "-");
  const normalized = base.replace(/^-+|-+$/g, "");
  return normalized || "download.bin";
}

function resolveTempRoot(tmpDir?: string): string {
  return tmpDir ?? resolvePreferredOpenClawTmpDir();
}

function isNodeErrorWithCode(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === code
  );
}

async function cleanupTempDir(dir: string) {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (err) {
    if (!isNodeErrorWithCode(err, "ENOENT")) {
      logger.warn(`temp-path cleanup failed for ${dir}: ${String(err)}`, { dir, error: err });
    }
  }
}

export function buildRandomTempFilePath(params: {
  prefix: string;
  extension?: string;
  tmpDir?: string;
  now?: number;
  uuid?: string;
}): string {
  const prefix = sanitizePrefix(params.prefix);
  const extension = sanitizeExtension(params.extension);
  const nowCandidate = params.now;
  const now =
    typeof nowCandidate === "number" && Number.isFinite(nowCandidate)
      ? Math.trunc(nowCandidate)
      : Date.now();
  const uuid = params.uuid?.trim() || crypto.randomUUID();
  return path.join(resolveTempRoot(params.tmpDir), `${prefix}-${now}-${uuid}${extension}`);
}

export async function createTempDownloadTarget(params: {
  prefix: string;
  fileName?: string;
  tmpDir?: string;
}): Promise<TempDownloadTarget> {
  const tempRoot = resolveTempRoot(params.tmpDir);
  const prefix = `${sanitizePrefix(params.prefix)}-`;
  const dir = await mkdtemp(path.join(tempRoot, prefix));
  return {
    dir,
    path: path.join(dir, sanitizeTempFileName(params.fileName ?? "download.bin")),
    cleanup: async () => {
      await cleanupTempDir(dir);
    },
  };
}

export async function withTempDownloadPath<T>(
  params: {
    prefix: string;
    fileName?: string;
    tmpDir?: string;
  },
  fn: (tmpPath: string) => Promise<T>,
): Promise<T> {
  const target = await createTempDownloadTarget(params);
  try {
    return await fn(target.path);
  } finally {
    await target.cleanup();
  }
}

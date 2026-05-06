import "./fs-safe-defaults.js";
import crypto from "node:crypto";
import path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { tempWorkspace, type TempWorkspace } from "./private-temp-workspace.js";
import { resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir.js";

const logger = createSubsystemLogger("infra:temp-download");

export { resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir.js";

type TempDownloadTarget = {
  dir: string;
  path: string;
  file(fileName?: string): string;
  cleanup: () => Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
};

function resolveTempRoot(tmpDir?: string): string {
  return tmpDir ?? resolvePreferredOpenClawTmpDir();
}

function sanitizeTempPrefix(prefix: string): string {
  const normalized = prefix.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "tmp";
}

function sanitizeTempExtension(extension?: string): string {
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

export function buildRandomTempFilePath(params: {
  prefix: string;
  extension?: string;
  tmpDir?: string;
  now?: number;
  uuid?: string;
}): string {
  const nowCandidate = params.now;
  const now =
    typeof nowCandidate === "number" && Number.isFinite(nowCandidate)
      ? Math.trunc(nowCandidate)
      : Date.now();
  const uuid = params.uuid?.trim() || crypto.randomUUID();
  return path.join(
    resolveTempRoot(params.tmpDir),
    `${sanitizeTempPrefix(params.prefix)}-${now}-${uuid}${sanitizeTempExtension(params.extension)}`,
  );
}

function buildTempDownloadTarget(
  workspace: TempWorkspace,
  fileName: string | undefined,
): TempDownloadTarget {
  const file = (nextName?: string) =>
    workspace.path(sanitizeTempFileName(nextName ?? fileName ?? "download.bin"));
  return {
    dir: workspace.dir,
    path: file(),
    file,
    cleanup: async () => {
      await workspace.cleanup();
    },
    [Symbol.asyncDispose]: workspace[Symbol.asyncDispose].bind(workspace),
  };
}

export async function createTempDownloadTarget(params: {
  prefix: string;
  fileName?: string;
  tmpDir?: string;
}): Promise<TempDownloadTarget> {
  const workspace = await tempWorkspace({
    rootDir: resolveTempRoot(params.tmpDir),
    prefix: sanitizeTempPrefix(params.prefix),
  });
  const target = buildTempDownloadTarget(workspace, params.fileName);
  const cleanup = async () => {
    try {
      await workspace.cleanup();
    } catch (err) {
      logger.warn(`temp-path cleanup failed: ${String(err)}`, { error: err });
    }
  };
  return {
    ...target,
    cleanup,
    [Symbol.asyncDispose]: cleanup,
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

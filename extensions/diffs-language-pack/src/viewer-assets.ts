// Diffs Language Pack plugin module implements viewer assets behavior.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const VIEWER_ASSET_PREFIX = "/plugins/diffs-language-pack/assets/";
export const VIEWER_LOADER_PATH = `${VIEWER_ASSET_PREFIX}viewer.js`;
export const VIEWER_RUNTIME_PATH = `${VIEWER_ASSET_PREFIX}viewer-runtime.js`;
const VIEWER_RUNTIME_RELATIVE_IMPORT_PATH = "./viewer-runtime.js";
const VIEWER_RUNTIME_CANDIDATE_RELATIVE_PATHS = [
  "./assets/viewer-runtime.js",
  "../assets/viewer-runtime.js",
] as const;

type ServedViewerAsset = {
  body: string | Buffer;
  contentType: string;
};

type RuntimeAssetCache = {
  mtimeMs: number;
  runtimeBody: Buffer;
  loaderBody: string;
};

let runtimeAssetCache: RuntimeAssetCache | null = null;

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export async function resolveViewerRuntimeFileUrl(): Promise<URL> {
  let missingFileError: NodeJS.ErrnoException | null = null;

  for (const relativePath of VIEWER_RUNTIME_CANDIDATE_RELATIVE_PATHS) {
    const candidateUrl = new URL(relativePath, import.meta.url);
    try {
      await fs.stat(fileURLToPath(candidateUrl));
      return candidateUrl;
    } catch (error) {
      if (isMissingFileError(error)) {
        missingFileError = error;
        continue;
      }
      throw error;
    }
  }

  if (missingFileError) {
    throw missingFileError;
  }

  throw new Error("viewer runtime asset candidates were not checked");
}

export async function getServedViewerAsset(pathname: string): Promise<ServedViewerAsset | null> {
  if (pathname !== VIEWER_LOADER_PATH && pathname !== VIEWER_RUNTIME_PATH) {
    return null;
  }

  const assets = await loadViewerAssets();
  if (pathname === VIEWER_LOADER_PATH) {
    return {
      body: assets.loaderBody,
      contentType: "text/javascript; charset=utf-8",
    };
  }

  return {
    body: assets.runtimeBody,
    contentType: "text/javascript; charset=utf-8",
  };
}

async function loadViewerAssets(): Promise<RuntimeAssetCache> {
  const runtimeUrl = await resolveViewerRuntimeFileUrl();
  const runtimePath = fileURLToPath(runtimeUrl);
  const runtimeStat = await fs.stat(runtimePath);
  if (runtimeAssetCache && runtimeAssetCache.mtimeMs === runtimeStat.mtimeMs) {
    return runtimeAssetCache;
  }

  const runtimeBody = await fs.readFile(runtimePath);
  const hash = crypto.createHash("sha1").update(runtimeBody).digest("hex").slice(0, 12);
  runtimeAssetCache = {
    mtimeMs: runtimeStat.mtimeMs,
    runtimeBody,
    loaderBody: `import "${VIEWER_RUNTIME_RELATIVE_IMPORT_PATH}?v=${hash}";\n`,
  };
  return runtimeAssetCache;
}

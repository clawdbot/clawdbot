import type fs from "node:fs";
import type { RootFileOpenFailure } from "../infra/boundary-file-read.js";
import type { PluginDiagnosticCode, PluginManifest } from "./manifest-types.js";

export type CachedPluginManifestResult =
  | { ok: true; manifest: PluginManifest; manifestPath: string }
  | { ok: false; error: string; manifestPath: string; diagnosticCode?: PluginDiagnosticCode };

export type PluginJsonCacheResult = { ok: true; value: unknown } | { ok: false; error: unknown };

export type PluginEntryCheck =
  | { ok: true; path: string; rootRealPath: string; exists: boolean }
  | RootFileOpenFailure;

export type PluginFileCacheEntry = (
  | {
      ok: true;
      path: string;
      rootRealPath: string;
      contents: Buffer;
      hash: string;
      signature: { size: number; mtimeMs: number; ctimeMs: number };
      json?: PluginJsonCacheResult;
      json5?: PluginJsonCacheResult;
      manifest?: CachedPluginManifestResult;
    }
  | { ok: false; failure: RootFileOpenFailure; failurePhase?: "read" }
) & { metadataScanWarningEmitted?: true };

export type PluginPathCacheEntry = {
  exists?: boolean;
  realpath?: string | null;
  nativeRealpath?: string | null;
  stat?: fs.Stats | null;
  lstat?: fs.Stats | null;
};

export type PluginDirectoryCacheEntry =
  | { ok: true; entries: fs.Dirent[] }
  | { ok: false; error: unknown };

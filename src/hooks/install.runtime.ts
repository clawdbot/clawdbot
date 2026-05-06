import { resolveArchiveKind } from "../infra/archive.js";
import { pathExists } from "../infra/fs-safe.js";
import { resolveExistingInstallPath, withExtractedArchiveRoot } from "../infra/install-flow.js";
import { installFromValidatedNpmSpecArchive } from "../infra/install-from-npm-spec.js";
import {
  resolveInstallModeOptions,
  resolveTimedInstallModeOptions,
} from "../infra/install-mode-options.js";
import {
  installPackageDir,
  installPackageDirWithManifestDeps,
} from "../infra/install-package-dir.js";
import {
  type NpmIntegrityDrift,
  type NpmSpecResolution,
  resolveArchiveSourcePath,
} from "../infra/install-source-utils.js";
import {
  ensureInstallTargetAvailable,
  resolveCanonicalInstallTarget,
} from "../infra/install-target.js";
import { readJson } from "../infra/json-files.js";
import { isPathInside, isPathInsideWithRealpath } from "../security/scan-paths.js";

export type { NpmIntegrityDrift, NpmSpecResolution };

export {
  ensureInstallTargetAvailable,
  pathExists as fileExists,
  installFromValidatedNpmSpecArchive,
  installPackageDir,
  installPackageDirWithManifestDeps,
  isPathInside,
  isPathInsideWithRealpath,
  readJson as readJsonFile,
  resolveArchiveKind,
  resolveArchiveSourcePath,
  resolveCanonicalInstallTarget,
  resolveExistingInstallPath,
  resolveInstallModeOptions,
  resolveTimedInstallModeOptions,
  withExtractedArchiveRoot,
};

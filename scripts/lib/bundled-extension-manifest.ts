// Bundled Extension Manifest script supports OpenClaw repository automation.
import { checkMinHostVersion } from "../../src/plugins/min-host-version.ts";
import { isRecord } from "../../src/utils.js";

export type ExtensionPackageJson = {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  openclaw?: {
    install?: unknown;
    releaseChecks?: unknown;
  };
};

export type BundledExtension = { id: string; packageJson: ExtensionPackageJson };

export function collectBundledExtensionManifestErrors(extensions: BundledExtension[]): string[] {
  const errors: string[] = [];

  for (const extension of extensions) {
    const install = extension.packageJson.openclaw?.install;
    if (install !== undefined && !isRecord(install)) {
      errors.push(
        `bundled extension '${extension.id}' manifest invalid | openclaw.install must be an object`,
      );
      continue;
    }
    const hasNpmSpec = isRecord(install) && "npmSpec" in install;
    if (
      hasNpmSpec &&
      (!install.npmSpec || typeof install.npmSpec !== "string" || !install.npmSpec.trim())
    ) {
      errors.push(
        `bundled extension '${extension.id}' manifest invalid | openclaw.install.npmSpec must be a non-empty string`,
      );
    }
    const minHostVersionCheck =
      install?.minHostVersion === undefined
        ? null
        : checkMinHostVersion({
            currentVersion: "0.0.0",
            minHostVersion: install.minHostVersion,
          });
    const minHostVersionError =
      minHostVersionCheck && !minHostVersionCheck.ok && minHostVersionCheck.kind === "invalid"
        ? minHostVersionCheck.error
        : null;
    if (minHostVersionError) {
      errors.push(`bundled extension '${extension.id}' manifest invalid | ${minHostVersionError}`);
    }
  }

  return errors;
}

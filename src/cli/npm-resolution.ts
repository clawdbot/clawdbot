// Helpers for recording npm plugin installs with optional exact-version pinning metadata.
import {
  buildNpmResolutionFields,
  type NpmSpecResolution as NpmResolutionMetadata,
} from "../infra/install-source-utils.js";

/** CLI adapter for npm install-record pinning with styled warning output. */
export function resolvePinnedNpmInstallRecordForCli(
  rawSpec: string,
  pin: boolean,
  installPath: string,
  version: string | undefined,
  resolution: NpmResolutionMetadata | undefined,
  log: (message: string) => void,
  warnFormat: (message: string) => string,
) {
  const resolvedSpec = resolution?.resolvedSpec;
  const recordSpec = pin && resolvedSpec ? resolvedSpec : rawSpec;
  if (pin) {
    if (resolvedSpec) {
      log(`Pinned npm install record to ${resolvedSpec}.`);
    } else {
      log(warnFormat("Could not resolve exact npm version for --pin; storing original npm spec."));
    }
  }
  return {
    source: "npm" as const,
    spec: recordSpec,
    installPath,
    version,
    ...buildNpmResolutionFields(resolution),
  };
}

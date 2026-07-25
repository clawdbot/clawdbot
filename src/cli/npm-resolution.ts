// Helpers for recording npm plugin installs with optional exact-version pinning metadata.
import {
  buildNpmResolutionFields,
  type NpmSpecResolution as NpmResolutionMetadata,
} from "../infra/install-source-utils.js";

/** Build the npm section of a plugin install record. */
export function buildNpmInstallRecordFields(params: {
  spec: string;
  installPath: string;
  version?: string;
  resolution?: NpmResolutionMetadata;
}): {
  source: "npm";
  spec: string;
  installPath: string;
  version?: string;
  resolvedName?: string;
  resolvedVersion?: string;
  resolvedSpec?: string;
  integrity?: string;
  shasum?: string;
  resolvedAt?: string;
} {
  return {
    source: "npm",
    spec: params.spec,
    installPath: params.installPath,
    version: params.version,
    ...buildNpmResolutionFields(params.resolution),
  };
}

/** CLI adapter for npm install-record pinning with styled warning output. */
export function resolvePinnedNpmInstallRecordForCli(
  rawSpec: string,
  pin: boolean,
  installPath: string,
  version: string | undefined,
  resolution: NpmResolutionMetadata | undefined,
  log: (message: string) => void,
  warnFormat: (message: string) => string,
): ReturnType<typeof buildNpmInstallRecordFields> {
  const resolvedSpec = resolution?.resolvedSpec;
  const recordSpec = pin && resolvedSpec ? resolvedSpec : rawSpec;
  if (pin) {
    if (resolvedSpec) {
      log(`Pinned npm install record to ${resolvedSpec}.`);
    } else {
      log(warnFormat("Could not resolve exact npm version for --pin; storing original npm spec."));
    }
  }
  return buildNpmInstallRecordFields({
    spec: recordSpec,
    installPath,
    version,
    resolution,
  });
}

/** Generates the documented matrix of user-supplied credential fields that accept SecretRefs. */
import { getSecretTargetRegistry } from "./target-registry-data.js";
import { unsupportedSecretRefSurfacePolicy } from "./unsupported-surface-policy.js";

type CredentialMatrixEntry = {
  id: string;
  configFile: "openclaw.json" | "auth-profiles.json";
  path: string;
  refPath?: string;
  when?: { type: "api_key" | "token" };
  secretShape: "secret_input" | "sibling_ref"; // pragma: allowlist secret
  optIn: true;
  notes?: string;
};

export type SecretRefCredentialMatrixDocument = {
  version: 1;
  matrixId: "strictly-user-supplied-credentials";
  pathSyntax: 'Dot path with "*" for map keys and "[]" for arrays.';
  scope: "Credentials that are strictly user-supplied and not minted/rotated by OpenClaw runtime.";
  excludedMutableOrRuntimeManaged: string[];
  entries: CredentialMatrixEntry[];
};

/** Builds the public SecretRef credential matrix from the source target registry. */
export function buildSecretRefCredentialMatrix(): SecretRefCredentialMatrixDocument {
  const entriesByKey = new Map<string, CredentialMatrixEntry>();
  for (const entry of getSecretTargetRegistry({ sourceTree: true })) {
    const matrixEntry = Object.assign(
      { id: entry.id, configFile: entry.configFile, path: entry.pathPattern },
      entry.refPathPattern ? { refPath: entry.refPathPattern } : {},
      entry.authProfileType ? { when: { type: entry.authProfileType } } : {},
      { secretShape: entry.secretShape, optIn: true as const },
      entry.secretShape === `sibling_ref` && entry.refPathPattern
        ? { notes: `Compatibility exception: sibling ref field remains canonical.` }
        : {},
    );
    entriesByKey.set(
      [
        matrixEntry.configFile,
        matrixEntry.id,
        matrixEntry.path,
        matrixEntry.refPath ?? "",
        matrixEntry.when?.type ?? "",
      ].join("\0"),
      matrixEntry,
    );
  }

  const entries: CredentialMatrixEntry[] = [...entriesByKey.values()]
    .map((entry) => {
      return entry;
    })
    .toSorted((a, b) => a.id.localeCompare(b.id));

  return {
    version: 1,
    matrixId: "strictly-user-supplied-credentials",
    pathSyntax: 'Dot path with "*" for map keys and "[]" for arrays.',
    scope:
      "Credentials that are strictly user-supplied and not minted/rotated by OpenClaw runtime.",
    excludedMutableOrRuntimeManaged: unsupportedSecretRefSurfacePolicy.listPatterns(),
    entries,
  };
}

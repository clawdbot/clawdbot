import { listSecretTargetRegistryEntries } from "./target-registry.js";
import { getUnsupportedSecretRefSurfacePatterns } from "./unsupported-surface-policy.js";

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

export function buildSecretRefCredentialMatrix(): SecretRefCredentialMatrixDocument {
  const entries: CredentialMatrixEntry[] = listSecretTargetRegistryEntries()
    .map((entry) => {
      const isCanonicalFirecrawlWebFetchEntry =
        entry.id === "plugins.entries.firecrawl.config.webFetch.apiKey";
      const canonicalId = isCanonicalFirecrawlWebFetchEntry
        ? "tools.web.fetch.firecrawl.apiKey"
        : entry.id;
      const canonicalPath = isCanonicalFirecrawlWebFetchEntry
        ? "tools.web.fetch.firecrawl.apiKey"
        : entry.pathPattern;

      return Object.assign(
        { id: canonicalId, configFile: entry.configFile, path: canonicalPath },
        entry.refPathPattern ? { refPath: entry.refPathPattern } : {},
        entry.authProfileType ? { when: { type: entry.authProfileType } } : {},
        { secretShape: entry.secretShape, optIn: true as const },
        entry.secretShape === `sibling_ref` && entry.refPathPattern
          ? { notes: `Compatibility exception: sibling ref field remains canonical.` }
          : {},
      );
    })
    .toSorted((a, b) => a.id.localeCompare(b.id));

  return {
    version: 1,
    matrixId: "strictly-user-supplied-credentials",
    pathSyntax: 'Dot path with "*" for map keys and "[]" for arrays.',
    scope:
      "Credentials that are strictly user-supplied and not minted/rotated by OpenClaw runtime.",
    excludedMutableOrRuntimeManaged: getUnsupportedSecretRefSurfacePatterns(),
    entries,
  };
}

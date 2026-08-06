/** Static, manifest-owned inventory for one host integration bundle. */
import { isRecord } from "../utils.js";

export const HOST_INTEGRATION_BUNDLE_CONTRACT_VERSION = "host-integration-bundle/v1" as const;

const EXACT_SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const NAMESPACED_ID_PATTERN =
  /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
const TOKEN_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
const CONTRACT_VERSION_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?\/v[1-9]\d*$/;

export type PluginManifestHostIntegrationContribution = Readonly<{
  owner: string;
  kind: string;
  id: string;
  contractVersion: string;
}>;

export type PluginManifestHostIntegrationBundle = Readonly<{
  contractVersion: typeof HOST_INTEGRATION_BUNDLE_CONTRACT_VERSION;
  id: string;
  version: string;
  contributions: readonly PluginManifestHostIntegrationContribution[];
}>;

export type HostIntegrationBundleParseResult =
  | { ok: true; bundle: PluginManifestHostIntegrationBundle | undefined }
  | { ok: false; error: string };

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function readRequiredString(value: Record<string, unknown>, key: string): string | undefined {
  const candidate = value[key];
  if (typeof candidate !== "string" || candidate.trim() !== candidate || !candidate) {
    return undefined;
  }
  return candidate;
}

/**
 * Parses the versioned bundle declaration without importing plugin runtime code.
 * Unknown fields fail closed so a plugin cannot imply readiness or activation
 * semantics that this contract does not implement.
 */
export function parsePluginManifestHostIntegrationBundle(
  value: unknown,
): HostIntegrationBundleParseResult {
  if (value === undefined) {
    return { ok: true, bundle: undefined };
  }
  if (!isRecord(value)) {
    return { ok: false, error: "hostIntegrationBundle must be an object" };
  }
  if (!hasOnlyKeys(value, ["contractVersion", "id", "version", "contributions"])) {
    return { ok: false, error: "hostIntegrationBundle contains unsupported fields" };
  }

  const contractVersion = readRequiredString(value, "contractVersion");
  if (contractVersion !== HOST_INTEGRATION_BUNDLE_CONTRACT_VERSION) {
    return {
      ok: false,
      error: `hostIntegrationBundle.contractVersion must be ${HOST_INTEGRATION_BUNDLE_CONTRACT_VERSION}`,
    };
  }
  const id = readRequiredString(value, "id");
  if (!id || !NAMESPACED_ID_PATTERN.test(id) || id.includes("//")) {
    return { ok: false, error: "hostIntegrationBundle.id must be a namespaced id" };
  }
  const version = readRequiredString(value, "version");
  if (!version || !EXACT_SEMVER_PATTERN.test(version)) {
    return { ok: false, error: "hostIntegrationBundle.version must be an exact SemVer" };
  }
  if (!Array.isArray(value.contributions) || value.contributions.length === 0) {
    return {
      ok: false,
      error: "hostIntegrationBundle.contributions must be a non-empty array",
    };
  }

  const ids = new Set<string>();
  const contributions: PluginManifestHostIntegrationContribution[] = [];
  for (const [index, rawContribution] of value.contributions.entries()) {
    if (
      !isRecord(rawContribution) ||
      !hasOnlyKeys(rawContribution, ["owner", "kind", "id", "contractVersion"])
    ) {
      return {
        ok: false,
        error: `hostIntegrationBundle.contributions[${index}] must contain only owner, kind, id, and contractVersion`,
      };
    }
    const owner = readRequiredString(rawContribution, "owner");
    const kind = readRequiredString(rawContribution, "kind");
    const contributionId = readRequiredString(rawContribution, "id");
    const contributionContractVersion = readRequiredString(rawContribution, "contractVersion");
    if (!owner || !TOKEN_PATTERN.test(owner)) {
      return {
        ok: false,
        error: `hostIntegrationBundle.contributions[${index}].owner must be a canonical token`,
      };
    }
    if (!kind || !TOKEN_PATTERN.test(kind)) {
      return {
        ok: false,
        error: `hostIntegrationBundle.contributions[${index}].kind must be a canonical token`,
      };
    }
    if (
      !contributionId ||
      !NAMESPACED_ID_PATTERN.test(contributionId) ||
      contributionId.includes("//")
    ) {
      return {
        ok: false,
        error: `hostIntegrationBundle.contributions[${index}].id must be a namespaced id`,
      };
    }
    if (ids.has(contributionId)) {
      return {
        ok: false,
        error: `hostIntegrationBundle contains duplicate contribution id ${JSON.stringify(contributionId)}`,
      };
    }
    if (
      !contributionContractVersion ||
      !CONTRACT_VERSION_PATTERN.test(contributionContractVersion)
    ) {
      return {
        ok: false,
        error: `hostIntegrationBundle.contributions[${index}].contractVersion must be a versioned contract id`,
      };
    }
    ids.add(contributionId);
    contributions.push(
      Object.freeze({
        owner,
        kind,
        id: contributionId,
        contractVersion: contributionContractVersion,
      }),
    );
  }

  return {
    ok: true,
    bundle: Object.freeze({
      contractVersion: HOST_INTEGRATION_BUNDLE_CONTRACT_VERSION,
      id,
      version,
      contributions: Object.freeze(contributions),
    }),
  };
}

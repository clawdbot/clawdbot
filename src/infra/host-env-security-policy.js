// Loads the generated host environment security policy JSON for JS consumers.
import HOST_ENV_SECURITY_POLICY_JSON from "./host-env-security-policy.json" with { type: "json" };

function sortUniqueUppercase(values) {
  return Object.freeze(
    Array.from(new Set(values.map((value) => value.toUpperCase()))).toSorted((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );
}

function derivePolicyArrays(policy) {
  const blockedEverywhereKeys = policy.blockedEverywhereKeys ?? [];
  const blockedOverrideOnlyKeys = policy.blockedOverrideOnlyKeys ?? [];
  const allowedInheritedOverrideOnlyKeys = policy.allowedInheritedOverrideOnlyKeys ?? [];
  const allowedInheritedOverrideOnlyUpper = new Set(
    allowedInheritedOverrideOnlyKeys.map((value) => value.toUpperCase()),
  );
  const blockedPrefixes = policy.blockedPrefixes ?? [];
  const blockedOverridePrefixes = policy.blockedOverridePrefixes ?? [];
  const blockedInheritedPrefixes = policy.blockedInheritedPrefixes ?? blockedPrefixes;

  return {
    blockedInheritedKeys: sortUniqueUppercase([
      ...blockedEverywhereKeys,
      ...blockedOverrideOnlyKeys.filter(
        (value) => !allowedInheritedOverrideOnlyUpper.has(value.toUpperCase()),
      ),
    ]),
    blockedInheritedPrefixes: sortUniqueUppercase(blockedInheritedPrefixes),
    blockedKeys: sortUniqueUppercase(blockedEverywhereKeys),
    blockedOverrideKeys: sortUniqueUppercase(blockedOverrideOnlyKeys),
    blockedPrefixes: sortUniqueUppercase(blockedPrefixes),
    blockedOverridePrefixes: sortUniqueUppercase(blockedOverridePrefixes),
  };
}

/**
 * Normalizes raw host environment policy JSON into immutable lookup arrays.
 */
export function loadHostEnvSecurityPolicy(rawPolicy = HOST_ENV_SECURITY_POLICY_JSON) {
  const derived = derivePolicyArrays(rawPolicy);
  return Object.freeze({
    blockedEverywhereKeys: Object.freeze(rawPolicy.blockedEverywhereKeys ?? []),
    blockedOverrideOnlyKeys: Object.freeze(rawPolicy.blockedOverrideOnlyKeys ?? []),
    allowedInheritedOverrideOnlyKeys: Object.freeze(
      rawPolicy.allowedInheritedOverrideOnlyKeys ?? [],
    ),
    blockedInheritedKeys: derived.blockedInheritedKeys,
    blockedInheritedPrefixes: derived.blockedInheritedPrefixes,
    blockedPrefixes: derived.blockedPrefixes,
    blockedOverridePrefixes: derived.blockedOverridePrefixes,
    blockedKeys: derived.blockedKeys,
    blockedOverrideKeys: derived.blockedOverrideKeys,
  });
}

/**
 * Process-wide host environment security policy derived from generated JSON.
 */
export const HOST_ENV_SECURITY_POLICY = loadHostEnvSecurityPolicy();

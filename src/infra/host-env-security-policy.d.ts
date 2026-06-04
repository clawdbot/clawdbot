// Generated host-env security policy declarations used by TypeScript tests and
// runtime parity checks.
type HostEnvSecurityPolicy = Readonly<{
  blockedEverywhereKeys: readonly string[];
  blockedOverrideOnlyKeys: readonly string[];
  allowedInheritedOverrideOnlyKeys: readonly string[];
  blockedInheritedKeys: readonly string[];
  blockedInheritedPrefixes: readonly string[];
  blockedPrefixes: readonly string[];
  blockedOverridePrefixes: readonly string[];
  blockedKeys: readonly string[];
  blockedOverrideKeys: readonly string[];
}>;

/** Load the host env security policy, optionally merging a raw override. */
export declare function loadHostEnvSecurityPolicy(
  rawPolicy?: Partial<HostEnvSecurityPolicy>,
): HostEnvSecurityPolicy;

/** Default host env security policy generated from the repo policy source. */
export declare const HOST_ENV_SECURITY_POLICY: HostEnvSecurityPolicy;

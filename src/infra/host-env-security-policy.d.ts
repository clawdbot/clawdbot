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

export declare function loadHostEnvSecurityPolicy(
  rawPolicy?: Partial<HostEnvSecurityPolicy>,
): HostEnvSecurityPolicy;

export declare const HOST_ENV_SECURITY_POLICY: HostEnvSecurityPolicy;

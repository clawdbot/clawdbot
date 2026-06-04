// Public SSRF policy shape accepted by memory host remote HTTP helpers.

/** Host/network allowlist policy forwarded to the runtime SSRF guard. */
export type SsrFPolicy = {
  allowPrivateNetwork?: boolean;
  dangerouslyAllowPrivateNetwork?: boolean;
  allowRfc2544BenchmarkRange?: boolean;
  allowIpv6UniqueLocalRange?: boolean;
  allowedHostnames?: string[];
  hostnameAllowlist?: string[];
};

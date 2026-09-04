// Defines the canonical operator-configurable SSRF policy surface.
export type SsrFPolicyConfig = {
  /** Permit private/internal network targets. Default: false. */
  dangerouslyAllowPrivateNetwork?: boolean;
  /** Allow RFC 2544 benchmark-range IPs (198.18.0.0/15). */
  allowRfc2544BenchmarkRange?: boolean;
  /** Allow IPv6 Unique Local Addresses (fc00::/7). */
  allowIpv6UniqueLocalRange?: boolean;
  /** Explicitly allowed exact hostnames or IP literals. */
  allowedHostnames?: string[];
  /** Deny exact hosts or wildcard subdomains; "*.example.com" excludes the apex. Overrides allows. */
  blockedHostnames?: string[];
};

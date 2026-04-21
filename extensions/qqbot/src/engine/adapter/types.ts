/**
 * Shared types used by the PlatformAdapter interface.
 */

/** Reference to a secret stored in the platform's secret management system. */
export interface SecretInputRef {
  source: "env" | "file" | "config";
  id: string;
}

/** Options for fetching remote media through the platform adapter. */
export interface FetchMediaOptions {
  url: string;
  /** Hint for the local filename when saving. */
  filePathHint?: string;
  /** Maximum bytes to download. */
  maxBytes?: number;
  /** Maximum redirects to follow. */
  maxRedirects?: number;
  /** SSRF policy configuration. */
  ssrfPolicy?: SsrfPolicyConfig;
  /** Extra fetch() RequestInit options. */
  requestInit?: RequestInit;
}

/** Result of a remote media fetch operation. */
export interface FetchMediaResult {
  buffer: Buffer;
  fileName?: string;
}

/** SSRF policy configuration — platform-agnostic subset. */
export interface SsrfPolicyConfig {
  /** Hostnames that are always allowed (supports `*.example.com` wildcards). */
  hostnameAllowlist?: string[];
  /** Whether to allow RFC 2544 benchmark ranges (198.18.0.0/15). */
  allowRfc2544BenchmarkRange?: boolean;
}

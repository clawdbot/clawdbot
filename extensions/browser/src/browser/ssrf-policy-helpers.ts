/**
 * SSRF policy helpers for Browser routes that need one-off hostname grants.
 */
import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { SsrFPolicy } from "../infra/net/ssrf.js";

/** Returns an SSRF policy with the hostname added to allowedHostnames. */
export function withAllowedHostname(
  ssrfPolicy: SsrFPolicy | undefined,
  hostname: string,
): SsrFPolicy {
  return {
    ...ssrfPolicy,
    allowedHostnames: uniqueStrings([...(ssrfPolicy?.allowedHostnames ?? []), hostname]),
  };
}

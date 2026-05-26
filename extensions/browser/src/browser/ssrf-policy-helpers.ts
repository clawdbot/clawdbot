import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { SsrFPolicy } from "../infra/net/ssrf.js";

export function withAllowedHostname(
  ssrfPolicy: SsrFPolicy | undefined,
  hostname: string,
): SsrFPolicy {
  return {
    ...ssrfPolicy,
    allowedHostnames: uniqueStrings([...(ssrfPolicy?.allowedHostnames ?? []), hostname]),
  };
}

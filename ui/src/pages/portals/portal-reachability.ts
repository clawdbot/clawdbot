const PORTAL_REACHABILITY_TIMEOUT_MS = 4_000;

/**
 * `blocked` means the probe never reached the network: Content Security Policy
 * refused the connection, so the result says nothing about the portal. Frames
 * obey `frame-src`, not `connect-src`, so a blocked probe must never be
 * reported to the operator as an unreachable portal.
 */
export type PortalReachability = "reachable" | "unreachable" | "blocked";

function isProbeViolation(event: SecurityPolicyViolationEvent, target: URL): boolean {
  try {
    return new URL(event.blockedURI).origin === target.origin;
  } catch {
    // Keyword blockedURI values ("inline", "eval") never describe this fetch.
    return false;
  }
}

export async function probePortalReachable(url: string): Promise<PortalReachability> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return "unreachable";
  }
  let blocked = false;
  const onViolation = (event: Event) => {
    if (isProbeViolation(event as SecurityPolicyViolationEvent, target)) {
      blocked = true;
    }
  };
  // Callable outside a DOM (tests, any non-browser import): without a document
  // there is no violation signal, so the probe stays reachable/unreachable.
  const violationTarget = typeof document === "undefined" ? undefined : document;
  violationTarget?.addEventListener("securitypolicyviolation", onViolation);
  try {
    await fetch(url, {
      mode: "no-cors",
      signal: AbortSignal.timeout(PORTAL_REACHABILITY_TIMEOUT_MS),
    });
    return "reachable";
  } catch {
    // The violation event and the fetch rejection race; let the event land.
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    return blocked ? "blocked" : "unreachable";
  } finally {
    violationTarget?.removeEventListener("securitypolicyviolation", onViolation);
  }
}

const PORTAL_REACHABILITY_TIMEOUT_MS = 4_000;

export async function probePortalReachable(url: string): Promise<boolean> {
  try {
    await fetch(url, {
      mode: "no-cors",
      signal: AbortSignal.timeout(PORTAL_REACHABILITY_TIMEOUT_MS),
    });
    return true;
  } catch {
    return false;
  }
}

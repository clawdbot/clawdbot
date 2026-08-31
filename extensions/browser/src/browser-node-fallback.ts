/**
 * Browser-node fallback classification.
 *
 * Only the node host's explicit pre-dispatch reachability failure is safe to
 * retry on the Gateway host. Other failures may follow a mutating action.
 */
const BROWSER_CONTROL_HOST_UNREACHABLE = /\bbrowser control host is not reachable\b/i;

export function isBrowserControlHostUnavailableError(value: unknown): boolean {
  const seen = new Set<object>();

  const visit = (candidate: unknown, depth: number): boolean => {
    if (typeof candidate === "string") {
      return BROWSER_CONTROL_HOST_UNREACHABLE.test(candidate);
    }
    if (!candidate || typeof candidate !== "object" || depth > 3 || seen.has(candidate)) {
      return false;
    }
    seen.add(candidate);
    const record = candidate as Record<string, unknown>;
    if (
      typeof record.message === "string" &&
      BROWSER_CONTROL_HOST_UNREACHABLE.test(record.message)
    ) {
      return true;
    }
    return [record.error, record.cause, record.details, record.nodeError].some((entry) =>
      visit(entry, depth + 1),
    );
  };

  return visit(value, 0);
}

// Test routing predicate for Control UI tests.
export function isUiTestTarget(relative) {
  return (
    relative.startsWith("ui/src/") &&
    relative.endsWith(".test.ts") &&
    !relative.endsWith(".e2e.test.ts")
  );
}

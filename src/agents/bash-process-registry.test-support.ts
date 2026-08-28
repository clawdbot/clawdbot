import "./bash-process-registry.js";

type BashProcessRegistryTestApi = {
  resetProcessRegistryForTests(): void;
};

// Bind cleanup to the imported registry; a later module evaluation may replace
// the global slot while existing callers still own the original instance.
const testApi = (globalThis as Record<PropertyKey, unknown>)[
  Symbol.for("openclaw.bashProcessRegistryTestApi")
] as BashProcessRegistryTestApi;

export function resetProcessRegistryForTests(): void {
  testApi.resetProcessRegistryForTests();
}

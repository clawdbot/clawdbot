import "./code-mode-namespaces.js";

type CodeModeNamespacesTestApi = {
  clearCodeModeNamespacesForTest(): void;
  listCodeModeNamespaces(): Array<{ id: string }>;
};

const testing = (globalThis as Record<PropertyKey, unknown>)[
  Symbol.for("openclaw.codeModeNamespacesTestApi")
] as CodeModeNamespacesTestApi;

export function clearCodeModeNamespacesForTest(): void {
  testing.clearCodeModeNamespacesForTest();
}

export function listCodeModeNamespaces(): Array<{ id: string }> {
  return testing.listCodeModeNamespaces();
}

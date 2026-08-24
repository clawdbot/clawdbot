// Canonical file ownership for the non-isolated Gateway server Vitest project.
export const gatewayServerBackedHttpTestFiles = [
  "src/gateway/embeddings-http.test.ts",
  "src/gateway/models-http.test.ts",
  "src/gateway/openai-http.test.ts",
  "src/gateway/openresponses-http.test.ts",
  "src/gateway/probe.auth.integration.test.ts",
];

// Gateway server tests that replace a module the Gateway reaches only through
// re-exports. `gateway-server` is `isolate: false`, so a neighbour that boots a
// full Gateway leaves those importers bound to the real implementation and the
// mock silently never fires. These run in `gateway-server-isolated` instead,
// which gives each file a fresh module graph.
export const gatewayServerIsolatedTestFiles = [
  "src/gateway/server.sessions.compaction-read-errors.test.ts",
];

export const gatewayServerExcludedTestFiles = [
  "src/gateway/gateway.test.ts",
  "src/gateway/server.startup-matrix-migration.integration.test.ts",
  "src/gateway/sessions-history-http.test.ts",
];

const gatewayServerBackedHttpTestFileSet = new Set(gatewayServerBackedHttpTestFiles);
const gatewayServerExcludedTestFileSet = new Set(gatewayServerExcludedTestFiles);
const gatewayServerIsolatedTestFileSet = new Set(gatewayServerIsolatedTestFiles);

export function isGatewayServerBackedHttpTestFile(file) {
  return gatewayServerBackedHttpTestFileSet.has(file.replaceAll("\\", "/"));
}

export function isGatewayServerTestFile(file) {
  const normalized = file.replaceAll("\\", "/");
  if (
    gatewayServerExcludedTestFileSet.has(normalized) ||
    gatewayServerIsolatedTestFileSet.has(normalized) ||
    normalized.startsWith("src/gateway/server-methods/") ||
    normalized.endsWith(".e2e.test.ts")
  ) {
    return false;
  }
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
  return (
    isGatewayServerBackedHttpTestFile(normalized) ||
    (normalized.startsWith("src/gateway/") &&
      basename.includes("server") &&
      normalized.endsWith(".test.ts"))
  );
}

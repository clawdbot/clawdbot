import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

const gatewayServerBackedHttpTests = [
  "src/gateway/embeddings-http.test.ts",
  "src/gateway/models-http.test.ts",
  "src/gateway/openai-http.test.ts",
  "src/gateway/openresponses-http.test.ts",
  "src/gateway/probe.auth.integration.test.ts",
];

export function createGatewayServerVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(
    ["src/gateway/**/*server*.test.ts", ...gatewayServerBackedHttpTests],
    {
      dir: "src/gateway",
      env,
      exclude: [
        "src/gateway/server-methods/**/*.test.ts",
        "src/gateway/gateway.test.ts",
        "src/gateway/server.startup-matrix-migration.integration.test.ts",
        "src/gateway/sessions-history-http.test.ts",
      ],
      // Gateway server suites share process-level env, logger, and server helper state.
      // Isolate files so parallel shards cannot cross-wire suite-scoped servers.
      isolate: true,
      name: "gateway-server",
    },
  );
}

export default createGatewayServerVitestConfig();

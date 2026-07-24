// Vitest gateway core config wires the gateway core test shard.
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

const nonCoreGatewayTestExclude = [
  "src/gateway/server-methods/**/*.test.ts",
  "packages/gateway-protocol/src/**/*.test.ts",
  "src/gateway/**/*client*.test.ts",
  "src/gateway/**/*reconnect*.test.ts",
  "src/gateway/**/*android-node*.test.ts",
  "src/gateway/**/*gateway-cli-backend*.test.ts",
  "src/gateway/**/*server*.test.ts",
  "src/gateway/gateway.test.ts",
  "src/gateway/embeddings-http.test.ts",
  "src/gateway/models-http.test.ts",
  "src/gateway/openai-http.test.ts",
  "src/gateway/openresponses-http.test.ts",
  "src/gateway/probe.auth.integration.test.ts",
  "src/gateway/server.startup-matrix-migration.integration.test.ts",
  "src/gateway/sessions-history-http.test.ts",
];

export function createGatewayCoreVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(["src/gateway/**/*.test.ts"], {
    dir: "src/gateway",
    env,
    exclude: nonCoreGatewayTestExclude,
    includeAgentRosterSetup: false,
    // Gateway child projects share one include file; preserve this project's ownership.
    intersectIncludeFile: true,
    name: "gateway-core",
    setupFiles: ["test/setup-agent-roster-config.ts"],
  });
}

export default createGatewayCoreVitestConfig();

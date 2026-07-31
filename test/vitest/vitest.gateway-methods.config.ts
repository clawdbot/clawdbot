// Vitest gateway methods config wires the gateway methods test shard.
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createGatewayMethodsVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(["src/gateway/server-methods/**/*.test.ts"], {
    dir: "src/gateway",
    env,
    // Gateway child projects share one include file; preserve this project's ownership.
    intersectIncludeFile: true,
    name: "gateway-methods",
  });
}

export default createGatewayMethodsVitestConfig();

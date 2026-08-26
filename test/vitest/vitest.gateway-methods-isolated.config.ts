// Vitest Gateway methods isolated config gives deep module mocks a fresh graph
// while retaining the shared Gateway methods runner and setup.
import { gatewayMethodsIsolatedTestFiles } from "./vitest.gateway-server-paths.mjs";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createGatewayMethodsIsolatedVitestConfig(
  env: Record<string, string | undefined> = process.env,
) {
  return createScopedVitestConfig(gatewayMethodsIsolatedTestFiles, {
    dir: "src/gateway",
    env,
    intersectIncludeFile: true,
    isolate: true,
    name: "gateway-methods-isolated",
    passWithNoTests: true,
    useNonIsolatedRunner: true,
  });
}

export default createGatewayMethodsIsolatedVitestConfig();

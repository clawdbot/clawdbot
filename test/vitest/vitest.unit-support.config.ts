// Vitest unit support config wires the unit support test shard.
import { createUnitVitestConfigWithOptions } from "./vitest.unit.config.ts";

export default createUnitVitestConfigWithOptions(process.env, {
  name: "unit-support",
  includePatterns: ["packages/**/*.test.ts"],
  extraExcludePatterns: [
    // The gateway-client package owns its own browser/runtime protocol lane.
    "packages/gateway-client/src/**/*.test.ts",
    // The gateway-protocol package rides with gateway-client because the client
    // package owns the browser/runtime protocol compatibility lane.
    "packages/gateway-protocol/src/**/*.test.ts",
    "packages/gateway-client/src/**/*.test.ts",
  ],
  passWithNoTests: true,
});

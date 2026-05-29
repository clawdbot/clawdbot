import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createGatewayClientVitestConfig(env?: Record<string, string | undefined>) {
  return createScopedVitestConfig(
    [
      "packages/gateway-client/src/**/*.test.ts",
      "packages/gateway-protocol/src/**/*.test.ts",
      "src/gateway/**/*client*.test.ts",
      "src/gateway/**/*reconnect*.test.ts",
      "src/gateway/**/*android-node*.test.ts",
      "src/gateway/**/*gateway-cli-backend*.test.ts",
    ],
    {
      env,
      exclude: ["src/gateway/**/*server*.test.ts"],
      name: "gateway-client",
    },
  );
}

export default createGatewayClientVitestConfig();

import fs from "node:fs";
import path from "node:path";
import { assert, expect, it } from "vitest";
import { createGatewayClientVitestConfig } from "./vitest/vitest.gateway-client.config.ts";
import { createGatewayCoreVitestConfig } from "./vitest/vitest.gateway-core.config.ts";
import { createGatewayMethodsIsolatedVitestConfig } from "./vitest/vitest.gateway-methods-isolated.config.ts";
import { createGatewayMethodsVitestConfig } from "./vitest/vitest.gateway-methods.config.ts";
import { createGatewayServerIsolatedVitestConfig } from "./vitest/vitest.gateway-server-isolated.config.ts";
import { createGatewayServerVitestConfig } from "./vitest/vitest.gateway-server.config.ts";

function gatewayProjectFiles(filters: string[]) {
  const originalArgv = process.argv;
  process.argv = ["node", "vitest", "run", ...filters];
  try {
    return Object.fromEntries<string[]>(
      [
        createGatewayCoreVitestConfig,
        createGatewayClientVitestConfig,
        createGatewayMethodsVitestConfig,
        createGatewayMethodsIsolatedVitestConfig,
        createGatewayServerVitestConfig,
        createGatewayServerIsolatedVitestConfig,
      ].map((createConfig) => {
        const config = createConfig({});
        const test = config.test!;
        assert(typeof test.name === "string");
        const dir = test.dir ?? config.root!;
        const files = fs
          .globSync(test.include ?? [], { cwd: dir, exclude: test.exclude })
          .map((file) => path.relative(config.root!, path.join(dir, file)).replaceAll("\\", "/"))
          .filter((file) => file.startsWith("src/gateway/"))
          .filter((file) => selectedByFilters(file, filters))
          .toSorted();
        return [test.name, files];
      }),
    );
  } finally {
    process.argv = originalArgv;
  }
}

function selectedByFilters(file: string, filters: string[]): boolean {
  return (
    filters.length === 0 ||
    filters.some((filter) => file === filter || file.startsWith(`${filter}/`))
  );
}

it.each(
  [
    ["src/gateway"],
    ["src/gateway/server"],
    ["src/gateway/server-methods"],
    ["src/gateway/worker-environments"],
    ["src/gateway/managed-image-attachments.test.ts"],
    ["src/gateway/server.sessions.compaction-read-errors.test.ts"],
    ["src/gateway/server", "src/gateway/worker-environments"],
  ].map((filters) => ({ filters })),
)("preserves canonical project ownership for $filters", ({ filters }) => {
  const canonical = gatewayProjectFiles([]);
  const expected = Object.fromEntries(
    Object.entries(canonical).map(([name, files]) => [
      name,
      files.filter((file) => selectedByFilters(file, filters)),
    ]),
  );

  expect(gatewayProjectFiles(filters)).toEqual(expected);
  const selected = Object.values(expected).flat();
  expect(selected.length).toBeGreaterThan(0);
  expect(new Set(selected).size).toBe(selected.length);
});

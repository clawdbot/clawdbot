import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = resolve("scripts/list-prod-store-packages.mjs");

function runListProdStorePackages(input: unknown) {
  return spawnSync(process.execPath, [scriptPath], {
    encoding: "utf8",
    input: JSON.stringify(input),
  });
}

describe("list-prod-store-packages", () => {
  it("accepts pnpm list array output", () => {
    const result = runListProdStorePackages([
      {
        dependencies: {
          sourceMap: {
            from: "source-map",
            resolved: "https://registry.npmjs.org/source-map/-/source-map-0.6.1.tgz",
            version: "0.6.1",
          },
        },
      },
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("source-map@0.6.1");
  });

  it("accepts pnpm list object output", () => {
    const result = runListProdStorePackages({
      dependencies: {
        litSignals: {
          from: "@lit-labs/signals",
          resolved: "https://registry.npmjs.org/@lit-labs/signals/-/signals-0.1.3.tgz",
          version: "0.1.3",
        },
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("@lit-labs/signals@0.1.3");
  });
});

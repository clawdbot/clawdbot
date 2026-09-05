import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { build } from "tsdown";
import { describe, expect, it } from "vitest";
import { collectGatewayRunChunkBudgetErrors } from "../../scripts/check-cli-bootstrap-imports.mts";
import {
  createGatewayRunChunkMetadataPlugin,
  GATEWAY_RUN_CHUNK_METADATA_PATH,
  readGatewayRunChunks,
} from "../../scripts/lib/gateway-run-chunk-metadata.mts";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

function createFixture() {
  const root = fs.realpathSync(createTempDir("openclaw-gateway-chunk-metadata-"));
  fs.mkdirSync(path.join(root, "src/cli/gateway-cli"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"locator-fixture","type":"module"}');
  // Deliberately no source-text markers: the module identity owns this locator.
  fs.writeFileSync(
    path.join(root, "src/cli/gateway-cli/run-command.ts"),
    "export function register() { return 42; }",
  );
  fs.writeFileSync(
    path.join(root, "entry.ts"),
    'export const run = () => import("./src/cli/gateway-cli/run-command.ts");',
  );
  return root;
}

// Real emission protects filename, minification and source-map behavior together.
describe("gateway run chunk metadata", () => {
  it.each([false, true])("binds emitted bytes with sourcemap=%s", async (sourcemap) => {
    const root = createFixture();
    const plugin = createGatewayRunChunkMetadataPlugin(root);
    let producerMs = 0;
    const handler = plugin.generateBundle.handler;
    plugin.generateBundle.handler = function (...args) {
      const start = performance.now();
      try {
        return handler.apply(this, args);
      } finally {
        producerMs += performance.now() - start;
      }
    };
    const bundles = await build({
      config: false,
      cwd: root,
      entry: { "cli/run-main": "entry.ts" },
      outDir: "dist",
      dts: false,
      minify: true,
      sourcemap,
      plugins: [plugin],
      logLevel: "silent",
    });
    try {
      const chunks = readGatewayRunChunks(path.join(root, "dist"));
      expect(chunks).toHaveLength(1);
      expect(chunks[0]?.source).not.toContain("GATEWAY_AUTH_MODES");
      expect(collectGatewayRunChunkBudgetErrors({ rootDir: root })).toEqual([]);
      fs.appendFileSync(chunks[0]!.filePath, "\n// changed after emission\n");
      expect(() => readGatewayRunChunks(path.join(root, "dist"))).toThrow(
        "does not match its build metadata",
      );
      // Evidence only, not a timing threshold that would depend on the runner.
      console.log(JSON.stringify({ proof: "gateway-locator-producer", sourcemap, producerMs }));
    } finally {
      for (const bundle of bundles) await bundle[Symbol.asyncDispose]();
    }
  });

  it("permits subset builds that do not include the gateway command", async () => {
    const root = createFixture();
    fs.writeFileSync(path.join(root, "entry.ts"), "export const unrelated = 1;");
    const bundles = await build({
      config: false,
      cwd: root,
      entry: "entry.ts",
      outDir: "dist",
      dts: false,
      plugins: [createGatewayRunChunkMetadataPlugin(root)],
      logLevel: "silent",
    });
    try {
      expect(fs.existsSync(path.join(root, "dist", GATEWAY_RUN_CHUNK_METADATA_PATH))).toBe(false);
    } finally {
      for (const bundle of bundles) await bundle[Symbol.asyncDispose]();
    }
  });
});

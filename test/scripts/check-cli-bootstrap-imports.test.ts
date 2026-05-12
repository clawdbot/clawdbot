import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectCliBootstrapExternalImportErrors,
  collectGatewayRunChunkBudgetErrors,
  listStaticImportSpecifiers,
} from "../../scripts/check-cli-bootstrap-imports.mjs";

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "openclaw-cli-bootstrap-imports-"));
  tempRoots.push(root);
  mkdirSync(join(root, "dist", "cli"), { recursive: true });
  return root;
}

function writeFixture(root: string, relativePath: string, source: string): void {
  const target = join(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, source, "utf8");
}

function writeGatewayRunChunk(root: string, source = ""): void {
  writeFixture(root, "dist/string-coerce.js", "export const normalize = true;");
  writeFixture(
    root,
    "dist/run-gateway.js",
    [
      'import "./string-coerce.js";',
      "const GATEWAY_RUN_VALUE_KEYS = [];",
      "function addGatewayRunCommand(cmd) { return cmd; }",
      source,
    ].join("\n"),
  );
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("check-cli-bootstrap-imports", () => {
  it("lists only static import and export specifiers", () => {
    expect(
      listStaticImportSpecifiers(`
        import fs from "node:fs";
        import "./side-effect.js";
        export { value } from "../value.js";
        await import("commander");
      `),
    ).toEqual(["node:fs", "./side-effect.js", "../value.js"]);
  });

  it("allows a bootstrap graph with builtins and lazy external imports", () => {
    const root = makeTempRoot();
    writeFixture(
      root,
      "dist/entry.js",
      `import fs from "node:fs";\nimport "./cli/run-main.js";\nvoid fs;\n`,
    );
    writeFixture(
      root,
      "dist/cli/run-main.js",
      `import "../light.js";\nexport async function run() { return import("tslog"); }\n`,
    );
    writeFixture(root, "dist/light.js", `import path from "node:path";\nvoid path;\n`);
    writeGatewayRunChunk(root);

    expect(collectCliBootstrapExternalImportErrors({ rootDir: root })).toStrictEqual([]);
    expect(collectGatewayRunChunkBudgetErrors({ rootDir: root })).toStrictEqual([]);
  });

  it("reports external packages in the static bootstrap graph", () => {
    const root = makeTempRoot();
    writeFixture(root, "dist/entry.js", `import "./cli/run-main.js";\n`);
    writeFixture(root, "dist/cli/run-main.js", `import "../heavy.js";\n`);
    writeFixture(root, "dist/heavy.js", `import { Logger } from "tslog";\nvoid Logger;\n`);
    writeGatewayRunChunk(root);

    expect(collectCliBootstrapExternalImportErrors({ rootDir: root })).toEqual([
      'CLI bootstrap static graph imports external package "tslog" from dist/heavy.js.',
    ]);
  });

  it("reports missing gateway run chunk", () => {
    const root = makeTempRoot();

    expect(collectGatewayRunChunkBudgetErrors({ rootDir: root })).toEqual([
      "CLI bootstrap import guard could not find the bundled gateway run chunk. Run pnpm build first.",
    ]);
  });

  it("reports cold static imports in the gateway run chunk", () => {
    const root = makeTempRoot();
    writeGatewayRunChunk(root, 'import "./restart-sentinel-abc123.js";');
    writeFixture(root, "dist/restart-sentinel-abc123.js", "export const sentinel = true;");

    expect(collectGatewayRunChunkBudgetErrors({ rootDir: root })).toEqual([
      'Gateway run chunk dist/run-gateway.js static graph imports cold path "./restart-sentinel-abc123.js" from dist/run-gateway.js.',
    ]);
  });

  it("reports transitive cold static imports from the gateway run chunk graph", () => {
    const root = makeTempRoot();
    writeGatewayRunChunk(root, 'import "./gateway-bridge.js";');
    writeFixture(root, "dist/gateway-bridge.js", 'import "./server-close-abc123.js";');
    writeFixture(root, "dist/server-close-abc123.js", "export const close = true;");

    expect(collectGatewayRunChunkBudgetErrors({ rootDir: root })).toEqual([
      'Gateway run chunk dist/run-gateway.js static graph imports cold path "./server-close-abc123.js" from dist/gateway-bridge.js.',
    ]);
  });

  it("reports oversized gateway run chunks", () => {
    const root = makeTempRoot();
    writeGatewayRunChunk(root, "x".repeat(10));
    const gatewayRunChunkBytes = statSync(join(root, "dist", "run-gateway.js")).size;

    expect(
      collectGatewayRunChunkBudgetErrors({ rootDir: root, gatewayRunChunkMaxBytes: 50 }),
    ).toEqual([
      `Gateway run chunk dist/run-gateway.js is ${gatewayRunChunkBytes} bytes, above budget 50 bytes.`,
    ]);
  });
});

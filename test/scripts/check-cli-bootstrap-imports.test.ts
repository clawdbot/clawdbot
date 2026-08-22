// Check Cli Bootstrap Imports tests cover check cli bootstrap imports script behavior.
import { createHash } from "node:crypto";
import fs, { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectCliBootstrapExternalImportErrors,
  collectGatewayRunChunkBudgetErrors,
  collectWorkerDeployArtifactErrors,
  listStaticImportSpecifiers,
} from "../../scripts/check-cli-bootstrap-imports.mts";

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
      "const GATEWAY_AUTH_MODES = [];",
      "function addGatewayRunCommand(cmd) { return cmd; }",
      source,
    ].join("\n"),
  );
}

function writeWorkerClosureAttestation(
  root: string,
  artifactName: string,
  source: string,
  runtimeImports: string[],
): void {
  writeFixture(
    root,
    `dist/worker/${artifactName}.closure.json`,
    `${JSON.stringify({
      version: 1,
      artifact: artifactName,
      sha256: createHash("sha256").update(source).digest("hex"),
      runtimeImports,
    })}\n`,
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

  it("discovers the gateway run chunk without reading unrelated build output", () => {
    const root = makeTempRoot();
    writeFixture(root, "dist/cli/run-main.js", 'await import("../run-gateway-facade.js");');
    writeFixture(root, "dist/run-gateway-facade.js", 'import "./run-gateway.js";');
    writeGatewayRunChunk(root);
    const unrelatedPath = join(root, "dist", "extensions", "unrelated.js");
    writeFixture(root, "dist/extensions/unrelated.js", "export const unrelated = true;");

    const readPaths: string[] = [];
    const observedFs = new Proxy(fs, {
      get(target, property, receiver) {
        if (property !== "readFileSync") {
          return Reflect.get(target, property, receiver);
        }
        return (filePath: Parameters<typeof fs.readFileSync>[0], ...args: unknown[]) => {
          readPaths.push(String(filePath));
          return Reflect.apply(target.readFileSync, target, [filePath, ...args]);
        };
      },
    });

    expect(collectGatewayRunChunkBudgetErrors({ rootDir: root, fs: observedFs })).toEqual([]);
    expect(readPaths).not.toContain(unrelatedPath);
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

  it("accepts the self-contained worker deploy artifacts with builtin imports", () => {
    const root = makeTempRoot();
    writeFixture(
      root,
      "dist/worker/worker.mjs",
      'import fs from "node:fs";\nexport const worker = Boolean(fs);\n',
    );
    writeFixture(
      root,
      "dist/worker/workspace-rsync-receiver.mjs",
      'import path from "node:path";\nexport const receiver = Boolean(path);\n',
    );

    expect(collectWorkerDeployArtifactErrors({ rootDir: root })).toEqual([]);
  });

  it("uses build-owned closure attestations for worker deploy artifacts", () => {
    const root = makeTempRoot();
    const workerSource = "this source is intentionally not reparsed";
    const receiverSource = "export {};\n";
    writeFixture(root, "dist/worker/worker.mjs", workerSource);
    writeFixture(root, "dist/worker/workspace-rsync-receiver.mjs", receiverSource);
    writeWorkerClosureAttestation(root, "worker.mjs", workerSource, ["node:fs"]);
    writeWorkerClosureAttestation(root, "workspace-rsync-receiver.mjs", receiverSource, [
      "node:path",
    ]);

    expect(collectWorkerDeployArtifactErrors({ rootDir: root })).toEqual([]);
  });

  it("rejects worker deploy artifacts that do not match their closure attestation", () => {
    const root = makeTempRoot();
    const workerSource = "export {};\n";
    writeFixture(root, "dist/worker/worker.mjs", `${workerSource}// changed\n`);
    writeFixture(root, "dist/worker/workspace-rsync-receiver.mjs", "export {};\n");
    writeWorkerClosureAttestation(root, "worker.mjs", workerSource, []);

    expect(collectWorkerDeployArtifactErrors({ rootDir: root })).toContain(
      "Worker deploy artifact dist/worker/worker.mjs does not match its closure attestation. Run pnpm build again.",
    );
  });

  it("rejects worker package imports and dependency manifests", () => {
    const root = makeTempRoot();
    writeFixture(
      root,
      "dist/worker/worker.mjs",
      [
        'import "left-pad";',
        'await import("./lazy.mjs");',
        '__require("json5");',
        'createRequire(import.meta.url)("../../package.json");',
        'moduleNamespace.createRequire(import.meta.url)("@openclaw/fs-safe/temp");',
      ].join("\n"),
    );
    writeFixture(root, "dist/worker/workspace-rsync-receiver.mjs", "export {};\n");
    writeFixture(root, "dist/worker/lazy.mjs", "export {};\n");
    writeFixture(
      root,
      "dist/worker/package.json",
      `${JSON.stringify({ scripts: { postinstall: "node prepare.js" } })}\n`,
    );

    expect(collectWorkerDeployArtifactErrors({ rootDir: root })).toEqual([
      'Worker deploy artifact dist/worker/worker.mjs retains runtime import "../../package.json" instead of bundling it.',
      'Worker deploy artifact dist/worker/worker.mjs retains runtime import "./lazy.mjs" instead of bundling it.',
      'Worker deploy artifact dist/worker/worker.mjs retains runtime import "@openclaw/fs-safe/temp" instead of bundling it.',
      'Worker deploy artifact dist/worker/worker.mjs retains runtime import "json5" instead of bundling it.',
      'Worker deploy artifact dist/worker/worker.mjs retains runtime import "left-pad" instead of bundling it.',
      "Worker deploy artifact emits unstaged runtime asset dist/worker/lazy.mjs.",
      "Worker deploy artifact must not contain a dependency manifest or lifecycle scripts.",
    ]);
  });
});

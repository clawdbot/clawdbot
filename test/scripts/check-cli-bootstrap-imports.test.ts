// Check Cli Bootstrap Imports tests cover check cli bootstrap imports script behavior.
import { createHash } from "node:crypto";
import fs, { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { build } from "tsdown";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectCliBootstrapExternalImportErrors,
  collectGatewayRunChunkBudgetErrors,
  collectWorkerDeployArtifactErrors,
  listStaticImportSpecifiers,
} from "../../scripts/check-cli-bootstrap-imports.mts";
import {
  createGatewayRunChunkMetadataPlugin,
  GATEWAY_RUN_CHUNK_METADATA_PATH,
  readGatewayRunChunks,
} from "../../scripts/lib/gateway-run-chunk-metadata.mts";

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

function writeGatewayRunChunk(
  root: string,
  source = "",
  { distDir = "dist", chunkName = "run-gateway.js" }: { distDir?: string; chunkName?: string } = {},
): void {
  writeFixture(root, `${distDir}/string-coerce.js`, "export const normalize = true;");
  const chunkSource = [
    'import "./string-coerce.js";',
    "const GATEWAY_AUTH_MODES = [];",
    "function addGatewayRunCommand(cmd) { return cmd; }",
    source,
  ].join("\n");
  writeFixture(root, `${distDir}/${chunkName}`, chunkSource);
  writeFixture(
    root,
    `${distDir}/cli/gateway-run-chunk.json`,
    JSON.stringify({
      version: 1,
      chunks: [
        {
          fileName: chunkName,
          sha256: createHash("sha256").update(chunkSource).digest("hex"),
        },
      ],
    }),
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

  it.each(["run-gateway.js", "run-gateway-abc123.mjs"])(
    "allows builtins and lazy external imports with %s and a mixed-extension graph",
    (chunkName) => {
      const root = makeTempRoot();
      writeFixture(
        root,
        "dist/entry.js",
        `import fs from "node:fs";\nimport "./cli/run-main.js";\nvoid fs;\n`,
      );
      writeFixture(
        root,
        "dist/cli/run-main.js",
        `import "../light-abc123.mjs";\nexport async function run() { return import("tslog"); }\n`,
      );
      writeFixture(root, "dist/light-abc123.mjs", 'import "./string-coerce.js";\n');
      writeGatewayRunChunk(root, "", { chunkName });

      expect(collectCliBootstrapExternalImportErrors({ rootDir: root })).toStrictEqual([]);
      expect(collectGatewayRunChunkBudgetErrors({ rootDir: root })).toStrictEqual([]);
      expect(
        collectGatewayRunChunkBudgetErrors({ rootDir: root, legacyGatewayChunkDiscovery: true }),
      ).toStrictEqual([]);
    },
  );

  it("reports external packages in the static bootstrap graph", () => {
    const root = makeTempRoot();
    writeFixture(root, "dist/entry.js", `import "./cli/run-main.js";\n`);
    writeFixture(root, "dist/cli/run-main.js", `import "../bridge-abc123.mjs";\n`);
    writeFixture(root, "dist/bridge-abc123.mjs", `import "./heavy.js";\n`);
    writeFixture(root, "dist/heavy.js", `import { Logger } from "tslog";\nvoid Logger;\n`);
    writeGatewayRunChunk(root);

    expect(collectCliBootstrapExternalImportErrors({ rootDir: root })).toEqual([
      'CLI bootstrap static graph imports external package "tslog" from dist/heavy.js.',
    ]);
  });

  it("requires build-owned gateway metadata for current builds", () => {
    const root = makeTempRoot();
    writeGatewayRunChunk(root);
    rmSync(join(root, "dist/cli/gateway-run-chunk.json"));
    expect(collectGatewayRunChunkBudgetErrors({ rootDir: root })).toEqual([
      expect.stringMatching(
        /^CLI bootstrap import guard could not read gateway run chunk metadata: .*Run pnpm build first\.$/u,
      ),
    ]);
    expect(
      collectGatewayRunChunkBudgetErrors({ rootDir: root, legacyGatewayChunkDiscovery: true }),
    ).toEqual([]);
  });

  it("reports missing gateway chunks in frozen legacy targets", () => {
    const root = makeTempRoot();
    expect(
      collectGatewayRunChunkBudgetErrors({ rootDir: root, legacyGatewayChunkDiscovery: true }),
    ).toEqual([
      "CLI bootstrap import guard could not find the bundled gateway run chunk. Run pnpm build first.",
    ]);
  });

  it.each(["dist", "custom-output"])("reads only the owned gateway graph under %s", (distDir) => {
    const root = makeTempRoot();
    writeGatewayRunChunk(root, "", { distDir });
    const unrelatedPath = join(root, distDir, "plugins/unrelated.js");
    writeFixture(root, `${distDir}/plugins/unrelated.js`, "export const unrelated = true;");
    const reads: string[] = [];
    const observedFs = new Proxy(fs, {
      get(target, property, receiver) {
        if (property !== "readFileSync") {
          return Reflect.get(target, property, receiver);
        }
        return (...args: Parameters<typeof fs.readFileSync>) => {
          reads.push(String(args[0]));
          return Reflect.apply(target.readFileSync, target, args);
        };
      },
    });
    expect(collectGatewayRunChunkBudgetErrors({ rootDir: root, distDir, fs: observedFs })).toEqual(
      [],
    );
    expect(reads).not.toContain(unrelatedPath);
  });

  it("records bounded reads alongside legacy discovery", () => {
    const root = makeTempRoot();
    writeGatewayRunChunk(root);
    for (let index = 0; index < 128; index += 1) {
      writeFixture(
        root,
        `dist/plugins/unrelated-${index}.js`,
        `export const fixture = "${"x".repeat(4096)}";`,
      );
    }
    let unrelatedReads = 0;
    const observedFs = new Proxy(fs, {
      get(target, property, receiver) {
        if (property !== "readFileSync") {
          return Reflect.get(target, property, receiver);
        }
        return (...args: Parameters<typeof fs.readFileSync>) => {
          if (String(args[0]).includes(`${join("dist", "plugins")}${sep}`)) {
            unrelatedReads += 1;
          }
          return Reflect.apply(target.readFileSync, target, args);
        };
      },
    });
    const start = performance.now();
    expect(collectGatewayRunChunkBudgetErrors({ rootDir: root, fs: observedFs })).toEqual([]);
    const metadataMs = performance.now() - start;
    expect(unrelatedReads).toBe(0);
    const legacyStart = performance.now();
    expect(
      collectGatewayRunChunkBudgetErrors({
        rootDir: root,
        fs: observedFs,
        legacyGatewayChunkDiscovery: true,
      }),
    ).toEqual([]);
    const legacyMs = performance.now() - legacyStart;
    expect(unrelatedReads).toBe(128);
    console.log(
      JSON.stringify({
        proof: "gateway-locator-check-work",
        metadataMs,
        legacyMs,
        removedUnrelatedReads: unrelatedReads,
      }),
    );
  });

  it.each(["invalid JSON", "empty locator", "changed chunk"])(
    "rejects %s without scanning for a replacement",
    (condition) => {
      const root = makeTempRoot();
      writeGatewayRunChunk(root);
      if (condition === "changed chunk") {
        writeFixture(root, "dist/run-gateway.js", "export const changed = true;");
      } else {
        writeFixture(
          root,
          "dist/cli/gateway-run-chunk.json",
          condition === "invalid JSON" ? "not-json" : '{"version":1,"chunks":[]}',
        );
      }
      expect(collectGatewayRunChunkBudgetErrors({ rootDir: root })).toEqual([
        expect.stringMatching(
          /^CLI bootstrap import guard could not read gateway run chunk metadata: .*Run pnpm build first\.$/u,
        ),
      ]);
    },
  );

  it.each(["run-gateway.js", "run-gateway-abc123.mjs"])(
    "reports cold static imports in %s",
    (chunkName) => {
      const root = makeTempRoot();
      writeGatewayRunChunk(root, 'import "./restart-sentinel-abc123.mjs";', { chunkName });
      writeFixture(root, "dist/restart-sentinel-abc123.mjs", "export const sentinel = true;");

      expect(collectGatewayRunChunkBudgetErrors({ rootDir: root })).toEqual([
        `Gateway run chunk dist/${chunkName} static graph imports cold path "./restart-sentinel-abc123.mjs" from dist/${chunkName}.`,
      ]);
    },
  );

  it.each(["run-gateway.js", "run-gateway-abc123.mjs"])(
    "reports transitive cold static imports from %s through a mixed-extension graph",
    (chunkName) => {
      const root = makeTempRoot();
      writeGatewayRunChunk(root, 'import "./gateway-bridge-abc123.mjs";', { chunkName });
      writeFixture(root, "dist/gateway-bridge-abc123.mjs", 'import "./server-close-abc123.js";');
      writeFixture(root, "dist/server-close-abc123.js", "export const close = true;");

      expect(collectGatewayRunChunkBudgetErrors({ rootDir: root })).toEqual([
        `Gateway run chunk dist/${chunkName} static graph imports cold path "./server-close-abc123.js" from dist/gateway-bridge-abc123.mjs.`,
      ]);
    },
  );

  it.each(["run-gateway.js", "run-gateway-abc123.mjs"])("reports an oversized %s", (chunkName) => {
    const root = makeTempRoot();
    writeGatewayRunChunk(root, "x".repeat(10), { chunkName });
    const gatewayRunChunkBytes = statSync(join(root, "dist", chunkName)).size;

    expect(
      collectGatewayRunChunkBudgetErrors({ rootDir: root, gatewayRunChunkMaxBytes: 50 }),
    ).toEqual([
      `Gateway run chunk dist/${chunkName} is ${gatewayRunChunkBytes} bytes, above budget 50 bytes.`,
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
    writeFixture(
      root,
      "dist/worker/github-exec-launcher.mjs",
      'import fs from "node:fs";\nexport const launcher = Boolean(fs);\n',
    );

    expect(collectWorkerDeployArtifactErrors({ rootDir: root })).toEqual([]);
  });

  it("accepts no worker artifact directory when the target has no worker contract", () => {
    const root = makeTempRoot();

    expect(
      collectWorkerDeployArtifactErrors({ rootDir: root, workerDeployEntrypoints: [] }),
    ).toEqual([]);

    writeFixture(root, "dist/worker/unexpected.mjs", "export {};\n");
    expect(
      collectWorkerDeployArtifactErrors({ rootDir: root, workerDeployEntrypoints: [] }),
    ).toEqual(["Worker deploy artifact emits unstaged runtime asset dist/worker/unexpected.mjs."]);

    rmSync(join(root, "dist/worker"), { recursive: true, force: true });
    writeFixture(root, "dist/worker", "not a directory\n");
    expect(
      collectWorkerDeployArtifactErrors({ rootDir: root, workerDeployEntrypoints: [] }),
    ).toEqual(["Worker deploy artifact directory dist/worker is unreadable."]);
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
    writeFixture(root, "dist/worker/github-exec-launcher.mjs", 'import "yaml";\n');
    writeFixture(root, "dist/worker/lazy.mjs", "export {};\n");
    writeFixture(
      root,
      "dist/worker/package.json",
      `${JSON.stringify({ scripts: { postinstall: "node prepare.js" } })}\n`,
    );

    expect(collectWorkerDeployArtifactErrors({ rootDir: root })).toEqual([
      'Worker deploy artifact dist/worker/github-exec-launcher.mjs retains runtime import "yaml" instead of bundling it.',
      'Worker deploy artifact dist/worker/worker.mjs retains runtime import "../../package.json" instead of bundling it.',
      'Worker deploy artifact dist/worker/worker.mjs retains runtime import "./lazy.mjs" instead of bundling it.',
      'Worker deploy artifact dist/worker/worker.mjs retains runtime import "@openclaw/fs-safe/temp" instead of bundling it.',
      'Worker deploy artifact dist/worker/worker.mjs retains runtime import "json5" instead of bundling it.',
      'Worker deploy artifact dist/worker/worker.mjs retains runtime import "left-pad" instead of bundling it.',
      "Worker deploy artifact emits unstaged runtime asset dist/worker/lazy.mjs.",
      "Worker deploy artifact must not contain a dependency manifest or lifecycle scripts.",
    ]);
  });

  it.each(["two", "three", "default"] as const)(
    "requires the %s-artifact worker deployment contract",
    (contract) => {
      const root = makeTempRoot();
      const workerDeployEntrypoints = [
        "dist/worker/worker.mjs",
        "dist/worker/workspace-rsync-receiver.mjs",
      ];
      for (const entrypoint of workerDeployEntrypoints) {
        writeFixture(root, entrypoint, "export {};\n");
      }
      if (contract === "three") {
        workerDeployEntrypoints.push("dist/worker/github-exec-launcher.mjs");
      }
      expect(
        collectWorkerDeployArtifactErrors({
          rootDir: root,
          workerDeployEntrypoints: contract === "default" ? undefined : workerDeployEntrypoints,
        }),
      ).toEqual(
        contract === "two"
          ? []
          : [
              "Worker deploy artifact dist/worker/github-exec-launcher.mjs is missing. Run pnpm build first.",
            ],
      );
    },
  );
});

function createGatewayBuildFixture() {
  const root = fs.realpathSync(makeTempRoot());
  fs.mkdirSync(join(root, "src/cli/gateway-cli"), { recursive: true });
  fs.writeFileSync(join(root, "package.json"), '{"name":"locator-fixture","type":"module"}');
  // Deliberately no source-text markers: the module identity owns this locator.
  fs.writeFileSync(
    join(root, "src/cli/gateway-cli/run-command.ts"),
    "export function register() { return 42; }",
  );
  fs.writeFileSync(
    join(root, "entry.ts"),
    'export const run = () => import("./src/cli/gateway-cli/run-command.ts");',
  );
  return root;
}

// Real emission protects filename, minification and source-map behavior together.
describe("gateway run chunk metadata", () => {
  it.each([false, true])("binds emitted bytes with sourcemap=%s", async (sourcemap) => {
    const root = createGatewayBuildFixture();
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
      outputOptions: {
        entryFileNames: "[name].js",
        chunkFileNames: "[name]-[hash].mjs",
      },
      minify: true,
      sourcemap,
      plugins: [plugin],
      logLevel: "silent",
    });
    try {
      const chunks = readGatewayRunChunks(join(root, "dist"));
      expect(chunks).toHaveLength(1);
      expect(chunks[0]?.filePath).toMatch(/-[A-Za-z0-9_-]+\.mjs$/u);
      expect(fs.existsSync(join(root, "dist/cli/run-main.js"))).toBe(true);
      expect(chunks[0]?.source).not.toContain("GATEWAY_AUTH_MODES");
      expect(collectGatewayRunChunkBudgetErrors({ rootDir: root })).toEqual([]);
      fs.appendFileSync(chunks[0]!.filePath, "\n// changed after emission\n");
      expect(() => readGatewayRunChunks(join(root, "dist"))).toThrow(
        "does not match its build metadata",
      );
      // Evidence only, not a timing threshold that would depend on the runner.
      console.log(JSON.stringify({ proof: "gateway-locator-producer", sourcemap, producerMs }));
    } finally {
      for (const bundle of bundles) await bundle[Symbol.asyncDispose]();
    }
  });

  it("permits subset builds that do not include the gateway command", async () => {
    const root = createGatewayBuildFixture();
    fs.writeFileSync(join(root, "entry.ts"), "export const unrelated = 1;");
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
      expect(fs.existsSync(join(root, "dist", GATEWAY_RUN_CHUNK_METADATA_PATH))).toBe(false);
    } finally {
      for (const bundle of bundles) await bundle[Symbol.asyncDispose]();
    }
  });
});

// Tsdown config tests protect package artifact build contracts.
import fs from "node:fs";
import path from "node:path";
import { build } from "tsdown";
import { afterEach, describe, expect, it, vi } from "vitest";
import { publicPluginSdkEntrypoints } from "../../scripts/lib/plugin-sdk-entries.mts";
import {
  TSDOWN_PACKAGE_CONFIG_GROUP,
  TSDOWN_UNIFIED_CONFIG_GROUP,
  TSDOWN_UNIFIED_DTS_CONFIG_GROUPS,
} from "../../scripts/lib/tsdown-config-groups.mts";
import { WORKER_DEPLOY_OPTIONAL_NATIVE_MODULE_ID } from "../../scripts/lib/worker-deploy-build-plugin.mts";
import buildConfigs from "../../tsdown.config.ts";
import { createScriptTestHarness } from "./test-helpers.js";

const configs = Array.isArray(buildConfigs) ? buildConfigs : [buildConfigs];
const { createTempDir } = createScriptTestHarness();
afterEach(() => vi.unstubAllEnvs());

type TsdownConfig = (typeof configs)[number];
type OutExtensions = NonNullable<TsdownConfig["outExtensions"]>;

function hasWorkerEntry(config: TsdownConfig, name: string, source: string): boolean {
  const entry = config.entry;
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return false;
  }
  return (entry as Record<string, unknown>)[name] === source;
}

const isWorkerDeployConfig = (config: TsdownConfig) =>
  hasWorkerEntry(config, "worker/worker", "src/worker/worker-deploy-entry.ts");
const isWorkerRsyncReceiverConfig = (config: TsdownConfig) =>
  hasWorkerEntry(
    config,
    "worker/workspace-rsync-receiver",
    "src/worker/workspace-rsync-receiver.ts",
  );
const isWorkerBuildConfig = (config: TsdownConfig) =>
  isWorkerDeployConfig(config) || isWorkerRsyncReceiverConfig(config);

describe("tsdown config", () => {
  it.each(
    ["runtime", "declarations", "worker", "receiver"].flatMap((target) =>
      [false, true].map((verbose) => ({ target, verbose })),
    ),
  )(
    "preserves dependency package boundaries for $target (verbose=$verbose)",
    async ({ target, verbose }) => {
      vi.stubEnv("OPENCLAW_BUILD_VERBOSE", verbose ? "1" : "0");
      const root = fs.realpathSync(createTempDir("openclaw-tsdown-dependencies-"));
      const declarations = target === "declarations";
      const bundleAll = target === "worker" || target === "receiver";
      const selected = configs.find(
        target === "worker"
          ? isWorkerDeployConfig
          : target === "receiver"
            ? isWorkerRsyncReceiverConfig
            : (entry) =>
                entry.name ===
                (declarations ? TSDOWN_UNIFIED_DTS_CONFIG_GROUPS[0] : TSDOWN_UNIFIED_CONFIG_GROUP),
      );
      expect(selected).toBeDefined();
      const packages = [
        "@anthropic-ai/claude-agent-sdk",
        "@anthropic-ai/vertex-sdk",
        "@slack/bolt",
        "@slack/web-api",
        "@discordjs/voice",
        "@lancedb/lancedb",
        "@larksuiteoapi/node-sdk",
        "@matrix-org/matrix-sdk-crypto-nodejs",
        "@openclaw/ai",
        "@vitest/expect",
        "jimp",
        "matrix-js-sdk",
        "prism-media",
        "sharp",
        "typescript",
        "vitest",
        "zod",
      ];
      // No manifest dependencies: only phantom/transitive copies are resolvable.
      // Automatic manifest externalization must not hide a missing build boundary.
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
      const specifiers: string[] = [];
      const expectedImports: string[] = [];
      for (const name of packages) {
        for (const packageName of [name, `${name}-extra`]) {
          const packageRoot = path.join(root, "node_modules", packageName);
          fs.mkdirSync(packageRoot, { recursive: true });
          fs.writeFileSync(
            path.join(packageRoot, "package.json"),
            JSON.stringify({
              name: packageName,
              version: "1.0.0",
              type: "module",
              exports: {
                ".": { types: "./index.d.ts", default: "./index.js" },
                "./subpath": { types: "./index.d.ts", default: "./index.js" },
              },
            }),
          );
          fs.writeFileSync(
            path.join(packageRoot, "index.js"),
            "export const identity = import.meta.url;\n",
          );
          fs.writeFileSync(
            path.join(packageRoot, "index.d.ts"),
            "export interface Identity { value: string }\n",
          );
          const imports = [packageName, `${packageName}/subpath`];
          specifiers.push(...imports);
          if (!bundleAll && packageName === name && (name !== "zod" || declarations)) {
            expectedImports.push(...imports);
          }
        }
      }
      const entry = path.join(root, declarations ? "entry.d.ts" : "entry.ts");
      fs.writeFileSync(
        entry,
        specifiers
          .map(
            (specifier, index) =>
              `export { ${declarations ? "type Identity" : "identity"} as value${index} } from ${JSON.stringify(specifier)};`,
          )
          .join("\n"),
      );
      const bundles = await build({
        ...selected,
        config: false,
        cwd: root,
        entry: [entry],
        outDir: path.join(root, "dist"),
        tsconfig: false,
        dts: declarations ? { emitDtsOnly: true } : false,
        logLevel: "silent",
      });
      try {
        const imports = bundles.flatMap((bundle) =>
          bundle.chunks.flatMap((chunk) => (chunk.type === "chunk" ? chunk.imports : [])),
        );
        expect(imports.toSorted()).toEqual(expectedImports.toSorted());
      } finally {
        for (const bundle of bundles) {
          await bundle[Symbol.asyncDispose]();
        }
      }
    },
  );

  it.each(["tsdown.config.ts", "tsdown.ai.config.ts"])(
    "keeps %s free of runtime imports from tsdown",
    (configPath) => {
      const source = fs.readFileSync(configPath, "utf8");
      expect(source).not.toMatch(/^import(?!\s+type\b).*from ["']tsdown["'];?$/mu);
    },
  );

  it("isolates runtime output from bounded declaration-only graphs", () => {
    const packageConfigs = configs.filter((entry) => entry.name === TSDOWN_PACKAGE_CONFIG_GROUP);
    const unifiedRuntimeConfig = configs.find(
      (entry) => entry.name === TSDOWN_UNIFIED_CONFIG_GROUP,
    );
    const unifiedDeclarationConfigs = TSDOWN_UNIFIED_DTS_CONFIG_GROUPS.map((name) =>
      configs.find((entry) => entry.name === name),
    );

    expect(packageConfigs).not.toHaveLength(0);
    expect(packageConfigs.map((entry) => entry.dts)).toEqual(packageConfigs.map(() => true));
    expect(unifiedRuntimeConfig?.dts).toBe(false);
    expect(unifiedDeclarationConfigs.every(Boolean)).toBe(true);
    for (const declarationConfig of unifiedDeclarationConfigs) {
      expect(declarationConfig?.dts).toMatchObject({ emitDtsOnly: true });
      expect(Object.keys(declarationConfig?.entry ?? {})).toEqual(
        Object.keys(unifiedRuntimeConfig?.entry ?? {}),
      );
    }
  });

  it("assigns every unified entry to exactly one bounded declaration graph", () => {
    const unifiedRuntimeConfig = configs.find(
      (entry) => entry.name === TSDOWN_UNIFIED_CONFIG_GROUP,
    );
    const runtimeSources = Object.values(unifiedRuntimeConfig?.entry ?? {}).map((source) => {
      const sourceString = String(source);
      return (
        path.isAbsolute(sourceString) ? path.relative(process.cwd(), sourceString) : sourceString
      ).replaceAll("\\", "/");
    });
    const declarationSources = TSDOWN_UNIFIED_DTS_CONFIG_GROUPS.flatMap((name) => {
      const declarationConfig = configs.find((entry) => entry.name === name);
      const dts = declarationConfig?.dts;
      if (!dts || typeof dts !== "object" || !Array.isArray(dts.entry)) {
        return [];
      }
      expect(dts.entry.length).toBeLessThanOrEqual(200);
      return dts.entry;
    });

    expect(declarationSources.toSorted()).toEqual(runtimeSources.toSorted());
    expect(new Set(declarationSources).size).toBe(declarationSources.length);
  });

  it("keeps public SDK declarations together and isolates private runtime declarations", () => {
    const [publicDeclarationSources = [], privateDeclarationSources = []] =
      TSDOWN_UNIFIED_DTS_CONFIG_GROUPS.filter((name) =>
        name.startsWith("openclaw-dts-plugin-sdk-"),
      ).map((name) => {
        const dts = configs.find((entry) => entry.name === name)?.dts;
        return dts && typeof dts === "object" && Array.isArray(dts.entry) ? dts.entry : [];
      });
    const publicSources = publicPluginSdkEntrypoints.map((entry) => `src/plugin-sdk/${entry}.ts`);
    const publicSourceSet = new Set(publicSources);

    expect(publicDeclarationSources.toSorted()).toEqual(publicSources.toSorted());
    expect(privateDeclarationSources.some((source) => publicSourceSet.has(source))).toBe(false);
    expect(privateDeclarationSources).toContain("src/plugin-sdk/tts-runtime.ts");
  });

  it("builds self-contained worker deploy executables with every dependency bundled", () => {
    const workerConfig = configs.find(isWorkerDeployConfig);
    const receiverConfig = configs.find(isWorkerRsyncReceiverConfig);
    expect(workerConfig?.entry).toEqual({
      "worker/worker": "src/worker/worker-deploy-entry.ts",
    });
    expect(receiverConfig?.entry).toEqual({
      "worker/workspace-rsync-receiver": "src/worker/workspace-rsync-receiver.ts",
    });
    const packageVersion = (
      JSON.parse(fs.readFileSync("package.json", "utf8")) as {
        version: string;
      }
    ).version;
    expect(workerConfig?.define).toEqual({
      WORKER_DEPLOY_BUILD: "true",
      WORKER_DEPLOY_VERSION: JSON.stringify(packageVersion),
    });
    expect(workerConfig?.alias).toMatchObject({
      bufferutil: WORKER_DEPLOY_OPTIONAL_NATIVE_MODULE_ID,
      "chromium-bidi/lib/cjs/bidiMapper/BidiMapper": WORKER_DEPLOY_OPTIONAL_NATIVE_MODULE_ID,
      "chromium-bidi/lib/cjs/cdp/CdpConnection": WORKER_DEPLOY_OPTIONAL_NATIVE_MODULE_ID,
      "electron/index.js": WORKER_DEPLOY_OPTIONAL_NATIVE_MODULE_ID,
      fsevents: WORKER_DEPLOY_OPTIONAL_NATIVE_MODULE_ID,
      kerberos: WORKER_DEPLOY_OPTIONAL_NATIVE_MODULE_ID,
      "utf-8-validate": WORKER_DEPLOY_OPTIONAL_NATIVE_MODULE_ID,
    });
    expect(workerConfig?.outDir).toBe("dist");
    expect(workerConfig?.shims).toBe(true);
    expect(workerConfig?.plugins).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "openclaw:worker-deploy" })]),
    );
    expect(workerConfig?.outputOptions).toMatchObject({
      codeSplitting: false,
      assetFileNames: "worker/[name][extname]",
    });
    expect(receiverConfig?.define).toBeUndefined();
    expect(receiverConfig?.alias).toBeUndefined();
    expect(receiverConfig?.plugins).toBeUndefined();
    expect(receiverConfig?.outputOptions).toEqual({ codeSplitting: false });

    const context = {
      format: "es",
      options: {},
      pkgType: "module",
    } as Parameters<OutExtensions>[0];
    for (const config of [workerConfig, receiverConfig]) {
      expect(config?.dts).toBe(false);
      expect(config?.outDir).toBe("dist");
      expect(config?.shims).toBe(true);
      expect(config?.deps?.onlyBundle).toBe(false);
      expect(config?.deps?.alwaysBundle).toBeTypeOf("function");
      const alwaysBundle = config?.deps?.alwaysBundle;
      if (typeof alwaysBundle !== "function") {
        throw new Error("worker deploy config must define dependency bundling");
      }
      expect(alwaysBundle("json5", undefined)).toBe(true);
      expect(alwaysBundle("node:fs", undefined)).toBe(false);
      expect(config?.outExtensions?.(context)).toEqual({ js: ".mjs", dts: ".d.ts" });
    }
  });

  it("keeps node package artifacts on the declared js and dts extensions", () => {
    const nodePackageConfigs = configs.filter(
      (entry) => entry.fixedExtension === false && !isWorkerBuildConfig(entry),
    );
    expect(nodePackageConfigs).not.toHaveLength(0);

    const context = {
      format: "es",
      options: {},
      pkgType: "module",
    } as Parameters<OutExtensions>[0];

    for (const entry of nodePackageConfigs) {
      expect(entry.outExtensions?.(context)).toEqual({ js: ".js", dts: ".d.ts" });
    }
  });
});

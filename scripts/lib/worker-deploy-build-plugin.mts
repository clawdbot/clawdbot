import fs from "node:fs";
import path from "node:path";

const WORKER_DEPLOY_BUILD_PLUGIN_NAME = "openclaw:worker-deploy";
export const WORKER_DEPLOY_OPTIONAL_NATIVE_MODULE_ID = `${path.resolve("src/worker/worker-deploy-runtime.ts")}?optional-native`;

const PLAYWRIGHT_PACKAGE_INIT = `    packageRoot = import_path9.default.join(__dirname, "..");
    packageJSON = require(import_path9.default.join(packageRoot, "package.json"));
    binPath = import_path9.default.join(packageRoot, "bin");`;
const PLAYWRIGHT_BROWSER_REGISTRY_INIT =
  '    registry = new Registry(require(import_path20.default.join(packageRoot, "browsers.json")));';
const WORKER_BROWSER_RUNTIME_COMPOSITION = `import { createAttachedBrowserToolRuntime } from "../../extensions/browser/runtime-api.js";
export default { createAttachedBrowserToolRuntime };`;
const WORKER_MODEL_NORMALIZATION_COMPOSITION =
  'export { normalizeProviderModelIdWithPlugin as normalizeProviderModelIdWithRuntime } from "../plugins/provider-runtime.js";';
const WORKER_PLAYWRIGHT_RUNTIME = `import * as playwrightCore from "playwright-core";
import { getUserAgent } from "playwright-core/lib/coreBundle";
export function getPlaywrightCore() { return playwrightCore; }
export function getPlaywrightUserAgent() { return getUserAgent(); }`;
const UNDICI_REQUIRE_BOOTSTRAP = [
  'import { createRequire } from "node:module";',
  "const requireUndici = createRequire(import.meta.url);\n",
  'return requireUndici("undici") as typeof import("undici");',
] as const;
const WORKER_UNDICI_IMPORT = 'import * as bundledUndici from "undici";';
const FS_SAFE_NATIVE_DIRECTORY =
  'const bundledNativeDirectory = fileURLToPath(new URL("../dist/native/", import.meta.url));';
const WORKER_FS_SAFE_NATIVE_DIRECTORY =
  'const bundledNativeDirectory = fileURLToPath(new URL("../../dist/native/", import.meta.url));';

/** Composes bundled-plugin runtime and removes dependency package reads from the worker build. */
export function createWorkerDeployBuildPlugin(rootDir = process.cwd()) {
  const playwrightRoot = fs.realpathSync(path.resolve(rootDir, "node_modules/playwright-core"));
  const coreBundlePath = fs.realpathSync(path.join(playwrightRoot, "lib/coreBundle.js"));
  const fsSafeNativePath = fs.realpathSync(
    path.resolve(rootDir, "node_modules/@openclaw/fs-safe/dist/native.js"),
  );
  const browserRuntimeBridgePath = fs.realpathSync(
    path.resolve("src/worker/worker-deploy-browser-runtime.ts"),
  );
  const modelNormalizationBridgePath = fs.realpathSync(
    path.resolve("src/agents/provider-model-normalization.runtime.ts"),
  );
  const playwrightRuntimePath = fs.realpathSync(
    path.resolve("extensions/browser/src/browser/playwright-core.runtime.ts"),
  );
  const undiciDispatcherOptionsPath = fs.realpathSync(
    path.resolve("src/infra/net/undici-dispatcher-options.ts"),
  );
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(playwrightRoot, "package.json"), "utf8"),
  ) as { name: string; version: string };
  const browsersJson = JSON.parse(
    fs.readFileSync(path.join(playwrightRoot, "browsers.json"), "utf8"),
  ) as unknown;
  const replacement = `    packageRoot = __dirname;
    packageJSON = ${JSON.stringify({ name: packageJson.name, version: packageJson.version })};
    binPath = packageRoot;`;

  return {
    name: WORKER_DEPLOY_BUILD_PLUGIN_NAME,
    load(id: string) {
      return id === WORKER_DEPLOY_OPTIONAL_NATIVE_MODULE_ID
        ? 'throw new Error("optional host-native dependency unavailable in portable worker runtime");'
        : null;
    },
    transform(this: { error(message: string): never }, code: string, id: string) {
      let resolvedId: string;
      try {
        resolvedId = fs.realpathSync(path.resolve(id));
      } catch {
        return null;
      }
      if (resolvedId === browserRuntimeBridgePath) {
        return WORKER_BROWSER_RUNTIME_COMPOSITION;
      }
      if (resolvedId === modelNormalizationBridgePath) {
        return WORKER_MODEL_NORMALIZATION_COMPOSITION;
      }
      if (resolvedId === playwrightRuntimePath) {
        return WORKER_PLAYWRIGHT_RUNTIME;
      }
      if (resolvedId === undiciDispatcherOptionsPath) {
        if (UNDICI_REQUIRE_BOOTSTRAP.some((fragment) => !code.includes(fragment))) {
          this.error("undici dispatcher bootstrap changed; update the worker deploy transform");
        }
        return code
          .replace(UNDICI_REQUIRE_BOOTSTRAP[0], WORKER_UNDICI_IMPORT)
          .replace(UNDICI_REQUIRE_BOOTSTRAP[1], "")
          .replace(UNDICI_REQUIRE_BOOTSTRAP[2], "return bundledUndici;");
      }
      if (resolvedId === fsSafeNativePath) {
        if (!code.includes(FS_SAFE_NATIVE_DIRECTORY)) {
          this.error("fs-safe native asset lookup changed; update the worker deploy transform");
        }
        return code.replace(FS_SAFE_NATIVE_DIRECTORY, WORKER_FS_SAFE_NATIVE_DIRECTORY);
      }
      if (
        resolvedId !== coreBundlePath ||
        !id.replaceAll("\\", "/").endsWith("/playwright-core/lib/coreBundle.js")
      ) {
        return null;
      }
      if (
        !code.includes(PLAYWRIGHT_PACKAGE_INIT) ||
        !code.includes(PLAYWRIGHT_BROWSER_REGISTRY_INIT)
      ) {
        this.error("playwright-core package bootstrap changed; update the worker deploy transform");
      }
      return code
        .replace(PLAYWRIGHT_PACKAGE_INIT, replacement)
        .replace(
          PLAYWRIGHT_BROWSER_REGISTRY_INIT,
          `    registry = new Registry(${JSON.stringify(browsersJson)});`,
        );
    },
  };
}

import fs from "node:fs";
import path from "node:path";

export const WORKER_DEPLOY_BUILD_PLUGIN_NAME = "openclaw:worker-deploy";

const PLAYWRIGHT_PACKAGE_INIT = `    packageRoot = import_path9.default.join(__dirname, "..");
    packageJSON = require(import_path9.default.join(packageRoot, "package.json"));
    binPath = import_path9.default.join(packageRoot, "bin");`;
const PLAYWRIGHT_BROWSER_REGISTRY_INIT =
  '    registry = new Registry(require(import_path20.default.join(packageRoot, "browsers.json")));';

/** Removes Playwright's package-manifest runtime read from the standalone worker build. */
export function createWorkerDeployBuildPlugin(rootDir = process.cwd()) {
  const playwrightRoot = fs.realpathSync(path.resolve(rootDir, "node_modules/playwright-core"));
  const coreBundlePath = fs.realpathSync(path.join(playwrightRoot, "lib/coreBundle.js"));
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
    transform(this: { error(message: string): never }, code: string, id: string) {
      if (!id.replaceAll("\\", "/").endsWith("/playwright-core/lib/coreBundle.js")) {
        return null;
      }
      let resolvedId: string;
      try {
        resolvedId = fs.realpathSync(path.resolve(id));
      } catch {
        return null;
      }
      if (resolvedId !== coreBundlePath) {
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

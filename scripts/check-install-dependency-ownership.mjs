import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

const root = realpathSync(process.cwd());
const configured =
  (process.env.PNPM_CONFIG_MODULES_DIR ?? process.env.pnpm_config_modules_dir) || undefined;
const modules = path.resolve(root, configured || "node_modules");
const workspaceModules = path.join(root, "node_modules");

function inspectDirectory(directory, explicitTarget) {
  const entry = lstatSync(directory, { throwIfNoEntry: false });
  if (!entry) {
    return;
  }
  if (entry.isSymbolicLink() && explicitTarget && realpathSync(directory) === explicitTarget) {
    return;
  }
  if (!entry.isDirectory()) {
    throw new Error(
      `Refusing to reconcile dependencies through ${directory}: it is not a physical directory. Preserve the borrowed install and use an independently owned checkout.`,
    );
  }
}

// pnpm can still reconcile workspace modules when its metadata directory is explicit.
inspectDirectory(modules);
const explicitTarget =
  configured && modules !== workspaceModules && lstatSync(modules, { throwIfNoEntry: false })
    ? realpathSync(modules)
    : undefined;
inspectDirectory(workspaceModules, explicitTarget);
for (const directory of new Set([modules, workspaceModules])) {
  inspectDirectory(path.join(directory, ".pnpm"));
}

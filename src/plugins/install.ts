// Public plugin install surface. Source-specific implementation lives in focused modules.
export { installPluginFromInstalledPackageDir } from "./install-installed-package.js";
export { installPluginFromNpmPackArchive } from "./install-npm-pack.js";
export { installPluginFromNpmSpec } from "./install-npm.js";
export { installPluginFromArchive, installPluginFromPath } from "./install-package.js";
export { resolvePluginInstallDir } from "./install-paths.js";
export { PLUGIN_INSTALL_ERROR_CODE, type InstallPluginResult } from "./install-types.js";

// Links a plugin's source-installed dependency packages under its packaged root.
import fs from "node:fs";
import path from "node:path";

/**
 * Link every package installed under `<pluginDir>/node_modules` into `distNodeModules` so
 * dependency lookups rooted at the packaged plugin resolve the plugin-owned install.
 */
export function linkSourcePluginDependencies(pluginDir, distNodeModules) {
  const sourceModules = path.join(pluginDir, "node_modules");
  if (!fs.existsSync(sourceModules)) {
    return;
  }
  const packages = fs.readdirSync(sourceModules).flatMap((name) => {
    if (name.startsWith(".") && name !== ".bin") {
      return [];
    }
    return name.startsWith("@")
      ? fs.readdirSync(path.join(sourceModules, name)).map((child) => path.join(name, child))
      : [name];
  });
  // An outer node_modules junction misresolves pnpm's relative links on Windows.
  // Link canonical package roots individually; keep scopes real and payloads source-owned.
  // Preserve .bin for managed launchers that resolve the plugin's private CLI shim.
  for (const name of packages) {
    const target = path.join(distNodeModules, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const canonical = fs.realpathSync(path.join(sourceModules, name));
    // POSIX release checkouts relocate as a unit; Windows junctions require absolute targets.
    fs.symlinkSync(
      process.platform === "win32" ? canonical : path.relative(path.dirname(target), canonical),
      target,
      "junction",
    );
  }
}

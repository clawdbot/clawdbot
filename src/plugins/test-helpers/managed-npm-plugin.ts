import fs from "node:fs";
import path from "node:path";
import { resolvePluginNpmProjectDir } from "../install-paths.js";

export function writeManagedNpmPlugin(params: {
  stateDir: string;
  packageName: string;
  pluginId: string;
  version: string;
  name?: string;
  dependencySpec?: string;
  layout?: "project" | "legacy";
}): string {
  const npmBaseDir = path.join(params.stateDir, "npm");
  const npmRoot =
    params.layout === "legacy"
      ? npmBaseDir
      : resolvePluginNpmProjectDir({
          npmDir: npmBaseDir,
          packageName: params.packageName,
        });
  const rootManifestPath = path.join(npmRoot, "package.json");
  fs.mkdirSync(npmRoot, { recursive: true });
  const rootManifest = fs.existsSync(rootManifestPath)
    ? (JSON.parse(fs.readFileSync(rootManifestPath, "utf8")) as {
        dependencies?: Record<string, string>;
      })
    : {};
  fs.writeFileSync(
    rootManifestPath,
    JSON.stringify(
      {
        ...rootManifest,
        private: true,
        dependencies: {
          ...rootManifest.dependencies,
          [params.packageName]: params.dependencySpec ?? params.version,
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  const packageDir = path.join(npmRoot, "node_modules", ...params.packageName.split("/"));
  fs.mkdirSync(path.join(packageDir, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({
      name: params.packageName,
      version: params.version,
      openclaw: { extensions: ["./dist/index.js"] },
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(packageDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: params.pluginId,
      ...(params.name ? { name: params.name } : {}),
      configSchema: { type: "object" },
    }),
    "utf8",
  );
  fs.writeFileSync(path.join(packageDir, "dist", "index.js"), "export {};\n", "utf8");
  return packageDir;
}

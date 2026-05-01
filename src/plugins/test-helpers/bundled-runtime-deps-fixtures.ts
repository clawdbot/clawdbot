import fs from "node:fs";
import path from "node:path";

export function writeInstalledRuntimeDepPackage(
  rootDir: string,
  packageName: string,
  version: string,
): void {
  const packageDir = path.join(rootDir, "node_modules", ...packageName.split("/"));
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({ name: packageName, version }),
    "utf8",
  );
  fs.writeFileSync(path.join(packageDir, "index.js"), "export {};\n", "utf8");
}

export function writeGeneratedRuntimeDepsManifest(rootDir: string, specs: readonly string[]): void {
  const dependencies = Object.fromEntries(
    [...specs]
      .toSorted((left, right) => left.localeCompare(right))
      .map((spec) => {
        const atIndex = spec.lastIndexOf("@");
        return [spec.slice(0, atIndex), spec.slice(atIndex + 1)];
      }),
  );
  fs.mkdirSync(rootDir, { recursive: true });
  fs.writeFileSync(
    path.join(rootDir, "package.json"),
    `${JSON.stringify(
      {
        name: "openclaw-runtime-deps-install",
        private: true,
        dependencies,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

export function writeBundledPluginRuntimeDepsPackage(params: {
  packageRoot: string;
  pluginId: string;
  deps: Record<string, string>;
  enabledByDefault?: boolean;
  channels?: string[];
  modelSupport?: { modelPatterns?: string[]; modelPrefixes?: string[] };
  providers?: string[];
  runtimeDependencies?: Record<string, string[]>;
}): string {
  const pluginRoot = path.join(params.packageRoot, "dist", "extensions", params.pluginId);
  fs.mkdirSync(pluginRoot, { recursive: true });
  fs.writeFileSync(
    path.join(pluginRoot, "package.json"),
    JSON.stringify({ dependencies: params.deps }),
  );
  fs.writeFileSync(
    path.join(pluginRoot, "openclaw.plugin.json"),
    JSON.stringify({
      id: params.pluginId,
      enabledByDefault: params.enabledByDefault === true,
      ...(params.channels ? { channels: params.channels } : {}),
      ...(params.modelSupport ? { modelSupport: params.modelSupport } : {}),
      ...(params.providers ? { providers: params.providers } : {}),
      ...(params.runtimeDependencies ? { runtimeDependencies: params.runtimeDependencies } : {}),
    }),
  );
  return pluginRoot;
}

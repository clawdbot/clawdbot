import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonFile } from "./temp-repo.js";

type PublishablePluginSurface = "npm" | "clawhub" | "both" | "clawhub-disabled";

type PublishablePluginFixtureOptions = {
  extensionId?: string;
  version: string;
  publishTo: PublishablePluginSurface;
  bundledDist?: boolean;
  dependency?: {
    packageName: string;
    version: string;
    requireLatest?: boolean;
  };
};

export function writePublishablePluginFixture(
  repoDir: string,
  options: PublishablePluginFixtureOptions,
) {
  const extensionId = options.extensionId ?? "demo-plugin";
  const packageName = `@openclaw/${extensionId}`;
  const packageDir = join(repoDir, "extensions", extensionId);
  const publishToNpm = options.publishTo === "npm" || options.publishTo === "both";
  const publishToClawHub = options.publishTo === "clawhub" || options.publishTo === "both";
  const release = {
    ...(publishToNpm ? { publishToNpm: true } : {}),
    ...(publishToClawHub ? { publishToClawHub: true } : {}),
    ...(options.publishTo === "clawhub-disabled" ? { publishToClawHub: false } : {}),
    ...(options.dependency?.requireLatest
      ? { requireLatestDependencies: [options.dependency.packageName] }
      : {}),
  };
  writeJsonFile(join(packageDir, "package.json"), {
    name: packageName,
    version: options.version,
    type: "module",
    repository: {
      type: "git",
      url: "https://github.com/openclaw/openclaw",
    },
    ...(options.dependency
      ? { dependencies: { [options.dependency.packageName]: options.dependency.version } }
      : {}),
    openclaw: {
      extensions: ["./index.ts"],
      compat: { pluginApi: `>=${options.version}` },
      build: {
        openclawVersion: options.version,
        ...(options.bundledDist ? { bundledDist: true } : {}),
      },
      install: { npmSpec: packageName },
      release,
    },
  });
  const exportName = extensionId.replaceAll(/[-.]/g, "_");
  writeFileSync(join(packageDir, "index.ts"), `export const ${exportName} = 1;\n`);
  writeFileSync(join(packageDir, "README.md"), "# Demo plugin\n");
  return { extensionId, packageDir, packageName };
}

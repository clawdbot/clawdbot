import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { PluginInstallRecord } from "../../src/config/types.plugins.js";
import { isTrustedOfficialPluginInstallRecord } from "../../src/plugins/official-external-install-records.js";

export type PluginInspectFixture = {
  plugin: {
    id: string;
    packageName: string;
    rootDir: string;
    trustedOfficialInstall: boolean;
  };
  install: PluginInstallRecord;
};

export function writePluginInspectFixture(
  binDir: string,
  records: Readonly<Record<string, PluginInstallRecord>>,
  mutate?: (inspections: Record<string, PluginInspectFixture>) => void,
): NodeJS.ProcessEnv {
  const inspections: Record<string, PluginInspectFixture> = {};
  for (const [pluginId, record] of Object.entries(records)) {
    if (!record.installPath || !existsSync(join(record.installPath, "package.json"))) {
      continue;
    }
    const { name: packageName } = JSON.parse(
      readFileSync(join(record.installPath, "package.json"), "utf8"),
    ) as { name: string };
    inspections[pluginId] = {
      plugin: {
        id: pluginId,
        packageName,
        rootDir: record.installPath,
        trustedOfficialInstall: isTrustedOfficialPluginInstallRecord({
          pluginId,
          packageName,
          record,
        }),
      },
      install: { ...record },
    };
  }
  mutate?.(inspections);
  mkdirSync(binDir, { recursive: true });
  const inspectionPath = join(binDir, "plugin-inspections.json");
  writeFileSync(inspectionPath, JSON.stringify(inspections));
  const fixtureScript = join(binDir, "openclaw");
  writeFileSync(
    fixtureScript,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.join(" ") === "plugins install --help") {
  console.log("  --accept-capabilities  Accept capabilities");
} else if (args.length === 4 && args[0] === "plugins" && args[1] === "inspect" && args[3] === "--json") {
  const inspection = JSON.parse(fs.readFileSync(${JSON.stringify(inspectionPath)}, "utf8"))[args[2]];
  if (!inspection) process.exit(98);
  console.log(JSON.stringify(inspection));
} else {
  process.exit(97);
}
`,
    { mode: 0o755 },
  );
  // Keep Bash's executable fixture, but let Node callers use an absolute executable on Windows.
  const preloadPath = join(binDir, "plugin-inspect-preload.mjs");
  writeFileSync(
    preloadPath,
    `import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const execFileSync = childProcess.execFileSync;
childProcess.execFileSync = (file, args, options) => {
  if (file === "openclaw") {
    return execFileSync(process.execPath, [${JSON.stringify(fixtureScript)}, ...args], options);
  }
  return execFileSync(file, args, options);
};
syncBuiltinESMExports();
`,
  );
  return {
    NODE_OPTIONS:
      `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(preloadPath).href}`.trim(),
    PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
  };
}

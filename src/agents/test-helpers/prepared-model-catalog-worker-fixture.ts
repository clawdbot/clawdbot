import fs from "node:fs";
import path from "node:path";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";

export function writeSyntheticAuthDiscoveryFixture(params: {
  root: string;
  pluginDir: string;
  harnessId: string;
  unrelatedId: string;
}): void {
  const probePath = path.join(params.root, "synthetic-auth-probes.txt");
  fs.writeFileSync(
    path.join(params.pluginDir, "provider-discovery.cjs"),
    `const fs = require("node:fs");
module.exports = {
  id: ${JSON.stringify(params.harnessId)},
  hookAliases: [${JSON.stringify(params.unrelatedId)}],
  label: "Worker catalog fixture synthetic auth",
  auth: [],
  resolveSyntheticAuth({ provider }) {
    fs.appendFileSync(${JSON.stringify(probePath)}, provider + "\\n");
    return provider === ${JSON.stringify(params.harnessId)}
      ? { apiKey: "native-login-not-real", source: "fixture native login", mode: "oauth" }
      : undefined;
  },
};
`,
    "utf8",
  );
}

export function markPluginMetadataSnapshotProvided(
  snapshot: PluginMetadataSnapshot,
): PluginMetadataSnapshot {
  return { ...snapshot, registrySource: "provided", registryDiagnostics: [] };
}

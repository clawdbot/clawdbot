import { realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export const minimalManifest = {
  schemaVersion: 1,
  agent: { id: "demo-agent", name: "Demo Agent" },
};

export const pluginSetupReadiness = {
  ready: false,
  requirements: [
    {
      kind: "plugin-setup" as const,
      plugin: "market-data",
      provider: "market-data",
      envVars: ["MARKET_DATA_TOKEN"],
      authMethods: ["token"],
    },
  ],
};

export async function canonicalFuturePath(target: string): Promise<string> {
  return join(await realpath(dirname(target)), basename(target));
}

export async function writeManifestFile(
  tempDirs: { make(prefix: string): string },
  value: unknown = minimalManifest,
): Promise<string> {
  const dir = tempDirs.make("openclaw-claws-cli-");
  const path = join(dir, "openclaw.claw.json");
  await writeFile(path, JSON.stringify(value), "utf8");
  return path;
}

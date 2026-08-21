import fs from "node:fs";
import path from "node:path";

const PLUGIN_SPECS = [
  ["acpx", true],
  ["anthropic", true],
  ["browser", true],
  ["codex", false],
  ["file-transfer", true],
  ["google-meet", true],
  ["logbook", false],
  ["ollama", true],
  ["opencode", true],
  ["teams-meetings", true],
  ["zoom-meetings", true],
] as const;

/** Injects audited bundled plugin entrypoints only into the signed macOS worker build. */
export function createMacNodeHostWorkerBuildPlugin(rootDir = process.cwd()) {
  const definitionsPath = fs.realpathSync(
    path.resolve(rootDir, "src/node-host/mac-node-host-plugin-definitions.ts"),
  );
  return {
    name: "openclaw:mac-node-host-worker",
    transform(code: string, id: string) {
      let resolved: string;
      try {
        resolved = fs.realpathSync(path.resolve(id));
      } catch {
        return null;
      }
      if (resolved !== definitionsPath) {
        return null;
      }
      if (!code.includes("MAC_NODE_HOST_PLUGIN_DEFINITIONS")) {
        throw new Error("macOS node-host plugin placeholder contract changed");
      }
      const imports = PLUGIN_SPECS.map(
        ([pluginId], index) =>
          `import plugin${index} from ${JSON.stringify(`../../extensions/${pluginId}/index.js`)};`,
      );
      const definitions = PLUGIN_SPECS.map(
        ([, enabledByDefault], index) =>
          `{ definition: plugin${index}, enabledByDefault: ${enabledByDefault} }`,
      );
      return [
        ...imports,
        `export const MAC_NODE_HOST_PLUGIN_DEFINITIONS = [${definitions.join(",")}];`,
      ].join("\n");
    },
  };
}

import fs from "node:fs";
import path from "node:path";

const [root, alias, ...plugins] = process.argv.slice(2);

if (!root || !alias || plugins.length === 0) {
  throw new Error("usage: write-marketplace.mjs <root> <alias> <pluginId>...");
}

fs.mkdirSync(path.join(root, ".claude-plugin"), { recursive: true });
fs.mkdirSync(path.join(process.env.HOME, ".claude", "plugins"), { recursive: true });
fs.writeFileSync(
  path.join(root, ".claude-plugin", "marketplace.json"),
  `${JSON.stringify(
    {
      name: "Release Fixture Marketplace",
      version: "1.0.0",
      plugins: plugins.map((pluginId) => ({
        name: pluginId,
        version: "0.0.1",
        description: `${pluginId} release fixture`,
        source: { type: "path", path: `./plugins/${pluginId}` },
      })),
    },
    null,
    2,
  )}\n`,
);
fs.writeFileSync(
  path.join(process.env.HOME, ".claude", "plugins", "known_marketplaces.json"),
  `${JSON.stringify(
    {
      [alias]: {
        installLocation: root,
        source: { type: "github", repo: "openclaw/release-fixture-marketplace" },
      },
    },
    null,
    2,
  )}\n`,
);

import fs from "node:fs";

const [scenario, configPath] = process.argv.slice(2);
if (!scenario || !configPath) {
  throw new Error("usage: write-config.mjs <reset|skills> <config-path>");
}

const config = {
  reset: {
    meta: {},
    agents: { defaults: { workspace: "/root/old" } },
    gateway: { mode: "remote", remote: { url: "ws://old.example:18789", token: "old-token" } },
  },
  skills: { meta: {}, skills: { allowBundled: ["__none__"], install: { nodeManager: "bun" } } },
}[scenario];
if (!config) {
  throw new Error(`unknown config scenario: ${scenario}`);
}

fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

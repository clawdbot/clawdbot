import fs from "node:fs";
import path from "node:path";

const [pluginDir] = process.argv.slice(2);
if (!pluginDir) {
  throw new Error("usage: write-load-failure-fixture.mjs <plugin-dir>");
}

const writeJson = (filename, contents) =>
  fs.writeFileSync(path.join(pluginDir, filename), `${JSON.stringify(contents, null, 2)}\n`);

fs.mkdirSync(pluginDir, { recursive: true });
writeJson("package.json", {
  name: "@openclaw/load-failure-alpha",
  version: "2026.4.21",
  private: true,
  type: "module",
  openclaw: { extensions: ["./index.js"], setupEntry: "./setup-entry.js" },
});
writeJson("openclaw.plugin.json", {
  id: "load-failure-alpha",
  channels: ["load-failure-alpha"],
  configSchema: { type: "object", additionalProperties: false, properties: {} },
});
fs.writeFileSync(
  path.join(pluginDir, "index.js"),
  `export default {
  kind: "bundled-channel-entry", id: "load-failure-alpha", name: "Load Failure Alpha", description: "Load Failure Alpha", register() {},
  loadChannelSecrets() { globalThis.__loadFailureSecrets = (globalThis.__loadFailureSecrets ?? 0) + 1; throw new Error("synthetic channel secrets failure"); },
  loadChannelPlugin() { globalThis.__loadFailurePlugin = (globalThis.__loadFailurePlugin ?? 0) + 1; throw new Error("synthetic channel plugin failure"); }
};
`,
);
fs.writeFileSync(
  path.join(pluginDir, "setup-entry.js"),
  `export default {
  kind: "bundled-channel-setup-entry",
  loadSetupSecrets() { globalThis.__loadFailureSetupSecrets = (globalThis.__loadFailureSetupSecrets ?? 0) + 1; throw new Error("synthetic setup secrets failure"); },
  loadSetupPlugin() { globalThis.__loadFailureSetup = (globalThis.__loadFailureSetup ?? 0) + 1; throw new Error("synthetic setup plugin failure"); }
};
`,
);

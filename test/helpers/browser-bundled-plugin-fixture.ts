import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BROWSER_FIXTURE_MANIFEST = {
  id: "browser",
  enabledByDefault: true,
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
};

const BROWSER_FIXTURE_ENTRY = `module.exports = {
  id: "browser",
  name: "Browser",
  description: "Bundled browser fixture plugin",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
  register(api) {
    api.registerTool((ctx) => ({
      name: "browser",
      label: "browser",
      description: "browser fixture tool",
      parameters: {
        type: "object",
        properties: {},
      },
      async execute() {
        return {
          content: [{ type: "text", text: "ok" }],
          details: {
            workspaceOnly: ctx.fsPolicy?.workspaceOnly ?? null,
          },
        };
      },
    }));
    api.registerCli(({ program }) => {
      program.command("browser");
    }, { commands: ["browser"] });
    api.registerGatewayMethod("browser.request", async () => ({ ok: true }), {
      scope: "operator.admin",
    });
    api.registerService({
      id: "browser-control",
      start() {},
    });
  },
};`;

export function createBundledBrowserPluginFixture(): { rootDir: string; cleanup: () => void } {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-browser-bundled-"));
  const pluginDir = path.join(rootDir, "browser");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify(BROWSER_FIXTURE_MANIFEST, null, 2),
    "utf8",
  );
  fs.writeFileSync(path.join(pluginDir, "index.js"), BROWSER_FIXTURE_ENTRY, "utf8");
  return {
    rootDir,
    cleanup() {
      fs.rmSync(rootDir, { recursive: true, force: true });
    },
  };
}

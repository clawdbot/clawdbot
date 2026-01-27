import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { withTempHome } from "./test-helpers.js";

async function writePluginFixture(params: {
  dir: string;
  id: string;
  schema: Record<string, unknown>;
  channels?: string[];
}) {
  await fs.mkdir(params.dir, { recursive: true });
  await fs.writeFile(
    path.join(params.dir, "index.js"),
    `export default { id: "${params.id}", register() {} };`,
    "utf-8",
  );
  const manifest: Record<string, unknown> = {
    id: params.id,
    configSchema: params.schema,
  };
  if (params.channels) {
    manifest.channels = params.channels;
  }
  await fs.writeFile(
    path.join(params.dir, "moltbot.plugin.json"),
    JSON.stringify(manifest, null, 2),
    "utf-8",
  );
}

describe("config plugin validation", () => {
  it("rejects missing plugin load paths", async () => {
    await withTempHome(async (home) => {
      process.env.CLAWDBOT_STATE_DIR = path.join(home, ".clawdbot");
      vi.resetModules();
      const { validateConfigObjectWithPlugins } = await import("./config.js");
      const missingPath = path.join(home, "missing-plugin");
      const res = validateConfigObjectWithPlugins({
        agents: { list: [{ id: "pi" }] },
        plugins: { enabled: false, load: { paths: [missingPath] } },
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        const hasIssue = res.issues.some(
          (issue) =>
            issue.path === "plugins.load.paths" && issue.message.includes("plugin path not found"),
        );
        expect(hasIssue).toBe(true);
      }
    });
  });

  it("rejects missing plugin ids in entries", async () => {
    await withTempHome(async (home) => {
      process.env.CLAWDBOT_STATE_DIR = path.join(home, ".clawdbot");
      vi.resetModules();
      const { validateConfigObjectWithPlugins } = await import("./config.js");
      const res = validateConfigObjectWithPlugins({
        agents: { list: [{ id: "pi" }] },
        plugins: { enabled: false, entries: { "missing-plugin": { enabled: true } } },
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.issues).toContainEqual({
          path: "plugins.entries.missing-plugin",
          message: "plugin not found: missing-plugin",
        });
      }
    });
  });

  it("rejects missing plugin ids in allow/deny/slots", async () => {
    await withTempHome(async (home) => {
      process.env.CLAWDBOT_STATE_DIR = path.join(home, ".clawdbot");
      vi.resetModules();
      const { validateConfigObjectWithPlugins } = await import("./config.js");
      const res = validateConfigObjectWithPlugins({
        agents: { list: [{ id: "pi" }] },
        plugins: {
          enabled: false,
          allow: ["missing-allow"],
          deny: ["missing-deny"],
          slots: { memory: "missing-slot" },
        },
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.issues).toEqual(
          expect.arrayContaining([
            { path: "plugins.allow", message: "plugin not found: missing-allow" },
            { path: "plugins.deny", message: "plugin not found: missing-deny" },
            { path: "plugins.slots.memory", message: "plugin not found: missing-slot" },
          ]),
        );
      }
    });
  });

  it("surfaces plugin config diagnostics", async () => {
    await withTempHome(async (home) => {
      process.env.CLAWDBOT_STATE_DIR = path.join(home, ".clawdbot");
      const pluginDir = path.join(home, "bad-plugin");
      await writePluginFixture({
        dir: pluginDir,
        id: "bad-plugin",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            value: { type: "boolean" },
          },
          required: ["value"],
        },
      });

      vi.resetModules();
      const { validateConfigObjectWithPlugins } = await import("./config.js");
      const res = validateConfigObjectWithPlugins({
        agents: { list: [{ id: "pi" }] },
        plugins: {
          enabled: true,
          load: { paths: [pluginDir] },
          entries: { "bad-plugin": { config: { value: "nope" } } },
        },
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        const hasIssue = res.issues.some(
          (issue) =>
            issue.path === "plugins.entries.bad-plugin.config" &&
            issue.message.includes("invalid config"),
        );
        expect(hasIssue).toBe(true);
      }
    });
  });

  it("accepts known plugin ids", async () => {
    await withTempHome(async (home) => {
      process.env.CLAWDBOT_STATE_DIR = path.join(home, ".clawdbot");
      vi.resetModules();
      const { validateConfigObjectWithPlugins } = await import("./config.js");
      const res = validateConfigObjectWithPlugins({
        agents: { list: [{ id: "pi" }] },
        plugins: { enabled: false, entries: { discord: { enabled: true } } },
      });
      expect(res.ok).toBe(true);
    });
  });

  it("accepts plugin heartbeat targets", async () => {
    await withTempHome(async (home) => {
      process.env.CLAWDBOT_STATE_DIR = path.join(home, ".clawdbot");
      const pluginDir = path.join(home, "bluebubbles-plugin");
      await writePluginFixture({
        dir: pluginDir,
        id: "bluebubbles-plugin",
        channels: ["bluebubbles"],
        schema: { type: "object" },
      });

      vi.resetModules();
      const { validateConfigObjectWithPlugins } = await import("./config.js");
      const res = validateConfigObjectWithPlugins({
        agents: { defaults: { heartbeat: { target: "bluebubbles" } }, list: [{ id: "pi" }] },
        plugins: { enabled: false, load: { paths: [pluginDir] } },
      });
      expect(res.ok).toBe(true);
    });
  });

  it("rejects unknown heartbeat targets", async () => {
    await withTempHome(async (home) => {
      process.env.CLAWDBOT_STATE_DIR = path.join(home, ".clawdbot");
      vi.resetModules();
      const { validateConfigObjectWithPlugins } = await import("./config.js");
      const res = validateConfigObjectWithPlugins({
        agents: { defaults: { heartbeat: { target: "not-a-channel" } }, list: [{ id: "pi" }] },
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.issues).toContainEqual({
          path: "agents.defaults.heartbeat.target",
          message: "unknown heartbeat target: not-a-channel",
        });
      }
    });
  });
});

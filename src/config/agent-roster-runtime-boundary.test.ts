import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { loadConfig, readConfigFileSnapshot, resetConfigRuntimeState } from "./config.js";

describe("persisted agent roster boundary", () => {
  it("constructs a canonical roster when the config file does not exist", async () => {
    await withTempHome(async () => {
      resetConfigRuntimeState();

      const snapshot = await readConfigFileSnapshot();

      expect(snapshot.exists).toBe(false);
      expect(snapshot.valid).toBe(true);
      expect(snapshot.sourceConfig).toEqual({
        agents: { entries: { main: { default: true } } },
      });
      expect(loadConfig()).toMatchObject({
        agents: { entries: { main: { default: true } } },
      });
    });
  });

  it.each([
    {
      label: "legacy agents.list",
      config: { agents: { list: [{ id: "ops", default: true }] } },
    },
    { label: "missing roster", config: { gateway: { mode: "local" } } },
    { label: "empty roster", config: { agents: { entries: {} } } },
    {
      label: "zero defaults",
      config: { agents: { entries: { ops: {}, research: {} } } },
    },
    {
      label: "multiple defaults",
      config: {
        agents: {
          entries: { ops: { default: true }, research: { default: true } },
        },
      },
    },
  ])("rejects $label without rewriting authored state", async ({ config }) => {
    await withTempHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const raw = JSON.stringify(config);
      await fs.writeFile(configPath, raw);
      resetConfigRuntimeState();

      const snapshot = await readConfigFileSnapshot();

      expect(snapshot.valid).toBe(false);
      expect(snapshot.sourceConfig).toEqual(config);
      expect(await fs.readFile(configPath, "utf8")).toBe(raw);
      expect(() => loadConfig()).toThrow(expect.objectContaining({ code: "INVALID_CONFIG" }));
    });
  });

  it("points a rosterless persisted config to Doctor", async () => {
    await withTempHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, JSON.stringify({ gateway: { mode: "local" } }));
      resetConfigRuntimeState();

      expect(() => loadConfig()).toThrow(/openclaw doctor --fix/u);
    });
  });
});

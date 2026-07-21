import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { readConfigFileSnapshot, resetConfigRuntimeState } from "./config.js";
import { migratePersistedImplicitMainRoster } from "./legacy.js";

describe("persisted implicit-main roster migration", () => {
  it("writes main for a persisted pre-roster config", async () => {
    await withTempHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, JSON.stringify({ gateway: { mode: "local" } }));
      await fs.chmod(configPath, 0o600);
      resetConfigRuntimeState();

      const snapshot = await readConfigFileSnapshot();

      expect(snapshot.sourceConfig.agents?.list).toEqual([{ id: "main", default: true }]);
      expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toMatchObject({
        agents: { list: [{ id: "main", default: true }] },
      });
      expect((await fs.stat(configPath)).mode & 0o777).toBe(0o600);
    });
  });

  it("leaves a missing config as a truly fresh empty roster", async () => {
    await withTempHome(async () => {
      resetConfigRuntimeState();
      const snapshot = await readConfigFileSnapshot();
      expect(snapshot.exists).toBe(false);
      expect(snapshot.sourceConfig.agents?.list).toBeUndefined();
    });
  });

  it("preserves malformed agents values for validation", () => {
    expect(migratePersistedImplicitMainRoster({ agents: "invalid" })).toEqual({
      config: { agents: "invalid" },
      changed: false,
    });
  });
});

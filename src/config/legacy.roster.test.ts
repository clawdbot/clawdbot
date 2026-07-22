import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { readConfigFileSnapshot, resetConfigRuntimeState } from "./config.js";
import { migratePersistedImplicitMainRoster } from "./legacy.js";

describe("persisted implicit-main roster migration", () => {
  it("normalizes a commented pre-roster config in memory without rewriting it", async () => {
    await withTempHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const raw = `// operator comment\n{ gateway: { mode: "local" } }\n`;
      await fs.writeFile(configPath, raw);
      resetConfigRuntimeState();

      const snapshot = await readConfigFileSnapshot();

      expect(snapshot.sourceConfig.agents?.list).toEqual([{ id: "main", default: true }]);
      expect(await fs.readFile(configPath, "utf8")).toBe(raw);
    });
  });

  it("injects main into the in-memory config when no file exists", async () => {
    await withTempHome(async () => {
      resetConfigRuntimeState();
      const snapshot = await readConfigFileSnapshot();
      expect(snapshot.exists).toBe(false);
      expect(snapshot.sourceConfig.agents?.list).toEqual([{ id: "main", default: true }]);
    });
  });

  it("retains include-resolved roster provenance before migration", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".openclaw");
      const configPath = path.join(configDir, "openclaw.json");
      const includePath = path.join(configDir, "included.json");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(configPath, JSON.stringify({ $include: "./included.json" }));

      await fs.writeFile(
        includePath,
        JSON.stringify({ channels: { telegram: { enabled: true } } }),
      );
      resetConfigRuntimeState();
      const channelsSnapshot = await readConfigFileSnapshot();
      expect(channelsSnapshot.sourceConfigBeforeMigrations?.agents?.list).toBeUndefined();
      expect(channelsSnapshot.sourceConfig.agents?.list).toEqual([{ id: "main", default: true }]);

      await fs.writeFile(
        includePath,
        JSON.stringify({ agents: { list: [{ id: "ops", default: true }] } }),
      );
      resetConfigRuntimeState();
      const rosterSnapshot = await readConfigFileSnapshot();
      expect(rosterSnapshot.sourceConfigBeforeMigrations?.agents?.list).toEqual([
        { id: "ops", default: true },
      ]);
      expect(rosterSnapshot.sourceConfig.agents?.list).toEqual([{ id: "ops", default: true }]);
    });
  });

  it("preserves malformed agents values for validation", () => {
    expect(migratePersistedImplicitMainRoster({ agents: "invalid" })).toEqual({
      config: { agents: "invalid" },
      changed: false,
      diagnostics: [],
    });
  });

  it("migrates a persisted empty roster to explicit main", async () => {
    await withTempHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, JSON.stringify({ agents: { list: [] } }));
      resetConfigRuntimeState();

      const snapshot = await readConfigFileSnapshot();

      expect(snapshot.sourceConfig.agents?.list).toEqual([{ id: "main", default: true }]);
      expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toEqual({ agents: { list: [] } });
    });
  });

  it.each([
    {
      label: "missing default",
      list: [{ id: "ops" }, { id: "research" }],
      expected: [{ id: "ops", default: true }, { id: "research" }],
    },
    {
      label: "duplicate defaults",
      list: [{ id: "ops" }, { id: "research", default: true }, { id: "writer", default: true }],
      expected: [{ id: "ops" }, { id: "research", default: true }, { id: "writer" }],
    },
    {
      label: "false default markers",
      list: [
        { id: "ops", default: false },
        { id: "research", default: false },
      ],
      expected: [{ id: "ops", default: true }, { id: "research" }],
    },
  ])("normalizes $label markers in memory", async ({ list, expected }) => {
    await withTempHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, JSON.stringify({ agents: { list } }));
      resetConfigRuntimeState();

      const snapshot = await readConfigFileSnapshot();

      expect(snapshot.valid).toBe(true);
      expect(snapshot.sourceConfig.agents?.list).toEqual(expected);
      expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toEqual({
        agents: { list },
      });
    });
  });

  it("marks the first object entry and leaves wholly malformed lists unchanged", () => {
    expect(migratePersistedImplicitMainRoster({ agents: { list: [null, { id: "ops" }] } })).toEqual(
      {
        config: { agents: { list: [null, { id: "ops", default: true }] } },
        changed: true,
        diagnostics: ["Migrated agents.list by marking the first entry as default."],
      },
    );
    const malformed = { agents: { list: [null, "invalid"] } };
    expect(migratePersistedImplicitMainRoster(malformed)).toEqual({
      config: malformed,
      changed: false,
      diagnostics: [],
    });
    const invalidMarker = { agents: { list: [{ id: "ops", default: "yes" }] } };
    expect(migratePersistedImplicitMainRoster(invalidMarker)).toEqual({
      config: invalidMarker,
      changed: false,
      diagnostics: [],
    });
  });

  it("leaves non-boolean default markers for schema validation", async () => {
    await withTempHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        JSON.stringify({ agents: { list: [{ id: "ops", default: "yes" }] } }),
      );
      resetConfigRuntimeState();

      const snapshot = await readConfigFileSnapshot();

      expect(snapshot.valid).toBe(false);
      expect(snapshot.issues).toContainEqual(
        expect.objectContaining({ path: "agents.list.0.default" }),
      );
    });
  });
});

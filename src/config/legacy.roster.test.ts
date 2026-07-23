import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { configIncludeOwnsAgentRoster } from "./agent-roster-provenance.js";
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

      expect(snapshot.sourceConfig.agents?.entries).toEqual({ main: { default: true } });
      expect(await fs.readFile(configPath, "utf8")).toBe(raw);
    });
  });

  it("injects main into the in-memory config when no file exists", async () => {
    await withTempHome(async () => {
      resetConfigRuntimeState();
      const snapshot = await readConfigFileSnapshot();
      expect(snapshot.exists).toBe(false);
      expect(snapshot.sourceConfig.agents?.entries).toEqual({ main: { default: true } });
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
      expect(channelsSnapshot.sourceConfigBeforeMigrations?.agents?.entries).toBeUndefined();
      expect(channelsSnapshot.sourceConfig.agents?.entries).toEqual({ main: { default: true } });

      await fs.writeFile(
        includePath,
        JSON.stringify({ agents: { list: [{ id: "ops", default: true }] } }),
      );
      resetConfigRuntimeState();
      const rosterSnapshot = await readConfigFileSnapshot();
      expect(rosterSnapshot.sourceConfigBeforeMigrations?.agents?.list).toEqual([
        { id: "ops", default: true },
      ]);
      expect(rosterSnapshot.sourceConfig.agents?.entries).toEqual({
        ops: { default: true },
      });
    });
  });

  it("tracks nested mixed roster includes at the entries boundary", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".openclaw");
      const configPath = path.join(configDir, "openclaw.json");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        configPath,
        JSON.stringify({
          $include: "./base.json",
          agents: { entries: { main: { default: true } } },
        }),
      );
      await fs.writeFile(
        path.join(configDir, "base.json"),
        JSON.stringify({ agents: { entries: { $include: "./entries.json" } } }),
      );
      await fs.writeFile(path.join(configDir, "entries.json"), JSON.stringify({ ops: {} }));
      resetConfigRuntimeState();

      const snapshot = await readConfigFileSnapshot();

      expect(snapshot.sourceConfigBeforeMigrations?.agents?.entries).toEqual({
        main: { default: true },
        ops: {},
      });
      expect(configIncludeOwnsAgentRoster(snapshot)).toBe(true);
    });
  });

  it("keeps an unrelated ancestor include from owning a locally authored roster", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".openclaw");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "openclaw.json"),
        JSON.stringify({
          $include: "./channels.json",
          agents: { entries: {} },
        }),
      );
      await fs.writeFile(
        path.join(configDir, "channels.json"),
        JSON.stringify({ channels: { telegram: { enabled: true } } }),
      );
      resetConfigRuntimeState();

      const snapshot = await readConfigFileSnapshot();

      expect(snapshot.includeProvenance?.agentRoster).toBe(false);
      expect(configIncludeOwnsAgentRoster(snapshot)).toBe(false);
    });
  });

  it("records an identical ancestor roster contribution as include-owned", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".openclaw");
      const entries = { main: { default: true } };
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "openclaw.json"),
        JSON.stringify({ $include: "./base.json", agents: { entries } }),
      );
      await fs.writeFile(
        path.join(configDir, "base.json"),
        JSON.stringify({ agents: { entries } }),
      );
      resetConfigRuntimeState();

      const snapshot = await readConfigFileSnapshot();

      expect(snapshot.includeProvenance?.agentRoster).toBe(true);
      expect(configIncludeOwnsAgentRoster(snapshot)).toBe(true);
    });
  });

  it("keeps an entry-internal identity include locally roster-owned", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".openclaw");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "openclaw.json"),
        JSON.stringify({
          agents: {
            entries: {
              main: {
                default: true,
                identity: { $include: "./identity.json" },
              },
            },
          },
        }),
      );
      await fs.writeFile(path.join(configDir, "identity.json"), JSON.stringify({ name: "Main" }));
      resetConfigRuntimeState();

      const snapshot = await readConfigFileSnapshot();

      expect(snapshot.includeProvenance?.agentRoster).toBe(false);
      expect(configIncludeOwnsAgentRoster(snapshot)).toBe(false);
    });
  });

  it("records a legacy list id include as roster-owned", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".openclaw");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "openclaw.json"),
        JSON.stringify({
          agents: {
            list: [{ id: { $include: "./agent-id.json" }, default: true }],
          },
        }),
      );
      await fs.writeFile(path.join(configDir, "agent-id.json"), JSON.stringify("10"));
      resetConfigRuntimeState();

      const snapshot = await readConfigFileSnapshot();

      expect(snapshot.sourceConfigBeforeMigrations?.agents?.list?.[0]?.id).toBe("10");
      expect(snapshot.includeProvenance?.agentRoster).toBe(true);
      expect(configIncludeOwnsAgentRoster(snapshot)).toBe(true);
    });
  });

  it("preserves malformed agents values for validation", () => {
    expect(migratePersistedImplicitMainRoster({ agents: "invalid" })).toEqual({
      config: { agents: "invalid" },
      changed: false,
      diagnostics: [],
    });
  });

  it("converts a legacy list roster before applying default normalization", () => {
    expect(
      migratePersistedImplicitMainRoster({
        agents: {
          defaults: { workspace: "/srv/ops" },
          list: [
            { id: "ops", workspace: "/srv/ops" },
            { id: "writer", default: true },
          ],
        },
      }),
    ).toEqual({
      config: {
        agents: {
          defaults: { workspace: "/srv/ops" },
          entries: {
            ops: { workspace: "/srv/ops" },
            writer: { default: true },
          },
        },
      },
      changed: true,
      diagnostics: ["Moved agents.list to keyed agents.entries."],
    });
  });

  it.each([
    {
      label: "missing default",
      list: [{ id: "10" }, { id: "2" }],
    },
    {
      label: "duplicate defaults",
      list: [
        { id: "10", default: true },
        { id: "2", default: true },
      ],
    },
  ])("preserves original list order for numeric ids with $label", ({ list }) => {
    const migrated = migratePersistedImplicitMainRoster({ agents: { list } });
    expect(migrated.changed).toBe(true);
    expect(migrated.config).toMatchObject({
      agents: {
        entries: {
          "2": {},
          "10": { default: true },
        },
      },
    });
  });

  it("preserves a __proto__ agent as an own keyed entry", () => {
    const migrated = migratePersistedImplicitMainRoster({
      agents: { list: [{ id: "__proto__" }] },
    });
    const config = migrated.config as {
      agents: { entries: Record<string, { default?: boolean }> };
    };

    expect(Object.hasOwn(config.agents.entries, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(config.agents.entries, "__proto__")?.value).toEqual({
      default: true,
    });
  });

  it("leaves malformed legacy list entries for schema validation", () => {
    const malformed = { agents: { list: [null, { id: "ops", default: true }] } };
    expect(migratePersistedImplicitMainRoster(malformed)).toEqual({
      config: malformed,
      changed: false,
      diagnostics: [],
    });
  });

  it.each([
    { list: [{ default: true }] },
    { list: [{ id: "" }] },
    { list: [{ id: "Ops" }] },
    { list: [{ id: "ops" }, { id: "ops" }] },
  ])("leaves invalid or colliding legacy ids for schema validation", ({ list }) => {
    const raw = { agents: { list } };
    expect(migratePersistedImplicitMainRoster(raw)).toEqual({
      config: raw,
      changed: false,
      diagnostics: [],
    });
  });

  it("migrates a persisted empty roster to explicit main", async () => {
    await withTempHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, JSON.stringify({ agents: { entries: {} } }));
      resetConfigRuntimeState();

      const snapshot = await readConfigFileSnapshot();

      expect(snapshot.sourceConfig.agents?.entries).toEqual({ main: { default: true } });
      expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toEqual({
        agents: { entries: {} },
      });
    });
  });

  it.each([
    {
      label: "missing default",
      entries: { ops: {}, research: {} },
      expected: { ops: { default: true }, research: {} },
    },
    {
      label: "duplicate defaults",
      entries: { ops: {}, research: { default: true }, writer: { default: true } },
      expected: { ops: {}, research: { default: true }, writer: {} },
    },
    {
      label: "false default markers",
      entries: { ops: { default: false }, research: { default: false } },
      expected: { ops: { default: true }, research: {} },
    },
  ])("normalizes $label markers in memory", async ({ entries, expected }) => {
    await withTempHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, JSON.stringify({ agents: { entries } }));
      resetConfigRuntimeState();

      const snapshot = await readConfigFileSnapshot();

      expect(snapshot.valid).toBe(true);
      expect(snapshot.sourceConfig.agents?.entries).toEqual(expected);
      expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toEqual({
        agents: { entries },
      });
    });
  });

  it("marks the first object entry and leaves wholly malformed maps unchanged", () => {
    expect(
      migratePersistedImplicitMainRoster({ agents: { entries: { invalid: null, ops: {} } } }),
    ).toEqual({
      config: { agents: { entries: { invalid: null, ops: { default: true } } } },
      changed: true,
      diagnostics: ['Migrated agents.entries by marking "ops" as default.'],
    });
    const malformed = { agents: { entries: { first: null, second: "invalid" } } };
    expect(migratePersistedImplicitMainRoster(malformed)).toEqual({
      config: malformed,
      changed: false,
      diagnostics: [],
    });
    const invalidMarker = { agents: { entries: { ops: { default: "yes" } } } };
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
        JSON.stringify({ agents: { entries: { ops: { default: "yes" } } } }),
      );
      resetConfigRuntimeState();

      const snapshot = await readConfigFileSnapshot();

      expect(snapshot.valid).toBe(false);
      expect(snapshot.issues).toContainEqual(
        expect.objectContaining({ path: "agents.entries.ops.default" }),
      );
    });
  });
});

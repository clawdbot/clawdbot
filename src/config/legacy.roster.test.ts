import fsNode from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { createConfigIO, readConfigFileSnapshot, resetConfigRuntimeState } from "./config.js";
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
      diagnostics: [],
    });
  });

  it("preserves a persisted explicit empty new-world roster", async () => {
    await withTempHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, JSON.stringify({ agents: { list: [] } }));
      resetConfigRuntimeState();

      const snapshot = await readConfigFileSnapshot();

      expect(snapshot.sourceConfig.agents?.list).toEqual([]);
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
  ])("persists repaired $label markers before validation", async ({ list, expected }) => {
    await withTempHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, JSON.stringify({ agents: { list } }));
      resetConfigRuntimeState();

      const snapshot = await readConfigFileSnapshot();

      expect(snapshot.valid).toBe(true);
      expect(snapshot.sourceConfig.agents?.list).toEqual(expected);
      expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toEqual({
        agents: { list: expected },
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
  });

  it("rereads a concurrent edit observed after taking the migration lock", async () => {
    await withTempHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, JSON.stringify({ gateway: { mode: "local" } }));
      const concurrentRaw = JSON.stringify({ agents: { list: [{ id: "ops", default: true }] } });
      let configReads = 0;
      const injectedFs = {
        ...fsNode,
        readFileSync: ((target: fsNode.PathOrFileDescriptor, options?: unknown) => {
          if (target === configPath && configReads++ === 1) {
            fsNode.writeFileSync(configPath, concurrentRaw);
          }
          return fsNode.readFileSync(target, options as never);
        }) as typeof fsNode.readFileSync,
      } as typeof fsNode;
      const io = createConfigIO({
        configPath,
        env: { HOME: home },
        fs: injectedFs,
        homedir: () => home,
      });

      const snapshot = await io.readConfigFileSnapshot();

      expect(snapshot.sourceConfig.agents?.list).toEqual([{ id: "ops", default: true }]);
      expect(await fs.readFile(configPath, "utf8")).toBe(concurrentRaw);
    });
  });
});

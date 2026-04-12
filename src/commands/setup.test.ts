import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTempHome } from "../../test/helpers/temp-home.js";
import { setupCommand } from "./setup.js";

function createSetupDeps(home: string) {
  const configPath = path.join(home, ".openclaw", "openclaw.json");
  return {
    createConfigIO: () => ({ configPath }),
    ensureAgentWorkspace: vi.fn(async (params?: { dir?: string }) => ({
      dir: params?.dir ?? path.join(home, ".openclaw", "workspace"),
    })),
    formatConfigPath: (value: string) => value,
    logConfigUpdated: vi.fn(
      (runtime: { log: (message: string) => void }, opts: { path?: string; suffix?: string }) => {
        const suffix = opts.suffix ? ` ${opts.suffix}` : "";
        runtime.log(`Updated ${opts.path}${suffix}`);
      },
    ),
    mkdir: vi.fn(async () => {}),
    resolveSessionTranscriptsDir: vi.fn(() => path.join(home, ".openclaw", "sessions")),
    writeConfigFile: vi.fn(async (config: unknown) => {
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, JSON.stringify(config, null, 2));
    }),
  };
}

describe("setupCommand", () => {
  it("writes gateway.mode=local on first run", async () => {
    await withTempHome(async (home) => {
      const runtime = {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      };
      const deps = createSetupDeps(home);
      const workspace = path.join(home, ".openclaw", "workspace");

      await setupCommand({ workspace }, runtime, deps);

      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const raw = await fs.readFile(configPath, "utf-8");

      expect(raw).toContain('"mode": "local"');
      expect(raw).toContain('"workspace"');
    });
  });

  it("adds gateway.mode=local to an existing config without overwriting workspace", async () => {
    await withTempHome(async (home) => {
      const runtime = {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      };
      const configDir = path.join(home, ".openclaw");
      const configPath = path.join(configDir, "openclaw.json");
      const workspace = path.join(home, "custom-workspace");
      const deps = createSetupDeps(home);

      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        configPath,
        JSON.stringify({
          agents: {
            defaults: {
              workspace,
            },
          },
        }),
      );

      await setupCommand(undefined, runtime, deps);

      const raw = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
        agents?: { defaults?: { workspace?: string } };
        gateway?: { mode?: string };
      };

      expect(raw.agents?.defaults?.workspace).toBe(workspace);
      expect(raw.gateway?.mode).toBe("local");
    });
  });

  it("treats non-object config roots as empty config", async () => {
    await withTempHome(async (home) => {
      const runtime = {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      };
      const configDir = path.join(home, ".openclaw");
      const configPath = path.join(configDir, "openclaw.json");
      const deps = createSetupDeps(home);
      const workspace = path.join(home, ".openclaw", "workspace");

      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(configPath, '"not-an-object"', "utf-8");

      await setupCommand({ workspace }, runtime, deps);

      const raw = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
        agents?: { defaults?: { workspace?: string } };
        gateway?: { mode?: string };
      };

      expect(raw.agents?.defaults?.workspace).toBeTruthy();
      expect(raw.gateway?.mode).toBe("local");
    });
  });
});

// Setup command tests cover local setup initialization and next-step messaging.
import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { createConfigIO } from "../config/io.js";
import { replaceConfigFile } from "../config/mutate.js";
import { setupCommand } from "./setup.js";

function createSetupDeps(home: string) {
  const configPath = path.join(home, ".openclaw", "openclaw.json");
  const configIO = createConfigIO({
    configPath,
    env: { OPENCLAW_TEST_FAST: "1" } as NodeJS.ProcessEnv,
    homedir: () => home,
    logger: { error: vi.fn(), warn: vi.fn() },
  });
  return {
    createConfigIO: () => ({
      configPath,
      readConfigFileSnapshotForWrite: configIO.readConfigFileSnapshotForWrite,
    }),
    ensureAgentWorkspace: vi.fn(
      async (params?: { dir?: string; skipOptionalBootstrapFiles?: string[] }) => ({
        dir: params?.dir ?? path.join(home, ".openclaw", "workspace"),
      }),
    ),
    formatConfigPath: (value: string) => value,
    logConfigUpdated: vi.fn(
      (runtime: { log: (message: string) => void }, opts: { path?: string; suffix?: string }) => {
        const suffix = opts.suffix ? ` ${opts.suffix}` : "";
        runtime.log(`Updated ${opts.path}${suffix}`);
      },
    ),
    mkdir: vi.fn(async () => {}),
    resolveSessionTranscriptsDir: vi.fn(() => path.join(home, ".openclaw", "sessions")),
    replaceConfigFile: vi.fn(async ({ nextConfig }: Parameters<typeof replaceConfigFile>[0]) => {
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, JSON.stringify(nextConfig, null, 2));
    }),
  };
}

function requireFirstWorkspaceParams(
  ensureAgentWorkspace: ReturnType<typeof vi.fn>,
): Record<string, unknown> {
  const [call] = ensureAgentWorkspace.mock.calls;
  if (!call) {
    throw new Error("expected workspace setup call");
  }
  const [params] = call;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("expected workspace setup params");
  }
  return params as Record<string, unknown>;
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
      const raw = JSON.parse(await fs.readFile(configPath, "utf-8")) as unknown;

      expect(raw).toStrictEqual({
        agents: {
          defaults: {
            workspace,
          },
        },
        gateway: {
          mode: "local",
        },
      });
      expect(deps.replaceConfigFile).toHaveBeenCalledWith(
        expect.objectContaining({
          snapshot: expect.objectContaining({ exists: false, path: configPath }),
          writeOptions: expect.objectContaining({
            expectedConfigPath: configPath,
            ownedConfigPathForWrite: configPath,
          }),
        }),
      );
    });
  });

  it("explains that plain setup only initializes local files", async () => {
    await withTempHome(async (home) => {
      const runtime = {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      };
      const deps = createSetupDeps(home);

      await setupCommand(undefined, runtime, deps);

      expect(runtime.log.mock.calls.map((call) => String(call[0])).slice(-5)).toStrictEqual([
        "",
        "Setup complete: config, workspace, and session directories are ready.",
        "Next guided path: openclaw onboard.",
        "Next targeted changes: openclaw configure for models, channels, Gateway, plugins, skills, and health checks.",
        "Add a chat channel later: openclaw channels add.",
      ]);
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

  it("threads skipOptionalBootstrapFiles into workspace creation", async () => {
    await withTempHome(async (home) => {
      const runtime = {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      };
      const configDir = path.join(home, ".openclaw");
      const configPath = path.join(configDir, "openclaw.json");
      const deps = createSetupDeps(home);
      const workspace = path.join(home, "custom-workspace");

      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        configPath,
        JSON.stringify({
          agents: {
            defaults: {
              workspace,
              skipOptionalBootstrapFiles: ["IDENTITY.md", "USER.md"],
            },
          },
        }),
      );

      await setupCommand(undefined, runtime, deps);

      expect(deps.ensureAgentWorkspace).toHaveBeenCalledOnce();
      const workspaceParams = requireFirstWorkspaceParams(deps.ensureAgentWorkspace);
      expect(workspaceParams.dir).toBe(workspace);
      expect(workspaceParams.skipOptionalBootstrapFiles).toEqual(["IDENTITY.md", "USER.md"]);
    });
  });

  it("rejects a stale config snapshot before workspace or session mutation", async () => {
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
      const externalRaw = `${JSON.stringify({ external: true }, null, 2)}\n`;

      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        configPath,
        JSON.stringify({ agents: { defaults: { workspace } } }),
        "utf-8",
      );
      deps.replaceConfigFile.mockImplementationOnce(async (params) => {
        await fs.writeFile(configPath, externalRaw, "utf-8");
        await replaceConfigFile(params);
      });

      await expect(setupCommand(undefined, runtime, deps)).rejects.toThrow(
        "config changed since last load",
      );

      expect(await fs.readFile(configPath, "utf-8")).toBe(externalRaw);
      expect(deps.ensureAgentWorkspace).not.toHaveBeenCalled();
      expect(deps.resolveSessionTranscriptsDir).not.toHaveBeenCalled();
      expect(deps.mkdir).not.toHaveBeenCalled();
    });
  });

  it("preserves malformed config and stops before setup mutations", async () => {
    await withTempHome(async (home) => {
      const runtime = {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      };
      const configDir = path.join(home, ".openclaw");
      const configPath = path.join(configDir, "openclaw.json");
      const deps = createSetupDeps(home);
      const original = Buffer.from('{ "gateway": ', "utf-8");

      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(configPath, original);

      await setupCommand(undefined, runtime, deps);

      expect(runtime.exit).toHaveBeenCalledWith(1);
      expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("openclaw doctor"));
      expect(await fs.readFile(configPath)).toStrictEqual(original);
      expect(deps.replaceConfigFile).not.toHaveBeenCalled();
      expect(deps.ensureAgentWorkspace).not.toHaveBeenCalled();
      expect(deps.resolveSessionTranscriptsDir).not.toHaveBeenCalled();
      expect(deps.mkdir).not.toHaveBeenCalled();
    });
  });

  it.each([
    ["string", '"not-an-object"'],
    ["array", "[]"],
    ["null", "null"],
  ])(
    "preserves an existing %s config root and stops before setup mutations",
    async (_label, raw) => {
      await withTempHome(async (home) => {
        const runtime = {
          log: vi.fn(),
          error: vi.fn(),
          exit: vi.fn(),
        };
        const configDir = path.join(home, ".openclaw");
        const configPath = path.join(configDir, "openclaw.json");
        const deps = createSetupDeps(home);

        await fs.mkdir(configDir, { recursive: true });
        await fs.writeFile(configPath, raw, "utf-8");

        await setupCommand(undefined, runtime, deps);

        expect(runtime.exit).toHaveBeenCalledWith(1);
        expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("openclaw doctor"));
        expect(await fs.readFile(configPath, "utf-8")).toBe(raw);
        expect(deps.replaceConfigFile).not.toHaveBeenCalled();
        expect(deps.ensureAgentWorkspace).not.toHaveBeenCalled();
        expect(deps.resolveSessionTranscriptsDir).not.toHaveBeenCalled();
        expect(deps.mkdir).not.toHaveBeenCalled();
      });
    },
  );
});

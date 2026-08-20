// Root help live config tests cover root help output derived from live config state.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { loadRootHelpRenderOptionsForConfigSensitivePlugins } from "./root-help-live-config.js";

const readConfigFileSnapshotMock = vi.hoisted(() => vi.fn());
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: readConfigFileSnapshotMock,
}));

describe("root help live config", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses precomputed help when plugin-sensitive config is invalid", async () => {
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      valid: false,
      sourceConfig: {
        plugins: {
          slots: {
            memory: "memory-lancedb",
          },
        },
      },
      runtimeConfig: {},
    });

    await expect(loadRootHelpRenderOptionsForConfigSensitivePlugins({})).resolves.toBeNull();
  });

  it("uses snapshot runtime config when plugin config affects help", async () => {
    const runtimeConfig = {
      plugins: {
        slots: {
          memory: "memory-lancedb",
        },
      },
    };
    const env = {};
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      valid: true,
      sourceConfig: runtimeConfig,
      runtimeConfig,
    });

    await expect(loadRootHelpRenderOptionsForConfigSensitivePlugins(env)).resolves.toEqual({
      config: runtimeConfig,
      env,
    });
  });
});

describe("root help live config fast path", () => {
  let home: string;

  beforeEach(() => {
    vi.clearAllMocks();
    home = tempDirs.make("root-help-home-");
    vi.stubEnv("HOME", home);
    vi.stubEnv("OPENCLAW_HOME", undefined);
    vi.stubEnv("OPENCLAW_STATE_DIR", undefined);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", undefined);
    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", undefined);
    vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function writeConfig(contents: string): void {
    fs.mkdirSync(path.join(home, ".openclaw"), { recursive: true });
    fs.writeFileSync(path.join(home, ".openclaw", "openclaw.json"), contents);
  }

  function writePluginSensitiveConfig(configPath: string): void {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ plugins: { enabled: false } }));
    const runtimeConfig = { plugins: { enabled: false } };
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      valid: true,
      sourceConfig: runtimeConfig,
      runtimeConfig,
    });
  }

  it("skips the config load when no config file exists", async () => {
    await expect(loadRootHelpRenderOptionsForConfigSensitivePlugins()).resolves.toBeNull();
    expect(readConfigFileSnapshotMock).not.toHaveBeenCalled();
  });

  it("loads the config when the configured file cannot be read", async () => {
    writeConfig(JSON.stringify({ plugins: {} }));
    const readError = Object.assign(new Error("unreadable config"), { code: "EACCES" });
    const readFileSyncSpy = vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw readError;
    });
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      valid: false,
      sourceConfig: {},
      runtimeConfig: {},
    });

    try {
      await expect(loadRootHelpRenderOptionsForConfigSensitivePlugins()).resolves.toBeNull();
      expect(readConfigFileSnapshotMock).toHaveBeenCalledTimes(1);
    } finally {
      readFileSyncSpy.mockRestore();
      readConfigFileSnapshotMock.mockReset();
    }
  });

  it("skips the config load for a config whose plugins cannot affect help", async () => {
    writeConfig(JSON.stringify({ plugins: {} }));

    await expect(loadRootHelpRenderOptionsForConfigSensitivePlugins()).resolves.toBeNull();
    expect(readConfigFileSnapshotMock).not.toHaveBeenCalled();
  });

  it("keeps the fast path for an empty plugins.installs record", async () => {
    writeConfig(JSON.stringify({ plugins: { installs: {} } }));

    await expect(loadRootHelpRenderOptionsForConfigSensitivePlugins()).resolves.toBeNull();

    expect(readConfigFileSnapshotMock).not.toHaveBeenCalled();
  });

  it("keeps legacy installs plugin-sensitive through snapshot migration", async () => {
    const persistedConfig = {
      plugins: {
        installs: {
          demo: {
            source: "npm",
            spec: "demo@latest",
            installedAt: "2026-08-20T00:00:00.000Z",
          },
        },
      },
    };
    writeConfig(JSON.stringify(persistedConfig));
    const actualConfig =
      await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
    readConfigFileSnapshotMock.mockImplementationOnce(actualConfig.readConfigFileSnapshot);

    const result = await loadRootHelpRenderOptionsForConfigSensitivePlugins();

    expect(result).not.toBeNull();
    expect(result?.config?.plugins?.installs).toBeUndefined();
    expect(readConfigFileSnapshotMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    { config: { plugins: null }, name: "plugins=null" },
    { config: { plugins: [] }, name: "plugins=[]" },
    { config: { plugins: { enabled: null } }, name: "plugins.enabled=null" },
    { config: { plugins: { allow: null } }, name: "plugins.allow=null" },
    { config: { plugins: { allow: ["plugin", 1] } }, name: "plugins.allow=[string,number]" },
    { config: { plugins: { deny: null } }, name: "plugins.deny=null" },
    { config: { plugins: { deny: ["plugin", 1] } }, name: "plugins.deny=[string,number]" },
    { config: { plugins: { entries: null } }, name: "plugins.entries=null" },
    { config: { plugins: { entries: [] } }, name: "plugins.entries=[]" },
    { config: { plugins: { slots: null } }, name: "plugins.slots=null" },
    { config: { plugins: { installs: 1 } }, name: "plugins.installs=number" },
    { config: { plugins: { load: null } }, name: "plugins.load=null" },
    { config: { plugins: { load: { paths: null } } }, name: "plugins.load.paths=null" },
    {
      config: { plugins: { load: { paths: ["./plugins", 1] } } },
      name: "plugins.load.paths=[string,number]",
    },
    { config: { plugins: { unknown: true } }, name: "plugins.unknown=true" },
    { config: { plugins: { load: { unknown: true } } }, name: "plugins.load.unknown=true" },
  ])("loads the config when $name is not a canonical plugin shape", async ({ config }) => {
    writeConfig(JSON.stringify(config));
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      valid: false,
      sourceConfig: {},
      runtimeConfig: {},
    });

    try {
      await expect(loadRootHelpRenderOptionsForConfigSensitivePlugins()).resolves.toBeNull();
      expect(readConfigFileSnapshotMock).toHaveBeenCalledTimes(1);
    } finally {
      readConfigFileSnapshotMock.mockReset();
    }
  });

  it("loads the config when plugins.enabled is false", async () => {
    writeConfig(JSON.stringify({ plugins: { enabled: false } }));
    const runtimeConfig = { plugins: { enabled: false } };
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      valid: true,
      sourceConfig: runtimeConfig,
      runtimeConfig,
    });

    await expect(loadRootHelpRenderOptionsForConfigSensitivePlugins()).resolves.not.toBeNull();
    expect(readConfigFileSnapshotMock).toHaveBeenCalledTimes(1);
  });

  it("loads the config when config-owned env vars affect plugin help", async () => {
    const config = {
      env: { vars: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
    };
    writeConfig(JSON.stringify(config));
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      valid: true,
      sourceConfig: config,
      runtimeConfig: config,
    });

    try {
      await loadRootHelpRenderOptionsForConfigSensitivePlugins();
      expect(readConfigFileSnapshotMock).toHaveBeenCalledTimes(1);
    } finally {
      readConfigFileSnapshotMock.mockReset();
    }
  });

  it("loads the config when env.vars trims a plugin key", async () => {
    const config = {
      env: { vars: { " OPENCLAW_DISABLE_BUNDLED_PLUGINS ": "1" } },
    };
    writeConfig(JSON.stringify(config));
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      valid: false,
      sourceConfig: {},
      runtimeConfig: {},
    });

    await loadRootHelpRenderOptionsForConfigSensitivePlugins();

    expect(readConfigFileSnapshotMock).toHaveBeenCalledTimes(1);
  });

  it("loads the config when a direct env key trims to a plugin key", async () => {
    const config = {
      env: { " OPENCLAW_BUNDLED_PLUGINS_DIR ": "/tmp/plugins" },
    };
    writeConfig(JSON.stringify(config));
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      valid: false,
      sourceConfig: {},
      runtimeConfig: {},
    });

    await loadRootHelpRenderOptionsForConfigSensitivePlugins();

    expect(readConfigFileSnapshotMock).toHaveBeenCalledTimes(1);
  });

  it.runIf(process.platform !== "win32")(
    "keeps mixed-case config env keys distinct on POSIX",
    async () => {
      writeConfig(JSON.stringify({ env: { vars: { openclaw_disable_bundled_plugins: "1" } } }));

      await expect(loadRootHelpRenderOptionsForConfigSensitivePlugins()).resolves.toBeNull();

      expect(readConfigFileSnapshotMock).not.toHaveBeenCalled();
    },
  );

  it.runIf(process.platform === "win32")(
    "matches mixed-case config env keys on Windows",
    async () => {
      const config = { env: { vars: { openclaw_disable_bundled_plugins: "1" } } };
      writeConfig(JSON.stringify(config));
      readConfigFileSnapshotMock.mockResolvedValueOnce({
        valid: false,
        sourceConfig: {},
        runtimeConfig: {},
      });

      await loadRootHelpRenderOptionsForConfigSensitivePlugins();

      expect(readConfigFileSnapshotMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { env: null, name: "env=null" },
    { env: [], name: "env=[]" },
    { env: { vars: null }, name: "env.vars=null" },
    { env: { vars: [] }, name: "env.vars=[]" },
    { env: { vars: { "NOT PORTABLE": "value" } }, name: "non-portable env.vars key" },
    { env: { OTHER: 1 }, name: "non-string direct env value" },
  ])("loads the config for malformed $name", async ({ env }) => {
    writeConfig(JSON.stringify({ env }));
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      valid: false,
      sourceConfig: {},
      runtimeConfig: {},
    });

    await loadRootHelpRenderOptionsForConfigSensitivePlugins();

    expect(readConfigFileSnapshotMock).toHaveBeenCalledTimes(1);
  });

  it("loads plugin-sensitive config when the plugins key uses a JSON escape", async () => {
    writeConfig('{"pl\\u0075gins":{"enabled":false}}');
    const runtimeConfig = { plugins: { enabled: false } };
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      valid: true,
      sourceConfig: runtimeConfig,
      runtimeConfig,
    });

    await expect(loadRootHelpRenderOptionsForConfigSensitivePlugins()).resolves.not.toBeNull();
    expect(readConfigFileSnapshotMock).toHaveBeenCalledTimes(1);
  });

  it("loads the config when a nested include key uses a JSON escape", async () => {
    writeConfig('{"plugins":{"$incl\\u0075de":"./plugins.json"}}');
    const runtimeConfig = { plugins: { enabled: false } };
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      valid: true,
      sourceConfig: runtimeConfig,
      runtimeConfig,
    });

    await expect(loadRootHelpRenderOptionsForConfigSensitivePlugins()).resolves.not.toBeNull();
    expect(readConfigFileSnapshotMock).toHaveBeenCalledTimes(1);
  });

  it("loads plugin-sensitive config from OPENCLAW_HOME", async () => {
    const openclawHome = tempDirs.make("root-help-openclaw-home-");
    fs.mkdirSync(path.join(openclawHome, ".openclaw"), { recursive: true });
    fs.writeFileSync(
      path.join(openclawHome, ".openclaw", "openclaw.json"),
      JSON.stringify({ plugins: { enabled: false } }),
    );
    vi.stubEnv("OPENCLAW_HOME", openclawHome);
    const runtimeConfig = { plugins: { enabled: false } };
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      valid: true,
      sourceConfig: runtimeConfig,
      runtimeConfig,
    });

    await expect(loadRootHelpRenderOptionsForConfigSensitivePlugins()).resolves.not.toBeNull();
    expect(readConfigFileSnapshotMock).toHaveBeenCalledTimes(1);
  });

  it("loads plugin-sensitive config from a relative OPENCLAW_CONFIG_PATH", async () => {
    const configPath = path.join(home, "relative-config", "openclaw.json");
    writePluginSensitiveConfig(configPath);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.relative(process.cwd(), configPath));

    await expect(loadRootHelpRenderOptionsForConfigSensitivePlugins()).resolves.not.toBeNull();
    expect(readConfigFileSnapshotMock).toHaveBeenCalledTimes(1);
  });

  it("loads plugin-sensitive config from a tilde-prefixed OPENCLAW_CONFIG_PATH", async () => {
    const configPath = path.join(home, "tilde-config", "openclaw.json");
    writePluginSensitiveConfig(configPath);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", "~/tilde-config/openclaw.json");

    await expect(loadRootHelpRenderOptionsForConfigSensitivePlugins()).resolves.not.toBeNull();
    expect(readConfigFileSnapshotMock).toHaveBeenCalledTimes(1);
  });

  it("loads plugin-sensitive config from a relative OPENCLAW_STATE_DIR", async () => {
    const stateDir = path.join(home, "relative-state");
    writePluginSensitiveConfig(path.join(stateDir, "openclaw.json"));
    vi.stubEnv("OPENCLAW_STATE_DIR", path.relative(process.cwd(), stateDir));

    await expect(loadRootHelpRenderOptionsForConfigSensitivePlugins()).resolves.not.toBeNull();
    expect(readConfigFileSnapshotMock).toHaveBeenCalledTimes(1);
  });

  it("loads plugin-sensitive config from a tilde-prefixed OPENCLAW_STATE_DIR", async () => {
    const stateDir = path.join(home, "tilde-state");
    writePluginSensitiveConfig(path.join(stateDir, "openclaw.json"));
    vi.stubEnv("OPENCLAW_STATE_DIR", "~/tilde-state");

    await expect(loadRootHelpRenderOptionsForConfigSensitivePlugins()).resolves.not.toBeNull();
    expect(readConfigFileSnapshotMock).toHaveBeenCalledTimes(1);
  });

  it("loads the config when the legacy gateway.env sets a plugin env var (#85396)", async () => {
    fs.mkdirSync(path.join(home, ".config", "openclaw"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".config", "openclaw", "gateway.env"),
      "OPENCLAW_DISABLE_BUNDLED_PLUGINS=1\n",
    );
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      valid: true,
      sourceConfig: {},
      runtimeConfig: {},
    });

    await loadRootHelpRenderOptionsForConfigSensitivePlugins();
    expect(readConfigFileSnapshotMock).toHaveBeenCalledTimes(1);
  });

  it("loads the config when dotenv uses a lower-case plugin key", async () => {
    fs.mkdirSync(path.join(home, ".config", "openclaw"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".config", "openclaw", "gateway.env"),
      "openclaw_disable_bundled_plugins=1\n",
    );
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      valid: true,
      sourceConfig: {},
      runtimeConfig: {},
    });

    try {
      await loadRootHelpRenderOptionsForConfigSensitivePlugins();
      expect(readConfigFileSnapshotMock).toHaveBeenCalledTimes(1);
    } finally {
      readConfigFileSnapshotMock.mockReset();
    }
  });

  it("loads the config when a .env beside OPENCLAW_CONFIG_PATH sets a plugin env var (#85396)", async () => {
    const configDir = path.join(home, "custom");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "openclaw.json"), "{}");
    fs.writeFileSync(path.join(configDir, ".env"), "OPENCLAW_DISABLE_BUNDLED_PLUGINS=1\n");
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(configDir, "openclaw.json"));
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      valid: true,
      sourceConfig: {},
      runtimeConfig: {},
    });

    await loadRootHelpRenderOptionsForConfigSensitivePlugins();
    expect(readConfigFileSnapshotMock).toHaveBeenCalledTimes(1);
  });

  it("loads the config when a symlinked state .env target sets a plugin env var", async () => {
    writeConfig("{}");
    const targetPath = path.join(home, "dotenv-target");
    fs.writeFileSync(targetPath, "OPENCLAW_DISABLE_BUNDLED_PLUGINS=1\n");
    fs.symlinkSync(targetPath, path.join(home, ".openclaw", ".env"));
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      valid: true,
      sourceConfig: {},
      runtimeConfig: {},
    });

    await expect(loadRootHelpRenderOptionsForConfigSensitivePlugins()).resolves.toBeNull();
    expect(readConfigFileSnapshotMock).toHaveBeenCalledTimes(1);
  });

  it("skips a nonregular state .env directory and retains the safe config fast path", async () => {
    writeConfig("{}");
    fs.mkdirSync(path.join(home, ".openclaw", ".env"));

    await expect(loadRootHelpRenderOptionsForConfigSensitivePlugins()).resolves.toBeNull();
    expect(readConfigFileSnapshotMock).not.toHaveBeenCalled();
  });

  it("does not scan plugin keys beyond the dotenv read bound", async () => {
    const dotEnvPath = path.join(home, ".openclaw", ".env");
    fs.mkdirSync(path.dirname(dotEnvPath), { recursive: true });
    fs.writeFileSync(
      dotEnvPath,
      `${"#".repeat(1024 * 1024 + 1)}\nOPENCLAW_DISABLE_BUNDLED_PLUGINS=1\n`,
    );

    readConfigFileSnapshotMock.mockResolvedValueOnce({
      valid: false,
      sourceConfig: {},
      runtimeConfig: {},
    });
    try {
      await expect(loadRootHelpRenderOptionsForConfigSensitivePlugins()).resolves.toBeNull();
      expect(readConfigFileSnapshotMock).not.toHaveBeenCalled();
    } finally {
      readConfigFileSnapshotMock.mockReset();
    }
  });

  it("loads the config when the raw config uses an include directive", async () => {
    writeConfig('{"$include":"./other.json"}');
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      valid: true,
      sourceConfig: {},
      runtimeConfig: {},
    });

    await loadRootHelpRenderOptionsForConfigSensitivePlugins();
    expect(readConfigFileSnapshotMock).toHaveBeenCalledTimes(1);
  });

  it("loads the config when the raw config is not plain JSON", async () => {
    writeConfig("{ plugins: { /* JSON5 */ } }");
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      valid: true,
      sourceConfig: {},
      runtimeConfig: {},
    });

    await loadRootHelpRenderOptionsForConfigSensitivePlugins();
    expect(readConfigFileSnapshotMock).toHaveBeenCalledTimes(1);
  });
});

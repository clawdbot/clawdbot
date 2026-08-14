import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const roots = new Set<string>();
const sharedStateDatabases = new Set<DatabaseSync>();
const PREFLIGHT_FIXTURE_PLUGIN_ID = "gateway-preflight-fixture";

afterEach(async () => {
  for (const database of sharedStateDatabases) {
    database.close();
  }
  sharedStateDatabases.clear();
  await Promise.all([...roots].map((root) => fs.rm(root, { recursive: true, force: true })));
  roots.clear();
});

async function writePreflightFixturePlugin(pluginRoot: string): Promise<void> {
  await fs.mkdir(pluginRoot, { recursive: true });
  await fs.writeFile(
    path.join(pluginRoot, "package.json"),
    `${JSON.stringify({
      name: `@openclaw/${PREFLIGHT_FIXTURE_PLUGIN_ID}`,
      version: "0.0.0-test",
      type: "commonjs",
      openclaw: { extensions: ["./index.cjs"] },
    })}\n`,
  );
  await fs.writeFile(
    path.join(pluginRoot, "openclaw.plugin.json"),
    `${JSON.stringify({
      id: PREFLIGHT_FIXTURE_PLUGIN_ID,
      name: "Gateway Preflight Fixture",
      doctorContract: { stateMigrations: true },
      contracts: { embeddingProviders: ["local"] },
      configSchema: {},
    })}\n`,
  );
  await fs.writeFile(
    path.join(pluginRoot, "index.cjs"),
    `const fs = require("node:fs");
const activationSentinel = process.env.OPENCLAW_PREFLIGHT_ACTIVATION_SENTINEL;
if (activationSentinel) {
  fs.writeFileSync(activationSentinel, "provider runtime activated");
}

module.exports = {
  register(api) {
    api.registerEmbeddingProvider({
      id: "local",
      inspectStartupPrerequisites: () => ({ status: "ready" }),
      create: async () => {
        throw new Error("gateway preflight must not create embedding providers");
      },
    });
  },
};
`,
  );
  await fs.writeFile(
    path.join(pluginRoot, "doctor-contract-api.cjs"),
    `const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const migration = {
  id: "fixture-vector-provider-readiness",
  label: "Fixture vector provider readiness",
  preflightStartup({ config, stateDir }) {
    const databasePath = path.join(
      stateDir,
      "agents",
      "main",
      "agent",
      "openclaw-agent.sqlite",
    );
    if (!fs.existsSync(databasePath)) {
      return { status: "ready" };
    }
    let database;
    let model;
    try {
      database = new DatabaseSync(databasePath, { readOnly: true });
      const row = database
        .prepare("SELECT value FROM memory_index_meta WHERE key = ?")
        .get("memory_index_meta_v1");
      const parsed = row && typeof row.value === "string" ? JSON.parse(row.value) : null;
      model = parsed && typeof parsed.model === "string" ? parsed.model.trim() : "";
    } catch (error) {
      return {
        status: "indeterminate",
        reason: error instanceof Error ? error.message : String(error),
      };
    } finally {
      database?.close();
    }
    if (!model || model === "fts-only") {
      return { status: "ready" };
    }
    const provider = config.memory?.search?.provider ?? "openai";
    if (provider !== "local") {
      return {
        status: "indeterminate",
        reason:
          'Embedding provider "' +
          provider +
          '" does not expose non-mutating startup inspection.',
      };
    }
    const managed = config.models?.providers?.["llama-cpp"];
    if (managed?.localService && managed?.baseUrl) {
      return { status: "ready" };
    }
    return {
      status: "blocked",
      findings: [
        {
          id: "main/local/managed-server-config-missing",
          code: "managed-server-config-missing",
          message:
            "Memory index for agent main uses vector model " +
            model +
            ', but embedding provider "local" has a startup prerequisite blocker: ' +
            "Local embeddings need the managed llama.cpp server config. " +
            "Run \`openclaw configure\`, choose llama.cpp once, then retry " +
            "\`openclaw memory status --deep\`.",
          remediation: [
            "Run \`openclaw configure\` and choose llama.cpp once.",
            "Retry \`openclaw memory status --deep\` after setup completes.",
          ],
          agentId: "main",
          provider: "local",
          model,
          configPath: "memory.search",
        },
      ],
    };
  },
  detectLegacyState: () => null,
  migrateLegacyState: () => ({ changes: [], warnings: [] }),
};

module.exports = { stateMigrations: [migration] };
`,
  );
}

async function createFixture(params: {
  config: Record<string, unknown>;
  disableMemorySlot?: boolean;
  invalidSessionStore?: boolean;
  vectorModel?: string;
}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-preflight-"));
  roots.add(root);
  const stateDir = path.join(root, "state");
  const configPath = path.join(stateDir, "openclaw.json");
  const pluginRoot = path.join(root, "plugins", PREFLIGHT_FIXTURE_PLUGIN_ID);
  await writePreflightFixturePlugin(pluginRoot);
  const configuredPlugins =
    params.config.plugins && typeof params.config.plugins === "object"
      ? (params.config.plugins as Record<string, unknown>)
      : {};
  const configuredSlots =
    configuredPlugins.slots && typeof configuredPlugins.slots === "object"
      ? (configuredPlugins.slots as Record<string, unknown>)
      : {};
  const configuredEntries =
    configuredPlugins.entries && typeof configuredPlugins.entries === "object"
      ? (configuredPlugins.entries as Record<string, unknown>)
      : {};
  const config = {
    ...params.config,
    plugins: {
      ...configuredPlugins,
      load: { paths: [pluginRoot] },
      slots:
        params.disableMemorySlot === false
          ? configuredSlots
          : { ...configuredSlots, memory: "none" },
      entries: {
        ...configuredEntries,
        [PREFLIGHT_FIXTURE_PLUGIN_ID]: { enabled: true },
      },
    },
  };
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  if (params.invalidSessionStore) {
    const sessionStorePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    await fs.mkdir(path.dirname(sessionStorePath), { recursive: true });
    await fs.writeFile(sessionStorePath, "{ invalid json\n");
  }
  const sharedStatePath = path.join(stateDir, "state", "openclaw.sqlite");
  await fs.mkdir(path.dirname(sharedStatePath), { recursive: true });
  const sharedStateDatabase = new DatabaseSync(sharedStatePath);
  sharedStateDatabase.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA wal_autocheckpoint = 0;
    CREATE TABLE preflight_state_probe (value TEXT PRIMARY KEY);
    INSERT INTO preflight_state_probe VALUES ('committed-in-wal');
  `);
  sharedStateDatabases.add(sharedStateDatabase);
  if (params.vectorModel) {
    const databasePath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    const database = new DatabaseSync(databasePath);
    database.exec(
      "CREATE TABLE memory_index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT",
    );
    database
      .prepare("INSERT INTO memory_index_meta (key, value) VALUES (?, ?)")
      .run("memory_index_meta_v1", JSON.stringify({ model: params.vectorModel, vectorDims: 768 }));
    database.close();
  }
  return { root, stateDir, configPath };
}

async function snapshotTree(
  root: string,
): Promise<Array<{ path: string; sha256: string; mtimeNs: bigint }>> {
  const entries: Array<{ path: string; sha256: string; mtimeNs: bigint }> = [];
  const visit = async (dir: string) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      const content = await fs.readFile(absolutePath);
      const stat = await fs.stat(absolutePath, { bigint: true });
      entries.push({
        path: path.relative(root, absolutePath),
        sha256: createHash("sha256").update(content).digest("hex"),
        mtimeNs: stat.mtimeNs,
      });
    }
  };
  await visit(root);
  return entries.toSorted((left, right) => left.path.localeCompare(right.path));
}

async function runCli(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  args: string[],
  envOverrides: NodeJS.ProcessEnv = {},
) {
  try {
    const result = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "src/entry.ts", ...args],
      {
        cwd: path.resolve("."),
        encoding: "utf8",
        timeout: 45_000,
        env: {
          ...process.env,
          HOME: fixture.root,
          USERPROFILE: fixture.root,
          NODE_DISABLE_COMPILE_CACHE: "1",
          NODE_ENV: undefined,
          NODE_OPTIONS: undefined,
          OPENCLAW_CONFIG_PATH: fixture.configPath,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_GATEWAY_PASSWORD: undefined,
          OPENCLAW_GATEWAY_TOKEN: undefined,
          OPENCLAW_HOME: fixture.root,
          OPENCLAW_NO_RESPAWN: "1",
          OPENCLAW_STATE_DIR: fixture.stateDir,
          VITEST: undefined,
          ...envOverrides,
        },
      },
    );
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
    if (typeof failure.code !== "number") {
      throw error;
    }
    return {
      code: failure.code,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

async function runPreflight(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  envOverrides: NodeJS.ProcessEnv = {},
) {
  return runCli(fixture, ["gateway", "preflight", "--json"], envOverrides);
}

async function runGateway(fixture: Awaited<ReturnType<typeof createFixture>>) {
  return runCli(fixture, ["gateway", "run", "--port", "39411"]);
}

function localMemoryConfig() {
  return {
    gateway: { mode: "local" },
    memory: {
      search: {
        provider: "local",
        fallback: "none",
        model: "embeddinggemma-300m",
      },
    },
  };
}

function configuredLlamaCppMemoryConfig() {
  return {
    ...localMemoryConfig(),
    models: {
      providers: {
        "llama-cpp": {
          api: "openai-completions",
          apiKey: "llama-cpp-local",
          baseUrl: "http://127.0.0.1:19432/v1",
          localService: {
            command: "/runtime/llama-server",
            args: ["--models-preset", "/runtime/models.ini"],
            healthUrl: "http://127.0.0.1:19432/health",
          },
          models: [
            {
              id: "gemma-4-e4b-it-q4_k_m",
              name: "Gemma 4 E4B",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 8192,
              maxTokens: 2048,
              params: { modelPath: "/models/chat.gguf" },
            },
          ],
        },
      },
    },
  };
}

describe("gateway preflight CLI process", () => {
  it("blocks the same missing password prerequisite as direct Gateway startup", async () => {
    const fixture = await createFixture({
      config: {
        gateway: { mode: "local", auth: { mode: "password" } },
        memory: { search: { provider: "none" } },
      },
    });
    const before = await snapshotTree(fixture.root);

    const preflight = await runPreflight(fixture);

    expect(preflight.code).toBe(1);
    expect(JSON.parse(preflight.stdout)).toMatchObject({
      ok: false,
      status: "blocked",
      blockers: [
        {
          id: "core/gateway-auth/password-missing",
          pluginId: "core",
          migrationId: "gateway-auth",
          code: "gateway-password-missing",
          configPath: "gateway.auth.password",
        },
      ],
      errors: [],
    });
    expect(await snapshotTree(fixture.root)).toEqual(before);

    const startup = await runGateway(fixture);
    expect(startup.code).toBe(78);
    expect(startup.stderr).toContain(
      "Gateway auth is set to password, but no password is configured.",
    );
  });

  it("accepts password inputs already present in config or the target environment", async () => {
    const configured = await createFixture({
      config: {
        gateway: {
          mode: "local",
          auth: { mode: "password", password: "configured-password" },
        },
        memory: { search: { provider: "none" } },
      },
    });
    const environment = await createFixture({
      config: {
        gateway: { mode: "local", auth: { mode: "password" } },
        memory: { search: { provider: "none" } },
      },
    });

    const results = [
      await runPreflight(configured),
      await runPreflight(environment, {
        OPENCLAW_GATEWAY_PASSWORD: "environment-password",
      }),
    ];

    for (const result of results) {
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        status: "ready",
        blockers: [],
        errors: [],
      });
    }
  });

  it("returns indeterminate for active auth refs without resolving them", async () => {
    const fixture = await createFixture({
      config: {
        gateway: {
          mode: "local",
          auth: {
            mode: "password",
            password: { source: "env", provider: "default", id: "GW_PASSWORD" },
          },
        },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
        memory: { search: { provider: "none" } },
      },
    });
    const before = await snapshotTree(fixture.root);

    const result = await runPreflight(fixture, {
      GW_PASSWORD: "preflight-must-not-resolve-this",
    });

    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      status: "indeterminate",
      blockers: [],
      errors: [
        {
          id: "core/gateway-auth",
          pluginId: "core",
          migrationId: "gateway-auth",
          code: "credential-inspection-required",
          message: expect.stringContaining("gateway.auth.password"),
        },
      ],
    });
    expect(await snapshotTree(fixture.root)).toEqual(before);
  });

  it("keeps token bootstrap, auth disablement, and inactive refs ready", async () => {
    const fixtures = [
      await createFixture({
        config: {
          gateway: {
            mode: "local",
            auth: {
              mode: "token",
              password: { source: "env", provider: "default", id: "INACTIVE_PASSWORD" },
            },
          },
          secrets: {
            providers: {
              default: { source: "env" },
            },
          },
          memory: { search: { provider: "none" } },
        },
      }),
      await createFixture({
        config: {
          gateway: { mode: "local", auth: { mode: "none" } },
          memory: { search: { provider: "none" } },
        },
      }),
    ];

    for (const fixture of fixtures) {
      const result = await runPreflight(fixture);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        status: "ready",
        blockers: [],
        errors: [],
      });
    }
  });

  it("blocks the same known-weak credential as direct Gateway startup", async () => {
    const fixture = await createFixture({
      config: {
        gateway: {
          mode: "local",
          auth: {
            mode: "token",
            token: "change-me-now",
          },
        },
        memory: { search: { provider: "none" } },
      },
    });
    const before = await snapshotTree(fixture.root);

    const preflight = await runPreflight(fixture);
    expect(preflight.code).toBe(1);
    expect(JSON.parse(preflight.stdout)).toMatchObject({
      status: "blocked",
      blockers: [expect.objectContaining({ code: "gateway-auth-known-weak" })],
      errors: [],
    });
    expect(await snapshotTree(fixture.root)).toEqual(before);

    const startup = await runGateway(fixture);
    expect(startup.code).not.toBe(0);
    expect(startup.stderr).toMatch(/example placeholder/i);
  });

  it("blocks the same unauthenticated LAN bind as direct Gateway startup", async () => {
    const fixture = await createFixture({
      config: {
        gateway: { mode: "local", bind: "lan", auth: { mode: "none" } },
        memory: { search: { provider: "none" } },
      },
    });
    const before = await snapshotTree(fixture.root);

    const preflight = await runPreflight(fixture);
    expect(preflight.code).toBe(1);
    expect(JSON.parse(preflight.stdout)).toMatchObject({
      status: "blocked",
      blockers: [expect.objectContaining({ code: "gateway-bind-auth-required" })],
      errors: [],
    });
    expect(await snapshotTree(fixture.root)).toEqual(before);

    const startup = await runGateway(fixture);
    expect(startup.code).toBe(78);
    expect(startup.stderr).toContain("Refusing to bind gateway to lan without auth.");
  });

  it("returns indeterminate for protected memory credentials in a SecretRef", async () => {
    const fixture = await createFixture({
      config: {
        gateway: { mode: "local" },
        memory: {
          search: {
            provider: "openai",
            fallback: "none",
            model: "text-embedding-3-small",
            remote: {
              apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
            },
          },
        },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
      },
      disableMemorySlot: false,
      vectorModel: "text-embedding-3-small",
    });
    const before = await snapshotTree(fixture.root);

    const result = await runPreflight(fixture, {
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
      OPENAI_API_KEY: "preflight-must-not-resolve-this",
    });

    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "indeterminate",
      blockers: [],
      errors: expect.arrayContaining([
        expect.objectContaining({
          code: "inspection-indeterminate",
          message: expect.stringContaining("Memory provider credentials use a SecretRef"),
        }),
      ]),
    });
    expect(await snapshotTree(fixture.root)).toEqual(before);
  });

  it("reports a startup-blocking unreadable session store without mutation", async () => {
    const fixture = await createFixture({
      config: {
        gateway: { mode: "local" },
        memory: { search: { provider: "none" } },
      },
      invalidSessionStore: true,
    });
    const before = await snapshotTree(fixture.root);

    const result = await runPreflight(fixture);

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      status: "blocked",
      blockers: [
        expect.objectContaining({
          id: "core/session-sqlite/main/store_unreadable/1",
          pluginId: "core",
          migrationId: "session-sqlite",
          code: "store_unreadable",
          agentId: "main",
        }),
      ],
      errors: [],
    });
    expect(await snapshotTree(fixture.root)).toEqual(before);
  });

  it("reports a stable local llama.cpp blocker without mutating config or state", async () => {
    const fixture = await createFixture({
      config: localMemoryConfig(),
      vectorModel: "embeddinggemma-300m",
    });
    const before = await snapshotTree(fixture.root);

    const first = await runPreflight(fixture);
    const second = await runPreflight(fixture);

    expect(first.code).toBe(1);
    expect(first.stdout).toBe(second.stdout);
    const result = JSON.parse(first.stdout) as {
      status: string;
      blockers: Array<{ code: string; provider?: string; message: string }>;
      errors: unknown[];
    };
    expect(result).toMatchObject({
      status: "blocked",
      errors: [],
      blockers: [
        expect.objectContaining({
          code: "managed-server-config-missing",
          provider: "local",
          message: expect.stringContaining(
            "Local embeddings need the managed llama.cpp server config",
          ),
        }),
      ],
    });
    expect(await snapshotTree(fixture.root)).toEqual(before);
  });

  it("accepts configured local setup and a local provider with no semantic index", async () => {
    const configured = await createFixture({
      config: configuredLlamaCppMemoryConfig(),
      vectorModel: "embeddinggemma-300m",
    });
    const noIndex = await createFixture({ config: localMemoryConfig() });

    for (const fixture of [configured, noIndex]) {
      const before = await snapshotTree(fixture.root);
      const result = await runPreflight(fixture);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        status: "ready",
        blockers: [],
        errors: [],
      });
      expect(await snapshotTree(fixture.root)).toEqual(before);
    }
  });

  it("returns indeterminate for unsupported selected providers and invalid config", async () => {
    const remote = await createFixture({
      config: {
        gateway: { mode: "local" },
        memory: {
          search: {
            provider: "openai",
            fallback: "none",
            model: "text-embedding-3-small",
          },
        },
      },
      vectorModel: "text-embedding-3-small",
    });
    const invalid = await createFixture({
      config: { gateway: { mode: "not-a-mode" } },
    });

    const remoteResult = await runPreflight(remote);
    expect(remoteResult.code).toBe(2);
    expect(JSON.parse(remoteResult.stdout)).toMatchObject({
      status: "indeterminate",
      blockers: [],
      errors: [expect.objectContaining({ code: "inspection-indeterminate" })],
    });
    expect(remoteResult.stdout).not.toContain("llama.cpp");

    const invalidResult = await runPreflight(invalid);
    expect(invalidResult.code).toBe(2);
    expect(JSON.parse(invalidResult.stdout)).toMatchObject({
      status: "indeterminate",
      blockers: [],
      errors: [expect.objectContaining({ code: "invalid-config" })],
    });
  });

  it("does not activate a configured external provider runtime", async () => {
    const fixture = await createFixture({
      config: localMemoryConfig(),
      disableMemorySlot: false,
      vectorModel: "embeddinggemma-300m",
    });
    const sentinelPath = path.join(fixture.root, "provider-runtime-activated");

    const result = await runPreflight(fixture, {
      OPENCLAW_PREFLIGHT_ACTIVATION_SENTINEL: sentinelPath,
    });

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "blocked",
      blockers: [expect.objectContaining({ code: "managed-server-config-missing" })],
      errors: [],
    });
    await expect(fs.access(sentinelPath)).rejects.toThrow();
  });
});

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";

const execFileAsync = promisify(execFile);
const roots = new Set<string>();
const sharedStateDatabases = new Set<DatabaseSync>();
const PREFLIGHT_FIXTURE_PLUGIN_ID = "gateway-preflight-fixture";

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
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
const contractSentinel = process.env.OPENCLAW_PREFLIGHT_CONTRACT_SENTINEL;
if (contractSentinel) {
  fs.writeFileSync(contractSentinel, "doctor contract loaded");
}

const migration = {
  id: "external-preflight",
  label: "External preflight",
  preflightStartup: () => ({ status: "ready" }),
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
  canonicalSharedStateDatabase?: boolean;
  includeFixturePlugin?: boolean;
  includeSharedStateDatabase?: boolean;
  invalidSessionStore?: boolean;
  vectorModel?: string;
}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-preflight-"));
  roots.add(root);
  const stateDir = path.join(root, "state");
  const configPath = path.join(stateDir, "openclaw.json");
  const pluginRoot = path.join(root, "plugins", PREFLIGHT_FIXTURE_PLUGIN_ID);
  if (params.includeFixturePlugin === true) {
    await writePreflightFixturePlugin(pluginRoot);
  }
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
      ...(params.includeFixturePlugin === true ? { load: { paths: [pluginRoot] } } : {}),
      slots:
        params.disableMemorySlot === false
          ? configuredSlots
          : { ...configuredSlots, memory: "none" },
      entries:
        params.includeFixturePlugin === true
          ? {
              ...configuredEntries,
              [PREFLIGHT_FIXTURE_PLUGIN_ID]: { enabled: true },
            }
          : configuredEntries,
    },
  };
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  if (params.invalidSessionStore) {
    const sessionStorePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    await fs.mkdir(path.dirname(sessionStorePath), { recursive: true });
    await fs.writeFile(sessionStorePath, "{ invalid json\n");
  }
  if (params.includeSharedStateDatabase === true) {
    const sharedStatePath = path.join(stateDir, "state", "openclaw.sqlite");
    await fs.mkdir(path.dirname(sharedStatePath), { recursive: true });
    if (params.canonicalSharedStateDatabase) {
      openOpenClawStateDatabase({
        path: sharedStatePath,
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      });
      closeOpenClawStateDatabaseForTest();
    } else {
      const sharedStateDatabase = new DatabaseSync(sharedStatePath);
      sharedStateDatabase.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA wal_autocheckpoint = 0;
        CREATE TABLE preflight_state_probe (value TEXT PRIMARY KEY);
        INSERT INTO preflight_state_probe VALUES ('committed-in-wal');
      `);
      sharedStateDatabases.add(sharedStateDatabase);
    }
  }
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
  timeoutMs = 75_000,
) {
  try {
    const result = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "src/entry.ts", ...args],
      {
        cwd: path.resolve("."),
        encoding: "utf8",
        timeout: timeoutMs,
        env: resolveCliEnv(fixture, envOverrides),
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

function resolveCliEnv(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  envOverrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
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
  };
}

async function waitForFile(filePath: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await fs.readFile(filePath, "utf8");
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code !== "ENOENT") {
        throw error;
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${filePath}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function runGatewayUntilFile(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  envOverrides: NodeJS.ProcessEnv,
  filePath: string,
  timeoutMs: number,
): Promise<string> {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/entry.ts", "gateway", "run", "--port", "39411"],
    {
      cwd: path.resolve("."),
      env: resolveCliEnv(fixture, envOverrides),
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  child.stderr.setEncoding("utf8");
  let stderr = "";
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const close = once(child, "close") as Promise<
    [code: number | null, signal: NodeJS.Signals | null]
  >;
  try {
    return await Promise.race([
      waitForFile(filePath, timeoutMs),
      close.then(([code, signal]) => {
        throw new Error(
          `Gateway exited before creating ${filePath} (code=${String(code)}, signal=${String(signal)}): ${stderr}`,
        );
      }),
    ]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
    await close;
  }
}

async function runPreflight(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  envOverrides: NodeJS.ProcessEnv = {},
  timeoutMs?: number,
) {
  return runCli(fixture, ["gateway", "preflight", "--json"], envOverrides, timeoutMs);
}

async function runGateway(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  envOverrides: NodeJS.ProcessEnv = {},
  timeoutMs?: number,
) {
  return runCli(fixture, ["gateway", "run", "--port", "39411"], envOverrides, timeoutMs);
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

function configuredLlamaCppMemoryConfig(
  params: {
    chatModelPath?: string;
    embeddingModelPath?: string;
  } = {},
) {
  const localMemory = localMemoryConfig();
  return {
    ...localMemory,
    memory: {
      search: {
        ...localMemory.memory.search,
        ...(params.embeddingModelPath ? { local: { modelPath: params.embeddingModelPath } } : {}),
      },
    },
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
              params: { modelPath: params.chatModelPath ?? "/models/chat.gguf" },
            },
          ],
        },
      },
    },
  };
}

async function createGgufFixture(name: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-preflight-model-"));
  roots.add(root);
  const filePath = path.join(root, name);
  await fs.writeFile(filePath, "GGUFfixture");
  return filePath;
}

export function registerGatewayPreflightCoreProcessTests(): void {
  describe("gateway preflight CLI core process", () => {
    it.each([
      {
        name: "missing config",
        config: {},
        removeConfig: true,
        message: "Missing config.",
      },
      {
        name: "missing gateway mode",
        config: { memory: { search: { provider: "none" } } },
        removeConfig: false,
        message: "existing config is missing gateway.mode",
      },
      {
        name: "non-local gateway mode",
        config: {
          gateway: { mode: "remote" },
          memory: { search: { provider: "none" } },
        },
        removeConfig: false,
        message: "set gateway.mode=local",
      },
    ])("blocks $name in agreement with direct Gateway startup", async (testCase) => {
      const fixture = await createFixture({
        config: testCase.config,
        includeFixturePlugin: false,
        includeSharedStateDatabase: false,
      });
      if (testCase.removeConfig) {
        await fs.rm(fixture.configPath);
      }
      const before = await snapshotTree(fixture.root);

      const preflight = await runPreflight(fixture);

      expect(preflight.code).toBe(1);
      expect(JSON.parse(preflight.stdout)).toMatchObject({
        status: "blocked",
        blockers: [
          expect.objectContaining({
            code: "gateway-start-config-blocked",
            message: expect.stringContaining(testCase.message),
          }),
        ],
        errors: [],
      });
      expect(await snapshotTree(fixture.root)).toEqual(before);

      const startup = await runGateway(fixture);
      expect(startup.code).toBe(78);
      expect(startup.stderr).toContain(testCase.message);
    });

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

    it("blocks the same ambiguous auth mode prerequisite as direct Gateway startup", async () => {
      const fixture = await createFixture({
        config: {
          gateway: {
            mode: "local",
            auth: {
              token: "configured-token",
              password: "configured-password",
            },
          },
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
            id: "core/gateway-auth/explicit-mode-required",
            pluginId: "core",
            migrationId: "gateway-auth",
            code: "gateway-auth-mode-required",
            message: expect.stringMatching(/gateway\.auth\.mode is unset/i),
            configPath: "gateway.auth.mode",
          },
        ],
        errors: [],
      });
      expect(await snapshotTree(fixture.root)).toEqual(before);

      const startup = await runGateway(fixture);
      expect(startup.code).toBe(1);
      expect(startup.stderr).toContain(
        "gateway.auth.token and gateway.auth.password are both configured",
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

    it("does not execute a login shell when fallback could change startup inputs", async () => {
      const fixture = await createFixture({
        config: {
          gateway: { mode: "local" },
          env: { shellEnv: { enabled: true } },
          memory: { search: { provider: "none" } },
        },
      });
      const shellSentinel = path.join(fixture.root, "shell-ran");
      await fs.writeFile(
        path.join(fixture.root, ".profile"),
        [
          'export OPENCLAW_GATEWAY_TOKEN="validator-shell-token"',
          'printf shell-ran > "$OPENCLAW_SHELL_SENTINEL"',
          "",
        ].join("\n"),
      );
      const before = await snapshotTree(fixture.root);
      const env = {
        OPENCLAW_SHELL_SENTINEL: shellSentinel,
        SHELL: "/bin/sh",
      };

      const preflight = await runPreflight(fixture, env);

      expect(preflight.code).toBe(2);
      expect(JSON.parse(preflight.stdout)).toMatchObject({
        status: "indeterminate",
        blockers: [],
        errors: [
          expect.objectContaining({
            code: "gateway-shell-env-inspection-required",
            message: expect.stringContaining("OPENCLAW_GATEWAY_TOKEN"),
          }),
        ],
      });
      expect(await snapshotTree(fixture.root)).toEqual(before);
      await expect(fs.access(shellSentinel)).rejects.toThrow();

      await expect(runGatewayUntilFile(fixture, env, shellSentinel, 90_000)).resolves.toBe(
        "shell-ran",
      );
    }, 120_000);

    it("does not require or execute shell fallback when config fixes Gateway auth", async () => {
      const fixture = await createFixture({
        config: {
          gateway: {
            mode: "local",
            auth: { mode: "token", token: "validator-explicit-token" },
          },
          env: { shellEnv: { enabled: true } },
          memory: { search: { provider: "none" } },
        },
      });
      const shellSentinel = path.join(fixture.root, "shell-ran");
      await fs.writeFile(
        path.join(fixture.root, ".profile"),
        [
          'export OPENCLAW_GATEWAY_TOKEN="validator-shell-token"',
          'printf shell-ran > "$OPENCLAW_SHELL_SENTINEL"',
          "",
        ].join("\n"),
      );
      const before = await snapshotTree(fixture.root);

      const preflight = await runPreflight(fixture, {
        OPENCLAW_SHELL_SENTINEL: shellSentinel,
        SHELL: "/bin/sh",
      });

      expect(preflight.code).toBe(0);
      expect(JSON.parse(preflight.stdout)).toMatchObject({
        ok: true,
        status: "ready",
        blockers: [],
        errors: [],
      });
      expect(await snapshotTree(fixture.root)).toEqual(before);
      await expect(fs.access(shellSentinel)).rejects.toThrow();
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

    it("never opens a listener while classifying a probe-dependent bind", async () => {
      const fixture = await createFixture({
        config: {
          gateway: { mode: "local", bind: "auto", auth: { mode: "none" } },
          memory: { search: { provider: "none" } },
        },
      });
      const observerPath = path.join(fixture.root, "observe-listen.cjs");
      const listenLog = path.join(fixture.root, "listen-events.jsonl");
      await fs.writeFile(
        observerPath,
        [
          'const fs = require("node:fs");',
          'const net = require("node:net");',
          "const original = net.createServer;",
          "net.createServer = function (...args) {",
          "  const server = original.apply(this, args);",
          "  const listen = server.listen;",
          "  server.listen = function (...listenArgs) {",
          '    fs.appendFileSync(process.env.OPENCLAW_LISTEN_OBSERVER, JSON.stringify(listenArgs) + "\\n");',
          "    return listen.apply(this, listenArgs);",
          "  };",
          "  return server;",
          "};",
          "",
        ].join("\n"),
      );
      const before = await snapshotTree(fixture.root);

      const result = await runPreflight(fixture, {
        NODE_OPTIONS: `--require=${observerPath}`,
        OPENCLAW_LISTEN_OBSERVER: listenLog,
      });

      expect(result.code).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({
        status: "indeterminate",
        blockers: [],
        errors: [expect.objectContaining({ code: "gateway-bind-inspection-required" })],
      });
      await expect(fs.access(listenLog)).rejects.toThrow();
      expect(await snapshotTree(fixture.root)).toEqual(before);
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
  });
}

export function registerGatewayPreflightMemoryProcessTests(): void {
  describe("gateway preflight CLI memory process", () => {
    it("reports a stable local llama.cpp blocker without mutating config or state", async () => {
      const fixture = await createFixture({
        config: localMemoryConfig(),
        disableMemorySlot: false,
        includeFixturePlugin: false,
        includeSharedStateDatabase: true,
        vectorModel: "embeddinggemma-300m",
      });
      const before = await snapshotTree(fixture.root);
      const env = { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0" };

      const first = await runPreflight(fixture, env);
      const second = await runPreflight(fixture, env);

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

    it("keeps a closed canonical shared-state database sidecar-free across built artifact reads", async () => {
      const fixture = await createFixture({
        config: {
          ...localMemoryConfig(),
          gateway: { mode: "local", auth: { mode: "none" } },
        },
        canonicalSharedStateDatabase: true,
        disableMemorySlot: false,
        includeFixturePlugin: false,
        vectorModel: "embeddinggemma-300m",
      });
      const before = await snapshotTree(fixture.root);

      const result = await runPreflight(
        fixture,
        {
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
        },
        150_000,
      );

      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        status: "blocked",
        blockers: [expect.objectContaining({ code: "managed-server-config-missing" })],
        errors: [],
      });
      expect(await snapshotTree(fixture.root)).toEqual(before);
    }, 180_000);

    it("blocks configured local setup when the selected chat GGUF is missing", async () => {
      const embeddingModelPath = await createGgufFixture("embedding.gguf");
      const fixture = await createFixture({
        config: configuredLlamaCppMemoryConfig({ embeddingModelPath }),
        disableMemorySlot: false,
        includeFixturePlugin: false,
        vectorModel: "embeddinggemma-300m",
      });
      const before = await snapshotTree(fixture.root);
      const preflightEnv = { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0" };

      const preflight = await runPreflight(fixture, preflightEnv);

      expect(preflight.code).toBe(1);
      expect(JSON.parse(preflight.stdout)).toMatchObject({
        ok: false,
        status: "blocked",
        blockers: [
          expect.objectContaining({
            code: "chat-model-cache-missing",
            provider: "local",
            message: expect.stringContaining("/models/chat.gguf"),
          }),
        ],
        errors: [],
      });
      expect(await snapshotTree(fixture.root)).toEqual(before);

      const startup = await runGateway(fixture, {
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
      });
      expect(startup.code).toBe(1);
      expect(startup.stderr).toMatch(/model file is missing: \/models\/chat\.gguf/i);
    }, 180_000);

    it("accepts configured local setup and a local provider with no semantic index", async () => {
      const chatModelPath = await createGgufFixture("chat.gguf");
      const configured = await createFixture({
        config: configuredLlamaCppMemoryConfig({ chatModelPath }),
        disableMemorySlot: false,
        includeFixturePlugin: false,
        vectorModel: "embeddinggemma-300m",
      });
      const noIndex = await createFixture({
        config: localMemoryConfig(),
        disableMemorySlot: false,
        includeFixturePlugin: false,
      });
      const env = { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0" };

      for (const fixture of [configured, noIndex]) {
        const before = await snapshotTree(fixture.root);
        const result = await runPreflight(fixture, env);
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
  });
}

export function registerGatewayPreflightProviderProcessTests(): void {
  describe("gateway preflight CLI provider process", () => {
    it("fails closed when the selected embedding provider owner is disabled", async () => {
      const config = {
        ...configuredLlamaCppMemoryConfig(),
        gateway: { mode: "local", auth: { mode: "none" } },
        plugins: {
          entries: {
            "llama-cpp": { enabled: false },
          },
        },
      };
      const semantic = await createFixture({
        config,
        includeFixturePlugin: false,
        includeSharedStateDatabase: false,
        vectorModel: "embeddinggemma-300m",
      });
      const noIndex = await createFixture({
        config,
        includeFixturePlugin: false,
        includeSharedStateDatabase: false,
      });
      const before = await snapshotTree(semantic.root);
      const env = { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0" };

      const preflight = await runPreflight(semantic, env);

      expect(preflight.code).toBe(2);
      expect(JSON.parse(preflight.stdout)).toMatchObject({
        status: "indeterminate",
        blockers: [],
        errors: [expect.objectContaining({ code: "inspection-indeterminate" })],
      });
      expect(await snapshotTree(semantic.root)).toEqual(before);

      const startup = await runGateway(semantic, env);
      expect(startup.code).not.toBe(0);
      expect(startup.stderr).toMatch(/unknown memory embedding provider: local/i);

      const noIndexResult = await runPreflight(noIndex, env);
      expect(noIndexResult.code).toBe(0);
      expect(JSON.parse(noIndexResult.stdout)).toMatchObject({
        status: "ready",
        blockers: [],
        errors: [],
      });
    }, 180_000);

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
        disableMemorySlot: false,
        includeFixturePlugin: false,
        vectorModel: "text-embedding-3-small",
      });
      const invalid = await createFixture({
        config: { gateway: { mode: "not-a-mode" } },
      });

      const remoteResult = await runPreflight(remote, {
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
      });
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

    it("does not execute configured external preflight or provider runtime code", async () => {
      const fixture = await createFixture({
        config: localMemoryConfig(),
        disableMemorySlot: false,
        includeFixturePlugin: true,
        vectorModel: "embeddinggemma-300m",
      });
      const runtimeSentinelPath = path.join(fixture.root, "provider-runtime-activated");
      const contractSentinelPath = path.join(fixture.root, "doctor-contract-loaded");

      const result = await runPreflight(fixture, {
        OPENCLAW_PREFLIGHT_ACTIVATION_SENTINEL: runtimeSentinelPath,
        OPENCLAW_PREFLIGHT_CONTRACT_SENTINEL: contractSentinelPath,
      });

      expect(result.code).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({
        status: "indeterminate",
        blockers: [],
        errors: [
          expect.objectContaining({
            code: "external-plugin-inspection-unsupported",
            pluginId: PREFLIGHT_FIXTURE_PLUGIN_ID,
          }),
        ],
      });
      await expect(fs.access(contractSentinelPath)).rejects.toThrow();
      await expect(fs.access(runtimeSentinelPath)).rejects.toThrow();
    });
  });
}

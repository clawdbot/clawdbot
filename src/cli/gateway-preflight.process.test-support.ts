import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { afterEach } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";

const execFileAsync = promisify(execFile);
const roots = new Set<string>();
const sharedStateDatabases = new Set<DatabaseSync>();
export const PREFLIGHT_FIXTURE_PLUGIN_ID = "gateway-preflight-fixture";

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

export async function createFixture(params: {
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

export async function snapshotTree(
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
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });
  }
}

export async function runGatewayUntilFile(
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

export async function runPreflight(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  envOverrides: NodeJS.ProcessEnv = {},
  timeoutMs?: number,
) {
  return runCli(fixture, ["gateway", "preflight", "--json"], envOverrides, timeoutMs);
}

export async function runGateway(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  envOverrides: NodeJS.ProcessEnv = {},
  timeoutMs?: number,
) {
  return runCli(fixture, ["gateway", "run", "--port", "39411"], envOverrides, timeoutMs);
}

export function localMemoryConfig() {
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

export function configuredLlamaCppMemoryConfig(
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

export async function createGgufFixture(name: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-preflight-model-"));
  roots.add(root);
  const filePath = path.join(root, name);
  await fs.writeFile(filePath, "GGUFfixture");
  return filePath;
}

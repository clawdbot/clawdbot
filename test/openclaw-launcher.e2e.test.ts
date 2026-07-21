// OpenClaw launcher E2E tests validate launcher process behavior.
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "./helpers/temp-dir.js";

async function makeLauncherFixture(fixtureRoots: string[]): Promise<string> {
  const fixtureRoot = makeTempDir(fixtureRoots, "openclaw-launcher-");
  await fs.copyFile(
    path.resolve(process.cwd(), "openclaw.mjs"),
    path.join(fixtureRoot, "openclaw.mjs"),
  );
  await fs.mkdir(path.join(fixtureRoot, "dist"), { recursive: true });
  return fixtureRoot;
}

async function makeLauncherProbeFixture(
  fixtureRoots: string[],
  probeSource: string,
): Promise<string> {
  const fixtureRoot = await makeLauncherFixture(fixtureRoots);
  const launcherPath = path.join(fixtureRoot, "openclaw.mjs");
  const launcher = await fs.readFile(launcherPath, "utf8");
  const bootstrapStart = "\nif (!waitingForCompileCacheRespawn) {";
  const bootstrapIndex = launcher.indexOf(bootstrapStart);
  if (bootstrapIndex < 0) {
    throw new Error("openclaw launcher bootstrap block was not found");
  }
  await fs.writeFile(
    launcherPath,
    `${launcher.slice(0, bootstrapIndex)}\n${probeSource}\n`,
    "utf8",
  );
  return fixtureRoot;
}

async function addSourceTreeMarker(fixtureRoot: string): Promise<void> {
  await fs.mkdir(path.join(fixtureRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(fixtureRoot, "src", "entry.ts"), "export {};\n", "utf8");
}

async function addGitMarker(fixtureRoot: string): Promise<void> {
  await fs.writeFile(path.join(fixtureRoot, ".git"), "gitdir: .git/worktrees/openclaw\n", "utf8");
}

async function addCompileCacheProbe(fixtureRoot: string): Promise<void> {
  await fs.writeFile(
    path.join(fixtureRoot, "dist", "entry.js"),
    [
      'import module from "node:module";',
      "process.stdout.write(",
      '  `${module.getCompileCacheDir?.() ? "cache:enabled" : "cache:disabled"};respawn:${process.env.OPENCLAW_COMPILE_CACHE_DISABLED_RESPAWNED ?? "0"}`',
      ");",
    ].join("\n"),
    "utf8",
  );
}

async function addLauncherRuntimeMock(
  fixtureRoot: string,
  params: { nodeVersion: string; platform: NodeJS.Platform },
): Promise<string> {
  const mockPath = path.join(fixtureRoot, "mock-launcher-runtime.mjs");
  await fs.writeFile(
    mockPath,
    [
      "Object.defineProperty(process, 'platform', {",
      `  value: ${JSON.stringify(params.platform)},`,
      "});",
      "Object.defineProperty(process.versions, 'node', {",
      `  value: ${JSON.stringify(params.nodeVersion)},`,
      "});",
    ].join("\n"),
    "utf8",
  );
  return mockPath;
}

async function waitForJsonFile<T>(filePath: string, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() <= deadline) {
    try {
      return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => {
        setTimeout(resolve, 5);
      });
    }
  }
  throw new Error(`timed out waiting for parseable JSON in ${filePath}`, { cause: lastError });
}

async function waitForProcessExit(
  child: ReturnType<typeof spawn>,
  label: string,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }

  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const [code, exitSignal] = (await once(child, "exit", { signal })) as [
      number | null,
      NodeJS.Signals | null,
    ];
    return { code, signal: exitSignal };
  } catch (error) {
    throw new Error(`timed out waiting for ${label} to exit`, { cause: error });
  }
}

function isProcessAlive(pid: number | undefined): boolean {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function launcherEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  delete env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  delete env.OPENCLAW_CONFIG_PATH;
  delete env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
  delete env.OPENCLAW_HOME;
  delete env.OPENCLAW_STATE_DIR;
  delete env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;
  delete env.NODE_COMPILE_CACHE;
  delete env.NODE_DISABLE_COMPILE_CACHE;
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  return env;
}

function hasBunRuntime(): boolean {
  return (
    spawnSync(process.env.BUN_BIN ?? "bun", ["--version"], {
      encoding: "utf8",
    }).status === 0
  );
}

describe("openclaw launcher", () => {
  const fixtureRoots: string[] = [];

  afterEach(async () => {
    cleanupTempDirs(fixtureRoots);
  });

  it("keeps the bootstrap Node range aligned with the package engine", async () => {
    const packageJsonRaw = await fs.readFile(path.resolve(process.cwd(), "package.json"), "utf8");
    const packageJson = JSON.parse(packageJsonRaw) as { engines?: { node?: string } };
    expect(packageJson.engines?.node).toBe(">=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0");

    const fixtureRoot = await makeLauncherFixture(fixtureRoots);
    await fs.writeFile(
      path.join(fixtureRoot, "dist", "entry.js"),
      'process.stdout.write("runtime-loaded\\n");\n',
      "utf8",
    );

    const cases = [
      { version: "22.22.2", supported: false },
      { version: "22.22.3", supported: true },
      { version: "23.11.0", supported: false },
      { version: "24.14.1", supported: false },
      { version: "24.15.0", supported: true },
      { version: "25.8.1", supported: false },
      { version: "25.9.0", supported: true },
      { version: "26.0.0", supported: true },
    ] as const;

    for (const testCase of cases) {
      const mockNodeVersionPath = path.join(
        fixtureRoot,
        `mock-node-version-${testCase.version}.mjs`,
      );
      await fs.writeFile(
        mockNodeVersionPath,
        [
          "Object.defineProperty(process.versions, 'node', {",
          `  value: ${JSON.stringify(testCase.version)},`,
          "});",
        ].join("\n"),
        "utf8",
      );

      const result = spawnSync(
        process.execPath,
        [
          "--import",
          pathToFileURL(mockNodeVersionPath).href,
          path.join(fixtureRoot, "openclaw.mjs"),
          "--help",
        ],
        {
          cwd: fixtureRoot,
          env: launcherEnv(),
          encoding: "utf8",
        },
      );

      if (testCase.supported) {
        expect(result.status, testCase.version).toBe(0);
        expect(result.stdout, testCase.version).toContain("runtime-loaded");
      } else {
        expect(result.status, testCase.version).toBe(1);
        expect(result.stderr, testCase.version).toContain(
          `openclaw: Node.js >=22.22.3 <23, >=24.15.0 <25, or >=25.9.0 is required (current: v${testCase.version}).`,
        );
      }
    }
  });

  it("rejects Bun even when its Node compatibility version is new enough", async () => {
    const fixtureRoot = await makeLauncherFixture(fixtureRoots);
    await fs.writeFile(
      path.join(fixtureRoot, "dist", "entry.js"),
      'process.stdout.write("unexpected-bun-runtime\\n");\n',
      "utf8",
    );
    const mockRuntime = path.join(fixtureRoot, "mock-bun-runtime.mjs");
    await fs.writeFile(
      mockRuntime,
      [
        "Object.defineProperty(process.versions, 'bun', { value: '1.3.14' });",
        "Object.defineProperty(process.versions, 'node', { value: '24.3.0' });",
      ].join("\n"),
      "utf8",
    );

    const result = spawnSync(
      process.execPath,
      ["--import", pathToFileURL(mockRuntime).href, path.join(fixtureRoot, "openclaw.mjs")],
      {
        cwd: fixtureRoot,
        env: launcherEnv(),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "the Bun runtime is unsupported because OpenClaw requires node:sqlite",
    );
  });

  it("surfaces transitive entry import failures instead of masking them as missing dist", async () => {
    const fixtureRoot = await makeLauncherFixture(fixtureRoots);
    await fs.writeFile(
      path.join(fixtureRoot, "dist", "entry.js"),
      'import "missing-openclaw-launcher-dep";\nexport {};\n',
      "utf8",
    );

    const result = spawnSync(process.execPath, [path.join(fixtureRoot, "openclaw.mjs"), "--help"], {
      cwd: fixtureRoot,
      env: launcherEnv(),
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("missing-openclaw-launcher-dep");
    expect(result.stderr).not.toContain("missing dist/entry.(m)js");
  });

  it("keeps the friendly launcher error for a truly missing entry build output", async () => {
    const fixtureRoot = await makeLauncherFixture(fixtureRoots);

    const result = spawnSync(process.execPath, [path.join(fixtureRoot, "openclaw.mjs"), "--help"], {
      cwd: fixtureRoot,
      env: launcherEnv(),
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("missing dist/entry.(m)js");
  });

  it("prints root version without importing the runtime entry", async () => {
    const fixtureRoot = await makeLauncherFixture(fixtureRoots);
    await fs.writeFile(
      path.join(fixtureRoot, "package.json"),
      JSON.stringify({
        name: "openclaw",
        version: "1.2.3-test",
        gitHead: "abcdef0123456789",
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(fixtureRoot, "dist", "entry.js"),
      "throw new Error('runtime entry should not load for --version');\n",
      "utf8",
    );

    const result = spawnSync(
      process.execPath,
      [path.join(fixtureRoot, "openclaw.mjs"), "--version"],
      {
        cwd: fixtureRoot,
        env: launcherEnv(),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("OpenClaw 1.2.3-test (abcdef0)\n");
    expect(result.stderr).toBe("");
  });

  it("defers container-targeted root version to the runtime entry", async () => {
    const fixtureRoot = await makeLauncherFixture(fixtureRoots);
    await fs.writeFile(
      path.join(fixtureRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "1.2.3-test" }),
      "utf8",
    );
    await fs.writeFile(
      path.join(fixtureRoot, "dist", "entry.js"),
      "process.stdout.write('RUNTIME ENTRY\\n');\n",
      "utf8",
    );

    const result = spawnSync(
      process.execPath,
      [path.join(fixtureRoot, "openclaw.mjs"), "--container", "demo", "--version"],
      {
        cwd: fixtureRoot,
        env: launcherEnv(),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("RUNTIME ENTRY\n");

    const envResult = spawnSync(
      process.execPath,
      [path.join(fixtureRoot, "openclaw.mjs"), "--version"],
      {
        cwd: fixtureRoot,
        env: launcherEnv({ OPENCLAW_CONTAINER: "demo" }),
        encoding: "utf8",
      },
    );

    expect(envResult.status).toBe(0);
    expect(envResult.stdout).toBe("RUNTIME ENTRY\n");
  });

  it("treats Bun direct optional import misses as direct launcher misses", async () => {
    const fixtureRoot = await makeLauncherProbeFixture(
      fixtureRoots,
      [
        "const result = {",
        "  direct: isDirectModuleNotFoundError(",
        "    { message: `Cannot find module './dist/warning-filter.js' from '${fileURLToPath(import.meta.url)}'` },",
        "    './dist/warning-filter.js',",
        "  ),",
        "  directWithCode: isDirectModuleNotFoundError(",
        "    { code: 'ERR_MODULE_NOT_FOUND', message: `Cannot find module './dist/warning-filter.js' from '${fileURLToPath(import.meta.url)}'` },",
        "    './dist/warning-filter.js',",
        "  ),",
        "  transitive: isDirectModuleNotFoundError(",
        "    { message: \"Cannot find module './nested.js' from '/pkg/openclaw/dist/entry.js'\" },",
        "    './dist/entry.js',",
        "  ),",
        "  sameSpecifierTransitive: isDirectModuleNotFoundError(",
        "    { message: \"Cannot find module './dist/entry.js' from '/pkg/openclaw/dist/entry.js'\" },",
        "    './dist/entry.js',",
        "  ),",
        "  nonModuleUrl: isDirectModuleNotFoundError(",
        "    { message: 'boom', url: new URL('./dist/warning-filter.js', import.meta.url).href },",
        "    './dist/warning-filter.js',",
        "  ),",
        "  nonModulePath: isDirectModuleNotFoundError(",
        "    { message: `Cannot find module '${fileURLToPath(new URL('./dist/warning-filter.js', import.meta.url))}'` },",
        "    './dist/warning-filter.js',",
        "  ),",
        "};",
        "process.stdout.write(`${JSON.stringify(result)}\\n`);",
      ].join("\n"),
    );

    const result = spawnSync(process.execPath, [path.join(fixtureRoot, "openclaw.mjs")], {
      cwd: fixtureRoot,
      env: launcherEnv(),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      direct: true,
      directWithCode: true,
      nonModulePath: false,
      nonModuleUrl: false,
      sameSpecifierTransitive: false,
      transitive: false,
    });
  });

  it.runIf(process.env.OPENCLAW_TEST_BUN_LAUNCHER === "1" && hasBunRuntime())(
    "rejects the real Bun runtime before loading the CLI",
    async () => {
      const fixtureRoot = await makeLauncherFixture(fixtureRoots);
      await fs.writeFile(
        path.join(fixtureRoot, "dist", "entry.js"),
        "process.stdout.write('unexpected bun entry\\n');\n",
        "utf8",
      );

      const result = spawnSync(
        process.env.BUN_BIN ?? "bun",
        [path.join(fixtureRoot, "openclaw.mjs")],
        {
          cwd: fixtureRoot,
          env: launcherEnv(),
          encoding: "utf8",
        },
      );

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(
        "the Bun runtime is unsupported because OpenClaw requires node:sqlite",
      );
    },
  );

  it("uses precomputed root help when plugin config does not invalidate it", async () => {
    const fixtureRoot = await makeLauncherFixture(fixtureRoots);
    await fs.writeFile(
      path.join(fixtureRoot, "dist", "cli-startup-metadata.json"),
      JSON.stringify({ rootHelpText: "PRECOMPUTED help\n" }),
      "utf8",
    );

    const result = spawnSync(process.execPath, [path.join(fixtureRoot, "openclaw.mjs"), "--help"], {
      cwd: fixtureRoot,
      env: launcherEnv(),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("PRECOMPUTED help\n");
  });

  it.each([
    { command: "browser", metadataKey: "browserHelpText" },
    { command: "secrets", metadataKey: "secretsHelpText" },
    { command: "nodes", metadataKey: "nodesHelpText" },
  ])("uses precomputed $command help before loading the runtime entry", async (params) => {
    const fixtureRoot = await makeLauncherFixture(fixtureRoots);
    await fs.writeFile(
      path.join(fixtureRoot, "dist", "cli-startup-metadata.json"),
      JSON.stringify({ [params.metadataKey]: `PRECOMPUTED ${params.command} help\n` }),
      "utf8",
    );

    const result = spawnSync(
      process.execPath,
      [path.join(fixtureRoot, "openclaw.mjs"), params.command, "--help"],
      {
        cwd: fixtureRoot,
        env: launcherEnv(),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`PRECOMPUTED ${params.command} help\n`);
  });

  it.each(["doctor", "gateway", "models", "plugins", "sessions", "tasks"])(
    "uses precomputed %s help before loading the runtime entry",
    async (command) => {
      const fixtureRoot = await makeLauncherFixture(fixtureRoots);
      await fs.writeFile(
        path.join(fixtureRoot, "dist", "cli-startup-metadata.json"),
        JSON.stringify({ subcommandHelpText: { [command]: `PRECOMPUTED ${command} help\n` } }),
        "utf8",
      );

      const result = spawnSync(
        process.execPath,
        [path.join(fixtureRoot, "openclaw.mjs"), command, "--help"],
        {
          cwd: fixtureRoot,
          env: launcherEnv(),
          encoding: "utf8",
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toBe(`PRECOMPUTED ${command} help\n`);
    },
  );

  it("uses precomputed subcommand help with leading root options", async () => {
    const fixtureRoot = await makeLauncherFixture(fixtureRoots);
    await fs.writeFile(
      path.join(fixtureRoot, "dist", "cli-startup-metadata.json"),
      JSON.stringify({ subcommandHelpText: { models: "PRECOMPUTED models help\n" } }),
      "utf8",
    );

    const result = spawnSync(
      process.execPath,
      [path.join(fixtureRoot, "openclaw.mjs"), "--profile", "work", "--no-color", "models", "-h"],
      {
        cwd: fixtureRoot,
        env: launcherEnv(),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("PRECOMPUTED models help\n");
  });

  it("defers precomputed subcommand help to the runtime entry when container env is set", async () => {
    const fixtureRoot = await makeLauncherFixture(fixtureRoots);
    await fs.writeFile(
      path.join(fixtureRoot, "dist", "cli-startup-metadata.json"),
      JSON.stringify({ subcommandHelpText: { models: "PRECOMPUTED models help\n" } }),
      "utf8",
    );
    await fs.writeFile(
      path.join(fixtureRoot, "dist", "entry.js"),
      "process.stdout.write('RUNTIME ENTRY\\n');\n",
      "utf8",
    );

    const result = spawnSync(
      process.execPath,
      [path.join(fixtureRoot, "openclaw.mjs"), "models", "--help"],
      {
        cwd: fixtureRoot,
        env: launcherEnv({ OPENCLAW_CONTAINER: "demo" }),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("RUNTIME ENTRY\n");
    expect(result.stdout).not.toContain("PRECOMPUTED");
  });

  it.each([
    {
      name: "container env",
      args: ["browser", "--help"],
      env: { OPENCLAW_CONTAINER: "demo" },
    },
    {
      name: "root --container flag",
      args: ["--container", "demo", "browser", "--help"],
      env: {},
    },
    {
      name: "root --container=value flag",
      args: ["--container=demo", "browser", "--help"],
      env: {},
    },
  ])("defers precomputed command help to the runtime entry with $name", async (params) => {
    const fixtureRoot = await makeLauncherFixture(fixtureRoots);
    await fs.writeFile(
      path.join(fixtureRoot, "dist", "cli-startup-metadata.json"),
      JSON.stringify({ browserHelpText: "PRECOMPUTED browser help\n" }),
      "utf8",
    );
    await fs.writeFile(
      path.join(fixtureRoot, "dist", "entry.js"),
      "process.stdout.write('RUNTIME ENTRY\\n');\n",
      "utf8",
    );

    const result = spawnSync(
      process.execPath,
      [path.join(fixtureRoot, "openclaw.mjs"), ...params.args],
      {
        cwd: fixtureRoot,
        env: launcherEnv(params.env),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("RUNTIME ENTRY\n");
    expect(result.stdout).not.toContain("PRECOMPUTED");
  });

  it("defers root help to the runtime entry when plugin config can change help", async () => {
    const fixtureRoot = await makeLauncherFixture(fixtureRoots);
    const configPath = path.join(fixtureRoot, "openclaw.json");
    await fs.writeFile(
      path.join(fixtureRoot, "dist", "cli-startup-metadata.json"),
      JSON.stringify({ rootHelpText: "PRECOMPUTED memory help\n" }),
      "utf8",
    );
    await fs.writeFile(
      path.join(fixtureRoot, "dist", "entry.js"),
      "process.stdout.write('RUNTIME ENTRY\\n');\n",
      "utf8",
    );
    await fs.writeFile(
      configPath,
      JSON.stringify({ plugins: { slots: { memory: "memory-lancedb" } } }),
      "utf8",
    );

    const result = spawnSync(process.execPath, [path.join(fixtureRoot, "openclaw.mjs"), "--help"], {
      cwd: fixtureRoot,
      env: launcherEnv({ OPENCLAW_CONFIG_PATH: configPath }),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("RUNTIME ENTRY\n");
    expect(result.stdout).not.toContain("PRECOMPUTED");
  });

  it("defers nodes help to the runtime entry when plugin config can change help", async () => {
    const fixtureRoot = await makeLauncherFixture(fixtureRoots);
    const configPath = path.join(fixtureRoot, "openclaw.json");
    await fs.writeFile(
      path.join(fixtureRoot, "dist", "cli-startup-metadata.json"),
      JSON.stringify({ nodesHelpText: "PRECOMPUTED nodes help\n" }),
      "utf8",
    );
    await fs.writeFile(
      path.join(fixtureRoot, "dist", "entry.js"),
      "process.stdout.write('RUNTIME ENTRY\\n');\n",
      "utf8",
    );
    await fs.writeFile(
      configPath,
      JSON.stringify({ plugins: { entries: { canvas: { enabled: false } } } }),
      "utf8",
    );

    const result = spawnSync(
      process.execPath,
      [path.join(fixtureRoot, "openclaw.mjs"), "nodes", "--help"],
      {
        cwd: fixtureRoot,
        env: launcherEnv({ OPENCLAW_CONFIG_PATH: configPath }),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("RUNTIME ENTRY\n");
    expect(result.stdout).not.toContain("PRECOMPUTED");
  });

  it("checks the OPENCLAW_HOME default config path before using precomputed root help", async () => {
    const fixtureRoot = await makeLauncherFixture(fixtureRoots);
    const openclawHome = path.join(fixtureRoot, "home");
    const configDir = path.join(openclawHome, ".openclaw");
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(fixtureRoot, "dist", "cli-startup-metadata.json"),
      JSON.stringify({ rootHelpText: "PRECOMPUTED memory help\n" }),
      "utf8",
    );
    await fs.writeFile(
      path.join(fixtureRoot, "dist", "entry.js"),
      "process.stdout.write('RUNTIME ENTRY\\n');\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(configDir, "openclaw.json"),
      JSON.stringify({ plugins: { slots: { memory: "memory-lancedb" } } }),
      "utf8",
    );

    const result = spawnSync(process.execPath, [path.join(fixtureRoot, "openclaw.mjs"), "--help"], {
      cwd: fixtureRoot,
      env: launcherEnv({ OPENCLAW_HOME: openclawHome }),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("RUNTIME ENTRY\n");
    expect(result.stdout).not.toContain("PRECOMPUTED");
  });

  it("checks legacy config candidates before using precomputed root help", async () => {
    const fixtureRoot = await makeLauncherFixture(fixtureRoots);
    const home = path.join(fixtureRoot, "home");
    const legacyConfigDir = path.join(home, ".clawdbot");
    await fs.mkdir(legacyConfigDir, { recursive: true });
    await fs.writeFile(
      path.join(fixtureRoot, "dist", "cli-startup-metadata.json"),
      JSON.stringify({ rootHelpText: "PRECOMPUTED memory help\n" }),
      "utf8",
    );
    await fs.writeFile(
      path.join(fixtureRoot, "dist", "entry.js"),
      "process.stdout.write('RUNTIME ENTRY\\n');\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(legacyConfigDir, "clawdbot.json"),
      JSON.stringify({ plugins: { slots: { memory: "memory-lancedb" } } }),
      "utf8",
    );

    const result = spawnSync(process.execPath, [path.join(fixtureRoot, "openclaw.mjs"), "--help"], {
      cwd: fixtureRoot,
      env: launcherEnv({ HOME: home, OPENCLAW_HOME: undefined }),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("RUNTIME ENTRY\n");
    expect(result.stdout).not.toContain("PRECOMPUTED");
  });

  it("defers root help when the active config has includes", async () => {
    const fixtureRoot = await makeLauncherFixture(fixtureRoots);
    const configPath = path.join(fixtureRoot, "openclaw.json");
    await fs.writeFile(
      path.join(fixtureRoot, "dist", "cli-startup-metadata.json"),
      JSON.stringify({ rootHelpText: "PRECOMPUTED memory help\n" }),
      "utf8",
    );
    await fs.writeFile(
      path.join(fixtureRoot, "dist", "entry.js"),
      "process.stdout.write('RUNTIME ENTRY\\n');\n",
      "utf8",
    );
    await fs.writeFile(configPath, JSON.stringify({ $include: "memory.json" }), "utf8");

    const result = spawnSync(process.execPath, [path.join(fixtureRoot, "openclaw.mjs"), "--help"], {
      cwd: fixtureRoot,
      env: launcherEnv({ OPENCLAW_CONFIG_PATH: configPath }),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("RUNTIME ENTRY\n");
    expect(result.stdout).not.toContain("PRECOMPUTED");
  });

  it("explains how to recover from an unbuilt source install", async () => {
    const fixtureRoot = await makeLauncherFixture(fixtureRoots);
    await addSourceTreeMarker(fixtureRoot);

    const result = spawnSync(process.execPath, [path.join(fixtureRoot, "openclaw.mjs"), "--help"], {
      cwd: fixtureRoot,
      env: launcherEnv(),
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("missing dist/entry.(m)js");
    expect(result.stderr).toContain("unbuilt source tree or GitHub source archive");
    expect(result.stderr).toContain("pnpm install && pnpm build");
    expect(result.stderr).toContain("github:openclaw/openclaw#<ref>");
  });

  it("keeps compile cache off for source-checkout launchers", async () => {
    const fixtureRoot = await makeLauncherFixture(fixtureRoots);
    await addSourceTreeMarker(fixtureRoot);
    await addCompileCacheProbe(fixtureRoot);

    const result = spawnSync(process.execPath, [path.join(fixtureRoot, "openclaw.mjs")], {
      cwd: fixtureRoot,
      env: launcherEnv(),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("cache:disabled;respawn:0");
  });

  it("respawns source-checkout launchers without inherited NODE_COMPILE_CACHE", async () => {
    const fixtureRoot = await makeLauncherFixture(fixtureRoots);
    await addGitMarker(fixtureRoot);
    await addCompileCacheProbe(fixtureRoot);

    const result = spawnSync(process.execPath, [path.join(fixtureRoot, "openclaw.mjs")], {
      cwd: fixtureRoot,
      env: launcherEnv({
        NODE_COMPILE_CACHE: path.join(fixtureRoot, ".node-compile-cache"),
      }),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("cache:disabled;respawn:1");
  });

  it.runIf(process.platform !== "win32")(
    "forwards SIGTERM to source-checkout compile-cache respawn children",
    async () => {
      const fixtureRoot = await makeLauncherFixture(fixtureRoots);
      await addGitMarker(fixtureRoot);
      const childInfoPath = path.join(fixtureRoot, "child-info.json");
      const signalPath = path.join(fixtureRoot, "sigterm-received.txt");
      await fs.writeFile(
        path.join(fixtureRoot, "dist", "entry.js"),
        [
          'import { writeFileSync } from "node:fs";',
          'process.title = "openclaw-launcher-sigterm-test-child";',
          `process.on("SIGTERM", () => { writeFileSync(${JSON.stringify(signalPath)}, "SIGTERM\\n"); process.exit(0); });`,
          `writeFileSync(${JSON.stringify(childInfoPath)}, JSON.stringify({ pid: process.pid }) + "\\n");`,
          "setInterval(() => {}, 1000);",
          "",
        ].join("\n"),
        "utf8",
      );

      const launcher = spawn(process.execPath, [path.join(fixtureRoot, "openclaw.mjs")], {
        cwd: fixtureRoot,
        env: launcherEnv({
          NODE_COMPILE_CACHE: path.join(fixtureRoot, ".node-compile-cache"),
        }),
        stdio: "ignore",
      });
      let respawnChildPid: number | undefined;

      try {
        const childInfo = await waitForJsonFile<{ pid: number }>(childInfoPath, 5000);
        respawnChildPid = childInfo.pid;

        launcher.kill("SIGTERM");

        await expect(waitForProcessExit(launcher, "launcher", 5000)).resolves.toEqual({
          code: 0,
          signal: null,
        });
        await expect(fs.readFile(signalPath, "utf8")).resolves.toBe("SIGTERM\n");
        expect(isProcessAlive(respawnChildPid)).toBe(false);
      } finally {
        if (isProcessAlive(respawnChildPid)) {
          process.kill(respawnChildPid!, "SIGKILL");
        }
        if (isProcessAlive(launcher.pid)) {
          process.kill(launcher.pid!, "SIGKILL");
        }
      }
    },
  );

  it.runIf(process.platform !== "win32").each([
    { signal: "SIGINT" as const, exitCode: 130 },
    { signal: "SIGTERM" as const, exitCode: 143 },
  ])("exits $exitCode when the respawn child terminates from $signal", async (testCase) => {
    const fixtureRoot = await makeLauncherFixture(fixtureRoots);
    await addGitMarker(fixtureRoot);
    const childInfoPath = path.join(fixtureRoot, "child-info.json");
    await fs.writeFile(
      path.join(fixtureRoot, "dist", "entry.js"),
      [
        'import { writeFileSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(childInfoPath)}, JSON.stringify({ pid: process.pid }) + "\\n");`,
        'process.title = "openclaw-launcher-default-signal-test-child";',
        "setInterval(() => {}, 1000);",
        "",
      ].join("\n"),
      "utf8",
    );

    const launcher = spawn(process.execPath, [path.join(fixtureRoot, "openclaw.mjs")], {
      cwd: fixtureRoot,
      env: launcherEnv({
        NODE_COMPILE_CACHE: path.join(fixtureRoot, ".node-compile-cache"),
      }),
      stdio: "ignore",
    });
    let respawnChildPid: number | undefined;

    try {
      const childInfo = await waitForJsonFile<{ pid: number }>(childInfoPath, 5000);
      respawnChildPid = childInfo.pid;

      launcher.kill(testCase.signal);

      await expect(waitForProcessExit(launcher, "launcher", 5000)).resolves.toEqual({
        code: testCase.exitCode,
        signal: null,
      });
      expect(isProcessAlive(respawnChildPid)).toBe(false);
    } finally {
      if (isProcessAlive(respawnChildPid)) {
        process.kill(respawnChildPid!, "SIGKILL");
      }
      if (isProcessAlive(launcher.pid)) {
        process.kill(launcher.pid!, "SIGKILL");
      }
    }
  });

  it.runIf(process.platform !== "win32")(
    "exits after SIGTERM when the respawn child ignores the forwarded signal",
    async () => {
      const fixtureRoot = await makeLauncherFixture(fixtureRoots);
      await addGitMarker(fixtureRoot);
      const childInfoPath = path.join(fixtureRoot, "child-info.json");
      await fs.writeFile(
        path.join(fixtureRoot, "dist", "entry.js"),
        [
          'import { writeFileSync } from "node:fs";',
          'process.title = "openclaw-launcher-sigterm-ignore-test-child";',
          'process.on("SIGTERM", () => {});',
          `writeFileSync(${JSON.stringify(childInfoPath)}, JSON.stringify({ pid: process.pid }) + "\\n");`,
          "setInterval(() => {}, 1000);",
          "",
        ].join("\n"),
        "utf8",
      );

      const launcher = spawn(process.execPath, [path.join(fixtureRoot, "openclaw.mjs")], {
        cwd: fixtureRoot,
        env: launcherEnv({
          NODE_COMPILE_CACHE: path.join(fixtureRoot, ".node-compile-cache"),
        }),
        stdio: "ignore",
      });
      let respawnChildPid: number | undefined;

      try {
        const childInfo = await waitForJsonFile<{ pid: number }>(childInfoPath, 5000);
        respawnChildPid = childInfo.pid;

        launcher.kill("SIGTERM");

        await expect(waitForProcessExit(launcher, "launcher", 5000)).resolves.toEqual({
          code: 1,
          signal: null,
        });
        expect(isProcessAlive(launcher.pid)).toBe(false);
        expect(isProcessAlive(respawnChildPid)).toBe(false);
      } finally {
        if (isProcessAlive(respawnChildPid)) {
          process.kill(respawnChildPid!, "SIGKILL");
        }
        if (isProcessAlive(launcher.pid)) {
          process.kill(launcher.pid!, "SIGKILL");
        }
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "respawns symlinked source-checkout launchers without inherited NODE_COMPILE_CACHE",
    async () => {
      const fixtureRoot = await makeLauncherFixture(fixtureRoots);
      await addGitMarker(fixtureRoot);
      await addCompileCacheProbe(fixtureRoot);
      const linkParent = makeTempDir(fixtureRoots, "openclaw-launcher-link-");
      const linkedRoot = path.join(linkParent, "openclaw-linked");
      await fs.symlink(fixtureRoot, linkedRoot, "dir");

      const result = spawnSync(process.execPath, [path.join(linkedRoot, "openclaw.mjs")], {
        cwd: linkParent,
        env: launcherEnv({
          NODE_COMPILE_CACHE: path.join(linkParent, ".node-compile-cache"),
        }),
        encoding: "utf8",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toBe("cache:disabled;respawn:1");
    },
  );

  it("keeps compile cache enabled for packaged launchers when NODE_COMPILE_CACHE is configured", async () => {
    const fixtureRoot = await makeLauncherFixture(fixtureRoots);
    await addCompileCacheProbe(fixtureRoot);

    const result = spawnSync(process.execPath, [path.join(fixtureRoot, "openclaw.mjs")], {
      cwd: fixtureRoot,
      env: launcherEnv({
        NODE_COMPILE_CACHE: path.join(fixtureRoot, ".node-compile-cache"),
      }),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("cache:enabled;respawn:0");
  });

  it.runIf(process.platform !== "win32")(
    "does not respawn native hook relays for packaged compile-cache scoping",
    async () => {
      const fixtureRoot = await makeLauncherFixture(fixtureRoots);
      await fs.writeFile(path.join(fixtureRoot, "package.json"), '{"version":"2026.4.29"}\n');
      await fs.writeFile(
        path.join(fixtureRoot, "dist", "entry.js"),
        'process.stdout.write(process.env.OPENCLAW_PACKAGED_COMPILE_CACHE_RESPAWNED ?? "0");\n',
        "utf8",
      );

      const result = spawnSync(
        process.execPath,
        [path.join(fixtureRoot, "openclaw.mjs"), "hooks", "relay"],
        {
          cwd: fixtureRoot,
          env: launcherEnv({
            NODE_COMPILE_CACHE: path.join(fixtureRoot, ".node-compile-cache"),
          }),
          encoding: "utf8",
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toBe("0");
    },
  );

  it("scopes packaged launcher compile cache inside configured cache roots", async () => {
    const fixtureRoot = await makeLauncherFixture(fixtureRoots);
    await fs.writeFile(path.join(fixtureRoot, "package.json"), '{"version":"2026.4.29"}\n');
    await fs.writeFile(
      path.join(fixtureRoot, "dist", "entry.js"),
      [
        'import module from "node:module";',
        'process.stdout.write(module.getCompileCacheDir?.() ?? "cache:disabled");',
      ].join("\n"),
      "utf8",
    );

    const result = spawnSync(process.execPath, [path.join(fixtureRoot, "openclaw.mjs")], {
      cwd: fixtureRoot,
      env: launcherEnv({
        NODE_COMPILE_CACHE: path.join(fixtureRoot, ".node-compile-cache"),
      }),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(path.join(".node-compile-cache", "openclaw", "2026.4.29"));
  });

  it("falls back to the default packaged launcher compile cache when NODE_COMPILE_CACHE is empty", async () => {
    const fixtureRoot = await makeLauncherFixture(fixtureRoots);
    const runCwd = makeTempDir(fixtureRoots, "openclaw-launcher-cwd-");
    const tmpRoot = makeTempDir(fixtureRoots, "openclaw-launcher-tmp-");
    await fs.writeFile(path.join(fixtureRoot, "package.json"), '{"version":"2026.4.29"}\n');
    await fs.writeFile(
      path.join(fixtureRoot, "dist", "entry.js"),
      [
        'import module from "node:module";',
        'process.stdout.write(module.getCompileCacheDir?.() ?? "cache:disabled");',
      ].join("\n"),
      "utf8",
    );

    const result = spawnSync(process.execPath, [path.join(fixtureRoot, "openclaw.mjs")], {
      cwd: runCwd,
      env: launcherEnv({
        NODE_COMPILE_CACHE: "",
        TMP: tmpRoot,
        TEMP: tmpRoot,
        TMPDIR: tmpRoot,
      }),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(path.join("node-compile-cache", "openclaw", "2026.4.29"));
    expect(result.stdout).not.toContain(path.join(runCwd, "openclaw"));
  });

  it("keeps compile cache enabled for unaffected packaged launcher runtimes", async () => {
    const cases: Array<{ nodeVersion: string; platform: NodeJS.Platform }> = [
      { nodeVersion: "24.15.0", platform: "win32" },
      { nodeVersion: "22.22.3", platform: "linux" },
      { nodeVersion: "25.9.0", platform: "darwin" },
    ];

    for (const runtime of cases) {
      const fixtureRoot = await makeLauncherFixture(fixtureRoots);
      const tmpRoot = makeTempDir(fixtureRoots, "openclaw-launcher-tmp-");
      const mockRuntime = await addLauncherRuntimeMock(fixtureRoot, runtime);
      await addCompileCacheProbe(fixtureRoot);

      const result = spawnSync(
        process.execPath,
        ["--import", pathToFileURL(mockRuntime).href, path.join(fixtureRoot, "openclaw.mjs")],
        {
          cwd: fixtureRoot,
          env: launcherEnv({
            TMP: tmpRoot,
            TEMP: tmpRoot,
            TMPDIR: tmpRoot,
          }),
          encoding: "utf8",
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toBe("cache:enabled;respawn:0");
    }
  });

  it("enables compile cache for packaged launchers", async () => {
    const fixtureRoot = await makeLauncherFixture(fixtureRoots);
    const tmpRoot = makeTempDir(fixtureRoots, "openclaw-launcher-tmp-");
    await addCompileCacheProbe(fixtureRoot);

    const result = spawnSync(process.execPath, [path.join(fixtureRoot, "openclaw.mjs")], {
      cwd: fixtureRoot,
      env: launcherEnv({
        TMP: tmpRoot,
        TEMP: tmpRoot,
        TMPDIR: tmpRoot,
      }),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("cache:enabled;respawn:0");
  });
});

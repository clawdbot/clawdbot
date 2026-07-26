// Plugin Lifecycle Probe tests cover QA Lab plugin lifecycle evidence.
import { spawn, spawnSync } from "node:child_process";
/* oxlint-disable eslint/no-shadow, eslint/prefer-const, eslint/no-promise-executor-return, typescript/restrict-template-expressions, typescript/no-base-to-string -- QA probe intentionally validates loosely typed external JSON and mirrors child-process callback shapes. */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readPluginInstallRecords } from "../../../../scripts/e2e/lib/plugin-index-sqlite.mjs";
import { resolveWindowsTaskkillPath } from "../../../../scripts/lib/windows-taskkill.mjs";

// The Docker entrypoint runs without Vitest installed, so keep cleanup local to this runtime probe.
const tempDirs = (() => {
  const dirs = new Set<string>();
  return {
    make(prefix: string): string {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
      dirs.add(dir);
      return dir;
    },
    cleanup(): void {
      for (const dir of dirs) {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
      }
      dirs.clear();
    },
  };
})();

type ProbeEnv = NodeJS.ProcessEnv;

type MatrixEnv = NodeJS.ProcessEnv;

interface CommandOptions {
  env?: NodeJS.ProcessEnv;
  outputFile?: string;
  spawnImpl?: typeof spawn;
  taskkillImpl?: typeof spawnSync;
  timeoutKillGraceMs?: number;
  timeoutMs?: number;
}

interface RegistryServer {
  env: NodeJS.ProcessEnv;
  stop(): void;
}

function stateDir(env: ProbeEnv = process.env) {
  return env.OPENCLAW_STATE_DIR || path.join(env.HOME ?? os.homedir(), ".openclaw");
}

function configPath(env: ProbeEnv = process.env) {
  return env.OPENCLAW_CONFIG_PATH || path.join(stateDir(env), "openclaw.json");
}

function readJson(file: string) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function readRequiredJson(file: string) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to read JSON from ${file}: ${message}`, { cause: error });
  }
}

function records(env: ProbeEnv = process.env) {
  return readPluginInstallRecords({
    configPath: configPath(env),
    stateDir: stateDir(env),
  }) as Record<string, Record<string, unknown>>;
}

function recordFor(pluginId: string, env: ProbeEnv = process.env) {
  return records(env)[pluginId];
}

function config(env: ProbeEnv = process.env) {
  return readJson(configPath(env));
}

function requiredConfig(env: ProbeEnv = process.env) {
  return readRequiredJson(configPath(env));
}

function assertProbe(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertVersion(pluginId: string, version: string, env: ProbeEnv = process.env) {
  const record = recordFor(pluginId, env);
  assertProbe(record, `install record missing for ${pluginId}`);
  assertProbe(record.source === "npm", `expected npm source for ${pluginId}, got ${record.source}`);
  assertProbe(
    record.resolvedVersion === version || record.version === version,
    `expected ${pluginId} record version ${version}, got ${JSON.stringify(record)}`,
  );
  assertProbe(record.installPath, `install path missing for ${pluginId}`);
  const packageJson = readJson(path.join(String(record.installPath), "package.json"));
  assertProbe(
    packageJson.version === version,
    `expected installed package version ${version}, got ${packageJson.version}`,
  );
}

function assertNpmProjectRoot(pluginId: string, packageName: string, env: ProbeEnv = process.env) {
  const record = recordFor(pluginId, env);
  assertProbe(record?.installPath, `install path missing for ${pluginId}`);
  const installPath = String(record.installPath);
  const relative = path.relative(path.join(stateDir(env), "npm", "projects"), installPath);
  assertProbe(
    !relative.startsWith("..") && !path.isAbsolute(relative),
    `install path outside npm projects: ${installPath}`,
  );
  const segments = relative.split(path.sep);
  const packageSegments = packageName.split("/");
  assertProbe(
    segments.length === 2 + packageSegments.length,
    `unexpected npm project install path: ${installPath}`,
  );
  assertProbe(Boolean(segments[0]), `missing npm project directory: ${installPath}`);
  assertProbe(
    segments[1] === "node_modules",
    `missing project node_modules segment: ${installPath}`,
  );
  for (let index = 0; index < packageSegments.length; index++) {
    assertProbe(
      segments[index + 2] === packageSegments[index],
      `package path mismatch: ${installPath}`,
    );
  }
  assertProbe(
    !fs.existsSync(path.join(stateDir(env), "npm", "node_modules", ...packageSegments)),
    `legacy flat npm install path exists for ${packageName}`,
  );
}

export function assertInspectLoaded(pluginId: string, inspectPath: string | undefined) {
  assertProbe(inspectPath, "inspect JSON path is required");
  const inspect = readRequiredJson(inspectPath);
  const plugin = inspect.plugin as
    | { enabled?: boolean; id?: string; status?: string }
    | null
    | undefined;
  assertProbe(
    plugin?.id === pluginId,
    `expected inspected plugin id ${pluginId}, got ${plugin?.id}`,
  );
  assertProbe(plugin.enabled === true, `expected ${pluginId} inspect enabled=true`);
  assertProbe(
    plugin.status === "loaded",
    `expected ${pluginId} inspect status loaded, got ${plugin.status}`,
  );
}

function assertEnabled(pluginId: string, expected: boolean, env: ProbeEnv = process.env) {
  const cfg = config(env) as {
    plugins?: { entries?: Record<string, { enabled?: boolean }> };
  };
  const entry = cfg.plugins?.entries?.[pluginId];
  assertProbe(entry?.enabled === expected, `expected ${pluginId} enabled=${expected}`);
}

function installPath(pluginId: string, env: ProbeEnv = process.env) {
  const record = recordFor(pluginId, env);
  assertProbe(record?.installPath, `install path missing for ${pluginId}`);
  return String(record.installPath);
}

export function assertUninstalled(pluginId: string, env: ProbeEnv = process.env) {
  const cfg = requiredConfig(env) as {
    plugins?: {
      allow?: string[];
      deny?: string[];
      entries?: Record<string, unknown>;
      load?: { paths?: unknown[] };
    };
  };
  const record = recordFor(pluginId, env);
  assertProbe(!record, `install record still present for ${pluginId}`);
  assertProbe(
    !cfg.plugins?.entries?.[pluginId],
    `plugin config entry still present for ${pluginId}`,
  );
  assertProbe(
    !(cfg.plugins?.allow ?? []).includes(pluginId),
    `allowlist still contains ${pluginId}`,
  );
  assertProbe(!(cfg.plugins?.deny ?? []).includes(pluginId), `denylist still contains ${pluginId}`);
  const loadPaths = cfg.plugins?.load?.paths ?? [];
  assertProbe(
    !loadPaths.some((entry) => String(entry).includes(pluginId)),
    `load path still references ${pluginId}: ${loadPaths.join(", ")}`,
  );
}

export function parseDurationMs(value: string | undefined, fallback: string) {
  const text = (value || fallback).trim();
  if (text === "0") {
    return undefined;
  }
  const match = /^([0-9]+(?:\.[0-9]+)?)(ms|s|m|h)?$/u.exec(text);
  if (!match) {
    throw new Error(`unsupported duration value: ${text}`);
  }
  const amount = Number(match[1]);
  const unit = match[2] ?? "s";
  const multiplier = unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : 3_600_000;
  return Math.max(1, Math.ceil(amount * multiplier));
}

function createMatrixStateEnv(resourceDir: string): MatrixEnv {
  const home = fs.mkdtempSync(path.join(resourceDir, "home."));
  const stateDir = path.join(home, ".openclaw");
  const workspaceDir = path.join(home, "workspace");
  const configFile = path.join(stateDir, "openclaw.json");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    OPENCLAW_HOME: home,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configFile,
    OPENCLAW_TEST_WORKSPACE_DIR: workspaceDir,
    OPENCLAW_AUTH_PROFILE_SECRET_KEY: randomBytes(32).toString("hex"),
  };
}

function packageEntrypoint(prefix: string) {
  const packageRoot = path.join(prefix, "lib", "node_modules", "openclaw");
  for (const entry of ["dist/index.mjs", "dist/index.js"]) {
    const candidate = path.join(packageRoot, entry);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`OpenClaw package entrypoint not found under ${packageRoot}/dist/`);
}

async function runCommand(command: string, args: readonly string[], options: CommandOptions = {}) {
  const outputFd =
    options.outputFile === undefined ? undefined : fs.openSync(options.outputFile, "a");
  try {
    await new Promise<void>((resolve, reject) => {
      const spawnImpl = options.spawnImpl ?? spawn;
      const useProcessGroup = process.platform !== "win32";
      const child = spawnImpl(command, args, {
        cwd: process.cwd(),
        detached: useProcessGroup,
        env: options.env ?? process.env,
        stdio: outputFd === undefined ? "inherit" : (["ignore", outputFd, outputFd] as const),
      });
      let settled = false;
      let forceKillTimer: NodeJS.Timeout | undefined;
      let forceSettleTimer: NodeJS.Timeout | undefined;
      let timeoutTimer: NodeJS.Timeout | undefined;
      let timeoutError: Error | undefined;
      const clearTimers = () => {
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
        }
        if (forceKillTimer) {
          clearTimeout(forceKillTimer);
        }
        if (forceSettleTimer) {
          clearTimeout(forceSettleTimer);
        }
      };
      const signalChild = (signal: NodeJS.Signals) => {
        if (useProcessGroup && child.pid) {
          try {
            process.kill(-child.pid, signal);
            return;
          } catch {
            // The process group may already be gone; fall back to the direct child.
          }
        }
        if (!useProcessGroup && child.pid) {
          const runTaskkill = options.taskkillImpl ?? spawnSync;
          const taskkillPath = resolveWindowsTaskkillPath();
          const args = ["/PID", String(child.pid), "/T"];
          if (signal === "SIGKILL") {
            args.push("/F");
          }
          const result = runTaskkill(taskkillPath, args, { stdio: "ignore", windowsHide: true });
          if (!result.error && result.status === 0) {
            return;
          }
          if (signal !== "SIGKILL") {
            const forceResult = runTaskkill(taskkillPath, [...args, "/F"], {
              stdio: "ignore",
              windowsHide: true,
            });
            if (!forceResult.error && forceResult.status === 0) {
              return;
            }
          }
        }
        child.kill(signal);
      };
      const isProcessGroupRunning = () => {
        if (!useProcessGroup || !child.pid) {
          return false;
        }
        try {
          process.kill(-child.pid, 0);
          return true;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === "EPERM";
        }
      };
      const finish = (error?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimers();
        if (error) {
          reject(error);
          return;
        }
        resolve();
      };
      timeoutTimer =
        options.timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              timeoutError = new Error(
                `${command} ${args.join(" ")} timed out after ${options.timeoutMs}ms`,
              );
              signalChild("SIGTERM");
              forceKillTimer = setTimeout(() => {
                forceKillTimer = undefined;
                signalChild("SIGKILL");
                forceSettleTimer = setTimeout(
                  () => finish(timeoutError),
                  options.timeoutKillGraceMs ?? 2_000,
                );
                forceSettleTimer.unref();
              }, options.timeoutKillGraceMs ?? 2_000);
              forceKillTimer.unref();
            }, options.timeoutMs);
      timeoutTimer?.unref();
      child.once("error", (error) => {
        finish(error);
      });
      child.once("exit", (code, signal) => {
        if (settled) {
          return;
        }
        if (timeoutError) {
          if (isProcessGroupRunning()) {
            return;
          }
          finish(timeoutError);
          return;
        }
        if (code === 0 && !signal) {
          finish();
          return;
        }
        finish(new Error(`${command} ${args.join(" ")} failed with ${signal ?? `exit ${code}`}`));
      });
    });
  } catch (error) {
    if (options.outputFile && fs.existsSync(options.outputFile)) {
      const log = fs.readFileSync(options.outputFile, "utf8");
      if (log.trim()) {
        process.stderr.write(`--- ${options.outputFile} ---\n${log}`);
      }
    }
    throw error;
  } finally {
    if (outputFd !== undefined) {
      fs.closeSync(outputFd);
    }
  }
}

async function installOpenClawPackage(prefix: string, env: MatrixEnv) {
  const packageTgz = env.OPENCLAW_CURRENT_PACKAGE_TGZ;
  assertProbe(packageTgz, "OPENCLAW_CURRENT_PACKAGE_TGZ is required");
  const installLog = "/tmp/openclaw-plugin-lifecycle-install.log";
  process.stdout.write("Installing mounted OpenClaw package...\n");
  await runCommand(
    "npm",
    ["install", "-g", "--prefix", prefix, packageTgz, "--no-fund", "--no-audit"],
    {
      env,
      outputFile: installLog,
      timeoutMs: parseDurationMs(env.OPENCLAW_E2E_NPM_INSTALL_TIMEOUT, "600s"),
    },
  );
}

async function packFixturePlugin(
  packDir: string,
  outputTgz: string,
  pluginId: string,
  version: string,
  method: string,
  name: string,
) {
  const packageDir = path.join(packDir, "package");
  fs.mkdirSync(packageDir, { recursive: true });
  await runCommand("node", [
    "scripts/e2e/lib/fixture.mjs",
    "plugin",
    packageDir,
    pluginId,
    version,
    method,
    name,
  ]);
  await runCommand("tar", ["-czf", outputTgz, "-C", packDir, "package"]);
}

async function startNpmFixtureRegistry(
  registryRoot: string,
  packages: readonly [packageName: string, version: string, tarball: string][],
  env: MatrixEnv,
): Promise<RegistryServer> {
  const serverLog = path.join(registryRoot, "npm-registry.log");
  const serverPortFile = path.join(registryRoot, "npm-registry-port");
  const logFd = fs.openSync(serverLog, "a");
  const child = spawn(
    "node",
    [
      "scripts/e2e/lib/plugins/npm-registry-server.mjs",
      serverPortFile,
      ...packages.flatMap(([packageName, version, tarball]) => [packageName, version, tarball]),
    ],
    {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", logFd, logFd],
    },
  );
  fs.closeSync(logFd);

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (fs.existsSync(serverPortFile) && fs.statSync(serverPortFile).size > 0) {
      const port = fs.readFileSync(serverPortFile, "utf8").trim();
      return {
        env: {
          ...env,
          NPM_CONFIG_REGISTRY: `http://127.0.0.1:${port}`,
        },
        stop() {
          child.kill();
        },
      };
    }
    if (child.exitCode !== null) {
      const log = fs.existsSync(serverLog) ? fs.readFileSync(serverLog, "utf8") : "";
      throw new Error(`npm fixture registry exited early${log ? `\n${log}` : ""}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill();
  const log = fs.existsSync(serverLog) ? fs.readFileSync(serverLog, "utf8") : "";
  throw new Error(`timed out waiting for npm fixture registry${log ? `\n${log}` : ""}`);
}

async function runMeasured(
  summaryTsv: string,
  phase: string,
  command: string,
  args: readonly string[],
  env: MatrixEnv,
) {
  process.stdout.write(`Running plugin lifecycle phase: ${phase}\n`);
  await runCommand(
    "node",
    [
      "scripts/e2e/lib/plugin-lifecycle-matrix/measure.mjs",
      summaryTsv,
      phase,
      "--",
      command,
      ...args,
    ],
    { env },
  );
}

async function runPluginLifecycleMatrix() {
  const pluginId = "lifecycle-claw";
  const packageName = "@openclaw/lifecycle-claw";
  const resourceDir = tempDirs.make("openclaw-plugin-lifecycle-matrix-");
  const npmPrefix = "/tmp/npm-prefix";
  const env = createMatrixStateEnv(resourceDir);
  const tarballV1 = path.join(resourceDir, "lifecycle-claw-1.0.0.tgz");
  const tarballV2 = path.join(resourceDir, "lifecycle-claw-2.0.0.tgz");
  const inspectV1 = path.join(resourceDir, "plugin-lifecycle-inspect-v1.json");
  const summaryTsv = path.join(resourceDir, "resource-summary.tsv");
  let registry: RegistryServer | undefined;

  fs.writeFileSync(
    summaryTsv,
    "phase\tmax_rss_kb\tcpu_seconds\twall_ms\tcpu_core_ratio\tsignal\n",
    "utf8",
  );
  fs.rmSync(npmPrefix, { recursive: true, force: true });

  try {
    await installOpenClawPackage(npmPrefix, env);
    const entry = packageEntrypoint(npmPrefix);
    const matrixEnv: MatrixEnv = {
      ...env,
      PATH: `${path.join(npmPrefix, "bin")}:${env.PATH ?? ""}`,
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_loglevel: "error",
    };
    const packRoot = fs.mkdtempSync(path.join(resourceDir, "pack."));
    const registryRoot = fs.mkdtempSync(path.join(resourceDir, "registry."));
    await packFixturePlugin(
      path.join(packRoot, "v1"),
      tarballV1,
      pluginId,
      "1.0.0",
      "lifecycle.v1",
      "Lifecycle Claw",
    );
    await packFixturePlugin(
      path.join(packRoot, "v2"),
      tarballV2,
      pluginId,
      "2.0.0",
      "lifecycle.v2",
      "Lifecycle Claw",
    );
    registry = await startNpmFixtureRegistry(
      registryRoot,
      [
        [packageName, "1.0.0", tarballV1],
        [packageName, "2.0.0", tarballV2],
      ],
      matrixEnv,
    );
    const runEnv = registry.env as MatrixEnv;

    await runMeasured(
      summaryTsv,
      "install-v1",
      "node",
      [entry, "plugins", "install", `npm:${packageName}@1.0.0`, "--force"],
      runEnv,
    );
    assertVersion(pluginId, "1.0.0", runEnv);
    assertNpmProjectRoot(pluginId, packageName, runEnv);

    await runMeasured(
      summaryTsv,
      "inspect-v1",
      "bash",
      [
        "-c",
        'node "$1" plugins inspect "$2" --runtime --json >"$3"',
        "bash",
        entry,
        pluginId,
        inspectV1,
      ],
      runEnv,
    );
    assertInspectLoaded(pluginId, inspectV1);

    await runMeasured(
      summaryTsv,
      "disable",
      "node",
      [entry, "plugins", "disable", pluginId],
      runEnv,
    );
    assertEnabled(pluginId, false, runEnv);

    await runMeasured(summaryTsv, "enable", "node", [entry, "plugins", "enable", pluginId], runEnv);
    assertEnabled(pluginId, true, runEnv);

    await runMeasured(
      summaryTsv,
      "upgrade-v2",
      "node",
      [entry, "plugins", "update", `${packageName}@2.0.0`],
      runEnv,
    );
    assertVersion(pluginId, "2.0.0", runEnv);
    assertNpmProjectRoot(pluginId, packageName, runEnv);

    await runMeasured(
      summaryTsv,
      "downgrade-v1",
      "node",
      [entry, "plugins", "update", `${packageName}@1.0.0`],
      runEnv,
    );
    assertVersion(pluginId, "1.0.0", runEnv);
    assertNpmProjectRoot(pluginId, packageName, runEnv);

    const installedPath = installPath(pluginId, runEnv);
    fs.rmSync(installedPath, { recursive: true, force: true });
    assertProbe(
      !fs.existsSync(installedPath),
      `failed to remove plugin code before missing-code uninstall: ${installedPath}`,
    );

    await runMeasured(
      summaryTsv,
      "missing-code-uninstall",
      "node",
      [entry, "plugins", "uninstall", pluginId, "--force"],
      runEnv,
    );
    assertUninstalled(pluginId, runEnv);

    process.stdout.write(
      `Plugin lifecycle resource summary:\n${fs.readFileSync(summaryTsv, "utf8")}`,
    );
    process.stdout.write("Plugin lifecycle matrix passed.\n");
  } finally {
    registry?.stop();
  }
}

export const testing = { runCommand };

const isLifecycleMatrixCli = process.argv[2] === "--lifecycle-matrix";

if (isLifecycleMatrixCli) {
  void (async () => {
    try {
      await runPluginLifecycleMatrix();
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    } finally {
      tempDirs.cleanup();
    }
  })();
}

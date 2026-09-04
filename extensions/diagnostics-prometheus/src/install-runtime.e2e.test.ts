// Proves the external Prometheus plugin's managed install and trusted runtime boundary.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import {
  resolvePreferredOpenClawTmpDir,
  tempWorkspace,
  type TempWorkspace,
} from "openclaw/plugin-sdk/temp-path";
import { stopChildProcess } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const packageName = "@openclaw/diagnostics-prometheus";
const pluginId = "diagnostics-prometheus";
const repoRoot = path.resolve(import.meta.dirname, "../../..");
const pluginRoot = path.resolve(import.meta.dirname, "..");
const tempWorkspaces: TempWorkspace[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  const stopped = await Promise.allSettled(
    children.splice(0).map((child) => stopChildProcess(child, 5_000)),
  );
  const errors = stopped.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length > 0) {
    throw new AggregateError(errors, "failed to stop Prometheus E2E children");
  }
  await Promise.all(tempWorkspaces.splice(0).map((workspace) => workspace.cleanup()));
});

async function reservePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("failed to reserve a loopback port");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

function isolatedEnv(params: {
  configPath: string;
  home: string;
  registry?: string;
  stateDir: string;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: params.home,
    USERPROFILE: params.home,
    OPENCLAW_HOME: params.home,
    OPENCLAW_STATE_DIR: params.stateDir,
    OPENCLAW_CONFIG_PATH: params.configPath,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    NODE_ENV: "production",
    NO_COLOR: "1",
  };
  for (const key of [
    "OPENCLAW_BUNDLED_PLUGINS_DIR",
    "OPENCLAW_PLUGIN_CATALOG_PATHS",
    "OPENCLAW_PLUGINS_PATHS",
    "OPENCLAW_TEST_FAST",
    "OPENCLAW_TEST_HOME",
    "OPENCLAW_TEST_MINIMAL_GATEWAY",
    "OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR",
    "VITEST",
    "VITEST_POOL_ID",
    "VITEST_WORKER_ID",
  ]) {
    delete env[key];
  }
  if (params.registry) {
    env.NPM_CONFIG_REGISTRY = params.registry;
    env.npm_config_registry = params.registry;
  }
  return env;
}

async function runCli(args: string[], env: NodeJS.ProcessEnv, build = false): Promise<string> {
  const entry = build ? "scripts/run-node.mjs" : "openclaw.mjs";
  const result = await execFileAsync(process.execPath, [entry, ...args], {
    cwd: repoRoot,
    env,
    maxBuffer: 4 * 1024 * 1024,
    timeout: 180_000,
  });
  return result.stdout;
}

async function packPlugin(
  outputDir: string,
  version: string,
): Promise<{
  files: string[];
  tarballPath: string;
}> {
  const stagingDir = path.join(outputDir, "package-source");
  await fs.cp(pluginRoot, stagingDir, {
    recursive: true,
    filter: (source) => {
      const relative = path.relative(pluginRoot, source);
      const topLevel = relative.split(path.sep)[0];
      return topLevel !== "dist" && topLevel !== "node_modules";
    },
  });
  await execFileAsync(process.execPath, ["scripts/lib/plugin-npm-runtime-build.mjs", stagingDir], {
    cwd: repoRoot,
    maxBuffer: 2 * 1024 * 1024,
    timeout: 60_000,
  });
  await execFileAsync(
    process.execPath,
    [
      "scripts/lib/plugin-npm-package-manifest.mjs",
      "--run",
      stagingDir,
      "--",
      "npm",
      "pack",
      "--ignore-scripts",
      "--pack-destination",
      outputDir,
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        OPENCLAW_PLUGIN_NPM_BUNDLE_DEPENDENCIES: "1",
      },
      maxBuffer: 2 * 1024 * 1024,
      timeout: 60_000,
    },
  );
  const tarballPath = path.join(
    outputDir,
    `${packageName.replace(/^@/, "").replace("/", "-")}-${version}.tgz`,
  );
  expect((await fs.stat(tarballPath)).isFile()).toBe(true);
  const entries = await execFileAsync("tar", ["-tzf", tarballPath], {
    maxBuffer: 2 * 1024 * 1024,
    timeout: 60_000,
  });
  return {
    files: entries.stdout
      .trim()
      .split(/\r?\n/u)
      .map((file) => file.replace(/^package\//u, "")),
    tarballPath,
  };
}

async function readPluginVersion(): Promise<string> {
  const manifest = JSON.parse(await fs.readFile(path.join(pluginRoot, "package.json"), "utf8")) as {
    version?: unknown;
  };
  if (typeof manifest.version !== "string" || !manifest.version.trim()) {
    throw new Error("diagnostics-prometheus package version is missing");
  }
  return manifest.version.trim();
}

async function waitForFile(
  filePath: string,
  child: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("local npm registry exited before publishing its port");
    }
    try {
      if ((await fs.stat(filePath)).size > 0) {
        return;
      }
    } catch {
      // The registry writes the port file only after the listener is ready.
    }
    await delay(50);
  }
  throw new Error("timed out waiting for local npm registry");
}

async function startRegistry(params: {
  root: string;
  tarballPath: string;
  version: string;
}): Promise<string> {
  const portFile = path.join(params.root, "registry-port");
  const logPath = path.join(params.root, "registry.log");
  const logHandle = await fs.open(logPath, "a");
  const child = spawn(
    process.execPath,
    [
      "scripts/e2e/lib/plugins/npm-registry-server.mjs",
      portFile,
      packageName,
      params.version,
      params.tarballPath,
    ],
    {
      cwd: repoRoot,
      env: isolatedEnv({
        configPath: path.join(params.root, "unused.json"),
        home: params.root,
        stateDir: path.join(params.root, "unused-state"),
      }),
      stdio: ["ignore", logHandle.fd, logHandle.fd],
    },
  );
  children.push(child);
  await logHandle.close();
  await waitForFile(portFile, child, 10_000);
  const port = (await fs.readFile(portFile, "utf8")).trim();
  return `http://127.0.0.1:${port}`;
}

async function waitForGateway(params: {
  child: ChildProcess;
  logPath: string;
  port: number;
}): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (params.child.exitCode !== null || params.child.signalCode !== null) {
      const logs = await fs.readFile(params.logPath, "utf8").catch(() => "");
      throw new Error(`Gateway exited before readiness:\n${logs.slice(-8_000)}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${params.port}/readyz`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        return;
      }
    } catch {
      // Readiness is authoritative only after the HTTP endpoint responds.
    }
    await delay(200);
  }
  const logs = await fs.readFile(params.logPath, "utf8").catch(() => "");
  throw new Error(`Gateway did not become ready:\n${logs.slice(-8_000)}`);
}

describe("diagnostics-prometheus managed install runtime", () => {
  it("installs the exact official package and exports metrics at Gateway startup", async () => {
    const workspace = await tempWorkspace({
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: "openclaw-prometheus-install-",
    });
    tempWorkspaces.push(workspace);
    const root = workspace.dir;
    const home = path.join(root, "home");
    const stateDir = path.join(root, "state");
    const configPath = path.join(stateDir, "openclaw.json");
    const gatewayLog = path.join(root, "gateway.log");
    const gatewayToken = "prometheus-managed-install-test-token";
    const gatewayPort = await reservePort();
    await fs.mkdir(home, { recursive: true });
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          diagnostics: { enabled: true },
          gateway: {
            mode: "local",
            bind: "loopback",
            port: gatewayPort,
            auth: { mode: "token", token: gatewayToken },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const pluginVersion = await readPluginVersion();
    const packedPlugin = await packPlugin(root, pluginVersion);
    expect(packedPlugin.files.some((file) => /^dist\/index\.(?:js|mjs|cjs)$/u.test(file))).toBe(
      true,
    );
    const registry = await startRegistry({
      root,
      tarballPath: packedPlugin.tarballPath,
      version: pluginVersion,
    });
    const env = isolatedEnv({
      configPath,
      home,
      registry,
      stateDir,
    });

    await runCli(
      ["plugins", "install", `npm:${packageName}@${pluginVersion}`, "--accept-capabilities"],
      env,
      true,
    );
    const inspect = JSON.parse(
      await runCli(["plugins", "inspect", pluginId, "--runtime", "--json"], env),
    ) as {
      install?: {
        artifactKind?: unknown;
        installPath?: unknown;
        resolvedName?: unknown;
        resolvedVersion?: unknown;
        source?: unknown;
        sourcePath?: unknown;
      };
      plugin?: {
        enabled?: unknown;
        id?: unknown;
        origin?: unknown;
        status?: unknown;
        trustedOfficialInstall?: unknown;
      };
    };
    expect(inspect.install).toMatchObject({
      source: "npm",
      resolvedName: packageName,
      resolvedVersion: pluginVersion,
    });
    expect(typeof inspect.install?.installPath).toBe("string");
    expect(inspect.install?.artifactKind).toBeUndefined();
    expect(inspect.install?.sourcePath).toBeUndefined();
    expect(inspect.plugin).toMatchObject({
      id: pluginId,
      enabled: true,
      status: "loaded",
      trustedOfficialInstall: true,
    });
    expect(["config", "global"]).toContain(inspect.plugin?.origin);

    const gatewayLogHandle = await fs.open(gatewayLog, "a");
    const gateway = spawn(
      process.execPath,
      ["openclaw.mjs", "gateway", "run", "--bind", "loopback", "--port", String(gatewayPort)],
      {
        cwd: repoRoot,
        env,
        stdio: ["ignore", gatewayLogHandle.fd, gatewayLogHandle.fd],
      },
    );
    children.push(gateway);
    await gatewayLogHandle.close();
    await waitForGateway({ child: gateway, logPath: gatewayLog, port: gatewayPort });

    const url = `http://127.0.0.1:${gatewayPort}/api/diagnostics/prometheus`;
    const unauthenticated = await fetch(url);
    expect([401, 403]).toContain(unauthenticated.status);
    const authenticated = await fetch(url, {
      headers: { authorization: `Bearer ${gatewayToken}` },
    });
    const body = await authenticated.text();
    expect(authenticated.status).toBe(200);
    expect(authenticated.headers.get("content-type")).toContain("text/plain");
    expect(body).toContain(
      'openclaw_telemetry_exporter_total{exporter="diagnostics-prometheus",reason="configured",signal="metrics",status="started"} 1',
    );
    const scrapeEventLoopMetrics = async () => {
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${gatewayToken}` },
      });
      expect(response.status).toBe(200);
      const lines = (await response.text())
        .split("\n")
        .filter((line) => line.startsWith("openclaw_gateway_event_loop_"));
      const value = (name: string) =>
        Number(
          lines
            .find((line) => line.startsWith(`${name} `))
            ?.split(" ")
            .at(-1),
        );
      return {
        lines,
        count: value("openclaw_gateway_event_loop_delay_max_seconds_count"),
        sum: value("openclaw_gateway_event_loop_delay_max_seconds_sum"),
        observed: value("openclaw_gateway_event_loop_observed_seconds_total"),
      };
    };
    const readCompletedWindow = async () => {
      // Healthy monitor windows complete after one second; readiness owns this read.
      await delay(1_100);
      const response = await fetch(`http://127.0.0.1:${gatewayPort}/readyz`, {
        headers: { authorization: `Bearer ${gatewayToken}` },
      });
      expect(response.status).toBe(200);
      const readiness = (await response.json()) as {
        ready: boolean;
        eventLoop?: { intervalMs: number; delayMaxMs: number };
      };
      expect(readiness.ready).toBe(true);
      expect(readiness.eventLoop?.intervalMs).toBeGreaterThanOrEqual(1_000);
      expect(readiness.eventLoop?.delayMaxMs).toBeGreaterThanOrEqual(0);
      return readiness.eventLoop!;
    };

    await readCompletedWindow();
    await expect.poll(async () => (await scrapeEventLoopMetrics()).count).toBeGreaterThan(0);
    const firstWindow = await scrapeEventLoopMetrics();
    expect(firstWindow.observed).toBeGreaterThan(0);
    const nextWindow = await readCompletedWindow();
    await expect
      .poll(async () => (await scrapeEventLoopMetrics()).count)
      .toBeGreaterThan(firstWindow.count);
    const retainedWindows = await scrapeEventLoopMetrics();
    // Prometheus renders 12 significant digits; tolerate only serialization rounding.
    expect(retainedWindows.observed).toBeGreaterThanOrEqual(
      firstWindow.observed + nextWindow.intervalMs / 1_000 - 1e-9,
    );
    expect(retainedWindows.sum).toBeGreaterThanOrEqual(
      firstWindow.sum + nextWindow.delayMaxMs / 1_000 - 1e-9,
    );
    expect(retainedWindows.lines.join("\n")).not.toMatch(/\{(?!le=)/u);
    // Background health readers may complete windows between full-Gateway scrapes.
    let previous = retainedWindows;
    for (let scrape = 0; scrape < 2; scrape++) {
      const current = await scrapeEventLoopMetrics();
      expect(current.count).toBeGreaterThanOrEqual(previous.count);
      expect(current.sum).toBeGreaterThanOrEqual(previous.sum);
      expect(current.observed).toBeGreaterThanOrEqual(previous.observed);
      previous = current;
    }
    const gatewayLogs = await fs.readFile(gatewayLog, "utf8");
    expect(gatewayLogs).not.toContain(
      "diagnostics-prometheus: internal diagnostics capability unavailable",
    );
    await stopChildProcess(gateway, 5_000);
    expect(gateway.exitCode).toBe(0);
    expect(gateway.signalCode).toBeNull();
  }, 300_000);
});

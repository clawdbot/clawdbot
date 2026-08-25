// Verifies installed packages can bootstrap the default OpenClaw workspace files.
import { execFileSync, spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { TSDOWN_PACKAGE_OUTPUT_ROOTS } from "./tsdown-output-roots.mts";

/**
 * Template pack files that must be present in installed packages.
 */
export const WORKSPACE_TEMPLATE_PACK_PATHS: readonly string[] = [
  "docs/reference/templates/AGENTS.md",
  "docs/reference/templates/SOUL.md",
  "docs/reference/templates/IDENTITY.md",
  "docs/reference/templates/USER.md",
  "src/agents/templates/HEARTBEAT.md",
  "docs/reference/templates/BOOTSTRAP.md",
];

const DIST_RUNTIME_ARTIFACT_BASE_PATHS = [
  "openclaw.mjs",
  "node-version.mjs",
  "package.json",
  "docs/reference/templates",
  "src/agents/templates",
  "dist",
  "dist-runtime",
  "node_modules",
];

const DIST_RUNTIME_ARTIFACT_PACKAGE_DIST_PATHS = [...TSDOWN_PACKAGE_OUTPUT_ROOTS].toSorted(
  (left, right) => left.localeCompare(right),
);

const DIST_RUNTIME_ARTIFACT_PACKAGE_SOURCE_PATHS = DIST_RUNTIME_ARTIFACT_PACKAGE_DIST_PATHS.flatMap(
  (distPath) => {
    const packageRoot = dirname(distPath);
    return [`${packageRoot}/package.json`, distPath];
  },
);

function packageArtifactPath(sourcePath: string): string {
  return sourcePath.replace(/^packages\//u, "node_modules/@openclaw/");
}

const DIST_RUNTIME_ARTIFACT_PACKAGE_ARTIFACT_PATHS =
  DIST_RUNTIME_ARTIFACT_PACKAGE_SOURCE_PATHS.map(packageArtifactPath);

function copyDistRuntimeArtifactPath(
  rootDir: string,
  artifactRoot: string,
  sourcePath: string,
  destinationPath = sourcePath,
  skipNodeBin = false,
): void {
  const sourceNodeBin = join(rootDir, sourcePath, ".bin");
  function copy(source: string, destination: string): void {
    if (skipNodeBin && source === sourceNodeBin) {
      return;
    }
    if (
      existsSync(destination) &&
      statSync(source).isDirectory() &&
      statSync(destination).isDirectory()
    ) {
      for (const entry of readdirSync(source)) {
        copy(join(source, entry), join(destination, entry));
      }
      return;
    }
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, { dereference: true, force: true, recursive: true });
  }

  const destination = join(artifactRoot, destinationPath);
  copy(join(rootDir, sourcePath), destination);
}

function stageDistRuntimeArtifact(rootDir: string, artifactRoot: string): void {
  const deploymentRoot = join(artifactRoot, "deployment");
  execFileSync(
    "pnpm",
    [
      "--frozen-lockfile",
      "--config.inject-workspace-packages=true",
      "--ignore-scripts",
      "--filter",
      "openclaw",
      "deploy",
      "--prod",
      deploymentRoot,
    ],
    { cwd: rootDir, stdio: "inherit" },
  );
  copyDistRuntimeArtifactPath(deploymentRoot, artifactRoot, "node_modules");
  rmSync(deploymentRoot, { force: true, recursive: true });

  const pluginDeploymentRoot = join(artifactRoot, "acpx-deployment");
  execFileSync(
    "pnpm",
    [
      "--frozen-lockfile",
      "--config.inject-workspace-packages=true",
      "--ignore-scripts",
      "--filter",
      BUNDLED_PLUGIN_SMOKE_PACKAGE,
      "deploy",
      "--prod",
      pluginDeploymentRoot,
    ],
    { cwd: rootDir, stdio: "inherit" },
  );
  // ACPX is bundled, but its adapters are plugin-owned and load on the first ACP session.
  copyDistRuntimeArtifactPath(
    pluginDeploymentRoot,
    artifactRoot,
    "node_modules",
    "node_modules",
    true,
  );
  rmSync(pluginDeploymentRoot, { force: true, recursive: true });

  for (const sourcePath of DIST_RUNTIME_ARTIFACT_BASE_PATHS) {
    if (sourcePath !== "node_modules") {
      copyDistRuntimeArtifactPath(rootDir, artifactRoot, sourcePath);
    }
  }
  for (const sourcePath of DIST_RUNTIME_ARTIFACT_PACKAGE_SOURCE_PATHS) {
    copyDistRuntimeArtifactPath(rootDir, artifactRoot, sourcePath, packageArtifactPath(sourcePath));
  }
}

function assertExtractedPluginRuntimeDependencies(packageRoot: string): void {
  const pluginEntry = join(
    packageRoot,
    "dist-runtime",
    "extensions",
    BUNDLED_PLUGIN_SMOKE_ID,
    "index.js",
  );
  const requireFromPlugin = createRequire(pluginEntry);
  for (const dependency of BUNDLED_PLUGIN_SMOKE_RUNTIME_DEPENDENCIES) {
    const manifestPath = requireFromPlugin.resolve(`${dependency}/package.json`);
    if (!manifestPath.startsWith(join(packageRoot, "node_modules"))) {
      throw new Error(`extracted ACPX runtime resolved ${dependency} outside its artifact`);
    }
  }
}

function probeExtractedAcpxRuntime(params: {
  packageRoot: string;
  cwd: string;
  stateDir: string;
  env: NodeJS.ProcessEnv;
}): void {
  const requireFromArtifact = createRequire(join(params.packageRoot, "package.json"));
  const codexLauncher = requireFromArtifact.resolve("@openai/codex/bin/codex.js");
  if (!codexLauncher.startsWith(join(params.packageRoot, "node_modules"))) {
    throw new Error("extracted ACPX runtime resolved Codex outside its artifact");
  }
  // The upstream launcher selects the native Codex binary for this consumer target.
  // Run it from the extracted package before ACPX starts its app-server connection.
  const codexVersion = execFileSync(process.execPath, [codexLauncher, "--version"], {
    cwd: params.packageRoot,
    encoding: "utf8",
    env: params.env,
    maxBuffer: DIST_RUNTIME_ARTIFACT_MAX_OUTPUT_BYTES,
    timeout: DIST_RUNTIME_ARTIFACT_SMOKE_TIMEOUT_MS,
  });
  if (!codexVersion.trim()) {
    throw new Error("extracted Codex launcher did not report a version");
  }

  const probe = `
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createAcpRuntime, createAgentRegistry, createFileSessionStore } from "acpx/runtime";

const require = createRequire(new URL("./package.json", import.meta.url));
const adapterEntry = join(
  dirname(require.resolve("@agentclientprotocol/codex-acp/package.json")),
  "dist",
  "index.js",
);
const runtime = createAcpRuntime({
  cwd: process.env.OPENCLAW_ACPX_SMOKE_CWD,
  sessionStore: createFileSessionStore({ stateDir: process.env.OPENCLAW_ACPX_SMOKE_STATE_DIR }),
  agentRegistry: createAgentRegistry({ overrides: { codex: [process.execPath, adapterEntry] } }),
  permissionMode: "approve-reads",
  nonInteractivePermissions: "fail",
  probeAgent: "codex",
});
await runtime.probeAvailability();
if (!runtime.isHealthy()) {
  throw new Error("extracted ACPX runtime probe did not report healthy");
}
console.log("extracted ACPX runtime probe passed");
`;
  const output = execFileSync(process.execPath, ["--input-type=module", "--eval", probe], {
    cwd: params.packageRoot,
    encoding: "utf8",
    env: {
      ...params.env,
      OPENCLAW_ACPX_SMOKE_CWD: params.cwd,
      OPENCLAW_ACPX_SMOKE_STATE_DIR: params.stateDir,
    },
    maxBuffer: DIST_RUNTIME_ARTIFACT_MAX_OUTPUT_BYTES,
    timeout: DIST_RUNTIME_ARTIFACT_SMOKE_TIMEOUT_MS,
  });
  if (!output.includes("extracted ACPX runtime probe passed")) {
    throw new Error("extracted ACPX runtime probe did not complete");
  }
}

// HEARTBEAT.md ships in the template pack for docs/doctor context but is no
// longer seeded into new workspaces; heartbeat context lives in cron scratch.
const REQUIRED_BOOTSTRAP_WORKSPACE_FILES = [
  "AGENTS.md",
  "SOUL.md",
  "IDENTITY.md",
  "USER.md",
  "BOOTSTRAP.md",
];

const WORKSPACE_BOOTSTRAP_SMOKE_TIMEOUT_MS = 15_000;
const DIST_RUNTIME_ARTIFACT_SMOKE_TIMEOUT_MS = 20_000;
const DIST_RUNTIME_ARTIFACT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const SAFE_UNIX_SMOKE_PATH = "/usr/bin:/bin";
const BUNDLED_PLUGIN_SMOKE_ID = "acpx";
const BUNDLED_PLUGIN_SMOKE_PACKAGE = "@openclaw/acpx";
const BUNDLED_PLUGIN_SMOKE_RUNTIME_DEPENDENCIES = [
  "@agentclientprotocol/codex-acp",
  "@agentclientprotocol/claude-agent-acp",
];

type GatewayProcess = ReturnType<typeof spawn>;
type GatewaySmokeParams = { child: GatewayProcess; port: number; readOutput: () => string };
type GatewayPluginSmokeParams = { child: GatewayProcess; readOutput: () => string };

/**
 * Creates a minimal isolated environment for workspace bootstrap smoke runs.
 */
export function createWorkspaceBootstrapSmokeEnv(
  env: NodeJS.ProcessEnv,
  homeDir: string,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const allowlistedEnvEntries = [
    "TMPDIR",
    "TMP",
    "TEMP",
    "SystemRoot",
    "ComSpec",
    "PATHEXT",
    "WINDIR",
  ];
  const windowsRoot = env.SystemRoot ?? env.WINDIR ?? "C:\\Windows";
  const nodeBinDir = dirname(process.execPath);
  const safePath =
    process.platform === "win32"
      ? `${nodeBinDir};${windowsRoot}\\System32;${windowsRoot}`
      : `${nodeBinDir}:${SAFE_UNIX_SMOKE_PATH}`;

  return {
    ...Object.fromEntries(
      allowlistedEnvEntries.flatMap((key) => {
        const value = env[key];
        return typeof value === "string" && value.length > 0 ? [[key, value]] : [];
      }),
    ),
    PATH: safePath,
    HOME: homeDir,
    USERPROFILE: homeDir,
    OPENCLAW_HOME: homeDir,
    OPENCLAW_NO_ONBOARD: "1",
    OPENCLAW_SUPPRESS_NOTES: "1",
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_DISABLE_BUNDLED_ENTRY_SOURCE_FALLBACK: "1",
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_SHARED_CREDENTIALS_FILE: join(homeDir, ".aws", "credentials"),
    AWS_CONFIG_FILE: join(homeDir, ".aws", "config"),
    ...overrides,
  };
}

function collectMissingBootstrapWorkspaceFiles(workspaceDir: string): string[] {
  return REQUIRED_BOOTSTRAP_WORKSPACE_FILES.filter(
    (filename) => !existsSync(join(workspaceDir, filename)),
  );
}

function describeExecFailure(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const execStdout = "stdout" in error ? error.stdout : undefined;
  const execStderr = "stderr" in error ? error.stderr : undefined;
  const stdout =
    typeof execStdout === "string"
      ? execStdout.trim()
      : execStdout instanceof Uint8Array
        ? Buffer.from(execStdout).toString("utf8").trim()
        : "";
  const stderr =
    typeof execStderr === "string"
      ? execStderr.trim()
      : execStderr instanceof Uint8Array
        ? Buffer.from(execStderr).toString("utf8").trim()
        : "";
  return [error.message, stdout, stderr].filter(Boolean).join(" | ");
}

/**
 * Runs the installed CLI workspace bootstrap smoke and validates created files.
 */
export function runInstalledWorkspaceBootstrapSmoke(params: {
  packageRoot: string;
  nodeArgs?: string[];
  envOverrides?: NodeJS.ProcessEnv;
}): void {
  const tempRoot = mkdtempSync(join(tmpdir(), "openclaw-workspace-bootstrap-smoke-"));
  const homeDir = join(tempRoot, "home");
  const cwd = join(tempRoot, "cwd");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });

  let combinedOutput = "";
  try {
    try {
      execFileSync(
        process.execPath,
        [
          ...(params.nodeArgs ?? []),
          join(params.packageRoot, "openclaw.mjs"),
          "agents",
          "add",
          "workspace-bootstrap-smoke",
          "--workspace",
          join(homeDir, "workspace"),
          "--non-interactive",
          "--json",
        ],
        {
          cwd,
          encoding: "utf8",
          maxBuffer: 1024 * 1024 * 16,
          stdio: ["ignore", "pipe", "pipe"],
          timeout: WORKSPACE_BOOTSTRAP_SMOKE_TIMEOUT_MS,
          env: createWorkspaceBootstrapSmokeEnv(process.env, homeDir, params.envOverrides),
        },
      );
    } catch (error) {
      combinedOutput = describeExecFailure(error);
    }

    if (combinedOutput.includes("Missing workspace template:")) {
      throw new Error(
        `installed workspace bootstrap failed before agent execution: ${combinedOutput}`,
      );
    }

    const workspaceDir = join(homeDir, "workspace");
    const missingFiles = collectMissingBootstrapWorkspaceFiles(workspaceDir);
    if (missingFiles.length > 0) {
      const outputDetails = combinedOutput.length > 0 ? `\nCommand output:\n${combinedOutput}` : "";
      throw new Error(
        `installed workspace bootstrap did not create required files in ${workspaceDir}: ${missingFiles.join(", ")}${outputDetails}`,
      );
    }
  } finally {
    try {
      rmSync(tempRoot, { force: true, recursive: true });
    } catch {
      // best effort cleanup only
    }
  }
}

function collectDistRuntimeArtifactPaths(rootDir: string): string[] {
  const missingPaths = DIST_RUNTIME_ARTIFACT_PACKAGE_SOURCE_PATHS.filter(
    (artifactPath) => !existsSync(join(rootDir, artifactPath)),
  );
  if (missingPaths.length > 0) {
    throw new Error(
      `dist runtime artifact inputs are missing required workspace package paths: ${missingPaths.join(", ")}`,
    );
  }
  return [
    ...DIST_RUNTIME_ARTIFACT_BASE_PATHS,
    ...DIST_RUNTIME_ARTIFACT_PACKAGE_ARTIFACT_PATHS,
  ].toSorted((left, right) => left.localeCompare(right));
}

function listDistRuntimeArtifactEntries(archivePath: string, compressor: string): string[] {
  return execFileSync("tar", ["--use-compress-program", compressor, "-tf", archivePath], {
    encoding: "utf8",
    maxBuffer: DIST_RUNTIME_ARTIFACT_MAX_OUTPUT_BYTES,
  })
    .split(/\r?\n/u)
    .map((entry) => entry.replace(/^\.\//u, "").replace(/\/$/u, ""))
    .filter(Boolean);
}

function validateDistRuntimeArtifactEntries(entries: string[], expectedPaths: string[]): void {
  const entrySet = new Set(entries);
  const missingPaths = expectedPaths.filter(
    (expectedPath) =>
      !entrySet.has(expectedPath) && !entries.some((entry) => entry.startsWith(`${expectedPath}/`)),
  );
  if (missingPaths.length > 0) {
    throw new Error(`dist runtime artifact is missing required paths: ${missingPaths.join(", ")}`);
  }

  const hasPluginRuntime = entries.some(
    (entry) =>
      entry.startsWith("dist-runtime/extensions/") && entry.endsWith("/openclaw.plugin.json"),
  );
  if (!hasPluginRuntime) {
    throw new Error("dist runtime artifact is missing the built plugin runtime layout");
  }

  const unexpectedEntries = entries.filter((entry) => {
    if (
      DIST_RUNTIME_ARTIFACT_PACKAGE_ARTIFACT_PATHS.some(
        (artifactPath) => entry === artifactPath || entry.startsWith(`${artifactPath}/`),
      )
    ) {
      return false;
    }
    if (entry === "openclaw.mjs" || entry === "node-version.mjs" || entry === "package.json") {
      return false;
    }
    if (
      entry === "node_modules" ||
      entry.startsWith("node_modules/") ||
      entry === "dist" ||
      entry.startsWith("dist/") ||
      entry === "dist-runtime" ||
      entry.startsWith("dist-runtime/") ||
      entry === "src" ||
      entry === "src/agents" ||
      entry === "src/agents/templates" ||
      entry.startsWith("src/agents/templates/") ||
      entry === "docs" ||
      entry === "docs/reference" ||
      entry === "docs/reference/templates" ||
      entry.startsWith("docs/reference/templates/")
    ) {
      return false;
    }
    return true;
  });
  if (unexpectedEntries.length > 0) {
    throw new Error(
      `dist runtime artifact contains paths outside the runtime allowlist: ${unexpectedEntries.slice(0, 10).join(", ")}`,
    );
  }
}

function reserveLoopbackPort(): Promise<number> {
  return new Promise<number>((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to reserve a loopback port for the gateway smoke"));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(new Error("failed to release the reserved gateway smoke port", { cause: error }));
          return;
        }
        resolvePromise(address.port);
      });
    });
  });
}

async function waitForGatewayReadiness(params: GatewaySmokeParams): Promise<void> {
  const deadline = Date.now() + DIST_RUNTIME_ARTIFACT_SMOKE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (params.child.exitCode !== null) {
      throw new Error(`extracted gateway exited before readiness:\n${params.readOutput()}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${params.port}/readyz`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        const body = await response.json();
        if (body?.ready === true) {
          return;
        }
      }
    } catch {
      // Gateway startup is asynchronous; retry until the bounded deadline.
    }
    await new Promise((resolvePromise) => {
      setTimeout(resolvePromise, 250);
    });
  }
  throw new Error(`extracted gateway did not become ready:\n${params.readOutput()}`);
}

async function waitForGatewayPluginLoaded(params: GatewayPluginSmokeParams): Promise<void> {
  const expectedOutput = `plugin: ${BUNDLED_PLUGIN_SMOKE_ID}`;
  const deadline = Date.now() + DIST_RUNTIME_ARTIFACT_SMOKE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (params.child.exitCode !== null) {
      throw new Error(
        `extracted gateway exited before loading ${BUNDLED_PLUGIN_SMOKE_ID}:\n${params.readOutput()}`,
      );
    }
    if (params.readOutput().includes(expectedOutput)) {
      return;
    }
    await new Promise((resolvePromise) => {
      setTimeout(resolvePromise, 100);
    });
  }
  throw new Error(
    `extracted gateway did not load ${BUNDLED_PLUGIN_SMOKE_ID}:\n${params.readOutput()}`,
  );
}

async function waitForGatewayProcessGroupExit(
  processGroupId: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(processGroupId, 0);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") {
        return true;
      }
      throw error;
    }
    await new Promise((resolvePromise) => {
      setTimeout(resolvePromise, 50);
    });
  }
  return false;
}

async function stopGatewaySmoke(child: GatewayProcess): Promise<void> {
  if (process.platform === "win32" || !child.pid) {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise((resolvePromise) => {
          child.once("exit", resolvePromise);
        }),
        new Promise((resolvePromise) => {
          setTimeout(resolvePromise, 5_000);
        }),
      ]);
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await new Promise((resolvePromise) => {
          child.once("exit", resolvePromise);
        });
      }
    }
    return;
  }

  const processGroupId = -child.pid;
  process.kill(processGroupId, "SIGTERM");
  if (await waitForGatewayProcessGroupExit(processGroupId, 5_000)) {
    return;
  }
  process.kill(processGroupId, "SIGKILL");
  if (!(await waitForGatewayProcessGroupExit(processGroupId, 5_000))) {
    throw new Error("failed to stop the extracted gateway process group");
  }
}

export async function buildAndSmokeDistRuntimeArtifact(params: {
  rootDir: string;
  archivePath: string;
  compressor?: string;
}): Promise<{ archivePath: string; artifactPaths: string[] }> {
  const rootDir = resolve(params.rootDir);
  const archivePath = resolve(params.archivePath);
  const compressor = params.compressor ?? "zstdmt";
  const artifactPaths = collectDistRuntimeArtifactPaths(rootDir);
  const artifactRoot = mkdtempSync(join(tmpdir(), "openclaw-dist-runtime-artifact-"));
  mkdirSync(dirname(archivePath), { recursive: true });
  try {
    stageDistRuntimeArtifact(rootDir, artifactRoot);
    execFileSync(
      "tar",
      ["--posix", "-cf", archivePath, "--use-compress-program", compressor, ...artifactPaths],
      { cwd: artifactRoot, stdio: "inherit" },
    );

    const entries = listDistRuntimeArtifactEntries(archivePath, compressor);
    validateDistRuntimeArtifactEntries(entries, artifactPaths);

    const smokeRoot = mkdtempSync(join(tmpdir(), "openclaw-dist-runtime-artifact-smoke-"));
    const packageRoot = join(smokeRoot, "package");
    const homeDir = join(smokeRoot, "home");
    const cwd = join(smokeRoot, "cwd");
    mkdirSync(packageRoot, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });

    const artifactEnvOverrides = {
      OPENCLAW_CONFIG_PATH: join(homeDir, "openclaw.json"),
      OPENCLAW_STATE_DIR: join(homeDir, "state"),
    };
    writeFileSync(
      artifactEnvOverrides.OPENCLAW_CONFIG_PATH,
      `${JSON.stringify(
        {
          plugins: {
            allow: [BUNDLED_PLUGIN_SMOKE_ID],
            entries: { [BUNDLED_PLUGIN_SMOKE_ID]: { enabled: true } },
          },
        },
        null,
        2,
      )}\n`,
    );
    const smokeEnv = createWorkspaceBootstrapSmokeEnv(process.env, homeDir, artifactEnvOverrides);
    const gatewayEnv = { ...smokeEnv };
    delete gatewayEnv.OPENCLAW_DISABLE_BUNDLED_PLUGINS;

    let gatewayOutput = "";
    try {
      execFileSync(
        "tar",
        ["--use-compress-program", compressor, "-xf", archivePath, "-C", packageRoot],
        { stdio: "inherit" },
      );
      runInstalledWorkspaceBootstrapSmoke({
        packageRoot,
        envOverrides: artifactEnvOverrides,
      });
      assertExtractedPluginRuntimeDependencies(packageRoot);
      probeExtractedAcpxRuntime({
        packageRoot,
        cwd,
        stateDir: artifactEnvOverrides.OPENCLAW_STATE_DIR,
        env: smokeEnv,
      });

      const port = await reserveLoopbackPort();
      const gateway = spawn(
        process.execPath,
        [
          join(packageRoot, "openclaw.mjs"),
          "gateway",
          "run",
          "--allow-unconfigured",
          "--auth",
          "none",
          "--bind",
          "loopback",
          "--port",
          String(port),
        ],
        {
          cwd,
          detached: process.platform !== "win32",
          env: gatewayEnv,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      try {
        const appendGatewayOutput = (chunk: Buffer) => {
          gatewayOutput += chunk.toString();
          if (Buffer.byteLength(gatewayOutput) > DIST_RUNTIME_ARTIFACT_MAX_OUTPUT_BYTES) {
            gatewayOutput = gatewayOutput.slice(-DIST_RUNTIME_ARTIFACT_MAX_OUTPUT_BYTES);
          }
        };
        gateway.stdout?.on("data", appendGatewayOutput);
        gateway.stderr?.on("data", appendGatewayOutput);
        await waitForGatewayReadiness({ child: gateway, port, readOutput: () => gatewayOutput });
        await waitForGatewayPluginLoaded({ child: gateway, readOutput: () => gatewayOutput });
      } finally {
        await stopGatewaySmoke(gateway);
      }
    } finally {
      rmSync(smokeRoot, { force: true, recursive: true });
    }
  } finally {
    rmSync(artifactRoot, { force: true, recursive: true });
  }

  return { archivePath, artifactPaths };
}

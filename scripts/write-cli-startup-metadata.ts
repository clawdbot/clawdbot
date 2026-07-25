// Write Cli Startup Metadata script supports OpenClaw repository automation.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pMap from "p-map";
import type { RootHelpRenderOptions } from "../src/cli/program/root-help.js";
import type { OpenClawConfig } from "../src/config/config.js";
import { resolveCliStartupRootHelpBundleIdentity } from "./lib/cli-startup-root-help-bundle.js";
import { resolveWindowsTaskkillPath } from "./lib/windows-taskkill.mjs";

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    out.push(value);
  }
  return out;
}

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptPath);
const rootDir = path.resolve(scriptDir, "..");
const distDir = path.join(rootDir, "dist");
const outputPath = path.join(distDir, "cli-startup-metadata.json");
const extensionsDir = path.join(rootDir, "extensions");
const ROOT_HELP_RENDER_TIMEOUT_MS = 120_000;
const COMMAND_HELP_RENDER_TIMEOUT_MS = 120_000;
const COMMAND_HELP_RENDER_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const COMMAND_HELP_RENDER_KILL_GRACE_MS = 5_000;
// Each help render is an isolated CLI boot; concurrency only bounds process
// fan-out, not output content, so scale with the host instead of serializing
// eight boots two at a time.
const COMMAND_HELP_RENDER_CONCURRENCY = Math.min(8, Math.max(2, availableParallelism()));
const PRECOMPUTED_SUBCOMMAND_HELP_COMMANDS = [
  "doctor",
  "gateway",
  "models",
  "plugins",
  "sessions",
  "tasks",
] as const;
const CORE_CHANNEL_ORDER = [
  "telegram",
  "whatsapp",
  "discord",
  "irc",
  "googlechat",
  "slack",
  "signal",
  "imessage",
] as const;
const generatorSignature = createHash("sha1").update(readFileSync(scriptPath)).digest("hex");

type ExtensionChannelEntry = {
  id: string;
  order: number;
  label: string;
};

type BundledChannelCatalog = {
  ids: string[];
  signature: string;
};

type PrecomputedSubcommandHelpCommand = (typeof PRECOMPUTED_SUBCOMMAND_HELP_COMMANDS)[number];
type PrecomputedSubcommandHelpText = Record<PrecomputedSubcommandHelpCommand, string>;
type RootHelpRenderContext = Pick<RootHelpRenderOptions, "config" | "env">;
type Awaitable<T> = T | Promise<T>;
type SourceCommandHelpCommand = "browser" | "nodes" | "secrets" | PrecomputedSubcommandHelpCommand;
type SourceCommandHelpText = Record<SourceCommandHelpCommand, string>;
type ExistingCliStartupMetadata = {
  rootHelpBundleSignature?: unknown;
  generatorSignature?: unknown;
  browserHelpSourceSignature?: unknown;
  secretsHelpSourceSignature?: unknown;
  nodesHelpSourceSignature?: unknown;
  subcommandHelpSourceSignature?: unknown;
  channelCatalogSignature?: unknown;
  browserHelpText?: unknown;
  secretsHelpText?: unknown;
  nodesHelpText?: unknown;
  subcommandHelpText?: unknown;
  rootHelpText?: unknown;
};
type SpawnTextParentSignalState = {
  done: boolean;
  signal: NodeJS.Signals | null;
};
type KillableChild = {
  kill(signal: NodeJS.Signals): boolean;
  pid?: number;
};
type RunTaskkill = (
  command: string,
  args: string[],
  options: { stdio: "ignore" },
) => { error?: unknown; status?: number | null } | undefined;

const activeSpawnTextParentSignals = new Set<SpawnTextParentSignalState>();

function maybeReraiseSpawnTextParentSignal(signal: NodeJS.Signals): void {
  for (const state of activeSpawnTextParentSignals) {
    if (state.signal === null || !state.done) {
      return;
    }
  }
  process.kill(process.pid, signal);
}

function signalWindowsProcessTree(
  pid: number,
  signal: NodeJS.Signals,
  runTaskkill: RunTaskkill = spawnSync,
): boolean {
  const args = ["/PID", String(pid), "/T"];
  if (signal === "SIGKILL") {
    args.push("/F");
  }
  const result = runTaskkill(resolveWindowsTaskkillPath(), args, { stdio: "ignore" });
  return !result?.error && result?.status === 0;
}

function signalWindowsProcessTreeOrForce(
  pid: number,
  signal: NodeJS.Signals,
  runTaskkill: RunTaskkill = spawnSync,
): boolean {
  if (signalWindowsProcessTree(pid, signal, runTaskkill)) {
    return true;
  }
  return signal !== "SIGKILL" && signalWindowsProcessTree(pid, "SIGKILL", runTaskkill);
}

function signalCliStartupMetadataProcessTree(
  child: KillableChild,
  signal: NodeJS.Signals,
  {
    appendDiagnostic = () => {},
    platform = process.platform,
    runTaskkill = spawnSync,
    useProcessGroup = platform !== "win32",
  }: {
    appendDiagnostic?: (message: string) => void;
    platform?: NodeJS.Platform;
    runTaskkill?: RunTaskkill;
    useProcessGroup?: boolean;
  } = {},
): void {
  if (useProcessGroup && typeof child.pid === "number") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        appendDiagnostic(
          `failed to send ${signal} to process group: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }
  }
  if (platform === "win32" && typeof child.pid === "number") {
    if (signalWindowsProcessTreeOrForce(child.pid, signal, runTaskkill)) {
      return;
    }
  }
  child.kill(signal);
}

function updateHashFromFiles(
  hash: ReturnType<typeof createHash>,
  files: string[],
  sourceRootDir: string = rootDir,
): void {
  for (const file of files.toSorted()) {
    hash.update(`${path.relative(sourceRootDir, file)}\0`);
    hash.update(readFileSync(file));
    hash.update("\0");
  }
}

function resolveBrowserHelpSourceSignature(sourceRootDir: string = rootDir): string {
  const hash = createHash("sha1");
  const browserCliDir = path.join(sourceRootDir, "extensions/browser/src/cli");
  const browserCliFiles = readdirSync(browserCliDir)
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => path.join(browserCliDir, entry));
  updateHashFromFiles(hash, browserCliFiles, sourceRootDir);
  updateHashFromFiles(
    hash,
    [
      path.join(sourceRootDir, "src/cli/program/help.ts"),
      path.join(sourceRootDir, "src/cli/program/context.ts"),
      path.join(sourceRootDir, "src/cli/banner.ts"),
    ],
    sourceRootDir,
  );
  return hash.digest("hex");
}

function resolveSecretsHelpSourceSignature(sourceRootDir: string = rootDir): string {
  const hash = createHash("sha1");
  updateHashFromFiles(
    hash,
    [
      path.join(sourceRootDir, "src/cli/secrets-cli.ts"),
      path.join(sourceRootDir, "src/cli/program/help.ts"),
      path.join(sourceRootDir, "src/cli/program/context.ts"),
      path.join(sourceRootDir, "src/cli/banner.ts"),
    ],
    sourceRootDir,
  );
  return hash.digest("hex");
}

function resolveNodesHelpSourceSignature(sourceRootDir: string = rootDir): string {
  const hash = createHash("sha1");
  const nodesCliDir = path.join(sourceRootDir, "src/cli/nodes-cli");
  const nodesCliFiles = readdirSync(nodesCliDir)
    .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"))
    .map((entry) => path.join(nodesCliDir, entry));
  updateHashFromFiles(hash, nodesCliFiles, sourceRootDir);
  updateHashFromFiles(
    hash,
    [
      path.join(sourceRootDir, "extensions/canvas/cli-metadata.ts"),
      path.join(sourceRootDir, "extensions/canvas/index.ts"),
      path.join(sourceRootDir, "extensions/canvas/src/a2ui-jsonl.ts"),
      path.join(sourceRootDir, "extensions/canvas/src/cli-helpers.ts"),
      path.join(sourceRootDir, "extensions/canvas/src/cli.ts"),
      path.join(sourceRootDir, "src/cli/program/help.ts"),
      path.join(sourceRootDir, "src/cli/program/context.ts"),
      path.join(sourceRootDir, "src/cli/banner.ts"),
      path.join(sourceRootDir, "src/plugins/register-plugin-cli-command-groups.ts"),
    ],
    sourceRootDir,
  );
  return hash.digest("hex");
}

function resolveSubcommandHelpSourceSignature(sourceRootDir: string = rootDir): string {
  const hash = createHash("sha1");
  updateHashFromFiles(
    hash,
    [
      path.join(sourceRootDir, "src/cli/program/help.ts"),
      path.join(sourceRootDir, "src/cli/program/context.ts"),
      path.join(sourceRootDir, "src/cli/banner.ts"),
      path.join(sourceRootDir, "src/cli/help-format.ts"),
      path.join(sourceRootDir, "src/cli/daemon-cli/register-service-commands.ts"),
      path.join(sourceRootDir, "src/cli/program/register.maintenance.ts"),
      path.join(sourceRootDir, "src/cli/program/register.status-health-sessions.ts"),
      path.join(sourceRootDir, "src/cli/gateway-cli.ts"),
      path.join(sourceRootDir, "src/cli/gateway-cli/register.ts"),
      path.join(sourceRootDir, "src/cli/gateway-cli/run-command.ts"),
      path.join(sourceRootDir, "src/cli/models-cli.ts"),
      path.join(sourceRootDir, "src/cli/plugins-cli.ts"),
      path.join(sourceRootDir, "packages/terminal-core/src/links.ts"),
      path.join(sourceRootDir, "packages/terminal-core/src/theme.ts"),
    ],
    sourceRootDir,
  );
  return hash.digest("hex");
}

function readBundledChannelCatalog(
  extensionsDirOverride: string = extensionsDir,
): BundledChannelCatalog {
  const entries: ExtensionChannelEntry[] = [];
  const signature = createHash("sha1");
  for (const dirEntry of readdirSync(extensionsDirOverride, { withFileTypes: true })) {
    if (!dirEntry.isDirectory()) {
      continue;
    }
    const packageJsonPath = path.join(extensionsDirOverride, dirEntry.name, "package.json");
    try {
      const raw = readFileSync(packageJsonPath, "utf8");
      signature.update(`${dirEntry.name}\0${raw}\0`);
      const parsed = JSON.parse(raw) as {
        openclaw?: {
          channel?: {
            id?: unknown;
            order?: unknown;
            label?: unknown;
          };
        };
      };
      const id = parsed.openclaw?.channel?.id;
      if (typeof id !== "string" || !id.trim()) {
        continue;
      }
      const orderRaw = parsed.openclaw?.channel?.order;
      const labelRaw = parsed.openclaw?.channel?.label;
      entries.push({
        id: id.trim(),
        order: typeof orderRaw === "number" ? orderRaw : 999,
        label: typeof labelRaw === "string" ? labelRaw : id.trim(),
      });
    } catch {
      // Ignore malformed or missing extension package manifests.
    }
  }
  return {
    ids: entries
      .toSorted((a, b) =>
        a.order === b.order ? a.label.localeCompare(b.label) : a.order - b.order,
      )
      .map((entry) => entry.id),
    signature: signature.digest("hex"),
  };
}

function createRootHelpRenderStateDir(): string {
  return mkdtempSync(path.join(tmpdir(), "openclaw-build-root-help-"));
}

function cleanupRootHelpRenderStateDir(stateDir: string): void {
  rmSync(stateDir, { force: true, recursive: true });
}

function withIsolatedRootHelpRenderContext<T>(
  bundledPluginsDir: string,
  render: (context: RootHelpRenderContext) => T,
): T {
  const stateDir = createRootHelpRenderStateDir();
  try {
    const result = render(createIsolatedRootHelpRenderContext(bundledPluginsDir, stateDir));
    if (result instanceof Promise) {
      return result.finally(() => cleanupRootHelpRenderStateDir(stateDir)) as T;
    }
    cleanupRootHelpRenderStateDir(stateDir);
    return result;
  } catch (error) {
    cleanupRootHelpRenderStateDir(stateDir);
    throw error;
  }
}

async function settleRootHelpRenderPromises<T extends readonly unknown[]>(
  values: T,
  stateDir: string,
): Promise<{ -readonly [P in keyof T]: Awaited<T[P]> }> {
  try {
    return await Promise.all(values);
  } finally {
    await Promise.allSettled(values);
    cleanupRootHelpRenderStateDir(stateDir);
  }
}

function createIsolatedRootHelpRenderContext(
  bundledPluginsDir: string,
  stateDir: string,
): RootHelpRenderContext {
  const workspaceDir = path.join(stateDir, "workspace");
  const homeDir = path.join(stateDir, "home");
  const env: NodeJS.ProcessEnv = {
    HOME: homeDir,
    LOGNAME: process.env.LOGNAME ?? process.env.USER ?? "openclaw-build",
    USER: process.env.USER ?? process.env.LOGNAME ?? "openclaw-build",
    PATH: process.env.PATH ?? "",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
    TERM: process.env.TERM ?? "dumb",
    NO_COLOR: "1",
    OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "",
    OPENCLAW_STATE_DIR: stateDir,
  };
  const config: OpenClawConfig = {
    agents: {
      defaults: {
        workspace: workspaceDir,
      },
    },
  };
  return { config, env };
}

async function spawnText(
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    failureMessage: string;
    killGraceMs?: number;
    maxOutputBytes?: number;
    spawnProcess?: typeof spawn;
    timeoutMs: number;
  },
): Promise<string> {
  const maxOutputBytes = options.maxOutputBytes ?? COMMAND_HELP_RENDER_MAX_OUTPUT_BYTES;
  const killGraceMs = options.killGraceMs ?? COMMAND_HELP_RENDER_KILL_GRACE_MS;
  const spawnProcess = options.spawnProcess ?? spawn;
  const useProcessGroup = process.platform !== "win32";
  return await new Promise((resolve, reject) => {
    const child = spawnProcess(process.execPath, args, {
      cwd: options.cwd,
      detached: useProcessGroup,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let outputExceeded = false;
    let outputStreamError: { streamName: "stdout" | "stderr"; error: Error } | undefined;
    let settled = false;
    let timedOut = false;
    let waitingForKillGrace = false;
    let childClosedResult: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let parentSignalPending: NodeJS.Signals | null = null;
    const parentSignalState: SpawnTextParentSignalState = { done: false, signal: null };
    activeSpawnTextParentSignals.add(parentSignalState);
    const parentSignalHandlers: { handler: () => void; signal: NodeJS.Signals }[] = [];
    const cleanupParentSignalHandlers = () => {
      for (const { signal, handler } of parentSignalHandlers) {
        process.off(signal, handler);
      }
      parentSignalHandlers.length = 0;
    };
    const signalChild = (signal: NodeJS.Signals) => {
      signalCliStartupMetadataProcessTree(child, signal, {
        appendDiagnostic: (message) => {
          stderr += message;
        },
        useProcessGroup,
      });
    };
    const relayParentSignal = (signal: NodeJS.Signals) => {
      const handler = () => {
        parentSignalPending = signal;
        parentSignalState.signal = signal;
        signalChild(signal);
        cleanupParentSignalHandlers();
        if (!processGroupIsAlive()) {
          parentSignalState.done = true;
          maybeReraiseSpawnTextParentSignal(signal);
          return;
        }
        if (killTimer) {
          clearTimeout(killTimer);
        }
        // Keep this timer ref'ed so parent signal relay waits long enough to
        // force-kill stubborn detached descendants before re-raising.
        waitingForKillGrace = true;
        killTimer = setTimeout(() => {
          waitingForKillGrace = false;
          killTimer = undefined;
          signalChild("SIGKILL");
          parentSignalState.done = true;
          maybeReraiseSpawnTextParentSignal(signal);
        }, killGraceMs);
      };
      parentSignalHandlers.push({ handler, signal });
      process.once(signal, handler);
    };
    if (useProcessGroup) {
      relayParentSignal("SIGINT");
      relayParentSignal("SIGTERM");
      relayParentSignal("SIGHUP");
    }
    const processGroupIsAlive = () => {
      if (!useProcessGroup || typeof child.pid !== "number") {
        return false;
      }
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
      }
    };
    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (!parentSignalPending && killTimer) {
        clearTimeout(killTimer);
      }
      if (!parentSignalPending) {
        activeSpawnTextParentSignals.delete(parentSignalState);
      }
      cleanupParentSignalHandlers();
      callback();
    };
    const finishClose = (result: { code: number | null; signal: NodeJS.Signals | null }) => {
      settle(() => {
        if (outputStreamError) {
          reject(
            new Error(
              `${options.failureMessage}: ${outputStreamError.streamName} read error: ${outputStreamError.error.message}`,
              { cause: outputStreamError.error },
            ),
          );
          return;
        }
        if (result.code === 0 && !timedOut && !outputExceeded) {
          resolve(stdout);
          return;
        }
        const detail = stderr.trim();
        reject(
          new Error(
            options.failureMessage +
              (outputExceeded
                ? `: output exceeded ${maxOutputBytes} bytes`
                : timedOut
                  ? `: timed out after ${options.timeoutMs}ms`
                  : detail
                    ? `: ${detail}`
                    : result.signal
                      ? `: terminated by ${result.signal}`
                      : ""),
          ),
        );
      });
    };
    const scheduleKill = () => {
      if (waitingForKillGrace) {
        return;
      }
      waitingForKillGrace = true;
      killTimer = setTimeout(() => {
        waitingForKillGrace = false;
        killTimer = undefined;
        signalChild("SIGKILL");
        if (childClosedResult) {
          finishClose(childClosedResult);
        }
      }, killGraceMs);
    };
    const requestStop = () => {
      signalChild("SIGTERM");
      scheduleKill();
    };
    const failOutputStream = (streamName: "stdout" | "stderr", error: Error) => {
      // Keep the first stop cause: killing for a timeout or output cap can make
      // the stdio pipes fail secondarily while the child is shutting down.
      if (outputStreamError || timedOut || outputExceeded) {
        return;
      }
      outputStreamError = { streamName, error };
      requestStop();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      requestStop();
    }, options.timeoutMs);
    timeout.unref();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (outputExceeded) {
        return;
      }
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > maxOutputBytes) {
        outputExceeded = true;
        requestStop();
        return;
      }
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (outputExceeded) {
        return;
      }
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > maxOutputBytes) {
        outputExceeded = true;
        requestStop();
        return;
      }
      stderr += chunk;
    });
    child.stdout.once("error", (error: Error) => {
      failOutputStream("stdout", error);
    });
    child.stderr.once("error", (error: Error) => {
      failOutputStream("stderr", error);
    });
    child.once("error", (error) => {
      settle(() => {
        reject(error);
      });
    });
    child.once("close", (code, signal) => {
      const result = { code, signal };
      if (parentSignalPending) {
        if (processGroupIsAlive()) {
          childClosedResult = result;
          return;
        }
        if (killTimer) {
          clearTimeout(killTimer);
          killTimer = undefined;
        }
        parentSignalState.done = true;
        maybeReraiseSpawnTextParentSignal(parentSignalPending);
        return;
      }
      if (waitingForKillGrace && processGroupIsAlive()) {
        childClosedResult = result;
        return;
      }
      finishClose(result);
    });
  });
}

export async function renderBundledRootHelpText(
  _distDirOverride: string = distDir,
  renderContext?: RootHelpRenderContext,
): Promise<string> {
  if (!renderContext) {
    const bundledPluginsDir = existsSync(path.join(_distDirOverride, "extensions"))
      ? path.join(_distDirOverride, "extensions")
      : extensionsDir;
    return await withIsolatedRootHelpRenderContext(
      bundledPluginsDir,
      async (context) => await renderBundledRootHelpText(_distDirOverride, context),
    );
  }
  const bundleIdentity = resolveCliStartupRootHelpBundleIdentity(_distDirOverride);
  if (!bundleIdentity) {
    throw new Error("No root-help bundle found in dist; cannot write CLI startup metadata.");
  }
  const moduleUrl = pathToFileURL(path.join(_distDirOverride, bundleIdentity.bundleName)).href;
  const renderOptions = {
    config: renderContext.config,
    env: renderContext.env,
  } satisfies RootHelpRenderOptions;
  const inlineModule = [
    `const mod = await import(${JSON.stringify(moduleUrl)});`,
    "if (typeof mod.outputRootHelp !== 'function') {",
    `  throw new Error(${JSON.stringify(`Bundle ${bundleIdentity.bundleName} does not export outputRootHelp.`)});`,
    "}",
    `await mod.outputRootHelp(${JSON.stringify(renderOptions)});`,
    "process.exit(0);",
  ].join("\n");
  return await spawnText(["--input-type=module", "--eval", inlineModule], {
    cwd: _distDirOverride,
    // RootHelpRenderOptions marks env optional; spawnText requires one.
    env: renderContext.env ?? process.env,
    failureMessage: `Failed to render bundled root help from ${bundleIdentity.bundleName}`,
    timeoutMs: ROOT_HELP_RENDER_TIMEOUT_MS,
  });
}

function renderSourceRootHelpText(renderContext?: RootHelpRenderContext): string {
  if (!renderContext) {
    return withIsolatedRootHelpRenderContext(extensionsDir, renderSourceRootHelpText);
  }
  const moduleUrl = pathToFileURL(path.join(rootDir, "src/cli/program/root-help.ts")).href;
  const renderOptions = {
    pluginSdkResolution: "src",
    config: renderContext.config,
    env: renderContext.env,
  } satisfies RootHelpRenderOptions;
  const inlineModule = [
    `const mod = await import(${JSON.stringify(moduleUrl)});`,
    "if (typeof mod.renderRootHelpText !== 'function') {",
    `  throw new Error(${JSON.stringify("Source root-help module does not export renderRootHelpText.")});`,
    "}",
    `const output = await mod.renderRootHelpText(${JSON.stringify(renderOptions)});`,
    "process.stdout.write(output);",
    "process.exit(0);",
  ].join("\n");
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", inlineModule],
    {
      cwd: rootDir,
      encoding: "utf8",
      env: renderContext.env,
      killSignal: "SIGKILL",
      timeout: ROOT_HELP_RENDER_TIMEOUT_MS,
    },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    throw new Error(
      "Failed to render source root help" +
        (stderr ? `: ${stderr}` : result.signal ? `: terminated by ${result.signal}` : ""),
    );
  }
  return result.stdout ?? "";
}

async function renderSourceBrowserHelpText(renderContext: RootHelpRenderContext): Promise<string> {
  // The launcher CLI boot renders byte-identical browser help to a direct
  // tsx source render (registerBrowserCli + configureProgramHelp) while
  // avoiding a tsx evaluation of the whole browser CLI import graph, which
  // dominated this script's wall time.
  return await renderSourceCommandHelpText("browser", renderContext);
}

async function renderSourceCommandHelpText(
  command: SourceCommandHelpCommand,
  renderContext: RootHelpRenderContext,
): Promise<string> {
  return await spawnText(["openclaw.mjs", command, "--help"], {
    cwd: rootDir,
    env: {
      ...renderContext.env,
      OPENCLAW_DISABLE_CLI_STARTUP_HELP_FAST_PATH: "1",
    },
    failureMessage: `Failed to render source ${command} help`,
    timeoutMs: COMMAND_HELP_RENDER_TIMEOUT_MS,
  });
}

async function renderSourceSecretsHelpText(renderContext: RootHelpRenderContext): Promise<string> {
  return await renderSourceCommandHelpText("secrets", renderContext);
}

async function renderSourceNodesHelpText(renderContext: RootHelpRenderContext): Promise<string> {
  return await renderSourceCommandHelpText("nodes", renderContext);
}

async function renderSourceCommandHelpTextRecord(
  commands: readonly SourceCommandHelpCommand[],
  renderContext: RootHelpRenderContext,
): Promise<SourceCommandHelpText> {
  const helpTexts = await pMap(
    commands,
    async (commandName) => await renderSourceCommandHelpText(commandName, renderContext),
    {
      concurrency: COMMAND_HELP_RENDER_CONCURRENCY,
      stopOnError: true,
    },
  );
  return Object.fromEntries(
    commands.map((commandName, index) => [commandName, helpTexts[index]]),
  ) as SourceCommandHelpText;
}

async function renderSourceSubcommandHelpTextRecord(
  renderContext: RootHelpRenderContext,
): Promise<PrecomputedSubcommandHelpText> {
  const commandHelpText = await renderSourceCommandHelpTextRecord(
    PRECOMPUTED_SUBCOMMAND_HELP_COMMANDS,
    renderContext,
  );
  return Object.fromEntries(
    PRECOMPUTED_SUBCOMMAND_HELP_COMMANDS.map((commandName) => [
      commandName,
      commandHelpText[commandName],
    ]),
  ) as PrecomputedSubcommandHelpText;
}

export async function writeCliStartupMetadata(options?: {
  distDir?: string;
  outputPath?: string;
  extensionsDir?: string;
  sourceRootDir?: string;
  renderBundledRootHelpText?: typeof renderBundledRootHelpText;
  renderSourceRootHelpText?: typeof renderSourceRootHelpText;
  renderSourceBrowserHelpText?: (renderContext: RootHelpRenderContext) => Awaitable<string>;
  renderSourceSecretsHelpText?: (renderContext: RootHelpRenderContext) => Awaitable<string>;
  renderSourceNodesHelpText?: (renderContext: RootHelpRenderContext) => Awaitable<string>;
  renderSourceSubcommandHelpTextRecord?: (
    renderContext: RootHelpRenderContext,
  ) => Awaitable<PrecomputedSubcommandHelpText>;
}): Promise<void> {
  const resolvedDistDir = options?.distDir ?? distDir;
  const resolvedOutputPath = options?.outputPath ?? outputPath;
  const resolvedExtensionsDir = options?.extensionsDir ?? extensionsDir;
  const resolvedSourceRootDir = options?.sourceRootDir ?? rootDir;
  const channelCatalog = readBundledChannelCatalog(resolvedExtensionsDir);
  const bundleIdentity = resolveCliStartupRootHelpBundleIdentity(resolvedDistDir);
  const browserHelpSourceSignature = resolveBrowserHelpSourceSignature(resolvedSourceRootDir);
  const secretsHelpSourceSignature = resolveSecretsHelpSourceSignature(resolvedSourceRootDir);
  const nodesHelpSourceSignature = resolveNodesHelpSourceSignature(resolvedSourceRootDir);
  const subcommandHelpSourceSignature = resolveSubcommandHelpSourceSignature(resolvedSourceRootDir);
  const bundledPluginsDir = path.join(resolvedDistDir, "extensions");
  const channelOptions = dedupe([...CORE_CHANNEL_ORDER, ...channelCatalog.ids]);

  let existing: ExistingCliStartupMetadata | undefined;
  try {
    existing = JSON.parse(readFileSync(resolvedOutputPath, "utf8")) as ExistingCliStartupMetadata;
  } catch {
    // Missing or malformed existing metadata means we should regenerate it.
  }

  const reusableExisting =
    existing?.generatorSignature === generatorSignature &&
    existing.channelCatalogSignature === channelCatalog.signature
      ? existing
      : undefined;
  const reusableRootHelpText =
    reusableExisting &&
    bundleIdentity &&
    reusableExisting.rootHelpBundleSignature === bundleIdentity.signature &&
    typeof reusableExisting.rootHelpText === "string" &&
    reusableExisting.rootHelpText.length > 0
      ? reusableExisting.rootHelpText
      : undefined;
  const reusableBrowserHelpText =
    reusableExisting &&
    bundleIdentity &&
    reusableExisting.rootHelpBundleSignature === bundleIdentity.signature &&
    reusableExisting.browserHelpSourceSignature === browserHelpSourceSignature &&
    typeof reusableExisting.browserHelpText === "string" &&
    reusableExisting.browserHelpText.length > 0
      ? reusableExisting.browserHelpText
      : undefined;
  const reusableSecretsHelpText =
    reusableExisting &&
    bundleIdentity &&
    reusableExisting.rootHelpBundleSignature === bundleIdentity.signature &&
    reusableExisting.secretsHelpSourceSignature === secretsHelpSourceSignature &&
    typeof reusableExisting.secretsHelpText === "string" &&
    reusableExisting.secretsHelpText.length > 0
      ? reusableExisting.secretsHelpText
      : undefined;
  const reusableNodesHelpText =
    reusableExisting &&
    bundleIdentity &&
    reusableExisting.rootHelpBundleSignature === bundleIdentity.signature &&
    reusableExisting.nodesHelpSourceSignature === nodesHelpSourceSignature &&
    typeof reusableExisting.nodesHelpText === "string" &&
    reusableExisting.nodesHelpText.length > 0
      ? reusableExisting.nodesHelpText
      : undefined;
  const reusableSubcommandHelpText =
    reusableExisting &&
    bundleIdentity &&
    reusableExisting.rootHelpBundleSignature === bundleIdentity.signature &&
    reusableExisting.subcommandHelpSourceSignature === subcommandHelpSourceSignature &&
    hasAllPrecomputedSubcommandHelpText(reusableExisting.subcommandHelpText)
      ? (reusableExisting.subcommandHelpText as PrecomputedSubcommandHelpText)
      : undefined;
  if (
    reusableRootHelpText &&
    reusableBrowserHelpText &&
    reusableSecretsHelpText &&
    reusableNodesHelpText &&
    reusableSubcommandHelpText
  ) {
    return;
  }

  const renderStateDir = createRootHelpRenderStateDir();
  const renderContext = createIsolatedRootHelpRenderContext(
    existsSync(bundledPluginsDir) ? bundledPluginsDir : resolvedExtensionsDir,
    renderStateDir,
  );
  const rootHelpTextPromise = reusableRootHelpText
    ? Promise.resolve(reusableRootHelpText)
    : (async () => {
        try {
          return await (options?.renderBundledRootHelpText ?? renderBundledRootHelpText)(
            resolvedDistDir,
            renderContext,
          );
        } catch {
          // The spawnSync source fallback blocks the event loop; that is fine for
          // this rare recovery path (missing/broken bundle) and only delays
          // draining sibling render output, not its correctness.
          return (options?.renderSourceRootHelpText ?? renderSourceRootHelpText)(renderContext);
        }
      })();
  const hasCustomCommandRenderer =
    options?.renderSourceBrowserHelpText ||
    options?.renderSourceSecretsHelpText ||
    options?.renderSourceNodesHelpText ||
    options?.renderSourceSubcommandHelpTextRecord;
  const sourceCommandsToRender: SourceCommandHelpCommand[] = [];
  if (!reusableBrowserHelpText) {
    sourceCommandsToRender.push("browser");
  }
  if (!reusableSecretsHelpText) {
    sourceCommandsToRender.push("secrets");
  }
  if (!reusableNodesHelpText) {
    sourceCommandsToRender.push("nodes");
  }
  if (!reusableSubcommandHelpText) {
    sourceCommandsToRender.push(...PRECOMPUTED_SUBCOMMAND_HELP_COMMANDS);
  }
  const commandHelpTextPromise =
    hasCustomCommandRenderer || sourceCommandsToRender.length === 0
      ? null
      : renderSourceCommandHelpTextRecord(sourceCommandsToRender, renderContext);
  const browserHelpTextPromise = reusableBrowserHelpText
    ? Promise.resolve(reusableBrowserHelpText)
    : commandHelpTextPromise
      ? commandHelpTextPromise.then((commandHelpText) => commandHelpText.browser)
      : Promise.resolve().then(() =>
          (options?.renderSourceBrowserHelpText ?? renderSourceBrowserHelpText)(renderContext),
        );
  const secretsHelpTextPromise = reusableSecretsHelpText
    ? Promise.resolve(reusableSecretsHelpText)
    : commandHelpTextPromise
      ? commandHelpTextPromise.then((commandHelpText) => commandHelpText.secrets)
      : Promise.resolve().then(() =>
          (options?.renderSourceSecretsHelpText ?? renderSourceSecretsHelpText)(renderContext),
        );
  const nodesHelpTextPromise = reusableNodesHelpText
    ? Promise.resolve(reusableNodesHelpText)
    : commandHelpTextPromise
      ? commandHelpTextPromise.then((commandHelpText) => commandHelpText.nodes)
      : Promise.resolve().then(() =>
          (options?.renderSourceNodesHelpText ?? renderSourceNodesHelpText)(renderContext),
        );
  const subcommandHelpTextPromise = reusableSubcommandHelpText
    ? Promise.resolve(reusableSubcommandHelpText)
    : commandHelpTextPromise
      ? commandHelpTextPromise.then(
          (commandHelpText) =>
            Object.fromEntries(
              PRECOMPUTED_SUBCOMMAND_HELP_COMMANDS.map((commandName) => [
                commandName,
                commandHelpText[commandName],
              ]),
            ) as PrecomputedSubcommandHelpText,
        )
      : Promise.resolve().then(() =>
          (options?.renderSourceSubcommandHelpTextRecord ?? renderSourceSubcommandHelpTextRecord)(
            renderContext,
          ),
        );
  const [rootHelpText, browserHelpText, secretsHelpText, nodesHelpText, subcommandHelpText] =
    await settleRootHelpRenderPromises(
      [
        rootHelpTextPromise,
        browserHelpTextPromise,
        secretsHelpTextPromise,
        nodesHelpTextPromise,
        subcommandHelpTextPromise,
      ] as const,
      renderStateDir,
    );

  mkdirSync(resolvedDistDir, { recursive: true });
  writeFileSync(
    resolvedOutputPath,
    `${JSON.stringify(
      {
        generatedBy: "scripts/write-cli-startup-metadata.ts",
        generatorSignature,
        channelOptions,
        channelCatalogSignature: channelCatalog.signature,
        rootHelpBundleSignature: bundleIdentity?.signature ?? null,
        browserHelpSourceSignature,
        secretsHelpSourceSignature,
        nodesHelpSourceSignature,
        subcommandHelpSourceSignature,
        browserHelpText,
        secretsHelpText,
        nodesHelpText,
        subcommandHelpText,
        rootHelpText,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function hasAllPrecomputedSubcommandHelpText(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Partial<Record<PrecomputedSubcommandHelpCommand, unknown>>;
  return PRECOMPUTED_SUBCOMMAND_HELP_COMMANDS.every(
    (commandName) => typeof record[commandName] === "string" && record[commandName].length > 0,
  );
}

export const testing = {
  renderSourceRootHelpText,
  signalCliStartupMetadataProcessTree,
  spawnText,
};

export { testing as __testing };

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  await writeCliStartupMetadata();
  process.exit(0);
}

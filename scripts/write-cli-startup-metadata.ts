// Write Cli Startup Metadata script supports OpenClaw repository automation.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs, {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import pMap from "p-map";
import type { RootHelpRenderOptions } from "../src/cli/program/root-help.js";
import type { OpenClawConfig } from "../src/config/config.js";
import { resolveCliStartupRootHelpBundleIdentity } from "./lib/cli-startup-root-help-bundle.js";
import { terminateManagedChild } from "./lib/managed-child-process.mts";

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
// Cold CLI boots compete for the same module graph, so CPU count is not a safe
// proxy for module-loading throughput on a disk-contended host.
const COMMAND_HELP_RENDER_CONCURRENCY = 2;
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
type RenderTaskContext = {
  reportFailure: (error: unknown) => void;
  signal: AbortSignal;
};
type SourceHelpRenderer<T = string> = (
  renderContext: RootHelpRenderContext,
  taskContext?: RenderTaskContext,
) => Awaitable<T>;
class CliStartupMetadataRenderSupervisor {
  readonly #abortController = new AbortController();
  readonly #parentSignalHandlers: Array<{ handler: () => void; signal: NodeJS.Signals }> = [];
  #firstFailure: Error | undefined;
  #parentSignal: NodeJS.Signals | null = null;
  #preserveRenderState = false;

  constructor() {
    const signals: NodeJS.Signals[] =
      process.platform === "win32" ? ["SIGINT", "SIGTERM"] : ["SIGINT", "SIGTERM", "SIGHUP"];
    for (const signal of signals) {
      const handler = () => {
        this.#parentSignal ??= signal;
        if (!this.#abortController.signal.aborted) {
          this.#abortController.abort(new Error(`CLI startup metadata interrupted by ${signal}`));
        }
      };
      this.#parentSignalHandlers.push({ handler, signal });
      process.once(signal, handler);
    }
  }

  get firstFailure(): Error | undefined {
    return this.#firstFailure;
  }

  get signal(): AbortSignal {
    return this.#abortController.signal;
  }

  get preserveRenderState(): boolean {
    return this.#preserveRenderState;
  }

  reportFailure(error: unknown): void {
    if (
      error instanceof Error &&
      "preserveRenderState" in error &&
      error.preserveRenderState === true
    ) {
      this.#preserveRenderState = true;
    }
    if (this.#firstFailure || this.#parentSignal) {
      return;
    }
    this.#firstFailure = toErrorObject(error, "CLI startup metadata render failed");
    this.#abortController.abort(this.#firstFailure);
  }

  async run<T>(render: (context: RenderTaskContext) => Awaitable<T>): Promise<T> {
    // Register every sibling before a synchronous renderer can abort the shared group.
    await Promise.resolve();
    if (this.signal.aborted) {
      throw this.signal.reason ?? new Error("CLI startup metadata render aborted");
    }
    try {
      return await render({
        reportFailure: (error) => this.reportFailure(error),
        signal: this.signal,
      });
    } catch (error) {
      this.reportFailure(error);
      throw error;
    }
  }

  finish(
    primaryFailure: unknown,
    cleanupError?: unknown,
    preservedStateDir?: string,
  ): never | void {
    for (const { signal, handler } of this.#parentSignalHandlers) {
      process.off(signal, handler);
    }
    this.#parentSignalHandlers.length = 0;
    if (this.#parentSignal) {
      process.kill(process.pid, this.#parentSignal);
      return;
    }
    const failure =
      this.#firstFailure ??
      (primaryFailure
        ? toErrorObject(primaryFailure, "CLI startup metadata render failed")
        : undefined);
    if (!failure) {
      if (cleanupError) {
        throw toErrorObject(cleanupError, "CLI startup metadata cleanup failed");
      }
      return;
    }
    if (cleanupError) {
      Object.assign(failure, { cleanupError });
    }
    if (preservedStateDir) {
      failure.message += `\nPreserved CLI startup metadata render state: ${preservedStateDir}`;
    }
    throw failure;
  }
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
  fs.rmSync(stateDir, { force: true, recursive: true, maxRetries: 6, retryDelay: 25 });
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
  supervisor: CliStartupMetadataRenderSupervisor,
): Promise<{ -readonly [P in keyof T]: Awaited<T[P]> }> {
  const settled = await Promise.allSettled(values);
  const rejected = settled.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  let cleanupError: unknown;
  if (!supervisor.preserveRenderState) {
    try {
      cleanupRootHelpRenderStateDir(stateDir);
    } catch (error) {
      cleanupError = error;
    }
  }
  supervisor.finish(
    rejected?.reason,
    cleanupError,
    supervisor.preserveRenderState ? stateDir : undefined,
  );
  return settled.map((result) => (result as PromiseFulfilledResult<unknown>).value) as {
    -readonly [P in keyof T]: Awaited<T[P]>;
  };
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

function createSpawnTextFailure(params: {
  cause?: unknown;
  detail?: string;
  failureMessage: string;
  kind:
    | "aborted"
    | "nonzero-exit"
    | "output-limit"
    | "process-tree-cleanup"
    | "spawn-error"
    | "stream-error"
    | "timeout";
  startedAt: number;
}): Error {
  const elapsedMs = Date.now() - params.startedAt;
  return Object.assign(
    new Error(
      `${params.failureMessage}${params.detail ? `: ${params.detail}` : ""} (elapsed ${elapsedMs}ms)`,
      params.cause === undefined ? undefined : { cause: params.cause },
    ),
    {
      code:
        params.kind === "timeout"
          ? "ETIMEDOUT"
          : params.kind === "aborted"
            ? "EABORTED"
            : params.kind === "process-tree-cleanup"
              ? "EPROCESSGROUP_CLEANUP_FAILED"
              : "ECLI_STARTUP_METADATA_RENDER",
      elapsedMs,
      renderFailureKind: params.kind,
    },
  );
}

async function spawnText(
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    failureMessage: string;
    killGraceMs?: number;
    maxOutputBytes?: number;
    onTerminalFailure?: (error: Error) => void;
    signal?: AbortSignal;
    spawnProcess?: typeof spawn;
    timeoutMs: number;
  },
): Promise<string> {
  const maxOutputBytes = options.maxOutputBytes ?? COMMAND_HELP_RENDER_MAX_OUTPUT_BYTES;
  const killGraceMs = options.killGraceMs ?? COMMAND_HELP_RENDER_KILL_GRACE_MS;
  const spawnProcess = options.spawnProcess ?? spawn;
  const useProcessGroup = process.platform !== "win32";
  const startedAt = Date.now();
  if (options.signal?.aborted) {
    throw createSpawnTextFailure({
      cause: options.signal.reason,
      detail: "aborted before start",
      failureMessage: options.failureMessage,
      kind: "aborted",
      startedAt,
    });
  }
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
    let settled = false;
    let terminalFailure: Error | undefined;
    let processTreeCleanupFailure: Error | undefined;
    let waitingForKillGrace = false;
    let forceKillInFlight = false;
    let childClosedResult: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const signalChild = (signal: NodeJS.Signals) => {
      terminateManagedChild(child, signal, {
        onProcessGroupSignalError: (error) => {
          stderr += `failed to send ${signal} to process group: ${error instanceof Error ? error.message : String(error)}\n`;
        },
        useProcessGroup,
      });
    };
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
    const waitForProcessGroupExit = async (timeoutMs: number) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (!processGroupIsAlive()) {
          return true;
        }
        await new Promise((resolvePoll) => {
          setTimeout(resolvePoll, 25);
        });
      }
      return !processGroupIsAlive();
    };
    const recordTerminalFailure = (error: Error) => {
      if (terminalFailure) {
        return terminalFailure;
      }
      terminalFailure = error;
      options.onTerminalFailure?.(error);
      return error;
    };
    const createFailure = (
      kind: Parameters<typeof createSpawnTextFailure>[0]["kind"],
      detail: string,
      cause?: unknown,
    ) =>
      createSpawnTextFailure({
        cause,
        detail,
        failureMessage: options.failureMessage,
        kind,
        startedAt,
      });
    const fail = (
      kind: Parameters<typeof createSpawnTextFailure>[0]["kind"],
      detail: string,
      cause?: unknown,
    ) => recordTerminalFailure(createFailure(kind, detail, cause));
    const abortListener = () => {
      if (settled || terminalFailure) {
        return;
      }
      fail("aborted", "aborted after sibling failure", options.signal?.reason);
      signalChild("SIGTERM");
      scheduleKill();
    };
    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (killTimer) {
        clearTimeout(killTimer);
      }
      options.signal?.removeEventListener("abort", abortListener);
      callback();
    };
    const finishClose = (result: { code: number | null; signal: NodeJS.Signals | null }) => {
      settle(() => {
        if (result.code === 0 && !terminalFailure) {
          resolve(stdout);
          return;
        }
        const detail = stderr.trim() || (result.signal ? `terminated by ${result.signal}` : "");
        const failure = terminalFailure ?? createFailure("nonzero-exit", detail);
        if (processTreeCleanupFailure) {
          Object.assign(failure, {
            preserveRenderState: true,
            processTreeCleanupFailure,
          });
        }
        reject(failure);
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
        forceKillInFlight = true;
        signalChild("SIGKILL");
        const forceDrain = useProcessGroup
          ? waitForProcessGroupExit(killGraceMs)
          : Promise.resolve(true);
        void forceDrain.then((drained) => {
          forceKillInFlight = false;
          if (!drained) {
            processTreeCleanupFailure = Object.assign(
              createFailure(
                "process-tree-cleanup",
                `process group did not exit within ${killGraceMs}ms after SIGKILL`,
              ),
              { preserveRenderState: true },
            );
            options.onTerminalFailure?.(processTreeCleanupFailure);
          }
          if (childClosedResult) {
            finishClose(childClosedResult);
          } else if (!drained) {
            child.stdout.destroy();
            child.stderr.destroy();
            child.unref?.();
            finishClose({ code: null, signal: "SIGKILL" });
          }
        });
      }, killGraceMs);
      if (useProcessGroup) {
        void waitForProcessGroupExit(killGraceMs).then((drained) => {
          if (!drained || !waitingForKillGrace) {
            return;
          }
          waitingForKillGrace = false;
          if (killTimer) {
            clearTimeout(killTimer);
            killTimer = undefined;
          }
          if (childClosedResult) {
            finishClose(childClosedResult);
          }
        });
      }
    };
    const requestStop = () => {
      signalChild("SIGTERM");
      scheduleKill();
    };
    options.signal?.addEventListener("abort", abortListener, { once: true });
    if (options.signal?.aborted) {
      abortListener();
    }
    const failOutputStream = (streamName: "stdout" | "stderr", error: Error) => {
      // Keep the first stop cause: killing for a timeout or output cap can make
      // the stdio pipes fail secondarily while the child is shutting down.
      if (terminalFailure) {
        return;
      }
      fail("stream-error", `${streamName} read error: ${error.message}`, error);
      requestStop();
    };
    const timeout = setTimeout(() => {
      fail("timeout", `timed out after ${options.timeoutMs}ms`);
      requestStop();
    }, options.timeoutMs);
    timeout.unref();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (terminalFailure) {
        return;
      }
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > maxOutputBytes) {
        fail("output-limit", `output exceeded ${maxOutputBytes} bytes`);
        requestStop();
        return;
      }
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (terminalFailure) {
        return;
      }
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > maxOutputBytes) {
        fail("output-limit", `output exceeded ${maxOutputBytes} bytes`);
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
      const failure = fail(
        "spawn-error",
        error instanceof Error ? error.message : String(error),
        error,
      );
      settle(() => {
        reject(failure);
      });
    });
    child.once("close", (code, signal) => {
      const result = { code, signal };
      if (code !== 0 && !terminalFailure) {
        fail("nonzero-exit", stderr.trim() || (signal ? `terminated by ${signal}` : ""));
      }
      if (processGroupIsAlive()) {
        childClosedResult = result;
        if (!waitingForKillGrace && !forceKillInFlight) {
          requestStop();
        }
        return;
      }
      finishClose(result);
    });
  });
}

async function renderBundledRootHelpText(
  _distDirOverride: string = distDir,
  renderContext?: RootHelpRenderContext,
  taskContext?: RenderTaskContext,
): Promise<string> {
  if (!renderContext) {
    const bundledPluginsDir = existsSync(path.join(_distDirOverride, "extensions"))
      ? path.join(_distDirOverride, "extensions")
      : extensionsDir;
    return await withIsolatedRootHelpRenderContext(
      bundledPluginsDir,
      async (context) => await renderBundledRootHelpText(_distDirOverride, context, taskContext),
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
    onTerminalFailure: taskContext?.reportFailure,
    signal: taskContext?.signal,
    timeoutMs: ROOT_HELP_RENDER_TIMEOUT_MS,
  });
}

async function renderSourceRootHelpText(
  renderContext?: RootHelpRenderContext,
  taskContext?: RenderTaskContext,
): Promise<string> {
  if (!renderContext) {
    return await withIsolatedRootHelpRenderContext(
      extensionsDir,
      async (context) => await renderSourceRootHelpText(context, taskContext),
    );
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
  return await spawnText(["--import", "tsx", "--input-type=module", "--eval", inlineModule], {
    cwd: rootDir,
    env: renderContext.env ?? process.env,
    failureMessage: "Failed to render source root help",
    onTerminalFailure: taskContext?.reportFailure,
    signal: taskContext?.signal,
    timeoutMs: ROOT_HELP_RENDER_TIMEOUT_MS,
  });
}

async function renderSourceBrowserHelpText(
  renderContext: RootHelpRenderContext,
  taskContext?: RenderTaskContext,
): Promise<string> {
  // The launcher CLI boot renders byte-identical browser help to a direct
  // tsx source render (registerBrowserCli + configureProgramHelp) while
  // avoiding a tsx evaluation of the whole browser CLI import graph, which
  // dominated this script's wall time.
  return await renderSourceCommandHelpText("browser", renderContext, taskContext);
}

async function renderSourceCommandHelpText(
  command: SourceCommandHelpCommand,
  renderContext: RootHelpRenderContext,
  taskContext?: RenderTaskContext,
): Promise<string> {
  return await spawnText(["openclaw.mjs", command, "--help"], {
    cwd: rootDir,
    env: {
      ...renderContext.env,
      OPENCLAW_DISABLE_CLI_STARTUP_HELP_FAST_PATH: "1",
    },
    failureMessage: `Failed to render source ${command} help`,
    onTerminalFailure: taskContext?.reportFailure,
    signal: taskContext?.signal,
    timeoutMs: COMMAND_HELP_RENDER_TIMEOUT_MS,
  });
}

async function renderSourceSecretsHelpText(
  renderContext: RootHelpRenderContext,
  taskContext?: RenderTaskContext,
): Promise<string> {
  return await renderSourceCommandHelpText("secrets", renderContext, taskContext);
}

async function renderSourceNodesHelpText(
  renderContext: RootHelpRenderContext,
  taskContext?: RenderTaskContext,
): Promise<string> {
  return await renderSourceCommandHelpText("nodes", renderContext, taskContext);
}

async function renderSourceCommandHelpTextRecord(
  commands: readonly SourceCommandHelpCommand[],
  renderContext: RootHelpRenderContext,
  supervisor: CliStartupMetadataRenderSupervisor,
): Promise<SourceCommandHelpText> {
  const helpTexts: Partial<Record<SourceCommandHelpCommand, string>> = {};
  await pMap(
    commands,
    async (commandName) => {
      if (supervisor.signal.aborted) {
        return;
      }
      try {
        helpTexts[commandName] = await supervisor.run(async (taskContext) =>
          renderSourceCommandHelpText(commandName, renderContext, taskContext),
        );
      } catch {
        // Keep the mapper fulfilled so p-map waits for every active process-tree drain.
      }
    },
    {
      concurrency: COMMAND_HELP_RENDER_CONCURRENCY,
      stopOnError: false,
    },
  );
  if (supervisor.signal.aborted) {
    throw supervisor.firstFailure ?? supervisor.signal.reason;
  }
  return helpTexts as SourceCommandHelpText;
}

async function renderSourceSubcommandHelpTextRecord(
  renderContext: RootHelpRenderContext,
  supervisor: CliStartupMetadataRenderSupervisor,
): Promise<PrecomputedSubcommandHelpText> {
  const commandHelpText = await renderSourceCommandHelpTextRecord(
    PRECOMPUTED_SUBCOMMAND_HELP_COMMANDS,
    renderContext,
    supervisor,
  );
  return Object.fromEntries(
    PRECOMPUTED_SUBCOMMAND_HELP_COMMANDS.map((commandName) => [
      commandName,
      commandHelpText[commandName],
    ]),
  ) as PrecomputedSubcommandHelpText;
}

async function writeCliStartupMetadata(options?: {
  distDir?: string;
  outputPath?: string;
  extensionsDir?: string;
  sourceRootDir?: string;
  renderBundledRootHelpText?: typeof renderBundledRootHelpText;
  renderSourceRootHelpText?: SourceHelpRenderer;
  renderSourceBrowserHelpText?: SourceHelpRenderer;
  renderSourceSecretsHelpText?: SourceHelpRenderer;
  renderSourceNodesHelpText?: SourceHelpRenderer;
  renderSourceSubcommandHelpTextRecord?: SourceHelpRenderer<PrecomputedSubcommandHelpText>;
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
  const supervisor = new CliStartupMetadataRenderSupervisor();
  const rootHelpTextPromise = reusableRootHelpText
    ? Promise.resolve(reusableRootHelpText)
    : supervisor.run(async (taskContext) =>
        bundleIdentity
          ? (options?.renderBundledRootHelpText ?? renderBundledRootHelpText)(
              resolvedDistDir,
              renderContext,
              taskContext,
            )
          : // Missing built metadata is the only source-fallback contract. A built
            // renderer failure is terminal and must cancel the whole render group.
            (options?.renderSourceRootHelpText ?? renderSourceRootHelpText)(
              renderContext,
              taskContext,
            ),
      );
  // Root help traverses the plugin metadata graph too; finish it before command
  // fan-out so sibling cold boots cannot starve its bounded render.
  const afterRootHelp = <T>(render: () => Awaitable<T>) => rootHelpTextPromise.then(render);
  const runSourceRenderer = <T>(render: SourceHelpRenderer<T>) =>
    afterRootHelp(() => supervisor.run((taskContext) => render(renderContext, taskContext)));
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
      : afterRootHelp(() =>
          renderSourceCommandHelpTextRecord(sourceCommandsToRender, renderContext, supervisor),
        );
  const browserHelpTextPromise = reusableBrowserHelpText
    ? Promise.resolve(reusableBrowserHelpText)
    : commandHelpTextPromise
      ? commandHelpTextPromise.then((commandHelpText) => commandHelpText.browser)
      : runSourceRenderer(options?.renderSourceBrowserHelpText ?? renderSourceBrowserHelpText);
  const secretsHelpTextPromise = reusableSecretsHelpText
    ? Promise.resolve(reusableSecretsHelpText)
    : commandHelpTextPromise
      ? commandHelpTextPromise.then((commandHelpText) => commandHelpText.secrets)
      : runSourceRenderer(options?.renderSourceSecretsHelpText ?? renderSourceSecretsHelpText);
  const nodesHelpTextPromise = reusableNodesHelpText
    ? Promise.resolve(reusableNodesHelpText)
    : commandHelpTextPromise
      ? commandHelpTextPromise.then((commandHelpText) => commandHelpText.nodes)
      : runSourceRenderer(options?.renderSourceNodesHelpText ?? renderSourceNodesHelpText);
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
      : options?.renderSourceSubcommandHelpTextRecord
        ? runSourceRenderer(options.renderSourceSubcommandHelpTextRecord)
        : afterRootHelp(() => renderSourceSubcommandHelpTextRecord(renderContext, supervisor));
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
      supervisor,
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
  spawnText,
  writeCliStartupMetadata,
};

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  await writeCliStartupMetadata();
}

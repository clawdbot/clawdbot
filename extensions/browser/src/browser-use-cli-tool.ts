import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import type { AnyAgentTool } from "openclaw/plugin-sdk/core";
import { resolveNodeHostExecutable } from "openclaw/plugin-sdk/node-host";
import {
  runCommandWithTimeout,
  type CommandOptions,
  type SpawnResult,
} from "openclaw/plugin-sdk/process-runtime";
import {
  ensureManagedBrowserHarness,
  resolveManagedBrowserHarnessPaths,
  type ManagedBrowserUseCliRuntime,
} from "./browser-use-cli-install.js";
import {
  BrowserUseCliToolSchema,
  describeBrowserUseCliTool,
} from "./browser-use-cli-tool.schema.js";
import { writeExternalFileWithinOutputRoot } from "./browser/output-files.js";
import { resolvePreferredOpenClawTmpDir } from "./infra/tmp-openclaw-dir.js";
import { imageResultFromFile } from "./sdk-setup-tools.js";

const DEFAULT_TIMEOUT_SECONDS = 120;
const PREFLIGHT_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_OUTPUT_CHARS = 30_000;
const OUTPUT_HEAD_CHARS = 22_000;
const OUTPUT_TAIL_CHARS = 6_000;
const DAEMON_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MINIMUM_BROWSER_HARNESS_VERSION = [0, 1, 10] as const;

type RunCommand = (argv: string[], options: CommandOptions) => Promise<SpawnResult>;

export type BrowserUseCliRuntime =
  | ManagedBrowserUseCliRuntime
  | {
      kind: "orchestrator";
      executable: string;
      runtimeDir: string;
      daemonName: string;
      pathEnv: string;
      lang: string;
    };

function copySelectedEnv(
  target: Record<string, string>,
  source: NodeJS.ProcessEnv,
  keys: string[],
) {
  for (const key of keys) {
    const value = source[key];
    if (value) {
      target[key] = value;
    }
  }
}

function parseVersion(value: string): readonly [number, number, number] | undefined {
  const match = /(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(value.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function isSupportedVersion(version: readonly [number, number, number]): boolean {
  for (let index = 0; index < MINIMUM_BROWSER_HARNESS_VERSION.length; index += 1) {
    const actual = version[index] ?? 0;
    const minimum = MINIMUM_BROWSER_HARNESS_VERSION[index] ?? 0;
    if (actual !== minimum) {
      return actual > minimum;
    }
  }
  return true;
}

function buildHarnessEnv(params: {
  runtime: BrowserUseCliRuntime;
  workspaceDir: string;
  homeDir: string;
  tmpDir: string;
}): Record<string, string> {
  const env: Record<string, string> = {
    PATH: params.runtime.pathEnv,
    LANG: params.runtime.lang,
    HOME: params.homeDir,
    USERPROFILE: params.homeDir,
    BH_HOME: params.homeDir,
    BH_CONFIG_DIR: params.homeDir,
    BH_AUTH_PATH: path.join(params.homeDir, "auth.json"),
    BH_RUNTIME_DIR: params.runtime.runtimeDir,
    BH_TMP_DIR: params.tmpDir,
    BH_AGENT_WORKSPACE: params.workspaceDir,
    BU_NAME: params.runtime.daemonName,
    BH_TELEMETRY: "0",
    BROWSER_HARNESS_TELEMETRY: "0",
    ANONYMIZED_TELEMETRY: "0",
    BH_RECORD: "0",
    BH_OPEN_LIVE_URL: "0",
  };
  if (params.runtime.kind === "orchestrator") {
    env.BH_REQUIRE_EXISTING_DAEMON = "1";
  }
  copySelectedEnv(env, process.env, [
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "TMP",
    "TEMP",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
    "BH_CHROME_PATH",
    "CHROME_PATH",
    "BU_CDP_URL",
    "BU_CDP_WS",
  ]);
  return env;
}

/** Resolve the orchestrator's exact Browser Harness binary without blocking tool assembly. */
export function prepareBrowserUseCliRuntime(
  params: { env?: NodeJS.ProcessEnv } = {},
): BrowserUseCliRuntime | undefined {
  const env = params.env ?? process.env;
  const runtimeDir = env.BH_RUNTIME_DIR?.trim();
  const daemonName = env.BU_NAME?.trim();
  if (
    !runtimeDir ||
    !path.isAbsolute(runtimeDir) ||
    !daemonName ||
    !DAEMON_NAME_PATTERN.test(daemonName)
  ) {
    return undefined;
  }
  const pathEnv = env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  const resolved = resolveNodeHostExecutable("browser-harness", {
    env,
    pathEnv,
    strategy: "direct",
  });
  if (!resolved) {
    return undefined;
  }
  let executable: string;
  try {
    executable = realpathSync(resolved.executable);
  } catch {
    return undefined;
  }
  const runtime: BrowserUseCliRuntime = {
    kind: "orchestrator",
    executable,
    pathEnv: resolved.pathEnv ?? pathEnv,
    lang: env.LANG ?? "C.UTF-8",
    runtimeDir,
    daemonName,
  };
  return runtime;
}

function pythonStringLiteral(value: string): string {
  return JSON.stringify(value);
}

function capOutput(value: string): string {
  if (value.length <= MAX_OUTPUT_CHARS) {
    return value;
  }
  const omitted = value.length - OUTPUT_HEAD_CHARS - OUTPUT_TAIL_CHARS;
  return `${value.slice(0, OUTPUT_HEAD_CHARS)}\n...[${omitted} chars truncated]...\n${value.slice(-OUTPUT_TAIL_CHARS)}`;
}

function textResult(text: string, details: Record<string, unknown>): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details };
}

function readInput(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

function readTimeoutSeconds(value: unknown): number {
  if (value === undefined) {
    return DEFAULT_TIMEOUT_SECONDS;
  }
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 900) {
    throw new Error("timeoutSeconds must be an integer between 1 and 900");
  }
  return Number(value);
}

function normalizeCommandResult(
  action: string,
  result: SpawnResult,
  durationMs: number,
): AgentToolResult<unknown> {
  const failed = result.code !== 0 || result.termination !== "exit";
  const output = failed
    ? [result.stdout, result.stderr].filter((value) => value.trim()).join("\n")
    : result.stdout;
  const text = output.trim()
    ? capOutput(output)
    : failed
      ? "Browser call failed without diagnostic output."
      : "(no output — print(...) values you need)";
  return textResult(text, {
    action,
    status: failed ? "failed" : "completed",
    exitCode: result.code,
    ...(result.signal ? { exitSignal: result.signal } : {}),
    durationMs,
    timedOut: result.termination === "timeout",
    noOutputTimedOut: result.termination === "no-output-timeout",
  });
}

function isFailedCommandResult(result: AgentToolResult<unknown> | undefined): boolean {
  return Boolean(
    result?.details &&
    typeof result.details === "object" &&
    Reflect.get(result.details, "status") === "failed",
  );
}

export function createBrowserUseCliTool(opts: {
  runtime: BrowserUseCliRuntime;
  workspaceDir: string;
  runCommand?: RunCommand;
  ensureManaged?: typeof ensureManagedBrowserHarness;
}): AnyAgentTool {
  const runCommand = opts.runCommand ?? runCommandWithTimeout;
  const ensureManaged = opts.ensureManaged ?? ensureManagedBrowserHarness;
  let orchestratorVersionCheck: Promise<string | undefined> | undefined;
  const verifyOrchestratorVersion = async (
    executable: string,
    env: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<string | undefined> => {
    if (opts.runtime.kind !== "orchestrator") {
      return undefined;
    }
    orchestratorVersionCheck ??= (async () => {
      const result = await runCommand([executable, "--version"], {
        cwd: opts.workspaceDir,
        baseEnv: {},
        env,
        timeoutMs: PREFLIGHT_TIMEOUT_MS,
        signal,
        killProcessTree: true,
        maxOutputBytes: MAX_OUTPUT_BYTES,
      });
      const parsed =
        result.code === 0 && result.termination === "exit"
          ? parseVersion(result.stdout)
          : undefined;
      return parsed && isSupportedVersion(parsed)
        ? undefined
        : `Browser Harness ${MINIMUM_BROWSER_HARNESS_VERSION.join(".")} or newer is required.`;
    })();
    const failure = await orchestratorVersionCheck;
    if (failure) {
      orchestratorVersionCheck = undefined;
    }
    return failure;
  };
  const run = async (
    action: string,
    params: { args?: string[]; code?: string; timeoutSeconds: number },
    signal?: AbortSignal,
  ): Promise<AgentToolResult<unknown>> => {
    const executable =
      opts.runtime.kind === "managed"
        ? await ensureManaged({ stateDir: opts.runtime.stateDir })
        : opts.runtime.executable;
    const paths =
      opts.runtime.kind === "managed"
        ? resolveManagedBrowserHarnessPaths(opts.runtime.stateDir)
        : undefined;
    const ephemeralRoot = paths
      ? undefined
      : await mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "oc-bh-cli-"));
    const homeDir = paths?.homeDir ?? path.join(ephemeralRoot!, "home");
    const tmpDir = paths?.tmpDir ?? path.join(ephemeralRoot!, "tmp");
    try {
      await Promise.all([
        mkdir(homeDir, { recursive: true, mode: 0o700 }),
        mkdir(tmpDir, { recursive: true, mode: 0o700 }),
        mkdir(opts.runtime.runtimeDir, { recursive: true, mode: 0o700 }),
      ]);
      const env = buildHarnessEnv({
        runtime: opts.runtime,
        workspaceDir: opts.workspaceDir,
        homeDir,
        tmpDir,
      });
      const versionFailure = await verifyOrchestratorVersion(executable, env, signal);
      if (versionFailure) {
        return textResult(versionFailure, { action, status: "failed", version: "unsupported" });
      }
      const startedAt = Date.now();
      const result = await runCommand([executable, ...(params.args ?? [])], {
        cwd: opts.workspaceDir,
        ...(params.code === undefined ? {} : { input: `${params.code}\n` }),
        baseEnv: {},
        env,
        timeoutMs: params.timeoutSeconds * 1_000,
        signal,
        killProcessTree: true,
        maxOutputBytes: MAX_OUTPUT_BYTES,
      });
      if (signal?.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new Error("Browser call aborted", { cause: signal.reason });
      }
      return normalizeCommandResult(action, result, Date.now() - startedAt);
    } finally {
      if (ephemeralRoot) {
        await rm(ephemeralRoot, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  };

  return {
    label: "Browser",
    name: "browser",
    resultContentSource: "network",
    description: describeBrowserUseCliTool({
      orchestratorOwned: opts.runtime.kind === "orchestrator",
    }),
    parameters: BrowserUseCliToolSchema,
    execute: async (toolCallId, args, signal) => {
      const input = readInput(args);
      const action = typeof input.action === "string" ? input.action : "";
      const timeoutSeconds = readTimeoutSeconds(input.timeoutSeconds);
      if (action === "status" || action === "start") {
        const probe = await run(action, { code: "list_tabs()", timeoutSeconds }, signal);
        if (isFailedCommandResult(probe)) {
          return probe;
        }
        return textResult(
          opts.runtime.kind === "orchestrator"
            ? "Browser Use Cloud is ready. The run orchestrator owns this persistent browser and its cleanup."
            : "Browser Harness is ready. Its normal daemon will be reused across browser calls.",
          { action, orchestratorOwned: opts.runtime.kind === "orchestrator" },
        );
      }
      if (action === "stop") {
        if (opts.runtime.kind === "orchestrator") {
          return textResult(
            "Browser cleanup remains with the run orchestrator and will happen automatically.",
            { action, orchestratorOwned: true },
          );
        }
        return await run(action, { args: ["--reload"], timeoutSeconds }, signal);
      }
      if (action === "open") {
        const url = typeof input.url === "string" ? input.url.trim() : "";
        if (!url) {
          return textResult("action=open requires url.", { action, error: "missing_url" });
        }
        return await run(
          action,
          {
            code: `new_tab(${pythonStringLiteral(url)})\nwait_for_load()\nprint(page_info())`,
            timeoutSeconds,
          },
          signal,
        );
      }
      if (action === "exec") {
        const code = typeof input.code === "string" ? input.code : "";
        if (!code.trim()) {
          return textResult("action=exec requires code.", { action, error: "missing_code" });
        }
        return await run(action, { code, timeoutSeconds }, signal);
      }
      if (action === "screenshot") {
        const screenshotDir = path.join(opts.workspaceDir, ".openclaw", "browser");
        const screenshotPath = path.join(
          screenshotDir,
          `screenshot-${createHash("sha256").update(toolCallId).digest("hex").slice(0, 16)}.png`,
        );
        const fullPage = input.fullPage === true;
        let captureResult: AgentToolResult<unknown> | undefined;
        try {
          const result = await writeExternalFileWithinOutputRoot({
            rootDir: screenshotDir,
            path: screenshotPath,
            write: async (safePath) => {
              captureResult = await run(
                action,
                {
                  code: `capture_screenshot(${pythonStringLiteral(safePath)}, full=${fullPage ? "True" : "False"})`,
                  timeoutSeconds,
                },
                signal,
              );
            },
          });
          if (captureResult && isFailedCommandResult(captureResult)) {
            return captureResult;
          }
          return await imageResultFromFile({
            label: "browser screenshot",
            path: result,
            details: {
              action,
              orchestratorOwned: opts.runtime.kind === "orchestrator",
              media: { outbound: false },
            },
          });
        } catch {
          if (signal?.aborted) {
            throw signal.reason instanceof Error
              ? signal.reason
              : new Error("Browser screenshot aborted", { cause: signal.reason });
          }
          return textResult(
            "The browser screenshot failed. Inspect the page with action=exec, then retry screenshot.",
            { action, screenshot: "failed" },
          );
        }
      }
      return textResult(
        `Unknown action ${JSON.stringify(action)}. Use one of: status, start, stop, open, screenshot, exec.`,
        { action, error: "unknown_action" },
      );
    },
  };
}

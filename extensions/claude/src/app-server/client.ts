/**
 * JSON-RPC 2.0 client over a stdio child process — talks to the
 * @zeroaltitude/openclaw-claude-bridge binary. Bidirectional: the server can send
 * REQUESTS to us (`item/tool/call`, approval requests) which we route to
 * registered handlers.
 *
 * A single shared client is kept per host process so multiple turns share
 * one server (cheaper than spawn-per-turn). `clearSharedClaudeAppServerClient`
 * is called from the harness `dispose` hook on plugin teardown.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { sanitizeHostExecEnvWithDiagnostics } from "openclaw/plugin-sdk/host-env-security";
import {
  materializeWindowsSpawnProgram,
  resolveWindowsSpawnProgram,
} from "openclaw/plugin-sdk/windows-spawn";
import {
  CLAUDE_BRIDGE_BIN_ENV,
  DEFAULT_CLAUDE_BRIDGE_COMMAND,
  type ClaudeBridgeCommandSource,
} from "./config.js";
import type { JsonValue, RpcMessage, RpcNotification, RpcRequest, RpcResponse } from "./types.js";
import {
  compareClaudeBridgeVersions,
  MANAGED_CLAUDE_BRIDGE_PACKAGE,
  MIN_CLAUDE_BRIDGE_VERSION,
} from "./version.js";

export { MIN_CLAUDE_BRIDGE_VERSION } from "./version.js";

/**
 * Builds the spawn env for the local bridge binary. The inherited host env and
 * the config-derived overrides (`appServer.env` from workspace config) are both
 * routed through OpenClaw's canonical {@link sanitizeHostExecEnvWithDiagnostics}
 * boundary — the same one `bash-tools.exec` and the agent-bundle LSP runtime use
 * — rather than a local prototype-pollution-only denylist. This strips dangerous
 * inherited keys (LD_PRELOAD, DYLD_*, NODE_OPTIONS, …) and rejects config-derived
 * overrides that try to inject those keys or replace PATH, so a workspace config
 * cannot escalate into host code execution via the spawned child. Rejected
 * override keys are logged (never the values) for operator diagnostics.
 *
 * Resolves GHSA-VFW7-6RHC-6XXG (unsanitized env merge passed to child-process
 * spawn).
 */
export function resolveBridgeSpawnEnv(
  baseEnv: NodeJS.ProcessEnv,
  overrides: Record<string, string | undefined> | undefined,
): NodeJS.ProcessEnv {
  // sanitizeHostExecEnv only accepts string-valued overrides; drop unset entries
  // before handing the config-derived map across the boundary.
  const stringOverrides: Record<string, string> = {};
  for (const [k, v] of Object.entries(overrides ?? {})) {
    if (typeof v === "string") {
      stringOverrides[k] = v;
    }
  }
  const result = sanitizeHostExecEnvWithDiagnostics({
    baseEnv,
    overrides: stringOverrides,
    blockPathOverrides: true,
  });
  const rejected = [...result.rejectedOverrideBlockedKeys, ...result.rejectedOverrideInvalidKeys];
  if (rejected.length > 0) {
    embeddedAgentLog.warn("claude-bridge: rejected unsafe appServer.env overrides", {
      keys: rejected,
    });
  }
  return result.env;
}

type ClaudeBridgeSpawnRuntime = {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  execPath: string;
};

/**
 * Resolves the executable/argv used to launch the bridge, routing Windows
 * wrapper shims through OpenClaw's shared {@link resolveWindowsSpawnProgram}
 * boundary — the same one the standalone ACP client uses.
 *
 * On win32 the managed resolver returns `node_modules/.bin/openclaw-claude-bridge.cmd`.
 * Passing that `.cmd` shim directly to `spawn()` fails on patched Node (which
 * rejects raw `.cmd`/`.bat` spawning), so selecting the claude-bridge runtime on
 * Windows would die before the bridge initializes. The resolver materializes the
 * shim down to its real Node/exe entrypoint (or, for an unresolved wrapper, an
 * explicit shell fallback) so the spawn is Windows-safe. On non-win32 platforms
 * the command and argv pass through unchanged.
 *
 * Addresses the Clawsweeper [P2] "route Windows shims through the spawn resolver"
 * finding on extensions/claude/src/app-server/client.ts.
 */
export function resolveClaudeBridgeSpawnInvocation(
  params: { command: string; args: string[] },
  runtime: ClaudeBridgeSpawnRuntime = {
    platform: process.platform,
    env: process.env,
    execPath: process.execPath,
  },
): { command: string; args: string[]; shell?: boolean; windowsHide?: boolean } {
  const program = resolveWindowsSpawnProgram({
    command: params.command,
    platform: runtime.platform,
    env: runtime.env,
    execPath: runtime.execPath,
    packageName: MANAGED_CLAUDE_BRIDGE_PACKAGE,
  });
  const resolved = materializeWindowsSpawnProgram(program, params.args);
  return {
    command: resolved.command,
    args: resolved.argv,
    shell: resolved.shell,
    windowsHide: resolved.windowsHide,
  };
}

export type ClaudeAppServerStartOptions = {
  command?: string;
  args?: string[];
  env?: Record<string, string | undefined>;
  /**
   * Provenance of `command`, threaded from config so the version-floor
   * assertion can give the right remediation (managed reinstall vs. override).
   * Defaults to "managed" when unset.
   */
  commandSource?: ClaudeBridgeCommandSource;
};

export type NotificationHandler = (notification: RpcNotification) => void;

export type ServerRequestHandler = (req: {
  id: number | string;
  method: string;
  params?: JsonValue;
}) => Promise<JsonValue | undefined> | JsonValue | undefined;

type PendingRequest = {
  method: string;
  resolve: (value: JsonValue) => void;
  reject: (error: Error) => void;
};

const DEFAULT_COMMAND = DEFAULT_CLAUDE_BRIDGE_COMMAND;
const FORCE_KILL_DELAY_MS = 2_000;
const REQUEST_TIMEOUT_MS = 600_000;
const STDERR_TAIL_MAX = 2_000;
const INIT_TIMEOUT_MS = 30_000;

export class ClaudeAppServerRpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: JsonValue,
    readonly method?: string,
  ) {
    super(message);
    this.name = "ClaudeAppServerRpcError";
  }
}

/**
 * Thrown when the spawned bridge reports a version below
 * MIN_CLAUDE_BRIDGE_VERSION. Surfaced as the turn's promptError with an
 * actionable upgrade command rather than degrading to a misleading
 * "model idle timeout" (the silent-skew failure this guard prevents).
 */
export class ClaudeAppServerVersionError extends Error {
  constructor(
    message: string,
    readonly detectedVersion: string | undefined,
    readonly requiredVersion: string,
  ) {
    super(message);
    this.name = "ClaudeAppServerVersionError";
  }
}

/**
 * Maps a bridge stderr line onto the host log level it deserves.
 *
 * The bridge writes every stderr line through its own leveled formatter, which
 * prefixes the severity it chose (`[debug] …`, `[info] …`, `[warn] …`,
 * `[error] …`). Funnelling all of that into `embeddedAgentLog.debug` discarded
 * that severity, so at the default log level the journal contained none of the
 * bridge's operational warnings — most consequentially the `[attempt-registry]`
 * WARN that fires when an attempt is discarded with no turn awaiting its result,
 * i.e. when work a previous turn backgrounded was silently killed along with the
 * subprocess. That kill was real and invisible at the same time.
 *
 * Only `warn`/`error` are promoted. The bridge's `info` tier is per-RPC
 * bookkeeping (`[turn/start] received`, `[thread/read] read`, …) that fires
 * several times per turn, so it stays at debug along with everything carrying no
 * recognized prefix.
 */
export function classifyBridgeStderrLevel(line: string): "debug" | "warn" | "error" {
  const prefix = /^\[(warn|error)\]\s/.exec(line.trimStart())?.[1];
  return prefix === "warn" || prefix === "error" ? prefix : "debug";
}

export class ClaudeAppServerClient {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private notificationHandlers: NotificationHandler[] = [];
  private serverRequestHandlers: ServerRequestHandler[] = [];
  private stopped = false;
  private initializePromise: Promise<JsonValue> | null = null;
  private initialized = false;
  private stderrRl: ReadlineInterface | null = null;
  private stdoutRl: ReadlineInterface | null = null;
  private stderrTail = "";
  private serverInfo: { name?: string; version?: string } | null = null;
  // Fired when the child exits/crashes or is stopped. Pending RPCs are rejected
  // via rejectAll, but a turn is driven by server->client notifications inside a
  // plain Promise that holds NO pending RPC — without this, a dead bridge leaves
  // every in-flight turn to hit the run-attempt idle watchdog (90s) and surface
  // the misleading "model idle timeout" instead of the real exit cause.
  private exitListeners = new Set<(error: Error) => void>();

  constructor(private readonly opts: ClaudeAppServerStartOptions) {}

  async start(): Promise<void> {
    if (this.initializePromise) {
      await this.initializePromise;
      return;
    }
    this.stopped = false;
    this.initialized = false;
    this.stderrTail = "";

    const command = this.opts.command ?? DEFAULT_COMMAND;
    const args = this.opts.args ?? [];
    const env = resolveBridgeSpawnEnv(process.env, this.opts.env);
    // Route the (possibly Windows .cmd shim) command through the shared spawn
    // resolver before launch. PATH/PATHEXT lookup must see the same sanitized env
    // the child will run with, so resolve against `env` rather than process.env.
    const invocation = resolveClaudeBridgeSpawnInvocation(
      { command, args },
      { platform: process.platform, env, execPath: process.execPath },
    );

    this.child = spawn(invocation.command, invocation.args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      shell: invocation.shell,
      windowsHide: invocation.windowsHide,
    });

    embeddedAgentLog.info("claude-bridge: spawned", {
      pid: this.child.pid,
      command: invocation.command,
    });

    this.stderrRl = createInterface({ input: this.child.stderr! });
    this.stderrRl.on("line", (line) => {
      if (!line.trim()) {
        return;
      }
      this.stderrTail = appendBoundedTail(this.stderrTail, `${line}\n`, STDERR_TAIL_MAX);
      embeddedAgentLog[classifyBridgeStderrLevel(line)](`claude-bridge stderr: ${line}`);
    });

    this.stdoutRl = createInterface({ input: this.child.stdout! });
    this.stdoutRl.on("line", (line) => this.onLine(line));

    this.child.once("exit", (code, signal) => {
      embeddedAgentLog.warn("claude-bridge: process exited", { code, signal });
      const suffix = this.stderrTail
        ? ` stderr=${JSON.stringify(this.stderrTail.slice(-STDERR_TAIL_MAX))}`
        : "";
      this.handleChildExit(
        new Error(
          `openclaw-claude-bridge exited (code=${formatExitValue(code)} signal=${formatExitValue(signal)})${suffix}`,
        ),
      );
    });
    this.child.stdin?.on("error", (err) => {
      embeddedAgentLog.warn("claude-bridge: stdin error", { error: err.message });
      this.handleChildExit(new Error(`openclaw-claude-bridge stdin error: ${err.message}`));
    });

    this.initializePromise = this.sendRequest<JsonValue>(
      "initialize",
      {
        clientInfo: { name: "openclaw/extensions/claude", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      },
      AbortSignal.timeout(INIT_TIMEOUT_MS),
    ).then((result) => {
      if (result && typeof result === "object" && !Array.isArray(result)) {
        const info = (result as Record<string, unknown>).serverInfo;
        if (info && typeof info === "object" && !Array.isArray(info)) {
          this.serverInfo = info as { name?: string; version?: string };
        }
      }
      // Fail closed on a stale bridge BEFORE marking the client usable. The
      // bridge reports its npm package version in serverInfo.version (the
      // userAgent field carries only the synthetic codex-protocol revision, so
      // it must NOT be used as the floor source). On a miss the outer catch
      // below nulls initializePromise + stop()s the child, so the turn fails
      // with an actionable upgrade command instead of silently running an
      // out-of-contract binary.
      assertSupportedBridgeVersion(this.serverInfo?.version, this.opts.commandSource ?? "managed");
      this.initialized = true;
      embeddedAgentLog.info("claude-bridge: initialized", { server: this.serverInfo });
      return result;
    });

    try {
      await this.initializePromise;
    } catch (err) {
      this.initializePromise = null;
      this.stop();
      throw err;
    }
  }

  getServerInfo(): { name?: string; version?: string } | null {
    return this.serverInfo;
  }

  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    const child = this.child;
    this.child = null;
    this.initialized = false;
    this.initializePromise = null;
    this.closeReaders();
    if (!child) {
      return;
    }
    // Graceful first: close stdin and send SIGTERM to the process group we
    // spawned. SIGKILL only runs after FORCE_KILL_DELAY_MS if the bridge ignores
    // the normal shutdown path.
    child.stdin?.end();
    child.stdin?.destroy();
    try {
      if (child.pid && process.platform !== "win32") {
        process.kill(-child.pid, "SIGTERM");
      } else {
        child.kill("SIGTERM");
      }
    } catch {
      /* ignore */
    }
    const forceKill = setTimeout(() => {
      try {
        if (child.pid && process.platform !== "win32") {
          process.kill(-child.pid, "SIGKILL");
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        /* ignore */
      }
    }, FORCE_KILL_DELAY_MS);
    forceKill.unref?.();
    child.once("exit", () => clearTimeout(forceKill));
    child.unref?.();
    const stoppedError = new Error("claude-bridge stopped");
    this.rejectAll(stoppedError);
    this.fireExit(stoppedError);
  }

  isRunning(): boolean {
    return this.child !== null && !this.stopped;
  }

  /** Number of in-flight RPC requests awaiting a response. */
  pendingRequestCount(): number {
    return this.pending.size;
  }

  /**
   * Whether this client currently has an in-flight turn or compaction. Both
   * `runClaudeAppServerAttempt` (run-attempt.ts) and `acquireSharedCompactionClient`
   * (compact.ts) register exactly one notification handler for the duration of
   * their operation via {@link onNotification} and remove it on every
   * completion path (success, abort, idle timeout, exit) — no other caller in
   * this plugin registers a longer-lived notification handler — so a non-empty
   * `notificationHandlers` list is a reliable "a turn/compaction is running"
   * signal without needing separate begin/end instrumentation. `pending.size`
   * covers the brief request/response windows (e.g. `turn/start`'s ack, or a
   * quick catalog RPC) outside that.
   *
   * Used by the shared pool (`getSharedClaudeAppServerClient`) to decide
   * whether a same-key, different-fingerprint request may safely evict this
   * entry: a busy client must never be torn down out from under its caller
   * (openclaw-9jr).
   */
  isBusy(): boolean {
    return this.notificationHandlers.length > 0 || this.pending.size > 0;
  }

  /** Resolved command path/argv string, for diagnostics. */
  commandDescription(): string {
    const cmd = this.opts.command ?? DEFAULT_COMMAND;
    const args = this.opts.args ?? [];
    return args.length > 0 ? `${cmd} ${args.join(" ")}` : cmd;
  }

  /** Last server-side error message captured from stderr or RPC, if any. */
  lastErrorMessage(): string | undefined {
    return this.stderrTail.length > 0 ? this.stderrTail.slice(-200).trim() : undefined;
  }

  async request<T = JsonValue>(method: string, params?: unknown, signal?: AbortSignal): Promise<T> {
    if (method !== "initialize") {
      if (this.initializePromise) {
        await this.initializePromise.catch(() => {});
      }
      if (!this.initialized) {
        throw new Error("claude-bridge is not initialized");
      }
    }
    return this.sendRequest<T>(method, params, signal);
  }

  notify(method: string, params?: unknown): void {
    this.writeLine(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  onNotification(handler: NotificationHandler): () => void {
    this.notificationHandlers.push(handler);
    return () => {
      this.notificationHandlers = this.notificationHandlers.filter((h) => h !== handler);
    };
  }

  onServerRequest(handler: ServerRequestHandler): () => void {
    this.serverRequestHandlers.push(handler);
    return () => {
      this.serverRequestHandlers = this.serverRequestHandlers.filter((h) => h !== handler);
    };
  }

  /**
   * Subscribe to child exit/stop. Notification-driven turns use this to fail
   * fast with the real exit error rather than waiting out the idle watchdog.
   * Fires at most once per client lifetime (listeners are cleared after firing).
   */
  onExit(listener: (error: Error) => void): () => void {
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }

  private fireExit(error: Error): void {
    if (this.exitListeners.size === 0) {
      return;
    }
    const listeners = [...this.exitListeners];
    this.exitListeners.clear();
    for (const listener of listeners) {
      try {
        listener(error);
      } catch (err) {
        embeddedAgentLog.debug("claude-bridge: exit listener threw", { error: err });
      }
    }
  }

  private async sendRequest<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    if (!this.child) {
      throw new Error("claude-bridge is not running");
    }
    const id = this.nextId++;
    const msg: RpcRequest = { jsonrpc: "2.0", id, method, params };

    const result = await new Promise<JsonValue>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new ClaudeAppServerRpcError(`RPC ${method} timed out`, undefined, undefined, method),
        );
      }, REQUEST_TIMEOUT_MS);
      const onAbort = () => {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(new ClaudeAppServerRpcError(`RPC ${method} aborted`, undefined, undefined, method));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timeout);
          signal?.removeEventListener("abort", onAbort);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      });
      try {
        this.writeLine(JSON.stringify(msg));
      } catch (writeErr) {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        this.pending.delete(id);
        reject(writeErr instanceof Error ? writeErr : new Error(String(writeErr)));
      }
    });
    return result as T;
  }

  private writeLine(line: string): void {
    if (!this.child?.stdin) {
      throw new Error("stdin unavailable — server not running");
    }
    this.child.stdin.write(line + "\n");
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let msg: RpcMessage;
    try {
      msg = JSON.parse(trimmed) as RpcMessage;
    } catch {
      embeddedAgentLog.warn("claude-bridge: unparseable line", {
        preview: trimmed.slice(0, 200),
      });
      return;
    }

    if ("id" in msg && msg.id !== undefined && "method" in msg) {
      void this.handleServerRequest(msg);
      return;
    }
    if ("id" in msg && msg.id !== undefined) {
      const resp = msg as RpcResponse;
      const pending = this.pending.get(resp.id as number);
      if (!pending) {
        embeddedAgentLog.warn("claude-bridge: unexpected response id", { id: resp.id });
        return;
      }
      this.pending.delete(resp.id as number);
      if (resp.error) {
        pending.reject(
          new ClaudeAppServerRpcError(
            resp.error.message || `RPC ${pending.method} failed`,
            resp.error.code,
            resp.error.data,
            pending.method,
          ),
        );
      } else {
        pending.resolve((resp.result ?? null) as JsonValue);
      }
      return;
    }
    if ("method" in msg) {
      const notif = msg as RpcNotification;
      for (const handler of this.notificationHandlers) {
        try {
          handler(notif);
        } catch (err) {
          embeddedAgentLog.warn("claude-bridge: notification handler threw", { error: err });
        }
      }
    }
  }

  private async handleServerRequest(req: RpcRequest): Promise<void> {
    const id = req.id!;
    try {
      for (const handler of this.serverRequestHandlers) {
        const result = await handler({
          id: id as number,
          method: req.method,
          params: req.params as JsonValue | undefined,
        });
        if (result !== undefined) {
          this.writeLine(JSON.stringify({ jsonrpc: "2.0", id, result }));
          return;
        }
      }
      // Default decline so the server doesn't hang waiting forever.
      this.writeLine(
        JSON.stringify({ jsonrpc: "2.0", id, result: defaultServerRequestResponse(req.method) }),
      );
    } catch (err) {
      this.writeLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
        }),
      );
    }
  }

  private handleChildExit(error: Error): void {
    if (this.child === null) {
      return;
    }
    this.rejectAll(error);
    this.closeReaders();
    this.child = null;
    this.initialized = false;
    this.initializePromise = null;
    this.fireExit(error);
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.reject(error);
    }
  }

  private closeReaders(): void {
    this.stderrRl?.close();
    this.stderrRl = null;
    this.stdoutRl?.close();
    this.stdoutRl = null;
  }
}

function defaultServerRequestResponse(method: string): JsonValue {
  if (
    method === "item/commandExecution/requestApproval" ||
    method === "item/fileChange/requestApproval"
  ) {
    return { decision: "decline", reason: "no approval handler registered" };
  }
  if (method === "item/permissions/requestApproval") {
    return { permissions: {}, scope: "turn" };
  }
  if (method === "item/tool/call") {
    return {
      contentItems: [{ type: "inputText", text: "no dynamic-tool handler registered" }],
      success: false,
    };
  }
  return {};
}

function appendBoundedTail(current: string, next: string, maxLength: number): string {
  const combined = current + next;
  return combined.length > maxLength ? combined.slice(combined.length - maxLength) : combined;
}

function formatExitValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  return "unknown";
}

// ─── Version floor assertion ────────────────────────────────────────────────

/**
 * Throw a {@link ClaudeAppServerVersionError} when the spawned bridge is below
 * MIN_CLAUDE_BRIDGE_VERSION. Reads the npm package version (serverInfo.version),
 * never the userAgent (which carries only the synthetic codex-protocol
 * revision). Mirrors codex's assertSupportedCodexAppServerVersion: the managed
 * binary is resolved from the plugin's own node_modules, so an out-of-contract
 * version means the install is stale — the remediation is reinstall + restart,
 * not a runtime respawn.
 */
export function assertSupportedBridgeVersion(
  detectedVersion: string | undefined,
  commandSource: ClaudeBridgeCommandSource,
): void {
  if (compareClaudeBridgeVersions(detectedVersion, MIN_CLAUDE_BRIDGE_VERSION) >= 0) {
    return;
  }
  const reported = detectedVersion ?? "an unknown version";
  const remediation =
    commandSource === "managed"
      ? `Reinstall or update OpenClaw (or run pnpm install in a source checkout) so the bundled ${MANAGED_CLAUDE_BRIDGE_PACKAGE} is >= ${MIN_CLAUDE_BRIDGE_VERSION}, then restart the gateway.`
      : `Update the binary configured via appServer.command / ${CLAUDE_BRIDGE_BIN_ENV} to >= ${MIN_CLAUDE_BRIDGE_VERSION} and restart the gateway, or remove the override to use the managed binary.`;
  throw new ClaudeAppServerVersionError(
    `${MANAGED_CLAUDE_BRIDGE_PACKAGE} >= ${MIN_CLAUDE_BRIDGE_VERSION} is required, but the running bridge reports ${reported}. ${remediation}`,
    detectedVersion,
    MIN_CLAUDE_BRIDGE_VERSION,
  );
}

// ─── Shared client lifecycle ────────────────────────────────────────────────

/**
 * Keyed pool, not a single slot. Two (or more) distinct app-server harness
 * extensions built on this same client (e.g. `extensions/claude` pointed at
 * real Anthropic, `extensions/glm-bridge` pointed at Z.ai) must be able to
 * run their own bridge process concurrently without tearing each other's
 * down.
 *
 * The pool key is CALLER-SUPPLIED (explicit), not derived from spawn options.
 * Explicit keys stay robust even if `extensions/claude` and `extensions/glm-bridge`
 * end up importing this pool from the same compiled module (e.g. after a
 * future `packages/*` extraction) — an implicit spawn-options-derived key
 * would silently collapse two extensions onto one slot if their options ever
 * happened to match, whereas an explicit key names the slot directly and
 * can't drift. Callers should key on the same identity that already governs
 * provider-owned session semantics — e.g. `` `claude-bridge:${modelProvider}` ``
 * — so "same provider identity" and "same pool slot" stay the same question
 * (openclaw-7ss design decision, confirmed by Eddie 2026-07-02).
 *
 * A KEY can hold more than one live entry, distinguished by their spawn-options
 * fingerprint (command/args/env). This matters because the key is provider
 * identity (e.g. "claude-bridge:anthropic"), which every agent talking to that
 * provider shares regardless of which credential resolves for its turn — a
 * Claude setup-token vs a platform API key, or two different platform keys,
 * all fingerprint differently (env is part of the fingerprint) under the
 * identical key. A same-key, different-fingerprint request only tears down
 * and replaces an existing entry when that entry is IDLE
 * ({@link ClaudeAppServerClient.isBusy} false) — this is the cheap
 * "reconfiguration" path a single-slot design always had (operator changed
 * appServer.env/command/args, or the previous credential's work is done). A
 * BUSY entry (an in-flight turn or compaction on a DIFFERENT credential) is
 * left running under its own fingerprint slot instead: before this guard,
 * agent B's turn arriving with a different credential while agent A's turn
 * was still in flight would call agent A's `client.stop()` — killing A's live
 * subprocess and rejecting its pending work with "claude-bridge stopped" /
 * "claude-bridge is not initialized", even though nothing about A's turn had
 * actually failed (openclaw-9jr).
 *
 * A same-key, SAME-fingerprint request against a busy entry still reuses it
 * (multiple turns for the identical credential correctly keep sharing one
 * process, unchanged from before).
 */
type SharedClientPoolEntry = { client: ClaudeAppServerClient; optsFingerprint: string };
// key -> fingerprint -> entry. Most keys hold exactly one live fingerprint;
// more than one arises only when distinct credentials are concurrently active
// for the same provider identity (see doc above, openclaw-9jr).
const sharedClients = new Map<string, Map<string, SharedClientPoolEntry>>();
let lastAccessed: { key: string; fingerprint: string } | null = null;

function computeOptsFingerprint(
  opts: Pick<ClaudeAppServerStartOptions, "command" | "args" | "env">,
): string {
  return JSON.stringify({
    command: opts.command ?? DEFAULT_COMMAND,
    args: opts.args ?? [],
    env: opts.env ?? null,
  });
}

export function getSharedClaudeAppServerClient(
  key: string,
  opts: ClaudeAppServerStartOptions,
): ClaudeAppServerClient {
  const fingerprint = computeOptsFingerprint(opts);
  let entries = sharedClients.get(key);
  if (!entries) {
    entries = new Map();
    sharedClients.set(key, entries);
  }

  const exact = entries.get(fingerprint);
  if (exact && exact.client.isRunning()) {
    lastAccessed = { key, fingerprint };
    return exact.client;
  }

  // No running entry for this exact fingerprint. Clear out any OTHER
  // fingerprint at this key that isn't both running AND busy — busy entries
  // belong to a different concurrently-active credential and must be left
  // alone (see doc comment above, openclaw-9jr).
  for (const [fp, entry] of entries) {
    if (fp === fingerprint) {
      continue;
    }
    if (entry.client.isRunning() && entry.client.isBusy()) {
      continue;
    }
    try {
      entry.client.stop();
    } catch {
      /* ignore */
    }
    entries.delete(fp);
  }

  const client = new ClaudeAppServerClient(opts);
  entries.set(fingerprint, { client, optsFingerprint: fingerprint });
  lastAccessed = { key, fingerprint };
  return client;
}

/** Stop and remove one pool slot by key (every credential entry under it), or every slot when `key` is omitted. */
export async function clearSharedClaudeAppServerClient(key?: string): Promise<void> {
  if (key !== undefined) {
    const entries = sharedClients.get(key);
    if (!entries) {
      return;
    }
    for (const entry of entries.values()) {
      try {
        entry.client.stop();
      } catch {
        /* ignore */
      }
    }
    sharedClients.delete(key);
    if (lastAccessed?.key === key) {
      lastAccessed = null;
    }
    return;
  }
  for (const entries of sharedClients.values()) {
    for (const entry of entries.values()) {
      try {
        entry.client.stop();
      } catch {
        /* ignore */
      }
    }
  }
  sharedClients.clear();
  lastAccessed = null;
}

/**
 * Return a read-only snapshot of a shared client's state WITHOUT forcing
 * creation. Used by /claude status so the command stays cheap when no turn has
 * run yet.
 *
 * Pass an explicit pool `key` (e.g. `claudeAppServerPoolKey("anthropic")`) to
 * peek at THAT extension's own bridge — the correct behavior for an
 * extension-scoped command like /claude status|version, which must report the
 * Claude extension's process, not whichever bridge ran a turn most recently.
 *
 * With `key` omitted the snapshot falls back to the most recently accessed
 * (key, fingerprint) pair (`lastAccessed`) — exact for the common
 * single-extension, single-credential case, but with two concurrently-active
 * harness extensions (openclaw-7ss) or two concurrently-active credentials
 * under one key (openclaw-9jr) it reflects whichever ran a turn most recently
 * rather than a specific one (the ambiguity that motivated the keyed variant,
 * GLM review G7). A keyed peek against a key holding multiple live credential
 * entries resolves the same way: the most-recently-accessed entry under that
 * key, or an arbitrary one if none of that key's entries were the globally
 * most-recent access.
 */
export function peekSharedClaudeAppServerClient(key?: string): {
  running: boolean;
  command?: string;
  pendingRequests: number;
  lastError?: string;
  runningVersion?: string;
} | null {
  const lookupKey = key ?? lastAccessed?.key;
  if (!lookupKey) {
    return null;
  }
  const entries = sharedClients.get(lookupKey);
  if (!entries || entries.size === 0) {
    return null;
  }
  const values = [...entries.values()];
  const entry =
    (lastAccessed?.key === lookupKey ? entries.get(lastAccessed.fingerprint) : undefined) ??
    values[values.length - 1] ??
    values[0];
  if (!entry) {
    return null;
  }
  return {
    running: entry.client.isRunning(),
    pendingRequests: entry.client.pendingRequestCount(),
    command: entry.client.commandDescription(),
    lastError: entry.client.lastErrorMessage(),
    runningVersion: entry.client.getServerInfo()?.version,
  };
}

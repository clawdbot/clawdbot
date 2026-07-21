import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  type StdioServerParameters,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

// cua-driver is prerelease upstream; pin the exact minor contract until it stabilizes.
const SUPPORTED_DRIVER_VERSION_PREFIX = "0.10.";
const BINARY_CACHE_MS = 1_000;
// Cumulative ~9.75s of daemon readiness polling after spawning `serve`.
const DAEMON_READY_BACKOFF_MS = [250, 500, 1_000, 2_000, 3_000, 3_000] as const;
// How long an unsupported-version verdict suppresses re-probes. Bounded so that
// installing the right driver or restarting an incompatible daemon recovers
// without a node restart, while a persistently-wrong driver is not re-probed on
// every call.
const UNSUPPORTED_REPROBE_MS = 30_000;

type CuaToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | Record<string, unknown>;

export type CuaToolResult = {
  content: CuaToolContent[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};

export interface CuaDriver {
  readonly generation: number;
  isAvailable(): boolean;
  resetAvailabilityCache(): void;
  callTool(name: string, args: Record<string, unknown>): Promise<CuaToolResult>;
  dispose(): Promise<void>;
}

type McpClientLike = {
  connect(transport: Transport): Promise<void>;
  getServerVersion(): { name: string; version: string } | undefined;
  listTools(): Promise<unknown>;
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<unknown>;
  close(): Promise<void>;
};

type CuaDriverClientOptions = {
  driverPath?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  now?: () => number;
  access?: (filePath: string, mode: number) => void;
  spawn?: typeof spawn;
  transportFactory?: (params: StdioServerParameters) => Transport;
  clientFactory?: () => McpClientLike;
  sleep?: (durationMs: number) => Promise<void>;
};

type DriverSession = {
  client: McpClientLike;
  transport: Transport;
};

class ComputerDriverUnsupportedError extends Error {
  readonly code = "COMPUTER_DRIVER_UNSUPPORTED";

  constructor(found: string, pinned: string) {
    super(`COMPUTER_DRIVER_UNSUPPORTED: found ${found}; required ${pinned}`);
    this.name = "ComputerDriverUnsupportedError";
  }
}

// cua-driver is a separately installed process that outlives this client, so it
// must never inherit OpenClaw secrets (provider tokens, channel credentials).
// Forward a deny-by-default allowlist of only the OS/session variables the
// driver needs plus its own CUA_/XDG_/LC_ namespaces.
const DRIVER_ENV_ALLOWLIST = new Set(
  [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "USERNAME",
    "USERDOMAIN",
    "LANG",
    "LANGUAGE",
    "TERM",
    "TZ",
    "SHELL",
    "TMPDIR",
    "TEMP",
    "TMP",
    // Linux X11/Wayland session
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XAUTHORITY",
    "DBUS_SESSION_BUS_ADDRESS",
    // Windows system paths the driver's runtime relies on
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "COMMONPROGRAMFILES",
    "COMMONPROGRAMFILES(X86)",
    "SYSTEMROOT",
    "SYSTEMDRIVE",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "PROCESSOR_ARCHITECTURE",
    "NUMBER_OF_PROCESSORS",
    "COMPUTERNAME",
    "SESSIONNAME",
    // cua-driver local config — an explicit list, not a CUA_ prefix, because the
    // CUA_ namespace also holds cloud credentials like CUA_API_KEY that this
    // local desktop driver never needs.
    "CUA_DRIVER_RS_ENABLE_WAYLAND",
    "CUA_DRIVER_RS_SESSION_IDLE_TTL_SECS",
    "CUA_DRIVER_POLICY_FILE",
    "CUA_DRIVER_MANAGED_POLICY_FILE",
    "CUA_DRIVER_SESSION_POLICY_FILE",
  ].map((name) => name.toUpperCase()),
);

// Locale and freedesktop session-dir namespaces only. Both are credential-free
// by spec; the CUA_ namespace is deliberately excluded (see the allowlist).
const DRIVER_ENV_ALLOW_PREFIXES = ["XDG_", "LC_"];

function buildDriverEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") {
      continue;
    }
    const upper = key.toUpperCase();
    const allowed =
      DRIVER_ENV_ALLOWLIST.has(upper) ||
      DRIVER_ENV_ALLOW_PREFIXES.some((prefix) => upper.startsWith(prefix));
    if (allowed) {
      result[key] = value;
    }
  }
  // Force OpenClaw-managed opt-outs even over an inherited CUA_* value.
  result.CUA_DRIVER_RS_TELEMETRY_ENABLED = "false";
  result.CUA_DRIVER_RS_UPDATE_CHECK = "false";
  return result;
}

function firstTextBlock(content: CuaToolContent[]): string {
  const block = content.find(
    (entry): entry is { type: "text"; text: string } =>
      entry.type === "text" && typeof entry.text === "string",
  );
  return block?.text ?? "cua-driver tool failed";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asToolResult(value: unknown): CuaToolResult {
  const record = asRecord(value);
  return {
    content: Array.isArray(record.content) ? (record.content as CuaToolContent[]) : [],
    isError: record.isError === true,
    structuredContent:
      record.structuredContent && typeof record.structuredContent === "object"
        ? (record.structuredContent as Record<string, unknown>)
        : undefined,
  };
}

export class CuaDriverClient implements CuaDriver {
  private readonly driverPath?: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly now: () => number;
  private readonly access: (filePath: string, mode: number) => void;
  private readonly spawnProcess: typeof spawn;
  private readonly transportFactory: (params: StdioServerParameters) => Transport;
  private readonly clientFactory: () => McpClientLike;
  private readonly sleep: (durationMs: number) => Promise<void>;
  private binaryCache: { checkedAt: number; path: string | null } = {
    checkedAt: Number.NEGATIVE_INFINITY,
    path: null,
  };
  private session?: DriverSession;
  private connectPromise?: Promise<DriverSession>;
  private serveProcess?: ChildProcess;
  private unsupportedError?: ComputerDriverUnsupportedError;
  private unsupportedAt = 0;
  private generationValue = 0;
  private disposed = false;

  constructor(options: CuaDriverClientOptions = {}) {
    this.driverPath = options.driverPath;
    this.env = options.env ?? process.env;
    this.platform = options.platform ?? process.platform;
    this.now = options.now ?? Date.now;
    this.access = options.access ?? fs.accessSync;
    this.spawnProcess = options.spawn ?? spawn;
    this.transportFactory =
      options.transportFactory ?? ((params) => new StdioClientTransport(params));
    this.clientFactory =
      options.clientFactory ??
      (() => new Client({ name: "openclaw-cua-computer", version: "0.0.0" }));
    this.sleep =
      options.sleep ??
      (async (durationMs) => {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, durationMs);
          timer.unref?.();
        });
      });
  }

  get generation(): number {
    return this.generationValue;
  }

  private executableNames(name: string): string[] {
    if (this.platform !== "win32" || path.extname(name)) {
      return [name];
    }
    const extensions = (this.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean);
    return [name, ...extensions.map((extension) => `${name}${extension.toLowerCase()}`)];
  }

  private canExecute(candidate: string): boolean {
    try {
      this.access(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  private resolveBinaryUncached(): string | null {
    const requested = this.driverPath ?? "cua-driver";
    if (path.isAbsolute(requested)) {
      return this.canExecute(requested) ? requested : null;
    }
    const pathEntries = (this.env.PATH ?? "").split(path.delimiter).filter(Boolean);
    for (const entry of pathEntries) {
      for (const name of this.executableNames(requested)) {
        const candidate = path.resolve(entry, name);
        if (this.canExecute(candidate)) {
          return candidate;
        }
      }
    }
    return null;
  }

  private resolveBinary(): string | null {
    const now = this.now();
    if (now - this.binaryCache.checkedAt < BINARY_CACHE_MS) {
      return this.binaryCache.path;
    }
    const resolved = this.resolveBinaryUncached();
    this.binaryCache = { checkedAt: now, path: resolved };
    return resolved;
  }

  /** The cached version-incompatibility error while its re-probe window holds. */
  private activeUnsupportedError(): ComputerDriverUnsupportedError | undefined {
    if (
      this.unsupportedError !== undefined &&
      this.now() - this.unsupportedAt < UNSUPPORTED_REPROBE_MS
    ) {
      return this.unsupportedError;
    }
    return undefined;
  }

  isAvailable(): boolean {
    return (
      !this.disposed && this.activeUnsupportedError() === undefined && this.resolveBinary() !== null
    );
  }

  resetAvailabilityCache(): void {
    this.binaryCache.checkedAt = Number.NEGATIVE_INFINITY;
  }

  private driverEnv(): Record<string, string> {
    return buildDriverEnvironment(this.env);
  }

  private async closeSession(session: DriverSession | undefined): Promise<void> {
    if (!session) {
      return;
    }
    await session.client.close().catch(() => {});
    await session.transport.close().catch(() => {});
  }

  private async connectOnce(binary: string): Promise<DriverSession> {
    const transport = this.transportFactory({
      command: binary,
      args: ["mcp"],
      env: this.driverEnv(),
      stderr: "ignore",
    });
    const client = this.clientFactory();
    const session = { client, transport };
    try {
      await client.connect(transport);
      const serverInfo = client.getServerVersion();
      const foundServer = serverInfo
        ? `${serverInfo.name}@${serverInfo.version}`
        : "missing serverInfo";
      if (
        serverInfo?.name !== "cua-driver" ||
        !serverInfo.version.startsWith(SUPPORTED_DRIVER_VERSION_PREFIX)
      ) {
        throw new ComputerDriverUnsupportedError(
          foundServer,
          `cua-driver@${SUPPORTED_DRIVER_VERSION_PREFIX}x`,
        );
      }
      const listed = asRecord(await client.listTools());
      const capabilityVersion = listed.capability_version;
      const schemaVersion = listed.schema_version;
      if (capabilityVersion !== "1" || schemaVersion !== "1") {
        throw new ComputerDriverUnsupportedError(
          `cua-driver@${serverInfo.version} capability_version=${String(capabilityVersion)} schema_version=${String(schemaVersion)}`,
          `cua-driver@${SUPPORTED_DRIVER_VERSION_PREFIX}x capability_version=1 schema_version=1`,
        );
      }
      this.generationValue += 1;
      return session;
    } catch (error) {
      await this.closeSession(session);
      throw error;
    }
  }

  private spawnDaemon(binary: string): void {
    // A signal-terminated child leaves exitCode null but sets signalCode, so
    // both must be null to treat the remembered daemon as still running;
    // otherwise a SIGKILL/OOM'd daemon would block every future respawn.
    if (
      this.serveProcess &&
      this.serveProcess.exitCode === null &&
      this.serveProcess.signalCode == null
    ) {
      return;
    }
    const child = this.spawnProcess(binary, ["serve"], {
      detached: true,
      env: this.driverEnv(),
      stdio: "ignore",
      windowsHide: true,
    });
    const forget = () => {
      if (this.serveProcess === child) {
        this.serveProcess = undefined;
      }
    };
    // A binary can disappear between the availability check and spawn. `error`
    // can fire without `exit`, leaving exitCode/signalCode both null, so forget
    // the child here too or the guard above would treat the failed spawn as a
    // live daemon forever. The MCP retry owns the actionable failure.
    child.once("error", forget);
    // Forget the child once it dies (either code or signal) so the next connect
    // spawns a fresh daemon instead of trusting a stale handle.
    child.once("exit", forget);
    child.unref();
    this.serveProcess = child;
  }

  private async connect(): Promise<DriverSession> {
    if (this.disposed) {
      throw new Error("COMPUTER_DRIVER_UNAVAILABLE: cua-driver client is disposed");
    }
    if (this.session) {
      return this.session;
    }
    const activeUnsupported = this.activeUnsupportedError();
    if (activeUnsupported) {
      throw activeUnsupported;
    }
    // Verdict expired: allow one fresh compatibility probe so a corrected driver
    // or restarted daemon recovers without a node restart.
    this.unsupportedError = undefined;
    if (this.connectPromise) {
      return await this.connectPromise;
    }
    const binary = this.resolveBinary();
    if (!binary) {
      throw new Error("COMPUTER_DRIVER_UNAVAILABLE: cua-driver executable not found");
    }
    const pending = (async () => {
      try {
        return await this.connectOnce(binary);
      } catch (error) {
        if (error instanceof ComputerDriverUnsupportedError) {
          this.unsupportedError = error;
          this.unsupportedAt = this.now();
          throw error;
        }
        if (this.disposed) {
          throw new Error("COMPUTER_DRIVER_UNAVAILABLE: cua-driver client is disposed", {
            cause: error,
          });
        }
        this.spawnDaemon(binary);
        // A cold `serve` start (Xvfb, portals, UIA warmup) can take seconds;
        // upstream's own mcp launcher waits up to 10s for the macOS daemon.
        // Poll with backoff instead of racing one fixed delay.
        const lastIndex = DAEMON_READY_BACKOFF_MS.length - 1;
        for (const [index, delayMs] of DAEMON_READY_BACKOFF_MS.entries()) {
          await this.sleep(delayMs);
          if (this.disposed) {
            throw new Error("COMPUTER_DRIVER_UNAVAILABLE: cua-driver client is disposed", {
              cause: error,
            });
          }
          try {
            return await this.connectOnce(binary);
          } catch (retryError) {
            if (retryError instanceof ComputerDriverUnsupportedError) {
              this.unsupportedError = retryError;
              this.unsupportedAt = this.now();
              throw retryError;
            }
            // Give up only after the budget is exhausted, reporting the final
            // retry failure (the most relevant cause) rather than the first.
            // A child exit mid-budget is not terminal: cua-driver allows one
            // daemon per endpoint, so ours may have collided with a shared one
            // that needs more time to answer.
            if (index === lastIndex) {
              throw new Error(
                "COMPUTER_DRIVER_UNAVAILABLE: cua-driver daemon did not become ready in time",
                { cause: retryError },
              );
            }
          }
        }
        // Unreachable: the final iteration always returns or throws. Present for
        // control-flow completeness only.
        throw new Error("COMPUTER_DRIVER_UNAVAILABLE: cua-driver daemon did not become ready", {
          cause: error,
        });
      }
    })();
    this.connectPromise = pending;
    try {
      const session = await pending;
      if (this.disposed) {
        await this.closeSession(session);
        throw new Error("COMPUTER_DRIVER_UNAVAILABLE: cua-driver client is disposed");
      }
      this.session = session;
      return this.session;
    } finally {
      this.connectPromise = undefined;
    }
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CuaToolResult> {
    const session = await this.connect();
    if (this.disposed) {
      throw new Error("COMPUTER_DRIVER_UNAVAILABLE: cua-driver client is disposed");
    }
    let result: CuaToolResult;
    try {
      result = asToolResult(await session.client.callTool({ name, arguments: args }));
    } catch (error) {
      if (this.session === session) {
        this.session = undefined;
      }
      await this.closeSession(session);
      throw error;
    }
    if (!result.isError) {
      return result;
    }
    const text = firstTextBlock(result.content);
    const code = result.structuredContent?.code;
    if (typeof code === "string") {
      throw new Error(`COMPUTER_REFUSED_${code}: ${text}`);
    }
    throw new Error(`COMPUTER_DRIVER_ERROR: ${text}`);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const session = this.session;
    const pending = this.connectPromise;
    this.session = undefined;
    await this.closeSession(session);
    if (pending) {
      const pendingSession = await pending.catch(() => undefined);
      if (pendingSession && pendingSession !== session) {
        await this.closeSession(pendingSession);
      }
    }
    // Do not kill the daemon: cua-driver runs one shared machine daemon per
    // endpoint that other clients may attach to, and its idle-session TTL owns
    // cleanup. Closing our mcp client already releases our transport session
    // upstream. Killing it would disconnect unrelated clients.
    this.serveProcess = undefined;
  }
}

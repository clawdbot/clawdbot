import fs from "node:fs/promises";
import path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  createSubsystemLogger,
  resolveGlobalSingleton,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  resolveCliSpawnInvocation,
  runCliCommand,
} from "openclaw/plugin-sdk/memory-core-host-engine-qmd";
import {
  isFileMissingError,
  type ResolvedQmdConfig,
  type ResolvedQmdMcporterConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { asRecord } from "../dreaming-shared.js";
import {
  extractMcporterSourcePath,
  hasMcporterRemoteAuthMaterial,
  hasMcporterStdioLifecycleOrLogging,
  hasMcporterStdioUserOwnedMaterial,
  isGeneratedMcporterQmdStdioServer,
  parseMcporterResponseJson,
  readRawMcporterEntry,
  type ConfiguredMcporterServer,
  type McporterConfigMode,
  type McporterEnvMode,
  type RawMcporterEntry,
} from "./qmd-mcporter-config.js";

const log = createSubsystemLogger("memory");
const MCPORTER_STATE_KEY = Symbol.for("openclaw.mcporterState");

type McporterState = {
  coldStartWarned: boolean;
  daemonStarts: Map<string, Promise<void>>;
};

function getMcporterState(): McporterState {
  return resolveGlobalSingleton<McporterState>(MCPORTER_STATE_KEY, () => ({
    coldStartWarned: false,
    daemonStarts: new Map(),
  }));
}

export class QmdMcporterClient {
  private readonly mcporterConfigPath: string;
  private readonly mcporterEnv: NodeJS.ProcessEnv;
  private externalMcporterConfigPath: string | null = null;
  private mcporterConfigMode: Promise<McporterConfigMode> | null = null;

  constructor(
    private readonly params: {
      qmd: ResolvedQmdConfig;
      qmdEnv: NodeJS.ProcessEnv;
      mcporterEnv: NodeJS.ProcessEnv;
      qmdDir: string;
      workspaceDir: string;
      maxOutputChars: number;
    },
  ) {
    this.mcporterConfigPath = path.join(this.params.qmdDir, "mcporter", "mcporter.json");
    this.mcporterEnv = this.params.mcporterEnv;
  }

  private get qmd(): ResolvedQmdConfig {
    return this.params.qmd;
  }
  private get env(): NodeJS.ProcessEnv {
    return this.params.qmdEnv;
  }
  private get workspaceDir(): string {
    return this.params.workspaceDir;
  }
  private get maxQmdOutputChars(): number {
    return this.params.maxOutputChars;
  }

  async ensureDaemonStarted(mcporter: ResolvedQmdMcporterConfig): Promise<void> {
    if (!mcporter.enabled) {
      return;
    }
    const configMode = await this.ensureMcporterConfig();
    const state = getMcporterState();
    if (!mcporter.startDaemon) {
      if (!state.coldStartWarned) {
        state.coldStartWarned = true;
        log.warn(
          "mcporter qmd bridge enabled but startDaemon=false; each query may cold-start QMD MCP. Consider setting memory.qmd.mcporter.startDaemon=true to keep it warm.",
        );
      }
      return;
    }
    const daemonKey = this.mcporterDaemonKey(configMode);
    let daemonStart = state.daemonStarts.get(daemonKey);
    if (!daemonStart) {
      daemonStart = (async () => {
        try {
          await this.runMcporterCommand(["daemon", "start"], {
            envMode: configMode,
            includeGeneratedConfig: configMode === "generated",
            timeoutMs: 10_000,
          });
        } catch (err) {
          log.warn(`mcporter daemon start failed: ${String(err)}`);
          // Allow future searches to retry daemon start on transient failures.
          state.daemonStarts.delete(daemonKey);
        }
      })();
      state.daemonStarts.set(daemonKey, daemonStart);
    }
    await daemonStart;
  }

  private async ensureMcporterConfig(): Promise<McporterConfigMode> {
    if (!this.mcporterConfigMode) {
      this.mcporterConfigMode = this.resolveMcporterConfigMode().catch((err: unknown) => {
        this.mcporterConfigMode = null;
        throw err;
      });
    }
    return await this.mcporterConfigMode;
  }

  private async resolveMcporterConfigMode(): Promise<McporterConfigMode> {
    await fs.mkdir(path.dirname(this.mcporterConfigPath), { recursive: true });
    const configured = await this.resolveConfiguredMcporterServer();
    if (configured?.mode === "external") {
      return "external";
    }
    const server = configured?.server ?? this.buildDefaultMcporterQmdServer();
    const config = {
      imports: [],
      mcpServers: {
        [this.qmd.mcporter.serverName]: server,
      },
    };
    await this.writeMcporterConfigIfChanged(`${JSON.stringify(config, null, 2)}\n`);
    return "generated";
  }

  private async writeMcporterConfigIfChanged(contents: string): Promise<void> {
    try {
      if ((await fs.readFile(this.mcporterConfigPath, "utf8")) === contents) {
        return;
      }
    } catch (err) {
      if (!isFileMissingError(err)) {
        throw err;
      }
    }
    await fs.writeFile(this.mcporterConfigPath, contents, "utf8");
  }

  private buildDefaultMcporterQmdServer(): Record<string, unknown> {
    const server: Record<string, unknown> = {
      command: this.qmd.command,
      args: ["mcp"],
      env: this.buildMcporterQmdEnv(),
    };
    // Only keep the QMD MCP server warm when the resolved config enables daemon management.
    if (this.qmd.mcporter.startDaemon) {
      server.lifecycle = { mode: "keep-alive", idleTimeoutMs: 300_000 };
    }
    return server;
  }

  private async resolveConfiguredMcporterServer(): Promise<ConfiguredMcporterServer | null> {
    const serverName = this.qmd.mcporter.serverName;
    let result: { stdout: string; stderr: string };
    try {
      result = await this.runMcporterCommand(["config", "get", serverName, "--json"], {
        envMode: "discovery",
        includeGeneratedConfig: false,
        timeoutMs: 5_000,
      });
    } catch (err) {
      if (serverName === "qmd") {
        return null;
      }
      throw new Error(
        `mcporter server "${serverName}" is not configured or could not be read: ${formatErrorMessage(
          err,
        )}`,
        { cause: err },
      );
    }

    let parsed: unknown;
    try {
      parsed = parseMcporterResponseJson(result.stdout);
    } catch (err) {
      if (serverName === "qmd") {
        return null;
      }
      throw new Error(`mcporter server "${serverName}" returned invalid JSON`, { cause: err });
    }
    const serialized = asRecord(parsed);
    if (!serialized) {
      if (serverName === "qmd") {
        return null;
      }
      throw new Error(`mcporter server "${serverName}" returned an invalid JSON definition`);
    }

    const rawEntry = await readRawMcporterEntry(
      serverName,
      this.mcporterEnv,
      this.workspaceDir,
      extractMcporterSourcePath(serialized),
    );
    const source = asRecord(serialized.source);
    // Imported editor entries point at their native config format, not an
    // MCPorter config file. Only `local` sources are safe MCPORTER_CONFIG values.
    this.externalMcporterConfigPath =
      source?.kind === "local" ? (extractMcporterSourcePath(serialized) ?? null) : null;
    const server = this.toMcporterRawServerEntry(serialized, rawEntry);
    if (!server) {
      if (serverName === "qmd") {
        return null;
      }
      throw new Error(`mcporter server "${serverName}" returned an unsupported definition`);
    }
    return server;
  }

  private toMcporterRawServerEntry(
    serialized: Record<string, unknown>,
    rawEntry: RawMcporterEntry | null,
  ): ConfiguredMcporterServer | null {
    const server: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(serialized)) {
      if (key === "name" || key === "source" || value === undefined) {
        continue;
      }
      server[key] = value;
    }

    if (server.command !== undefined && server.command !== null) {
      // mcporter accepts stdio commands as strings, arrays, or executable
      // objects. We can only regenerate the string form, so preserve anything
      // else as external and let mcporter handle the invocation directly.
      if (typeof server.command !== "string" || server.command.length === 0) {
        return { mode: "external" };
      }
      if (
        !isGeneratedMcporterQmdStdioServer(server) ||
        hasMcporterStdioUserOwnedMaterial(server) ||
        (rawEntry !== null && hasMcporterStdioLifecycleOrLogging(rawEntry))
      ) {
        return { mode: "external" };
      }
      return { mode: "generated", server: this.toGeneratedMcporterStdioServer(server) };
    }

    const hasRemoteEndpoint =
      typeof server.baseUrl === "string" ||
      typeof server.base_url === "string" ||
      typeof server.url === "string" ||
      typeof server.serverUrl === "string" ||
      typeof server.server_url === "string";
    if (hasRemoteEndpoint) {
      // The generated per-agent config is persisted under OpenClaw state. Do not
      // copy remote auth material from a user's mcporter config into that file;
      // keep using the original mcporter config for authenticated remotes.
      if (
        hasMcporterRemoteAuthMaterial(server) ||
        (rawEntry !== null && hasMcporterStdioLifecycleOrLogging(rawEntry))
      ) {
        return { mode: "external" };
      }
      return { mode: "generated", server };
    }

    return null;
  }

  private toGeneratedMcporterStdioServer(server: Record<string, unknown>): Record<string, unknown> {
    return {
      ...server,
      env: this.buildMcporterQmdEnv(),
    };
  }

  private buildMcporterQmdEnv(): Record<string, string> {
    const keys = [
      "PATH",
      "XDG_CONFIG_HOME",
      "QMD_CONFIG_DIR",
      "XDG_CACHE_HOME",
      "QMD_EMBED_MODEL",
      "QMD_RERANK_MODEL",
      "QMD_GENERATE_MODEL",
      "QMD_LLAMA_GPU",
      "QMD_EMBED_CONTEXT_SIZE",
      "QMD_RERANK_CONTEXT_SIZE",
      "QMD_EXPAND_CONTEXT_SIZE",
      "NO_COLOR",
    ];
    const env: Record<string, string> = {};
    for (const key of keys) {
      const value = this.env[key];
      if (typeof value === "string" && value.length > 0) {
        env[key] = value;
      }
    }
    return env;
  }

  private buildMcporterProcessEnv(mode: McporterEnvMode): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...this.mcporterEnv };
    if (mode === "generated") {
      // Generated sidecars must not inherit the user's MCPorter/QMD discovery
      // state. Discovery and external modes start from the user's environment.
      delete env.XDG_CONFIG_HOME;
      delete env.QMD_CONFIG_DIR;
      delete env.XDG_CACHE_HOME;
      delete env.MCPORTER_CONFIG;
    }
    if (mode === "external" && this.externalMcporterConfigPath) {
      // Point mcporter at the exact user/project config that defined the
      // external server, so calls do not fall back to agent-scoped dirs.
      env.MCPORTER_CONFIG = this.externalMcporterConfigPath;
    }
    return env;
  }

  private mcporterDaemonKey(configMode: McporterConfigMode): string {
    if (configMode === "generated") {
      return this.mcporterConfigPath;
    }
    return [
      "external",
      this.qmd.mcporter.serverName,
      this.mcporterEnv.MCPORTER_CONFIG ?? "",
      this.mcporterEnv.XDG_CONFIG_HOME ?? "",
      this.workspaceDir,
    ].join(":");
  }

  private async runMcporterCommand(
    args: string[],
    opts?: {
      envMode?: McporterEnvMode;
      includeGeneratedConfig?: boolean;
      timeoutMs?: number;
      signal?: AbortSignal;
    },
  ): Promise<{ stdout: string; stderr: string }> {
    const mcporterArgs =
      opts?.includeGeneratedConfig === false
        ? args
        : [...args, "--config", this.mcporterConfigPath];
    const env = this.buildMcporterProcessEnv(opts?.envMode ?? "generated");
    const spawnInvocation = resolveCliSpawnInvocation({
      command: "mcporter",
      args: mcporterArgs,
      env,
      packageName: "mcporter",
    });
    return await runCliCommand({
      commandSummary: `${spawnInvocation.command} ${spawnInvocation.argv.join(" ")}`,
      spawnInvocation,
      env,
      cwd: this.workspaceDir,
      timeoutMs: opts?.timeoutMs,
      maxOutputChars: this.maxQmdOutputChars,
      signal: opts?.signal,
    });
  }

  async run(
    args: string[],
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<{ stdout: string; stderr: string }> {
    const configMode = await this.ensureMcporterConfig();
    return await this.runMcporterCommand(args, {
      ...opts,
      envMode: configMode,
      includeGeneratedConfig: configMode === "generated",
    });
  }
}

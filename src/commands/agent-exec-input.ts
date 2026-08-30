import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import { readByteStreamWithLimit } from "@openclaw/media-core/read-byte-stream-with-limit";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { mergeDeep } from "../infra/deep-merge.js";

const AGENT_EXEC_MESSAGE_MAX_BYTES = 4 * 1024 * 1024;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export type AgentExecCliOptions = {
  messageFile?: string;
  cwd?: string;
  stateDir?: string;
  config?: string;
  isolated?: boolean;
  model?: string;
  thinking?: string;
  fallback?: string[];
  codeMode?: "direct" | "auto" | "code";
  localModelLean?: boolean;
  authEnvOnly?: boolean;
  timeout?: string;
  json?: boolean;
};

function decodePrompt(bytes: Buffer, source: string): string {
  let value: string;
  try {
    value = UTF8_DECODER.decode(bytes).replace(/^\uFEFF/, "");
  } catch {
    throw new Error(`${source} must be valid UTF-8`);
  }
  if (!value.trim()) {
    throw new Error(`${source} is empty`);
  }
  return value;
}

async function readPromptStream(stream: AsyncIterable<unknown>, source: string): Promise<string> {
  const bytes = await readByteStreamWithLimit(stream, {
    maxBytes: AGENT_EXEC_MESSAGE_MAX_BYTES,
    onOverflow: () => new Error(`${source} exceeds ${String(AGENT_EXEC_MESSAGE_MAX_BYTES)} bytes`),
  });
  return decodePrompt(bytes, source);
}

/** Resolve the one allowed prompt source for `agent exec`. */
export async function resolveAgentExecPrompt(
  positionalMessage: string | undefined,
  messageFile: string | undefined,
  stdin: AsyncIterable<unknown> = process.stdin,
): Promise<string> {
  const file = messageFile?.trim();
  const hasPositional = positionalMessage !== undefined;
  if (hasPositional && file) {
    throw new Error("Use either the prompt argument or --message-file, not both.");
  }
  if (messageFile !== undefined && !file) {
    throw new Error("--message-file must not be empty.");
  }
  if (file) {
    const stream = file === "-" ? stdin : createReadStream(file);
    try {
      return await readPromptStream(stream, file === "-" ? "stdin" : `Message file ${file}`);
    } catch (error) {
      if (file === "-" || !(error instanceof Error) || !("code" in error)) {
        throw error;
      }
      const code = error.code;
      if (code === "ENOENT") {
        throw new Error(`Message file not found: ${file}`, { cause: error });
      }
      throw error;
    }
  }
  if (!positionalMessage?.trim()) {
    throw new Error("Missing prompt. Pass text or use --message-file <path>.");
  }
  return positionalMessage;
}

/**
 * Facts owned by this invocation rather than by any config, so they win over
 * both the ambient config and `--config`: exec is always scoped to the folder
 * it was pointed at, a one-shot turn never bootstraps, and explicit flags
 * outrank whatever the resolved config says.
 */
/**
 * Drops inherited state and workspace location overrides, which outrank the
 * facts this invocation owns. `session.store` and `agentDir` can redirect state
 * outside the invocation root, where its lock or temporary cleanup cannot own
 * it; a native harness `runtime.acp.cwd` can make the turn edit the wrong repo.
 * `agents.bindings[].acp.cwd` needs no equivalent because exec runs no channel,
 * so no binding matches.
 */
function stripInheritedAgentLocations(base: OpenClawConfig): OpenClawConfig {
  const { session, ...root } = base;
  const { store: _store, ...sessionWithoutStore } = session ?? {};
  const withoutSessionStore = session ? { ...root, session: sessionWithoutStore } : base;
  const entries = withoutSessionStore.agents?.entries;
  if (!entries) {
    return withoutSessionStore;
  }
  return {
    ...withoutSessionStore,
    agents: {
      ...withoutSessionStore.agents,
      entries: Object.fromEntries(
        Object.entries(entries).map(([id, entry]) => {
          const { agentDir: _agentDir, runtime, ...rest } = entry;
          if (runtime?.type !== "acp" || runtime.acp?.cwd === undefined) {
            return [id, { ...rest, ...(runtime ? { runtime } : {}) }];
          }
          const { cwd: _cwd, ...acp } = runtime.acp;
          return [id, { ...rest, runtime: { ...runtime, acp } }];
        }),
      ),
    },
  };
}

function buildExecRunOverlay(params: {
  base: OpenClawConfig;
  cwd: string;
  opts: Pick<AgentExecCliOptions, "localModelLean">;
}): OpenClawConfig {
  // A per-agent `workspace` outranks `agents.defaults`, so pinning only the
  // defaults would let an inherited entry silently run the turn against a
  // different repository. Override every configured entry as well.
  const entries = Object.keys(params.base.agents?.entries ?? {});
  return {
    agents: {
      defaults: {
        workspace: params.cwd,
        skipBootstrap: true,
        ...(params.opts.localModelLean ? { experimental: { localModelLean: true } } : {}),
      },
      ...(entries.length > 0
        ? { entries: Object.fromEntries(entries.map((id) => [id, { workspace: params.cwd }])) }
        : {}),
    },
    // This process exits after one turn, so live skill invalidation cannot be
    // observed and would leave Chokidar retaining the otherwise-finished CLI.
    skills: { load: { watch: false } },
  };
}

/**
 * Coding one-shot defaults. These merge *under* the resolved config so an
 * operator who configured a tool profile, shell env, or sandbox keeps it;
 * notably exec must never downgrade a configured sandbox to `off`.
 */
function buildExecConfigDefaults(): OpenClawConfig {
  return {
    env: { shellEnv: { enabled: false } },
    agents: { defaults: { sandbox: { mode: "off" } } },
    tools: {
      profile: "coding",
      fs: { workspaceOnly: true },
      // No `exec.host`: the default `auto` already resolves to the gateway when
      // no sandbox is configured, and pinning `gateway` here would route
      // commands back onto the host for an inherited config that enables one.
      // `mode: "full"` stays because a headless one-shot has no approval channel.
      exec: { mode: "full" },
    },
  };
}

/**
 * Resolves the config exec runs against. Default is the ambient config, so a
 * one-shot turn behaves like other folder-scoped coding CLIs and can reach
 * configured providers, credentials, and `agentRuntime` harness choices.
 *
 * `--auth-env-only` opts out of that inheritance entirely rather than trying to
 * launder the resolved config. A config is a credential store by design -- API
 * keys, secret headers, request auth, an inline `env` block, and login-shell
 * import all feed provider auth -- so the only closed way to promise
 * environment-only credentials is to not read it.
 */
export async function resolveExecBaseConfig(
  opts: Pick<AgentExecCliOptions, "authEnvOnly" | "config" | "isolated">,
): Promise<OpenClawConfig> {
  // `--isolated` and `--auth-env-only` both mean "read no config", so pairing
  // either with `--config` is a contradiction. Failing beats silently ignoring
  // the pinned file, which would run a CI invocation on bare exec defaults.
  if (opts.config && (opts.isolated || opts.authEnvOnly === true)) {
    const conflicting = opts.isolated ? "--isolated" : "--auth-env-only";
    throw new Error(`--config cannot be combined with ${conflicting}.`);
  }
  if (opts.isolated || opts.authEnvOnly === true) {
    // A missing config is normally passed through the persisted-config
    // migrations, which materialize the legacy main agent. Configless exec
    // modes must preserve that runtime contract even though they skip all
    // authored config and its credential surfaces.
    const { migratePersistedImplicitMainRoster } = await import("../config/legacy.roster.js");
    const { coerceConfig } = await import("../config/io.read-helpers.js");
    return coerceConfig(migratePersistedImplicitMainRoster({}).config);
  }
  const { createConfigIO, getRuntimeConfig } = await import("../config/io.js");
  if (!opts.config) {
    // Ambient means "whatever this process considers effective", so this honors a
    // runtime snapshot an in-process caller already published and otherwise loads
    // the ordinary config file exactly as any other command does.
    return getRuntimeConfig();
  }
  // `--config` pins an exact file. The factory loader reads that file directly --
  // unlike the module-level loader it never resolves from a published runtime
  // snapshot, so a pinned run cannot be shadowed by one. It throws on a config
  // that exists but is invalid, so the run cannot silently degrade to exec
  // defaults, and it finalizes the load (config `env` block, shell-env fallback).
  const io = createConfigIO({ configPath: path.resolve(opts.config) });
  if (!existsSync(io.configPath)) {
    throw new Error(`--config file not found: ${io.configPath}`);
  }
  return io.loadConfig();
}

export function buildExecRunConfig(params: {
  base: OpenClawConfig;
  cwd: string;
  opts?: Pick<AgentExecCliOptions, "localModelLean">;
}): OpenClawConfig {
  const opts = params.opts ?? {};
  const base = stripInheritedAgentLocations(params.base);
  return mergeDeep(
    mergeDeep(buildExecConfigDefaults(), base),
    buildExecRunOverlay({ base, cwd: params.cwd, opts }),
  ) as OpenClawConfig; // SAFETY: Merging three typed configs preserves the OpenClawConfig shape.
}

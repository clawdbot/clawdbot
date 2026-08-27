import { randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TextDecoder } from "node:util";
import { readByteStreamWithLimit } from "@openclaw/media-core/read-byte-stream-with-limit";
import { parseStrictNonNegativeInteger } from "@openclaw/normalization-core/number-coercion";
import { findAgentRunTerminalOutcome } from "../agents/agent-run-terminal-error.js";
import type { EmbeddedAgentRunMeta } from "../agents/embedded-agent.js";
import { isExecutionIdentityCollectionEnabled } from "../audit/audit-config.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { mergeDeep } from "../infra/deep-merge.js";
import type {
  EmbeddedStateLockHandle,
  EmbeddedStateSignalProcess,
} from "../infra/embedded-state-lock.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { GatewayLockIdentity, GatewayLockOptions } from "../infra/gateway-lock.js";
import { writeRuntimeJson, writeRuntimeStdout, type RuntimeEnv } from "../runtime.js";

const AGENT_EXEC_MESSAGE_MAX_BYTES = 4 * 1024 * 1024;
const AGENT_EXEC_DEFAULT_TIMEOUT_SECONDS = 600;
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

type AgentExecPayload = {
  text?: string;
  mediaUrl?: string | null;
  mediaUrls?: string[];
  isError?: boolean;
  isReasoning?: boolean;
  isCommentary?: boolean;
};

type AgentExecRawPayload = AgentExecPayload & Record<string, unknown>;

type AgentExecRunResult = {
  payloads?: AgentExecRawPayload[];
  meta: EmbeddedAgentRunMeta;
};

type AgentExecStatus = "ok" | "error" | "timeout";

export type AgentExecEnvelope = {
  ok: boolean;
  status: AgentExecStatus;
  final: string;
  payloads: AgentExecPayload[];
  usage?: NonNullable<NonNullable<EmbeddedAgentRunMeta["agentMeta"]>["usage"]>;
  costUsd?: number;
  codeModeEngaged?: boolean;
  assistantTurns?: number;
  bridgeCalls?: NonNullable<NonNullable<EmbeddedAgentRunMeta["agentMeta"]>["bridgeCalls"]>;
  toolSummary?: NonNullable<EmbeddedAgentRunMeta["toolSummary"]>;
  model: string | null;
  provider: string | null;
  sessionId: string;
  error?: {
    message: string;
    kind: string;
  };
};

type AgentExecCommandResult = {
  envelope: AgentExecEnvelope;
  exitCode: 0 | 1 | 2;
};

type AgentExecCommandDeps = {
  stdin?: AsyncIterable<unknown>;
  process?: EmbeddedStateSignalProcess;
  gatewayLockOptions?: GatewayLockOptions;
  runAgent?: (
    opts: Record<string, unknown>,
    runtime: RuntimeEnv,
  ) => Promise<AgentExecRunResult | undefined>;
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
      const code = (error as NodeJS.ErrnoException).code;
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

function projectAgentExecPayload(payload: AgentExecRawPayload): AgentExecPayload {
  return {
    ...(typeof payload.text === "string" ? { text: payload.text } : {}),
    ...(payload.mediaUrl !== undefined ? { mediaUrl: payload.mediaUrl } : {}),
    ...(Array.isArray(payload.mediaUrls) ? { mediaUrls: [...payload.mediaUrls] } : {}),
    ...(payload.isError === true ? { isError: true } : {}),
    ...(payload.isReasoning === true ? { isReasoning: true } : {}),
    ...(payload.isCommentary === true ? { isCommentary: true } : {}),
  };
}

function finalTextFromResult(
  result: AgentExecRunResult,
  payloads: AgentExecPayload[],
  allowMetadataFallback: boolean,
): string {
  const payloadText = payloads
    .filter(
      (payload) =>
        payload.isError !== true &&
        payload.isReasoning !== true &&
        payload.isCommentary !== true &&
        typeof payload.text === "string" &&
        payload.text.trim().length > 0,
    )
    .map((payload) => payload.text!.trimEnd())
    .join("\n");
  return (
    payloadText ||
    (allowMetadataFallback ? result.meta.finalAssistantVisibleText?.trimEnd() : "") ||
    ""
  );
}

function firstErrorPayload(result: AgentExecRunResult): AgentExecPayload | undefined {
  return result.payloads?.find((payload) => payload.isError === true);
}

/** Classify an embedded result into the strict `agent exec` process contract. */
export function classifyAgentExecResult(
  result: AgentExecRunResult,
  fallbackExhausted = false,
  projectedErrorPayload?: string | true,
): AgentExecEnvelope {
  const meta = result.meta;
  const errorPayload = firstErrorPayload(result);
  const errorPayloadMessage =
    typeof projectedErrorPayload === "string"
      ? projectedErrorPayload
      : typeof errorPayload?.text === "string" && errorPayload.text.trim()
        ? errorPayload.text
        : undefined;
  const hasErrorPayload = projectedErrorPayload !== undefined || errorPayload !== undefined;
  const payloads = (result.payloads ?? []).map(projectAgentExecPayload);
  if (typeof projectedErrorPayload === "string") {
    const projectedErrorIndex = payloads.findIndex(
      (payload) => payload.isError !== true && payload.text === projectedErrorPayload,
    );
    if (projectedErrorIndex >= 0) {
      payloads[projectedErrorIndex] = {
        ...payloads[projectedErrorIndex],
        isError: true,
      };
    }
  }
  const timeout = meta.stopReason === "timeout" || meta.timeoutPhase !== undefined;
  const failed =
    fallbackExhausted ||
    meta.aborted === true ||
    meta.error !== undefined ||
    meta.stopReason === "error" ||
    hasErrorPayload;
  const status: AgentExecStatus = timeout ? "timeout" : failed ? "error" : "ok";
  const errorMessage = timeout
    ? (meta.error?.message ?? errorPayloadMessage ?? "Agent run timed out")
    : fallbackExhausted
      ? (meta.error?.message ?? errorPayloadMessage ?? "All model fallback candidates failed")
      : (meta.error?.message ?? errorPayloadMessage ?? (failed ? "Agent run failed" : undefined));
  const errorKind = timeout
    ? "timeout"
    : fallbackExhausted
      ? "fallback_exhausted"
      : meta.error?.kind
        ? meta.error.kind
        : meta.aborted
          ? "aborted"
          : hasErrorPayload
            ? "error_payload"
            : failed
              ? "agent_error"
              : undefined;
  const agentMeta = meta.agentMeta;
  return {
    ok: status === "ok",
    status,
    final: finalTextFromResult(result, payloads, !hasErrorPayload),
    payloads,
    ...(agentMeta?.usage ? { usage: agentMeta.usage } : {}),
    ...(agentMeta?.costUsd !== undefined ? { costUsd: agentMeta.costUsd } : {}),
    ...(agentMeta?.codeModeEngaged !== undefined
      ? { codeModeEngaged: agentMeta.codeModeEngaged }
      : {}),
    ...(agentMeta?.assistantTurns !== undefined
      ? { assistantTurns: agentMeta.assistantTurns }
      : {}),
    ...(agentMeta?.bridgeCalls ? { bridgeCalls: agentMeta.bridgeCalls } : {}),
    ...(meta.toolSummary ? { toolSummary: meta.toolSummary } : {}),
    model: agentMeta?.model ?? null,
    provider: agentMeta?.provider ?? null,
    sessionId: agentMeta?.sessionId ?? "",
    ...(errorMessage && errorKind ? { error: { message: errorMessage, kind: errorKind } } : {}),
  };
}

function exitCodeForEnvelope(envelope: AgentExecEnvelope): 0 | 1 | 2 {
  return envelope.status === "ok" ? 0 : envelope.status === "timeout" ? 2 : 1;
}

function normalizeCodeMode(
  value: AgentExecCliOptions["codeMode"],
): false | "auto" | true | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "direct") {
    return false;
  }
  if (value === "auto") {
    return "auto";
  }
  if (value === "code") {
    return true;
  }
  throw new Error("--code-mode must be one of direct, auto, code.");
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
  } as OpenClawConfig;
}

function buildExecRunOverlay(params: {
  base: OpenClawConfig;
  cwd: string;
  opts: Pick<AgentExecCliOptions, "codeMode" | "localModelLean">;
}): OpenClawConfig {
  const codeMode = normalizeCodeMode(params.opts.codeMode);
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
    ...(codeMode !== undefined ? { tools: { codeMode } } : {}),
  } as OpenClawConfig;
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
  opts?: Pick<AgentExecCliOptions, "codeMode" | "localModelLean">;
}): OpenClawConfig {
  const opts = params.opts ?? {};
  const base = stripInheritedAgentLocations(params.base);
  const withDefaults = mergeDeep(buildExecConfigDefaults(), base) as OpenClawConfig;
  return mergeDeep(
    withDefaults,
    buildExecRunOverlay({ base, cwd: params.cwd, opts }),
  ) as OpenClawConfig;
}

function normalizeTimeoutSeconds(value: string | undefined): string {
  const raw = value ?? String(AGENT_EXEC_DEFAULT_TIMEOUT_SECONDS);
  if (parseStrictNonNegativeInteger(raw) === undefined) {
    throw new Error("--timeout must be a non-negative integer in seconds.");
  }
  return raw;
}

function normalizeFallbacks(model: string | undefined, values: string[] | undefined): string[] {
  const fallbacks = (values ?? []).map((value) => value.trim()).filter(Boolean);
  if (fallbacks.length > 0 && !model?.trim()) {
    throw new Error("--fallback requires --model so the primary model is explicit.");
  }
  return fallbacks;
}

async function requireDirectory(value: string, label: string): Promise<string> {
  const resolved = path.resolve(value);
  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch (error) {
    throw new Error(`${label} does not exist: ${resolved}`, { cause: error });
  }
  if (!stat.isDirectory()) {
    throw new Error(`${label} is not a directory: ${resolved}`);
  }
  return resolved;
}

function setAgentExecEnvironment(params: { stateDir: string; cwd: string }): () => void {
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  // Repointing the state dir would otherwise make the config resolve relative to
  // it (see `resolveConfigDir`), so clear any inherited path override and let the
  // published runtime snapshot own config for this run.
  const previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
  const previousWorkspaceDir = process.env.OPENCLAW_WORKSPACE_DIR;
  process.env.OPENCLAW_STATE_DIR = params.stateDir;
  delete process.env.OPENCLAW_CONFIG_PATH;
  process.env.OPENCLAW_WORKSPACE_DIR = params.cwd;
  return () => {
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    if (previousConfigPath === undefined) {
      delete process.env.OPENCLAW_CONFIG_PATH;
    } else {
      process.env.OPENCLAW_CONFIG_PATH = previousConfigPath;
    }
    if (previousWorkspaceDir === undefined) {
      delete process.env.OPENCLAW_WORKSPACE_DIR;
    } else {
      process.env.OPENCLAW_WORKSPACE_DIR = previousWorkspaceDir;
    }
  };
}

function formatActiveGatewayExecRefusal(identity: GatewayLockIdentity): string {
  return `A Gateway is running for this state directory (pid ${identity.pid}, port ${identity.port}). Omit --state-dir to use isolated temporary state, or stop the Gateway first (${formatCliCommand("openclaw gateway stop")}).`;
}

function isStructuredTimeoutError(error: unknown): boolean {
  if (findAgentRunTerminalOutcome(error)?.status === "timeout") {
    return true;
  }
  let candidate = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!candidate || typeof candidate !== "object") {
      return false;
    }
    const record = candidate as {
      cause?: unknown;
      code?: unknown;
      name?: unknown;
      reason?: unknown;
    };
    if (
      record.name === "TimeoutError" ||
      record.code === "ETIMEDOUT" ||
      record.reason === "timeout"
    ) {
      return true;
    }
    candidate = record.cause;
  }
  return false;
}

function errorEnvelope(error: unknown, sessionId: string): AgentExecEnvelope {
  const status = isStructuredTimeoutError(error) ? "timeout" : "error";
  return {
    ok: false,
    status,
    final: "",
    payloads: [],
    model: null,
    provider: null,
    sessionId,
    error: {
      message: formatErrorMessage(error),
      kind: status === "timeout" ? "timeout" : "exception",
    },
  };
}

function writeAgentExecOutput(
  runtime: RuntimeEnv,
  envelope: AgentExecEnvelope,
  json: boolean,
): void {
  if (json) {
    writeRuntimeJson(runtime, envelope);
  } else if (envelope.final) {
    writeRuntimeStdout(runtime, envelope.final);
  }
  if (!envelope.ok && envelope.error) {
    runtime.error(envelope.error.message);
  }
}

/** Run one isolated embedded agent turn and project its stable CLI result. */
export async function agentExecCommand(
  positionalMessage: string | undefined,
  opts: AgentExecCliOptions,
  runtime: RuntimeEnv,
  deps: AgentExecCommandDeps = {},
): Promise<AgentExecCommandResult> {
  const sessionId = randomUUID();
  let commandResult: AgentExecCommandResult;
  let temporaryStateDir: string | undefined;
  let restoreEnvironment: (() => void) | undefined;
  let restoreConfigEnvironment: (() => void) | undefined;
  let restoreRuntimeConfigSnapshot: (() => void) | undefined;
  let runtimePaths: typeof import("../config/paths.js") | undefined;
  let configIo: typeof import("../config/io.js") | undefined;
  let stopLocalAuditWriter: (() => Promise<void>) | undefined;
  let stateLock: EmbeddedStateLockHandle | null | undefined;
  let signalBridge:
    | ReturnType<
        (typeof import("../infra/embedded-state-lock.js"))["createEmbeddedStateSignalBridge"]
      >
    | undefined;
  try {
    const prompt = await resolveAgentExecPrompt(
      positionalMessage,
      opts.messageFile,
      deps.stdin ?? process.stdin,
    );
    const cwd = await requireDirectory(opts.cwd ?? process.cwd(), "Working directory");
    const stateDir = opts.stateDir
      ? await requireDirectory(opts.stateDir, "State directory")
      : await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-exec-"));
    // Only a state dir this command created is removed; `--state-dir` is the
    // caller's and is left alone.
    temporaryStateDir = opts.stateDir ? undefined : stateDir;
    configIo = await import("../config/io.js");
    // Both process globals are captured before the config is resolved: an ambient
    // load publishes a runtime snapshot of its own, so reading "previous" after it
    // would record exec's snapshot as the caller's.
    const previousRuntimeConfigSnapshot = configIo.getRuntimeConfigSnapshot();
    const snapshotIo = configIo;
    restoreRuntimeConfigSnapshot = () => {
      if (previousRuntimeConfigSnapshot) {
        snapshotIo.setRuntimeConfigSnapshot(previousRuntimeConfigSnapshot);
      } else {
        snapshotIo.clearRuntimeConfigSnapshot();
      }
    };
    // Resolve the config before the environment repoints the state dir, so the
    // ordinary config location still applies. A successful load finalizes the
    // config's `env` block and login-shell import against `process.env`, so undo
    // exactly those mutations on the way out: otherwise an in-process caller's
    // later isolated run would inherit provider keys from this one. A failed load
    // needs no handling here -- the loader applies env vars as its last step and
    // restores them from its own catch.
    const { restoreEnvChangesIfUnchanged, snapshotEnv } = configIo;
    const envBeforeConfigLoad = snapshotEnv(process.env);
    const baseConfig = await resolveExecBaseConfig(opts);
    const envAfterConfigLoad = snapshotEnv(process.env);
    restoreConfigEnvironment = () =>
      restoreEnvChangesIfUnchanged({
        env: process.env,
        before: envBeforeConfigLoad,
        after: envAfterConfigLoad,
      });
    const runConfig = buildExecRunConfig({ base: baseConfig, cwd, opts });
    // Installed plugins belong to the operator config resolved above, not to
    // the disposable state root used for this run. Capture all roots before
    // OPENCLAW_STATE_DIR moves so discovery and the installed-index DB agree.
    const inheritInstalledPlugins = opts.isolated !== true && opts.authEnvOnly !== true;
    const pluginInstallContext = inheritInstalledPlugins
      ? await import("../plugins/install-root-context.js")
      : undefined;
    const pluginInstallRoots = pluginInstallContext?.resolvePluginInstallRoots();
    const timeout = normalizeTimeoutSeconds(opts.timeout);
    const fallbacks = normalizeFallbacks(opts.model, opts.fallback);
    const { resolveAgentDir, resolveAmbientOwnerAgentId } =
      await import("../agents/agent-scope-config.js");
    // Resolve from the inherited config, not `{}`: the default agent may declare
    // its own `agentDir`, and that is where its stored auth profiles live. This
    // reads `baseConfig` rather than `runConfig` because the run config
    // deliberately strips agent directories to keep run state ephemeral, while
    // credential ownership must still follow the operator's configuration.
    // Computed before the environment repoints the state dir so the unconfigured
    // case still resolves against the real one.
    const execAgentId = resolveAmbientOwnerAgentId(baseConfig, undefined, {
      surface: "agent exec",
      hint: "Set agents.defaults.systemAgent.agentId.",
    });
    // Auth, session keys, and SQLite ownership must share one resolved owner.
    // Splitting these paths can select an agent's store but emit a `main` key.
    const storedAuthAgentDir = resolveAgentDir(baseConfig, execAgentId);
    runtimePaths = await import("../config/paths.js");
    const storedAuthStateDir = runtimePaths.resolveStateDir();
    restoreEnvironment = setAgentExecEnvironment({ stateDir, cwd });
    runtimePaths.pinRuntimePaths();
    if (opts.stateDir) {
      const { acquireEmbeddedStateLock, createEmbeddedStateSignalBridge } =
        await import("../infra/embedded-state-lock.js");
      signalBridge = createEmbeddedStateSignalBridge(deps.process ?? process);
      stateLock = await acquireEmbeddedStateLock({
        options: deps.gatewayLockOptions,
        signal: signalBridge.signal,
        formatActiveGatewayRefusal: formatActiveGatewayExecRefusal,
      });
    }
    // The runtime snapshot is the only in-process config cache (`clearConfigCache`
    // is a no-op shim), so publishing the composed config here is what makes the
    // run use it. Serializing it to a temporary file and repointing
    // OPENCLAW_CONFIG_PATH would only feed this same snapshot, while writing
    // env-substituted provider keys to disk where the run's own exec tool
    // could read them.
    snapshotIo.setRuntimeConfigSnapshot(runConfig);
    if (isExecutionIdentityCollectionEnabled(runConfig)) {
      try {
        stopLocalAuditWriter = (await import("./agent-local-audit.js")).startAgentLocalAuditWriter({
          stateDir,
        });
      } catch {
        // Admission emits a bounded warning if the direct-process writer is unavailable.
      }
    }
    const [
      { withAuthProfileStoreAgentDir, withEnvOnlyAuthProfileStore },
      { withHostExecInheritedEnvOmitted },
      { listKnownProviderAuthEnvVarNames },
      runAgent,
    ] = await Promise.all([
      import("../agents/auth-profiles.js"),
      import("../infra/host-env-security.js"),
      import("../secrets/provider-env-vars.js"),
      deps.runAgent
        ? Promise.resolve(deps.runAgent)
        : import("./agent.js").then((module) => module.agentCommand),
    ]);
    let fallbackExhausted = false;
    let resultErrorPayload: string | true | undefined;
    const silentRuntime: RuntimeEnv = {
      log: () => {},
      error: (...args) => runtime.error(...args),
      exit: (code, exitOpts) => runtime.exit(code, exitOpts),
    };
    const invoke = async () =>
      await runAgent(
        {
          message: prompt,
          sessionId,
          agentId: execAgentId,
          workspaceDir: cwd,
          cwd,
          model: opts.model,
          thinking: opts.thinking,
          timeout,
          modelFallbacksOverride: fallbacks.length > 0 ? fallbacks : undefined,
          cleanupBundleMcpOnRunEnd: true,
          cleanupCliLiveSessionOnRunEnd: true,
          oneShotCliRun: true,
          abortSignal: signalBridge?.signal,
          onModelFallbackExhausted: () => {
            fallbackExhausted = true;
          },
          onResultErrorPayload: (message?: string) => {
            resultErrorPayload = message ?? true;
          },
        },
        silentRuntime,
      );
    // Stored credentials are the default so a folder-scoped run reaches the
    // same logins as the rest of the CLI; `--auth-env-only` opts back into an
    // environment-only scope for automation.
    const runWithPluginInstallRoots = () =>
      pluginInstallContext && pluginInstallRoots
        ? pluginInstallContext.withPluginInstallRoots(pluginInstallRoots, invoke)
        : invoke();
    const runWithAuthScope = () =>
      opts.authEnvOnly === true
        ? withEnvOnlyAuthProfileStore(runWithPluginInstallRoots)
        : withAuthProfileStoreAgentDir(
            storedAuthAgentDir,
            storedAuthStateDir,
            runWithPluginInstallRoots,
          );
    const result = await withHostExecInheritedEnvOmitted(
      listKnownProviderAuthEnvVarNames({ env: process.env }),
      runWithAuthScope,
    );
    if (!result) {
      throw new Error("Agent run returned no result");
    }
    const envelope = classifyAgentExecResult(result, fallbackExhausted, resultErrorPayload);
    if (!envelope.sessionId) {
      envelope.sessionId = sessionId;
    }
    commandResult = { envelope, exitCode: exitCodeForEnvelope(envelope) };
  } catch (error) {
    const envelope = errorEnvelope(error, sessionId);
    commandResult = { envelope, exitCode: exitCodeForEnvelope(envelope) };
  }

  let cleanupError: unknown;
  await stopLocalAuditWriter?.().catch(() => undefined);
  await stateLock?.release().catch((error: unknown) => {
    cleanupError ??= error;
  });
  const runCleanupStep = (step: () => void) => {
    try {
      step();
    } catch (error) {
      cleanupError ??= error;
    }
  };
  runCleanupStep(() => restoreEnvironment?.());
  runCleanupStep(() => restoreConfigEnvironment?.());
  runCleanupStep(() => configIo?.clearConfigCache());
  runCleanupStep(() =>
    restoreRuntimeConfigSnapshot
      ? restoreRuntimeConfigSnapshot()
      : configIo?.clearRuntimeConfigSnapshot(),
  );
  runCleanupStep(() => runtimePaths?.pinRuntimePaths());
  if (temporaryStateDir) {
    try {
      await fs.rm(temporaryStateDir, { recursive: true, force: true });
    } catch (error) {
      cleanupError ??= error;
    }
  }
  if (cleanupError) {
    const cleanupFailure = new Error(
      `Agent exec cleanup failed: ${formatErrorMessage(cleanupError)}`,
    );
    const envelope = errorEnvelope(cleanupFailure, sessionId);
    commandResult = { envelope, exitCode: exitCodeForEnvelope(envelope) };
  }

  const receivedSignal = signalBridge?.getReceivedSignal();
  signalBridge?.dispose();
  if (receivedSignal) {
    runtime.exit(receivedSignal === "SIGINT" ? 130 : 143, { resetStream: process.stderr });
    return commandResult;
  }

  writeAgentExecOutput(runtime, commandResult.envelope, opts.json === true);
  return commandResult;
}

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseStrictNonNegativeInteger } from "@openclaw/normalization-core/number-coercion";
import { findAgentRunTerminalOutcome } from "../agents/agent-run-terminal-error.js";
import { isExecutionIdentityCollectionEnabled } from "../audit/audit-config.js";
import { formatCliCommand } from "../cli/command-format.js";
import type {
  EmbeddedStateLockHandle,
  EmbeddedStateSignalProcess,
} from "../infra/embedded-state-lock.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { GatewayLockIdentity, GatewayLockOptions } from "../infra/gateway-lock.js";
import {
  getInstallationTarget,
  LOCAL_INSTALLATION_TARGET_UNSUPPORTED,
} from "../infra/installation-target-context.js";
import { writeRuntimeJson, writeRuntimeStdout, type RuntimeEnv } from "../runtime.js";
import {
  buildExecRunConfig,
  resolveAgentExecPrompt,
  resolveExecBaseConfig,
  type AgentExecCliOptions,
} from "./agent-exec-input.js";
import {
  classifyAgentExecResult,
  type AgentExecEnvelope,
  type AgentExecRunResult,
} from "./agent-exec-result.js";

const AGENT_EXEC_DEFAULT_TIMEOUT_SECONDS = 600;

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
    const codeModeOverride = normalizeCodeMode(opts.codeMode);
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
    if (getInstallationTarget()) {
      const [{ resolveSandboxConfigForAgent }, { resolveExecToolConfig }] = await Promise.all([
        import("../agents/sandbox/config.js"),
        import("../agents/lazy-exec-tool.js"),
      ]);
      const execHost = resolveExecToolConfig({ cfg: runConfig, agentId: execAgentId }).host;
      // Exec creates a fresh explicit (non-main) session. Preserve its configured
      // isolation instead of launching a fixer against a remote or sandbox copy.
      if (
        resolveSandboxConfigForAgent(runConfig, execAgentId).mode !== "off" ||
        execHost === "node" ||
        execHost === "sandbox"
      ) {
        throw new Error(LOCAL_INSTALLATION_TARGET_UNSUPPORTED);
      }
    }
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
          codeModeOverride,
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

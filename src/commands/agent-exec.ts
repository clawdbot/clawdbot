import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TextDecoder } from "node:util";
import { readByteStreamWithLimit } from "@openclaw/media-core/read-byte-stream-with-limit";
import { findAgentRunTerminalOutcome } from "../agents/agent-run-terminal-outcome.js";
import type { EmbeddedAgentRunMeta } from "../agents/embedded-agent.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { parseStrictNonNegativeInteger } from "../infra/parse-finite-number.js";
import { writeRuntimeJson, writeRuntimeStdout, type RuntimeEnv } from "../runtime.js";

const AGENT_EXEC_MESSAGE_MAX_BYTES = 4 * 1024 * 1024;
const AGENT_EXEC_DEFAULT_TIMEOUT_SECONDS = 600;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export type AgentExecCliOptions = {
  messageFile?: string;
  cwd?: string;
  stateDir?: string;
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

function buildImplicitConfig(cwd: string, opts: AgentExecCliOptions): OpenClawConfig {
  const codeMode = normalizeCodeMode(opts.codeMode);
  return {
    env: { shellEnv: { enabled: false } },
    agents: {
      defaults: {
        workspace: cwd,
        skipBootstrap: true,
        sandbox: { mode: "off" },
        ...(opts.localModelLean ? { experimental: { localModelLean: true } } : {}),
      },
    },
    tools: {
      profile: "coding",
      fs: { workspaceOnly: true },
      exec: { host: "gateway", mode: "full" },
      ...(codeMode !== undefined ? { codeMode } : {}),
    },
  };
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

function setAgentExecEnvironment(params: {
  stateDir: string;
  configPath: string;
  cwd: string;
}): () => void {
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  const previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
  const previousWorkspaceDir = process.env.OPENCLAW_WORKSPACE_DIR;
  process.env.OPENCLAW_STATE_DIR = params.stateDir;
  process.env.OPENCLAW_CONFIG_PATH = params.configPath;
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
  let cleanupRoot: string | undefined;
  let restoreEnvironment: (() => void) | undefined;
  let runtimePaths: typeof import("../config/paths.js") | undefined;
  let configIo: typeof import("../config/io.js") | undefined;
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
    cleanupRoot = opts.stateDir
      ? await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-exec-config-"))
      : stateDir;
    const configPath = path.join(cleanupRoot, "openclaw.json");
    await fs.writeFile(configPath, `${JSON.stringify(buildImplicitConfig(cwd, opts), null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    const timeout = normalizeTimeoutSeconds(opts.timeout);
    const fallbacks = normalizeFallbacks(opts.model, opts.fallback);
    const { resolveDefaultAgentDir } = await import("../agents/agent-scope-config.js");
    const storedAuthAgentDir = resolveDefaultAgentDir({});
    restoreEnvironment = setAgentExecEnvironment({ stateDir, configPath, cwd });
    [runtimePaths, configIo] = await Promise.all([
      import("../config/paths.js"),
      import("../config/io.js"),
    ]);
    configIo.clearConfigCache();
    configIo.clearRuntimeConfigSnapshot();
    runtimePaths.pinRuntimePaths();
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
          workspaceDir: cwd,
          cwd,
          model: opts.model,
          thinking: opts.thinking,
          timeout,
          modelFallbacksOverride: fallbacks.length > 0 ? fallbacks : undefined,
          cleanupBundleMcpOnRunEnd: true,
          cleanupCliLiveSessionOnRunEnd: true,
          oneShotCliRun: true,
          onModelFallbackExhausted: () => {
            fallbackExhausted = true;
          },
          onResultErrorPayload: (message?: string) => {
            resultErrorPayload = message ?? true;
          },
        },
        silentRuntime,
      );
    const runWithAuthScope = () =>
      opts.authEnvOnly === false
        ? withAuthProfileStoreAgentDir(storedAuthAgentDir, invoke)
        : withEnvOnlyAuthProfileStore(invoke);
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
  const runCleanupStep = (step: () => void) => {
    try {
      step();
    } catch (error) {
      cleanupError ??= error;
    }
  };
  runCleanupStep(() => restoreEnvironment?.());
  runCleanupStep(() => configIo?.clearConfigCache());
  runCleanupStep(() => configIo?.clearRuntimeConfigSnapshot());
  runCleanupStep(() => runtimePaths?.pinRuntimePaths());
  if (cleanupRoot) {
    try {
      await fs.rm(cleanupRoot, { recursive: true, force: true });
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

  writeAgentExecOutput(runtime, commandResult.envelope, opts.json === true);
  return commandResult;
}

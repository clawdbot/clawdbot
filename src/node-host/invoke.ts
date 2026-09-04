/** Node-host command dispatcher for system commands, approvals, env policy, and plugin commands. */
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { DEFAULT_ASK, DEFAULT_SECURITY } from "../infra/exec-approvals-config.js";
import {
  analyzeArgvCommand,
  createExecApprovalPolicySnapshot,
  ensureExecApprovalsSnapshot,
  mergeExecApprovalsSocketDefaults,
  minSecurity,
  maxAsk,
  normalizeExecApprovals,
  readExecApprovalsSnapshot,
  redactExecApprovals,
  resolveAllowAlwaysPatternCoverage,
  resolveExecApprovalsFromFile,
  updateExecApprovals,
  type ExecAsk,
  type ExecApprovalsFile,
  type ExecApprovalsResolved,
  type ExecSecurity,
} from "../infra/exec-approvals.js";
import { planShellAuthorization } from "../infra/exec-authorization-plan.js";
import {
  requestExecHostViaSocket,
  type ExecHostRequest,
  type ExecHostResponse,
} from "../infra/exec-host.js";
import {
  extractShellWrapperCommand,
  isShellWrapperInvocation,
} from "../infra/exec-wrapper-resolution.js";
import {
  inspectHostExecEnvOverrides,
  sanitizeHostExecEnv,
  sanitizeSystemRunEnvOverrides,
} from "../infra/host-env-security.js";
import {
  NODE_AGENT_CLI_CLAUDE_RUN_COMMAND,
  NODE_DEVICE_APPS_COMMAND,
  NODE_MCP_TOOLS_CALL_COMMAND,
  NODE_WORKER_DESKTOP_COMPUTER_COMMAND,
} from "../infra/node-commands.js";
import { logWarn } from "../logger.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { NODE_DESKTOP_STREAM_COMMAND } from "../shared/node-desktop-stream.js";
import type { NodeHostClient } from "./client.js";
import { invokeNodeWorkerComputerCommand, type NodeWorkerComputer } from "./computer-command.js";
import { invokeNodeDesktopStream } from "./desktop-stream-command.js";
import {
  handleClaudeCliNodeInvoke,
  type NodeHostInvokeRuntime,
} from "./invoke-agent-cli-claude-handler.js";
import { invokeDeviceApps } from "./invoke-device-apps.js";
import { invokeNodeFileCommand } from "./invoke-file-commands.js";
import { boundMcpToolResultPayload } from "./invoke-mcp-result.js";
import {
  buildSystemRunApprovalPlan,
  handleSystemRunInvoke,
  resolveEffectiveSystemRunExecPolicy,
} from "./invoke-system-run.js";
import type {
  ExecEventPayload,
  ExecFinishedEventParams,
  NodeInvokeRequestPayload,
  RunResult,
  SkillBinsProvider,
  SystemRunParams,
} from "./invoke-types.js";
import { NodeHostMcpError, type NodeHostMcpManager } from "./mcp.js";
import { buildNodeEventParams } from "./node-event-params.js";
import type { NodeWorkerBundleInstallerControl } from "./node-worker-bundle-installer.js";
import { invokeNodeWorkerSupervisorCommand } from "./node-worker-supervisor-commands.js";
import type { NodeWorkerSupervisorControl } from "./node-worker-supervisor-contract.js";
import type { NodeWorkerWorkspaceRuntime } from "./node-worker-workspace.js";
import { invokeRegisteredNodeHostCommand as invokePlugin } from "./plugin-node-host.js";
import { resolveNodeHostedSkillDirectory } from "./skills.js";

const OUTPUT_CAP = 200_000;

const MCP_ERROR_MESSAGE_MAX_CHARS = 1_024;

const OUTPUT_EVENT_TAIL = 20_000;
const DEFAULT_NODE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

type NodeHostPrivateInvokeRuntime = NodeHostInvokeRuntime & {
  canReportAbortedFailure?: (error: unknown) => boolean;
  flushPluginCommandIo?: () => Promise<void>;
  workerBundleInstaller?: NodeWorkerBundleInstallerControl;
  workerSupervisor?: NodeWorkerSupervisorControl;
  workerWorkspace?: NodeWorkerWorkspaceRuntime;
  workerComputer?: NodeWorkerComputer;
};

const execHostEnforced =
  normalizeLowercaseStringOrEmpty(process.env.OPENCLAW_NODE_EXEC_HOST ?? "") === "app";
const execHostFallbackAllowed =
  normalizeLowercaseStringOrEmpty(process.env.OPENCLAW_NODE_EXEC_FALLBACK ?? "") !== "0";
const preferMacAppExecHost = process.platform === "darwin" && execHostEnforced;

type SystemWhichParams = {
  bins: string[];
};

type McpToolsCallParams = {
  server: string;
  tool: string;
  arguments?: Record<string, unknown>;
};

type SystemExecApprovalsSetParams = {
  file: ExecApprovalsFile;
  baseHash?: string | null;
};

type SystemRunPrepareParams = {
  security?: ExecSecurity;
  ask?: ExecAsk;
  command?: unknown;
  rawCommand?: unknown;
  cwd?: unknown;
  env?: Record<string, string> | null;
  agentId?: unknown;
  sessionKey?: unknown;
  strictInlineEval?: unknown;
};

type SystemRunPrepareEnv =
  | {
      ok: true;
      env: Record<string, string>;
    }
  | {
      ok: false;
      message: string;
    };

function resolveNodeSkillCwdParam<T extends { cwd?: unknown }>(params: T, nodeId: string): T {
  if (typeof params.cwd !== "string") {
    return params;
  }
  // Resolve before approval planning so the plan, policy, and spawn all bind
  // the same canonical node-local directory instead of trusting a URI at exec time.
  const resolved = resolveNodeHostedSkillDirectory(params.cwd, nodeId);
  return resolved ? { ...params, cwd: resolved } : params;
}

function buildEnvOverrideRejectionMessage(params: {
  rejectedOverrideBlockedKeys: string[];
  rejectedOverrideInvalidKeys: string[];
}): string {
  const details: string[] = [];
  if (params.rejectedOverrideBlockedKeys.length > 0) {
    details.push(`blocked override keys: ${params.rejectedOverrideBlockedKeys.join(", ")}`);
  }
  if (params.rejectedOverrideInvalidKeys.length > 0) {
    details.push(
      `invalid non-portable override keys: ${params.rejectedOverrideInvalidKeys.join(", ")}`,
    );
  }
  return `SYSTEM_RUN_DENIED: environment override rejected (${details.join("; ")})`;
}

function buildSystemRunPrepareCoverageEnv(params: {
  argv: string[];
  env?: Record<string, string> | null;
}): SystemRunPrepareEnv {
  const diagnostics = inspectHostExecEnvOverrides({
    overrides: params.env ?? undefined,
    blockPathOverrides: true,
  });
  if (
    diagnostics.rejectedOverrideBlockedKeys.length > 0 ||
    diagnostics.rejectedOverrideInvalidKeys.length > 0
  ) {
    return {
      ok: false,
      message: buildEnvOverrideRejectionMessage(diagnostics),
    };
  }
  const envOverrides = sanitizeSystemRunEnvOverrides({
    overrides: params.env ?? undefined,
    shellWrapper: isShellWrapperInvocation(params.argv),
  });
  return {
    ok: true,
    // Prepared coverage is durable approval evidence, so keep this in parity
    // with the env passed to `system.run` policy and execution.
    env: sanitizeEnv(envOverrides),
  };
}

async function buildSystemRunAllowAlwaysCoverage(params: {
  argv: string[];
  rawCommand?: string | null;
  cwd: string | null | undefined;
  env: Record<string, string> | undefined;
  strictInlineEval?: boolean;
}) {
  const cwd = params.cwd ?? undefined;
  const shellWrapper = extractShellWrapperCommand(params.argv, params.rawCommand);
  if (shellWrapper.isWrapper) {
    if (!shellWrapper.command) {
      return { complete: false, patterns: [] };
    }
    const authorizationPlan = await planShellAuthorization({
      command: shellWrapper.command,
      cwd,
      env: params.env,
      platform: process.platform,
    });
    if (!authorizationPlan.ok) {
      return { complete: false, patterns: [] };
    }
    const candidates = authorizationPlan.groups.flatMap((group) => group.candidates);
    const reusableSegments = candidates
      .filter((candidate) => candidate.allowAlways)
      .map((candidate) => candidate.sourceSegment);
    const coverage = resolveAllowAlwaysPatternCoverage({
      segments: reusableSegments,
      cwd,
      env: params.env,
      platform: process.platform,
      strictInlineEval: params.strictInlineEval,
    });
    return {
      ...coverage,
      complete: coverage.complete && reusableSegments.length === candidates.length,
    };
  }
  const analysis = analyzeArgvCommand({ argv: params.argv, cwd, env: params.env });
  if (!analysis.ok) {
    return { complete: false, patterns: [] };
  }
  return resolveAllowAlwaysPatternCoverage({
    segments: analysis.segments,
    cwd,
    env: params.env,
    platform: process.platform,
    strictInlineEval: params.strictInlineEval,
  });
}

type ExecApprovalsSnapshot = {
  path: string;
  exists: boolean;
  hash: string;
  file: ExecApprovalsFile;
};

export type { NodeInvokeRequestPayload, SkillBinsProvider } from "./invoke-types.js";

function resolveExecSecurity(value?: string): ExecSecurity {
  return value === "deny" || value === "allowlist" || value === "full" ? value : DEFAULT_SECURITY;
}

function isCmdExeInvocation(argv: string[]): boolean {
  const token = argv[0]?.trim();
  if (!token) {
    return false;
  }
  const base = normalizeLowercaseStringOrEmpty(path.win32.basename(token));
  return base === "cmd.exe" || base === "cmd";
}

function resolveExecAsk(value?: string): ExecAsk {
  return value === "off" || value === "on-miss" || value === "always" ? value : DEFAULT_ASK;
}

/** Builds a sanitized execution environment with controlled PATH and approved overrides. */
function sanitizeEnv(overrides?: Record<string, string> | null): Record<string, string> {
  return sanitizeHostExecEnv({ overrides, blockPathOverrides: true });
}

function truncateOutput(raw: string, maxChars: number): { text: string; truncated: boolean } {
  if (raw.length <= maxChars) {
    return { text: raw, truncated: false };
  }
  return { text: `... (truncated) ${sliceUtf16Safe(raw, raw.length - maxChars)}`, truncated: true };
}

function requireExecApprovalsBaseHash(
  params: SystemExecApprovalsSetParams,
  snapshot: ExecApprovalsSnapshot,
) {
  const baseHash = typeof params.baseHash === "string" ? params.baseHash.trim() : "";
  if (!snapshot.exists) {
    if (baseHash && baseHash !== snapshot.hash) {
      throw new Error("INVALID_REQUEST: exec approvals changed; reload and retry");
    }
    return;
  }
  if (!snapshot.hash) {
    throw new Error("INVALID_REQUEST: exec approvals base hash unavailable; reload and retry");
  }
  if (!baseHash) {
    throw new Error("INVALID_REQUEST: exec approvals base hash required; reload and retry");
  }
  if (baseHash !== snapshot.hash) {
    throw new Error("INVALID_REQUEST: exec approvals changed; reload and retry");
  }
}

// libuv reports a failed pre-exec `chdir(cwd)` as `spawn <argv0> ENOENT`, which
// blames the shell/command instead of the missing working directory (#85202).
// When the spawn cwd is set but is not a usable directory, name the real cause.
// Diagnostic only: the run still fails closed — the cwd is never dropped to fall
// back to the node's default directory.
function clarifyNodeExecCwdSpawnError(
  error: NodeJS.ErrnoException,
  cwd: string | undefined,
): string {
  const message = error.message;
  if (!cwd || (error.code !== "ENOENT" && error.code !== "ENOTDIR")) {
    return message;
  }
  let reason: "does not exist" | "is not a directory";
  try {
    const stats = fs.statSync(cwd);
    // An existing directory means the cwd is fine and the ENOENT is about the
    // executable itself; leave the original message untouched.
    if (stats.isDirectory()) {
      return message;
    }
    reason = "is not a directory";
  } catch (statError) {
    const statCode = (statError as NodeJS.ErrnoException).code;
    if (statCode !== "ENOENT" && statCode !== "ENOTDIR") {
      return message;
    }
    reason =
      statCode === "ENOTDIR" || error.code === "ENOTDIR" ? "is not a directory" : "does not exist";
  }
  return `node exec working directory ${reason} on the node host: ${cwd} (os reported: ${message})`;
}

async function runCommand(
  argv: string[],
  cwd: string | undefined,
  env: Record<string, string> | undefined,
  timeoutMs: number | undefined,
  signal?: AbortSignal,
): Promise<RunResult> {
  try {
    const result = await runCommandWithTimeout(argv, {
      baseEnv: env,
      cwd,
      killProcessTree: true,
      maxCombinedOutputBytes: OUTPUT_CAP,
      maxOutputBytes: OUTPUT_CAP,
      outputCapture: "head",
      input: Buffer.alloc(0),
      signal,
      timeoutMs: timeoutMs && timeoutMs > 0 ? timeoutMs : undefined,
    });
    const timedOut = result.termination === "timeout";
    const exitCode = result.code ?? undefined;
    return {
      exitCode,
      timedOut,
      success: exitCode === 0 && !timedOut,
      stdout: result.stdout,
      stderr: result.stderr,
      error: null,
      truncated: Boolean(result.stdoutTruncatedBytes || result.stderrTruncatedBytes),
    };
  } catch (err) {
    return {
      exitCode: undefined,
      timedOut: false,
      success: false,
      stdout: "",
      stderr: "",
      error: clarifyNodeExecCwdSpawnError(err as NodeJS.ErrnoException, cwd),
      truncated: false,
    };
  }
}

function resolveEnvPath(env?: Record<string, string>): string[] {
  const raw =
    env?.PATH ??
    (env as Record<string, string>)?.Path ??
    process.env.PATH ??
    process.env.Path ??
    DEFAULT_NODE_PATH;
  return raw.split(path.delimiter).filter(Boolean);
}

function resolveExecutable(bin: string, env?: Record<string, string>) {
  if (bin.includes("/") || bin.includes("\\")) {
    return null;
  }
  const extensions =
    process.platform === "win32"
      ? (
          env?.PATHEXT ??
          env?.PathExt ??
          env?.Pathext ??
          process.env.PATHEXT ??
          process.env.PathExt ??
          ".EXE;.CMD;.BAT;.COM"
        )
          .split(";")
          .map((ext) => normalizeLowercaseStringOrEmpty(ext))
      : [""];
  for (const dir of resolveEnvPath(env)) {
    for (const ext of extensions) {
      const candidate = path.join(dir, bin + ext);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

async function handleSystemWhich(params: SystemWhichParams, env?: Record<string, string>) {
  const bins = normalizeStringEntries(params.bins);
  const found: Record<string, string> = {};
  for (const bin of bins) {
    const pathLocal = resolveExecutable(bin, env);
    if (pathLocal) {
      found[bin] = pathLocal;
    }
  }
  return { bins: found };
}

function buildExecEventPayload(payload: ExecEventPayload): ExecEventPayload {
  if (!payload.output) {
    return payload;
  }
  const trimmed = payload.output.trim();
  if (!trimmed) {
    return payload;
  }
  const { text } = truncateOutput(trimmed, OUTPUT_EVENT_TAIL);
  return { ...payload, output: text };
}

async function sendExecFinishedEvent(
  params: ExecFinishedEventParams & {
    client: NodeHostClient;
  },
) {
  const combined = [params.result.stdout, params.result.stderr, params.result.error]
    .filter(Boolean)
    .join("\n");
  await sendNodeEvent(
    params.client,
    "exec.finished",
    buildExecEventPayload({
      sessionKey: params.sessionKey,
      runId: params.runId,
      host: "node",
      command: params.commandText,
      exitCode: params.result.exitCode ?? undefined,
      timedOut: params.result.timedOut,
      success: params.result.success,
      output: combined,
      suppressNotifyOnExit: params.suppressNotifyOnExit,
    }),
  );
}

async function runViaMacAppExecHost(params: {
  approvals: ExecApprovalsResolved;
  request: ExecHostRequest;
  signal?: AbortSignal;
}): Promise<ExecHostResponse | null> {
  const { approvals, request } = params;
  return await requestExecHostViaSocket({
    socketPath: approvals.socketPath,
    token: approvals.token,
    request,
    signal: params.signal,
  });
}

async function sendJsonPayloadResult(
  client: NodeHostClient,
  frame: NodeInvokeRequestPayload,
  payload: unknown,
) {
  await sendInvokeResult(client, frame, {
    ok: true,
    payloadJSON: JSON.stringify(payload),
  });
}

async function sendMcpPayloadResult(
  client: NodeHostClient,
  frame: NodeInvokeRequestPayload,
  payload: unknown,
) {
  await sendInvokeResult(client, frame, { ok: true, payload });
}

async function sendRawPayloadResult(
  client: NodeHostClient,
  frame: NodeInvokeRequestPayload,
  payloadJSON: string,
) {
  await sendInvokeResult(client, frame, {
    ok: true,
    payloadJSON,
  });
}

async function sendErrorResult(
  client: NodeHostClient,
  frame: NodeInvokeRequestPayload,
  code: string,
  message: string,
) {
  await sendInvokeResult(client, frame, {
    ok: false,
    error: { code, message },
  });
}

async function sendInvalidRequestResult(
  client: NodeHostClient,
  frame: NodeInvokeRequestPayload,
  err: unknown,
) {
  await sendErrorResult(client, frame, "INVALID_REQUEST", String(err));
}

function classifyExecApprovalsStorageError(err: unknown): "TIMEOUT" | "UNAVAILABLE" {
  const errorCode =
    err && typeof err === "object" && "code" in err ? (err as { code?: unknown }).code : null;
  return errorCode === "file_lock_timeout" ? "TIMEOUT" : "UNAVAILABLE";
}

async function sendExecApprovalsStorageErrorResult(
  client: NodeHostClient,
  frame: NodeInvokeRequestPayload,
  err: unknown,
) {
  await sendErrorResult(client, frame, classifyExecApprovalsStorageError(err), String(err));
}

function createNodeHostInvocationClient(
  client: NodeHostClient,
  signal: AbortSignal | undefined,
): NodeHostClient {
  if (!signal) {
    return client;
  }
  return {
    async request<T = Record<string, unknown>>(
      method: string,
      params?: unknown,
      opts?: Parameters<NodeHostClient["request"]>[2],
    ): Promise<T> {
      // Superseded invocations share their replacement's Gateway id, so late
      // results, progress, and events must not outlive invocation ownership.
      if (
        signal.aborted &&
        (method === "node.invoke.result" ||
          method === "node.invoke.progress" ||
          method === "node.event")
      ) {
        return {} as T;
      }
      return opts === undefined
        ? await client.request<T>(method, params)
        : await client.request<T>(method, params, opts);
    },
  };
}

/** Handles one node-host command invocation payload and returns serialized results. */
export async function handleInvoke(
  frame: NodeInvokeRequestPayload,
  client: NodeHostClient,
  skillBins: SkillBinsProvider,
  mcpManager?: NodeHostMcpManager,
  runtime: NodeHostPrivateInvokeRuntime = {},
) {
  const invocationClient = createNodeHostInvocationClient(client, runtime.signal);
  try {
    await dispatchInvoke(frame, invocationClient, client, skillBins, mcpManager, runtime);
  } catch (err) {
    // Gateway events launch this handler without awaiting it. Consume unexpected
    // failures here so one bad request cannot terminate the node-host process.
    logWarn(
      `node host invoke failed (command=${frame.command ?? "unknown"}, id=${frame.id}): ${String(err)}`,
    );
    try {
      await sendErrorResult(invocationClient, frame, "UNAVAILABLE", "node invocation failed");
    } catch (sendErr) {
      // The caller intentionally detaches this promise. A failed result send is
      // terminal for this request and must not surface as an unhandled rejection.
      logWarn(
        `node host invoke failure response could not be sent (id=${frame.id}): ${String(sendErr)}`,
      );
    }
  }
}

async function dispatchInvoke(
  frame: NodeInvokeRequestPayload,
  client: NodeHostClient,
  abortedFailureClient: NodeHostClient,
  skillBins: SkillBinsProvider,
  mcpManager?: NodeHostMcpManager,
  runtime: NodeHostPrivateInvokeRuntime = {},
) {
  const command = frame.command ?? "";
  if (
    (command === NODE_WORKER_DESKTOP_COMPUTER_COMMAND && !runtime.workerComputer) ||
    (runtime.workerComputer && (command === "screen.snapshot" || command === "computer.act"))
  ) {
    await sendErrorResult(
      client,
      frame,
      "UNAVAILABLE",
      "computer command is unavailable on this node transport",
    );
    return;
  }
  const workerSupervisorResult = await invokeNodeWorkerSupervisorCommand({
    command,
    paramsJSON: frame.paramsJSON,
    bundleInstaller: runtime.workerBundleInstaller,
    supervisor: runtime.workerSupervisor,
    workspace: runtime.workerWorkspace,
    gatewayUrl: runtime.gatewayUrl,
    gatewayTlsFingerprint: runtime.gatewayTlsFingerprint,
    gatewayCloudflareAccess: runtime.gatewayCloudflareAccess,
    signal: runtime.signal,
  });
  if (workerSupervisorResult.handled) {
    if (workerSupervisorResult.ok) {
      await sendJsonPayloadResult(client, frame, workerSupervisorResult.payload);
    } else {
      await sendErrorResult(
        client,
        frame,
        workerSupervisorResult.code,
        workerSupervisorResult.message,
      );
    }
    return;
  }
  if (command === NODE_DEVICE_APPS_COMMAND) {
    const result = await invokeDeviceApps({
      paramsJSON: frame.paramsJSON,
      sharingEnabled: runtime.installedAppsSharingEnabled === true,
      ...(runtime.installedAppsPlatform ? { platform: runtime.installedAppsPlatform } : {}),
      ...(runtime.scanInstalledApps ? { scan: runtime.scanInstalledApps } : {}),
    });
    if (result.ok) {
      await sendJsonPayloadResult(client, frame, result.payload);
    } else {
      await sendErrorResult(client, frame, result.code, result.message);
    }
    return;
  }
  if (command === NODE_DESKTOP_STREAM_COMMAND) {
    try {
      await invokeNodeDesktopStream({
        paramsJSON: frame.paramsJSON,
        gatewayUrl: runtime.gatewayUrl,
        gatewayTlsFingerprint: runtime.gatewayTlsFingerprint,
        gatewayCloudflareAccess: runtime.gatewayCloudflareAccess,
        config: runtime.desktopHostConfig,
        signal: runtime.signal,
        emitStatus: runtime.emitProgress,
      });
      await sendJsonPayloadResult(client, frame, { status: "closed" });
    } catch (error) {
      await sendErrorResult(
        client,
        frame,
        "UNAVAILABLE",
        error instanceof Error ? error.message : "desktop stream unavailable",
      );
    }
    return;
  }
  if (command === "system.execApprovals.get") {
    let includeResolvedDefaults = false;
    try {
      if (frame.paramsJSON != null) {
        const params = decodeParams<unknown>(frame.paramsJSON);
        if (
          !isRecord(params) ||
          (params.includeResolvedDefaults !== undefined &&
            typeof params.includeResolvedDefaults !== "boolean")
        ) {
          throw new Error("INVALID_REQUEST: includeResolvedDefaults must be boolean");
        }
        includeResolvedDefaults = params.includeResolvedDefaults === true;
      }
    } catch (err) {
      await sendInvalidRequestResult(client, frame, err);
      return;
    }
    try {
      const snapshot = await ensureExecApprovalsSnapshot();
      const payload = {
        ...redactExecApprovals(snapshot),
        ...(includeResolvedDefaults
          ? { resolvedDefaults: resolveExecApprovalsFromFile({ file: snapshot.file }).defaults }
          : {}),
      };
      await sendJsonPayloadResult(client, frame, payload);
    } catch (err) {
      await sendExecApprovalsStorageErrorResult(client, frame, err);
    }
    return;
  }

  if (command === "system.execApprovals.set") {
    let params: SystemExecApprovalsSetParams;
    let normalized: ExecApprovalsFile;
    try {
      params = decodeParams<SystemExecApprovalsSetParams>(frame.paramsJSON);
      if (!params.file || typeof params.file !== "object") {
        throw new Error("INVALID_REQUEST: exec approvals file required");
      }
      normalized = normalizeExecApprovals(params.file);
    } catch (err) {
      await sendInvalidRequestResult(client, frame, err);
      return;
    }

    let snapshot: ExecApprovalsSnapshot;
    try {
      // A stale save must not initialize state before its base hash is checked.
      snapshot = readExecApprovalsSnapshot();
    } catch (err) {
      await sendExecApprovalsStorageErrorResult(client, frame, err);
      return;
    }

    try {
      requireExecApprovalsBaseHash(params, snapshot);
    } catch (err) {
      await sendInvalidRequestResult(client, frame, err);
      return;
    }

    let nextSnapshot: ExecApprovalsSnapshot | null;
    try {
      nextSnapshot = await updateExecApprovals({
        baseHash: snapshot.hash,
        update: (current) => mergeExecApprovalsSocketDefaults({ normalized, current }),
      });
    } catch (err) {
      await sendExecApprovalsStorageErrorResult(client, frame, err);
      return;
    }

    if (!nextSnapshot) {
      await sendErrorResult(
        client,
        frame,
        "INVALID_REQUEST",
        "INVALID_REQUEST: exec approvals changed; reload and retry",
      );
      return;
    }

    const payload: ExecApprovalsSnapshot = redactExecApprovals(nextSnapshot);
    await sendJsonPayloadResult(client, frame, payload);
    return;
  }

  if (command === "system.which") {
    try {
      const params = decodeParams<SystemWhichParams>(frame.paramsJSON);
      if (!Array.isArray(params.bins)) {
        throw new Error("INVALID_REQUEST: bins required");
      }
      const env = sanitizeEnv(undefined);
      const payload = await handleSystemWhich(params, env);
      await sendJsonPayloadResult(client, frame, payload);
    } catch (err) {
      await sendInvalidRequestResult(client, frame, err);
    }
    return;
  }

  const fileCommand = await invokeNodeFileCommand(command, frame.paramsJSON);
  if (fileCommand) {
    if ("error" in fileCommand) {
      await sendInvalidRequestResult(client, frame, fileCommand.error);
    } else {
      await sendJsonPayloadResult(client, frame, fileCommand.payload);
    }
    return;
  }

  if (command === NODE_MCP_TOOLS_CALL_COMMAND) {
    await handleMcpToolsCall(frame, client, mcpManager, runtime.signal);
    return;
  }

  if (command === NODE_AGENT_CLI_CLAUDE_RUN_COMMAND) {
    await handleClaudeCliNodeInvoke({
      frame,
      client,
      skillBins,
      runtime,
      deps: {
        sendErrorResult,
        sendInvalidRequestResult,
        sendInvokeResult,
        resolveExecSecurity,
        resolveExecAsk,
        isCmdExeInvocation,
        sanitizeEnv,
        runViaMacAppExecHost,
        buildExecEventPayload,
      },
    });
    return;
  }
  try {
    const { pluginCommandIo: io, pluginCommandContext: context } = runtime;
    const acquireManagedWorkspace = context?.acquireManagedWorkspace;
    let pluginInvocationActive = true;
    const invokeContext =
      context && (frame.sessionKey || runtime.signal || acquireManagedWorkspace)
        ? {
            ...context,
            ...(frame.sessionKey ? { sessionKey: frame.sessionKey } : {}),
            ...(runtime.signal ? { signal: runtime.signal } : {}),
            ...(acquireManagedWorkspace
              ? {
                  acquireManagedWorkspace: (
                    request: Parameters<typeof acquireManagedWorkspace>[0],
                  ) => {
                    if (
                      !pluginInvocationActive ||
                      runtime.signal?.aborted ||
                      !frame.sessionKey ||
                      request.sessionKey !== frame.sessionKey
                    ) {
                      throw new Error("node placement workspace invocation authority is closed");
                    }
                    return acquireManagedWorkspace(request);
                  },
                }
              : {}),
          }
        : context;
    let pluginResult: string | null;
    try {
      pluginResult =
        command === NODE_WORKER_DESKTOP_COMPUTER_COMMAND
          ? await invokeNodeWorkerComputerCommand({
              paramsJSON: frame.paramsJSON,
              computer: runtime.workerComputer!,
              invoke: (innerCommand, paramsJSON) =>
                invokePlugin(innerCommand, paramsJSON, undefined, invokeContext),
            })
          : await invokePlugin(command, frame.paramsJSON, io, invokeContext);
    } finally {
      pluginInvocationActive = false;
    }
    if (pluginResult !== null) {
      await runtime.flushPluginCommandIo?.();
      await sendRawPayloadResult(client, frame, pluginResult);
      return;
    }
  } catch (err) {
    // Only the exact current owner's exact framed failure may bypass its aborted-client fence.
    const failureClient = runtime.canReportAbortedFailure?.(err) ? abortedFailureClient : client;
    await sendInvalidRequestResult(failureClient, frame, err);
    return;
  }

  if (command === "system.run.prepare") {
    try {
      const params = resolveNodeSkillCwdParam(
        decodeParams<SystemRunPrepareParams>(frame.paramsJSON),
        frame.nodeId,
      );
      const { getRuntimeConfig } = await import("../config/config.js");
      const execPolicy = await resolveEffectiveSystemRunExecPolicy({
        cfg: getRuntimeConfig(),
        agentId: normalizeOptionalString(params.agentId),
        defaultSecurity: resolveExecSecurity(undefined),
        defaultAsk: resolveExecAsk(undefined),
        requireSocket: preferMacAppExecHost,
      });
      // Omitted caller policy retains the approval-preparation contract. A caller can
      // narrow local policy, but cannot turn a restrictive node into an ordinary launch.
      const bindApproval =
        params.security === undefined ||
        params.ask === undefined ||
        minSecurity(execPolicy.security, resolveExecSecurity(params.security)) !== "full" ||
        maxAsk(execPolicy.ask, resolveExecAsk(params.ask)) !== "off" ||
        params.strictInlineEval === true ||
        execPolicy.agentExec?.strictInlineEval === true ||
        execPolicy.globalExec?.strictInlineEval === true;
      const allowSymlinkPath =
        execPolicy.agentExec?.allowSymlinkPath ?? execPolicy.globalExec?.allowSymlinkPath === true;
      const prepared = buildSystemRunApprovalPlan({ ...params, allowSymlinkPath }, bindApproval);
      if (!prepared.ok) {
        await sendErrorResult(client, frame, "INVALID_REQUEST", prepared.message);
        return;
      }
      const prepareEnv = buildSystemRunPrepareCoverageEnv({
        argv: prepared.plan.argv,
        env: params.env ?? undefined,
      });
      if (!prepareEnv.ok) {
        await sendErrorResult(client, frame, "INVALID_REQUEST", prepareEnv.message);
        return;
      }
      const plan = {
        ...prepared.plan,
        policySnapshot: createExecApprovalPolicySnapshot({
          file: execPolicy.approvals.file,
          agentId: prepared.plan.agentId ?? undefined,
        }),
      };
      await sendJsonPayloadResult(client, frame, {
        plan,
        execPolicy: {
          security: execPolicy.security,
          ask: execPolicy.ask,
        },
        allowAlwaysCoverage: bindApproval
          ? await buildSystemRunAllowAlwaysCoverage({
              argv: prepared.plan.argv,
              rawCommand: typeof params.rawCommand === "string" ? params.rawCommand : null,
              cwd: prepared.plan.cwd,
              env: prepareEnv.env,
              strictInlineEval: params.strictInlineEval === true,
            })
          : { complete: false, patterns: [] },
      });
    } catch (err) {
      await sendInvalidRequestResult(client, frame, err);
    }
    return;
  }

  if (command !== "system.run") {
    await sendErrorResult(client, frame, "UNAVAILABLE", "command not supported");
    return;
  }

  let params: SystemRunParams;
  try {
    params = resolveNodeSkillCwdParam(
      decodeParams<SystemRunParams>(frame.paramsJSON),
      frame.nodeId,
    );
  } catch (err) {
    await sendInvalidRequestResult(client, frame, err);
    return;
  }

  if (!Array.isArray(params.command) || params.command.length === 0) {
    await sendErrorResult(client, frame, "INVALID_REQUEST", "command required");
    return;
  }

  await handleSystemRunInvoke({
    client,
    params,
    skillBins,
    signal: runtime.signal,
    execHostEnforced,
    execHostFallbackAllowed,
    resolveExecSecurity,
    resolveExecAsk,
    isCmdExeInvocation,
    sanitizeEnv,
    runCommand,
    runViaMacAppExecHost,
    sendNodeEvent,
    buildExecEventPayload,
    sendInvokeResult: async (result) => {
      await sendInvokeResult(client, frame, result);
    },
    sendExecFinishedEvent: async (event) => {
      await sendExecFinishedEvent({ ...event, client });
    },
    preferMacAppExecHost,
  });
}

function decodeMcpToolsCallParams(raw?: string | null): McpToolsCallParams {
  const value = decodeParams<unknown>(raw);
  if (!isRecord(value)) {
    throw new Error("INVALID_REQUEST: MCP tool params must be an object");
  }
  const server = typeof value.server === "string" ? value.server.trim() : "";
  const tool = typeof value.tool === "string" ? value.tool.trim() : "";
  if (!server || !tool) {
    throw new Error("INVALID_REQUEST: server and tool required");
  }
  if (value.arguments !== undefined && !isRecord(value.arguments)) {
    throw new Error("INVALID_REQUEST: arguments must be an object");
  }
  return {
    server,
    tool,
    ...(value.arguments ? { arguments: value.arguments } : {}),
  };
}

async function handleMcpToolsCall(
  frame: NodeInvokeRequestPayload,
  client: NodeHostClient,
  mcpManager: NodeHostMcpManager | undefined,
  signal?: AbortSignal,
): Promise<void> {
  if (!mcpManager) {
    await sendErrorResult(client, frame, "MCP_SERVER_UNAVAILABLE", "node host MCP is unavailable");
    return;
  }
  let params: McpToolsCallParams;
  try {
    params = decodeMcpToolsCallParams(frame.paramsJSON);
  } catch (error) {
    await sendInvalidRequestResult(client, frame, error);
    return;
  }
  try {
    const result = await mcpManager.callMcpTool({
      ...params,
      timeoutMs: frame.timeoutMs ?? undefined,
      ...(signal ? { signal } : {}),
    });
    await sendMcpPayloadResult(client, frame, boundMcpToolResultPayload(result));
  } catch (error) {
    if (error instanceof NodeHostMcpError) {
      await sendErrorResult(client, frame, error.code, error.message);
      return;
    }
    await sendErrorResult(
      client,
      frame,
      "MCP_TOOL_ERROR",
      truncateUtf16Safe(String(error), MCP_ERROR_MESSAGE_MAX_CHARS),
    );
  }
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- CLI JSON params are typed by the invoked method.
function decodeParams<T>(raw?: string | null): T {
  if (!raw) {
    throw new Error("INVALID_REQUEST: paramsJSON required");
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error("INVALID_REQUEST: paramsJSON malformed JSON");
  }
}

async function sendInvokeResult(
  client: NodeHostClient,
  frame: NodeInvokeRequestPayload,
  result: {
    ok: boolean;
    payload?: unknown;
    payloadJSON?: string | null;
    error?: { code?: string; message?: string } | null;
  },
) {
  try {
    await client.request("node.invoke.result", buildNodeInvokeResultParams(frame, result));
  } catch {
    // ignore: node invoke responses are best-effort
  }
}

function buildNodeInvokeResultParams(
  frame: NodeInvokeRequestPayload,
  result: {
    ok: boolean;
    payload?: unknown;
    payloadJSON?: string | null;
    error?: { code?: string; message?: string } | null;
  },
): {
  id: string;
  nodeId: string;
  ok: boolean;
  payload?: unknown;
  payloadJSON?: string;
  error?: { code?: string; message?: string };
} {
  const params: {
    id: string;
    nodeId: string;
    ok: boolean;
    payload?: unknown;
    payloadJSON?: string;
    error?: { code?: string; message?: string };
  } = {
    id: frame.id,
    nodeId: frame.nodeId,
    ok: result.ok,
  };
  if (result.payload !== undefined) {
    params.payload = result.payload;
  }
  if (typeof result.payloadJSON === "string") {
    params.payloadJSON = result.payloadJSON;
  }
  if (result.error) {
    params.error = result.error;
  }
  return params;
}

async function sendNodeEvent(client: NodeHostClient, event: string, payload: unknown) {
  try {
    await client.request("node.event", buildNodeEventParams(event, payload));
  } catch {
    // ignore: node events are best-effort
  }
}

const testing = {
  clarifyNodeExecCwdSpawnError,
  runCommand,
} as const;

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.nodeHostInvokeTestApi")] =
    testing;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

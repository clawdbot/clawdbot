/** Node-host command dispatcher for system commands, approvals, env policy, and plugin commands. */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import { expectDefined } from "@openclaw/normalization-core";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { mcpContentBlockToAgentContent } from "../agents/mcp-content.js";
import { GatewayClient } from "../gateway/client.js";
import {
  analyzeArgvCommand,
  createExecApprovalPolicySnapshot,
  ensureExecApprovalsSnapshot,
  mergeExecApprovalsSocketDefaults,
  normalizeExecApprovals,
  readExecApprovalsSnapshot,
  resolveAllowAlwaysPatternCoverage,
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
import { NODE_MCP_TOOLS_CALL_COMMAND } from "../infra/node-commands.js";
import {
  decodeWindowsOutputBuffer,
  resolveWindowsConsoleEncoding,
} from "../infra/windows-encoding.js";
import { logWarn } from "../logger.js";
import { truncateUtf8Prefix } from "../utils/utf8-truncate.js";
import {
  buildSystemRunApprovalPlan,
  handleSystemRunInvoke,
  resolveEffectiveSystemRunExecPolicy,
} from "./invoke-system-run.js";
import type {
  ExecEventPayload,
  ExecFinishedEventParams,
  RunResult,
  SkillBinsProvider,
  SystemRunParams,
} from "./invoke-types.js";
import { NodeHostMcpError, type NodeHostMcpManager } from "./mcp.js";
import { invokeRegisteredNodeHostCommand } from "./plugin-node-host.js";
import { resolveNodeHostedSkillDirectory } from "./skills.js";

const OUTPUT_CAP = 200_000;
const MCP_TEXT_CONTENT_MAX_BYTES = 1024 * 1024;
const MCP_TEXT_TRUNCATION_MARKER = "\n[truncated: MCP text content exceeded 1 MB]";
const MCP_INVOKE_PAYLOAD_MAX_BYTES = 20 * 1024 * 1024;
const MCP_PAYLOAD_TRUNCATION_MARKER = "[truncated: MCP result exceeded 20 MB]";
const MCP_ERROR_MESSAGE_MAX_CHARS = 1_024;
const OUTPUT_EVENT_TAIL = 20_000;
const STREAM_ERROR_KILL_GRACE_MS = 1_000;
const DEFAULT_NODE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

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

type NodeInvokeRequestPayload = {
  id: string;
  nodeId: string;
  command: string;
  paramsJSON?: string | null;
  timeoutMs?: number | null;
  idempotencyKey?: string | null;
};

export type { SkillBinsProvider } from "./invoke-types.js";

function resolveExecSecurity(value?: string): ExecSecurity {
  return value === "deny" || value === "allowlist" || value === "full" ? value : "allowlist";
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
  return value === "off" || value === "on-miss" || value === "always" ? value : "on-miss";
}

/** Builds a sanitized execution environment with controlled PATH and approved overrides. */
export function sanitizeEnv(overrides?: Record<string, string> | null): Record<string, string> {
  return sanitizeHostExecEnv({ overrides, blockPathOverrides: true });
}

function truncateOutput(raw: string, maxChars: number): { text: string; truncated: boolean } {
  if (raw.length <= maxChars) {
    return { text: raw, truncated: false };
  }
  return { text: `... (truncated) ${sliceUtf16Safe(raw, raw.length - maxChars)}`, truncated: true };
}

export function decodeCapturedOutputBuffer(params: {
  buffer: Buffer;
  platform?: NodeJS.Platform;
  windowsEncoding?: string | null;
}): string {
  return decodeWindowsOutputBuffer(params);
}

function redactExecApprovals(file: ExecApprovalsFile): ExecApprovalsFile {
  const socketPath = file.socket?.path?.trim();
  return {
    ...file,
    socket: socketPath ? { path: socketPath } : undefined,
  };
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
): Promise<RunResult> {
  return await new Promise((resolve) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let outputLen = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const windowsEncoding = resolveWindowsConsoleEncoding();

    // A cwd that exists but is not a directory makes `spawn` throw ENOTDIR
    // synchronously instead of emitting `error`. Keep that failure inside the
    // node result because runner.ts intentionally dispatches invokes with `void`.
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(expectDefined(argv[0], "argv entry at 0"), argv.slice(1), {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      resolve({
        exitCode: undefined,
        timedOut: false,
        success: false,
        stdout: "",
        stderr: "",
        error: clarifyNodeExecCwdSpawnError(err as NodeJS.ErrnoException, cwd),
        truncated: false,
      });
      return;
    }

    const onChunk = (chunk: Buffer, target: "stdout" | "stderr") => {
      if (outputLen >= OUTPUT_CAP) {
        truncated = true;
        return;
      }
      const remaining = OUTPUT_CAP - outputLen;
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      outputLen += slice.length;
      if (target === "stdout") {
        stdoutChunks.push(slice);
      } else {
        stderrChunks.push(slice);
      }
      if (chunk.length > remaining) {
        truncated = true;
      }
    };

    child.stdout?.on("data", (chunk) => onChunk(chunk as Buffer, "stdout"));
    child.stderr?.on("data", (chunk) => onChunk(chunk as Buffer, "stderr"));

    let timer: NodeJS.Timeout | undefined;
    let streamError: Error | undefined;
    let streamKillTimer: NodeJS.Timeout | undefined;
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, timeoutMs);
    }

    const finalize = (exitCode?: number, error?: string | null) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      if (streamKillTimer) {
        clearTimeout(streamKillTimer);
      }
      const stdout = decodeCapturedOutputBuffer({
        buffer: Buffer.concat(stdoutChunks),
        windowsEncoding,
      });
      const stderr = decodeCapturedOutputBuffer({
        buffer: Buffer.concat(stderrChunks),
        windowsEncoding,
      });
      resolve({
        exitCode,
        timedOut,
        success: exitCode === 0 && !timedOut && !error,
        stdout,
        stderr,
        error: error ?? null,
        truncated,
      });
    };

    const onStreamError = (err: Error) => {
      if (settled || streamError) {
        return;
      }
      streamError = err;
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      // A reported system.run completion must not outlive its command. Escalate
      // a pipe-failure shutdown, then let the child exit settle the result.
      streamKillTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, STREAM_ERROR_KILL_GRACE_MS);
      streamKillTimer.unref?.();
    };

    child.stdout?.on("error", onStreamError);
    child.stderr?.on("error", onStreamError);
    child.on("error", (err) => {
      if (!streamError) {
        finalize(undefined, clarifyNodeExecCwdSpawnError(err, cwd));
      }
    });
    child.on("exit", (code) => {
      finalize(code === null ? undefined : code, streamError?.message ?? null);
    });
  });
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
    client: GatewayClient;
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
}): Promise<ExecHostResponse | null> {
  const { approvals, request } = params;
  return await requestExecHostViaSocket({
    socketPath: approvals.socketPath,
    token: approvals.token,
    request,
  });
}

async function sendJsonPayloadResult(
  client: GatewayClient,
  frame: NodeInvokeRequestPayload,
  payload: unknown,
) {
  await sendInvokeResult(client, frame, {
    ok: true,
    payloadJSON: JSON.stringify(payload),
  });
}

async function sendMcpPayloadResult(
  client: GatewayClient,
  frame: NodeInvokeRequestPayload,
  payload: unknown,
) {
  await sendInvokeResult(client, frame, { ok: true, payload });
}

async function sendRawPayloadResult(
  client: GatewayClient,
  frame: NodeInvokeRequestPayload,
  payloadJSON: string,
) {
  await sendInvokeResult(client, frame, {
    ok: true,
    payloadJSON,
  });
}

async function sendErrorResult(
  client: GatewayClient,
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
  client: GatewayClient,
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
  client: GatewayClient,
  frame: NodeInvokeRequestPayload,
  err: unknown,
) {
  await sendErrorResult(client, frame, classifyExecApprovalsStorageError(err), String(err));
}

/** Handles one node-host command invocation payload and returns serialized results. */
export async function handleInvoke(
  frame: NodeInvokeRequestPayload,
  client: GatewayClient,
  skillBins: SkillBinsProvider,
  mcpManager?: NodeHostMcpManager,
) {
  try {
    await dispatchInvoke(frame, client, skillBins, mcpManager);
  } catch (err) {
    // Gateway events launch this handler without awaiting it. Consume unexpected
    // failures here so one bad request cannot terminate the node-host process.
    logWarn(
      `node host invoke failed (command=${frame.command ?? "unknown"}, id=${frame.id}): ${String(err)}`,
    );
    try {
      await sendErrorResult(client, frame, "UNAVAILABLE", "node invocation failed");
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
  client: GatewayClient,
  skillBins: SkillBinsProvider,
  mcpManager?: NodeHostMcpManager,
) {
  const command = frame.command ?? "";
  if (command === "system.execApprovals.get") {
    try {
      const snapshot = await ensureExecApprovalsSnapshot();
      const payload: ExecApprovalsSnapshot = {
        path: snapshot.path,
        exists: snapshot.exists,
        hash: snapshot.hash,
        file: redactExecApprovals(snapshot.file),
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

    const payload: ExecApprovalsSnapshot = {
      path: nextSnapshot.path,
      exists: nextSnapshot.exists,
      hash: nextSnapshot.hash,
      file: redactExecApprovals(nextSnapshot.file),
    };
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

  if (command === NODE_MCP_TOOLS_CALL_COMMAND) {
    await handleMcpToolsCall(frame, client, mcpManager);
    return;
  }

  try {
    const pluginNodeHostResult = await invokeRegisteredNodeHostCommand(command, frame.paramsJSON);
    if (pluginNodeHostResult !== null) {
      await sendRawPayloadResult(client, frame, pluginNodeHostResult);
      return;
    }
  } catch (err) {
    await sendInvalidRequestResult(client, frame, err);
    return;
  }

  if (command === "system.run.prepare") {
    try {
      const params = resolveNodeSkillCwdParam(
        decodeParams<SystemRunPrepareParams>(frame.paramsJSON),
        frame.nodeId,
      );
      const prepared = buildSystemRunApprovalPlan(params);
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
      const { getRuntimeConfig } = await import("../config/config.js");
      const execPolicy = await resolveEffectiveSystemRunExecPolicy({
        cfg: getRuntimeConfig(),
        agentId: prepared.plan.agentId ?? undefined,
        defaultSecurity: resolveExecSecurity(undefined),
        defaultAsk: resolveExecAsk(undefined),
        requireSocket: preferMacAppExecHost,
      });
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
        allowAlwaysCoverage: await buildSystemRunAllowAlwaysCoverage({
          argv: prepared.plan.argv,
          rawCommand: typeof params.rawCommand === "string" ? params.rawCommand : null,
          cwd: prepared.plan.cwd,
          env: prepareEnv.env,
          strictInlineEval: params.strictInlineEval === true,
        }),
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
    sendExecFinishedEvent: async ({
      sessionKey,
      runId,
      commandText,
      result,
      suppressNotifyOnExit,
    }) => {
      await sendExecFinishedEvent({
        client,
        sessionKey,
        runId,
        commandText,
        result,
        suppressNotifyOnExit,
      });
    },
    preferMacAppExecHost,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

type McpInvokeContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

function normalizeMcpContentBlock(block: unknown): McpInvokeContentBlock | null {
  if (!isRecord(block)) {
    return null;
  }
  return mcpContentBlockToAgentContent(block as ContentBlock);
}

function serializedJsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

/** Keeps MCP text/image content while bounding text sent through node.invoke. */
export function boundMcpToolResultPayload(result: {
  content: readonly unknown[];
  structuredContent?: Record<string, unknown>;
}): { content: McpInvokeContentBlock[]; structuredContent?: Record<string, unknown> } {
  const normalizedBlocks = result.content
    .map(normalizeMcpContentBlock)
    .filter((block): block is McpInvokeContentBlock => block !== null);
  const totalTextBytes = normalizedBlocks.reduce<number>(
    (total, block) =>
      total +
      (isRecord(block) && block.type === "text" && typeof block.text === "string"
        ? Buffer.byteLength(block.text)
        : 0),
    0,
  );
  let remainingTextBytes =
    totalTextBytes > MCP_TEXT_CONTENT_MAX_BYTES
      ? MCP_TEXT_CONTENT_MAX_BYTES - Buffer.byteLength(MCP_TEXT_TRUNCATION_MARKER)
      : MCP_TEXT_CONTENT_MAX_BYTES;
  let markedTruncated = false;
  const textBoundedContent: McpInvokeContentBlock[] = [];
  for (const block of normalizedBlocks) {
    if (
      block.type === "image" &&
      typeof block.data === "string" &&
      typeof block.mimeType === "string"
    ) {
      textBoundedContent.push(block);
      continue;
    }
    if (block.type !== "text" || typeof block.text !== "string") {
      continue;
    }
    if (totalTextBytes <= MCP_TEXT_CONTENT_MAX_BYTES) {
      textBoundedContent.push(block);
      continue;
    }
    if (markedTruncated) {
      continue;
    }
    const text = truncateUtf8Prefix(block.text, remainingTextBytes);
    remainingTextBytes -= Buffer.byteLength(text);
    const blockWasTruncated = text.length < block.text.length;
    if (text || blockWasTruncated) {
      textBoundedContent.push({
        ...block,
        text: blockWasTruncated ? `${text}${MCP_TEXT_TRUNCATION_MARKER}` : text,
      });
    }
    if (blockWasTruncated || remainingTextBytes === 0) {
      if (!blockWasTruncated) {
        textBoundedContent.push({ type: "text", text: MCP_TEXT_TRUNCATION_MARKER.trimStart() });
      }
      markedTruncated = true;
    }
  }
  const payloadMarker = { type: "text" as const, text: MCP_PAYLOAD_TRUNCATION_MARKER };
  const reservedMarkerBytes = serializedJsonBytes(payloadMarker) + 1;
  let usedBytes = Buffer.byteLength('{"content":[]}');
  let payloadTruncated = false;
  const content: McpInvokeContentBlock[] = [];
  for (const block of textBoundedContent) {
    const blockBytes = serializedJsonBytes(block) + (content.length > 0 ? 1 : 0);
    if (usedBytes + blockBytes + reservedMarkerBytes > MCP_INVOKE_PAYLOAD_MAX_BYTES) {
      payloadTruncated = true;
      continue;
    }
    content.push(block);
    usedBytes += blockBytes;
  }
  let structuredContent: Record<string, unknown> | undefined;
  if (result.structuredContent) {
    const structuredBytes =
      Buffer.byteLength(',"structuredContent":') + serializedJsonBytes(result.structuredContent);
    if (usedBytes + structuredBytes + reservedMarkerBytes <= MCP_INVOKE_PAYLOAD_MAX_BYTES) {
      structuredContent = result.structuredContent;
    } else {
      payloadTruncated = true;
    }
  }
  if (payloadTruncated) {
    content.push(payloadMarker);
  }
  return { content, ...(structuredContent ? { structuredContent } : {}) };
}

function mcpToolErrorMessage(result: { content: readonly unknown[] }): string {
  const text = result.content
    .filter(
      (block): block is { type: "text"; text: string } =>
        isRecord(block) && block.type === "text" && typeof block.text === "string",
    )
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n");
  return truncateUtf16Safe(text || "MCP tool returned an error", 1_024);
}

async function handleMcpToolsCall(
  frame: NodeInvokeRequestPayload,
  client: GatewayClient,
  mcpManager: NodeHostMcpManager | undefined,
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
    });
    if (result.isError) {
      await sendErrorResult(client, frame, "MCP_TOOL_ERROR", mcpToolErrorMessage(result));
      return;
    }
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

export function coerceNodeInvokePayload(payload: unknown): NodeInvokeRequestPayload | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const obj = payload as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id.trim() : "";
  const nodeId = typeof obj.nodeId === "string" ? obj.nodeId.trim() : "";
  const command = typeof obj.command === "string" ? obj.command.trim() : "";
  if (!id || !nodeId || !command) {
    return null;
  }
  const paramsJSON =
    typeof obj.paramsJSON === "string"
      ? obj.paramsJSON
      : obj.params !== undefined
        ? JSON.stringify(obj.params)
        : null;
  const timeoutMs = typeof obj.timeoutMs === "number" ? obj.timeoutMs : null;
  const idempotencyKey = typeof obj.idempotencyKey === "string" ? obj.idempotencyKey : null;
  return {
    id,
    nodeId,
    command,
    paramsJSON,
    timeoutMs,
    idempotencyKey,
  };
}

async function sendInvokeResult(
  client: GatewayClient,
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

export function buildNodeInvokeResultParams(
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

export function buildNodeEventParams(
  event: string,
  payload: unknown,
): { event: string; payloadJSON: string | null } {
  const payloadJSON = payload === undefined ? undefined : JSON.stringify(payload);
  return {
    event,
    payloadJSON: typeof payloadJSON === "string" ? payloadJSON : null,
  };
}

async function sendNodeEvent(client: GatewayClient, event: string, payload: unknown) {
  try {
    await client.request("node.event", buildNodeEventParams(event, payload));
  } catch {
    // ignore: node events are best-effort
  }
}

export const testing = {
  MCP_TEXT_CONTENT_MAX_BYTES,
  MCP_INVOKE_PAYLOAD_MAX_BYTES,
  STREAM_ERROR_KILL_GRACE_MS,
  clarifyNodeExecCwdSpawnError,
  runCommand,
} as const;

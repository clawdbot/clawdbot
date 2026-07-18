/**
 * Opt-in CLI-backend dispatch for one-shot embedded runs.
 *
 * Embedded runs targeting a CLI runtime provider normally fall through to the
 * openclaw harness and call the provider API directly with that runtime's
 * credentials (`cli_runtime_passthrough_openclaw`). Anthropic routes direct
 * anthropic-messages calls on subscription OAuth tokens to metered "extra
 * usage" billing: without extra-usage balance the passthrough fails closed
 * with a billing error, and with it the run silently draws paid usage instead
 * of the plan limits the CLI runtime was configured for. Callers that
 * tolerate CLI latency opt in via `cliBackendDispatch: "subscription-auth"`
 * to run through the CLI backend on plan limits instead.
 */
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { onAgentEvent } from "../../infra/agent-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { OPENCLAW_MCP_TOOL_PREFIX, stripOpenClawMcpToolPrefix } from "../cli-runner/tool-policy.js";
import { normalizeToolName } from "../tool-policy.js";
import { isToolResultError } from "../tool-result-error.js";
import { resolveEmbeddedCliBackendDispatchEligibility } from "./cli-backend-dispatch-eligibility.js";
import { createCliDispatchTranscriptRecorder } from "./cli-backend-dispatch-transcript.js";
import type { RunEmbeddedAgentParams } from "./run/params.js";
import type { EmbeddedAgentRunResult } from "./types.js";

const log = createSubsystemLogger("agents/embedded-cli-dispatch");

type EmbeddedCliBackendDispatch = {
  provider: string;
  sessionFile: string;
  /** Named loopback allowlist; the dispatch gate guarantees it is non-empty. */
  toolsAllow: string[];
};

/**
 * Runs the embedded turn through the CLI backend when the opt-in dispatch
 * gate matches; returns undefined so the caller continues on the native path.
 */
export async function runEmbeddedAgentViaCliBackendIfEligible(
  params: RunEmbeddedAgentParams,
): Promise<EmbeddedAgentRunResult | undefined> {
  const dispatch = resolveEmbeddedCliBackendDispatch(params);
  return dispatch ? await runEmbeddedAgentViaCliBackend(params, dispatch) : undefined;
}

/** Applies the opt-in and transcript-path gates on top of shared eligibility. */
function resolveEmbeddedCliBackendDispatch(
  params: RunEmbeddedAgentParams,
): EmbeddedCliBackendDispatch | undefined {
  if (params.cliBackendDispatch !== "subscription-auth") {
    return undefined;
  }
  // The CLI runner needs the caller-owned transcript path; runs without one
  // stay on the passthrough where session targets are resolved internally.
  const sessionFile = params.sessionFile?.trim();
  if (!sessionFile) {
    return undefined;
  }
  const toolsAllow = resolveDispatchableToolsAllow(params);
  if (!toolsAllow) {
    return undefined;
  }
  const eligibility = resolveEmbeddedCliBackendDispatchEligibility(params);
  return eligibility ? { provider: eligibility.provider, sessionFile, toolsAllow } : undefined;
}

/**
 * Fail closed on tool policy: dispatch only runs whose embedded tool state the
 * CLI bridge can express faithfully — a non-empty named allowlist bounded by
 * the loopback grant. Deny-all (`[]`), wildcards, absent allowlists, and
 * flag-based restrictions (`disableTools`, `modelRun`) keep the embedded
 * passthrough so no closed state silently widens on the CLI surface; full
 * translation can arrive with the first caller that needs it (#57326).
 */
function resolveDispatchableToolsAllow(params: RunEmbeddedAgentParams): string[] | undefined {
  if (params.disableTools || params.modelRun) {
    return undefined;
  }
  if (!params.toolsAllow || params.toolsAllow.length === 0) {
    return undefined;
  }
  const names = params.toolsAllow.map((name) => normalizeToolName(name));
  if (names.some((name) => !name || name === "*" || name.includes("*"))) {
    return undefined;
  }
  return [...new Set(names)];
}

/** Runs an opted-in embedded run through the CLI backend as a one-shot turn. */
async function runEmbeddedAgentViaCliBackend(
  params: RunEmbeddedAgentParams,
  dispatch: EmbeddedCliBackendDispatch,
): Promise<EmbeddedAgentRunResult> {
  const { runCliAgent } = await import("../cli-runner.runtime.js");
  // The dispatch gate guarantees a non-empty named allowlist; translate it to
  // the selectable-backend surface: no native tools, only the listed loopback
  // MCP tools. The MCP list also bounds the loopback grant server-side (tools
  // outside it can be neither listed nor called) and makes prepare serve the
  // loopback exclusively, so the message tool and user/plugin MCP servers stay
  // unreachable, matching disableMessageTool intent.
  const cliToolAvailability = {
    native: [] as [],
    mcp: dispatch.toolsAllow.map((name) => `${OPENCLAW_MCP_TOOL_PREFIX}${name}`),
  };
  const onAgentToolResult = params.onAgentToolResult;
  // The CLI backend writes no OpenClaw session records; mirror the run into
  // the caller-owned session file so transcript consumers (persistTranscripts,
  // timeout partial-text salvage, the live terminal-search watcher) keep
  // working at parity with embedded runs.
  const transcript = createCliDispatchTranscriptRecorder({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    sessionFile: dispatch.sessionFile,
    runId: params.runId,
    prompt: params.prompt,
    provider: dispatch.provider,
    model: params.model,
    cwd: params.cwd ?? params.workspaceDir,
    config: params.config,
  });
  // CLI tool results arrive as agent events with transport-prefixed MCP
  // names; strip and normalize so observers and transcript records see the
  // same tool names and soft-error signal the native embedded path reports.
  const unsubscribe = onAgentEvent((evt) => {
    if (evt.runId !== params.runId) {
      return;
    }
    if (evt.stream === "assistant" && typeof evt.data.text === "string") {
      transcript.noteAssistantText(evt.data.text);
      return;
    }
    if (evt.stream !== "tool") {
      return;
    }
    const phase = evt.data.phase;
    if (phase !== "start" && phase !== "result") {
      return;
    }
    const rawName = typeof evt.data.name === "string" ? evt.data.name : "";
    if (!rawName) {
      return;
    }
    const toolName = normalizeToolName(stripOpenClawMcpToolPrefix(rawName));
    const toolCallId = typeof evt.data.toolCallId === "string" ? evt.data.toolCallId : undefined;
    if (phase === "start") {
      transcript.noteToolEvent({
        phase,
        toolName,
        toolCallId,
        args: isRecord(evt.data.args) ? evt.data.args : undefined,
      });
      return;
    }
    const isError = evt.data.isError === true || isToolResultError(evt.data.result);
    transcript.noteToolEvent({
      phase,
      toolName,
      toolCallId,
      result: evt.data.result,
      isError,
    });
    onAgentToolResult?.({
      toolName,
      result: evt.data.result,
      isError,
    });
  });
  // The killed CLI child can take seconds to settle after a timeout abort,
  // while the caller's partial-text salvage reads the session file within a
  // short grace window; flush the latest snapshot the moment abort fires.
  const flushOnAbort = () => transcript.flushAssistantSnapshot();
  params.abortSignal?.addEventListener("abort", flushOnAbort, { once: true });
  // Reply/cron callers advance lifecycle state and arm execution-phase
  // watchdogs on this signal; dispatched runs emit it at the same
  // post-admission boundary where the native path does.
  params.onExecutionStarted?.(
    params.lifecycleGeneration !== undefined
      ? { lifecycleGeneration: params.lifecycleGeneration }
      : undefined,
  );
  log.info(
    `dispatching embedded run through CLI backend: runId=${params.runId} provider=${dispatch.provider} model=${params.model ?? ""}`,
  );
  let finalAssistantText: string | undefined;
  try {
    const result = await runCliAgent({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      trigger: params.trigger,
      sessionFile: dispatch.sessionFile,
      workspaceDir: params.workspaceDir,
      agentDir: params.agentDir,
      config: params.config,
      prompt: params.prompt,
      provider: dispatch.provider,
      model: params.model,
      thinkLevel: params.thinkLevel,
      timeoutMs: params.timeoutMs,
      runTimeoutOverrideMs: params.runTimeoutOverrideMs ?? params.timeoutMs,
      runId: params.runId,
      lifecycleGeneration: params.lifecycleGeneration,
      lane: params.lane,
      extraSystemPrompt: params.extraSystemPrompt,
      messageChannel: params.messageChannel,
      messageProvider: params.messageProvider,
      bootstrapContextMode: params.bootstrapContextMode,
      bootstrapContextRunKind: params.bootstrapContextRunKind,
      abortSignal: params.abortSignal,
      onExecutionPhase: params.onExecutionPhase,
      cliToolAvailability,
      // One-shot helper run: fresh CLI process, no warm live session left
      // behind, and no implicit message sends without an explicit target.
      disableCliLiveSession: true,
      cleanupCliLiveSessionOnRunEnd: true,
      requireExplicitMessageTarget: true,
      // Deliberately NOT forwarding cleanupBundleMcpOnRunEnd: on the CLI
      // runner it closes the process-wide loopback MCP server, which a
      // concurrent main turn or overlapping recall may still be using.
      // Session-scoped MCP runtimes are retired below instead.
    });
    finalAssistantText = result.payloads?.find(
      (payload) => payload.isReasoning !== true && typeof payload.text === "string",
    )?.text;
    return withoutCliSessionBinding(result);
  } finally {
    params.abortSignal?.removeEventListener("abort", flushOnAbort);
    unsubscribe();
    // Flush before the promise settles: timeout salvage reads the session
    // file as soon as the caller observes the rejection.
    await transcript.finalize(finalAssistantText);
    if (params.cleanupBundleMcpOnRunEnd === true) {
      await retireDispatchSessionMcpRuntime(params);
    }
  }
}

/**
 * Mirrors the embedded runner's cleanupBundleMcpOnRunEnd semantics for the
 * CLI dispatch path: retire only this run's session-scoped MCP runtimes so
 * stdio children do not idle until the TTL reaper, without touching the
 * process-wide loopback server shared with concurrent CLI turns.
 */
async function retireDispatchSessionMcpRuntime(params: {
  sessionId: string;
  sessionKey?: string;
  runId: string;
}): Promise<void> {
  try {
    const { retireSessionMcpRuntime, retireSessionMcpRuntimeForSessionKey } =
      await import("../agent-bundle-mcp-tools.js");
    const onError = (error: unknown, sessionId: string) => {
      log.warn(
        `bundle-mcp cleanup failed after CLI dispatch run: runId=${params.runId} sessionId=${sessionId} error=${String(error)}`,
      );
    };
    const retiredBySessionKey = await retireSessionMcpRuntimeForSessionKey({
      sessionKey: params.sessionKey,
      reason: "embedded-cli-dispatch-run-end",
      onError,
    });
    if (!retiredBySessionKey) {
      await retireSessionMcpRuntime({
        sessionId: params.sessionId,
        reason: "embedded-cli-dispatch-run-end",
        onError,
      });
    }
  } catch (error) {
    log.warn(
      `bundle-mcp cleanup unavailable after CLI dispatch run: runId=${params.runId} error=${String(error)}`,
    );
  }
}

/** Dispatch runs own no session entry, so a returned CLI binding has no owner to persist it. */
function withoutCliSessionBinding(result: EmbeddedAgentRunResult): EmbeddedAgentRunResult {
  const agentMeta = result.meta.agentMeta;
  if (!agentMeta?.cliSessionBinding && agentMeta?.clearCliSessionBinding !== true) {
    return result;
  }
  return {
    ...result,
    meta: {
      ...result.meta,
      agentMeta: {
        ...agentMeta,
        cliSessionBinding: undefined,
        clearCliSessionBinding: undefined,
      },
    },
  };
}

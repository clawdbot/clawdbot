// OpenClaw agent turns run the real embedded agent loop with the ring-zero tool.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveCliBackendConfig, type ResolvedCliBackend } from "../agents/cli-backends.js";
import { normalizeCliModel } from "../agents/cli-runner/helpers.js";
import { SessionManager } from "../agents/sessions/index.js";
import { resolveStateDir } from "../config/paths.js";
import type { CliSessionBinding } from "../config/sessions.js";
import { buildAgentMainSessionKey } from "../routing/session-key.js";
import { SYSTEM_AGENT_ID } from "./agent-id.js";
import { SYSTEM_AGENT_SYSTEM_PROMPT } from "./assistant-prompts.js";
import { SystemAgentInferenceUnavailableError } from "./inference-error.js";
import type { SystemAgentConfiguredRoute } from "./inference-route.js";
import type { SystemAgentOperation } from "./operations.js";
import type { SystemAgentOverview } from "./overview.js";
import {
  resolveSystemAgentExpectedAgentHarnessRuntimeArtifact,
  resolveSystemAgentVerifiedInferenceRoute,
  type SystemAgentVerifiedInferenceBinding,
  type SystemAgentVerifiedInferenceDeps,
} from "./verified-inference.js";

/**
 * OpenClaw is a real agent: same loop, session transcript, and tool pipeline
 * as regular agents — restricted to the single ring-zero `openclaw` tool.
 * Embedded runtimes enforce that restriction with toolsAllow. CLI harnesses
 * must explicitly support per-run native-tool selection, then receive the tool
 * over a dedicated stdio MCP server that replaces the normal bundle surface.
 * Turns share one persistent session so the conversation has genuine
 * multi-turn memory. Inference setup must succeed before this runner is entered.
 */
// Flat budget for both route classes: agent-loop turns run multi-step tool
// calls, so even metered external routes need the full window, and 120s
// already covers local startup + generation (planner evidence).
const AGENT_TURN_TIMEOUT_MS = 120_000;
const SYSTEM_AGENT_TOOL_NAME = "openclaw";

export type SystemAgentTurnDirective =
  import("../agents/tools/system-agent-tool.js").SystemAgentToolDirective;

type SystemAgentTurnReply = {
  text: string;
  modelLabel?: string;
  /** Interactive handoff the tool requested; the host chat executes it. */
  directive?: SystemAgentTurnDirective;
};

export type SystemAgentTurnRunner = (params: {
  input: string;
  overview: SystemAgentOverview;
  surface: "cli" | "gateway";
  /** Host-verified: the user's current message is an explicit approval. */
  approvalArmed: boolean;
  session: SystemAgentSession;
}) => Promise<SystemAgentTurnReply | null>;

export type SystemAgentSession = {
  sessionId: string;
  /** Exact live-tested inference owner for this ephemeral conversation. */
  verifiedInference: SystemAgentVerifiedInferenceBinding;
  /** Host-owned pending-proposal fingerprint; see system-agent-tool.ts. */
  proposalRef: { current?: string; operation?: SystemAgentOperation };
  /** Native CLI continuity, bound to the exact configured model/auth owner route. */
  cliSession?: {
    routeKey: string;
    binding: CliSessionBinding;
  };
  /** Process-lifetime transcript shared by embedded and CLI-backed turns. */
  sessionManager?: SessionManager;
};

export function createSystemAgentSession(
  verifiedInference: SystemAgentVerifiedInferenceBinding,
): SystemAgentSession {
  if (!verifiedInference) {
    throw new SystemAgentInferenceUnavailableError("agent-turn");
  }
  return {
    sessionId: `openclaw-${randomUUID()}`,
    verifiedInference,
    proposalRef: {},
  };
}

type SystemAgentRunEmbeddedAgent = (
  params: Parameters<typeof import("../agents/embedded-agent.js").runEmbeddedAgent>[0] & {
    systemAgentTool?: import("../agents/tools/system-agent-tool.js").SystemAgentToolOptions;
  },
) => ReturnType<typeof import("../agents/embedded-agent.js").runEmbeddedAgent>;

type SystemAgentRunCliAgent = (
  params: Parameters<typeof import("../agents/cli-runner.js").runCliAgent>[0] & {
    systemAgentTool?: import("../agents/tools/system-agent-tool.js").SystemAgentToolOptions;
  },
) => ReturnType<typeof import("../agents/cli-runner.js").runCliAgent>;

type SystemAgentTurnDeps = SystemAgentVerifiedInferenceDeps & {
  runEmbeddedAgent?: SystemAgentRunEmbeddedAgent;
  runCliAgent?: SystemAgentRunCliAgent;
  readConfigFileSnapshot?: typeof import("../config/config.js").readConfigFileSnapshot;
};

type EmbeddedRunResult = {
  payloads?: Array<{ text?: string }>;
  meta?: {
    finalAssistantVisibleText?: string;
    finalAssistantRawText?: string;
    agentMeta?: {
      cliSessionBinding?: CliSessionBinding;
      clearCliSessionBinding?: boolean;
    };
  };
};

function extractRunText(result: EmbeddedRunResult): string | undefined {
  return (
    result.meta?.finalAssistantVisibleText ??
    result.meta?.finalAssistantRawText ??
    result.payloads
      ?.map((payload) => payload.text?.trim())
      .filter(Boolean)
      .join("\n")
  );
}

async function ensureSystemAgentDirs(): Promise<{ workspaceDir: string }> {
  const base = path.join(resolveStateDir(), "openclaw");
  const workspaceDir = path.join(base, "workspace");
  await fs.mkdir(workspaceDir, { recursive: true });
  return { workspaceDir };
}

export async function cleanupSystemAgentSession(session: SystemAgentSession): Promise<void> {
  delete session.cliSession;
  delete session.sessionManager;
}

type SystemAgentTurnParams = Parameters<SystemAgentTurnRunner>[0];

function clearSystemAgentCliSession(session: SystemAgentSession): void {
  delete session.cliSession;
}

function clearFailedSystemAgentSessionState(session: SystemAgentSession): void {
  session.proposalRef.current = undefined;
  session.proposalRef.operation = undefined;
  clearSystemAgentCliSession(session);
}

function throwSystemAgentInferenceUnavailable(params: {
  session: SystemAgentSession;
  failures?: unknown[];
}): never {
  clearFailedSystemAgentSessionState(params.session);
  throw new SystemAgentInferenceUnavailableError("agent-turn", params.failures);
}

function cliRouteKey(
  route: SystemAgentConfiguredRoute,
  backend: ResolvedCliBackend | null,
): string {
  return JSON.stringify({
    provider: route.provider,
    backendId: backend?.id ?? route.provider,
    modelLabel: route.modelLabel,
    configuredModel: route.model,
    model: backend ? normalizeCliModel(route.model, backend.config) : route.model,
    authProfileId: route.authProfileId ?? "",
    agentDir: path.resolve(route.agentDir),
    // Native resume arguments and the backend command are not represented in
    // CliSessionBinding. Bind them here so config changes cannot revive a
    // transcript owned by a different executable or resume protocol.
    backend: backend
      ? {
          pluginId: backend.pluginId,
          modelProvider: backend.modelProvider,
          config: backend.config,
          bundleMcp: backend.bundleMcp,
          bundleMcpMode: backend.bundleMcpMode,
          authEpochMode: backend.authEpochMode,
          nativeToolMode: backend.nativeToolMode,
          toolAvailabilityEnforcement: backend.toolAvailabilityEnforcement,
          sideQuestionToolMode: backend.sideQuestionToolMode,
        }
      : null,
  });
}

function resolveSystemAgentCliBackend(
  route: SystemAgentConfiguredRoute,
): ResolvedCliBackend | null {
  // The helper owns the executable/session identity even though its model and
  // auth come from the configured default agent. OpenClaw also forces a
  // process per turn so each approval gets fresh MCP authority; fingerprint
  // that effective execution identity rather than the configured live mode.
  const backend = resolveCliBackendConfig(route.provider, route.runConfig, {
    agentId: SYSTEM_AGENT_ID,
  });
  if (!backend) {
    return null;
  }
  const { liveSession: _liveSession, ...config } = backend.config;
  return { ...backend, config };
}

function resolveSystemAgentCliToolAvailability(
  backend: ResolvedCliBackend | null,
): { native: []; openClaw: string[] } | undefined {
  if (backend?.nativeToolMode === "none") {
    return undefined;
  }
  if (
    backend?.nativeToolMode === "selectable" &&
    ((backend.toolAvailabilityEnforcement === "execution-args" && backend.resolveExecutionArgs) ||
      (backend.toolAvailabilityEnforcement === "prepare-execution" && backend.prepareExecution))
  ) {
    return { native: [], openClaw: [SYSTEM_AGENT_TOOL_NAME] };
  }
  const backendId = backend?.id ?? "unknown";
  throw new Error(`CLI backend ${backendId} cannot enforce OpenClaw's exact tool availability`);
}

/**
 * CLI harnesses run the openclaw tool in a stdio MCP subprocess, so the
 * in-process proposalRef/directiveRef cannot be shared with the host. Mirror
 * the tool's transitions from the harness tool events instead: a denial
 * registers the exact-operation hash, a mismatch voids it, an executed
 * mutation consumes it, and directive actions replay the interactive handoff —
 * same lifecycle as system-agent-tool.ts enforces.
 */
async function mirrorSystemAgentToolStateFromEvents(params: {
  runId: string;
  proposalRef: { current?: string; operation?: SystemAgentOperation };
  directiveRef: { current?: SystemAgentTurnDirective };
}): Promise<() => void> {
  const [
    { onAgentEvent },
    { extractToolResultText },
    { resolveSystemAgentProposalTransition, resolveSystemAgentDirectiveTransition },
  ] = await Promise.all([
    import("../infra/agent-events.js"),
    import("../agents/embedded-agent-subscribe.tools.js"),
    import("../agents/tools/system-agent-tool.js"),
  ]);
  return onAgentEvent((evt) => {
    if (evt.runId !== params.runId || evt.stream !== "tool" || evt.data.phase !== "result") {
      return;
    }
    const name = typeof evt.data.name === "string" ? evt.data.name : "";
    // CLI harnesses report MCP tools with transport prefixes (mcp__openclaw__openclaw).
    if (name !== "openclaw" && !name.endsWith("__openclaw")) {
      return;
    }
    const args =
      typeof evt.data.args === "object" && evt.data.args !== null
        ? (evt.data.args as Record<string, unknown>)
        : {};
    const resultText = extractToolResultText(evt.data.result) ?? "";
    const transition = resolveSystemAgentProposalTransition({ args, resultText });
    if (transition) {
      params.proposalRef.current = transition.proposal;
      params.proposalRef.operation = transition.operation;
    }
    const directive = resolveSystemAgentDirectiveTransition({ args, resultText });
    if (directive && params.directiveRef.current?.kind !== "approved-operation") {
      params.directiveRef.current = directive;
    }
  });
}

/**
 * Run one OpenClaw turn through the embedded agent loop. Route, runner, and
 * output failures are typed so callers may try another inference path without
 * mistaking the failure for deterministic setup authority.
 */
async function runSystemAgentTurnWithDeps(
  params: SystemAgentTurnParams,
  deps: SystemAgentTurnDeps = {},
): Promise<SystemAgentTurnReply | null> {
  const binding = params.session.verifiedInference;
  if (!binding) {
    return throwSystemAgentInferenceUnavailable({ session: params.session });
  }
  let plan: SystemAgentConfiguredRoute | null;
  try {
    plan = await resolveSystemAgentVerifiedInferenceRoute(binding, deps);
  } catch (error) {
    return throwSystemAgentInferenceUnavailable({
      session: params.session,
      failures: [error],
    });
  }
  if (!plan) {
    return throwSystemAgentInferenceUnavailable({ session: params.session });
  }
  let expectedAgentHarnessRuntimeArtifact: ReturnType<
    typeof resolveSystemAgentExpectedAgentHarnessRuntimeArtifact
  >;
  try {
    expectedAgentHarnessRuntimeArtifact =
      resolveSystemAgentExpectedAgentHarnessRuntimeArtifact(binding);
  } catch (error) {
    return throwSystemAgentInferenceUnavailable({ session: params.session, failures: [error] });
  }
  let workspaceDir: string;
  try {
    ({ workspaceDir } = await ensureSystemAgentDirs());
  } catch (error) {
    return throwSystemAgentInferenceUnavailable({
      session: params.session,
      failures: [error],
    });
  }

  const runId = `openclaw-turn-${randomUUID()}`;
  const sessionManager = params.session.sessionManager ?? SessionManager.inMemory(workspaceDir);
  params.session.sessionManager = sessionManager;
  const shared = {
    sessionId: params.session.sessionId,
    sessionKey: buildAgentMainSessionKey({ agentId: SYSTEM_AGENT_ID }),
    agentId: SYSTEM_AGENT_ID,
    trigger: "manual" as const,
    sessionFile: `in-memory:${params.session.sessionId}`,
    sessionManager,
    workspaceDir,
    config: plan.runConfig,
    prompt: params.input,
    timeoutMs: AGENT_TURN_TIMEOUT_MS,
    thinkLevel: "off" as const,
    runId,
    messageChannel: "openclaw",
    messageProvider: "openclaw",
  };
  // Directives are per-turn: the tool records at most one interactive handoff
  // and the engine executes it after the reply.
  const directiveRef: { current?: SystemAgentTurnDirective } = {};
  const systemAgentTool = {
    surface: params.surface,
    approvalArmed: params.approvalArmed,
    proposalRef: params.session.proposalRef,
    directiveRef,
  };
  try {
    let result: EmbeddedRunResult;
    if (plan.runner === "cli") {
      const backend = resolveSystemAgentCliBackend(plan);
      const cliToolAvailability = resolveSystemAgentCliToolAvailability(backend);
      const routeKey = cliRouteKey(plan, backend);
      const previousBinding =
        params.session.cliSession?.routeKey === routeKey
          ? params.session.cliSession.binding
          : undefined;
      if (!previousBinding) {
        clearSystemAgentCliSession(params.session);
      }
      const runCli = deps.runCliAgent ?? (await import("../agents/cli-runner.js")).runCliAgent;
      const stopToolStateMirror = await mirrorSystemAgentToolStateFromEvents({
        runId,
        proposalRef: params.session.proposalRef,
        directiveRef,
      });
      try {
        result = (await runCli({
          ...shared,
          provider: plan.provider,
          model: plan.model,
          agentDir: plan.agentDir,
          ...(plan.authProfileId ? { authProfileId: plan.authProfileId } : {}),
          extraSystemPrompt: SYSTEM_AGENT_SYSTEM_PROMPT,
          extraSystemPromptStatic: SYSTEM_AGENT_SYSTEM_PROMPT,
          systemAgentTool,
          ...(cliToolAvailability ? { cliToolAvailability } : {}),
          ...(previousBinding ? { cliSessionBinding: previousBinding } : {}),
          disableCliLiveSession: true,
          cleanupCliLiveSessionOnRunEnd: true,
        })) as EmbeddedRunResult;
      } finally {
        stopToolStateMirror();
      }
      // Thread the harness's own session forward so the next turn resumes the
      // native CLI transcript instead of reseeding from scratch.
      const agentMeta = result.meta?.agentMeta;
      if (agentMeta?.clearCliSessionBinding || !agentMeta?.cliSessionBinding?.sessionId) {
        clearSystemAgentCliSession(params.session);
      } else if (agentMeta?.cliSessionBinding?.sessionId) {
        params.session.cliSession = {
          routeKey,
          binding: agentMeta.cliSessionBinding,
        };
      }
    } else {
      // An intervening embedded turn cannot be represented in the CLI's native
      // transcript. A later CLI route must reseed instead of reviving stale context.
      clearSystemAgentCliSession(params.session);
      const runEmbedded =
        deps.runEmbeddedAgent ?? (await import("../agents/embedded-agent.js")).runEmbeddedAgent;
      result = (await runEmbedded({
        ...shared,
        extraSystemPrompt: SYSTEM_AGENT_SYSTEM_PROMPT,
        toolsAllow: ["openclaw"],
        systemAgentTool,
        disableMessageTool: true,
        provider: plan.provider,
        model: plan.model,
        agentDir: plan.agentDir,
        agentHarnessRuntimeOverride: plan.agentHarnessRuntimeOverride,
        ...(expectedAgentHarnessRuntimeArtifact ? { expectedAgentHarnessRuntimeArtifact } : {}),
        ...(plan.authProfileId
          ? { authProfileId: plan.authProfileId, authProfileIdSource: "user" as const }
          : {}),
      })) as EmbeddedRunResult;
    }
    if (params.session.verifiedInference !== binding) {
      throw new SystemAgentInferenceUnavailableError("agent-turn");
    }
    // A completed model turn is still untrusted until the exact route owner is
    // revalidated. This also rejects directives produced while config changed.
    const currentRoute = await resolveSystemAgentVerifiedInferenceRoute(binding, deps);
    if (!currentRoute) {
      throw new SystemAgentInferenceUnavailableError("agent-turn");
    }
    const text = extractRunText(result)?.trim();
    if (!text) {
      throw new SystemAgentInferenceUnavailableError("agent-turn");
    }
    return {
      text,
      modelLabel: plan.modelLabel,
      ...(directiveRef.current ? { directive: directiveRef.current } : {}),
    };
  } catch (error) {
    // A failed run may have registered a proposal or returned a CLI session id
    // before rejecting. Neither is safe to arm or resume on a later attempt.
    const failures =
      error instanceof SystemAgentInferenceUnavailableError ? [...error.failures] : [error];
    return throwSystemAgentInferenceUnavailable({ session: params.session, failures });
  }
}

export const runSystemAgentTurn: SystemAgentTurnRunner = (params) =>
  runSystemAgentTurnWithDeps(params);

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.systemAgentTurnTestApi")] = {
    runSystemAgentTurnWithDeps,
  };
}

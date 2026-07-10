// Crestodian agent turns run the real embedded agent loop with the ring-zero tool.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import type { CliSessionBinding } from "../config/sessions.js";
import { buildAgentMainSessionKey } from "../routing/session-key.js";
import {
  selectCrestodianLocalPlannerBackends,
  type CrestodianLocalPlannerBackendKind,
} from "./assistant-backends.js";
import { CRESTODIAN_AGENT_SYSTEM_PROMPT } from "./assistant-prompts.js";
import type { CrestodianOverview } from "./overview.js";

/**
 * Crestodian is a real agent: same loop, session transcript, and tool pipeline
 * as regular agents — restricted to the single ring-zero `crestodian` tool.
 * Embedded runtimes enforce that restriction with toolsAllow; CLI harnesses
 * (claude-cli, gemini-cli) cannot, so they get the tool over a dedicated stdio
 * MCP server that replaces the normal bundle MCP surface for the run. Turns
 * share one persistent session so the conversation has genuine multi-turn
 * memory. When no loop-capable backend exists, the caller falls back to the
 * single-turn planner.
 */
export const CRESTODIAN_AGENT_ID = "crestodian";

const AGENT_TURN_TIMEOUT_MS = 120_000;

export type CrestodianAgentTurnDirective =
  import("../agents/tools/crestodian-tool.js").CrestodianToolDirective;

export type CrestodianAgentTurnReply = {
  text: string;
  modelLabel?: string;
  /** Interactive handoff the tool requested; the host chat executes it. */
  directive?: CrestodianAgentTurnDirective;
};

export type CrestodianAgentTurnRunner = (params: {
  input: string;
  overview: CrestodianOverview;
  surface: "cli" | "gateway";
  /** Host-verified: the user's current message is an explicit approval. */
  approvalArmed: boolean;
  session: CrestodianAgentSession;
}) => Promise<CrestodianAgentTurnReply | null>;

export type CrestodianAgentSession = {
  sessionId: string;
  /** Host-owned pending-proposal fingerprint; see crestodian-tool.ts. */
  proposalRef: { current?: string };
  /** Native CLI session plus the fingerprints that make --resume safe. */
  cliSessionBinding?: CliSessionBinding;
  /** CLI backend that owns cliSessionBinding; native sessions are not portable. */
  cliSessionBackendId?: string;
  /** Stable peer choice for this multi-turn conversation. */
  localBackendPreference?: Extract<
    CrestodianLocalPlannerBackendKind,
    "claude-cli" | "codex-app-server"
  >;
};

export function createCrestodianAgentSession(): CrestodianAgentSession {
  return { sessionId: `crestodian-${randomUUID()}`, proposalRef: {} };
}

export type CrestodianAgentTurnDeps = {
  runEmbeddedAgent?: typeof import("../agents/embedded-agent.js").runEmbeddedAgent;
  runCliAgent?: typeof import("../agents/cli-runner.js").runCliAgent;
  readConfigFileSnapshot?: typeof import("../config/config.js").readConfigFileSnapshot;
  randomInt?: (maxExclusive: number) => number;
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

function discardUnannouncedProposal(
  proposalRef: { current?: string },
  proposalBeforeTurn: string | undefined,
): void {
  // A failed/invisible turn cannot leave a newly registered mutation armable:
  // the planner fallback never showed that proposal to the user. Preserve a
  // previously visible proposal, but keep a consumed approval consumed.
  if (proposalRef.current !== undefined && proposalRef.current !== proposalBeforeTurn) {
    proposalRef.current = proposalBeforeTurn;
  }
}

async function ensureCrestodianDirs(
  sessionId: string,
): Promise<{ workspaceDir: string; sessionFile: string }> {
  const base = path.join(resolveStateDir(), "crestodian");
  const workspaceDir = path.join(base, "workspace");
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.mkdir(path.join(base, "sessions"), { recursive: true });
  return { workspaceDir, sessionFile: path.join(base, "sessions", `${sessionId}.jsonl`) };
}

export async function cleanupCrestodianAgentSession(
  session: CrestodianAgentSession,
): Promise<void> {
  const sessionFile = path.join(
    resolveStateDir(),
    "crestodian",
    "sessions",
    `${session.sessionId}.jsonl`,
  );
  await fs.rm(sessionFile, { force: true });
}

type CrestodianAgentTurnParams = Parameters<CrestodianAgentTurnRunner>[0];

type RunConfig = import("../config/types.openclaw.js").OpenClawConfig;

type CrestodianAgentTurnPlan =
  | {
      runner: "cli";
      runConfig: RunConfig;
      modelLabel: string;
      provider: string;
      model: string;
      backendId: string;
      localBackendPreference?: Extract<
        CrestodianLocalPlannerBackendKind,
        "claude-cli" | "codex-app-server"
      >;
    }
  | {
      runner: "embedded";
      runConfig: RunConfig;
      modelLabel: string;
      provider?: string;
      model?: string;
      /** Credential store owned by the agent whose configured model this turn borrows. */
      agentDir?: string;
      agentHarnessId?: string;
      agentHarnessRuntimeOverride?: string;
      localBackendPreference?: Extract<
        CrestodianLocalPlannerBackendKind,
        "claude-cli" | "codex-app-server"
      >;
    };

async function planCrestodianAgentTurn(
  params: CrestodianAgentTurnParams,
  deps: CrestodianAgentTurnDeps,
  workspaceDir: string,
): Promise<CrestodianAgentTurnPlan | null> {
  const configuredModel = params.overview.defaultModel;
  if (configuredModel) {
    const readSnapshot =
      deps.readConfigFileSnapshot ?? (await import("../config/config.js")).readConfigFileSnapshot;
    const snapshot = await readSnapshot();
    const runConfig = snapshot.runtimeConfig ?? snapshot.config ?? {};
    const [
      { isCliProvider, resolveDefaultModelForAgent },
      { resolveAgentDir, resolveDefaultAgentId },
    ] = await Promise.all([
      import("../agents/model-selection.js"),
      import("../agents/agent-scope.js"),
    ]);
    const defaultAgentId = resolveDefaultAgentId(runConfig);
    const agentDir = resolveAgentDir(runConfig, defaultAgentId);
    const ref = resolveDefaultModelForAgent({ cfg: runConfig, agentId: defaultAgentId });
    if (isCliProvider(ref.provider, runConfig)) {
      return {
        runner: "cli",
        runConfig,
        modelLabel: configuredModel,
        provider: ref.provider,
        model: ref.model,
        backendId: ref.provider,
      };
    }
    const { resolveAgentHarnessPolicy } = await import("../agents/harness/policy.js");
    const runtime = resolveAgentHarnessPolicy({
      config: runConfig,
      provider: ref.provider,
      modelId: ref.model,
      agentId: defaultAgentId,
    }).runtime;
    return {
      runner: "embedded",
      runConfig,
      modelLabel: configuredModel,
      provider: ref.provider,
      model: ref.model,
      agentDir,
      ...(runtime === "auto" ? {} : { agentHarnessRuntimeOverride: runtime }),
    };
  }
  // No configured model: fall back to a locally detected runtime. Claude Code
  // and Codex are randomized peers when both are available.
  const selectionOptions: Parameters<typeof selectCrestodianLocalPlannerBackends>[1] = {};
  if (deps.randomInt) {
    selectionOptions.randomInt = deps.randomInt;
  }
  if (params.session.localBackendPreference) {
    selectionOptions.preferredKind = params.session.localBackendPreference;
  }
  const backend = selectCrestodianLocalPlannerBackends(params.overview, selectionOptions)[0];
  if (!backend) {
    return null;
  }
  const base = {
    runConfig: backend.buildConfig(workspaceDir),
    modelLabel: backend.label,
    provider: backend.provider,
    model: backend.model,
    backendId: backend.kind,
    ...(backend.kind === "claude-cli" || backend.kind === "codex-app-server"
      ? { localBackendPreference: backend.kind }
      : {}),
  };
  return backend.runner === "cli"
    ? { runner: "cli", ...base }
    : { runner: "embedded", agentHarnessId: "codex", ...base };
}

/**
 * CLI harnesses run the crestodian tool in a stdio MCP subprocess, so the
 * in-process proposalRef/directiveRef cannot be shared with the host. Mirror
 * the tool's transitions from the harness tool events instead: a denial
 * registers the exact-operation hash, a mismatch voids it, an executed
 * mutation consumes it, and directive actions replay the interactive handoff —
 * same lifecycle as crestodian-tool.ts enforces.
 */
async function mirrorCrestodianToolStateFromEvents(params: {
  runId: string;
  proposalRef: { current?: string };
  directiveRef: { current?: CrestodianAgentTurnDirective };
}): Promise<() => void> {
  const [
    { onAgentEvent },
    { extractToolResultText },
    { resolveCrestodianProposalTransition, resolveCrestodianDirectiveTransition },
  ] = await Promise.all([
    import("../infra/agent-events.js"),
    import("../agents/embedded-agent-subscribe.tools.js"),
    import("../agents/tools/crestodian-tool.js"),
  ]);
  return onAgentEvent((evt) => {
    if (evt.runId !== params.runId || evt.stream !== "tool" || evt.data.phase !== "result") {
      return;
    }
    const name = typeof evt.data.name === "string" ? evt.data.name : "";
    // CLI harnesses report MCP tools with transport prefixes (mcp__openclaw__crestodian).
    if (name !== "crestodian" && !name.endsWith("__crestodian")) {
      return;
    }
    const args =
      typeof evt.data.args === "object" && evt.data.args !== null
        ? (evt.data.args as Record<string, unknown>)
        : {};
    const resultText = extractToolResultText(evt.data.result) ?? "";
    const transition = resolveCrestodianProposalTransition({ args, resultText });
    if (transition) {
      params.proposalRef.current = transition.proposal;
    }
    const directive = resolveCrestodianDirectiveTransition({ args, resultText });
    if (directive) {
      params.directiveRef.current = directive;
    }
  });
}

/**
 * Run one Crestodian turn through the embedded agent loop. Returns null when
 * no loop-capable backend is available or the run fails, so the caller can
 * degrade to the planner.
 */
export async function runCrestodianAgentTurnWithDeps(
  params: CrestodianAgentTurnParams,
  deps: CrestodianAgentTurnDeps = {},
): Promise<CrestodianAgentTurnReply | null> {
  const { workspaceDir, sessionFile } = await ensureCrestodianDirs(params.session.sessionId);
  const plan = await planCrestodianAgentTurn(params, deps, workspaceDir);
  if (!plan) {
    return null;
  }

  const runId = `crestodian-turn-${randomUUID()}`;
  const shared = {
    sessionId: params.session.sessionId,
    sessionKey: buildAgentMainSessionKey({ agentId: CRESTODIAN_AGENT_ID }),
    agentId: CRESTODIAN_AGENT_ID,
    trigger: "manual" as const,
    sessionFile,
    workspaceDir,
    config: plan.runConfig,
    prompt: params.input,
    timeoutMs: AGENT_TURN_TIMEOUT_MS,
    runId,
    messageChannel: "crestodian",
    messageProvider: "crestodian",
  };
  // Directives are per-turn: the tool records at most one interactive handoff
  // and the engine executes it after the reply.
  const directiveRef: { current?: CrestodianAgentTurnDirective } = {};
  const crestodianTool = {
    surface: params.surface,
    approvalArmed: params.approvalArmed,
    proposalRef: params.session.proposalRef,
    directiveRef,
  };
  const proposalBeforeTurn = params.session.proposalRef.current;

  try {
    let result: EmbeddedRunResult;
    if (plan.runner === "cli") {
      if (params.session.cliSessionBackendId !== plan.backendId) {
        delete params.session.cliSessionBinding;
        delete params.session.cliSessionBackendId;
      }
      const runCli = deps.runCliAgent ?? (await import("../agents/cli-runner.js")).runCliAgent;
      const stopToolStateMirror = await mirrorCrestodianToolStateFromEvents({
        runId,
        proposalRef: params.session.proposalRef,
        directiveRef,
      });
      try {
        result = (await runCli({
          ...shared,
          provider: plan.provider,
          model: plan.model,
          extraSystemPrompt: CRESTODIAN_AGENT_SYSTEM_PROMPT,
          extraSystemPromptStatic: CRESTODIAN_AGENT_SYSTEM_PROMPT,
          crestodianTool,
          ...(params.session.cliSessionBinding
            ? {
                cliSessionId: params.session.cliSessionBinding.sessionId,
                cliSessionBinding: params.session.cliSessionBinding,
              }
            : {}),
          cleanupCliLiveSessionOnRunEnd: true,
        })) as EmbeddedRunResult;
      } finally {
        stopToolStateMirror();
      }
      // Thread the harness's own session forward so the next turn resumes the
      // native CLI transcript instead of reseeding from scratch.
      const agentMeta = result.meta?.agentMeta;
      if (agentMeta?.clearCliSessionBinding) {
        delete params.session.cliSessionBinding;
        delete params.session.cliSessionBackendId;
      } else if (agentMeta?.cliSessionBinding?.sessionId.trim()) {
        params.session.cliSessionBinding = agentMeta.cliSessionBinding;
        params.session.cliSessionBackendId = plan.backendId;
      }
    } else {
      delete params.session.cliSessionBinding;
      delete params.session.cliSessionBackendId;
      const runEmbedded =
        deps.runEmbeddedAgent ?? (await import("../agents/embedded-agent.js")).runEmbeddedAgent;
      result = (await runEmbedded({
        ...shared,
        extraSystemPrompt: CRESTODIAN_AGENT_SYSTEM_PROMPT,
        toolsAllow: ["crestodian"],
        crestodianTool,
        disableMessageTool: true,
        ...(plan.provider ? { provider: plan.provider } : {}),
        ...(plan.model ? { model: plan.model } : {}),
        ...(plan.agentDir ? { agentDir: plan.agentDir } : {}),
        ...(plan.agentHarnessId
          ? { agentHarnessId: plan.agentHarnessId, cleanupBundleMcpOnRunEnd: true }
          : {}),
        ...(plan.agentHarnessRuntimeOverride
          ? { agentHarnessRuntimeOverride: plan.agentHarnessRuntimeOverride }
          : {}),
      })) as EmbeddedRunResult;
    }
    const text = extractRunText(result)?.trim();
    if (!text) {
      discardUnannouncedProposal(params.session.proposalRef, proposalBeforeTurn);
      return null;
    }
    // A detected binary is not necessarily authenticated or usable. Pin a
    // randomized peer only after it produces a real reply, so a broken peer
    // cannot own every later turn in this conversation.
    if (plan.localBackendPreference) {
      params.session.localBackendPreference = plan.localBackendPreference;
    }
    return {
      text,
      modelLabel: plan.modelLabel,
      ...(directiveRef.current ? { directive: directiveRef.current } : {}),
    };
  } catch {
    // Loop unavailable for this backend (missing CLI, auth failure, timeout):
    // the conversation must keep working, so degrade to the planner path.
    discardUnannouncedProposal(params.session.proposalRef, proposalBeforeTurn);
    return null;
  }
}

export const runCrestodianAgentTurn: CrestodianAgentTurnRunner = (params) =>
  runCrestodianAgentTurnWithDeps(params);

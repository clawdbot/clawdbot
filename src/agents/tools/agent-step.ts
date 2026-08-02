/**
 * Nested agent-step executor.
 *
 * Sends annotated inter-session messages through in-process or Gateway execution and reads the assistant reply.
 */
import crypto from "node:crypto";
import { annotateInterSessionPromptText } from "../../sessions/input-provenance.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { noAgentRunApprovalHost, type AgentRunApprovalHost } from "../agent-run-approval.js";
import { resolveNestedAgentLaneForSession } from "../lanes.js";

type AgentCommandRunner = typeof import("../../commands/agent.js").agentCommandFromIngress;

const defaultAgentStepDeps = {
  agentCommandFromIngress: (async (...args) => {
    const { agentCommandFromIngress } = await import("../../commands/agent.js");
    return await agentCommandFromIngress(...args);
  }) as AgentCommandRunner,
};

let agentStepDeps: {
  agentCommandFromIngress: AgentCommandRunner;
} = defaultAgentStepDeps;

function extractAgentCommandReply(result: unknown): string | undefined {
  const candidate = result as { meta?: { error?: unknown }; payloads?: unknown } | null | undefined;
  const error =
    candidate?.meta?.error &&
    typeof candidate.meta.error === "object" &&
    !Array.isArray(candidate.meta.error)
      ? (candidate.meta.error as { kind?: unknown; terminalPresentation?: unknown })
      : undefined;
  // Plain incomplete-turn output is a control failure; trusted terminal tool presentations remain deliverable.
  if (error?.kind === "incomplete_turn" && error.terminalPresentation !== true) {
    return undefined;
  }
  const payloads = candidate?.payloads;
  if (!Array.isArray(payloads)) {
    return undefined;
  }
  const texts = payloads
    .map((payload) =>
      payload &&
      typeof payload === "object" &&
      typeof (payload as { text?: unknown }).text === "string"
        ? (payload as { text: string }).text
        : "",
    )
    .filter((text) => text.trim().length > 0);
  return texts.length > 0 ? texts.join("\n\n") : undefined;
}

/** Sends one annotated message to a target session and returns the resulting assistant text. */
export async function runAgentStep(params: {
  sessionKey: string;
  message: string;
  extraSystemPrompt: string;
  timeoutMs: number;
  channel?: string;
  lane?: string;
  transcriptMessage?: string;
  sourceSessionKey?: string;
  sourceChannel?: string;
  sourceTool?: string;
  approvalHost?: AgentRunApprovalHost;
}): Promise<string | undefined> {
  const runId = crypto.randomUUID();
  const inputProvenance = {
    kind: "inter_session" as const,
    sourceSessionKey: params.sourceSessionKey,
    sourceChannel: params.sourceChannel,
    sourceTool: params.sourceTool ?? "sessions_send",
  };
  // Mark inter-session prompts so downstream transcripts can distinguish tool-routed text.
  const message = annotateInterSessionPromptText(params.message, inputProvenance);
  const lane = params.lane ?? resolveNestedAgentLaneForSession(params.sessionKey);
  const channel = params.channel ?? INTERNAL_MESSAGE_CHANNEL;
  // Nested turns inherit an exact process capability, including explicit absence.
  // Sending them through Gateway transport would silently replace no-host with Gateway ownership.
  const timeoutMs = Math.max(1, Math.min(params.timeoutMs, 60_000));
  const timeoutController = new AbortController();
  const timeoutError = new DOMException(
    `Nested agent step timed out after ${timeoutMs}ms`,
    "TimeoutError",
  );
  const timer = setTimeout(() => timeoutController.abort(timeoutError), timeoutMs);
  const commandOutcome = agentStepDeps
    .agentCommandFromIngress({
      message,
      transcriptMessage: params.transcriptMessage,
      sessionKey: params.sessionKey,
      deliver: false,
      sourceReplyDeliveryMode: "message_tool_only",
      channel,
      lane,
      runId,
      extraSystemPrompt: params.extraSystemPrompt,
      inputProvenance,
      allowModelOverride: false,
      approvalHost: params.approvalHost ?? noAgentRunApprovalHost,
      abortSignal: timeoutController.signal,
      // The command owns its exact run lifetime. Its backend retires MCP only
      // after that run stops, so a timed-out caller cannot tear down a newer turn.
      cleanupBundleMcpOnRunEnd: true,
    })
    .then(
      (result) => ({ status: "completed" as const, result }),
      (error: unknown) => ({ status: "failed" as const, error }),
    );
  const timeoutOutcome = new Promise<{ status: "timed_out" }>((resolve) => {
    timeoutController.signal.addEventListener("abort", () => resolve({ status: "timed_out" }), {
      once: true,
    });
  });
  const outcome = await Promise.race([commandOutcome, timeoutOutcome]);
  if (outcome.status === "timed_out") {
    // The caller deadline is authoritative even if a backend delays abort handling.
    // The still-running command keeps ownership of its own backend cleanup.
    return undefined;
  }
  clearTimeout(timer);
  if (outcome.status === "failed") {
    throw outcome.error;
  }
  return extractAgentCommandReply(outcome.result);
}

/** Test-only dependency overrides for gateway and in-process command execution. */
const testing = {
  setDepsForTest(
    overrides?: Partial<{
      agentCommandFromIngress: AgentCommandRunner;
    }>,
  ) {
    agentStepDeps = overrides
      ? {
          ...defaultAgentStepDeps,
          ...overrides,
        }
      : defaultAgentStepDeps;
  },
};

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.agentStepTestApi")] = {
    testing,
  };
}

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { prepareSystemAgentRunAdmission } from "../agents/admitted-run-context.js";
import {
  type AgentRunResultView,
  extractAgentRunTerminalError,
  extractAgentRunText,
} from "../agents/agent-run-result.js";
import type { AgentExecutionAuthBinding } from "../agents/execution-auth-binding.js";
import { describeFailoverError } from "../agents/failover-error.js";
import { supportsModelTools } from "../agents/model-tool-support.js";
import { SessionManager } from "../agents/sessions/index.js";
import {
  type ActivateSetupInferenceDeps,
  SETUP_INFERENCE_TEST_PROMPT,
  SETUP_INFERENCE_TEST_TIMEOUT_MS,
  SetupInferenceCancelledError,
  type SetupInferenceFailureStatus,
  setupInferenceLog,
} from "./setup-inference-core.js";
import {
  type SetupInferenceTestPlan,
  extractRunWinnerError,
  mapFailoverReasonToSetupStatus,
  resolveStrictSetupAuthProfileError,
  resolveToolFreeCliSetupError,
} from "./setup-inference-plan-helpers.js";
import { resolveSetupInferenceProbeStreamParams } from "./setup-inference-probe.js";

type SetupInferenceTestParams = {
  plan: SetupInferenceTestPlan;
  prompt?: string;
  tempDir: string;
  deps: ActivateSetupInferenceDeps;
  authProfileStateMode: "read-write" | "read-only";
  requireExecutionOwner: boolean;
  /** Explicit setup activation may verify tool use before committing its selected managed route. */
  verifyAgentTools?: boolean;
  signal?: AbortSignal;
};

type SetupInferenceTestResult =
  | { ok: true; latencyMs: number; auth: AgentExecutionAuthBinding; text: string }
  | {
      ok: false;
      status: SetupInferenceFailureStatus;
      error: string;
    };

type SetupAgentProbe = {
  onAgentToolResult: NonNullable<
    Parameters<NonNullable<ActivateSetupInferenceDeps["runEmbeddedAgent"]>>[0]["onAgentToolResult"]
  >;
};

export async function runSetupInferenceTest(
  params: SetupInferenceTestParams,
): Promise<SetupInferenceTestResult> {
  const connection = await runSetupInferenceProbe(params);
  const provider = params.plan.config.models?.providers?.[params.plan.provider];
  const model = provider?.models.find((entry) => entry.id === params.plan.model);
  if (
    !connection.ok ||
    !params.verifyAgentTools ||
    params.prompt !== undefined ||
    params.plan.runner !== "embedded" ||
    !provider?.localService ||
    !supportsModelTools(model ?? {})
  ) {
    return connection;
  }

  const workspace = await fs.realpath(await fs.mkdtemp(path.join(params.tempDir, "agent-check-")));
  let acceptingResults = true;
  try {
    const nonce = randomUUID();
    const fixture = path.join(workspace, "verification.txt");
    await fs.writeFile(fixture, nonce, { mode: 0o600 });
    let observedRead = false;
    const verified = await runSetupInferenceProbe(
      {
        ...params,
        tempDir: workspace,
        plan: {
          ...params.plan,
          ...(connection.auth.authProfileId
            ? { authProfileId: connection.auth.authProfileId }
            : {}),
        },
        // The answer exists only in a read-only fixture outside the temporary auth store.
        prompt: `Read ${JSON.stringify(fixture)} using the available tools. Reply with the complete file contents. Do not modify files or perform any other task.`,
      },
      {
        onAgentToolResult: ({ toolName, result, isError }) => {
          if (
            !acceptingResults ||
            toolName !== "read" ||
            isError ||
            !isRecord(result) ||
            !Array.isArray(result.content)
          ) {
            return;
          }
          observedRead ||= result.content.some(
            (item) =>
              isRecord(item) &&
              item.type === "text" &&
              typeof item.text === "string" &&
              item.text.includes(nonce),
          );
        },
      },
    );
    if (!verified.ok) {
      return verified;
    }
    if (!observedRead || !verified.text.includes(nonce)) {
      return {
        ok: false,
        status: "format",
        error:
          "The local model answered a simple prompt but could not read and return a file through an OpenClaw tool. Choose another model or review its tool support, then retry setup. No default model was changed.",
      };
    }
    if (!isDeepStrictEqual(connection.auth, verified.auth)) {
      return {
        ok: false,
        status: "auth",
        error:
          "The local model's execution owner changed during tool verification. Retry setup before selecting it as the default.",
      };
    }
    return { ...verified, latencyMs: connection.latencyMs + verified.latencyMs };
  } finally {
    acceptingResults = false;
    await fs.rm(workspace, { recursive: true, force: true }).catch(() => {
      setupInferenceLog.warn("Could not remove the temporary local model verification file.");
    });
  }
}

async function runSetupInferenceProbe(
  params: SetupInferenceTestParams,
  agentProbe?: SetupAgentProbe,
): Promise<SetupInferenceTestResult> {
  const { plan, tempDir, deps, authProfileStateMode, requireExecutionOwner } = params;
  // Keep probe prefixes aligned with the logging filters; provider transports can also use the
  // session id as cache affinity, so this ephemeral id must stay under OpenAI's 64-character cap.
  const runId = `probe-setup-inference-${randomUUID()}`;
  const sessionId = runId;
  const sessionFile = `in-memory:${sessionId}`;
  const sessionManager = SessionManager.inMemory(tempDir);
  const effectiveAgentId = plan.routeAgentId ?? plan.agentId ?? "openclaw";
  const sessionKey = `agent:${effectiveAgentId}:setup-inference:incognito-${runId}`;
  const timeoutMs = deps.timeoutMs ?? SETUP_INFERENCE_TEST_TIMEOUT_MS;
  const started = Date.now();
  const failed = (status: SetupInferenceFailureStatus, error: string) => {
    setupInferenceLog.warn("Inference setup probe failed.", {
      event: "setup_inference_probe_failed",
      provider: plan.provider,
      model: plan.model,
      runner: plan.runner,
      status,
      timeoutMs,
      durationMs: Date.now() - started,
    });
    return { ok: false as const, status, error };
  };
  const preparedRunAdmission = prepareSystemAgentRunAdmission(
    plan.config,
    runId,
    effectiveAgentId,
    "system-agent.setup-inference",
  );
  let successfulAuth: AgentExecutionAuthBinding | undefined;
  try {
    if (plan.runner === "cli") {
      const unsupportedError = resolveToolFreeCliSetupError(plan);
      if (unsupportedError) {
        return failed("unavailable", unsupportedError);
      }
    }
    const strictProfileError = resolveStrictSetupAuthProfileError({
      plan,
      workspaceDir: tempDir,
      deps,
    });
    if (strictProfileError) {
      return failed("auth", strictProfileError);
    }

    let result: AgentRunResultView;
    if (plan.runner === "cli") {
      const runCli = deps.runCliAgent ?? (await import("../agents/cli-runner.js")).runCliAgent;
      result = await runCli({
        preparedRunAdmission,
        sessionId,
        sessionKey,
        sessionManager,
        agentId: effectiveAgentId,
        trigger: "manual",
        sessionFile,
        workspaceDir: tempDir,
        ...(plan.agentDir ? { agentDir: plan.agentDir } : {}),
        config: plan.executionConfig ?? plan.config,
        prompt: params.prompt ?? SETUP_INFERENCE_TEST_PROMPT,
        provider: plan.provider,
        model: plan.model,
        ...(plan.authProfileId ? { authProfileId: plan.authProfileId } : {}),
        timeoutMs,
        runId,
        messageChannel: "openclaw",
        messageProvider: "openclaw",
        executionMode: "side-question",
        disableTools: true,
        cleanupCliLiveSessionOnRunEnd: true,
        onSuccessfulAuthBinding: (binding) => {
          successfulAuth = binding;
        },
        ...(params.signal ? { abortSignal: params.signal } : {}),
      });
    } else {
      const runEmbedded =
        deps.runEmbeddedAgent ?? (await import("../agents/embedded-agent.js")).runEmbeddedAgent;
      result = await runEmbedded({
        preparedRunAdmission,
        sessionId,
        sessionKey,
        sessionManager,
        // The probe owns its transcript; session admission must not create durable agent state.
        sessionPersistence: "detached",
        agentId: effectiveAgentId,
        trigger: "manual",
        sessionFile,
        workspaceDir: tempDir,
        ...(plan.agentDir ? { agentDir: plan.agentDir } : {}),
        config: plan.executionConfig ?? plan.config,
        prompt: params.prompt ?? SETUP_INFERENCE_TEST_PROMPT,
        provider: plan.provider,
        model: plan.model,
        ...(plan.authProfileId
          ? { authProfileId: plan.authProfileId, authProfileIdSource: "user" as const }
          : {}),
        authProfileStateMode,
        preparedModelRuntimeMode: "isolated-read-only",
        ...(plan.cleanupBundleMcpOnRunEnd ? { cleanupBundleMcpOnRunEnd: true } : {}),
        ...(plan.agentHarnessRuntimeOverride
          ? { agentHarnessRuntimeOverride: plan.agentHarnessRuntimeOverride }
          : {}),
        timeoutMs,
        runId,
        lane: `session:probe-setup-inference:${plan.provider}`,
        thinkLevel: "off",
        reasoningLevel: "off",
        verboseLevel: "off",
        disableTrajectory: true,
        // Keep the "reply OK" probe bounded while leaving room for reasoning.
        // Custom completions pass no explicit cap: the stream layer applies the
        // resolved model's own maxTokens budget without exceeding its limits.
        ...(params.prompt === undefined
          ? resolveSetupInferenceProbeStreamParams(plan.agentHarnessRuntimeOverride)
          : {}),
        ...(agentProbe
          ? {
              permissionMode: "read-only" as const,
              sessionRoot: tempDir,
              toolsAllow: ["read"],
              toolExecutionAllow: ["read"],
              onAgentToolResult: agentProbe.onAgentToolResult,
            }
          : { disableTools: true, modelRun: true }),
        messageChannel: "openclaw",
        messageProvider: "openclaw",
        onSuccessfulAuthBinding: (binding) => {
          successfulAuth = binding;
        },
        ...(params.signal ? { abortSignal: params.signal } : {}),
      });
    }
    if (params.signal?.aborted) {
      throw new SetupInferenceCancelledError();
    }
    const terminalError = extractAgentRunTerminalError(result);
    if (terminalError) {
      const described = describeFailoverError(new Error(terminalError));
      return failed(mapFailoverReasonToSetupStatus(described.reason), described.message);
    }
    const text = extractAgentRunText(result)?.trim();
    if (!text) {
      return failed(
        "format",
        "The model started but did not send a reply. Try again or pick another option.",
      );
    }
    const winnerError = await extractRunWinnerError(plan, result);
    if (winnerError) {
      return failed("unknown", winnerError);
    }
    if (requireExecutionOwner && !successfulAuth) {
      return failed(
        "unknown",
        "Inference succeeded, but its runtime did not report an owner that OpenClaw can safely reuse.",
      );
    }
    return {
      ok: true,
      latencyMs: Date.now() - started,
      text,
      auth:
        successfulAuth ??
        (!requireExecutionOwner && plan.authProfileId ? { authProfileId: plan.authProfileId } : {}),
    };
  } catch (error) {
    const described = describeFailoverError(error);
    return failed(mapFailoverReasonToSetupStatus(described.reason), described.message);
  } finally {
    preparedRunAdmission.close();
  }
}

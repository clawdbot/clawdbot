import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type {
  CliBackendExecute,
  CliBackendExecuteContext,
} from "../../plugins/cli-backend.types.js";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import { buildPreparedCliRunContext } from "../cli-runner.test-helpers.js";
import { executePluginOwnedProcess } from "./execute-plugin.js";
import type { PreparedCliRunContext, RunCliAgentParams } from "./types.js";

const activeAdmissions: Array<ReturnType<typeof prepareSystemAgentRunAdmission>> = [];
let nextRunId = 0;

export const SUCCESS_RESULT = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: "completed",
  session_id: "sdk-session",
};

export async function createExecution(
  options: {
    config?: OpenClawConfig;
    sessionEntry?: RunCliAgentParams["sessionEntry"];
    nativeTools?: string[];
    abortSignal?: AbortSignal;
    timeoutMs?: number;
    runId?: string;
    resumeArgs?: string[];
  } = {},
) {
  const runId = options.runId ?? `plugin-owner-${++nextRunId}`;
  const config = options.config ?? { tools: { exec: { security: "full", ask: "off" } } };
  const admission = prepareSystemAgentRunAdmission(config, runId, "main", "plugin-test");
  activeAdmissions.push(admission);
  const context = buildPreparedCliRunContext({
    provider: "claude-cli",
    model: "claude-sonnet-4-6",
    agentId: "main",
    runId,
    sessionId: "sdk-session",
    sessionKey: "agent:main:main",
    prompt: "hello",
    config,
    executionMode: "agent",
    timeoutMs: options.timeoutMs ?? 5_000,
    sessionEntry: options.sessionEntry,
    ...(options.nativeTools
      ? { cliToolAvailability: { native: options.nativeTools, openClaw: [] } }
      : {}),
    systemPrompt: "  Follow host policy.  ",
    backend: {
      command: "/bin/sh",
      args: [],
      ...(options.resumeArgs ? { resumeArgs: options.resumeArgs } : {}),
    },
  });
  context.params.admittedRunContext = await admission.admit("plugin-harness");
  if (options.abortSignal) {
    context.params.abortSignal = options.abortSignal;
  }

  return { admission, context };
}

export function runPlugin(
  context: PreparedCliRunContext,
  execute: CliBackendExecute,
  options: {
    noOutputTimeoutMs?: number;
    consumeStdout?: (chunk: string) => void;
    sessionId?: string;
    useResume?: boolean;
    forceNewSession?: boolean;
    liveSession?: boolean;
    requiredGeneration?: string;
    onNoOutputTimeout?: NonNullable<
      Parameters<typeof executePluginOwnedProcess>[0]["onNoOutputTimeout"]
    >;
    onOutstandingWorkChange?: (active: boolean) => void;
    onInterrupted?: (reason: "aborted" | "timeout") => boolean;
  } = {},
) {
  return executePluginOwnedProcess({
    context,
    execute,
    executionCommand: "/bin/sh",
    executionArgs: ["-p", "--permission-mode", "bypassPermissions"],
    env: { PATH: "/bin:/usr/bin", OPENCLAW_TEST_MARKER: "host-owned" },
    prompt: context.params.prompt,
    promptContext: context.promptContext,
    useResume: options.useResume ?? Boolean(options.requiredGeneration),
    sessionId: options.sessionId ?? "sdk-session",
    ...(options.forceNewSession ? { forceNewSession: true } : {}),
    ...(options.liveSession || options.requiredGeneration
      ? {
          liveSession: {
            beginCapture: () => {},
            ...(options.requiredGeneration
              ? { requiredGeneration: options.requiredGeneration }
              : {}),
          },
        }
      : {}),
    ...(options.onNoOutputTimeout ? { onNoOutputTimeout: options.onNoOutputTimeout } : {}),
    onOutstandingWorkChange: options.onOutstandingWorkChange,
    ...(options.onInterrupted ? { onInterrupted: options.onInterrupted } : {}),
    noOutputTimeoutMs: options.noOutputTimeoutMs ?? 2_000,
    consumeStdout: options.consumeStdout ?? (() => {}),
  });
}

export function requestNativeTool(
  execution: CliBackendExecuteContext,
  toolName = "Bash",
  toolInput: Record<string, unknown> = { command: "echo approved" },
) {
  return execution.requestToolPermission({
    toolName,
    toolInput,
    toolCallId: `native-${toolName}`,
    ...(execution.abortSignal ? { abortSignal: execution.abortSignal } : {}),
  });
}

export function closePluginTestAdmissions(): void {
  for (const admission of activeAdmissions.splice(0)) {
    admission.close();
  }
}

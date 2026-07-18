import { createExecApprovalPolicySnapshot } from "../infra/exec-approvals.js";
import type { scanInstalledApps } from "../infra/installed-apps.js";
import type { OpenClawPluginNodeHostCommandIo } from "../plugins/types.js";
import type { OpenClawPluginNodeHostCommandContext } from "../plugins/types.node-host.js";
import type { NodeHostClient } from "./client.js";
import {
  decodeClaudeCliNodeRunParams,
  type ClaudeCliNodeRunParams,
  type ClaudeCliNodeRunResult,
} from "./invoke-agent-cli-claude-params.js";
import { runClaudeCliNodeCommand } from "./invoke-agent-cli-claude.js";
import {
  buildSystemRunApprovalPlan,
  handleSystemRunInvoke,
  resolveEffectiveSystemRunExecPolicy,
} from "./invoke-system-run.js";
import type { NodeInvokeRequestPayload, RunResult, SkillBinsProvider } from "./invoke-types.js";

export type NodeHostInvokeRuntime = {
  claudePath?: string;
  handleSystemRun?: typeof handleSystemRunInvoke;
  signal?: AbortSignal;
  pluginCommandIo?: OpenClawPluginNodeHostCommandIo;
  pluginCommandContext?: OpenClawPluginNodeHostCommandContext;
  installedAppsSharingEnabled?: boolean;
  installedAppsPlatform?: NodeJS.Platform;
  scanInstalledApps?: typeof scanInstalledApps;
};

type ClaudeCliNodeInvokeDeps = Pick<
  Parameters<typeof handleSystemRunInvoke>[0],
  | "resolveExecSecurity"
  | "resolveExecAsk"
  | "isCmdExeInvocation"
  | "sanitizeEnv"
  | "runViaMacAppExecHost"
  | "buildExecEventPayload"
> & {
  sendErrorResult: (
    client: NodeHostClient,
    frame: NodeInvokeRequestPayload,
    code: string,
    message: string,
  ) => Promise<void>;
  sendInvalidRequestResult: (
    client: NodeHostClient,
    frame: NodeInvokeRequestPayload,
    error: unknown,
  ) => Promise<void>;
  sendInvokeResult: (
    client: NodeHostClient,
    frame: NodeInvokeRequestPayload,
    result: {
      ok: boolean;
      payload?: unknown;
      payloadJSON?: string | null;
      error?: { code?: string; message?: string } | null;
    },
  ) => Promise<void>;
};

export async function handleClaudeCliNodeInvoke(params: {
  frame: NodeInvokeRequestPayload;
  client: NodeHostClient;
  skillBins: SkillBinsProvider;
  runtime: NodeHostInvokeRuntime;
  deps: ClaudeCliNodeInvokeDeps;
}): Promise<void> {
  if (!params.runtime.claudePath) {
    await params.deps.sendErrorResult(
      params.client,
      params.frame,
      "UNAVAILABLE",
      "Claude CLI agent runs are unavailable",
    );
    return;
  }
  const claudePath = params.runtime.claudePath;
  let request: ClaudeCliNodeRunParams;
  try {
    request = await decodeClaudeCliNodeRunParams(params.frame.paramsJSON);
  } catch (error) {
    await params.deps.sendInvalidRequestResult(params.client, params.frame, error);
    return;
  }
  const approvalCommand = [claudePath, ...request.argv];
  const preparedApproval = buildSystemRunApprovalPlan({
    command: approvalCommand,
    ...(request.cwd ? { cwd: request.cwd } : {}),
    ...(request.agentId ? { agentId: request.agentId } : {}),
    ...(request.sessionKey ? { sessionKey: request.sessionKey } : {}),
  });
  if (!preparedApproval.ok) {
    await params.deps.sendErrorResult(
      params.client,
      params.frame,
      "INVALID_REQUEST",
      preparedApproval.message,
    );
    return;
  }
  const { getRuntimeConfig: getNodeRuntimeConfig } = await import("../config/config.js");
  const execPolicy = await resolveEffectiveSystemRunExecPolicy({
    cfg: getNodeRuntimeConfig(),
    agentId: request.agentId,
    defaultSecurity: params.deps.resolveExecSecurity(undefined),
    defaultAsk: params.deps.resolveExecAsk(undefined),
    requireSocket: false,
  });
  const approvalPlan = {
    ...preparedApproval.plan,
    policySnapshot: createExecApprovalPolicySnapshot({
      file: execPolicy.approvals.file,
      agentId: request.agentId,
    }),
  };
  let runResult: RunResult | undefined;
  await (params.runtime.handleSystemRun ?? handleSystemRunInvoke)({
    client: params.client,
    // The command-specific validator is the execution boundary. Approval sees
    // every executable argument; prompt/stdin content remains request input.
    params: {
      command: approvalCommand,
      ...(request.cwd ? { cwd: request.cwd } : {}),
      ...(request.env ? { env: request.env } : {}),
      ...(request.agentId ? { agentId: request.agentId } : {}),
      ...(request.sessionKey ? { sessionKey: request.sessionKey } : {}),
      ...(request.systemRunPlan ? { systemRunPlan: request.systemRunPlan } : {}),
      ...(request.approvalDecision ? { approvalDecision: request.approvalDecision } : {}),
      timeoutMs: request.timeoutMs,
    },
    skillBins: params.skillBins,
    execHostEnforced: false,
    execHostFallbackAllowed: true,
    resolveExecSecurity: params.deps.resolveExecSecurity,
    resolveExecAsk: params.deps.resolveExecAsk,
    isCmdExeInvocation: params.deps.isCmdExeInvocation,
    sanitizeEnv: params.deps.sanitizeEnv,
    runCommand: async (approvalArgv, cwd, env, timeoutMs) => {
      runResult = await runClaudeCliNodeCommand({
        client: params.client,
        frame: params.frame,
        request,
        argv: approvalArgv,
        cwd,
        env,
        timeoutMs,
        signal: params.runtime.signal,
      });
      return runResult;
    },
    runViaMacAppExecHost: params.deps.runViaMacAppExecHost,
    // Agent runs already report through the agent-run stream. Suppress the
    // system.run lifecycle side-channel, whose Gateway provenance is scoped
    // exclusively to system.run invokes.
    sendNodeEvent: async () => {},
    buildExecEventPayload: params.deps.buildExecEventPayload,
    sendInvokeResult: async (result) => {
      if (
        !result.ok &&
        !request.approvalDecision &&
        result.error?.message?.includes("approval required")
      ) {
        await params.deps.sendInvokeResult(params.client, params.frame, {
          ok: true,
          payloadJSON: JSON.stringify({
            approvalRequired: true,
            systemRunPlan: approvalPlan,
            security: execPolicy.security,
            ask: execPolicy.ask,
          }),
        });
        return;
      }
      if (!result.ok || !runResult) {
        await params.deps.sendInvokeResult(params.client, params.frame, result);
        return;
      }
      const payload: ClaudeCliNodeRunResult = {
        exitCode: runResult.exitCode ?? 1,
        stderrTail: runResult.stderr,
        truncated: runResult.truncated,
        ...(runResult.timedOut
          ? { timeoutKind: runResult.noOutputTimedOut ? ("idle" as const) : ("hard" as const) }
          : {}),
      };
      await params.deps.sendInvokeResult(params.client, params.frame, {
        ok: true,
        payloadJSON: JSON.stringify(payload),
      });
    },
    sendExecFinishedEvent: async () => {},
    preferMacAppExecHost: false,
  });
}

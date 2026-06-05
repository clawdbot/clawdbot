/**
 * Policy promotion for Codex app-server runs that can safely use OpenClaw tool
 * approvals.
 */
import type {
  CodexAppServerRuntimeOptions,
  CodexPluginConfig,
  OpenClawExecPolicyForCodexAppServer,
} from "./config.js";

/**
 * Promotes implicit `never` approval policy to `untrusted` only when runtime
 * requirements allow OpenClaw to handle tool approvals.
 */
export function resolveCodexAppServerForOpenClawToolPolicy(params: {
  appServer: CodexAppServerRuntimeOptions;
  pluginConfig: CodexPluginConfig;
  env: NodeJS.ProcessEnv;
  shouldPromote: boolean;
  canUseUntrustedApprovalPolicy: boolean;
  execPolicy?: OpenClawExecPolicyForCodexAppServer;
}): CodexAppServerRuntimeOptions {
  if (
    !params.shouldPromote ||
    !params.canUseUntrustedApprovalPolicy ||
    params.appServer.approvalPolicy !== "never"
  ) {
    return params.appServer;
  }
  const explicitMode =
    params.execPolicy?.mode === "full" ||
    params.pluginConfig.appServer?.mode !== undefined ||
    isCodexAppServerPolicyMode(params.env.OPENCLAW_CODEX_APP_SERVER_MODE);
  const explicitApprovalPolicy =
    params.pluginConfig.appServer?.approvalPolicy !== undefined ||
    isCodexAppServerApprovalPolicy(params.env.OPENCLAW_CODEX_APP_SERVER_APPROVAL_POLICY) ||
    params.appServer.approvalPolicySource === "requirements";
  if (explicitMode || explicitApprovalPolicy) {
    return params.appServer;
  }
  return {
    ...params.appServer,
    approvalPolicy: "untrusted",
  };
}

function isCodexAppServerPolicyMode(value: unknown): boolean {
  return value === "guardian" || value === "yolo";
}

function isCodexAppServerApprovalPolicy(value: unknown): boolean {
  return (
    value === "never" || value === "on-request" || value === "on-failure" || value === "untrusted"
  );
}

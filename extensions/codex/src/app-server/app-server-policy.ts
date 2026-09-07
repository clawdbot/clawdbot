import {
  canUseCodexModelBackedApprovalsReviewerForModel,
  type CodexAppServerRuntimeOptions,
} from "./config.js";

export function resolveCodexAppServerForModelProvider(params: {
  appServer: CodexAppServerRuntimeOptions;
  provider?: string;
  model?: string;
  config?: Parameters<typeof canUseCodexModelBackedApprovalsReviewerForModel>[0]["config"];
  env?: NodeJS.ProcessEnv;
  agentDir?: string;
  codexConfigToml?: string | null;
}): CodexAppServerRuntimeOptions {
  if (
    !isCodexModelBackedApprovalsReviewer(params.appServer.approvalsReviewer) ||
    canUseCodexModelBackedApprovalsReviewerForModel({
      modelProvider: params.provider,
      model: params.model,
      config: params.config,
      // Reviewer trust follows the spawned process, not the gateway's ambient home or endpoint.
      env: { ...(params.env ?? process.env), ...params.appServer.start.env },
      agentDir: params.agentDir,
      codexConfigToml: params.codexConfigToml,
      homeScope: params.appServer.start.homeScope,
      codexArgs: params.appServer.start.args,
    })
  ) {
    return params.appServer;
  }
  return {
    ...params.appServer,
    approvalsReviewer: "user",
  };
}

function isCodexModelBackedApprovalsReviewer(value: string): boolean {
  return value === "auto_review" || value === "guardian_subagent";
}

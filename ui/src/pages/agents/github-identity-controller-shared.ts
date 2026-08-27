import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ToolsGitHubAuthorizeStartResult, ToolsGitHubStatusResult } from "../../api/types.ts";
import type { RuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";

export type GitHubIdentityScope = "system" | "agent";
export type GitHubIdentityDraft = { token: string; name: string; email: string };

export type RequestOwner = {
  client: GatewayBrowserClient;
  agentId: string;
  clientRevision: number;
  agentRevision: number;
  requestRevision: number;
};

type AuthorizationPresentation = ToolsGitHubAuthorizeStartResult & {
  phase: "code" | "pending" | "network_error" | "cancelling" | "finishing" | "cancel_error";
  displayExpiresAtMs: number;
  slowedDown?: boolean;
  message?: string;
};

export type GitHubAuthorizationState =
  | { phase: "idle" }
  | { phase: "starting" | "cancelling" }
  | AuthorizationPresentation
  | {
      phase: "access_denied" | "expired" | "incorrect_device_code" | "failed";
      message?: string;
    };

export type AuthorizationOperation = {
  owner: RequestOwner;
  scope: GitHubIdentityScope;
  controller: AbortController;
  requestId?: string;
  start?: ToolsGitHubAuthorizeStartResult;
  displayExpiresAtMs?: number;
  timer?: ReturnType<typeof setTimeout>;
  cancelRequested?: boolean;
  cancelInFlight?: boolean;
  cancelTooLate?: boolean;
  cancelError?: string;
};

export type GitHubIdentityHost = {
  requestUpdate: () => void;
  runExternalMutation: RuntimeConfigCapability["runExternalMutation"];
};

export type GitHubConfigureMutationResult =
  | {
      ok: true;
      value: ToolsGitHubStatusResult;
      refresh: { ok: true } | { ok: false; error: string };
    }
  | { ok: false; error: string };

export function configFingerprint(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function readGitHubIdentityDraft(value: unknown): GitHubIdentityDraft {
  const github = isRecord(value) ? value : undefined;
  const gitAuthor = isRecord(github?.gitAuthor) ? github.gitAuthor : undefined;
  return {
    token: "",
    name: typeof gitAuthor?.name === "string" ? gitAuthor.name : "",
    email: typeof gitAuthor?.email === "string" ? gitAuthor.email : "",
  };
}

export function cancelAuthorizationRequest(operation: AuthorizationOperation): void {
  if (!operation.requestId) {
    return;
  }
  void operation.owner.client
    .request("tools.github.authorize.cancel", { requestId: operation.requestId })
    .catch(() => undefined);
}

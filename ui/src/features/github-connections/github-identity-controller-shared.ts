import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ToolsGitHubAuthorizeStartResult } from "../../api/types.ts";
import type { RuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";

type GitHubSharedScope = "system" | "agent";
export type GitHubIdentityScope = "personal" | GitHubSharedScope;
export type GitHubIdentityDraft = { token: string; name: string; email: string };
type GitHubConnectionOwner =
  | { kind: "personal"; profileId: string }
  | { kind: "shared"; scope: GitHubSharedScope; agentId: string };
export type GitHubConnectionTarget =
  | Extract<GitHubConnectionOwner, { kind: "personal" }>
  | (Extract<GitHubConnectionOwner, { kind: "shared" }> & {
      config: Record<string, unknown> | null;
    });

export type RequestOwner = {
  client: GatewayBrowserClient;
  target: GitHubConnectionOwner;
  clientRevision: number;
  requestRevision: number;
};
export type SharedRequestOwner = RequestOwner & {
  target: Extract<GitHubConnectionOwner, { kind: "shared" }>;
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
  controller: AbortController;
  requestId?: string;
  start?: ToolsGitHubAuthorizeStartResult;
  displayExpiresAtMs?: number;
  timer?: ReturnType<typeof setTimeout>;
  cancelRequested?: boolean;
  cancelInFlight?: boolean;
  pollInFlight?: boolean;
  cancelTooLate?: boolean;
  cancelError?: string;
};

export type GitHubIdentityHost = {
  requestUpdate: () => void;
  runExternalMutation?: RuntimeConfigCapability["runExternalMutation"];
};

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

export function githubConnectionOwnerKey(target: GitHubConnectionTarget | null): string {
  return JSON.stringify(
    target?.kind === "shared" ? { kind: target.kind, agentId: target.agentId } : target,
  );
}

export function githubAuthorizationMethod(
  owner: RequestOwner,
  operation: "start" | "poll" | "cancel",
) {
  return `${owner.target.kind === "personal" ? "users" : "tools"}.github.authorize.${operation}`;
}

export function cancelAuthorizationRequest(operation: AuthorizationOperation): void {
  if (!operation.requestId) {
    return;
  }
  void operation.owner.client
    .request(githubAuthorizationMethod(operation.owner, "cancel"), {
      requestId: operation.requestId,
    })
    .catch(() => undefined);
}

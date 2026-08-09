import {
  assertFactoryNativeLaunchAuthority,
  hashFactoryNativeAuthorityValue,
  type FactoryNativeRunAuthority,
  type SwarmLaunchAuthority,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type {
  CodexThreadResumeParams,
  CodexThreadResumeResponse,
  CodexThreadStartParams,
  CodexThreadStartResponse,
} from "./protocol.js";
import { assertCodexFactoryNativeThreadConfigPatch } from "./thread-requests.js";

export type CodexFactoryNativeStartupProof = {
  threadStartRequestHash: `sha256:${string}`;
  threadConfigHash: `sha256:${string}`;
  activePermissionProfile: { id: string; extends?: string | null };
  cwd: string;
  runtimeWorkspaceRoots: string[];
  approvalPolicy: "never";
  approvalsReviewer: "auto_review";
  sandbox: {
    type: "workspaceWrite";
    writableRoots: string[];
    networkAccess: false;
    excludeTmpdirEnvVar: true;
    excludeSlashTmp: true;
  };
};

type CodexFactoryNativeThreadRequestProof = {
  authority: SwarmLaunchAuthority;
  config: Record<string, unknown>;
  expectedRoots: string[];
};

/** Rejects capability drift before Codex may construct or resume a thread. */
export function assertCodexFactoryNativeThreadRequestAuthority(params: {
  binding: FactoryNativeRunAuthority;
  request: CodexThreadStartParams | CodexThreadResumeParams;
  expectedMcpServerNames: readonly string[];
}): CodexFactoryNativeThreadRequestProof {
  const authority = assertFactoryNativeLaunchAuthority(params.binding.authority);
  const expectedRoots = [...authority.filesystem.writableRoots].toSorted();
  const requestedRoots = [...(params.request.runtimeWorkspaceRoots ?? [])].toSorted();
  if (
    params.request.permissions !== authority.permissionProfile.id ||
    params.request.cwd !== authority.cwd ||
    JSON.stringify(requestedRoots) !== JSON.stringify(expectedRoots) ||
    Object.hasOwn(params.request, "sandbox") ||
    params.request.approvalPolicy !== authority.approvalPolicy ||
    params.request.approvalsReviewer !== authority.approvalsReviewer
  ) {
    throw new Error("Codex factory native thread request did not match its launch authority");
  }
  const config = params.request.config;
  if (!config) {
    throw new Error("Codex factory native thread request omitted its enforced config");
  }
  return {
    authority,
    config: assertCodexFactoryNativeThreadConfigPatch(
      authority,
      config,
      params.expectedMcpServerNames,
    ),
    expectedRoots,
  };
}

/** Attests Codex's effective named profile before any model turn can start. */
export function assertCodexFactoryNativeThreadAttestation(params: {
  binding: FactoryNativeRunAuthority;
  request: CodexThreadStartParams | CodexThreadResumeParams;
  response: CodexThreadStartResponse | CodexThreadResumeResponse;
  expectedMcpServerNames: readonly string[];
}): CodexFactoryNativeStartupProof {
  const requestProof = assertCodexFactoryNativeThreadRequestAuthority({
    binding: params.binding,
    request: params.request,
    expectedMcpServerNames: params.expectedMcpServerNames,
  });
  const { authority, config: validatedConfig, expectedRoots } = requestProof;
  const profile = params.response.activePermissionProfile;
  const expectedSandboxWritableRoots = expectedRoots.filter((root) => root !== authority.cwd);
  const actualRoots = [...(params.response.runtimeWorkspaceRoots ?? [])].toSorted();
  const sandbox = params.response.sandbox;
  const sandboxWritableRoots =
    sandbox.type === "workspaceWrite" ? [...sandbox.writableRoots].toSorted() : [];
  if (
    !profile ||
    profile.id !== authority.permissionProfile.id ||
    profile.extends != null ||
    params.response.approvalPolicy !== "never" ||
    params.response.approvalsReviewer !== authority.approvalsReviewer ||
    params.response.cwd !== authority.cwd ||
    JSON.stringify(actualRoots) !== JSON.stringify(expectedRoots) ||
    sandbox.type !== "workspaceWrite" ||
    JSON.stringify(sandboxWritableRoots) !== JSON.stringify(expectedSandboxWritableRoots) ||
    sandbox.networkAccess !== false ||
    sandbox.excludeTmpdirEnvVar !== true ||
    sandbox.excludeSlashTmp !== true
  ) {
    throw new Error("Codex app-server did not attest the factory native permission profile");
  }
  return {
    threadStartRequestHash: hashFactoryNativeAuthorityValue(params.request),
    threadConfigHash: hashFactoryNativeAuthorityValue(validatedConfig),
    activePermissionProfile: {
      id: profile.id,
      ...(profile.extends !== undefined ? { extends: profile.extends } : {}),
    },
    cwd: params.response.cwd,
    runtimeWorkspaceRoots: [...(params.response.runtimeWorkspaceRoots ?? [])],
    approvalPolicy: "never",
    approvalsReviewer: authority.approvalsReviewer,
    sandbox: {
      type: "workspaceWrite",
      writableRoots: sandboxWritableRoots,
      networkAccess: false,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    },
  };
}

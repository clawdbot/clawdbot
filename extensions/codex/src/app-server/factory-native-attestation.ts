import {
  assertFactoryNativeLaunchAuthority,
  hashFactoryNativeAuthorityValue,
  type FactoryNativeRunAuthority,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type {
  CodexThreadResumeParams,
  CodexThreadResumeResponse,
  CodexThreadStartParams,
  CodexThreadStartResponse,
} from "./protocol.js";

export type CodexFactoryNativeStartupProof = {
  threadStartRequestHash: `sha256:${string}`;
  threadConfigHash: `sha256:${string}`;
  activePermissionProfile: { id: string; extends?: string | null };
  cwd: string;
  runtimeWorkspaceRoots: string[];
  approvalPolicy: "never";
  sandbox: {
    type: "workspaceWrite";
    writableRoots: string[];
    networkAccess: false;
    excludeTmpdirEnvVar: true;
    excludeSlashTmp: true;
  };
};

/** Attests Codex's effective named profile before any model turn can start. */
export function assertCodexFactoryNativeThreadAttestation(params: {
  binding: FactoryNativeRunAuthority;
  request: CodexThreadStartParams | CodexThreadResumeParams;
  response: CodexThreadStartResponse | CodexThreadResumeResponse;
}): CodexFactoryNativeStartupProof {
  const authority = assertFactoryNativeLaunchAuthority(params.binding.authority);
  const profile = params.response.activePermissionProfile;
  const expectedRoots = [...authority.filesystem.writableRoots].toSorted();
  const expectedSandboxWritableRoots = expectedRoots.filter((root) => root !== authority.cwd);
  const requestedRoots = [...(params.request.runtimeWorkspaceRoots ?? [])].toSorted();
  const actualRoots = [...(params.response.runtimeWorkspaceRoots ?? [])].toSorted();
  const sandbox = params.response.sandbox;
  const sandboxWritableRoots =
    sandbox.type === "workspaceWrite" ? [...sandbox.writableRoots].toSorted() : [];
  if (
    params.request.permissions !== authority.permissionProfile.id ||
    JSON.stringify(requestedRoots) !== JSON.stringify(expectedRoots) ||
    Object.hasOwn(params.request, "sandbox") ||
    params.request.approvalPolicy !== "never" ||
    !profile ||
    profile.id !== authority.permissionProfile.id ||
    profile.extends != null ||
    params.response.approvalPolicy !== "never" ||
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
  const config = params.request.config;
  if (!config) {
    throw new Error("Codex factory native thread request omitted its enforced config");
  }
  return {
    threadStartRequestHash: hashFactoryNativeAuthorityValue(params.request),
    threadConfigHash: hashFactoryNativeAuthorityValue(config),
    activePermissionProfile: {
      id: profile.id,
      ...(profile.extends !== undefined ? { extends: profile.extends } : {}),
    },
    cwd: params.response.cwd,
    runtimeWorkspaceRoots: [...(params.response.runtimeWorkspaceRoots ?? [])],
    approvalPolicy: "never",
    sandbox: {
      type: "workspaceWrite",
      writableRoots: sandboxWritableRoots,
      networkAccess: false,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    },
  };
}

import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it } from "vitest";
import { buildTestFactoryNativeAuthority } from "../../../../src/agents/factory-authority-profile.test-helpers.js";
import { shouldEnableCodexAppServerNativeToolSurface } from "./dynamic-tool-build.js";
import { assertCodexFactoryNativeThreadAttestation } from "./factory-native-attestation.js";
import type { CodexThreadStartParams, CodexThreadStartResponse } from "./protocol.js";
import {
  buildCodexFactoryNativeThreadConfigPatch,
  codexThreadSandboxOrPermissions,
} from "./thread-requests.js";

const LAUNCH_DIGEST = `sha256:${"a".repeat(64)}` as const;
const authority = buildTestFactoryNativeAuthority("/tmp/codex-factory-native-test");
const binding = {
  runId: `swarm_${"b".repeat(32)}`,
  launchIdentityDigest: LAUNCH_DIGEST,
  authority,
};

function request(): CodexThreadStartParams {
  return {
    cwd: authority.cwd,
    model: "gpt-5.6-sol",
    approvalPolicy: "never",
    permissions: authority.permissionProfile.id,
    config: buildCodexFactoryNativeThreadConfigPatch(authority, ["github", "linear"]),
  };
}

function response(overrides: Partial<CodexThreadStartResponse> = {}): CodexThreadStartResponse {
  return {
    activePermissionProfile: { id: authority.permissionProfile.id },
    approvalPolicy: "never",
    approvalsReviewer: "auto_review",
    cwd: authority.cwd,
    runtimeWorkspaceRoots: [...authority.filesystem.writableRoots],
    sandbox: {
      type: "workspaceWrite",
      writableRoots: [...authority.filesystem.writableRoots],
      networkAccess: false,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    },
    thread: { id: "factory-thread" },
    model: "gpt-5.6-sol",
    ...overrides,
  } as CodexThreadStartResponse;
}

describe("Codex native factory authority", () => {
  it("installs a complete closed config and selects permissions without a sandbox field", () => {
    const config = buildCodexFactoryNativeThreadConfigPatch(authority, [
      "linear",
      "github",
      "linear",
    ]);

    expect(config).toMatchObject({
      "features.code_mode": true,
      "features.code_mode_only": false,
      "features.multi_agent": false,
      "features.multi_agent_v2": false,
      "features.apps": false,
      "features.plugins": false,
      "features.hooks": false,
      "features.standalone_web_search": false,
      "orchestrator.mcp.enabled": false,
      "orchestrator.skills.enabled": false,
      web_search: "disabled",
      permissions: {
        [authority.permissionProfile.id]: authority.permissionProfile.definition,
      },
      shell_environment_policy: authority.shellEnvironmentPolicy.definition,
      mcp_servers: {
        github: { enabled: false },
        linear: { enabled: false },
      },
    });
    expect(
      codexThreadSandboxOrPermissions(
        { networkProxy: undefined, sandbox: "workspace-write" },
        authority.permissionProfile.id,
      ),
    ).toEqual({ permissions: authority.permissionProfile.id });
  });

  it("enables native code only for the host-attested factory collector", () => {
    const genericCollector = {
      disableTools: false,
      swarmCollector: true,
      swarmOutputSchema: { type: "object" },
    } as unknown as EmbeddedRunAttemptParams;

    expect(shouldEnableCodexAppServerNativeToolSurface(genericCollector)).toBe(false);
    expect(
      shouldEnableCodexAppServerNativeToolSurface({
        ...genericCollector,
        factoryNativeAuthority: binding,
      }),
    ).toBe(true);
  });

  it("attests the exact active named profile before a model turn", () => {
    const proof = assertCodexFactoryNativeThreadAttestation({
      binding,
      request: request(),
      response: response(),
    });

    expect(proof).toMatchObject({
      activePermissionProfile: { id: authority.permissionProfile.id },
      cwd: authority.cwd,
      runtimeWorkspaceRoots: authority.filesystem.writableRoots,
      approvalPolicy: "never",
      sandbox: {
        type: "workspaceWrite",
        writableRoots: [...authority.filesystem.writableRoots].toSorted(),
        networkAccess: false,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      },
      threadStartRequestHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      threadConfigHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
  });

  it.each([
    {
      label: "wrong active profile",
      request: request(),
      response: response({ activePermissionProfile: { id: "default" } }),
    },
    {
      label: "inherited profile",
      request: request(),
      response: response({
        activePermissionProfile: {
          id: authority.permissionProfile.id,
          extends: "default",
        },
      }),
    },
    {
      label: "wrong runtime roots",
      request: request(),
      response: response({ runtimeWorkspaceRoots: [authority.cwd] }),
    },
    {
      label: "sandbox field mixed with permissions",
      request: { ...request(), sandbox: "workspace-write" as const },
      response: response(),
    },
    {
      label: "non-workspace-write effective sandbox",
      request: request(),
      response: response({ sandbox: { type: "dangerFullAccess" } }),
    },
    {
      label: "sandbox writable-root drift",
      request: request(),
      response: response({
        sandbox: {
          type: "workspaceWrite",
          writableRoots: [authority.cwd],
          networkAccess: false,
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true,
        },
      }),
    },
    {
      label: "sandbox network access",
      request: request(),
      response: response({
        sandbox: {
          type: "workspaceWrite",
          writableRoots: [...authority.filesystem.writableRoots],
          networkAccess: true,
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true,
        },
      }),
    },
    {
      label: "sandbox default temp access",
      request: request(),
      response: response({
        sandbox: {
          type: "workspaceWrite",
          writableRoots: [...authority.filesystem.writableRoots],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
      }),
    },
  ])("fails closed for $label", ({ request: threadRequest, response: threadResponse }) => {
    expect(() =>
      assertCodexFactoryNativeThreadAttestation({
        binding,
        request: threadRequest,
        response: threadResponse,
      }),
    ).toThrow("did not attest");
  });
});

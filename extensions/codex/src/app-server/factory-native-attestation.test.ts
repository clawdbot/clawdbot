import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it } from "vitest";
import { buildTestFactoryNativeAuthority } from "../../../../src/agents/factory-authority-profile.test-helpers.js";
import { shouldEnableCodexAppServerNativeToolSurface } from "./dynamic-tool-build.js";
import { assertCodexFactoryNativeThreadAttestation } from "./factory-native-attestation.js";
import type { CodexThreadStartParams, CodexThreadStartResponse, JsonObject } from "./protocol.js";
import {
  buildCodexFactoryNativeThreadConfigPatch,
  buildThreadResumeParams,
  buildThreadStartParams,
  codexThreadSandboxOrPermissions,
} from "./thread-requests.js";
import {
  assertCodexFactoryNativeTurnRequestAuthority,
  buildTurnStartParams,
} from "./turn-params.js";

const LAUNCH_DIGEST = `sha256:${"a".repeat(64)}` as const;
const authority = buildTestFactoryNativeAuthority("/tmp/codex-factory-native-test");
const EXPECTED_MCP_SERVER_NAMES = ["github", "linear"] as const;
const expectedSandboxWritableRoots = authority.filesystem.writableRoots
  .filter((root) => root !== authority.cwd)
  .toSorted();
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
    approvalsReviewer: "auto_review",
    permissions: authority.permissionProfile.id,
    runtimeWorkspaceRoots: [...authority.filesystem.writableRoots],
    config: buildCodexFactoryNativeThreadConfigPatch(authority, EXPECTED_MCP_SERVER_NAMES),
  };
}

function requestWithConfigDrift(
  mutate: (config: Record<string, unknown>) => void,
): CodexThreadStartParams {
  const threadRequest = request();
  const config = structuredClone(threadRequest.config) as Record<string, unknown>;
  mutate(config);
  return { ...threadRequest, config: config as JsonObject };
}

function requestWithoutRuntimeWorkspaceRoots(): CodexThreadStartParams {
  const threadRequest = request();
  delete threadRequest.runtimeWorkspaceRoots;
  return threadRequest;
}

function requestWithoutConfig(): CodexThreadStartParams {
  const threadRequest = request();
  delete threadRequest.config;
  return threadRequest;
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
      writableRoots: expectedSandboxWritableRoots,
      networkAccess: false,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    },
    thread: { id: "factory-thread" },
    model: "gpt-5.6-sol",
    ...overrides,
  } as CodexThreadStartResponse;
}

function attemptParams(): EmbeddedRunAttemptParams {
  return {
    provider: "openai",
    modelId: "gpt-5.6-sol",
    prompt: "factory native test",
    authProfileStore: { version: 1, profiles: {} },
    factoryNativeAuthority: binding,
  } as EmbeddedRunAttemptParams;
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
      default_permissions: authority.permissionProfile.id,
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

  it("forces thread authority and omits redundant turn permission selection", () => {
    const params = attemptParams();
    const appServer = {
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "read-only",
    } as never;
    const start = buildThreadStartParams(params, {
      cwd: "/tmp/drifted-cwd",
      dynamicTools: [],
      appServer,
      config: {
        approvals_reviewer: "user",
        mcp_servers: { github: { enabled: true }, linear: { enabled: true } },
      },
      ringZeroInheritedMcpServerNames: EXPECTED_MCP_SERVER_NAMES,
      environmentSelection: [{ environmentId: "untrusted", cwd: "/tmp/untrusted" }],
    });
    const resume = buildThreadResumeParams(params, {
      threadId: "factory-thread",
      appServer,
      config: {
        approvals_reviewer: "user",
        mcp_servers: { github: { enabled: true }, linear: { enabled: true } },
      },
      ringZeroInheritedMcpServerNames: EXPECTED_MCP_SERVER_NAMES,
    });
    const turn = buildTurnStartParams(params, {
      threadId: "factory-thread",
      cwd: "/tmp/drifted-cwd",
      appServer,
      sandboxPolicy: { type: "dangerFullAccess" },
      environmentSelection: [{ environmentId: "untrusted", cwd: "/tmp/untrusted" }],
    });

    for (const threadRequest of [start, resume]) {
      expect(threadRequest.cwd).toBe(authority.cwd);
      expect(threadRequest.runtimeWorkspaceRoots).toEqual(authority.filesystem.writableRoots);
      expect(threadRequest.approvalPolicy).toBe("never");
      expect(threadRequest.approvalsReviewer).toBe("auto_review");
      expect(threadRequest.permissions).toBe(authority.permissionProfile.id);
      expect(threadRequest).not.toHaveProperty("sandbox");
    }
    expect(start).not.toHaveProperty("environments");
    expect(turn).toMatchObject({
      cwd: authority.cwd,
      approvalPolicy: "never",
      approvalsReviewer: "auto_review",
    });
    expect(turn).not.toHaveProperty("permissions");
    expect(turn).not.toHaveProperty("sandboxPolicy");
    expect(turn).not.toHaveProperty("environments");
    expect(turn).not.toHaveProperty("runtimeWorkspaceRoots");
    expect(() => assertCodexFactoryNativeTurnRequestAuthority(authority, turn)).not.toThrow();
    expect(() =>
      assertCodexFactoryNativeTurnRequestAuthority(authority, {
        ...turn,
        runtimeWorkspaceRoots: ["/tmp/untrusted"],
      }),
    ).toThrow("drifted from its launch authority");
    expect(() =>
      assertCodexFactoryNativeTurnRequestAuthority(authority, {
        ...turn,
        permissions: authority.permissionProfile.id,
      }),
    ).toThrow("drifted from its launch authority");
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
      expectedMcpServerNames: EXPECTED_MCP_SERVER_NAMES,
    });

    expect(proof).toMatchObject({
      activePermissionProfile: { id: authority.permissionProfile.id },
      cwd: authority.cwd,
      runtimeWorkspaceRoots: authority.filesystem.writableRoots,
      approvalPolicy: "never",
      approvalsReviewer: "auto_review",
      sandbox: {
        type: "workspaceWrite",
        writableRoots: expectedSandboxWritableRoots,
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
      label: "wrong requested cwd",
      request: { ...request(), cwd: "/tmp/drifted-cwd" },
      response: response(),
    },
    {
      label: "missing requested runtime roots",
      request: requestWithoutRuntimeWorkspaceRoots(),
      response: response(),
    },
    {
      label: "requested runtime root drift",
      request: { ...request(), runtimeWorkspaceRoots: [authority.cwd] },
      response: response(),
    },
    {
      label: "wrong request approval policy",
      request: { ...request(), approvalPolicy: "on-request" as const },
      response: response(),
    },
    {
      label: "wrong request approvals reviewer",
      request: { ...request(), approvalsReviewer: "user" as const },
      response: response(),
    },
    {
      label: "wrong response approvals reviewer",
      request: request(),
      response: response({ approvalsReviewer: "user" }),
    },
    {
      label: "missing closed config",
      request: requestWithoutConfig(),
      response: response(),
    },
    {
      label: "feature drift",
      request: requestWithConfigDrift((config) => {
        config["features.apps"] = true;
      }),
      response: response(),
    },
    {
      label: "permission selection drift",
      request: requestWithConfigDrift((config) => {
        config.default_permissions = ":workspace";
      }),
      response: response(),
    },
    {
      label: "permission definition drift",
      request: requestWithConfigDrift((config) => {
        config.permissions = {
          [authority.permissionProfile.id]: {
            ...authority.permissionProfile.definition,
            network: { enabled: true },
          },
        };
      }),
      response: response(),
    },
    {
      label: "shell environment policy drift",
      request: requestWithConfigDrift((config) => {
        config.shell_environment_policy = {
          ...authority.shellEnvironmentPolicy.definition,
          set: {
            ...authority.shellEnvironmentPolicy.definition.set,
            HOME: "/tmp/host-home",
          },
        };
      }),
      response: response(),
    },
    {
      label: "enabled inherited MCP server",
      request: requestWithConfigDrift((config) => {
        config.mcp_servers = {
          github: { enabled: true },
          linear: { enabled: false },
        };
      }),
      response: response(),
    },
    {
      label: "extra MCP launch property",
      request: requestWithConfigDrift((config) => {
        config.mcp_servers = {
          github: { enabled: false, command: "/tmp/evil" },
          linear: { enabled: false },
        };
      }),
      response: response(),
    },
    {
      label: "missing inherited MCP server confinement",
      request: requestWithConfigDrift((config) => {
        config.mcp_servers = { github: { enabled: false } };
      }),
      response: response(),
    },
    {
      label: "malformed MCP confinement",
      request: requestWithConfigDrift((config) => {
        config.mcp_servers = "invalid";
      }),
      response: response(),
    },
    {
      label: "extra top-level config capability",
      request: requestWithConfigDrift((config) => {
        config.unexpected_capability = true;
      }),
      response: response(),
    },
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
          writableRoots: expectedSandboxWritableRoots,
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
          writableRoots: expectedSandboxWritableRoots,
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
        expectedMcpServerNames: EXPECTED_MCP_SERVER_NAMES,
      }),
    ).toThrow(/factory native|did not attest/u);
  });
});

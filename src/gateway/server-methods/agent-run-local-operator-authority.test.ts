import { afterAll, describe, expect, it } from "vitest";
import { createTestAdmittedRunContext } from "../../agents/admitted-run-context.test-support.js";
import {
  claimAgentRunDelegatedAuthority,
  resetAgentRunRegistryForTest,
} from "../../infra/agent-run-registry.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import type { AgentRuntimeIdentity } from "../agent-runtime-identity-token.js";
import type { AgentRunRequest } from "./agent-request-types.js";
import {
  resolveGatewayChatCronCreatorAuthorityAdmission,
  resolveGatewayCronCreatorAuthorityAdmission,
  type GatewayCronCreatorAuthorityAdmission,
} from "./cron-creator-authority-admission.js";
import type { GatewayClient } from "./shared-types.js";

const agentRuntimeContext = createTestAdmittedRunContext("run-local-operator-runtime");
const agentRuntimeAuthority = claimAgentRunDelegatedAuthority(
  agentRuntimeContext.operationalRunInstance,
);
const agentRuntimeIdentity: AgentRuntimeIdentity = {
  kind: "agentRuntime",
  agentId: "main",
  sessionKey: "agent:main:worker",
  operationalRunInstance: agentRuntimeContext.operationalRunInstance,
  delegatedAuthority: { kind: "local", ...agentRuntimeAuthority },
};

afterAll(() => {
  resetAgentRunRegistryForTest();
});

function createClient(overrides: Partial<NonNullable<GatewayClient["internal"]>> = {}) {
  return {
    connect: { scopes: ["operator.admin"] },
    internal: { isLocalClient: true, ...overrides },
  } as unknown as GatewayClient;
}

function createParams(
  overrides: {
    client?: GatewayClient | null;
    request?: Partial<AgentRunRequest>;
    inputProvenance?: InputProvenance;
    hasRestoredCronContinuation?: boolean;
    isOneShotModelRun?: boolean;
    isRestartRecoveryResumeRun?: boolean;
    resolvedSessionKey?: string;
    spawnedBy?: string;
  } = {},
): Parameters<typeof resolveGatewayCronCreatorAuthorityAdmission>[0] {
  return {
    runId: "run-local-operator",
    resolvedSessionKey: "agent:main:main",
    client: createClient(),
    request: {
      message: "create an automation",
      idempotencyKey: "run-local-operator",
      ...overrides.request,
    },
    hasRestoredCronContinuation: false,
    isOneShotModelRun: false,
    isRestartRecoveryResumeRun: false,
    ...(overrides.client !== undefined ? { client: overrides.client } : {}),
    ...(overrides.inputProvenance ? { inputProvenance: overrides.inputProvenance } : {}),
    ...(overrides.hasRestoredCronContinuation !== undefined
      ? { hasRestoredCronContinuation: overrides.hasRestoredCronContinuation }
      : {}),
    ...(overrides.isOneShotModelRun !== undefined
      ? { isOneShotModelRun: overrides.isOneShotModelRun }
      : {}),
    ...(overrides.isRestartRecoveryResumeRun !== undefined
      ? { isRestartRecoveryResumeRun: overrides.isRestartRecoveryResumeRun }
      : {}),
    ...(overrides.resolvedSessionKey !== undefined
      ? { resolvedSessionKey: overrides.resolvedSessionKey }
      : {}),
    ...(overrides.spawnedBy !== undefined ? { spawnedBy: overrides.spawnedBy } : {}),
  };
}

describe("resolveGatewayCronCreatorAuthorityAdmission", () => {
  it("mints only for the admitted direct local admin turn", () => {
    expect(resolveGatewayCronCreatorAuthorityAdmission(createParams())).toEqual({
      runId: "run-local-operator",
    } satisfies GatewayCronCreatorAuthorityAdmission);
  });

  it.each([
    ["missing Gateway client", { client: null }],
    ["non-local client", { client: createClient({ isLocalClient: undefined }) }],
    [
      "non-admin client",
      {
        client: {
          ...createClient(),
          connect: { scopes: ["operator.write"] },
        } as unknown as GatewayClient,
      },
    ],
    ["ephemeral run", { resolvedSessionKey: "" }],
    ["spawned run", { spawnedBy: "agent:main:parent" }],
    ["external provenance", { inputProvenance: { kind: "external_user" } }],
    ["cron continuation", { hasRestoredCronContinuation: true }],
    ["restart continuation", { isRestartRecoveryResumeRun: true }],
    ["model run", { isOneShotModelRun: true }],
    ["internal handoff", { request: { internalRuntimeHandoffId: "handoff-1" } }],
    ["model-run request", { request: { modelRun: true } }],
    ["identity retry", { request: { internalExecutionIdentityRetry: true } }],
    ["identity recovery attempt", { request: { internalExecutionIdentityRecoveryAttempt: 1 } }],
    ["exec approval followup", { request: { execApprovalFollowupExpectedSessionId: "session-1" } }],
    ["internal session effects", { request: { sessionEffects: "internal" } }],
    ["suppressed prompt persistence", { request: { suppressPromptPersistence: true } }],
    ["swarm collector", { request: { swarmCollector: true } }],
    ["completion event", { request: { internalEvents: [{ type: "task_completion" }] } }],
    ["ACP spawn", { request: { acpTurnSource: "manual_spawn" } }],
    ["subagent lane", { request: { lane: "subagent" } }],
    ["plugin run", { client: createClient({ pluginRuntimeOwnerId: "memory-core" }) }],
    ["synthetic run", { client: createClient({ syntheticClient: true }) }],
    ["delegated run", { client: createClient({ delegatedToolPolicyHandoffId: "handoff-1" }) }],
    ["approval runtime", { client: createClient({ approvalRuntime: true }) }],
    ["sender attribution", { client: createClient({ senderAttribution: { id: "sender-1" } }) }],
    ["tracked agent run", { client: createClient({ agentRunTracking: "plugin_subagent" }) }],
    [
      "plugin subagent requester",
      { client: createClient({ pluginSubagentRequester: {} as never }) },
    ],
    ["runtime plugin grant", { client: createClient({ runtimePluginToolGrant: {} as never }) }],
    [
      "worker runtime",
      {
        client: createClient({
          agentRuntimeIdentity,
        }),
      },
    ],
  ] as const)("rejects %s", (_label, override) => {
    expect(
      resolveGatewayCronCreatorAuthorityAdmission(
        createParams(override as Parameters<typeof createParams>[0]),
      ),
    ).toBeUndefined();
  });
});

function createChatParams(
  overrides: Partial<Parameters<typeof resolveGatewayChatCronCreatorAuthorityAdmission>[0]> = {},
): Parameters<typeof resolveGatewayChatCronCreatorAuthorityAdmission>[0] {
  return {
    runId: "run-local-chat",
    resolvedSessionKey: "agent:main:main",
    client: createClient(),
    hasExplicitOrigin: false,
    hasRestoredCronContinuation: false,
    isIncognito: false,
    isReconnectResume: false,
    isSystemGenerated: false,
    turnKind: "main",
    isDirectExternalUser: true,
    ...overrides,
  };
}

describe("resolveGatewayChatCronCreatorAuthorityAdmission", () => {
  it("mints only for a direct external local-admin user turn", () => {
    expect(resolveGatewayChatCronCreatorAuthorityAdmission(createChatParams())).toEqual({
      runId: "run-local-chat",
    });
  });

  it.each([
    ["internal re-entry", { isDirectExternalUser: false }],
    ["explicit origin", { hasExplicitOrigin: true }],
    ["reconnect", { isReconnectResume: true }],
    ["system-generated", { isSystemGenerated: true }],
    ["BTW turn", { turnKind: "btw" }],
    ["incognito", { isIncognito: true }],
    ["persisted cron continuation", { hasRestoredCronContinuation: true }],
    ["spawned lineage", { spawnedBy: "agent:main:parent" }],
    ["input provenance", { inputProvenance: { kind: "external_user" } }],
    ["remote client", { client: createClient({ isLocalClient: undefined }) }],
    [
      "non-admin client",
      { client: { ...createClient(), connect: { scopes: ["operator.write"] } } },
    ],
    ["synthetic client", { client: createClient({ syntheticClient: true }) }],
    ["sender attribution", { client: createClient({ senderAttribution: { id: "sender-1" } }) }],
    ["approval runtime", { client: createClient({ approvalRuntime: true }) }],
    ["cron continuation client", { client: createClient({ cronRunContinuation: true }) }],
    [
      "worker runtime",
      {
        client: createClient({
          agentRuntimeIdentity,
        }),
      },
    ],
    ["plugin runtime", { client: createClient({ pluginRuntimeOwnerId: "memory-core" }) }],
    ["tracked agent run", { client: createClient({ agentRunTracking: "plugin_subagent" }) }],
    [
      "plugin subagent requester",
      { client: createClient({ pluginSubagentRequester: {} as never }) },
    ],
    ["runtime plugin grant", { client: createClient({ runtimePluginToolGrant: {} as never }) }],
    ["delegated handoff", { client: createClient({ delegatedToolPolicyHandoffId: "handoff" }) }],
  ] as const)("rejects %s", (_label, overrides) => {
    expect(
      resolveGatewayChatCronCreatorAuthorityAdmission(
        createChatParams(
          overrides as Partial<
            Parameters<typeof resolveGatewayChatCronCreatorAuthorityAdmission>[0]
          >,
        ),
      ),
    ).toBeUndefined();
  });
});

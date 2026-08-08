import { describe, expect, it } from "vitest";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import type { AgentRunRequest } from "./agent-request-types.js";
import {
  resolveGatewayCronCreatorAuthorityAdmission,
  type GatewayCronCreatorAuthorityAdmission,
} from "./agent-run-local-operator-authority.js";
import type { GatewayClient } from "./shared-types.js";

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
    ["completion event", { request: { internalEvents: [{ type: "task_completion" }] } }],
    ["ACP spawn", { request: { acpTurnSource: "manual_spawn" } }],
    ["subagent lane", { request: { lane: "subagent" } }],
    ["plugin run", { client: createClient({ pluginRuntimeOwnerId: "memory-core" }) }],
    ["synthetic run", { client: createClient({ syntheticClient: true }) }],
    ["delegated run", { client: createClient({ delegatedToolPolicyHandoffId: "handoff-1" }) }],
    ["approval runtime", { client: createClient({ approvalRuntime: true }) }],
    [
      "worker runtime",
      {
        client: createClient({
          agentRuntimeIdentity: {
            kind: "agentRuntime",
            agentId: "main",
            sessionKey: "agent:main:worker",
          },
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

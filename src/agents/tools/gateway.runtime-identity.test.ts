// Gateway tool runtime-identity tests keep current-turn authority fail closed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import { withAgentRuntimeExecutionLineage } from "../../gateway/agent-runtime-execution-lineage.js";
import { verifyAgentRuntimeIdentityToken } from "../../gateway/agent-runtime-identity-token.js";
import { resolveExecutionIdentitySpawnFacts } from "../../gateway/agent-turn/agent-run-execution-lineage.js";
import type { CallGatewayOptions } from "../../gateway/call.js";
import {
  mintMessageActionTurnCapability,
  revokeMessageActionTurnCapability,
} from "../../gateway/message-action-turn-capability.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { createOperationalRunInstanceRef } from "../admitted-run-context.js";
import {
  withGatewayToolApprovalOwner,
  withGatewayToolCallerIdentity,
} from "./gateway-caller-context.js";
import { runWithGatewaySessionSpawnContext } from "./gateway-session-spawn-context.js";
import { runWithGatewaySessionSpawnParentExecutionIdentity } from "./gateway-session-spawn-execution-identity.js";
import { callGatewayTool, resolveMessageActionAgentRuntimeIdentityToken } from "./gateway.js";

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
}));

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: () => ({}),
  resolveGatewayPort: () => 18789,
}));

vi.mock("../../gateway/call.js", () => ({
  callGateway: (...args: unknown[]) => mocks.callGateway(...args),
}));

function capturedGatewayCall(): CallGatewayOptions {
  expect(mocks.callGateway).toHaveBeenCalledTimes(1);
  return mocks.callGateway.mock.calls[0]?.[0] as CallGatewayOptions;
}

type GatewayToolCallerIdentity = NonNullable<Parameters<typeof withGatewayToolCallerIdentity>[0]>;

async function withActiveGatewayToolCallerIdentity<T>(
  identity: GatewayToolCallerIdentity & {
    operationalRunInstance: NonNullable<GatewayToolCallerIdentity["operationalRunInstance"]>;
  },
  run: () => Promise<T>,
): Promise<T> {
  const authority = claimAgentRunDelegatedAuthority(identity.operationalRunInstance);
  expect(validateAgentRunDelegatedAuthority(authority)).toBe(true);
  try {
    return await withGatewayToolCallerIdentity(identity, run);
  } finally {
    expect(releaseAgentRunDelegatedAuthority(authority)).toBe(true);
    expect(validateAgentRunDelegatedAuthority(authority)).toBe(false);
  }
}

describe("gateway tool runtime identity", () => {
  const mintedTurnCapabilities: string[] = [];

  beforeEach(() => {
    mocks.callGateway.mockReset();
  });

  afterEach(() => {
    for (const token of mintedTurnCapabilities.splice(0)) {
      revokeMessageActionTurnCapability(token);
    }
  });

  it("omits runtime identity outside trusted agent context", async () => {
    mocks.callGateway.mockResolvedValueOnce({ id: "job-1" });

    await callGatewayTool("cron.remove", {}, { id: "job-1" });

    expect(capturedGatewayCall()).not.toHaveProperty("agentRuntimeIdentityToken");
  });

  it.each([
    ["cron.remove", { id: "job-1" }, { id: "job-1" }],
    ["wake", { mode: "now", text: "ping" }, { ok: true }],
  ] as const)(
    "marks trusted local %s calls with runtime identity",
    async (method, params, result) => {
      mocks.callGateway.mockResolvedValueOnce(result);

      await withActiveGatewayToolCallerIdentity(
        {
          agentId: "ops",
          sessionKey: "agent:ops:telegram:direct:alice",
          operationalRunInstance: createOperationalRunInstanceRef("run-1"),
        },
        async () => await callGatewayTool(method, {}, params),
      );

      expect(capturedGatewayCall().agentRuntimeIdentityToken).toEqual(expect.any(String));
    },
  );

  it("scopes signed session-spawn authority to its Gateway call", async () => {
    mocks.callGateway.mockResolvedValueOnce({ key: "agent:ops:dashboard:child" });
    const parentExecutionIdentity = createExecutionIdentityAdmissionToken("run-1", {
      contextId: "parent-context",
      executionId: "parent-execution",
    });

    await withActiveGatewayToolCallerIdentity(
      {
        agentId: "ops",
        sessionKey: "agent:ops:main",
        operationalRunInstance: createOperationalRunInstanceRef("run-1"),
        executionIdentityToken: parentExecutionIdentity,
      },
      async () =>
        await runWithGatewaySessionSpawnContext(
          {
            completionOwnerSessionKey: "agent:ops:discord:direct:alice",
            inheritedToolPolicy: { version: 1, allow: ["read"], deny: ["exec"] },
          },
          () =>
            runWithGatewaySessionSpawnParentExecutionIdentity(parentExecutionIdentity, () =>
              callGatewayTool(
                "sessions.create",
                {},
                { parentSessionKey: "agent:ops:main", spawnDepth: 1 },
                { requireAgentRuntimeIdentity: true },
              ),
            ),
        ),
    );

    await expect(
      verifyAgentRuntimeIdentityToken(capturedGatewayCall().agentRuntimeIdentityToken),
    ).resolves.toMatchObject({
      executionIdentity: parentExecutionIdentity,
      sessionSpawnContext: {
        completionOwnerSessionKey: "agent:ops:discord:direct:alice",
        inheritedToolPolicy: { version: 1, allow: ["read"], deny: ["exec"] },
      },
    });
  });

  it("does not recover missing forwarded parent evidence from ambient identity", async () => {
    mocks.callGateway.mockResolvedValueOnce({ key: "agent:ops:dashboard:child" });
    const ambientToken = createExecutionIdentityAdmissionToken("run-1");

    const identity = await withActiveGatewayToolCallerIdentity(
      {
        agentId: "ops",
        sessionKey: "agent:ops:main",
        operationalRunInstance: createOperationalRunInstanceRef("run-1"),
        executionIdentityToken: ambientToken,
      },
      async () => {
        await runWithGatewaySessionSpawnContext(
          withAgentRuntimeExecutionLineage(
            {
              inheritedToolPolicy: { version: 1, allow: [], deny: [] },
            },
            {
              relation: "sessions_spawn",
              requesterRef: "agent:ops:main",
              controllerRef: "agent:ops:main",
              depth: 1,
              applicableGrantRefs: ["tool:sessions_spawn"],
              localPolicyRefs: [],
              runtimeAssuranceRefs: ["spawn-runtime:subagent"],
              targetPolicyRefs: [],
              externalNativeActions: "observable",
            },
          ),
          () =>
            callGatewayTool(
              "sessions.create",
              {},
              { parentSessionKey: "agent:ops:main", spawnDepth: 1 },
              { requireAgentRuntimeIdentity: true },
            ),
        );
        return await verifyAgentRuntimeIdentityToken(
          capturedGatewayCall().agentRuntimeIdentityToken,
        );
      },
    );

    expect(identity).toBeDefined();
    expect(identity).not.toHaveProperty("executionIdentity");
    await expect(
      verifyAgentRuntimeIdentityToken(capturedGatewayCall().agentRuntimeIdentityToken),
    ).resolves.toBeUndefined();
  });

  it("redeems spawn lineage once without placing parent facts in the runtime bearer", async () => {
    mocks.callGateway.mockResolvedValueOnce({ runId: "child-run" });
    const parentExecutionIdentity = createExecutionIdentityAdmissionToken("run-private", {
      contextId: "private-parent-context",
      executionId: "private-parent-execution",
    });
    const result = await withActiveGatewayToolCallerIdentity(
      {
        agentId: "ops",
        sessionKey: "agent:ops:main",
        operationalRunInstance: createOperationalRunInstanceRef("run-private"),
        executionIdentityToken: parentExecutionIdentity,
      },
      async () => {
        await runWithGatewaySessionSpawnContext(
          withAgentRuntimeExecutionLineage(
            { inheritedToolPolicy: { version: 1, allow: ["read"], deny: ["exec"] } },
            {
              relation: "sessions_spawn",
              requesterRef: "private-requester-ref",
              controllerRef: "private-controller-ref",
              depth: 2,
              applicableGrantRefs: ["tool:sessions_spawn"],
              localPolicyRefs: ["private-local-policy"],
              runtimeAssuranceRefs: ["spawn-runtime:subagent"],
              targetPolicyRefs: ["private-target-policy"],
              externalNativeActions: "observable",
            },
          ),
          () =>
            runWithGatewaySessionSpawnParentExecutionIdentity(parentExecutionIdentity, () =>
              callGatewayTool(
                "agent",
                {},
                { sessionKey: "agent:child:main", message: "test", idempotencyKey: "child-run" },
                { requireAgentRuntimeIdentity: true },
              ),
            ),
        );
        const token = capturedGatewayCall().agentRuntimeIdentityToken ?? "";
        const [encodedPayload] = token.split(".");
        const payload = JSON.parse(
          Buffer.from(encodedPayload ?? "", "base64url").toString("utf8"),
        ) as Record<string, unknown>;
        expect(payload.executionLineageHandoffId).toEqual(expect.any(String));
        expect(payload).not.toHaveProperty("executionIdentity");
        expect(payload).not.toHaveProperty("sessionSpawnContext");
        expect(JSON.stringify(payload)).not.toMatch(
          /private-parent|private-requester|private-controller|private-local|private-target/,
        );
        const verified = await verifyAgentRuntimeIdentityToken(token);
        const copied = verified ? { ...verified } : undefined;
        return {
          identity: verified,
          facts: resolveExecutionIdentitySpawnFacts(copied),
          replayFacts: resolveExecutionIdentitySpawnFacts(verified),
        };
      },
    );

    expect(result.identity).toBeDefined();
    expect(result.facts?.spawnAdmission).toEqual(expect.any(String));
    expect(result.replayFacts).toBeUndefined();
    await expect(
      verifyAgentRuntimeIdentityToken(capturedGatewayCall().agentRuntimeIdentityToken),
    ).resolves.toBeUndefined();
  });

  it("mints message action identity only for an exact admitted source turn", async () => {
    const capabilityInput = {
      agentId: "ops",
      runId: "run-1",
      sessionKey: "agent:ops:telegram:group:room-1",
      sessionId: "session-1",
    };
    const turnCapability = mintMessageActionTurnCapability({
      ...capabilityInput,
      requesterAccountId: "default",
      toolContext: {
        currentChannelProvider: "telegram",
        currentChannelId: "room-1",
        currentChatType: "group",
        currentSourceTurnId: "source-turn-1",
      },
    });
    const sourceLessTurnCapability = mintMessageActionTurnCapability({
      ...capabilityInput,
      toolContext: {
        currentChannelProvider: "telegram",
        currentChannelId: "room-1",
        currentChatType: "group",
      },
    });
    mintedTurnCapabilities.push(turnCapability, sourceLessTurnCapability);
    const terminalParams = {
      opts: {},
      target: "local" as const,
      runId: "run-1",
      sessionId: "session-1",
      sourceReplyFinal: true,
      sourceReplyToolCallId: "message-call-1",
    };

    await withActiveGatewayToolCallerIdentity(
      {
        agentId: "ops",
        sessionKey: capabilityInput.sessionKey,
        operationalRunInstance: createOperationalRunInstanceRef(capabilityInput.runId),
      },
      async () => {
        const token = await resolveMessageActionAgentRuntimeIdentityToken({
          ...terminalParams,
          turnCapability,
        });
        await expect(verifyAgentRuntimeIdentityToken(token)).resolves.toMatchObject({
          messageActionContext: {
            sessionId: "session-1",
            sourceReplyFinal: true,
            sourceReplyToolCallId: "message-call-1",
            requesterAccountId: "default",
            toolContext: { currentSourceTurnId: "source-turn-1" },
          },
        });
        await expect(
          resolveMessageActionAgentRuntimeIdentityToken({
            ...terminalParams,
            sourceReplyToolCallId: undefined,
            turnCapability,
          }),
        ).rejects.toThrow("terminal source reply requires tool-call correlation");
        await expect(
          resolveMessageActionAgentRuntimeIdentityToken({
            ...terminalParams,
            turnCapability: "missing-capability",
          }),
        ).rejects.toThrow("terminal source reply requires an active turn capability");
        await expect(
          resolveMessageActionAgentRuntimeIdentityToken({
            ...terminalParams,
            turnCapability: sourceLessTurnCapability,
          }),
        ).rejects.toThrow("terminal source reply requires source-turn correlation");
        await expect(
          resolveMessageActionAgentRuntimeIdentityToken({
            ...terminalParams,
            target: "remote",
            turnCapability,
          }),
        ).rejects.toThrow("terminal source reply requires the trusted local gateway context");
        await expect(
          resolveMessageActionAgentRuntimeIdentityToken({
            ...terminalParams,
            target: "remote",
            turnCapability,
            callerOwnsTerminalReceipt: true,
          }),
        ).resolves.toBeUndefined();
        await expect(
          resolveMessageActionAgentRuntimeIdentityToken({ opts: {}, target: "local" }),
        ).resolves.toBeUndefined();
      },
    );
    await expect(
      resolveMessageActionAgentRuntimeIdentityToken({ ...terminalParams, turnCapability }),
    ).rejects.toThrow("terminal source reply requires trusted agent runtime identity");
  });

  it("mints split-session message action identity and rejects policy-session substitution", async () => {
    const policySessionKey = "agent:ops:telegram:default:direct:alice";
    const runSessionKey = "agent:ops:main";
    const operationalRunInstance = createOperationalRunInstanceRef("run-split-session");
    const turnCapability = mintMessageActionTurnCapability({
      agentId: "ops",
      runId: operationalRunInstance.runId,
      sessionKey: policySessionKey,
      sourceReplySessionKey: runSessionKey,
      sessionId: "session-split-session",
      toolContext: {
        currentChannelProvider: "telegram",
        currentChannelId: "alice",
        currentChatType: "direct",
        currentSourceTurnId: "source-turn-split-session",
      },
    });
    mintedTurnCapabilities.push(turnCapability);

    await withActiveGatewayToolCallerIdentity(
      {
        agentId: "ops",
        sessionKey: runSessionKey,
        operationalRunInstance,
      },
      async () => {
        await expect(
          resolveMessageActionAgentRuntimeIdentityToken({
            opts: {},
            target: "local",
            turnCapability,
            turnCapabilitySessionKey: "agent:ops:telegram:default:direct:mallory",
            runId: operationalRunInstance.runId,
            sessionId: "session-split-session",
            sourceReplyFinal: true,
            sourceReplyToolCallId: "message-call-substituted-session",
          }),
        ).rejects.toThrow("terminal source reply requires an active turn capability");

        const token = await resolveMessageActionAgentRuntimeIdentityToken({
          opts: {},
          target: "local",
          turnCapability,
          turnCapabilitySessionKey: policySessionKey,
          runId: operationalRunInstance.runId,
          sessionId: "session-split-session",
          sourceReplyFinal: true,
          sourceReplyToolCallId: "message-call-split-session",
        });

        await expect(verifyAgentRuntimeIdentityToken(token)).resolves.toMatchObject({
          sessionKey: policySessionKey,
          operationalRunInstance,
          messageActionContext: {
            sourceReplySessionKey: runSessionKey,
            sourceReplyFinal: true,
            sourceReplyToolCallId: "message-call-split-session",
          },
        });
      },
    );
  });

  it.each([
    ["exec.approval.request", undefined, false],
    ["plugin.approval.request", "codex", false],
    ["exec.approval.request", undefined, true],
    ["plugin.approval.request", "codex", true],
  ] as const)(
    "sends %s with exact admitted identity for owner=%s collection=%s",
    async (method, approvalOwnerPluginId, enabled) => {
      mocks.callGateway.mockResolvedValueOnce({ id: "approval-1" });
      const operationalRunInstance = createOperationalRunInstanceRef("run-approval-1");
      const executionIdentityToken = enabled
        ? createExecutionIdentityAdmissionToken(operationalRunInstance.runId)
        : undefined;

      await withActiveGatewayToolCallerIdentity(
        {
          agentId: "ops",
          sessionKey: "agent:ops:main",
          operationalRunInstance,
          executionIdentityToken,
        },
        async () => {
          const request = async () =>
            await callGatewayTool(method, {}, { title: "Approve test action" });
          return approvalOwnerPluginId
            ? await withGatewayToolApprovalOwner(approvalOwnerPluginId, request)
            : await request();
        },
      );

      const call = capturedGatewayCall();
      expect(call.agentRuntimeIdentityToken).toEqual(expect.any(String));
      const verified = await verifyAgentRuntimeIdentityToken(call.agentRuntimeIdentityToken);
      expect(verified).toEqual(
        expect.objectContaining({
          operationalRunInstance,
          ...(approvalOwnerPluginId ? { approvalOwnerPluginId } : {}),
          ...(executionIdentityToken ? { executionIdentity: executionIdentityToken } : {}),
        }),
      );
      if (!executionIdentityToken) {
        expect(verified).not.toHaveProperty("executionIdentity");
      }
    },
  );

  it("rejects required approval identity outside signed local admission", async () => {
    await expect(
      callGatewayTool(
        "exec.approval.request",
        {},
        { command: "echo unsigned" },
        { requireAgentRuntimeIdentity: true },
      ),
    ).rejects.toThrow("trusted agent runtime identity required");

    await withActiveGatewayToolCallerIdentity(
      {
        agentId: "ops",
        sessionKey: "agent:ops:main",
        operationalRunInstance: createOperationalRunInstanceRef("run-1"),
      },
      async () => {
        await expect(
          callGatewayTool(
            "exec.approval.request",
            { gatewayToken: "remote-override" },
            { command: "echo remote" },
            { requireAgentRuntimeIdentity: true },
          ),
        ).rejects.toThrow("trusted local gateway context");
      },
    );
    expect(mocks.callGateway).not.toHaveBeenCalled();
  });

  it("rejects a mismatched execution token from the signed approval identity", async () => {
    mocks.callGateway.mockResolvedValueOnce({ id: "approval-1" });
    const operationalRunInstance = createOperationalRunInstanceRef("run-1");

    await withActiveGatewayToolCallerIdentity(
      {
        agentId: "ops",
        sessionKey: "agent:ops:main",
        operationalRunInstance,
        executionIdentityToken: createExecutionIdentityAdmissionToken("other-run"),
      },
      async () =>
        await callGatewayTool(
          "exec.approval.request",
          {},
          { command: "echo mismatch" },
          { requireAgentRuntimeIdentity: true },
        ),
    );

    const verified = await verifyAgentRuntimeIdentityToken(
      capturedGatewayCall().agentRuntimeIdentityToken,
    );
    expect(verified).toMatchObject({ operationalRunInstance });
    expect(verified).not.toHaveProperty("executionIdentity");
  });
});

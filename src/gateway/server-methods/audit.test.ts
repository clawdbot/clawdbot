import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExecutionDecisionCursorError } from "../../audit/execution-decision-receipts.js";
import { auditHandlers } from "./audit.js";

const { inspectExecutionIdentityRun, listAuditEvents } = vi.hoisted(() => ({
  inspectExecutionIdentityRun: vi.fn(),
  listAuditEvents: vi.fn(),
}));

vi.mock("../../audit/audit-event-store.js", () => ({ listAuditEvents }));
vi.mock("../../audit/execution-identity-context.js", () => ({ inspectExecutionIdentityRun }));

const accountRef = `hmac-sha256:v1:${"a".repeat(32)}:${"b".repeat(64)}`;

async function runAuditHandler(
  method: "audit.activity.list" | "audit.list" | "audit.run.inspect",
  params: object,
) {
  const respond = vi.fn();
  await expectDefined(
    auditHandlers[method],
    "auditHandlers[method] test invariant",
  )({ params, respond } as never);
  return respond;
}

describe("audit gateway methods", () => {
  beforeEach(() => {
    listAuditEvents.mockReset();
    listAuditEvents.mockReturnValue({
      events: [
        {
          schemaVersion: 1,
          eventId: "event-1",
          sequence: 10,
          sourceSequence: 2,
          occurredAt: 100,
          kind: "agent_run",
          action: "agent.run.finished",
          status: "succeeded",
          actorType: "agent",
          actorId: "main",
          agentId: "main",
          runId: "run-1",
          redaction: "metadata_only",
        },
      ],
      nextCursor: 10,
    });
    inspectExecutionIdentityRun.mockReset();
    inspectExecutionIdentityRun.mockReturnValue({
      schemaVersion: 1,
      run: { runId: "run-1", status: "unknown" },
      identity: {
        state: "unknown",
        reasonCode: "run_not_found",
        missingEvidence: ["run.record"],
        remediation: [{ code: "verify_run_id", text: "Verify the exact run id." }],
      },
      decisions: [],
      decisionDisplays: [],
      coverage: { state: "unknown", missingEvidence: ["run.record"] },
    });
  });

  it("preserves the exact shipped audit.list request and result shape", async () => {
    const respond = await runAuditHandler("audit.list", {
      agentId: "main",
      kind: "agent_run",
      after: 50,
      before: 150,
      limit: 25,
      cursor: "11",
    });

    expect(listAuditEvents).toHaveBeenCalledWith({
      limit: 25,
      cursor: 11,
      filters: { agentId: "main", kind: "agent_run", after: 50, before: 150 },
    });
    expect(respond).toHaveBeenCalledWith(true, {
      events: [
        {
          eventId: "event-1",
          sequence: 10,
          sourceSequence: 2,
          occurredAt: 100,
          kind: "agent_run",
          action: "agent.run.finished",
          status: "succeeded",
          actor: { type: "agent", id: "main" },
          agentId: "main",
          runId: "run-1",
          redaction: "metadata_only",
        },
      ],
      nextCursor: "10",
    });
  });

  it("keeps message filters invalid on the shipped audit.list method", async () => {
    const respond = await runAuditHandler("audit.list", { kind: "message" });

    expect(respond).toHaveBeenCalledWith(false, undefined, expect.any(Object));
    expect(listAuditEvents).not.toHaveBeenCalled();
  });

  it("returns versioned message activity without synthetic run provenance", async () => {
    listAuditEvents.mockReturnValue({
      events: [
        {
          schemaVersion: 1,
          eventId: "event-message-1",
          sequence: 11,
          sourceSequence: 3,
          occurredAt: 101,
          kind: "message",
          action: "message.outbound.finished",
          status: "succeeded",
          actorType: "system",
          actorId: "gateway",
          direction: "outbound",
          channel: "telegram",
          conversationKind: "direct",
          outcome: "sent",
          deliveryKind: "text",
          durationMs: 12,
          resultCount: 1,
          accountRef,
          targetRef: accountRef,
          redaction: "metadata_only",
        },
      ],
    });

    const respond = await runAuditHandler("audit.activity.list", {
      kind: "message",
      direction: "outbound",
      channel: "telegram",
    });

    expect(listAuditEvents).toHaveBeenCalledWith({
      limit: 100,
      filters: {
        includeMessages: true,
        kind: "message",
        direction: "outbound",
        channel: "telegram",
      },
    });
    expect(respond).toHaveBeenCalledWith(true, {
      events: [
        {
          eventType: "outbound_message",
          schemaVersion: 1,
          eventId: "event-message-1",
          sequence: 11,
          sourceSequence: 3,
          occurredAt: 101,
          kind: "message",
          action: "message.outbound.finished",
          direction: "outbound",
          status: "succeeded",
          actor: { type: "system", id: "gateway" },
          channel: "telegram",
          conversationKind: "direct",
          outcome: "sent",
          deliveryKind: "text",
          durationMs: 12,
          resultCount: 1,
          accountRef,
          targetRef: accountRef,
          redaction: "metadata_only",
        },
      ],
    });
    const result = respond.mock.calls[0]?.[1] as { events?: Array<Record<string, unknown>> };
    expect(result.events?.[0]).not.toHaveProperty("agentId");
    expect(result.events?.[0]).not.toHaveProperty("runId");
  });

  it("projects a store-validated channel-sender identity", async () => {
    listAuditEvents.mockReturnValue({
      events: [
        {
          schemaVersion: 1,
          eventId: "event-message-2",
          sequence: 12,
          sourceSequence: 4,
          occurredAt: 102,
          kind: "message",
          action: "message.inbound.processed",
          status: "succeeded",
          actorType: "channel_sender",
          actorId: accountRef,
          direction: "inbound",
          channel: "telegram",
          conversationKind: "direct",
          outcome: "completed",
          redaction: "metadata_only",
        },
      ],
    });

    const respond = await runAuditHandler("audit.activity.list", {
      kind: "message",
      direction: "inbound",
    });

    expect(respond).toHaveBeenCalledWith(true, {
      events: [
        expect.objectContaining({
          eventType: "inbound_message",
          actor: { type: "channel_sender", id: accountRef },
        }),
      ],
    });
  });

  it.each([
    { kind: "agent_run", direction: "inbound" },
    { kind: "agent_run", channel: "telegram" },
    { kind: "message", sessionKey: "agent:main:main" },
    { sessionKey: "agent:main:main", direction: "inbound" },
    { sessionKey: "agent:main:main", channel: "telegram" },
  ])(
    "rejects impossible activity filters before storage: $kind $direction $channel",
    async (params) => {
      const respond = await runAuditHandler("audit.activity.list", params);

      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          message: expect.stringContaining("invalid audit.activity.list filters"),
        }),
      );
      expect(listAuditEvents).not.toHaveBeenCalled();
    },
  );

  it.each(["audit.list", "audit.activity.list"] as const)(
    "rejects malformed cursors and inverted ranges for %s",
    async (method) => {
      expect(await runAuditHandler(method, { cursor: "bad" })).toHaveBeenCalledWith(
        false,
        undefined,
        expect.any(Object),
      );
      expect(await runAuditHandler(method, { after: 2, before: 1 })).toHaveBeenCalledWith(
        false,
        undefined,
        expect.any(Object),
      );
      expect(listAuditEvents).not.toHaveBeenCalled();
    },
  );

  it.each(["audit.list", "audit.activity.list"] as const)(
    "trims whitespace around cursor digits for %s",
    async (method) => {
      const respond = await runAuditHandler(method, { cursor: "  11  " });
      expect(respond).toHaveBeenCalledWith(true, expect.anything());
      expect(listAuditEvents).toHaveBeenCalledWith(expect.objectContaining({ cursor: 11 }));
    },
  );

  it.each(["audit.list", "audit.activity.list"] as const)(
    "trims exact-match filter ids for %s before store lookup",
    async (method) => {
      const respond = await runAuditHandler(method, {
        agentId: " main ",
        sessionKey: " agent:main:main ",
        runId: " run-1 ",
      });

      expect(respond).toHaveBeenCalledWith(true, expect.anything());
      expect(listAuditEvents).toHaveBeenCalledWith(
        expect.objectContaining({
          filters: expect.objectContaining({
            agentId: "main",
            sessionKey: "agent:main:main",
            runId: "run-1",
            ...(method === "audit.activity.list" ? { includeMessages: true } : {}),
          }),
        }),
      );
    },
  );

  it("projects bounded run discovery and exact execution selection", async () => {
    await runAuditHandler("audit.run.inspect", {
      runId: "run-1",
      executionCursor: " 2 ",
      executionLimit: 10,
      decisionCursor: "a:2000:42",
      decisionLimit: 25,
    });
    expect(inspectExecutionIdentityRun).toHaveBeenLastCalledWith({
      runId: "run-1",
      executionOffset: 2,
      executionLimit: 10,
      decisionCursor: "a:2000:42",
      decisionLimit: 25,
    });

    await runAuditHandler("audit.run.inspect", {
      executionId: "execution-1",
      decisionLimit: 20,
    });
    expect(inspectExecutionIdentityRun).toHaveBeenLastCalledWith({
      executionId: "execution-1",
      decisionLimit: 20,
    });

    await runAuditHandler("audit.run.inspect", {
      executionId: "execution-1",
      decisionCursor: "1",
      decisionLimit: 20,
    });
    expect(inspectExecutionIdentityRun).toHaveBeenLastCalledWith({
      executionId: "execution-1",
      decisionCursor: "1",
      decisionLimit: 20,
    });
  });

  it("serializes only the safe decision projection", async () => {
    const hostile = {
      receipt: "U2_R6_GATEWAY_RECEIPT_SECRET_05d8",
      resolutionRef: "U2_R6_GATEWAY_RESOLUTION_REF_SECRET_a941",
      eventId: "U2_R6_GATEWAY_EVENT_ID_SECRET_7b21",
      context: "U2_R6_GATEWAY_CONTEXT_SECRET_812a",
      execution: "U2_R6_GATEWAY_EXECUTION_SECRET_469b",
      run: "U2_R6_GATEWAY_RUN_SECRET_e8e7",
      resource: "U2_R6_GATEWAY_RESOURCE_SECRET_170c",
      target: "U2_R6_GATEWAY_TARGET_SECRET_1d49",
      record: "U2_R6_GATEWAY_RECORD_SECRET_017b",
      evaluator: "U2_R6_GATEWAY_EVALUATOR_SECRET_2aa3",
      owner: "U2_R6_GATEWAY_OWNER_SECRET_f72d",
      policy: "U2_R6_GATEWAY_POLICY_SECRET_7ae1",
      grant: "U2_R6_GATEWAY_GRANT_SECRET_8da2",
      reason: "U2_R6_GATEWAY_REASON_SECRET_bf5f",
      remediationCode: "U2_R6_GATEWAY_REMEDIATION_CODE_SECRET_96c3",
      remediationText: "U2_R6_GATEWAY_REMEDIATION_TEXT_SECRET_e403",
      generic:
        "U2_R6_GATEWAY_COMMAND_PATH_TOOL_INPUT_PERMISSION_TITLE_INPUT_METADATA_GENERIC_SECRET_66a1",
    };
    inspectExecutionIdentityRun.mockReturnValueOnce({
      schemaVersion: 1,
      run: { runId: "run-1", executionId: "execution-1", status: "known" },
      identity: {
        state: "unknown",
        reasonCode: "run_not_found",
        missingEvidence: ["run.record"],
        remediation: [],
      },
      decisions: [
        {
          schemaVersion: 1,
          receiptId: hostile.receipt,
          contextId: hostile.context,
          executionId: hostile.execution,
          runId: hostile.run,
          actionId: hostile.eventId,
          occurredAt: 1,
          action: {
            family: "tool",
            operation: "execute",
            resourceRef: hostile.resource,
            targetRef: hostile.target,
            summary: hostile.generic,
          },
          decision: { outcome: "allowed", reasonCode: hostile.reason },
          enforcement: {
            coverageState: "enforced",
            evaluatorRef: hostile.evaluator,
            policyRefs: [hostile.policy],
            grantRefs: [hostile.grant],
            contextFieldsUsed: [],
          },
          source: {
            owner: hostile.owner,
            recordRef: hostile.resolutionRef,
            decisionBoundary: hostile.record,
          },
          missingEvidence: [],
          remediation: [{ code: hostile.remediationCode, text: hostile.remediationText }],
        },
      ],
      decisionDisplays: [],
      coverage: { state: "unknown", missingEvidence: ["run.record"] },
    });

    const respond = await runAuditHandler("audit.run.inspect", { executionId: "execution-1" });
    const result = respond.mock.calls[0]?.[1];
    const json = JSON.stringify(result);

    expect(result).not.toHaveProperty("decisions");
    expect(result).toEqual(
      expect.objectContaining({ decisionDisplays: [], coverage: expect.any(Object) }),
    );
    for (const rawKey of ["receiptId", "resolutionRef", "eventId"]) {
      expect(json).not.toContain(`"${rawKey}"`);
    }
    for (const secret of Object.values(hostile)) {
      expect(json).not.toContain(secret);
    }
  });

  it.each([
    {
      name: "present",
      identity: {
        state: "present",
        context: {
          schemaVersion: 1,
          contextId: "context-1",
          executionId: "execution-1",
          runId: "run-1",
          createdAt: 1,
          trustDomain: { kind: "gateway-cell", domainRef: accountRef, state: "present" },
          invoker: { state: "absent" },
          ingress: {
            kind: "gateway-client",
            boundary: "gateway.ws.authenticated-connect",
            state: "present",
          },
          agentPrincipal: { kind: "agent", domainRef: accountRef, principalRef: "main" },
          agentDefinition: { definitionRef: "main", state: "present" },
          runtimeInstance: { runtimeRef: accountRef, kind: "gateway", state: "present" },
          applicableGrants: [],
          assurance: [],
          coverageState: "unattributed",
          missingEvidence: [],
        },
      },
    },
    {
      name: "unavailable",
      identity: {
        state: "unsupported",
        reasonCode: "identity_context_unavailable",
        missingEvidence: ["identity.context"],
        remediation: [],
      },
    },
    {
      name: "ambiguous",
      identity: {
        state: "ambiguous",
        reasonCode: "execution_selection_required",
        candidates: [],
        missingEvidence: ["execution.selection"],
        remediation: [],
      },
    },
  ] as const)("keeps the $name success response safe-only", async ({ identity }) => {
    inspectExecutionIdentityRun.mockReturnValueOnce({
      schemaVersion: 1,
      run: { runId: "run-1", status: "known" },
      identity,
      decisions: [],
      decisionDisplays: [],
      coverage: { state: "unknown", missingEvidence: [] },
    });

    const respond = await runAuditHandler("audit.run.inspect", { runId: "run-1" });
    const result = respond.mock.calls[0]?.[1];
    expect(result).toEqual(
      expect.objectContaining({ decisionDisplays: [], coverage: expect.any(Object) }),
    );
    expect(result).not.toHaveProperty("decisions");
    expect(JSON.stringify(result)).not.toContain('"decisions"');
  });

  it.each(["1", "001"])(
    "preserves mirrored numeric cursor %s for execution paging",
    async (decisionCursor) => {
      await runAuditHandler("audit.run.inspect", {
        runId: "run-1",
        executionCursor: decisionCursor,
        decisionCursor,
        decisionLimit: 25,
      });

      expect(inspectExecutionIdentityRun).toHaveBeenLastCalledWith({
        runId: "run-1",
        executionOffset: 1,
        executionLimit: 50,
        decisionCursor,
        decisionLimit: 25,
      });
    },
  );

  it.each(["a:2000:42", "m:2000:42", "g:2000:42", "c:2000:42", "t:2000:42", "f:2000:42"])(
    "treats mirrored owner decision cursor %s as decision-only",
    async (decisionCursor) => {
      await runAuditHandler("audit.run.inspect", {
        runId: "run-1",
        executionCursor: decisionCursor,
        decisionCursor,
        decisionLimit: 25,
      });

      expect(inspectExecutionIdentityRun).toHaveBeenLastCalledWith({
        runId: "run-1",
        executionLimit: 50,
        decisionCursor,
        decisionLimit: 25,
      });
    },
  );

  it("rejects malformed run inspection before storage access", async () => {
    expect(
      await runAuditHandler("audit.run.inspect", { runId: "", extra: true }),
    ).toHaveBeenCalledWith(false, undefined, expect.any(Object));
    expect(
      await runAuditHandler("audit.run.inspect", { runId: "run-1", decisionCursor: "0" }),
    ).toHaveBeenCalledWith(false, undefined, expect.any(Object));
    for (const decisionCursor of ["-1", "1.5", "1a", "a:1:2x", "9007199254740992"]) {
      expect(
        await runAuditHandler("audit.run.inspect", { runId: "run-1", decisionCursor }),
      ).toHaveBeenCalledWith(false, undefined, expect.any(Object));
    }
    expect(
      await runAuditHandler("audit.run.inspect", {
        runId: "run-1",
        executionId: "execution-1",
      }),
    ).toHaveBeenCalledWith(false, undefined, expect.any(Object));
    expect(inspectExecutionIdentityRun).not.toHaveBeenCalled();
  });

  it("tells the operator how to recover from an expired decision cursor", async () => {
    inspectExecutionIdentityRun.mockImplementationOnce(() => {
      throw new ExecutionDecisionCursorError(
        "decision cursor is no longer retained; restart inspection without --cursor",
      );
    });

    const respond = await runAuditHandler("audit.run.inspect", {
      runId: "run-1",
      decisionCursor: "a:2000:42",
    });
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: "decision cursor is no longer retained; restart inspection without --cursor",
      }),
    );
  });
});

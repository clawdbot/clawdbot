import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureExecutionIdentityAdmissionSink,
  type ExecutionIdentityAdmissionWork,
} from "../../audit/execution-identity-admission.js";
import { admitAutoReplyExecutionAttribution } from "./agent-runner-execution-identity.js";

describe("admitAutoReplyExecutionAttribution", () => {
  let restoreSink: (() => void) | undefined;

  afterEach(() => {
    restoreSink?.();
    restoreSink = undefined;
  });

  it("records exact channel and requester evidence with the runtime correlation", () => {
    const work: ExecutionIdentityAdmissionWork[] = [];
    restoreSink = configureExecutionIdentityAdmissionSink((item) => {
      work.push(item);
      return true;
    });

    const attribution = admitAutoReplyExecutionAttribution({
      config: { logging: { audit: { enabled: true, executionIdentity: true } } },
      lifecycleGeneration: "generation-1",
      runId: "run-1",
      context: {
        accountId: "workspace-1",
        agentId: "main",
        channel: "slack",
        chatId: "C123",
        messageId: "M456",
        senderId: "U789",
        senderLabel: "Operator",
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        threadId: "T123",
        isHeartbeat: false,
      },
    });

    expect(work).toHaveLength(1);
    expect(work[0]).toMatchObject({
      kind: "capture",
      envelope: {
        contextId: attribution.contextId,
        executionId: attribution.executionId,
        runId: "run-1",
        ingress: { kind: "channel", boundary: "auto-reply.channel" },
        invoker: { kind: "person", displayLabel: "Operator" },
        runtime: { kind: "embedded" },
        assurance: [{ kind: "channel-admission", strength: "boundary-verified" }],
      },
    });
    expect(attribution).not.toHaveProperty("executionIdentityAdmission");
  });

  it.each([
    {
      label: "heartbeat",
      ingressKind: "system",
      context: { channel: "slack", isHeartbeat: true },
    },
    {
      label: "internal system",
      ingressKind: "system",
      context: {
        channel: "slack",
        inputProvenance: { kind: "internal_system" as const, sourceTool: "test" },
        isHeartbeat: false,
      },
    },
    {
      label: "inter-session",
      ingressKind: "subagent",
      context: {
        channel: "slack",
        inputProvenance: {
          kind: "inter_session" as const,
          sourceSessionKey: "agent:worker:main",
        },
        isHeartbeat: false,
      },
    },
  ])("does not assert channel admission for $label ingress", ({ context, ingressKind }) => {
    const work: ExecutionIdentityAdmissionWork[] = [];
    restoreSink = configureExecutionIdentityAdmissionSink((item) => {
      work.push(item);
      return true;
    });

    admitAutoReplyExecutionAttribution({
      config: { logging: { audit: { enabled: true, executionIdentity: true } } },
      lifecycleGeneration: "generation-1",
      runId: `run-${ingressKind}`,
      context,
    });

    expect(work[0]).toMatchObject({
      kind: "capture",
      envelope: { ingress: { kind: ingressKind } },
    });
    const assurance = work[0]?.kind === "capture" ? work[0].envelope.assurance : undefined;
    expect(assurance?.some((item) => item.kind === "channel-admission")).toBe(false);
  });

  it("accepts long run ids without touching the disabled audit sink", () => {
    const sink = vi.fn(() => true);
    restoreSink = configureExecutionIdentityAdmissionSink(sink);
    const runId = "r".repeat(1_024);

    const attribution = admitAutoReplyExecutionAttribution({
      config: {},
      lifecycleGeneration: "generation-1",
      runId,
      context: { isHeartbeat: false },
    });

    expect(attribution.runId).toBe(runId);
    expect(attribution).not.toHaveProperty("executionIdentityAdmission");
    expect(sink).not.toHaveBeenCalled();
  });

  it("does not persist or replace an already admitted attribution", () => {
    const sink = vi.fn(() => true);
    restoreSink = configureExecutionIdentityAdmissionSink(sink);
    const attribution = admitAutoReplyExecutionAttribution({
      config: {},
      lifecycleGeneration: "generation-1",
      runId: "run-1",
      context: { isHeartbeat: false },
    });

    expect(
      admitAutoReplyExecutionAttribution({
        attribution,
        config: { logging: { audit: { enabled: true, executionIdentity: true } } },
        lifecycleGeneration: "generation-2",
        runId: "run-1",
        context: { isHeartbeat: false },
      }),
    ).toBe(attribution);
    expect(sink).not.toHaveBeenCalled();
  });
});

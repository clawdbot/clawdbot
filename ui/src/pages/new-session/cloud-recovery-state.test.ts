import { beforeEach, describe, expect, it } from "vitest";
import { PendingCloudRecoveryState } from "./cloud-recovery-state.ts";
import { readCloudSessionRecovery } from "./cloud-recovery.ts";

describe("pending cloud recovery state", () => {
  beforeEach(() => sessionStorage.clear());

  it("stages an idempotent create before the Gateway request", () => {
    const pending = new PendingCloudRecoveryState();
    const createParams = pending.stageCreate({
      agentId: "cloud",
      profileId: "aws",
      message: "run remotely",
      gatewayUrl: "ws://gateway.example",
      recoveryScope: "principal-a",
      createParams: { agentId: "cloud", message: "", worktree: true },
    });

    expect(createParams).toMatchObject({
      agentId: "cloud",
      key: expect.stringMatching(/^agent:cloud:dashboard:/),
      worktree: true,
    });
    expect(readCloudSessionRecovery("ws://gateway.example", "principal-a")).toMatchObject({
      phase: "creating",
      sessionKey: createParams?.key,
      createParams,
    });
  });

  it("promotes the acknowledged server key before dispatch", () => {
    const pending = new PendingCloudRecoveryState();
    expect(
      pending.stageCreate({
        agentId: "cloud",
        profileId: "aws",
        message: "run remotely",
        gatewayUrl: "ws://gateway.example",
        recoveryScope: "principal-a",
        createParams: { agentId: "cloud", message: "", worktree: true },
      }),
    ).not.toBeNull();

    expect(pending.promoteToDispatching("agent:cloud:dashboard:server-key")).toBe(true);
    expect(readCloudSessionRecovery("ws://gateway.example", "principal-a")).toMatchObject({
      phase: "dispatching",
      sessionKey: "agent:cloud:dashboard:server-key",
    });
    expect(pending.createParams).toBeUndefined();
  });

  it("captures creating recovery without sharing mutable payloads", () => {
    const pending = new PendingCloudRecoveryState();
    expect(
      pending.stageCreate({
        agentId: "cloud",
        profileId: "aws",
        message: "run remotely",
        attachments: [{ type: "image" }],
        gatewayUrl: "ws://gateway.example",
        recoveryScope: "principal-a",
        createParams: { agentId: "cloud", message: "", worktree: true },
      }),
    ).not.toBeNull();

    const captured = pending.capture();
    expect(captured).toMatchObject({
      phase: "creating",
      message: "run remotely",
      createParams: { key: pending.sessionKey },
    });
    expect(captured?.attachments).not.toBe(pending.attachments);
    expect(captured?.createParams).not.toBe(pending.createParams);
  });
});

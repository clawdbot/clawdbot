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
      createParams: { agentId: "cloud", message: "", thinkingLevel: "high", worktree: true },
    });

    expect(createParams).toMatchObject({
      agentId: "cloud",
      key: expect.stringMatching(/^agent:cloud:dashboard:/),
      thinkingLevel: "high",
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

  it("keeps incognito cloud drafts in memory without writing recovery storage", () => {
    const pending = new PendingCloudRecoveryState();
    const createParams = pending.stageCreate({
      agentId: "cloud",
      profileId: "aws",
      message: "private remote task",
      gatewayUrl: "ws://gateway.example",
      recoveryScope: "principal-a",
      createParams: {
        agentId: "cloud",
        incognito: true,
        message: "",
        worktree: true,
      },
      persistent: false,
    });

    expect(createParams).toMatchObject({
      agentId: "cloud",
      incognito: true,
      worktree: true,
    });
    expect(createParams).not.toHaveProperty("key");
    expect(pending.persistent).toBe(false);
    expect(readCloudSessionRecovery("ws://gateway.example", "principal-a")).toBeNull();
    expect(pending.promoteToDispatching("agent:cloud:dashboard:server-key")).toBe(true);
    expect(pending.sessionKey).toBe("agent:cloud:dashboard:server-key");
    expect(readCloudSessionRecovery("ws://gateway.example", "principal-a")).toBeNull();
  });

  it("rejects a persisted recovery record that claims to be incognito", () => {
    sessionStorage.setItem(
      "openclaw.new-session.cloud-recovery.v1:ws://gateway.example:principal-a",
      JSON.stringify({
        sessionKey: "agent:cloud:dashboard:persisted-incognito",
        messageId: "message-private",
        message: "private task",
        profileId: "aws",
        agentId: "cloud",
        gatewayUrl: "ws://gateway.example",
        recoveryScope: "principal-a",
        phase: "creating",
        createParams: {
          key: "agent:cloud:dashboard:persisted-incognito",
          agentId: "cloud",
          incognito: true,
          message: "",
          worktree: true,
        },
      }),
    );

    const pending = new PendingCloudRecoveryState();
    expect(pending.restore("ws://gateway.example", "principal-a")).toBeNull();
    expect(sessionStorage.length).toBe(0);
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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cloudSessionRecoveryExactStorageKey } from "../../lib/sessions/cloud-recovery-storage-key.ts";
import {
  readCloudSessionRecovery,
  writeCloudSessionRecovery,
} from "../../lib/sessions/cloud-recovery.ts";
import {
  PendingCloudRecoveryState,
  resolveSubmissionOutcomeReason,
} from "./cloud-recovery-state.ts";

describe("pending cloud recovery state", () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    {
      name: "a replacement Gateway",
      gatewayIdentityChanged: true,
      cloudDraftOwned: true,
      expected: "gateway-changed",
    },
    {
      name: "a normal local submission",
      gatewayIdentityChanged: false,
      cloudDraftOwned: false,
      expected: "gateway-changed",
    },
    {
      name: "an interrupted cloud draft",
      gatewayIdentityChanged: false,
      cloudDraftOwned: true,
      expected: "cloud-interrupted",
    },
  ])("classifies $name accurately", ({ expected, gatewayIdentityChanged, cloudDraftOwned }) => {
    expect(resolveSubmissionOutcomeReason({ gatewayIdentityChanged, cloudDraftOwned })).toBe(
      expected,
    );
  });

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
    expect(
      readCloudSessionRecovery("ws://gateway.example", "principal-a", pending.sessionKey),
    ).toMatchObject({
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
    const provisionalSessionKey = pending.sessionKey;
    const storage = sessionStorage;
    const provisionalKey = cloudSessionRecoveryExactStorageKey(
      "ws://gateway.example",
      "principal-a",
      provisionalSessionKey,
    );
    const canonicalKey = cloudSessionRecoveryExactStorageKey(
      "ws://gateway.example",
      "principal-a",
      "agent:cloud:dashboard:server-key",
    );
    vi.stubGlobal("sessionStorage", {
      get length() {
        return storage.length;
      },
      getItem: storage.getItem.bind(storage),
      key: storage.key.bind(storage),
      removeItem: storage.removeItem.bind(storage),
      setItem(key: string, value: string) {
        if (key === canonicalKey && storage.getItem(provisionalKey) !== null) {
          throw new DOMException("quota exceeded", "QuotaExceededError");
        }
        storage.setItem(key, value);
      },
    });

    expect(pending.promoteToDispatching("agent:cloud:dashboard:server-key")).toBe(true);
    expect(
      readCloudSessionRecovery("ws://gateway.example", "principal-a", provisionalSessionKey),
    ).toBeNull();
    expect(
      readCloudSessionRecovery(
        "ws://gateway.example",
        "principal-a",
        "agent:cloud:dashboard:server-key",
      ),
    ).toMatchObject({
      phase: "dispatching",
      sessionKey: "agent:cloud:dashboard:server-key",
    });
    expect(pending.createParams).toBeUndefined();
  });

  it("restores the provisional row when canonical promotion cannot be written", () => {
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
    const storage = sessionStorage;
    const provisionalSessionKey = pending.sessionKey;
    const provisionalKey = cloudSessionRecoveryExactStorageKey(
      "ws://gateway.example",
      "principal-a",
      provisionalSessionKey,
    );
    const canonicalSessionKey = "agent:cloud:dashboard:server-key";
    const canonicalKey = cloudSessionRecoveryExactStorageKey(
      "ws://gateway.example",
      "principal-a",
      canonicalSessionKey,
    );
    const raw = storage.getItem(provisionalKey);
    vi.stubGlobal("sessionStorage", {
      get length() {
        return storage.length;
      },
      getItem: storage.getItem.bind(storage),
      key: storage.key.bind(storage),
      removeItem: storage.removeItem.bind(storage),
      setItem(key: string, value: string) {
        if (key === canonicalKey) {
          throw new DOMException("quota exceeded", "QuotaExceededError");
        }
        storage.setItem(key, value);
      },
    });

    expect(pending.promoteToDispatching(canonicalSessionKey)).toBe(false);
    expect(storage.getItem(provisionalKey)).toBe(raw);
    expect(storage.getItem(canonicalKey)).toBeNull();
    expect(pending.sessionKey).toBe(provisionalSessionKey);
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
    expect(
      readCloudSessionRecovery("ws://gateway.example", "principal-a", pending.sessionKey),
    ).toBeNull();
    expect(pending.promoteToDispatching("agent:cloud:dashboard:server-key")).toBe(true);
    expect(pending.sessionKey).toBe("agent:cloud:dashboard:server-key");
    expect(
      readCloudSessionRecovery(
        "ws://gateway.example",
        "principal-a",
        "agent:cloud:dashboard:server-key",
      ),
    ).toBeNull();
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

  it("restores only page-owned creating work", () => {
    const dispatching = {
      sessionKey: "agent:cloud:dispatching",
      messageId: "message-dispatching",
      message: "dispatching task",
      profileId: "aws",
      agentId: "cloud",
      gatewayUrl: "ws://gateway.example",
      recoveryScope: "principal-a",
      phase: "dispatching" as const,
    };
    const sending = {
      ...dispatching,
      sessionKey: "agent:cloud:sending",
      messageId: "message-sending",
      phase: "sending" as const,
    };
    const creating = {
      ...dispatching,
      sessionKey: "agent:cloud:creating",
      messageId: "message-creating",
      phase: "creating" as const,
      createParams: {
        key: "agent:cloud:creating",
        agentId: "cloud",
        message: "" as const,
        worktree: true as const,
      },
    };
    expect(writeCloudSessionRecovery(dispatching)).toBe(true);
    expect(writeCloudSessionRecovery(sending)).toBe(true);

    const pending = new PendingCloudRecoveryState();
    expect(pending.restore("ws://gateway.example", "principal-a")).toBeNull();
    expect(pending.sessionKey).toBe("");

    expect(writeCloudSessionRecovery(creating)).toBe(true);
    expect(pending.restore("ws://gateway.example", "principal-a")).toEqual(creating);
    expect(pending.sessionKey).toBe(creating.sessionKey);
  });

  it("neutralizes a stale local owner without clearing newer durable recovery", () => {
    const pending = new PendingCloudRecoveryState();
    expect(
      pending.stageCreate({
        agentId: "cloud",
        profileId: "aws",
        message: "stale task",
        gatewayUrl: "ws://gateway.example",
        recoveryScope: "principal-a",
        createParams: { agentId: "cloud", message: "", worktree: true },
      }),
    ).not.toBeNull();
    const staleKey = pending.sessionKey;
    const newerRecovery = {
      sessionKey: "agent:cloud:newer",
      messageId: "message-newer",
      message: "newer task",
      profileId: "aws",
      agentId: "cloud",
      gatewayUrl: "ws://gateway.example",
      recoveryScope: "principal-a",
      phase: "dispatching" as const,
    };
    expect(writeCloudSessionRecovery(newerRecovery)).toBe(true);

    pending.clearFor("ws://gateway.example", "principal-a", staleKey);

    expect(pending.sessionKey).toBe("");
    expect(
      readCloudSessionRecovery("ws://gateway.example", "principal-a", newerRecovery.sessionKey),
    ).toEqual(newerRecovery);
  });
});

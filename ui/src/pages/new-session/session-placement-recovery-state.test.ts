import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionPlacementRecoveryExactStorageKey } from "../../lib/sessions/session-placement-recovery-storage-key.ts";
import {
  readSessionPlacementRecovery,
  writeSessionPlacementRecovery,
} from "../../lib/sessions/session-placement-recovery.ts";
import {
  PendingSessionPlacementRecoveryState,
  resolveSubmissionOutcomeReason,
} from "./session-placement-recovery-state.ts";

describe("pending session placement recovery state", () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    {
      name: "a replacement Gateway",
      gatewayIdentityChanged: true,
      placementDraftOwned: true,
      expected: "gateway-changed",
    },
    {
      name: "a normal local submission",
      gatewayIdentityChanged: false,
      placementDraftOwned: false,
      expected: "gateway-changed",
    },
    {
      name: "an interrupted placement draft",
      gatewayIdentityChanged: false,
      placementDraftOwned: true,
      expected: "placement-interrupted",
    },
  ])("classifies $name accurately", ({ expected, gatewayIdentityChanged, placementDraftOwned }) => {
    expect(resolveSubmissionOutcomeReason({ gatewayIdentityChanged, placementDraftOwned })).toBe(
      expected,
    );
  });

  it("stages an idempotent create before the Gateway request", () => {
    const pending = new PendingSessionPlacementRecoveryState();
    const createParams = pending.stageCreate({
      agentId: "cloud",
      target: { kind: "profile", profileId: "aws", machineClass: "fast" },
      message: "run remotely",
      gatewayUrl: "ws://gateway.example",
      recoveryScope: "principal-a",
      createParams: {
        agentId: "cloud",
        message: "",
        thinkingLevel: "high",
        contextWindow: "large",
        worktree: true,
      },
    });

    expect(createParams).toMatchObject({
      agentId: "cloud",
      key: expect.stringMatching(/^agent:cloud:dashboard:/),
      thinkingLevel: "high",
      contextWindow: "large",
      worktree: true,
    });
    expect(
      readSessionPlacementRecovery("ws://gateway.example", "principal-a", pending.sessionKey),
    ).toMatchObject({
      phase: "creating",
      target: { kind: "profile", profileId: "aws", machineClass: "fast" },
      sessionKey: createParams?.key,
      createParams,
    });
  });

  it("preserves the requested permission mode in placement recovery", () => {
    const pending = new PendingSessionPlacementRecoveryState();
    const createParams = pending.stageCreate({
      agentId: "cloud",
      target: { kind: "profile", profileId: "aws" },
      message: "run remotely with guarded permissions",
      gatewayUrl: "ws://gateway.example",
      recoveryScope: "principal-a",
      createParams: {
        agentId: "cloud",
        message: "",
        permissionMode: "guarded",
        worktree: true,
      },
    });

    expect(createParams).toMatchObject({ permissionMode: "guarded" });
    expect(
      readSessionPlacementRecovery("ws://gateway.example", "principal-a", pending.sessionKey),
    ).toMatchObject({ createParams: { permissionMode: "guarded" } });
  });

  it.each([false, true])(
    "does not promote over a replacement submission (canonical key changes: %s)",
    (changesKey) => {
      const pending = new PendingSessionPlacementRecoveryState();
      expect(
        pending.stageCreate({
          agentId: "cloud",
          target: { kind: "device", deviceId: "device-1" },
          message: "old input",
          gatewayUrl: "ws://gateway.example",
          recoveryScope: "principal-a",
          createParams: { agentId: "cloud", message: "", worktree: true },
        }),
      ).not.toBeNull();
      const previous = pending.capture();
      expect(previous).not.toBeNull();
      const replacement = { ...previous!, messageId: "new-submission", message: "new input" };
      expect(writeSessionPlacementRecovery(replacement)).toBe(true);
      expect(
        pending.promoteToDispatching(changesKey ? "agent:cloud:canonical" : pending.sessionKey),
      ).toBe(false);
      expect(
        readSessionPlacementRecovery(pending.gatewayUrl, pending.recoveryScope, pending.sessionKey),
      ).toEqual(replacement);
    },
  );

  it.each(["", "x".repeat(129)])(
    "rejects an invalid persisted machine class %#",
    (machineClass) => {
      expect(
        writeSessionPlacementRecovery({
          sessionKey: "agent:cloud:invalid-machine",
          messageId: "message-invalid-machine",
          message: "run remotely",
          target: { kind: "profile", profileId: "aws", machineClass },
          agentId: "cloud",
          gatewayUrl: "ws://gateway.example",
          recoveryScope: "principal-a",
          phase: "dispatching",
        }),
      ).toBe(false);
      expect(sessionStorage.length).toBe(0);
    },
  );

  it("promotes the acknowledged server key before dispatch", () => {
    const pending = new PendingSessionPlacementRecoveryState();
    expect(
      pending.stageCreate({
        agentId: "cloud",
        target: { kind: "profile", profileId: "aws" },
        message: "run remotely",
        gatewayUrl: "ws://gateway.example",
        recoveryScope: "principal-a",
        createParams: { agentId: "cloud", message: "", worktree: true },
      }),
    ).not.toBeNull();
    const provisionalSessionKey = pending.sessionKey;
    const storage = sessionStorage;
    const provisionalKey = sessionPlacementRecoveryExactStorageKey(
      "ws://gateway.example",
      "principal-a",
      provisionalSessionKey,
    );
    const canonicalKey = sessionPlacementRecoveryExactStorageKey(
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
      readSessionPlacementRecovery("ws://gateway.example", "principal-a", provisionalSessionKey),
    ).toBeNull();
    expect(
      readSessionPlacementRecovery(
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
    const pending = new PendingSessionPlacementRecoveryState();
    expect(
      pending.stageCreate({
        agentId: "cloud",
        target: { kind: "profile", profileId: "aws" },
        message: "run remotely",
        gatewayUrl: "ws://gateway.example",
        recoveryScope: "principal-a",
        createParams: { agentId: "cloud", message: "", worktree: true },
      }),
    ).not.toBeNull();
    const storage = sessionStorage;
    const provisionalSessionKey = pending.sessionKey;
    const provisionalKey = sessionPlacementRecoveryExactStorageKey(
      "ws://gateway.example",
      "principal-a",
      provisionalSessionKey,
    );
    const canonicalSessionKey = "agent:cloud:dashboard:server-key";
    const canonicalKey = sessionPlacementRecoveryExactStorageKey(
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

  it("keeps incognito placement drafts in memory without writing recovery storage", () => {
    const pending = new PendingSessionPlacementRecoveryState();
    const createParams = pending.stageCreate({
      agentId: "cloud",
      target: { kind: "profile", profileId: "aws" },
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
      readSessionPlacementRecovery("ws://gateway.example", "principal-a", pending.sessionKey),
    ).toBeNull();
    expect(pending.promoteToDispatching("agent:cloud:dashboard:server-key")).toBe(true);
    expect(pending.sessionKey).toBe("agent:cloud:dashboard:server-key");
    expect(
      readSessionPlacementRecovery(
        "ws://gateway.example",
        "principal-a",
        "agent:cloud:dashboard:server-key",
      ),
    ).toBeNull();
  });

  it("rejects a persisted recovery record that claims to be incognito", () => {
    sessionStorage.setItem(
      sessionPlacementRecoveryExactStorageKey(
        "ws://gateway.example",
        "principal-a",
        "agent:cloud:dashboard:persisted-incognito",
      ),
      JSON.stringify({
        sessionKey: "agent:cloud:dashboard:persisted-incognito",
        messageId: "message-private",
        message: "private task",
        target: { kind: "profile", profileId: "aws" },
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

    const pending = new PendingSessionPlacementRecoveryState();
    expect(pending.restore("ws://gateway.example", "principal-a")).toBeNull();
    expect(sessionStorage.length).toBe(0);
  });

  it("captures creating recovery without sharing mutable payloads", () => {
    const pending = new PendingSessionPlacementRecoveryState();
    expect(
      pending.stageCreate({
        agentId: "cloud",
        target: { kind: "profile", profileId: "aws" },
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
      target: { kind: "profile" as const, profileId: "aws" },
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
    expect(writeSessionPlacementRecovery(dispatching)).toBe(true);
    expect(writeSessionPlacementRecovery(sending)).toBe(true);

    const pending = new PendingSessionPlacementRecoveryState();
    expect(pending.restore("ws://gateway.example", "principal-a")).toBeNull();
    expect(pending.sessionKey).toBe("");

    expect(writeSessionPlacementRecovery(creating)).toBe(true);
    expect(pending.restore("ws://gateway.example", "principal-a")).toEqual(creating);
    expect(pending.sessionKey).toBe(creating.sessionKey);
  });

  it("neutralizes a stale local owner without clearing newer durable recovery", () => {
    const pending = new PendingSessionPlacementRecoveryState();
    expect(
      pending.stageCreate({
        agentId: "cloud",
        target: { kind: "profile", profileId: "aws" },
        message: "stale task",
        gatewayUrl: "ws://gateway.example",
        recoveryScope: "principal-a",
        createParams: { agentId: "cloud", message: "", worktree: true },
      }),
    ).not.toBeNull();
    const newerRecovery = {
      sessionKey: "agent:cloud:newer",
      messageId: "message-newer",
      message: "newer task",
      target: { kind: "profile" as const, profileId: "aws" },
      agentId: "cloud",
      gatewayUrl: "ws://gateway.example",
      recoveryScope: "principal-a",
      phase: "dispatching" as const,
    };
    expect(writeSessionPlacementRecovery(newerRecovery)).toBe(true);

    pending.clear();

    expect(pending.sessionKey).toBe("");
    expect(
      readSessionPlacementRecovery("ws://gateway.example", "principal-a", newerRecovery.sessionKey),
    ).toEqual(newerRecovery);
  });
});

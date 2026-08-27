// Channel ingress runtime tests cover inbound message normalization and runtime contracts.
import { describe, expect, it, vi } from "vitest";
import {
  fanInChannelIngressLifecycles,
  resolveChannelMessageIngress,
  type ChannelIngressIdentityDescriptor,
  type IdentifierAuthentication,
  type ResolveChannelMessageIngressParams,
} from "./channel-ingress-runtime.js";

const identity = {
  primary: { normalize: (value) => value.trim().toLowerCase(), sensitivity: "pii" },
} satisfies ChannelIngressIdentityDescriptor;

async function resolve(input: Partial<ResolveChannelMessageIngressParams> = {}) {
  return await resolveChannelMessageIngress({
    channelId: "runtime-test",
    accountId: "default",
    identity,
    subject: { stableId: "owner" },
    conversation: { kind: "direct", id: "dm-1" },
    event: { kind: "message", authMode: "inbound", mayPair: true },
    policy: { dmPolicy: "allowlist", groupPolicy: "disabled", ...input.policy },
    allowFrom: ["owner"],
    ...input,
  });
}

describe("plugin-sdk/channel-ingress-runtime", () => {
  it("exports only the generic identifier-authentication inputs", () => {
    const strengths: IdentifierAuthentication[] = ["verified", "asserted", "unverified", "mutable"];
    const subject: NonNullable<ResolveChannelMessageIngressParams["subject"]["authentication"]> = {
      email: "verified",
      displayName: "mutable",
    };

    expect(strengths).toContain(subject.email);
  });

  it("fans one logical turn lifecycle across every durable claim", async () => {
    const createLifecycle = () => ({
      abortSignal: new AbortController().signal,
      onAdopted: vi.fn(async () => {}),
      onDeferred: vi.fn(),
      onAdoptionFinalizing: vi.fn(),
      onFailed: vi.fn(async () => {}),
      onCancelled: vi.fn(async () => {}),
      onAbandoned: vi.fn(async () => {}),
    });
    const first = createLifecycle();
    const second = createLifecycle();
    const cancellation = fanInChannelIngressLifecycles([first, second]);
    await cancellation.lifecycle?.onCancelled?.();
    const combined = fanInChannelIngressLifecycles([undefined, first, second]);

    combined.lifecycle?.onAdoptionFinalizing();
    await combined.lifecycle?.onAdopted();
    await combined.settle();

    expect(first.onAdoptionFinalizing).toHaveBeenCalledOnce();
    expect(second.onAdoptionFinalizing).toHaveBeenCalledOnce();
    expect(first.onAdopted).toHaveBeenCalledOnce();
    expect(second.onAdopted).toHaveBeenCalledOnce();
    expect(first.onAbandoned).not.toHaveBeenCalled();
    expect(second.onAbandoned).not.toHaveBeenCalled();
    expect(first.onCancelled).toHaveBeenCalledOnce();
    expect(second.onCancelled).toHaveBeenCalledOnce();
  });

  it("settles or abandons claims that no reply lane adopted", async () => {
    const adopted = vi.fn(async () => {});
    const failed = vi.fn(async () => {});
    const abandoned = vi.fn(async () => {});
    const lifecycle = {
      abortSignal: new AbortController().signal,
      onAdopted: adopted,
      onDeferred: vi.fn(),
      onAdoptionFinalizing: vi.fn(),
      onFailed: failed,
      onAbandoned: abandoned,
    };

    await fanInChannelIngressLifecycles([lifecycle]).settle();
    await fanInChannelIngressLifecycles([lifecycle]).abandon();

    expect(adopted).toHaveBeenCalledOnce();
    expect(abandoned).toHaveBeenCalledOnce();
    expect(failed).not.toHaveBeenCalled();
    expect(fanInChannelIngressLifecycles([]).lifecycle).toBeUndefined();
  });

  it("cancellation-settles every source in mixed capable and legacy fan-in", async () => {
    const adopted = vi.fn(async () => {});
    const cancelled = vi.fn(async () => {});
    const legacyAbandoned = vi.fn(async () => {});
    const createLifecycle = (
      onCancelled?: () => Promise<void>,
      onAbandoned = vi.fn(async () => {}),
    ) => ({
      abortSignal: new AbortController().signal,
      onAdopted: adopted,
      onDeferred: vi.fn(),
      onAdoptionFinalizing: vi.fn(),
      onFailed: vi.fn(async () => {}),
      onAbandoned,
      ...(onCancelled ? { onCancelled } : {}),
    });
    const combined = fanInChannelIngressLifecycles([
      createLifecycle(cancelled),
      createLifecycle(undefined, legacyAbandoned),
    ]);

    expect(combined.lifecycle).not.toHaveProperty("onCancelled");
    await combined.cancel();

    expect(adopted).not.toHaveBeenCalled();
    expect(cancelled).toHaveBeenCalledOnce();
    expect(legacyAbandoned).toHaveBeenCalledOnce();
  });

  it("preserves lifecycle receivers while fanning in cancellation", async () => {
    const createLifecycle = () => ({
      abortSignal: new AbortController().signal,
      cancellationCount: 0,
      onAdopted: vi.fn(async () => {}),
      onDeferred: vi.fn(),
      onAdoptionFinalizing: vi.fn(),
      onFailed: vi.fn(async () => {}),
      async onCancelled() {
        this.cancellationCount += 1;
      },
      onAbandoned: vi.fn(async () => {}),
    });
    const first = createLifecycle();
    const second = createLifecycle();

    await fanInChannelIngressLifecycles([first, second]).lifecycle?.onCancelled?.();

    expect(first.cancellationCount).toBe(1);
    expect(second.cancellationCount).toBe(1);
  });

  it("fans failed settlement into modern failure and legacy abandonment", async () => {
    const failed = vi.fn(async () => {});
    const abandoned = vi.fn(async () => {});
    const legacyAbandoned = vi.fn(async () => {});
    const combined = fanInChannelIngressLifecycles([
      {
        abortSignal: new AbortController().signal,
        onAdopted: async () => {
          throw new Error("adoption failed");
        },
        onDeferred: vi.fn(),
        onAdoptionFinalizing: vi.fn(),
        onFailed: failed,
        onAbandoned: abandoned,
      },
      {
        abortSignal: new AbortController().signal,
        onAdopted: vi.fn(async () => {}),
        onDeferred: vi.fn(),
        onAdoptionFinalizing: vi.fn(),
        onAbandoned: legacyAbandoned,
      },
    ]);

    await expect(combined.settle()).rejects.toThrow("adoption failed");
    const failure = new Error("dispatch failed");
    await combined.abandon(failure);

    expect(failed).toHaveBeenCalledExactlyOnceWith(failure);
    expect(abandoned).not.toHaveBeenCalled();
    expect(legacyAbandoned).toHaveBeenCalledOnce();
  });

  it("derives store allowlists, command auth, sender separation, and redaction", async () => {
    const sender = "Secret-Sender@example.test";
    const readStoreAllowFrom = vi.fn(async () => ["secret-sender@example.test"]);
    const allowed = await resolve({
      subject: { stableId: sender },
      policy: { dmPolicy: "pairing", groupPolicy: "disabled" },
      allowFrom: [],
      readStoreAllowFrom,
      command: { useAccessGroups: true, allowTextCommands: true, hasControlCommand: true },
    });
    expect(readStoreAllowFrom).toHaveBeenCalledOnce();
    expect(allowed.ingress.admission).toBe("dispatch");
    expect(allowed.ingress.decision).toBe("allow");
    expect(allowed.commandAccess.authorized).toBe(true);
    expect(JSON.stringify(allowed.state)).not.toContain(sender);
    expect(JSON.stringify(allowed.ingress)).not.toContain(sender);

    const blockedBeforeCommand = await resolve({
      route: { id: "route:disabled", enabled: false },
      command: { useAccessGroups: true, allowTextCommands: true, hasControlCommand: true },
    });
    expect(blockedBeforeCommand.ingress.reasonCode).toBe("route_blocked");
    expect(blockedBeforeCommand.commandAccess.authorized).toBe(false);

    const unauthorizedCommand = await resolve({
      conversation: { kind: "group", id: "room-1" },
      event: { kind: "message", authMode: "inbound", mayPair: false },
      policy: {
        dmPolicy: "pairing",
        groupPolicy: "open",
        groupAllowFromFallbackToAllowFrom: false,
      },
      command: {
        useAccessGroups: true,
        allowTextCommands: true,
        hasControlCommand: true,
        groupOwnerAllowFrom: "none",
        commandGroupAllowFromFallbackToAllowFrom: false,
      },
    });
    expect(unauthorizedCommand.ingress.reasonCode).toBe("control_command_unauthorized");
    expect(unauthorizedCommand.senderAccess.decision).toBe("allow");
    expect(unauthorizedCommand.senderAccess.reasonCode).toBe("group_policy_open");
    expect(unauthorizedCommand.commandAccess.shouldBlockControlCommand).toBe(true);
  });

  it("keeps normalized compatibility entries scoped to the intended identifier kind", async () => {
    const prefixedIdentity = {
      primary: {
        key: "user-id",
        normalizeEntry: (value) =>
          value
            .trim()
            .toLowerCase()
            .replace(/^users\//, "") || null,
        normalizeSubject: (value) =>
          value
            .trim()
            .toLowerCase()
            .replace(/^users\//, ""),
      },
      aliases: [
        {
          key: "email",
          kind: "plugin:test-email",
          normalizeEntry(value) {
            const normalized = value.trim().toLowerCase();
            return normalized.startsWith("users/") || !normalized.includes("@") ? null : normalized;
          },
          normalizeSubject: (value) => value.trim().toLowerCase(),
          dangerous: true,
        },
      ],
    } satisfies ChannelIngressIdentityDescriptor;

    const result = await resolveChannelMessageIngress({
      channelId: "runtime-test",
      accountId: "default",
      identity: prefixedIdentity,
      subject: { stableId: "users/123", aliases: { email: "jane@example.test" } },
      conversation: { kind: "direct", id: "dm-1" },
      event: { kind: "message", authMode: "inbound", mayPair: false },
      policy: {
        dmPolicy: "allowlist",
        groupPolicy: "disabled",
        mutableIdentifierMatching: "enabled",
      },
      allowFrom: ["users/jane@example.test"],
    });

    expect(result.senderAccess.effectiveAllowFrom).toEqual(["jane@example.test"]);
    expect(result.senderAccess.decision).toBe("block");
  });
});

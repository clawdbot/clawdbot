import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { AccessFacts } from "../channels/turn/types.js";
import {
  resolveChannelMessageIngress,
  type ChannelIngressIdentityDescriptor,
  type ResolveChannelMessageIngressParams,
} from "./channel-ingress-runtime.js";
import { projectIngressAccessFacts } from "./channel-ingress.js";

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
  it("omits projected command facts unless command policy was requested", async () => {
    const normalMessage = await resolve();

    expect(projectIngressAccessFacts(normalMessage.ingress).commands).toBeUndefined();

    const commandMessage = await resolve({
      command: { useAccessGroups: true, allowTextCommands: true, hasControlCommand: true },
    });

    const commandFacts = projectIngressAccessFacts(commandMessage.ingress).commands;
    expect(commandFacts?.authorized).toBe(true);
    expect(commandFacts?.authorizers).toEqual([]);
    expect(commandFacts?.useAccessGroups).toBe(true);
    expect(commandFacts?.allowTextCommands).toBe(true);
  });

  it("keeps command authorizers required on public AccessFacts", () => {
    expectTypeOf<NonNullable<AccessFacts["commands"]>["authorizers"]>().toEqualTypeOf<
      Array<{ configured: boolean; allowed: boolean }>
    >();
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

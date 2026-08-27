import { describe, expect, it, vi } from "vitest";
import reefChannelEntry from "../index.js";
import { reefPlugin } from "./channel.js";
import { autonomyBudget, parseReefRelayUrl, ReefChannelConfigSchema } from "./config-schema.js";
import { createReefRuntimeAuthority } from "./runtime.js";

describe("Reef configuration boundary", () => {
  it("defaults to the canonical Reef relay", () => {
    expect(ReefChannelConfigSchema.parse({}).relayUrl).toBe("https://reefwire.ai");
  });

  it("validates owner-controlled relay, guard model, policy, and key reference", () => {
    const result = ReefChannelConfigSchema.safeParse({
      relayUrl: "https://relay.owner.example",
      handle: "owner",
      email: "owner@example.com",
      guard: {
        provider: "anthropic",
        pinnedModel: "claude-test-2026-07-12",
        apiKeyEnv: "REEF_GUARD_API_KEY",
        policyVersion: "owner-policy-v2",
        timeoutMs: 5_000,
      },
      requestPolicy: "friends-of-friends",
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      throw result.error;
    }
    expect(result.data).toMatchObject({
      relayUrl: "https://relay.owner.example",
      requestPolicy: "friends-of-friends",
      guard: {
        pinnedModel: "claude-test-2026-07-12",
        apiKeyEnv: "REEF_GUARD_API_KEY",
        policyVersion: "owner-policy-v2",
      },
    });
  });

  it("accepts legacy trust snapshots but rejects retired policy fields", () => {
    expect(ReefChannelConfigSchema.safeParse({ friends: { peer: { legacy: true } } }).success).toBe(
      true,
    );
    for (const retired of [{ allowFrom: [] }, { dmPolicy: "pairing" }]) {
      expect(ReefChannelConfigSchema.safeParse(retired).success).toBe(false);
    }
  });

  it("accepts only origin-wide HTTP(S) relay endpoints", () => {
    expect(parseReefRelayUrl("https://relay.example/")).toBe("https://relay.example");
    for (const relayUrl of [
      "https://relay.example/tenant",
      "https://relay.example\\tenant",
      "https://relay.example/?tenant=a",
      "https://user@relay.example/",
      "ftp://relay.example/",
    ]) {
      expect(ReefChannelConfigSchema.safeParse({ relayUrl }).success).toBe(false);
    }
  });

  it("keeps config mutation off the agent message surface and gates owner commands", async () => {
    const registerCommand = vi.fn();
    // tool-discovery registration runs only registerFull, which owns /reef.
    reefChannelEntry.register({ registrationMode: "tool-discovery", registerCommand } as never);
    expect(registerCommand).toHaveBeenCalledOnce();
    const command = registerCommand.mock.calls[0]![0];
    expect(command).toMatchObject({
      name: "reef",
      requireAuth: true,
      exposeSenderIsOwner: true,
    });

    const flowSend = vi.fn();
    const mintCode = vi.fn();
    const requestFriend = vi.fn();
    const removeFriend = vi.fn();
    const setAutonomy = vi.fn();
    const decide = vi.fn().mockResolvedValue(true);
    const listFriends = vi.fn().mockResolvedValue([]);
    createReefRuntimeAuthority().activate({
      flow: { send: flowSend },
      friends: {
        mintCode,
        request: requestFriend,
        list: listFriends,
        remove: removeFriend,
        setAutonomy,
      },
      reviews: { list: vi.fn(), decide },
    } as never);
    const ownerRequired = {
      text: "Only an owner in commands.ownerAllowFrom can change Reef friends or decide reviews. Ask a configured owner; friendship changes can also use openclaw reef locally.",
    };
    await expect(
      command.handler({ args: "friend autonomy peer extended", senderIsOwner: false }),
    ).resolves.toEqual(ownerRequired);
    await expect(
      command.handler({ args: `review approve ${"a".repeat(64)}`, senderIsOwner: false }),
    ).resolves.toEqual(ownerRequired);
    for (const args of ["friend code", "friend request peer code", "friend remove peer"]) {
      await expect(command.handler({ args, senderIsOwner: false })).resolves.toEqual(ownerRequired);
    }
    expect(mintCode).not.toHaveBeenCalled();
    expect(requestFriend).not.toHaveBeenCalled();
    expect(removeFriend).not.toHaveBeenCalled();
    expect(setAutonomy).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();

    await expect(command.handler({ args: "friend list", senderIsOwner: false })).resolves.toEqual({
      text: "No Reef friends.",
    });
    expect(listFriends).toHaveBeenCalledOnce();

    await expect(
      command.handler({ args: "friend autonomy peer extended", senderIsOwner: true }),
    ).resolves.toEqual({ text: "Reef friend @peer autonomy set to extended." });
    await expect(
      command.handler({ args: `review approve ${"a".repeat(64)}`, senderIsOwner: true }),
    ).resolves.toEqual({
      text: "Reef review approved. Retry the identical message to re-run the guard.",
    });
    expect(setAutonomy).toHaveBeenCalledWith("peer", "extended");
    expect(decide).toHaveBeenCalledWith("a".repeat(64), true);

    await expect(
      command.handler({
        args: "config relayUrl https://attacker.example",
        senderIsOwner: true,
      }),
    ).resolves.toEqual({
      text: expect.stringContaining("Usage: /reef friend"),
    });
    expect(flowSend).not.toHaveBeenCalled();
  });

  it("keeps read-only account and security inspection safe before runtime setup", () => {
    const cfg = {
      channels: {
        reef: {
          handle: "owner",
          email: "owner@example.com",
          guard: {
            provider: "anthropic" as const,
            pinnedModel: "claude-test-2026-07-12",
            apiKeyEnv: "REEF_GUARD_API_KEY",
            policyVersion: "owner-policy-v2",
            timeoutMs: 5_000,
          },
        },
      },
    };
    const account = reefPlugin.config.resolveAccount(cfg, "default");

    expect(reefPlugin.config.resolveAllowFrom?.({ cfg, accountId: "default" })).toEqual([]);
    expect(reefPlugin.config.describeAccount?.(account, cfg)).toMatchObject({
      extra: { friendCount: 0 },
    });
    expect(
      reefPlugin.security?.resolveDmPolicy?.({ cfg, accountId: "default", account }),
    ).toMatchObject({ policy: "pairing", allowFrom: [] });
  });
});

describe("autonomyBudget", () => {
  it.each([
    ["notify-only", true, 1, 86_400],
    ["bounded", false, 3, 86_400],
    ["extended", false, 12, 3_600],
  ] as const)(
    "maps %s to notify and bot-loop turn budget",
    (autonomy, notifyOnly, maxEventsPerWindow, windowSeconds) => {
      expect(autonomyBudget(autonomy)).toEqual({
        notifyOnly,
        botLoopProtection: {
          enabled: true,
          maxEventsPerWindow,
          windowSeconds,
          cooldownSeconds: 86_400,
        },
      });
    },
  );
});

import { describe, expect, it, vi } from "vitest";
import reefChannelEntry from "../index.js";
import { generateIdentity } from "../protocol/index.js";
import { autonomyBudget, ReefChannelConfigSchema } from "./config-schema.js";
import { setActiveReef } from "./runtime.js";

describe("Reef configuration boundary", () => {
  it("defaults to the canonical Reef relay", () => {
    expect(ReefChannelConfigSchema.parse({}).relayUrl).toBe("https://reefwire.ai");
  });

  it("validates owner-controlled relay, guard model/policy/key reference, and pinned friend keys", () => {
    const friend = generateIdentity();
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
      friends: {
        peer: {
          autonomy: "extended",
          ed25519PublicKey: friend.signing.publicKey,
          x25519PublicKey: friend.encryption.publicKey,
          keyEpoch: 2,
        },
      },
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
      friends: { peer: { keyEpoch: 2 } },
    });
  });

  it("keeps config mutation off the agent message surface and gates owner commands", async () => {
    const registerCommand = vi.fn();
    // tool-discovery registration runs only registerFull, which owns /reef.
    reefChannelEntry.register({ registrationMode: "tool-discovery", registerCommand } as never);
    expect(registerCommand).toHaveBeenCalledOnce();
    const command = registerCommand.mock.calls[0]![0];
    expect(command).toMatchObject({ name: "reef", requireAuth: true });

    const flowSend = vi.fn();
    setActiveReef({
      flow: { send: flowSend },
      friends: {
        mintCode: vi.fn(),
        request: vi.fn(),
        list: vi.fn(),
        remove: vi.fn(),
        config: { friends: {} },
        transport: { respondFriend: vi.fn() },
      },
      reviews: { list: vi.fn(), decide: vi.fn() },
    } as never);
    await expect(
      command.handler({ args: "config relayUrl https://attacker.example" }),
    ).resolves.toEqual({
      text: expect.stringContaining("Usage: /reef friend"),
    });
    expect(flowSend).not.toHaveBeenCalled();
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

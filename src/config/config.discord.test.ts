import { describe, expect, it } from "vitest";
import { DiscordConfigSchema } from "./zod-schema.providers-core.js";

function expectValidDiscordConfig(config: unknown) {
  const res = DiscordConfigSchema.safeParse(config);
  expect(res.success).toBe(true);
  if (!res.success) {
    throw new Error("expected Discord config to be valid");
  }
  return res.data;
}

function expectInvalidDiscordConfig(config: unknown) {
  const res = DiscordConfigSchema.safeParse(config);
  expect(res.success).toBe(false);
  if (res.success) {
    throw new Error("expected Discord config to be invalid");
  }
  return res.error.issues;
}

describe("config discord", () => {
  it("loads discord guild map + dm group settings", () => {
    const cfg = expectValidDiscordConfig({
      enabled: true,
      dm: {
        enabled: true,
        allowFrom: ["steipete"],
        groupEnabled: true,
        groupChannels: ["openclaw-dm"],
      },
      actions: {
        emojiUploads: true,
        stickerUploads: false,
        channels: true,
      },
      guilds: {
        "123": {
          slug: "friends-of-openclaw",
          requireMention: false,
          users: ["steipete"],
          channels: {
            general: { enabled: true, autoThread: true },
          },
        },
      },
    });

    expect(cfg.enabled).toBe(true);
    expect(cfg.dm?.groupEnabled).toBe(true);
    expect(cfg.dm?.groupChannels).toEqual(["openclaw-dm"]);
    expect(cfg.actions?.emojiUploads).toBe(true);
    expect(cfg.actions?.stickerUploads).toBe(false);
    expect(cfg.actions?.channels).toBe(true);
    expect(cfg.guilds?.["123"]?.slug).toBe("friends-of-openclaw");
    expect(cfg.guilds?.["123"]?.channels?.general?.enabled).toBe(true);
    expect(cfg.guilds?.["123"]?.channels?.general?.autoThread).toBe(true);
  });

  it("coerces safe-integer numeric discord allowlist entries to strings", () => {
    const cfg = expectValidDiscordConfig({
      allowFrom: [123],
      dm: { allowFrom: [456], groupChannels: [789] },
      guilds: {
        "123": {
          users: [111],
          roles: [222],
          channels: {
            general: { users: [333], roles: [444] },
          },
        },
      },
      execApprovals: { approvers: [555] },
    });

    expect(cfg.allowFrom).toEqual(["123"]);
    expect(cfg.dm?.allowFrom).toEqual(["456"]);
    expect(cfg.dm?.groupChannels).toEqual(["789"]);
    expect(cfg.guilds?.["123"]?.users).toEqual(["111"]);
    expect(cfg.guilds?.["123"]?.roles).toEqual(["222"]);
    expect(cfg.guilds?.["123"]?.channels?.general?.users).toEqual(["333"]);
    expect(cfg.guilds?.["123"]?.channels?.general?.roles).toEqual(["444"]);
    expect(cfg.execApprovals?.approvers).toEqual(["555"]);
  });

  it("rejects numeric discord IDs that are not valid non-negative safe integers", () => {
    const cases = [106232522769186816, -1, 123.45];
    for (const id of cases) {
      const issues = expectInvalidDiscordConfig({ allowFrom: [id] });

      expect(
        issues.some((issue) => issue.message.includes("not a valid non-negative safe integer")),
      ).toBe(true);
    }
  });
});

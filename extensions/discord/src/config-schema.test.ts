import { describe, expect, it } from "vitest";
import { DiscordConfigSchema } from "../config-api.js";

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

describe("discord config schema", () => {
  it('rejects dmPolicy="open" without allowFrom "*"', () => {
    const issues = expectInvalidDiscordConfig({
      dmPolicy: "open",
      allowFrom: ["123"],
    });

    expect(issues[0]?.path.join(".")).toBe("allowFrom");
  });

  it('rejects dmPolicy="open" with empty allowFrom', () => {
    const issues = expectInvalidDiscordConfig({
      dmPolicy: "open",
      allowFrom: [],
    });

    expect(issues[0]?.path.join(".")).toBe("allowFrom");
  });

  it('rejects legacy dm.policy="open" with empty dm.allowFrom', () => {
    const issues = expectInvalidDiscordConfig({
      dm: { policy: "open", allowFrom: [] },
    });

    expect(issues[0]?.path.join(".")).toBe("dm.allowFrom");
  });

  it('accepts legacy dm.policy="open" with top-level allowFrom alias', () => {
    expectValidDiscordConfig({
      dm: { policy: "open", allowFrom: ["123"] },
      allowFrom: ["*"],
    });
  });

  it("accepts textChunkLimit without reviving legacy message limits", () => {
    const cfg = expectValidDiscordConfig({
      enabled: true,
      textChunkLimit: 1999,
      maxLinesPerMessage: 17,
    });

    expect(cfg.textChunkLimit).toBe(1999);
    expect(cfg.maxLinesPerMessage).toBe(17);
  });

  it("defaults groupPolicy to allowlist", () => {
    const cfg = expectValidDiscordConfig({});

    expect(cfg.groupPolicy).toBe("allowlist");
  });

  it("accepts historyLimit", () => {
    const cfg = expectValidDiscordConfig({ historyLimit: 3 });

    expect(cfg.historyLimit).toBe(3);
  });

  it("accepts Discord application IDs at top-level and account scope", () => {
    const cfg = expectValidDiscordConfig({
      applicationId: "123456789012345678",
      accounts: {
        work: {
          applicationId: 234567890123456,
        },
      },
    });

    expect(cfg.applicationId).toBe("123456789012345678");
    expect(cfg.accounts?.work?.applicationId).toBe("234567890123456");
  });

  it("rejects unsafe numeric Discord application IDs", () => {
    const issues = expectInvalidDiscordConfig({
      applicationId: 106232522769186816,
    });

    expect(
      issues.some((issue) => issue.message.includes("not a valid non-negative safe integer")),
    ).toBe(true);
  });

  it("loads guild map and dm group settings", () => {
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

  it("accepts voice model override field", () => {
    const cfg = expectValidDiscordConfig({
      voice: {
        model: "openai/gpt-5.4-mini",
      },
    });

    expect(cfg.voice?.model).toBe("openai/gpt-5.4-mini");
  });

  it("accepts Discord voice timing overrides", () => {
    const cfg = expectValidDiscordConfig({
      voice: {
        connectTimeoutMs: 45_000,
        reconnectGraceMs: 20_000,
        captureSilenceGraceMs: 3_500,
      },
    });

    expect(cfg.voice?.connectTimeoutMs).toBe(45_000);
    expect(cfg.voice?.reconnectGraceMs).toBe(20_000);
    expect(cfg.voice?.captureSilenceGraceMs).toBe(3_500);
  });

  it("rejects invalid Discord voice timing overrides", () => {
    for (const voice of [
      { connectTimeoutMs: 0 },
      { connectTimeoutMs: 120_001 },
      { reconnectGraceMs: -1 },
      { reconnectGraceMs: 1.5 },
      { captureSilenceGraceMs: 0 },
      { captureSilenceGraceMs: 30_001 },
    ]) {
      expectInvalidDiscordConfig({ voice });
    }
  });

  it("coerces safe-integer numeric allowlist entries to strings", () => {
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

  it("rejects numeric IDs that are not valid non-negative safe integers", () => {
    const cases = [106232522769186816, -1, 123.45];
    for (const id of cases) {
      const issues = expectInvalidDiscordConfig({ allowFrom: [id] });

      expect(
        issues.some((issue) => issue.message.includes("not a valid non-negative safe integer")),
      ).toBe(true);
    }
  });

  it.each([
    { name: "status-only presence", config: { status: "idle" } },
    {
      name: "custom activity when type is omitted",
      config: { activity: "Focus time" },
    },
    {
      name: "custom activity type",
      config: { activity: "Chilling", activityType: 4 },
    },
    {
      name: "auto presence config",
      config: {
        autoPresence: {
          enabled: true,
          intervalMs: 30000,
          minUpdateIntervalMs: 15000,
          exhaustedText: "token exhausted",
        },
      },
    },
  ] as const)("accepts $name", ({ config }) => {
    expect(DiscordConfigSchema.safeParse(config).success).toBe(true);
  });

  it.each([
    {
      name: "streaming activity without url",
      config: { activity: "Live", activityType: 1 },
    },
    {
      name: "activityUrl without streaming type",
      config: { activity: "Live", activityUrl: "https://twitch.tv/openclaw" },
    },
    {
      name: "auto presence min update interval above check interval",
      config: {
        autoPresence: {
          enabled: true,
          intervalMs: 5000,
          minUpdateIntervalMs: 6000,
        },
      },
    },
  ] as const)("rejects $name", ({ config }) => {
    expect(DiscordConfigSchema.safeParse(config).success).toBe(false);
  });

  it("accepts agentComponents.enabled at channel scope", () => {
    const res = DiscordConfigSchema.safeParse({
      agentComponents: {
        enabled: true,
      },
    });

    expect(res.success).toBe(true);
  });

  it("accepts agentComponents.enabled at account scope", () => {
    const res = DiscordConfigSchema.safeParse({
      accounts: {
        work: {
          agentComponents: {
            enabled: false,
          },
        },
      },
    });

    expect(res.success).toBe(true);
  });

  it("accepts thread.inheritParent at top-level and account scope", () => {
    const cases = [
      {
        thread: {
          inheritParent: true,
        },
      },
      {
        accounts: {
          work: {
            thread: {
              inheritParent: true,
            },
          },
        },
      },
    ] as const;

    for (const config of cases) {
      const res = DiscordConfigSchema.safeParse(config);
      expect(res.success).toBe(true);
    }
  });

  it("rejects unknown fields under agentComponents", () => {
    const res = DiscordConfigSchema.safeParse({
      agentComponents: {
        enabled: true,
        invalidField: true,
      },
    });

    expect(res.success).toBe(false);
    if (!res.success) {
      expect(
        res.error.issues.some(
          (issue) =>
            issue.path.join(".") === "agentComponents" &&
            issue.message.toLowerCase().includes("unrecognized"),
        ),
      ).toBe(true);
    }
  });
});

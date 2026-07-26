// Discord tests cover config schema plugin behavior.
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

  it('rejects dmPolicy="allowlist" without allowFrom', () => {
    const issues = expectInvalidDiscordConfig({ dmPolicy: "allowlist" });
    expect(issues.some((issue) => issue.path.includes("allowFrom"))).toBe(true);
  });

  it("accepts account allowlist policy inherited from the channel", () => {
    expectValidDiscordConfig({
      allowFrom: ["123456789"],
      accounts: { work: { dmPolicy: "allowlist" } },
    });
  });

  it("accepts progress commentary in streaming config", () => {
    expectValidDiscordConfig({
      streaming: {
        mode: "progress",
        progress: { commentary: true },
      },
    });
  });

  it("rejects retired subagent progress config", () => {
    expectInvalidDiscordConfig({ subagentProgress: true });
    expectInvalidDiscordConfig({ subagentProgress: { enabled: true } });
  });

  it("validates mention aliases at channel and account scope", () => {
    expectValidDiscordConfig({
      mentionAliases: { opslead: "123456789012345678" },
      accounts: {
        work: { mentionAliases: { vladislava: "234567890123456789" } },
      },
    });
    expectInvalidDiscordConfig({ mentionAliases: { opslead: "not-a-user-id" } });
  });

  it("rejects legacy nested DM access keys", () => {
    const issues = expectInvalidDiscordConfig({
      dm: { policy: "open", allowFrom: [] },
    });

    expect(issues[0]?.path.join(".")).toBe("dm");
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

  it("accepts suppressEmbeds at top-level and account scope", () => {
    const cfg = expectValidDiscordConfig({
      suppressEmbeds: true,
      accounts: {
        noisy: {
          suppressEmbeds: false,
        },
      },
    });

    expect(cfg.suppressEmbeds).toBe(true);
    expect(cfg.accounts?.noisy?.suppressEmbeds).toBe(false);
  });

  it("rejects unknown preview config keys", () => {
    const issues = expectInvalidDiscordConfig({
      streaming: {
        preview: {
          unknownPreviewFlag: true,
        },
      },
    });

    expect(issues[0]?.path.join(".")).toBe("streaming.preview");
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
      allowFrom: ["steipete"],
      dm: {
        enabled: true,
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

  it("accepts voice agent session target routing", () => {
    const cfg = expectValidDiscordConfig({
      voice: {
        agentSession: {
          mode: "target",
          target: "channel:123456789012345678",
        },
      },
    });

    expect(cfg.voice?.agentSession).toEqual({
      mode: "target",
      target: "channel:123456789012345678",
    });
  });

  it("accepts Discord realtime voice modes", () => {
    const cfg = expectValidDiscordConfig({
      voice: {
        mode: "agent-proxy",
        model: "openai/gpt-5.5",
        followUsersEnabled: true,
        followUsers: ["58398277829140480"],
        realtime: {
          provider: "openai",
          model: "gpt-realtime-2",
          speakerVoice: "cedar",
          speakerVoiceId: "voice-123",
          toolPolicy: "safe-read-only",
          consultPolicy: "always",
          requireWakeName: true,
          wakeNames: ["Molty"],
          bootstrapContextFiles: ["IDENTITY.md", "USER.md", "SOUL.md"],
          bargeIn: true,
          minBargeInAudioEndMs: 500,
          providers: {
            openai: {
              apiKey: "sk-test",
              voice: "marin",
            },
          },
        },
      },
    });

    expect(cfg.voice?.mode).toBe("agent-proxy");
    expect(cfg.voice?.model).toBe("openai/gpt-5.5");
    expect(cfg.voice?.followUsersEnabled).toBe(true);
    expect(cfg.voice?.followUsers).toEqual(["58398277829140480"]);
    expect(cfg.voice?.realtime?.provider).toBe("openai");
    expect(cfg.voice?.realtime?.model).toBe("gpt-realtime-2");
    expect(cfg.voice?.realtime?.speakerVoice).toBe("cedar");
    expect(cfg.voice?.realtime?.speakerVoiceId).toBe("voice-123");
    expect(cfg.voice?.realtime?.toolPolicy).toBe("safe-read-only");
    expect(cfg.voice?.realtime?.consultPolicy).toBe("always");
    expect(cfg.voice?.realtime?.requireWakeName).toBe(true);
    expect(cfg.voice?.realtime?.wakeNames).toEqual(["Molty"]);
    expect(cfg.voice?.realtime?.bootstrapContextFiles).toEqual([
      "IDENTITY.md",
      "USER.md",
      "SOUL.md",
    ]);
    expect(cfg.voice?.realtime?.bargeIn).toBe(true);
    expect(cfg.voice?.realtime?.minBargeInAudioEndMs).toBe(500);
  });

  it("rejects invalid Discord realtime voice modes", () => {
    for (const voice of [
      { mode: "realtime" },
      { mode: "talk-buffer" },
      { mode: "bidi", realtime: { toolPolicy: "dangerous" } },
      { mode: "agent-proxy", realtime: { consultPolicy: "substantive" } },
      { mode: "bidi", realtime: { bootstrapContextFiles: ["AGENTS.md"] } },
      { mode: "agent-proxy", realtime: { wakeNames: [] } },
      { mode: "agent-proxy", realtime: { wakeNames: [""] } },
      { mode: "agent-proxy", realtime: { wakeNames: ["Claw Bot Helper"] } },
      { mode: "agent-proxy", realtime: { debounceMs: 10_001 } },
      { mode: "agent-proxy", realtime: { minBargeInAudioEndMs: -1 } },
      { mode: "agent-proxy", realtime: { minBargeInAudioEndMs: 10_001 } },
      { agentSession: { mode: "target" } },
      { followUsers: [""] },
    ]) {
      expectInvalidDiscordConfig({ voice });
    }
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

  it("accepts Discord voice allowed channels", () => {
    const cfg = expectValidDiscordConfig({
      voice: {
        allowedChannels: [{ guildId: "123", channelId: "456" }],
      },
    });

    expect(cfg.voice?.allowedChannels).toEqual([{ guildId: "123", channelId: "456" }]);
  });

  it("rejects invalid Discord voice allowed channels", () => {
    for (const voice of [
      { allowedChannels: [{ guildId: "", channelId: "456" }] },
      { allowedChannels: [{ guildId: "123", channelId: "" }] },
    ]) {
      expectInvalidDiscordConfig({ voice });
    }
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
      dm: { groupChannels: [789] },
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
    expect(cfg.dm?.groupChannels).toEqual(["789"]);
    expect(cfg.guilds?.["123"]?.users).toEqual(["111"]);
    expect(cfg.guilds?.["123"]?.roles).toEqual(["222"]);
    expect(cfg.guilds?.["123"]?.channels?.general?.users).toEqual(["333"]);
    expect(cfg.guilds?.["123"]?.channels?.general?.roles).toEqual(["444"]);
    expect(cfg.execApprovals?.approvers).toEqual(["555"]);
  });

  it.each([true, false, "auto"] as const)("accepts execApprovals.enabled=%s", (enabled) => {
    const cfg = expectValidDiscordConfig({ execApprovals: { enabled } });
    expect(cfg.execApprovals?.enabled).toBe(enabled);
  });

  it("rejects execApprovals.enabled with other string values", () => {
    expectInvalidDiscordConfig({ execApprovals: { enabled: "on" } });
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
        },
      },
    },
  ] as const)("accepts $name", ({ config }) => {
    expect(DiscordConfigSchema.safeParse(config).success).toBe(true);
  });

  it("accepts guild online-presence event routing", () => {
    const cfg = expectValidDiscordConfig({
      intents: { presence: true },
      guilds: {
        "123456789012345678": {
          presenceEvents: {
            channelId: "234567890123456789",
            users: ["345678901234567890"],
          },
        },
      },
    });

    expect(cfg.guilds?.["123456789012345678"]?.presenceEvents?.channelId).toBe(
      "234567890123456789",
    );
  });

  it("accepts online-presence throttling knobs", () => {
    const cfg = expectValidDiscordConfig({
      intents: { presence: true },
      guilds: {
        "123456789012345678": {
          presenceEvents: {
            channelId: "234567890123456789",
            reconnectSuppressSeconds: 0,
            burstLimit: 4,
            burstWindowSeconds: 30,
          },
        },
      },
    });

    expect(cfg.guilds?.["123456789012345678"]?.presenceEvents?.burstLimit).toBe(4);
  });

  it("rejects invalid online-presence throttling values", () => {
    const issues = expectInvalidDiscordConfig({
      guilds: {
        "123456789012345678": {
          presenceEvents: {
            channelId: "234567890123456789",
            reconnectSuppressSeconds: -1,
            burstLimit: 0,
            burstWindowSeconds: 0,
          },
        },
      },
    });

    for (const field of ["reconnectSuppressSeconds", "burstLimit", "burstWindowSeconds"]) {
      expect(issues.some((issue) => issue.path.join(".").endsWith(field))).toBe(true);
    }
  });

  it("rejects mutable names in online-presence event routing", () => {
    const issues = expectInvalidDiscordConfig({
      guilds: {
        maintainers: {
          presenceEvents: {
            channelId: "maintainers",
            users: ["alice"],
          },
        },
      },
    });

    expect(issues.some((issue) => issue.path.join(".").includes("presenceEvents"))).toBe(true);
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

  it("accepts agentComponents.ttlMs at channel and account scope", () => {
    const res = DiscordConfigSchema.safeParse({
      agentComponents: {
        ttlMs: 86_400_000,
      },
      accounts: {
        work: {
          agentComponents: {
            ttlMs: 120_000,
          },
        },
      },
    });

    expect(res.success).toBe(true);
  });

  it("rejects invalid agentComponents.ttlMs values", () => {
    for (const ttlMs of [0, -1, 1.5, 86_400_001]) {
      const res = DiscordConfigSchema.safeParse({
        agentComponents: {
          ttlMs,
        },
      });

      expect(res.success).toBe(false);
    }
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

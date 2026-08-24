// Qa Lab Matrix tests cover config behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { buildMatrixQaConfig } from "./config.js";
import type { MatrixQaProvisionedTopology } from "./topology.js";

function castRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

describe("matrix qa config", () => {
  const topology: MatrixQaProvisionedTopology = {
    defaultRoomId: "!main:matrix-qa.test",
    defaultRoomKey: "main",
    rooms: [
      {
        key: "main",
        kind: "group" as const,
        memberRoles: ["driver", "observer", "sut"],
        memberUserIds: [
          "@driver:matrix-qa.test",
          "@observer:matrix-qa.test",
          "@sut:matrix-qa.test",
        ],
        name: "Main",
        requireMention: true,
        roomId: "!main:matrix-qa.test",
      },
      {
        key: "secondary",
        kind: "group" as const,
        memberRoles: ["driver", "observer", "sut"],
        memberUserIds: [
          "@driver:matrix-qa.test",
          "@observer:matrix-qa.test",
          "@sut:matrix-qa.test",
        ],
        name: "Secondary",
        requireMention: true,
        roomId: "!secondary:matrix-qa.test",
      },
      {
        key: "driver-dm",
        kind: "dm" as const,
        memberRoles: ["driver", "sut"],
        memberUserIds: ["@driver:matrix-qa.test", "@sut:matrix-qa.test"],
        name: "DM",
        requireMention: false,
        roomId: "!dm:matrix-qa.test",
      },
    ],
  };

  it("builds default Matrix QA config from provisioned topology", () => {
    const next = buildMatrixQaConfig({} as OpenClawConfig, {
      driverUserId: "@driver:matrix-qa.test",
      homeserver: "http://127.0.0.1:28008/",
      observerUserId: "@observer:matrix-qa.test",
      sutAccessToken: "sut-token",
      sutAccountId: "sut",
      sutUserId: "@sut:matrix-qa.test",
      topology,
    });

    const sut = next.channels?.matrix?.accounts?.sut;
    expect(sut?.dm?.allowFrom).toEqual(["@driver:matrix-qa.test"]);
    expect(sut?.dm?.enabled).toBe(true);
    expect(sut?.dm?.policy).toBe("allowlist");
    expect(sut?.groupAllowFrom).toEqual(["@driver:matrix-qa.test"]);
    expect(sut?.groupPolicy).toBe("allowlist");
    expect(sut?.groups?.["!main:matrix-qa.test"]).toEqual({
      enabled: true,
      requireMention: true,
    });
    expect(sut?.groups?.["!secondary:matrix-qa.test"]).toEqual({
      enabled: true,
      requireMention: true,
    });
    expect(sut?.replyToMode).toBe("off");
    expect(sut?.streaming).toEqual({
      block: { enabled: false },
      chunkMode: "length",
      mode: "off",
      preview: { toolProgress: true },
    });
    expect(sut?.textChunkLimit).toBe(4000);
    expect(sut?.threadReplies).toBe("inbound");
    expect(next.messages?.groupChat?.visibleReplies).toBe("automatic");
  });

  it("preserves the scenario provider plugin without enabling unrelated plugins", () => {
    const next = buildMatrixQaConfig(
      {
        plugins: {
          allow: ["acpx", "memory-core", "qa-lab", "openai"],
          entries: {
            matrix: {
              config: { preserve: "matrix-config" },
              enabled: false,
              hooks: { allowConversationAccess: true, timeoutMs: 1_500 },
              llm: {
                allowModelOverride: true,
                allowedModels: ["openai/gpt-5.4"],
              },
              subagent: {
                allowModelOverride: true,
                allowedModels: ["anthropic/claude-sonnet-4-6"],
              },
            },
            openai: { enabled: true },
            unrelated: { enabled: true },
          },
        },
      } as OpenClawConfig,
      {
        driverUserId: "@driver:matrix-qa.test",
        homeserver: "http://127.0.0.1:28008/",
        observerUserId: "@observer:matrix-qa.test",
        sutAccessToken: "sut-token",
        sutAccountId: "sut",
        sutUserId: "@sut:matrix-qa.test",
        topology,
      },
    );

    expect(next.plugins?.allow).toEqual(["acpx", "memory-core", "qa-lab", "openai", "matrix"]);
    expect(next.plugins?.allow).not.toContain("unrelated");
    expect(next.plugins?.allow).not.toContain("anthropic");
    expect(next.plugins?.entries?.matrix).toEqual({
      config: { preserve: "matrix-config" },
      enabled: true,
      hooks: { allowConversationAccess: true, timeoutMs: 1_500 },
      llm: {
        allowModelOverride: true,
        allowedModels: ["openai/gpt-5.4"],
      },
      subagent: {
        allowModelOverride: true,
        allowedModels: ["anthropic/claude-sonnet-4-6"],
      },
    });
    expect(next.plugins?.entries?.openai).toEqual({ enabled: true });
  });

  it("honors an explicit DM disable with a provisioned DM room", () => {
    const next = buildMatrixQaConfig({} as OpenClawConfig, {
      driverUserId: "@driver:matrix-qa.test",
      homeserver: "http://127.0.0.1:28008/",
      observerUserId: "@observer:matrix-qa.test",
      overrides: { dm: { enabled: false } },
      sutAccessToken: "sut-token",
      sutAccountId: "sut",
      sutUserId: "@sut:matrix-qa.test",
      topology,
    });

    expect(next.channels?.matrix?.accounts?.sut?.dm).toEqual({ enabled: false });
  });

  it("applies room-keyed Matrix QA config overrides", () => {
    const next = buildMatrixQaConfig({} as OpenClawConfig, {
      driverUserId: "@driver:matrix-qa.test",
      homeserver: "http://127.0.0.1:28008/",
      observerUserId: "@observer:matrix-qa.test",
      overrides: {
        autoJoin: "allowlist",
        autoJoinAllowlist: [" !dm:matrix-qa.test ", "#ops:matrix-qa.test"],
        agentDefaults: {
          blockStreamingChunk: {
            breakPreference: "newline",
            maxChars: 48,
            minChars: 1,
          },
          blockStreamingCoalesce: {
            idleMs: 0,
            maxChars: 48,
            minChars: 1,
          },
        },
        blockStreaming: true,
        dm: {
          sessionScope: "per-room",
          threadReplies: "off",
        },
        encryption: true,
        allowBots: "mentions",
        configuredBotRoles: ["observer"],
        groupAllowFrom: ["@driver:matrix-qa.test", "@observer:matrix-qa.test"],
        groupMentionPatterns: ["\\S"],
        groupsByKey: {
          secondary: {
            allowBots: false,
            requireMention: false,
            tools: {
              allow: ["sessions_spawn"],
            },
          },
        },
        replyToMode: "all",
        streaming: "quiet",
        threadBindings: {
          enabled: true,
          idleHours: 1,
          spawnSessions: true,
        },
        threadReplies: "always",
        audio: {
          echoTranscript: false,
          enabled: true,
        },
        toolProfile: "coding",
      },
      observerAccessToken: "observer-token",
      sutAccessToken: "sut-token",
      sutAccountId: "sut",
      sutUserId: "@sut:matrix-qa.test",
      topology,
    });

    expect(next.agents?.defaults?.blockStreamingChunk).toEqual({
      breakPreference: "newline",
      maxChars: 48,
      minChars: 1,
    });
    expect(next.agents?.defaults?.blockStreamingCoalesce).toEqual({
      idleMs: 0,
      maxChars: 48,
      minChars: 1,
    });
    expect(next.tools?.profile).toBe("coding");
    expect(next.tools?.media?.audio).toEqual({
      echoTranscript: false,
      enabled: true,
    });
    expect(next.messages?.groupChat?.mentionPatterns).toEqual(["\\S"]);
    const observer = next.channels?.matrix?.accounts?.["qa-observer-bot-source"];
    expect(observer?.accessToken).toBe("observer-token");
    expect(observer?.enabled).toBe(false);
    expect(observer?.homeserver).toBe("http://127.0.0.1:28008/");
    expect(observer?.userId).toBe("@observer:matrix-qa.test");
    const sut = next.channels?.matrix?.accounts?.sut;
    expect(sut?.allowBots).toBe("mentions");
    expect(sut?.autoJoin).toBe("allowlist");
    expect(sut?.autoJoinAllowlist).toEqual(["!dm:matrix-qa.test", "#ops:matrix-qa.test"]);
    expect((sut?.streaming as { block?: { enabled?: boolean } })?.block?.enabled).toBe(true);
    expect(sut?.dm?.sessionScope).toBe("per-room");
    expect(sut?.dm?.threadReplies).toBe("off");
    expect(sut?.encryption).toBe(true);
    expect(sut?.groupAllowFrom).toEqual(["@driver:matrix-qa.test", "@observer:matrix-qa.test"]);
    expect(sut?.groups?.["!main:matrix-qa.test"]).toEqual({
      enabled: true,
      requireMention: true,
    });
    expect(sut?.groups?.["!secondary:matrix-qa.test"]).toEqual({
      allowBots: false,
      enabled: true,
      requireMention: false,
      tools: {
        allow: ["sessions_spawn"],
      },
    });
    expect(sut?.replyToMode).toBe("all");
    expect((sut?.streaming as { mode?: string })?.mode).toBe("quiet");
    expect(sut?.threadBindings).toEqual({
      enabled: true,
      idleHours: 1,
      spawnSessions: true,
    });
    expect(sut?.threadReplies).toBe("always");
  });

  it("rewrites the owned Matrix QA account instead of retaining stale override fields", () => {
    const overridden = buildMatrixQaConfig({} as OpenClawConfig, {
      driverUserId: "@driver:matrix-qa.test",
      homeserver: "http://127.0.0.1:28008/",
      observerUserId: "@observer:matrix-qa.test",
      overrides: {
        autoJoin: "allowlist",
        autoJoinAllowlist: ["!ops:matrix-qa.test"],
        blockStreaming: true,
        streaming: "quiet",
      },
      sutAccessToken: "sut-token",
      sutAccountId: "sut",
      sutUserId: "@sut:matrix-qa.test",
      topology,
    });

    const reset = buildMatrixQaConfig({} as OpenClawConfig, {
      currentConfig: overridden,
      driverUserId: "@driver:matrix-qa.test",
      homeserver: "http://127.0.0.1:28008/",
      observerUserId: "@observer:matrix-qa.test",
      sutAccessToken: "sut-token",
      sutAccountId: "sut",
      sutUserId: "@sut:matrix-qa.test",
      topology,
    });

    expect(reset.channels?.matrix?.accounts?.sut?.autoJoin).toBeUndefined();
    expect(reset.channels?.matrix?.accounts?.sut?.autoJoinAllowlist).toBeUndefined();
    expect(reset.channels?.matrix?.accounts?.sut?.streaming).toEqual({
      block: { enabled: false },
      chunkMode: "length",
      mode: "off",
      preview: { toolProgress: true },
    });
  });

  it("restores owned baseline leaves while preserving current Matrix lifecycle and siblings", () => {
    const baseline = {
      approvals: { exec: { enabled: false, mode: "session" } },
      agents: {
        defaults: {
          blockStreamingChunk: { maxChars: 120 },
          adjacentDefault: "baseline",
        },
      },
      tools: {
        profile: "messaging",
        media: {
          models: [{ provider: "openai", model: "baseline", capabilities: ["audio"] }],
          audio: {
            enabled: false,
            prompt: "baseline prompt",
            scope: {
              default: "allow",
              rules: [{ action: "allow", match: { chatType: "direct" } }],
            },
          },
        },
      },
      messages: {
        groupChat: {
          mentionPatterns: ["baseline"],
        },
      },
      channels: {
        matrix: {
          unknownRoot: "baseline",
          accounts: {
            sut: {
              allowBots: false,
              autoJoin: "allowlist",
              autoJoinAllowlist: ["!baseline:matrix-qa.test"],
              deviceId: "BASELINE-DEVICE",
              dm: {
                allowFrom: ["@baseline:matrix-qa.test"],
                enabled: true,
                policy: "open",
                sessionScope: "per-room",
                threadReplies: "always",
              },
              execApprovals: {
                agentFilter: ["baseline-agent"],
                approvers: ["@baseline:matrix-qa.test"],
                enabled: false,
                sessionFilter: ["baseline-session"],
                target: "dm",
              },
              groups: {
                "!main:matrix-qa.test": {
                  allowBots: false,
                  enabled: false,
                  requireMention: false,
                  tools: {
                    allow: ["baseline-allow"],
                    deny: ["baseline-deny"],
                  },
                },
              },
              streaming: {
                block: { enabled: true },
                chunkMode: "newline",
                mode: "quiet",
                preview: { toolProgress: false },
              },
              threadBindings: {
                enabled: false,
                idleHours: 12,
              },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;
    const current = structuredClone(baseline) as OpenClawConfig & Record<string, unknown>;
    const currentRoot = castRecord(current);
    currentRoot.unrelated = { currentOnly: true };
    castRecord(currentRoot.approvals).exec = {
      enabled: true,
      mode: "session",
      reviewer: "current",
    };
    castRecord(currentRoot.agents).defaults = {
      blockStreamingChunk: { maxChars: 8 },
      adjacentDefault: "current",
    };
    const currentTools = castRecord(currentRoot.tools);
    const currentMedia = castRecord(currentTools.media);
    currentTools.profile = "coding";
    currentMedia.models = [{ provider: "openai", model: "previous" }];
    currentMedia.audio = {
      enabled: true,
      prompt: "previous prompt",
      adjacentAudio: "current",
      scope: {
        default: "deny",
        rules: [{ action: "deny", match: { chatType: "group" } }],
      },
    };
    castRecord(currentRoot.messages).groupChat = {
      mentionPatterns: ["previous"],
      adjacentMessage: "current",
    };
    const currentMatrix = castRecord(castRecord(currentRoot.channels).matrix);
    currentMatrix.unknownRoot = "current";
    const currentAccounts = castRecord(currentMatrix.accounts);
    currentAccounts.sibling = { enabled: false, homeserver: "https://sibling.invalid" };
    currentAccounts["qa-driver-bot-source"] = { enabled: false, userId: "@stale:test" };
    const currentSut = castRecord(currentAccounts.sut);
    currentAccounts.sut = {
      ...currentSut,
      allowBots: "mentions",
      autoJoinAllowlist: ["!previous:matrix-qa.test"],
      deviceId: "CURRENT-DEVICE",
      lifecycleState: "current",
      dm: {
        ...castRecord(currentSut.dm),
        allowFrom: ["@previous:test"],
        adjacentDm: "current",
        sessionScope: "per-user",
      },
      execApprovals: {
        agentFilter: ["previous-agent"],
        adjacentApproval: "current",
        approvers: ["@previous:test"],
        enabled: true,
        sessionFilter: ["previous-session"],
        target: "both",
      },
      groups: {
        ...castRecord(currentSut.groups),
        "!main:matrix-qa.test": {
          allowBots: "mentions",
          adjacentGroup: "current",
          enabled: true,
          requireMention: true,
          tools: {
            adjacentTool: "current",
            allow: ["previous-allow"],
            deny: ["previous-deny"],
          },
        },
        "!current-only:matrix-qa.test": {
          adjacentGroup: "preserved",
          enabled: false,
        },
      },
      streaming: {
        adjacentStreaming: "current",
        block: { adjacentBlock: "current", enabled: true },
        chunkMode: "newline",
        mode: "quiet",
        preview: { adjacentPreview: "current", toolProgress: false },
      },
      threadBindings: {
        adjacentBinding: "current",
        enabled: true,
        idleHours: 1,
      },
    };

    const next = buildMatrixQaConfig(baseline, {
      currentConfig: current,
      driverUserId: "@driver:matrix-qa.test",
      homeserver: "http://127.0.0.1:28008/",
      observerUserId: "@observer:matrix-qa.test",
      sutAccessToken: "sut-token",
      sutAccountId: "sut",
      sutUserId: "@sut:matrix-qa.test",
      topology,
    });

    expect(castRecord(next).unrelated).toEqual({ currentOnly: true });
    expect(next.approvals?.exec).toEqual({
      enabled: false,
      mode: "session",
      reviewer: "current",
    });
    expect(next.agents?.defaults).toMatchObject({
      adjacentDefault: "current",
      blockStreamingChunk: { maxChars: 120 },
    });
    expect(next.tools?.profile).toBe("messaging");
    expect(next.tools?.media).toMatchObject({
      models: [{ provider: "openai", model: "baseline", capabilities: ["audio"] }],
      audio: {
        adjacentAudio: "current",
        enabled: false,
        prompt: "baseline prompt",
        scope: {
          default: "allow",
          rules: [{ action: "allow", match: { chatType: "direct" } }],
        },
      },
    });
    expect(next.messages?.groupChat).toMatchObject({
      adjacentMessage: "current",
      mentionPatterns: ["baseline"],
      visibleReplies: "automatic",
    });
    expect(next.channels?.matrix).toMatchObject({ unknownRoot: "current" });
    expect(next.channels?.matrix?.accounts?.sibling).toEqual(currentAccounts.sibling);
    expect(next.channels?.matrix?.accounts?.["qa-driver-bot-source"]).toBeUndefined();
    const sut = castRecord(next.channels?.matrix?.accounts?.sut);
    expect(sut).toMatchObject({
      allowBots: false,
      autoJoin: "allowlist",
      autoJoinAllowlist: ["!baseline:matrix-qa.test"],
      deviceId: "CURRENT-DEVICE",
      lifecycleState: "current",
      textChunkLimit: 4000,
      dm: {
        adjacentDm: "current",
        allowFrom: ["@driver:matrix-qa.test"],
        sessionScope: "per-room",
        threadReplies: "always",
      },
      execApprovals: {
        adjacentApproval: "current",
        agentFilter: ["baseline-agent"],
        approvers: ["@baseline:matrix-qa.test"],
        enabled: false,
        sessionFilter: ["baseline-session"],
        target: "dm",
      },
      streaming: {
        adjacentStreaming: "current",
        block: { adjacentBlock: "current", enabled: false },
        chunkMode: "length",
        mode: "off",
        preview: { adjacentPreview: "current", toolProgress: true },
      },
      threadBindings: {
        adjacentBinding: "current",
        enabled: false,
        idleHours: 12,
      },
    });
    const sutGroups = castRecord(sut.groups);
    expect(sutGroups["!main:matrix-qa.test"]).toEqual({
      adjacentGroup: "current",
      allowBots: false,
      enabled: true,
      requireMention: true,
      tools: {
        adjacentTool: "current",
        allow: ["baseline-allow"],
        deny: ["baseline-deny"],
      },
    });
    expect(sutGroups["!current-only:matrix-qa.test"]).toEqual({
      adjacentGroup: "preserved",
      enabled: false,
    });

    const provisioned = buildMatrixQaConfig(baseline, {
      currentConfig: current,
      driverUserId: "@driver:matrix-qa.test",
      homeserver: "http://127.0.0.1:28008/",
      observerUserId: "@observer:matrix-qa.test",
      sutAccessToken: "sut-token",
      sutAccountId: "sut",
      sutDeviceId: "PROVISIONED-DEVICE",
      sutUserId: "@sut:matrix-qa.test",
      topology,
    });
    expect(provisioned.channels?.matrix?.accounts?.sut).toMatchObject({
      deviceId: "PROVISIONED-DEVICE",
      lifecycleState: "current",
    });
  });

  it("normalizes Matrix QA overrides into the written account config", () => {
    const config = buildMatrixQaConfig({} as OpenClawConfig, {
      driverUserId: "@driver:matrix-qa.test",
      homeserver: "http://127.0.0.1:28008/",
      observerUserId: "@observer:matrix-qa.test",
      overrides: {
        autoJoin: "allowlist",
        autoJoinAllowlist: ["!ops:matrix-qa.test"],
        blockStreaming: true,
        dm: {
          sessionScope: "per-room",
        },
        groupMentionPatterns: ["\\S"],
        groupPolicy: "open",
        streaming: true,
      },
      sutAccessToken: "sut-token",
      sutAccountId: "sut",
      sutUserId: "@sut:matrix-qa.test",
      topology,
    });
    const account = config.channels?.matrix?.accounts?.sut;
    expect(account?.autoJoin).toBe("allowlist");
    expect(account?.autoJoinAllowlist).toEqual(["!ops:matrix-qa.test"]);
    expect(account?.dm?.sessionScope).toBe("per-room");
    expect(account?.groupPolicy).toBe("open");
    expect(account?.streaming).toEqual({
      block: { enabled: true },
      chunkMode: "length",
      mode: "partial",
      preview: { toolProgress: true },
    });
    expect(config.messages?.groupChat?.mentionPatterns).toEqual(["\\S"]);
  });

  it("resets progress and preview overrides when a scalar follows an object", () => {
    const optedOut = buildMatrixQaConfig({} as OpenClawConfig, {
      driverUserId: "@driver:matrix-qa.test",
      homeserver: "http://127.0.0.1:28008/",
      observerUserId: "@observer:matrix-qa.test",
      overrides: {
        streaming: {
          mode: "quiet",
          progress: { commandText: "raw" },
          preview: { toolProgress: false },
        },
      },
      sutAccessToken: "sut-token",
      sutAccountId: "sut",
      sutUserId: "@sut:matrix-qa.test",
      topology,
    });
    const reset = buildMatrixQaConfig({} as OpenClawConfig, {
      currentConfig: optedOut,
      driverUserId: "@driver:matrix-qa.test",
      homeserver: "http://127.0.0.1:28008/",
      observerUserId: "@observer:matrix-qa.test",
      overrides: { streaming: "quiet" },
      sutAccessToken: "sut-token",
      sutAccountId: "sut",
      sutUserId: "@sut:matrix-qa.test",
      topology,
    });

    expect(optedOut.channels?.matrix?.accounts?.sut?.streaming).toEqual({
      block: { enabled: false },
      chunkMode: "length",
      mode: "quiet",
      progress: { commandText: "raw" },
      preview: { toolProgress: false },
    });
    expect(reset.channels?.matrix?.accounts?.sut?.streaming).toEqual({
      block: { enabled: false },
      chunkMode: "length",
      mode: "quiet",
      preview: { toolProgress: true },
    });
  });

  it("applies Matrix approval delivery overrides with gateway forwarding enabled", () => {
    const next = buildMatrixQaConfig({} as OpenClawConfig, {
      driverUserId: "@driver:matrix-qa.test",
      homeserver: "http://127.0.0.1:28008/",
      observerUserId: "@observer:matrix-qa.test",
      overrides: {
        approvalForwarding: {
          exec: true,
          plugin: true,
        },
        chunkMode: "length",
        dm: {
          enabled: true,
        },
        execApprovals: {
          enabled: true,
          target: "both",
        },
        textChunkLimit: 280,
      },
      sutAccessToken: "sut-token",
      sutAccountId: "sut",
      sutUserId: "@sut:matrix-qa.test",
      topology,
    });

    expect(next.approvals?.exec).toEqual({ enabled: true, mode: "session" });
    expect(next.approvals?.plugin).toEqual({ enabled: true, mode: "session" });
    const sut = next.channels?.matrix?.accounts?.sut;
    expect((sut?.streaming as { chunkMode?: string })?.chunkMode).toBe("length");
    expect(sut?.dm?.allowFrom).toEqual(["@driver:matrix-qa.test"]);
    expect(sut?.dm?.enabled).toBe(true);
    expect(sut?.execApprovals).toEqual({
      enabled: true,
      target: "both",
    });
    expect(sut?.textChunkLimit).toBe(280);
  });

  it("resolves role-based Matrix sender allowlist overrides", () => {
    const config = buildMatrixQaConfig({} as OpenClawConfig, {
      driverUserId: "@driver:matrix-qa.test",
      homeserver: "http://127.0.0.1:28008/",
      observerUserId: "@observer:matrix-qa.test",
      overrides: {
        groupAllowRoles: ["driver", "observer"],
      },
      sutAccessToken: "sut-token",
      sutAccountId: "sut",
      sutUserId: "@sut:matrix-qa.test",
      topology,
    });

    expect(config.channels?.matrix?.accounts?.sut?.groupAllowFrom).toEqual([
      "@driver:matrix-qa.test",
      "@observer:matrix-qa.test",
    ]);
  });

  it("rejects configured bot roles without matching side-account auth", () => {
    expect(() =>
      buildMatrixQaConfig({} as OpenClawConfig, {
        driverUserId: "@driver:matrix-qa.test",
        homeserver: "http://127.0.0.1:28008/",
        observerUserId: "@observer:matrix-qa.test",
        overrides: {
          configuredBotRoles: ["observer"],
        },
        sutAccessToken: "sut-token",
        sutAccountId: "sut",
        sutUserId: "@sut:matrix-qa.test",
        topology,
      }),
    ).toThrow('Matrix QA configured bot role "observer" requires an access token');
  });

  it("removes QA bot-source accounts when configured roles are reset", () => {
    const withObserver = buildMatrixQaConfig({} as OpenClawConfig, {
      driverUserId: "@driver:matrix-qa.test",
      homeserver: "http://127.0.0.1:28008/",
      observerAccessToken: "observer-token",
      observerUserId: "@observer:matrix-qa.test",
      overrides: { configuredBotRoles: ["observer"] },
      sutAccessToken: "sut-token",
      sutAccountId: "sut",
      sutUserId: "@sut:matrix-qa.test",
      topology,
    });
    const reset = buildMatrixQaConfig({} as OpenClawConfig, {
      currentConfig: withObserver,
      driverUserId: "@driver:matrix-qa.test",
      homeserver: "http://127.0.0.1:28008/",
      observerUserId: "@observer:matrix-qa.test",
      sutAccessToken: "sut-token",
      sutAccountId: "sut",
      sutUserId: "@sut:matrix-qa.test",
      topology,
    });

    expect(reset.channels?.matrix?.accounts?.["qa-observer-bot-source"]).toBeUndefined();
  });

  it("rejects the SUT role as a configured bot source", () => {
    expect(() =>
      buildMatrixQaConfig({} as OpenClawConfig, {
        driverUserId: "@driver:matrix-qa.test",
        homeserver: "http://127.0.0.1:28008/",
        observerUserId: "@observer:matrix-qa.test",
        overrides: {
          configuredBotRoles: ["sut"],
        },
        sutAccessToken: "sut-token",
        sutAccountId: "sut",
        sutUserId: "@sut:matrix-qa.test",
        topology,
      }),
    ).toThrow('Matrix QA configured bot role "sut" would match the SUT account itself');
  });

  it("rejects unknown room-key overrides", () => {
    expect(() =>
      buildMatrixQaConfig({} as OpenClawConfig, {
        driverUserId: "@driver:matrix-qa.test",
        homeserver: "http://127.0.0.1:28008/",
        observerUserId: "@observer:matrix-qa.test",
        overrides: {
          groupsByKey: {
            ghost: {
              requireMention: false,
            },
          },
        },
        sutAccessToken: "sut-token",
        sutAccountId: "sut",
        sutUserId: "@sut:matrix-qa.test",
        topology,
      }),
    ).toThrow('Matrix QA group override references unknown room key "ghost"');
  });
});

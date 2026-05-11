import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import {
  buildMatrixQaConfig,
  buildMatrixQaConfigSnapshot,
  summarizeMatrixQaConfigSnapshot,
} from "./config.js";
import type { MatrixQaProvisionedTopology } from "./topology.js";

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
    expect(sut?.threadReplies).toBe("inbound");
    expect(next.messages?.groupChat?.visibleReplies).toBe("automatic");
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
    const observer = next.channels?.matrix?.accounts?.["qa-observer-bot-source"];
    expect(observer?.accessToken).toBe("observer-token");
    expect(observer?.enabled).toBe(false);
    expect(observer?.homeserver).toBe("http://127.0.0.1:28008/");
    expect(observer?.userId).toBe("@observer:matrix-qa.test");
    const sut = next.channels?.matrix?.accounts?.sut;
    expect(sut?.allowBots).toBe("mentions");
    expect(sut?.autoJoin).toBe("allowlist");
    expect(sut?.autoJoinAllowlist).toEqual(["!dm:matrix-qa.test", "#ops:matrix-qa.test"]);
    expect(sut?.blockStreaming).toBe(true);
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
    expect(sut?.streaming).toBe("quiet");
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

    const reset = buildMatrixQaConfig(overridden, {
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
    expect(reset.channels?.matrix?.accounts?.sut?.blockStreaming).toBeUndefined();
    expect(reset.channels?.matrix?.accounts?.sut?.streaming).toBeUndefined();
  });

  it("builds an effective Matrix QA config snapshot for reporting", () => {
    const snapshot = buildMatrixQaConfigSnapshot({
      driverUserId: "@driver:matrix-qa.test",
      observerUserId: "@observer:matrix-qa.test",
      overrides: {
        autoJoin: "allowlist",
        autoJoinAllowlist: ["!ops:matrix-qa.test"],
        blockStreaming: true,
        dm: {
          sessionScope: "per-room",
        },
        groupPolicy: "open",
        streaming: true,
      },
      sutUserId: "@sut:matrix-qa.test",
      topology,
    });

    expect(snapshot).toEqual({
      approvalForwarding: {
        exec: false,
        plugin: false,
      },
      allowBots: undefined,
      autoJoin: "allowlist",
      autoJoinAllowlist: ["!ops:matrix-qa.test"],
      blockStreaming: true,
      chunkMode: undefined,
      dm: {
        allowFrom: ["@driver:matrix-qa.test"],
        enabled: true,
        policy: "allowlist",
        sessionScope: "per-room",
        threadReplies: "inbound",
      },
      encryption: false,
      execApprovals: undefined,
      configuredBotRoles: [],
      groupAllowFrom: ["@driver:matrix-qa.test"],
      groupPolicy: "open",
      groupsByKey: {
        main: {
          enabled: true,
          requireMention: true,
          roomId: "!main:matrix-qa.test",
        },
        secondary: {
          enabled: true,
          requireMention: true,
          roomId: "!secondary:matrix-qa.test",
        },
      },
      replyToMode: "off",
      streaming: "partial",
      streamingPreviewToolProgress: true,
      textChunkLimit: undefined,
      threadBindings: {},
      threadReplies: "inbound",
    });
    expect(summarizeMatrixQaConfigSnapshot(snapshot)).toContain("allowBots=<default>");
    expect(summarizeMatrixQaConfigSnapshot(snapshot)).toContain("configuredBotRoles=<none>");
    expect(summarizeMatrixQaConfigSnapshot(snapshot)).toContain("autoJoin=allowlist");
    expect(summarizeMatrixQaConfigSnapshot(snapshot)).toContain("streaming=partial");
    expect(summarizeMatrixQaConfigSnapshot(snapshot)).toContain(
      "streaming.preview.toolProgress=true",
    );
  });

  it("builds Matrix QA config snapshots from structured streaming overrides", () => {
    const snapshot = buildMatrixQaConfigSnapshot({
      driverUserId: "@driver:matrix-qa.test",
      observerUserId: "@observer:matrix-qa.test",
      overrides: {
        streaming: {
          mode: "quiet",
          preview: {
            toolProgress: false,
          },
        },
      },
      sutUserId: "@sut:matrix-qa.test",
      topology,
    });

    expect(snapshot.streaming).toBe("quiet");
    expect(snapshot.streamingPreviewToolProgress).toBe(false);
    expect(summarizeMatrixQaConfigSnapshot(snapshot)).toContain("streaming=quiet");
    expect(summarizeMatrixQaConfigSnapshot(snapshot)).toContain(
      "streaming.preview.toolProgress=false",
    );
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
    expect(sut?.chunkMode).toBe("length");
    expect(sut?.dm?.allowFrom).toEqual(["@driver:matrix-qa.test"]);
    expect(sut?.dm?.enabled).toBe(true);
    expect(sut?.execApprovals).toEqual({
      enabled: true,
      target: "both",
    });
    expect(sut?.textChunkLimit).toBe(280);
  });

  it("resolves role-based Matrix sender allowlist overrides", () => {
    const snapshot = buildMatrixQaConfigSnapshot({
      driverUserId: "@driver:matrix-qa.test",
      observerUserId: "@observer:matrix-qa.test",
      overrides: {
        groupAllowRoles: ["driver", "observer"],
      },
      sutUserId: "@sut:matrix-qa.test",
      topology,
    });

    expect(snapshot.groupAllowFrom).toEqual(["@driver:matrix-qa.test", "@observer:matrix-qa.test"]);
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

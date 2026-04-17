import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
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

    expect(next.channels?.matrix?.accounts?.sut).toMatchObject({
      dm: {
        allowFrom: ["@driver:matrix-qa.test"],
        enabled: true,
        policy: "allowlist",
      },
      groupAllowFrom: ["@driver:matrix-qa.test"],
      groupPolicy: "allowlist",
      groups: {
        "!main:matrix-qa.test": { enabled: true, requireMention: true },
        "!secondary:matrix-qa.test": { enabled: true, requireMention: true },
      },
      replyToMode: "off",
      threadReplies: "inbound",
    });
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
        groupAllowFrom: ["@driver:matrix-qa.test", "@observer:matrix-qa.test"],
        groupsByKey: {
          secondary: {
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
          spawnSubagentSessions: true,
        },
        threadReplies: "always",
        toolProfile: "coding",
      },
      sutAccessToken: "sut-token",
      sutAccountId: "sut",
      sutUserId: "@sut:matrix-qa.test",
      topology,
    });

    expect(next.agents?.defaults).toMatchObject({
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
    });
    expect(next.tools).toMatchObject({
      profile: "coding",
    });
    expect(next.channels?.matrix?.accounts?.sut).toMatchObject({
      autoJoin: "allowlist",
      autoJoinAllowlist: ["!dm:matrix-qa.test", "#ops:matrix-qa.test"],
      blockStreaming: true,
      dm: {
        sessionScope: "per-room",
        threadReplies: "off",
      },
      encryption: true,
      groupAllowFrom: ["@driver:matrix-qa.test", "@observer:matrix-qa.test"],
      groups: {
        "!main:matrix-qa.test": { enabled: true, requireMention: true },
        "!secondary:matrix-qa.test": {
          enabled: true,
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
        spawnSubagentSessions: true,
      },
      threadReplies: "always",
    });
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
      autoJoin: "allowlist",
      autoJoinAllowlist: ["!ops:matrix-qa.test"],
      blockStreaming: true,
      dm: {
        allowFrom: ["@driver:matrix-qa.test"],
        enabled: true,
        policy: "allowlist",
        sessionScope: "per-room",
        threadReplies: "inbound",
      },
      encryption: false,
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
      threadBindings: {},
      threadReplies: "inbound",
    });
    expect(summarizeMatrixQaConfigSnapshot(snapshot)).toContain("autoJoin=allowlist");
    expect(summarizeMatrixQaConfigSnapshot(snapshot)).toContain("streaming=partial");
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

// Verifies canonical group scope precedence and sender policy resolution.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "./config.js";
import { resolveChannelGroupRequireMention, resolveToolsBySender } from "./group-policy.js";
import {
  resolveScopeIntroHint,
  resolveScopeRequireMention,
  resolveScopeToolsPolicy,
  type ScopeTree,
} from "./group-scope-tree.js";

describe("resolveScopeRequireMention", () => {
  const scalarCases: Array<{
    name: string;
    tree: ScopeTree;
    path: string[];
    expected: boolean;
  }> = [
    {
      name: "uses the most specific configured scope",
      tree: {
        defaults: { requireMention: false },
        scopes: {
          broad: { requireMention: false },
          narrow: { requireMention: true },
        },
      },
      path: ["broad", "narrow"],
      expected: true,
    },
    {
      name: "skips missing scope keys",
      tree: { scopes: { broad: { requireMention: false } } },
      path: ["broad", "missing"],
      expected: false,
    },
    {
      name: "uses defaults after path scopes",
      tree: { defaults: { requireMention: false }, scopes: { room: {} } },
      path: ["room"],
      expected: false,
    },
    {
      name: "defaults to requiring a mention",
      tree: { scopes: {} },
      path: ["missing"],
      expected: true,
    },
  ];

  it.each(scalarCases)("$name", ({ tree, path, expected }) => {
    expect(resolveScopeRequireMention({ tree, path })).toBe(expected);
  });

  it("honors Telegram wildcard-topic precedence encoded by the path", () => {
    const tree: ScopeTree = {
      scopes: {
        "*#topic:7": { requireMention: false },
        "<chat>": { requireMention: true },
      },
    };

    expect(
      resolveScopeRequireMention({
        tree,
        path: ["*", "<chat>", "*#topic:7", "<chat>#topic:7"],
      }),
    ).toBe(false);
  });

  it.each([
    {
      name: "no override",
      configured: false,
      override: undefined,
      overrideOrder: undefined,
    },
    {
      name: "before-config override",
      configured: false,
      override: true,
      overrideOrder: "before-config" as const,
    },
    {
      name: "after-config override",
      configured: false,
      override: true,
      overrideOrder: "after-config" as const,
    },
    {
      name: "after-config fallback override",
      configured: undefined,
      override: false,
      overrideOrder: "after-config" as const,
    },
  ])("matches flat group-policy behavior: $name", ({ configured, override, overrideOrder }) => {
    const node = typeof configured === "boolean" ? { requireMention: configured } : {};
    const tree: ScopeTree = { scopes: { room: node } };
    const cfg = {
      channels: { whatsapp: { groups: { room: node } } },
    } as OpenClawConfig;

    expect(
      resolveScopeRequireMention({
        tree,
        path: ["room"],
        requireMentionOverride: override,
        overrideOrder,
      }),
    ).toBe(
      resolveChannelGroupRequireMention({
        cfg,
        channel: "whatsapp",
        groupId: "room",
        requireMentionOverride: override,
        overrideOrder,
      }),
    );
  });

  it("defaults configured-but-unset scopes to no mention only when requested", () => {
    const tree: ScopeTree = { scopes: { configured: {} } };

    expect(
      resolveScopeRequireMention({
        tree,
        path: ["configured"],
        configuredScopeDefaultsToNoMention: true,
      }),
    ).toBe(false);
    expect(
      resolveScopeRequireMention({
        tree,
        path: ["missing"],
        configuredScopeDefaultsToNoMention: true,
      }),
    ).toBe(true);
  });
});

describe("resolveScopeToolsPolicy", () => {
  const cascadeCases: Array<{
    name: string;
    tree: ScopeTree;
    senderId: string;
    expected: { allow?: string[]; deny?: string[] };
  }> = [
    {
      name: "channel sender policy",
      tree: {
        scopes: {
          team: { tools: { deny: ["team"] } },
          channel: {
            toolsBySender: { "id:alice": { allow: ["channel-sender"] } },
            tools: { allow: ["channel"] },
          },
        },
      },
      senderId: "alice",
      expected: { allow: ["channel-sender"] },
    },
    {
      name: "channel policy",
      tree: {
        scopes: {
          team: { tools: { deny: ["team"] } },
          channel: {
            toolsBySender: { "id:alice": { allow: ["channel-sender"] } },
            tools: { allow: ["channel"] },
          },
        },
      },
      senderId: "bob",
      expected: { allow: ["channel"] },
    },
    {
      name: "team sender policy",
      tree: {
        scopes: {
          team: {
            toolsBySender: { "id:bob": { allow: ["team-sender"] } },
            tools: { deny: ["team"] },
          },
          channel: {},
        },
      },
      senderId: "bob",
      expected: { allow: ["team-sender"] },
    },
    {
      name: "team policy",
      tree: {
        scopes: {
          team: {
            toolsBySender: { "id:bob": { allow: ["team-sender"] } },
            tools: { deny: ["team"] },
          },
          channel: {},
        },
      },
      senderId: "carol",
      expected: { deny: ["team"] },
    },
  ];

  it.each(cascadeCases)(
    "resolves the MSTeams cascade through $name",
    ({ tree, senderId, expected }) => {
      expect(resolveScopeToolsPolicy({ tree, path: ["team", "channel"], senderId })).toEqual(
        expected,
      );
    },
  );

  it.each([
    { name: "id", sender: { senderId: "user:alice" }, expected: { allow: ["id"] } },
    {
      name: "username",
      sender: { senderUsername: "@Alice" },
      expected: { allow: ["username"] },
    },
    {
      name: "channel",
      sender: { senderId: "user:alice", messageProvider: "discord" },
      expected: { allow: ["channel"] },
    },
    {
      name: "channel without provider",
      sender: { senderId: "user:alice" },
      expected: { allow: ["id"] },
    },
  ])("matches resolveToolsBySender for typed $name keys", ({ sender, expected }) => {
    const toolsBySender = {
      "id:user:alice": { allow: ["id"] },
      "username:alice": { allow: ["username"] },
      "channel:discord:user:alice": { allow: ["channel"] },
      "*": { deny: ["fallback"] },
    };
    const tree: ScopeTree = { scopes: { room: { toolsBySender } } };

    const directPolicy = resolveToolsBySender({ toolsBySender, ...sender });
    expect(resolveScopeToolsPolicy({ tree, path: ["room"], ...sender })).toEqual(directPolicy);
    expect(directPolicy).toEqual(expected);
  });

  it("uses sender and plain policies from defaults after path scopes", () => {
    const senderTree: ScopeTree = {
      defaults: {
        toolsBySender: { "id:alice": { allow: ["default-sender"] } },
        tools: { deny: ["default"] },
      },
      scopes: { channel: {} },
    };

    expect(
      resolveScopeToolsPolicy({ tree: senderTree, path: ["channel"], senderId: "alice" }),
    ).toEqual({ allow: ["default-sender"] });
    expect(
      resolveScopeToolsPolicy({ tree: senderTree, path: ["channel"], senderId: "bob" }),
    ).toEqual({ deny: ["default"] });
    expect(resolveScopeToolsPolicy({ tree: { scopes: {} }, path: [] })).toBeUndefined();
  });

  it("keeps a narrower plain policy ahead of a broader sender match", () => {
    const tree: ScopeTree = {
      scopes: {
        team: { toolsBySender: { "id:alice": { allow: ["team-sender"] } } },
        channel: { tools: { deny: ["channel"] } },
      },
    };

    expect(
      resolveScopeToolsPolicy({
        tree,
        path: ["team", "channel"],
        senderId: "alice",
      }),
    ).toEqual({ deny: ["channel"] });
  });
});

describe("resolveScopeIntroHint", () => {
  it("uses the first defined hint from narrowest scope through defaults", () => {
    const tree: ScopeTree = {
      defaults: { introHint: "default" },
      scopes: {
        team: { introHint: "team" },
        channel: {},
        thread: { introHint: "thread" },
      },
    };

    expect(resolveScopeIntroHint({ tree, path: ["team", "channel", "thread"] })).toBe("thread");
    expect(resolveScopeIntroHint({ tree, path: ["missing"] })).toBe("default");
  });
});

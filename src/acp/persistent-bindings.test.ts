import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import type { ChannelConfiguredBindingProvider, ChannelPlugin } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { buildConfiguredAcpSessionKey } from "./persistent-bindings.types.js";

type PersistentBindingsModule = Pick<
  typeof import("./persistent-bindings.resolve.js"),
  "resolveConfiguredAcpBindingRecord" | "resolveConfiguredAcpBindingSpecBySessionKey"
>;
let persistentBindings: PersistentBindingsModule;
let persistentBindingsResolveModule: Pick<
  typeof import("./persistent-bindings.resolve.js"),
  "resolveConfiguredAcpBindingRecord" | "resolveConfiguredAcpBindingSpecBySessionKey"
>;

type ConfiguredBinding = NonNullable<OpenClawConfig["bindings"]>[number];
type BindingRecordInput = Parameters<
  PersistentBindingsModule["resolveConfiguredAcpBindingRecord"]
>[0];

const baseCfg = {
  session: { mainKey: "main", scope: "per-sender" },
  agents: {
    list: [{ id: "codex" }, { id: "claude" }],
  },
} satisfies OpenClawConfig;

const defaultDiscordConversationId = "1478836151241412759";
const defaultDiscordAccountId = "default";

const discordBindings: ChannelConfiguredBindingProvider = {
  compileConfiguredBinding: ({ conversationId }) => {
    const normalized = conversationId.trim();
    return normalized ? { conversationId: normalized } : null;
  },
  matchInboundConversation: ({ compiledBinding, conversationId, parentConversationId }) => {
    if (compiledBinding.conversationId === conversationId) {
      return { conversationId, matchPriority: 2 };
    }
    if (
      parentConversationId &&
      parentConversationId !== conversationId &&
      compiledBinding.conversationId === parentConversationId
    ) {
      return { conversationId: parentConversationId, matchPriority: 1 };
    }
    return null;
  },
};

function parseTelegramTopicConversationForTest(params: {
  conversationId: string;
  parentConversationId?: string;
}): {
  canonicalConversationId: string;
  chatId: string;
  topicId?: string;
} | null {
  const conversationId = params.conversationId.trim();
  const parentConversationId = params.parentConversationId?.trim() || undefined;
  if (!conversationId) {
    return null;
  }
  const canonicalTopicMatch = /^(-[^:]+):topic:([^:]+)$/.exec(conversationId);
  if (canonicalTopicMatch) {
    const [, chatId, topicId] = canonicalTopicMatch;
    return {
      canonicalConversationId: `${chatId}:topic:${topicId}`,
      chatId,
      topicId,
    };
  }
  if (parentConversationId) {
    return {
      canonicalConversationId: `${parentConversationId}:topic:${conversationId}`,
      chatId: parentConversationId,
      topicId: conversationId,
    };
  }
  return {
    canonicalConversationId: conversationId,
    chatId: conversationId,
  };
}

const telegramBindings: ChannelConfiguredBindingProvider = {
  compileConfiguredBinding: ({ conversationId }) => {
    const parsed = parseTelegramTopicConversationForTest({ conversationId });
    if (!parsed || !parsed.chatId.startsWith("-")) {
      return null;
    }
    return {
      conversationId: parsed.canonicalConversationId,
      parentConversationId: parsed.chatId,
    };
  },
  matchInboundConversation: ({ compiledBinding, conversationId, parentConversationId }) => {
    const incoming = parseTelegramTopicConversationForTest({
      conversationId,
      parentConversationId,
    });
    if (!incoming || !incoming.chatId.startsWith("-")) {
      return null;
    }
    if (compiledBinding.conversationId !== incoming.canonicalConversationId) {
      return null;
    }
    return {
      conversationId: incoming.canonicalConversationId,
      parentConversationId: incoming.chatId,
      matchPriority: 2,
    };
  },
};

function isSupportedFeishuDirectConversationId(conversationId: string): boolean {
  const trimmed = conversationId.trim();
  if (!trimmed || trimmed.includes(":")) {
    return false;
  }
  if (trimmed.startsWith("oc_") || trimmed.startsWith("on_")) {
    return false;
  }
  return true;
}

function parseFeishuConversationIdForTest(params: {
  conversationId: string;
  parentConversationId?: string;
}): {
  canonicalConversationId: string;
  chatId: string;
  topicId?: string;
  senderOpenId?: string;
  scope: "group" | "group_sender" | "group_topic" | "group_topic_sender";
} | null {
  const conversationId = params.conversationId.trim();
  const parentConversationId = params.parentConversationId?.trim() || undefined;
  if (!conversationId) {
    return null;
  }

  const topicSenderMatch = /^(.+):topic:([^:]+):sender:([^:]+)$/.exec(conversationId);
  if (topicSenderMatch) {
    const [, chatId, topicId, senderOpenId] = topicSenderMatch;
    return {
      canonicalConversationId: `${chatId}:topic:${topicId}:sender:${senderOpenId}`,
      chatId,
      topicId,
      senderOpenId,
      scope: "group_topic_sender",
    };
  }

  const topicMatch = /^(.+):topic:([^:]+)$/.exec(conversationId);
  if (topicMatch) {
    const [, chatId, topicId] = topicMatch;
    return {
      canonicalConversationId: `${chatId}:topic:${topicId}`,
      chatId,
      topicId,
      scope: "group_topic",
    };
  }

  const senderMatch = /^(.+):sender:([^:]+)$/.exec(conversationId);
  if (senderMatch) {
    const [, chatId, senderOpenId] = senderMatch;
    return {
      canonicalConversationId: `${chatId}:sender:${senderOpenId}`,
      chatId,
      senderOpenId,
      scope: "group_sender",
    };
  }

  if (parentConversationId) {
    return {
      canonicalConversationId: `${parentConversationId}:topic:${conversationId}`,
      chatId: parentConversationId,
      topicId: conversationId,
      scope: "group_topic",
    };
  }

  return {
    canonicalConversationId: conversationId,
    chatId: conversationId,
    scope: "group",
  };
}

const feishuBindings: ChannelConfiguredBindingProvider = {
  compileConfiguredBinding: ({ conversationId }) => {
    const parsed = parseFeishuConversationIdForTest({ conversationId });
    if (
      !parsed ||
      (parsed.scope !== "group_topic" &&
        parsed.scope !== "group_topic_sender" &&
        !isSupportedFeishuDirectConversationId(parsed.canonicalConversationId))
    ) {
      return null;
    }
    return {
      conversationId: parsed.canonicalConversationId,
      parentConversationId:
        parsed.scope === "group_topic" || parsed.scope === "group_topic_sender"
          ? parsed.chatId
          : undefined,
    };
  },
  matchInboundConversation: ({ compiledBinding, conversationId, parentConversationId }) => {
    const incoming = parseFeishuConversationIdForTest({
      conversationId,
      parentConversationId,
    });
    if (
      !incoming ||
      (incoming.scope !== "group_topic" &&
        incoming.scope !== "group_topic_sender" &&
        !isSupportedFeishuDirectConversationId(incoming.canonicalConversationId))
    ) {
      return null;
    }
    const matchesCanonicalConversation =
      compiledBinding.conversationId === incoming.canonicalConversationId;
    const matchesParentTopicForSenderScopedConversation =
      incoming.scope === "group_topic_sender" &&
      compiledBinding.parentConversationId === incoming.chatId &&
      compiledBinding.conversationId === `${incoming.chatId}:topic:${incoming.topicId}`;
    if (!matchesCanonicalConversation && !matchesParentTopicForSenderScopedConversation) {
      return null;
    }
    return {
      conversationId: matchesParentTopicForSenderScopedConversation
        ? compiledBinding.conversationId
        : incoming.canonicalConversationId,
      parentConversationId:
        incoming.scope === "group_topic" || incoming.scope === "group_topic_sender"
          ? incoming.chatId
          : undefined,
      matchPriority: matchesCanonicalConversation ? 2 : 1,
    };
  },
};

function createConfiguredBindingTestPlugin(
  id: ChannelPlugin["id"],
  bindings: ChannelConfiguredBindingProvider,
): Pick<ChannelPlugin, "id" | "meta" | "capabilities" | "config" | "bindings"> {
  return {
    ...createChannelTestPluginBase({ id }),
    bindings,
  };
}

function createCfgWithBindings(
  bindings: ConfiguredBinding[],
  overrides?: Partial<OpenClawConfig>,
): OpenClawConfig {
  return {
    ...baseCfg,
    ...overrides,
    bindings,
  } as OpenClawConfig;
}

function createDiscordBinding(params: {
  agentId: string;
  conversationId: string;
  accountId?: string;
  acp?: Record<string, unknown>;
}): ConfiguredBinding {
  return {
    type: "acp",
    agentId: params.agentId,
    match: {
      channel: "discord",
      accountId: params.accountId ?? defaultDiscordAccountId,
      peer: { kind: "channel", id: params.conversationId },
    },
    ...(params.acp ? { acp: params.acp } : {}),
  } as ConfiguredBinding;
}

function createTelegramGroupBinding(params: {
  agentId: string;
  conversationId: string;
  acp?: Record<string, unknown>;
}): ConfiguredBinding {
  return {
    type: "acp",
    agentId: params.agentId,
    match: {
      channel: "telegram",
      accountId: defaultDiscordAccountId,
      peer: { kind: "group", id: params.conversationId },
    },
    ...(params.acp ? { acp: params.acp } : {}),
  } as ConfiguredBinding;
}

function createFeishuBinding(params: {
  agentId: string;
  conversationId: string;
  accountId?: string;
  acp?: Record<string, unknown>;
}): ConfiguredBinding {
  return {
    type: "acp",
    agentId: params.agentId,
    match: {
      channel: "feishu",
      accountId: params.accountId ?? defaultDiscordAccountId,
      peer: {
        kind: params.conversationId.includes(":topic:") ? "group" : "direct",
        id: params.conversationId,
      },
    },
    ...(params.acp ? { acp: params.acp } : {}),
  } as ConfiguredBinding;
}

function resolveBindingRecord(cfg: OpenClawConfig, overrides: Partial<BindingRecordInput> = {}) {
  return persistentBindings.resolveConfiguredAcpBindingRecord({
    cfg,
    channel: "discord",
    accountId: defaultDiscordAccountId,
    conversationId: defaultDiscordConversationId,
    ...overrides,
  });
}

function resolveDiscordBindingSpecBySession(
  cfg: OpenClawConfig,
  conversationId = defaultDiscordConversationId,
) {
  const resolved = resolveBindingRecord(cfg, { conversationId });
  return persistentBindings.resolveConfiguredAcpBindingSpecBySessionKey({
    cfg,
    sessionKey: resolved?.record.targetSessionKey ?? "",
  });
}

beforeAll(async () => {
  persistentBindingsResolveModule = await import("./persistent-bindings.resolve.js");
  persistentBindings = {
    resolveConfiguredAcpBindingRecord:
      persistentBindingsResolveModule.resolveConfiguredAcpBindingRecord,
    resolveConfiguredAcpBindingSpecBySessionKey:
      persistentBindingsResolveModule.resolveConfiguredAcpBindingSpecBySessionKey,
  };
});

beforeEach(() => {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "discord",
        plugin: createConfiguredBindingTestPlugin("discord", discordBindings),
        source: "test",
      },
      {
        pluginId: "telegram",
        plugin: createConfiguredBindingTestPlugin("telegram", telegramBindings),
        source: "test",
      },
      {
        pluginId: "feishu",
        plugin: createConfiguredBindingTestPlugin("feishu", feishuBindings),
        source: "test",
      },
    ]),
  );
});

describe("resolveConfiguredAcpBindingRecord", () => {
  it("resolves discord channel ACP binding from top-level typed bindings", () => {
    const cfg = createCfgWithBindings([
      createDiscordBinding({
        agentId: "codex",
        conversationId: defaultDiscordConversationId,
        acp: { cwd: "/repo/openclaw" },
      }),
    ]);
    const resolved = resolveBindingRecord(cfg);

    expect(resolved?.spec.channel).toBe("discord");
    expect(resolved?.spec.conversationId).toBe(defaultDiscordConversationId);
    expect(resolved?.spec.agentId).toBe("codex");
    expect(resolved?.record.targetSessionKey).toContain("agent:codex:acp:binding:discord:default:");
    expect(resolved?.record.metadata?.source).toBe("config");
  });

  it("falls back to parent discord channel when conversation is a thread id", () => {
    const cfg = createCfgWithBindings([
      createDiscordBinding({
        agentId: "codex",
        conversationId: "channel-parent-1",
      }),
    ]);
    const resolved = resolveBindingRecord(cfg, {
      conversationId: "thread-123",
      parentConversationId: "channel-parent-1",
    });

    expect(resolved?.spec.conversationId).toBe("channel-parent-1");
    expect(resolved?.record.conversation.conversationId).toBe("channel-parent-1");
  });

  it("prefers direct discord thread binding over parent channel fallback", () => {
    const cfg = createCfgWithBindings([
      createDiscordBinding({
        agentId: "codex",
        conversationId: "channel-parent-1",
      }),
      createDiscordBinding({
        agentId: "claude",
        conversationId: "thread-123",
      }),
    ]);
    const resolved = resolveBindingRecord(cfg, {
      conversationId: "thread-123",
      parentConversationId: "channel-parent-1",
    });

    expect(resolved?.spec.conversationId).toBe("thread-123");
    expect(resolved?.spec.agentId).toBe("claude");
  });

  it("prefers sender-scoped Feishu bindings over topic inheritance", () => {
    const cfg = createCfgWithBindings([
      createFeishuBinding({
        agentId: "codex",
        conversationId: "oc_group_chat:topic:om_topic_root",
        accountId: "work",
      }),
      createFeishuBinding({
        agentId: "claude",
        conversationId: "oc_group_chat:topic:om_topic_root:sender:ou_sender_1",
        accountId: "work",
      }),
    ]);

    const resolved = persistentBindings.resolveConfiguredAcpBindingRecord({
      cfg,
      channel: "feishu",
      accountId: "work",
      conversationId: "oc_group_chat:topic:om_topic_root:sender:ou_sender_1",
      parentConversationId: "oc_group_chat",
    });

    expect(resolved?.spec.conversationId).toBe(
      "oc_group_chat:topic:om_topic_root:sender:ou_sender_1",
    );
    expect(resolved?.spec.agentId).toBe("claude");
  });

  it("prefers exact account binding over wildcard for the same discord conversation", () => {
    const cfg = createCfgWithBindings([
      createDiscordBinding({
        agentId: "codex",
        conversationId: defaultDiscordConversationId,
        accountId: "*",
      }),
      createDiscordBinding({
        agentId: "claude",
        conversationId: defaultDiscordConversationId,
      }),
    ]);
    const resolved = resolveBindingRecord(cfg);

    expect(resolved?.spec.agentId).toBe("claude");
  });

  it("returns null when no top-level ACP binding matches the conversation", () => {
    const cfg = createCfgWithBindings([
      createDiscordBinding({
        agentId: "codex",
        conversationId: "different-channel",
      }),
    ]);
    const resolved = resolveBindingRecord(cfg, {
      conversationId: "thread-123",
      parentConversationId: "channel-parent-1",
    });

    expect(resolved).toBeNull();
  });

  it("resolves telegram forum topic bindings using canonical conversation ids", () => {
    const cfg = createCfgWithBindings([
      createTelegramGroupBinding({
        agentId: "claude",
        conversationId: "-1001234567890:topic:42",
        acp: { backend: "acpx" },
      }),
    ]);

    const canonical = persistentBindings.resolveConfiguredAcpBindingRecord({
      cfg,
      channel: "telegram",
      accountId: "default",
      conversationId: "-1001234567890:topic:42",
    });
    const splitIds = persistentBindings.resolveConfiguredAcpBindingRecord({
      cfg,
      channel: "telegram",
      accountId: "default",
      conversationId: "42",
      parentConversationId: "-1001234567890",
    });

    expect(canonical?.spec.conversationId).toBe("-1001234567890:topic:42");
    expect(splitIds?.spec.conversationId).toBe("-1001234567890:topic:42");
    expect(canonical?.spec.agentId).toBe("claude");
    expect(canonical?.spec.backend).toBe("acpx");
    expect(splitIds?.record.targetSessionKey).toBe(canonical?.record.targetSessionKey);
  });

  it("skips telegram non-group topic configs", () => {
    const cfg = createCfgWithBindings([
      createTelegramGroupBinding({
        agentId: "claude",
        conversationId: "123456789:topic:42",
      }),
    ]);

    const resolved = persistentBindings.resolveConfiguredAcpBindingRecord({
      cfg,
      channel: "telegram",
      accountId: "default",
      conversationId: "123456789:topic:42",
    });
    expect(resolved).toBeNull();
  });

  it("resolves Feishu DM bindings using direct peer ids", () => {
    const cfg = createCfgWithBindings([
      createFeishuBinding({
        agentId: "codex",
        conversationId: "ou_user_1",
      }),
    ]);

    const resolved = persistentBindings.resolveConfiguredAcpBindingRecord({
      cfg,
      channel: "feishu",
      accountId: "default",
      conversationId: "ou_user_1",
    });

    expect(resolved?.spec.channel).toBe("feishu");
    expect(resolved?.spec.conversationId).toBe("ou_user_1");
    expect(resolved?.record.targetSessionKey).toContain("agent:codex:acp:binding:feishu:default:");
  });

  it("resolves Feishu DM bindings using user_id fallback peer ids", () => {
    const cfg = createCfgWithBindings([
      createFeishuBinding({
        agentId: "codex",
        conversationId: "user_123",
      }),
    ]);

    const resolved = persistentBindings.resolveConfiguredAcpBindingRecord({
      cfg,
      channel: "feishu",
      accountId: "default",
      conversationId: "user_123",
    });

    expect(resolved?.spec.channel).toBe("feishu");
    expect(resolved?.spec.conversationId).toBe("user_123");
    expect(resolved?.record.targetSessionKey).toContain("agent:codex:acp:binding:feishu:default:");
  });

  it("resolves Feishu topic bindings with parent chat ids", () => {
    const cfg = createCfgWithBindings([
      createFeishuBinding({
        agentId: "claude",
        conversationId: "oc_group_chat:topic:om_topic_root",
        acp: { backend: "acpx" },
      }),
    ]);

    const resolved = persistentBindings.resolveConfiguredAcpBindingRecord({
      cfg,
      channel: "feishu",
      accountId: "default",
      conversationId: "oc_group_chat:topic:om_topic_root",
      parentConversationId: "oc_group_chat",
    });

    expect(resolved?.spec.conversationId).toBe("oc_group_chat:topic:om_topic_root");
    expect(resolved?.spec.agentId).toBe("claude");
    expect(resolved?.record.conversation.parentConversationId).toBe("oc_group_chat");
  });

  it("inherits configured Feishu topic bindings for sender-scoped topic conversations", () => {
    const cfg = createCfgWithBindings([
      createFeishuBinding({
        agentId: "claude",
        conversationId: "oc_group_chat:topic:om_topic_root",
        acp: { backend: "acpx" },
      }),
    ]);

    const resolved = persistentBindings.resolveConfiguredAcpBindingRecord({
      cfg,
      channel: "feishu",
      accountId: "default",
      conversationId: "oc_group_chat:topic:om_topic_root:sender:ou_topic_user",
      parentConversationId: "oc_group_chat",
    });

    expect(resolved?.spec.conversationId).toBe("oc_group_chat:topic:om_topic_root");
    expect(resolved?.spec.agentId).toBe("claude");
    expect(resolved?.spec.backend).toBe("acpx");
    expect(resolved?.record.conversation.conversationId).toBe("oc_group_chat:topic:om_topic_root");
  });

  it("rejects non-matching Feishu topic roots", () => {
    const cfg = createCfgWithBindings([
      createFeishuBinding({
        agentId: "claude",
        conversationId: "oc_group_chat:topic:om_topic_root",
      }),
    ]);

    const resolved = persistentBindings.resolveConfiguredAcpBindingRecord({
      cfg,
      channel: "feishu",
      accountId: "default",
      conversationId: "oc_group_chat:topic:om_other_root",
      parentConversationId: "oc_group_chat",
    });

    expect(resolved).toBeNull();
  });

  it("rejects Feishu non-topic group ACP bindings", () => {
    const cfg = createCfgWithBindings([
      createFeishuBinding({
        agentId: "claude",
        conversationId: "oc_group_chat",
      }),
    ]);

    const resolved = persistentBindings.resolveConfiguredAcpBindingRecord({
      cfg,
      channel: "feishu",
      accountId: "default",
      conversationId: "oc_group_chat",
    });

    expect(resolved).toBeNull();
  });

  it("applies agent runtime ACP defaults for bound conversations", () => {
    const cfg = createCfgWithBindings(
      [
        createDiscordBinding({
          agentId: "coding",
          conversationId: defaultDiscordConversationId,
        }),
      ],
      {
        agents: {
          list: [
            { id: "main" },
            {
              id: "coding",
              runtime: {
                type: "acp",
                acp: {
                  agent: "codex",
                  backend: "acpx",
                  mode: "oneshot",
                  cwd: "/workspace/repo-a",
                },
              },
            },
          ],
        },
      },
    );
    const resolved = resolveBindingRecord(cfg);

    expect(resolved?.spec.agentId).toBe("coding");
    expect(resolved?.spec.acpAgentId).toBe("codex");
    expect(resolved?.spec.mode).toBe("oneshot");
    expect(resolved?.spec.cwd).toBe("/workspace/repo-a");
    expect(resolved?.spec.backend).toBe("acpx");
  });

  it("derives configured binding cwd from an explicit agent workspace", () => {
    const cfg = createCfgWithBindings(
      [
        createDiscordBinding({
          agentId: "codex",
          conversationId: defaultDiscordConversationId,
        }),
      ],
      {
        agents: {
          list: [{ id: "codex", workspace: "/workspace/openclaw" }, { id: "claude" }],
        },
      },
    );
    const resolved = resolveBindingRecord(cfg);

    expect(resolved?.spec.cwd).toBe(resolveAgentWorkspaceDir(cfg, "codex"));
  });
});

describe("resolveConfiguredAcpBindingSpecBySessionKey", () => {
  it("maps a configured discord binding session key back to its spec", () => {
    const cfg = createCfgWithBindings([
      createDiscordBinding({
        agentId: "codex",
        conversationId: defaultDiscordConversationId,
        acp: { backend: "acpx" },
      }),
    ]);
    const spec = resolveDiscordBindingSpecBySession(cfg);

    expect(spec?.channel).toBe("discord");
    expect(spec?.conversationId).toBe(defaultDiscordConversationId);
    expect(spec?.agentId).toBe("codex");
    expect(spec?.backend).toBe("acpx");
  });

  it("returns null for unknown session keys", () => {
    const spec = persistentBindings.resolveConfiguredAcpBindingSpecBySessionKey({
      cfg: baseCfg,
      sessionKey: "agent:main:acp:binding:discord:default:notfound",
    });
    expect(spec).toBeNull();
  });

  it("prefers exact account ACP settings over wildcard when session keys collide", () => {
    const cfg = createCfgWithBindings([
      createDiscordBinding({
        agentId: "codex",
        conversationId: defaultDiscordConversationId,
        accountId: "*",
        acp: { backend: "wild" },
      }),
      createDiscordBinding({
        agentId: "codex",
        conversationId: defaultDiscordConversationId,
        acp: { backend: "exact" },
      }),
    ]);
    const spec = resolveDiscordBindingSpecBySession(cfg);

    expect(spec?.backend).toBe("exact");
  });

  it("maps a configured Feishu user_id DM binding session key back to its spec", () => {
    const cfg = createCfgWithBindings([
      createFeishuBinding({
        agentId: "codex",
        conversationId: "user_123",
        acp: { backend: "acpx" },
      }),
    ]);
    const resolved = persistentBindings.resolveConfiguredAcpBindingRecord({
      cfg,
      channel: "feishu",
      accountId: "default",
      conversationId: "user_123",
    });
    const spec = persistentBindings.resolveConfiguredAcpBindingSpecBySessionKey({
      cfg,
      sessionKey: resolved?.record.targetSessionKey ?? "",
    });

    expect(spec?.channel).toBe("feishu");
    expect(spec?.conversationId).toBe("user_123");
    expect(spec?.agentId).toBe("codex");
    expect(spec?.backend).toBe("acpx");
  });
});

describe("buildConfiguredAcpSessionKey", () => {
  it("is deterministic for the same conversation binding", () => {
    const sessionKeyA = buildConfiguredAcpSessionKey({
      channel: "discord",
      accountId: "default",
      conversationId: "1478836151241412759",
      agentId: "codex",
      mode: "persistent",
    });
    const sessionKeyB = buildConfiguredAcpSessionKey({
      channel: "discord",
      accountId: "default",
      conversationId: "1478836151241412759",
      agentId: "codex",
      mode: "persistent",
    });
    expect(sessionKeyA).toBe(sessionKeyB);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildConfiguredAcpSessionKey } from "../../acp/persistent-bindings.types.js";
import { ensureConfiguredBindingBuiltinsRegistered } from "./configured-binding-builtins.js";
import * as bindingRegistry from "./configured-binding-registry.js";

const resolveAgentConfigMock = vi.hoisted(() => vi.fn());
const resolveDefaultAgentIdMock = vi.hoisted(() => vi.fn());
const resolveAgentWorkspaceDirMock = vi.hoisted(() => vi.fn());
const getChannelPluginMock = vi.hoisted(() => vi.fn());

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentConfig: resolveAgentConfigMock,
  resolveDefaultAgentId: resolveDefaultAgentIdMock,
  resolveAgentWorkspaceDir: resolveAgentWorkspaceDirMock,
}));

vi.mock("./index.js", () => ({
  getChannelPlugin: getChannelPluginMock,
}));

function createConfig(options?: { bindingAgentId?: string; accountId?: string }) {
  return {
    agents: {
      list: [{ id: "main" }, { id: "codex" }],
    },
    bindings: [
      {
        type: "acp",
        agentId: options?.bindingAgentId ?? "codex",
        match: {
          channel: "discord",
          accountId: options?.accountId ?? "default",
          peer: {
            kind: "channel",
            id: "1479098716916023408",
          },
        },
        acp: {
          backend: "acpx",
        },
      },
    ],
  };
}

function createDiscordAcpPlugin(overrides?: {
  compileConfiguredBinding?: ReturnType<typeof vi.fn>;
  matchInboundConversation?: ReturnType<typeof vi.fn>;
}) {
  const compileConfiguredBinding =
    overrides?.compileConfiguredBinding ??
    vi.fn(({ conversationId }: { conversationId: string }) => ({
      conversationId,
    }));
  const matchInboundConversation =
    overrides?.matchInboundConversation ??
    vi.fn(
      ({
        compiledBinding,
        conversationId,
        parentConversationId,
      }: {
        compiledBinding: { conversationId: string };
        conversationId: string;
        parentConversationId?: string;
      }) => {
        if (compiledBinding.conversationId === conversationId) {
          return { conversationId, matchPriority: 2 };
        }
        if (parentConversationId && compiledBinding.conversationId === parentConversationId) {
          return { conversationId: parentConversationId, matchPriority: 1 };
        }
        return null;
      },
    );
  return {
    id: "discord",
    bindings: {
      compileConfiguredBinding,
      matchInboundConversation,
    },
  };
}

describe("configured binding registry", () => {
  beforeEach(() => {
    resolveAgentConfigMock.mockReset().mockReturnValue(undefined);
    resolveDefaultAgentIdMock.mockReset().mockReturnValue("main");
    resolveAgentWorkspaceDirMock.mockReset().mockReturnValue("/tmp/workspace");
    getChannelPluginMock.mockReset();
    ensureConfiguredBindingBuiltinsRegistered();
  });

  it("resolves configured ACP bindings from an already loaded channel plugin", () => {
    const plugin = createDiscordAcpPlugin();
    getChannelPluginMock.mockReturnValue(plugin);

    const resolved = bindingRegistry.resolveConfiguredBindingRecord({
      cfg: createConfig() as never,
      channel: "discord",
      accountId: "default",
      conversationId: "1479098716916023408",
    });

    expect(resolved?.record.conversation.channel).toBe("discord");
    expect(resolved?.record.metadata?.backend).toBe("acpx");
    expect(plugin.bindings?.compileConfiguredBinding).toHaveBeenCalledTimes(1);
  });

  it("resolves configured ACP bindings from canonical conversation refs", () => {
    const plugin = createDiscordAcpPlugin();
    getChannelPluginMock.mockReturnValue(plugin);

    const resolved = bindingRegistry.resolveConfiguredBinding({
      cfg: createConfig() as never,
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "1479098716916023408",
      },
    });

    expect(resolved?.conversation).toEqual({
      channel: "discord",
      accountId: "default",
      conversationId: "1479098716916023408",
    });
    expect(resolved?.record.conversation.channel).toBe("discord");
    expect(resolved?.statefulTarget).toEqual({
      kind: "stateful",
      driverId: "acp",
      sessionKey: resolved?.record.targetSessionKey,
      agentId: "codex",
      label: undefined,
    });
  });

  it("primes compiled ACP bindings from the already loaded channel registry", () => {
    const plugin = createDiscordAcpPlugin();
    const cfg = createConfig({ bindingAgentId: "codex" });
    getChannelPluginMock.mockReturnValue(plugin);

    const primed = bindingRegistry.primeConfiguredBindingRegistry({
      cfg: cfg as never,
    });
    const resolved = bindingRegistry.resolveConfiguredBindingRecord({
      cfg: cfg as never,
      channel: "discord",
      accountId: "default",
      conversationId: "1479098716916023408",
    });

    expect(primed).toEqual({ bindingCount: 1, channelCount: 1 });
    expect(resolved?.statefulTarget.agentId).toBe("codex");

    const second = bindingRegistry.resolveConfiguredBindingRecord({
      cfg: cfg as never,
      channel: "discord",
      accountId: "default",
      conversationId: "1479098716916023408",
    });

    expect(second?.statefulTarget.agentId).toBe("codex");
  });

  it("resolves wildcard binding session keys from the compiled registry", () => {
    const plugin = createDiscordAcpPlugin();
    getChannelPluginMock.mockReturnValue(plugin);

    const resolved = bindingRegistry.resolveConfiguredBindingRecordBySessionKey({
      cfg: createConfig({ accountId: "*" }) as never,
      sessionKey: buildConfiguredAcpSessionKey({
        channel: "discord",
        accountId: "work",
        conversationId: "1479098716916023408",
        agentId: "codex",
        mode: "persistent",
        backend: "acpx",
      }),
    });

    expect(resolved?.record.conversation.channel).toBe("discord");
    expect(resolved?.record.conversation.accountId).toBe("work");
    expect(resolved?.record.metadata?.backend).toBe("acpx");
  });

  it("does not perform late plugin discovery when a channel plugin is unavailable", () => {
    const resolved = bindingRegistry.resolveConfiguredBindingRecord({
      cfg: createConfig() as never,
      channel: "discord",
      accountId: "default",
      conversationId: "1479098716916023408",
    });

    expect(resolved).toBeNull();
  });

  it("uses the current loaded channel plugin on each resolve", () => {
    const firstPlugin = createDiscordAcpPlugin();
    const secondPlugin = createDiscordAcpPlugin();
    getChannelPluginMock.mockReturnValueOnce(firstPlugin).mockReturnValueOnce(secondPlugin);
    const cfg = createConfig();

    bindingRegistry.resolveConfiguredBindingRecord({
      cfg: cfg as never,
      channel: "discord",
      accountId: "default",
      conversationId: "1479098716916023408",
    });

    bindingRegistry.resolveConfiguredBindingRecord({
      cfg: cfg as never,
      channel: "discord",
      accountId: "default",
      conversationId: "1479098716916023408",
    });

    expect(firstPlugin.bindings?.compileConfiguredBinding).toHaveBeenCalledTimes(1);
    expect(secondPlugin.bindings?.compileConfiguredBinding).toHaveBeenCalledTimes(1);
  });
});

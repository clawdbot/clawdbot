import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { addSession, resetProcessRegistryForTests } from "../bash-process-registry.js";
import { createProcessSessionFixture } from "../bash-process-registry.test-helpers.js";
import {
  buildEmbeddedCompactionRuntimeContext,
  resolveEmbeddedCompactionTarget,
} from "./compaction-runtime-context.js";

describe("buildEmbeddedCompactionRuntimeContext", () => {
  afterEach(() => {
    resetProcessRegistryForTests();
  });

  it("preserves sender and current message routing for compaction", () => {
    const result = buildEmbeddedCompactionRuntimeContext({
      sessionKey: "agent:main:thread:1",
      messageChannel: "slack",
      messageProvider: "slack",
      agentAccountId: "acct-1",
      currentChannelId: "C123",
      currentThreadTs: "thread-9",
      currentMessageId: "msg-42",
      authProfileId: "openai:p1",
      workspaceDir: "/tmp/workspace",
      agentDir: "/tmp/agent",
      config: {} as OpenClawConfig,
      senderIsOwner: true,
      senderId: "user-123",
      provider: "openai-codex",
      modelId: "gpt-5.4",
      thinkLevel: "off",
      reasoningLevel: "on",
      extraSystemPrompt: "extra",
      ownerNumbers: ["+15555550123"],
    });
    expect(result.sessionKey).toBe("agent:main:thread:1");
    expect(result.messageChannel).toBe("slack");
    expect(result.messageProvider).toBe("slack");
    expect(result.agentAccountId).toBe("acct-1");
    expect(result.currentChannelId).toBe("C123");
    expect(result.currentThreadTs).toBe("thread-9");
    expect(result.currentMessageId).toBe("msg-42");
    expect(result.authProfileId).toBe("openai:p1");
    expect(result.workspaceDir).toBe("/tmp/workspace");
    expect(result.agentDir).toBe("/tmp/agent");
    expect(result.senderId).toBe("user-123");
    expect(result.provider).toBe("openai-codex");
    expect(result.model).toBe("gpt-5.4");
  });

  it("normalizes nullable compaction routing fields to undefined", () => {
    const result = buildEmbeddedCompactionRuntimeContext({
      sessionKey: null,
      messageChannel: null,
      messageProvider: null,
      agentAccountId: null,
      currentChannelId: null,
      currentThreadTs: null,
      currentMessageId: null,
      authProfileId: null,
      workspaceDir: "/tmp/workspace",
      agentDir: "/tmp/agent",
      senderId: null,
      provider: null,
      modelId: null,
    });
    expect(result.sessionKey).toBeUndefined();
    expect(result.messageChannel).toBeUndefined();
    expect(result.messageProvider).toBeUndefined();
    expect(result.agentAccountId).toBeUndefined();
    expect(result.currentChannelId).toBeUndefined();
    expect(result.currentThreadTs).toBeUndefined();
    expect(result.currentMessageId).toBeUndefined();
    expect(result.authProfileId).toBeUndefined();
    expect(result.senderId).toBeUndefined();
    expect(result.provider).toBeUndefined();
    expect(result.model).toBeUndefined();
  });

  it("applies compaction.model override with provider/model format", () => {
    const result = buildEmbeddedCompactionRuntimeContext({
      workspaceDir: "/tmp/workspace",
      agentDir: "/tmp/agent",
      config: {
        agents: { defaults: { compaction: { model: "anthropic/claude-opus-4-6" } } },
      } as OpenClawConfig,
      provider: "ollama",
      modelId: "minimax-m2.7:cloud",
      authProfileId: "ollama:default",
    });
    expect(result.provider).toBe("anthropic");
    expect(result.model).toBe("claude-opus-4-6");
    // Auth profile dropped because provider changed
    expect(result.authProfileId).toBeUndefined();
  });

  it("applies compaction.model override with model-only format", () => {
    const result = buildEmbeddedCompactionRuntimeContext({
      workspaceDir: "/tmp/workspace",
      agentDir: "/tmp/agent",
      config: {
        agents: { defaults: { compaction: { model: "gpt-4o" } } },
      } as OpenClawConfig,
      provider: "openai",
      modelId: "gpt-3.5-turbo",
      authProfileId: "openai:p1",
    });
    expect(result.provider).toBe("openai");
    expect(result.model).toBe("gpt-4o");
    // Auth profile preserved because provider didn't change
    expect(result.authProfileId).toBe("openai:p1");
  });

  it("uses session model when no compaction.model override configured", () => {
    const result = buildEmbeddedCompactionRuntimeContext({
      workspaceDir: "/tmp/workspace",
      agentDir: "/tmp/agent",
      config: {} as OpenClawConfig,
      provider: "ollama",
      modelId: "minimax-m2.7:cloud",
      authProfileId: "ollama:default",
    });
    expect(result.provider).toBe("ollama");
    expect(result.model).toBe("minimax-m2.7:cloud");
    expect(result.authProfileId).toBe("ollama:default");
  });

  it("preserves scoped active process session references for compaction", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-02T03:04:05.000Z"));
    const active = createProcessSessionFixture({
      id: "sess-active",
      command: "sleep 600",
      backgrounded: true,
      pid: 1234,
      startedAt: 1_000,
    });
    active.scopeKey = "agent:main:thread:1";
    const other = createProcessSessionFixture({
      id: "sess-other",
      command: "sleep 600",
      backgrounded: true,
    });
    other.scopeKey = "agent:other";
    addSession(active);
    addSession(other);

    const result = buildEmbeddedCompactionRuntimeContext({
      sessionKey: "agent:main:thread:1",
      workspaceDir: "/tmp/workspace",
      agentDir: "/tmp/agent",
      config: {} as OpenClawConfig,
    });

    try {
      expect(result.activeProcessSessions).toEqual([
        {
          command: "sleep 600",
          cwd: "/tmp",
          name: "sleep 600",
          pid: 1234,
          runtimeMs: 1_767_323_044_000,
          sessionId: "sess-active",
          startedAt: 1_000,
          status: "running",
          tail: "",
          truncated: false,
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("omits active process session references when no safe scope is available", () => {
    const active = createProcessSessionFixture({
      id: "sess-active",
      command: "sleep 600",
      backgrounded: true,
    });
    active.scopeKey = "agent:main:thread:1";
    addSession(active);

    const result = buildEmbeddedCompactionRuntimeContext({
      workspaceDir: "/tmp/workspace",
      agentDir: "/tmp/agent",
      config: {} as OpenClawConfig,
    });

    expect(result.activeProcessSessions).toBeUndefined();
  });

  it("applies runtime defaults when resolving the effective compaction target", () => {
    expect(
      resolveEmbeddedCompactionTarget({
        config: {
          agents: { defaults: { compaction: { model: "anthropic/" } } },
        } as OpenClawConfig,
        provider: "openai-codex",
        modelId: "gpt-5.4",
        authProfileId: "openai:p1",
        defaultProvider: "openai-codex",
        defaultModel: "gpt-5.4",
      }),
    ).toEqual({
      provider: "anthropic",
      model: "gpt-5.4",
      authProfileId: undefined,
    });
  });
});

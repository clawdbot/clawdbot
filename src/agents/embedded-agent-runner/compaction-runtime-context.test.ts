// Coverage for building compaction runtime context from active runner state.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { addSession } from "../bash-process-registry.js";
import { createProcessSessionFixture } from "../bash-process-registry.test-helpers.js";
import { resetProcessRegistryForTests } from "../bash-process-registry.test-support.js";
import {
  buildEmbeddedCompactionRuntimeContext,
  resolveCompactionHarnessRuntime,
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
      chatType: "channel",
      agentAccountId: "acct-1",
      currentChannelId: "C123",
      currentThreadTs: "thread-9",
      currentMessageId: "msg-42",
      authProfileId: "openai:p1",
      workspaceDir: "/tmp/workspace",
      cwd: "/tmp/task-repo",
      agentDir: "/tmp/agent",
      config: {} as unknown as OpenClawConfig,
      senderIsOwner: true,
      senderId: "user-123",
      provider: "openai",
      modelId: "gpt-5.4",
      thinkLevel: "off",
      reasoningLevel: "on",
      extraSystemPrompt: "extra",
      ownerNumbers: ["+15555550123"],
    });
    expect(result.sessionKey).toBe("agent:main:thread:1");
    expect(result.messageChannel).toBe("slack");
    expect(result.messageProvider).toBe("slack");
    expect(result.chatType).toBe("channel");
    expect(result.agentAccountId).toBe("acct-1");
    expect(result.currentChannelId).toBe("C123");
    expect(result.currentThreadTs).toBe("thread-9");
    expect(result.currentMessageId).toBe("msg-42");
    expect(result.authProfileId).toBe("openai:p1");
    expect(result.workspaceDir).toBe("/tmp/workspace");
    expect(result.cwd).toBe("/tmp/task-repo");
    expect(result.agentDir).toBe("/tmp/agent");
    expect(result.senderIsOwner).toBe(true);
    expect(result.senderId).toBe("user-123");
    expect(result.provider).toBe("openai");
    expect(result.model).toBe("gpt-5.4");
  });

  it("normalizes nullable compaction routing fields to undefined", () => {
    const result = buildEmbeddedCompactionRuntimeContext({
      sessionKey: null,
      messageChannel: null,
      messageProvider: null,
      chatType: null,
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
    expect(result.chatType).toBeUndefined();
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
      } as unknown as OpenClawConfig,
      provider: "ollama",
      modelId: "minimax-m2.7:cloud",
      authProfileId: "ollama:default",
    });
    expect(result.provider).toBe("anthropic");
    expect(result.model).toBe("claude-opus-4-6");
    // Auth profile must be dropped when provider changes; otherwise compaction
    // could send a stale credential to the override provider.
    expect(result.authProfileId).toBeUndefined();
  });

  it("applies compaction.model override with model-only format", () => {
    const result = buildEmbeddedCompactionRuntimeContext({
      workspaceDir: "/tmp/workspace",
      agentDir: "/tmp/agent",
      config: {
        agents: { defaults: { compaction: { model: "gpt-4o" } } },
      } as unknown as OpenClawConfig,
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
      config: {} as unknown as OpenClawConfig,
      provider: "ollama",
      modelId: "minimax-m2.7:cloud",
      authProfileId: "ollama:default",
    });
    expect(result.provider).toBe("ollama");
    expect(result.model).toBe("minimax-m2.7:cloud");
    expect(result.authProfileId).toBe("ollama:default");
  });

  it("preserves scoped active process session references for compaction", () => {
    // Only sessions tied to the same scope are summarized; cross-session process
    // state would leak unrelated task context into the compaction prompt.
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
      config: {} as unknown as OpenClawConfig,
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
      config: {} as unknown as OpenClawConfig,
    });

    expect(result.activeProcessSessions).toBeUndefined();
  });

  it("applies runtime defaults when resolving the effective compaction target", () => {
    expect(
      resolveEmbeddedCompactionTarget({
        config: {
          agents: { defaults: { compaction: { model: "anthropic/" } } },
        } as unknown as OpenClawConfig,
        provider: "openai",
        modelId: "gpt-5.4",
        authProfileId: "openai:p1",
        defaultProvider: "openai",
        defaultModel: "gpt-5.4",
      }),
    ).toEqual({
      provider: "anthropic",
      model: "gpt-5.4",
      authProfileId: undefined,
    });
  });

  it("ignores compaction model overrides for model-locked sessions", () => {
    expect(
      resolveEmbeddedCompactionTarget({
        config: {
          agents: { defaults: { compaction: { model: "anthropic/claude-opus-4-6" } } },
        } as unknown as OpenClawConfig,
        provider: "openai",
        modelId: "gpt-5.5",
        authProfileId: "openai:default",
        modelSelectionLocked: true,
      }),
    ).toEqual({
      provider: "openai",
      model: "gpt-5.5",
      authProfileId: "openai:default",
    });
  });

  it("keeps configured OpenAI provider with legacy Codex auth profiles (#86373)", () => {
    const result = resolveEmbeddedCompactionTarget({
      provider: "openai",
      modelId: "gpt-5.4",
      authProfileId: "openai:default",
      defaultProvider: "openai",
      defaultModel: "gpt-5.4",
    });
    expect(result.provider).toBe("openai");
    expect(result.runtimeProvider).toBeUndefined();
    expect(result.contextProvider).toBeUndefined();
    expect(result.model).toBe("gpt-5.4");
    expect(result.authProfileId).toBe("openai:default");
  });

  it("keeps openai auth order with Codex profile on canonical OpenAI", () => {
    const result = resolveEmbeddedCompactionTarget({
      config: {
        auth: { order: { openai: ["openai:default"] } },
      } as unknown as OpenClawConfig,
      provider: "openai",
      modelId: "gpt-5.5",
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
    });
    expect(result.provider).toBe("openai");
    expect(result.runtimeProvider).toBeUndefined();
    expect(result.contextProvider).toBeUndefined();
    expect(result.model).toBe("gpt-5.5");
    expect(result.authProfileId).toBeUndefined();
  });

  it("keeps Codex-runtime OpenAI compaction on the canonical OpenAI provider", () => {
    const result = resolveEmbeddedCompactionTarget({
      config: {
        models: {
          providers: {
            openai: { models: [{ id: "gpt-5.5" }] },
          },
        },
      } as unknown as OpenClawConfig,
      provider: "openai",
      modelId: "gpt-5.5",
      harnessRuntime: "codex",
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
    });
    expect(result.provider).toBe("openai");
    expect(result.runtimeProvider).toBeUndefined();
    expect(result.contextProvider).toBeUndefined();
    expect(result.nativeHarnessCompaction).toBe(true);
    expect(result.model).toBe("gpt-5.5");
    expect(result.authProfileId).toBeUndefined();
  });

  it("carries the selected harness id for delegated runtime compaction", () => {
    const result = buildEmbeddedCompactionRuntimeContext({
      workspaceDir: "/tmp/workspace",
      agentDir: "/tmp/agent",
      config: {
        agents: { defaults: { compaction: { model: "anthropic/claude-opus-4-6" } } },
      } as unknown as OpenClawConfig,
      provider: "openai",
      modelId: "gpt-5.5",
      harnessRuntime: "codex",
      modelSelectionLocked: true,
    });
    expect(result.agentHarnessId).toBe("codex");
    expect(result.modelSelectionLocked).toBe(true);
    expect(result.provider).toBe("openai");
    expect(result.model).toBe("gpt-5.5");
    expect(result.runtimeProvider).toBeUndefined();
  });

  it("carries only a target-matching prepared auth plan into compaction context", () => {
    const runtimeAuthPlan = {
      providerForAuth: "openai",
      modelId: "gpt-5.5",
      authProfileProviderForAuth: "openai",
      forwardedAuthProfileId: "openai:work",
      forwardedAuthProfileSource: "user",
      modelRoute: {
        provider: "openai",
        modelId: "gpt-5.5",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        authRequirement: "api-key",
        requestTransportOverrides: "none",
      },
    } as const;

    const matching = buildEmbeddedCompactionRuntimeContext({
      workspaceDir: "/tmp/workspace",
      agentDir: "/tmp/agent",
      provider: "openai",
      modelId: "gpt-5.5",
      authProfileId: "openai:work",
      authProfileIdSource: "user",
      runtimeAuthPlan,
    });
    const mismatched = buildEmbeddedCompactionRuntimeContext({
      workspaceDir: "/tmp/workspace",
      agentDir: "/tmp/agent",
      provider: "openai",
      modelId: "gpt-5.4",
      runtimeAuthPlan,
    });

    expect(matching.runtimeAuthPlan).toBe(runtimeAuthPlan);
    expect(matching.authProfileIdSource).toBe("user");
    expect(mismatched.runtimeAuthPlan).toBeUndefined();
  });

  it("resolves compaction harness ownership from bound, prepared, then configured facts", () => {
    const preparedRuntimePlan = {
      resolvedRef: {
        provider: "openai",
        modelId: "gpt-5.5",
        harnessId: "codex",
      },
      auth: {
        providerForAuth: "openai",
        modelId: "gpt-5.5",
        authProfileProviderForAuth: "openai",
      },
    } as never;

    expect(
      resolveCompactionHarnessRuntime({
        boundHarnessRuntime: "copilot",
        preparedRuntimePlan,
        configuredHarnessRuntime: "custom",
        provider: "openai",
        modelId: "gpt-5.5",
      }),
    ).toBe("copilot");
    expect(
      resolveCompactionHarnessRuntime({
        preparedRuntimePlan,
        configuredHarnessRuntime: "custom",
        provider: "openai",
        modelId: "gpt-5.5",
      }),
    ).toBe("codex");
    expect(
      resolveCompactionHarnessRuntime({
        preparedRuntimePlan,
        configuredHarnessRuntime: "custom",
        provider: "openai",
        modelId: "gpt-5.4",
      }),
    ).toBe("custom");
  });

  it("preserves direct OpenAI compaction for the OpenClaw runtime", () => {
    const result = resolveEmbeddedCompactionTarget({
      config: {
        models: {
          providers: {
            openai: { models: [{ id: "gpt-5.5" }] },
          },
        },
      } as unknown as OpenClawConfig,
      provider: "openai",
      modelId: "gpt-5.5",
      harnessRuntime: "openclaw",
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
    });
    expect(result.provider).toBe("openai");
    expect(result.runtimeProvider).toBeUndefined();
    expect(result.contextProvider).toBeUndefined();
    expect(result.model).toBe("gpt-5.5");
    expect(result.authProfileId).toBeUndefined();
  });

  it.each([
    { selection: "implicit OpenClaw", harnessRuntime: undefined, nativeCompaction: undefined },
    { selection: "bound OpenClaw", harnessRuntime: "openclaw", nativeCompaction: undefined },
    { selection: "bound Codex", harnessRuntime: "codex", nativeCompaction: true },
  ])("keeps $selection ownership for custom OpenAI Responses compaction", (fixture) => {
    const result = resolveEmbeddedCompactionTarget({
      config: {
        models: {
          providers: {
            openai: {
              api: "openai-responses",
              baseUrl: "https://example.test/v1",
              models: [{ id: "gpt-5.5" }],
            },
          },
        },
      } as unknown as OpenClawConfig,
      provider: "openai",
      modelId: "gpt-5.5",
      harnessRuntime: fixture.harnessRuntime,
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
    });
    expect(result.provider).toBe("openai");
    expect(result.runtimeProvider).toBeUndefined();
    expect(result.contextProvider).toBeUndefined();
    expect(result.nativeHarnessCompaction).toBe(fixture.nativeCompaction);
    expect(result.model).toBe("gpt-5.5");
    expect(result.authProfileId).toBeUndefined();
  });

  it("keeps a locked Codex harness authoritative over a custom OpenAI base URL", () => {
    const result = resolveEmbeddedCompactionTarget({
      config: {
        models: {
          providers: {
            openai: {
              baseUrl: "https://example.test/v1",
              models: [{ id: "gpt-5.5" }],
            },
          },
        },
      } as unknown as OpenClawConfig,
      provider: "openai",
      modelId: "gpt-5.5",
      harnessRuntime: "codex",
      modelSelectionLocked: true,
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
    });
    expect(result.provider).toBe("openai");
    expect(result.runtimeProvider).toBeUndefined();
    expect(result.contextProvider).toBeUndefined();
    expect(result.nativeHarnessCompaction).toBe(true);
    expect(result.model).toBe("gpt-5.5");
  });

  it("keeps model-only compaction overrides with legacy Codex auth on OpenAI", () => {
    const result = resolveEmbeddedCompactionTarget({
      config: {
        agents: { defaults: { compaction: { model: "gpt-5.4" } } },
      } as unknown as OpenClawConfig,
      provider: "openai",
      modelId: "gpt-5.5",
      authProfileId: "openai:default",
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
    });
    expect(result.provider).toBe("openai");
    expect(result.runtimeProvider).toBeUndefined();
    expect(result.contextProvider).toBeUndefined();
    expect(result.model).toBe("gpt-5.4");
    expect(result.authProfileId).toBe("openai:default");
  });

  it("keeps openai compaction overrides with legacy Codex auth on OpenAI", () => {
    const result = resolveEmbeddedCompactionTarget({
      config: {
        agents: { defaults: { compaction: { model: "openai/gpt-5.4" } } },
      } as unknown as OpenClawConfig,
      provider: "openai",
      modelId: "gpt-5.5",
      authProfileId: "openai:default",
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
    });
    expect(result.provider).toBe("openai");
    expect(result.runtimeProvider).toBeUndefined();
    expect(result.contextProvider).toBeUndefined();
    expect(result.model).toBe("gpt-5.4");
    expect(result.authProfileId).toBe("openai:default");
  });

  it("keeps OpenAI compaction model overrides on canonical OpenAI with Codex runtime", () => {
    const result = resolveEmbeddedCompactionTarget({
      config: {
        models: {
          providers: {
            openai: { models: [{ id: "gpt-5.5" }, { id: "gpt-5.4-mini" }] },
          },
        },
        agents: { defaults: { compaction: { model: "openai/gpt-5.4-mini" } } },
      } as unknown as OpenClawConfig,
      provider: "openai",
      modelId: "gpt-5.5",
      harnessRuntime: "codex",
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
    });
    expect(result.provider).toBe("openai");
    expect(result.runtimeProvider).toBeUndefined();
    expect(result.contextProvider).toBeUndefined();
    expect(result.nativeHarnessCompaction).toBe(true);
    expect(result.model).toBe("gpt-5.4-mini");
    expect(result.authProfileId).toBeUndefined();
  });

  it("resolves compaction.model alias to canonical model ref on same provider (#90340)", () => {
    const result = resolveEmbeddedCompactionTarget({
      config: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.4-mini": {
                alias: "gpt54mini",
                params: { thinking: "high" },
              },
            },
            compaction: { model: "gpt54mini" },
          },
        },
      } as unknown as OpenClawConfig,
      provider: "openai",
      modelId: "gpt-5.5",
      authProfileId: "openai:default",
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
    });
    expect(result.provider).toBe("openai");
    expect(result.model).toBe("gpt-5.4-mini");
    expect(result.authProfileId).toBe("openai:default");
  });

  it("resolves compaction.model alias to canonical model ref on different provider", () => {
    const result = resolveEmbeddedCompactionTarget({
      config: {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-opus-4-6": {
                alias: "thinky",
              },
            },
            compaction: { model: "thinky" },
          },
        },
      } as unknown as OpenClawConfig,
      provider: "openai",
      modelId: "gpt-5.5",
      authProfileId: "openai:default",
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
    });
    expect(result.provider).toBe("anthropic");
    expect(result.model).toBe("claude-opus-4-6");
    // Auth profile must be dropped when provider changes
    expect(result.authProfileId).toBeUndefined();
  });

  it("falls back to literal model when alias does not match", () => {
    const result = resolveEmbeddedCompactionTarget({
      config: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.4-mini": {
                alias: "gpt54mini",
              },
            },
            compaction: { model: "nonexistent-alias" },
          },
        },
      } as unknown as OpenClawConfig,
      provider: "openai",
      modelId: "gpt-5.5",
      authProfileId: "openai:default",
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
    });
    expect(result.provider).toBe("openai");
    expect(result.model).toBe("nonexistent-alias");
    expect(result.authProfileId).toBe("openai:default");
  });

  it("preserves auth when an omitted provider uses the effective default", () => {
    const result = resolveEmbeddedCompactionTarget({
      config: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.4-mini": {
                alias: "summary",
              },
            },
            compaction: { model: "summary" },
          },
        },
      } as unknown as OpenClawConfig,
      authProfileId: "openai:default",
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
    });
    expect(result.provider).toBe("openai");
    expect(result.model).toBe("gpt-5.4-mini");
    expect(result.authProfileId).toBe("openai:default");
  });

  it("prefers literal configured model ids over alias collisions (#90340)", () => {
    const result = resolveEmbeddedCompactionTarget({
      config: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.4-mini": {
                alias: "gpt54mini",
              },
              "openai/gpt54mini": {},
            },
            compaction: { model: "gpt54mini" },
          },
        },
      } as unknown as OpenClawConfig,
      provider: "openai",
      modelId: "gpt-5.5",
      authProfileId: "openai:default",
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
    });
    expect(result.provider).toBe("openai");
    expect(result.model).toBe("gpt54mini");
    expect(result.authProfileId).toBe("openai:default");
  });

  it("keeps current-provider configured model ids over cross-provider alias collisions (#90340)", () => {
    const result = resolveEmbeddedCompactionTarget({
      config: {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-opus-4-6": {
                alias: "gpt-5.4-mini",
              },
            },
            compaction: { model: "gpt-5.4-mini" },
          },
        },
        models: {
          providers: {
            openai: { models: [{ id: "gpt-5.4-mini" }] },
          },
        },
      } as unknown as OpenClawConfig,
      provider: "openai",
      modelId: "gpt-5.5",
      authProfileId: "openai:default",
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
    });
    expect(result.provider).toBe("openai");
    expect(result.model).toBe("gpt-5.4-mini");
    expect(result.authProfileId).toBe("openai:default");
  });

  it("leaves non-openai providers unchanged", () => {
    const result = resolveEmbeddedCompactionTarget({
      provider: "anthropic",
      modelId: "claude-opus-4-5",
      authProfileId: "anthropic:default",
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-5",
    });
    expect(result.provider).toBe("anthropic");
  });
});

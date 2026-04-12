import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import plugin from "./index.js";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const hoisted = vi.hoisted(() => {
  const sessionStore: Record<string, Record<string, unknown>> = {
    "agent:main:main": {
      sessionId: "s-main",
      updatedAt: 0,
    },
  };
  return {
    sessionStore,
    updateSessionStore: vi.fn(
      async (_storePath: string, updater: (store: Record<string, unknown>) => void) => {
        updater(sessionStore);
      },
    ),
  };
});

vi.mock("openclaw/plugin-sdk/config-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/config-runtime")>(
    "openclaw/plugin-sdk/config-runtime",
  );
  return {
    ...actual,
    updateSessionStore: hoisted.updateSessionStore,
  };
});

describe("active-memory plugin", () => {
  const hooks: Record<string, Function> = {};
  const registeredCommands: Record<string, any> = {};
  const runEmbeddedPiAgent = vi.fn();
  let stateDir = "";
  let configFile: Record<string, unknown> = {};
  const api: any = {
    pluginConfig: {
      agents: ["main"],
      logging: true,
    },
    config: {},
    id: "active-memory",
    name: "Active Memory",
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    runtime: {
      agent: {
        runEmbeddedPiAgent,
        session: {
          resolveStorePath: vi.fn(() => "/tmp/openclaw-session-store.json"),
          loadSessionStore: vi.fn(() => hoisted.sessionStore),
          saveSessionStore: vi.fn(async () => {}),
        },
      },
      state: {
        resolveStateDir: () => stateDir,
      },
      config: {
        loadConfig: () => configFile,
        writeConfigFile: vi.fn(async (nextConfig: Record<string, unknown>) => {
          configFile = nextConfig;
        }),
      },
    },
    registerCommand: vi.fn((command) => {
      registeredCommands[command.name] = command;
    }),
    on: vi.fn((hookName: string, handler: Function) => {
      hooks[hookName] = handler;
    }),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-active-memory-test-"));
    configFile = {
      plugins: {
        entries: {
          "active-memory": {
            enabled: true,
            config: {
              agents: ["main"],
            },
          },
        },
      },
    };
    api.pluginConfig = {
      agents: ["main"],
      logging: true,
    };
    api.config = {
      agents: {
        defaults: {
          model: {
            primary: "github-copilot/gpt-5.4-mini",
          },
        },
      },
    };
    hoisted.sessionStore["agent:main:main"] = {
      sessionId: "s-main",
      updatedAt: 0,
    };
    for (const key of Object.keys(hooks)) {
      delete hooks[key];
    }
    for (const key of Object.keys(registeredCommands)) {
      delete registeredCommands[key];
    }
    runEmbeddedPiAgent.mockResolvedValue({
      payloads: [{ text: "- lemon pepper wings\n- blue cheese" }],
    });
    await plugin.register(api as unknown as OpenClawPluginApi);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (stateDir) {
      await fs.rm(stateDir, { recursive: true, force: true });
      stateDir = "";
    }
  });

  it("registers a before_prompt_build hook", () => {
    expect(api.on).toHaveBeenCalledWith("before_prompt_build", expect.any(Function));
  });

  it("registers a session-scoped active-memory toggle command", async () => {
    const command = registeredCommands["active-memory"];
    const sessionKey = "agent:main:active-memory-toggle";
    hoisted.sessionStore[sessionKey] = {
      sessionId: "s-active-memory-toggle",
      updatedAt: 0,
    };
    expect(command).toMatchObject({
      name: "active-memory",
      acceptsArgs: true,
    });

    const offResult = await command.handler({
      channel: "webchat",
      isAuthorizedSender: true,
      sessionKey,
      args: "off",
      commandBody: "/active-memory off",
      config: {},
      requestConversationBinding: async () => ({ status: "error", message: "unsupported" }),
      detachConversationBinding: async () => ({ removed: false }),
      getCurrentConversationBinding: async () => null,
    });

    expect(offResult.text).toContain("off for this session");

    const statusResult = await command.handler({
      channel: "webchat",
      isAuthorizedSender: true,
      sessionKey,
      args: "status",
      commandBody: "/active-memory status",
      config: {},
      requestConversationBinding: async () => ({ status: "error", message: "unsupported" }),
      detachConversationBinding: async () => ({ removed: false }),
      getCurrentConversationBinding: async () => null,
    });

    expect(statusResult.text).toBe("Active Memory: off for this session.");

    const disabledResult = await hooks.before_prompt_build(
      { prompt: "what wings should i order? active memory toggle", messages: [] },
      {
        agentId: "main",
        trigger: "user",
        sessionKey,
        messageProvider: "webchat",
      },
    );

    expect(disabledResult).toBeUndefined();
    expect(runEmbeddedPiAgent).not.toHaveBeenCalled();

    const onResult = await command.handler({
      channel: "webchat",
      isAuthorizedSender: true,
      sessionKey,
      args: "on",
      commandBody: "/active-memory on",
      config: {},
      requestConversationBinding: async () => ({ status: "error", message: "unsupported" }),
      detachConversationBinding: async () => ({ removed: false }),
      getCurrentConversationBinding: async () => null,
    });

    expect(onResult.text).toContain("on for this session");

    await hooks.before_prompt_build(
      { prompt: "what wings should i order? active memory toggle", messages: [] },
      {
        agentId: "main",
        trigger: "user",
        sessionKey,
        messageProvider: "webchat",
      },
    );

    expect(runEmbeddedPiAgent).toHaveBeenCalledTimes(1);
  });

  it("supports an explicit global active-memory config toggle", async () => {
    const command = registeredCommands["active-memory"];

    const offResult = await command.handler({
      channel: "webchat",
      isAuthorizedSender: true,
      args: "off --global",
      commandBody: "/active-memory off --global",
      config: {},
      requestConversationBinding: async () => ({ status: "error", message: "unsupported" }),
      detachConversationBinding: async () => ({ removed: false }),
      getCurrentConversationBinding: async () => null,
    });

    expect(offResult.text).toBe("Active Memory: off globally.");
    expect(api.runtime.config.writeConfigFile).toHaveBeenCalledTimes(1);
    expect(configFile).toMatchObject({
      plugins: {
        entries: {
          "active-memory": {
            enabled: true,
            config: {
              enabled: false,
              agents: ["main"],
            },
          },
        },
      },
    });

    const statusOffResult = await command.handler({
      channel: "webchat",
      isAuthorizedSender: true,
      args: "status --global",
      commandBody: "/active-memory status --global",
      config: {},
      requestConversationBinding: async () => ({ status: "error", message: "unsupported" }),
      detachConversationBinding: async () => ({ removed: false }),
      getCurrentConversationBinding: async () => null,
    });

    expect(statusOffResult.text).toBe("Active Memory: off globally.");

    await hooks.before_prompt_build(
      { prompt: "what wings should i order while global active memory is off?", messages: [] },
      {
        agentId: "main",
        trigger: "user",
        sessionKey: "agent:main:global-toggle",
        messageProvider: "webchat",
      },
    );

    expect(runEmbeddedPiAgent).not.toHaveBeenCalled();

    const onResult = await command.handler({
      channel: "webchat",
      isAuthorizedSender: true,
      args: "on --global",
      commandBody: "/active-memory on --global",
      config: {},
      requestConversationBinding: async () => ({ status: "error", message: "unsupported" }),
      detachConversationBinding: async () => ({ removed: false }),
      getCurrentConversationBinding: async () => null,
    });

    expect(onResult.text).toBe("Active Memory: on globally.");
    expect(configFile).toMatchObject({
      plugins: {
        entries: {
          "active-memory": {
            enabled: true,
            config: {
              enabled: true,
              agents: ["main"],
            },
          },
        },
      },
    });

    await hooks.before_prompt_build(
      { prompt: "what wings should i order after global active memory is back on?", messages: [] },
      {
        agentId: "main",
        trigger: "user",
        sessionKey: "agent:main:global-toggle",
        messageProvider: "webchat",
      },
    );

    expect(runEmbeddedPiAgent).toHaveBeenCalledTimes(1);
  });

  it("does not run for agents that are not explicitly targeted", async () => {
    const result = await hooks.before_prompt_build(
      { prompt: "what wings should i order?", messages: [] },
      {
        agentId: "support",
        trigger: "user",
        sessionKey: "agent:support:main",
        messageProvider: "webchat",
      },
    );

    expect(result).toBeUndefined();
    expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
  });

  it("does not rewrite session state for skipped turns with no active-memory entry to clear", async () => {
    const result = await hooks.before_prompt_build(
      { prompt: "what wings should i order?", messages: [] },
      {
        agentId: "support",
        trigger: "user",
        sessionKey: "agent:support:main",
        messageProvider: "webchat",
      },
    );

    expect(result).toBeUndefined();
    expect(hoisted.updateSessionStore).not.toHaveBeenCalled();
  });

  it("does not run for non-interactive contexts", async () => {
    const result = await hooks.before_prompt_build(
      { prompt: "what wings should i order?", messages: [] },
      {
        agentId: "main",
        trigger: "heartbeat",
        sessionKey: "agent:main:main",
        messageProvider: "webchat",
      },
    );

    expect(result).toBeUndefined();
    expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
  });

  it("defaults to direct-style sessions only", async () => {
    const result = await hooks.before_prompt_build(
      { prompt: "what wings should we order?", messages: [] },
      {
        agentId: "main",
        trigger: "user",
        sessionKey: "agent:main:telegram:group:-100123",
        messageProvider: "telegram",
        channelId: "telegram",
      },
    );

    expect(result).toBeUndefined();
    expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
  });

  it("treats non-webchat main sessions as direct chats under the default dmScope", async () => {
    const result = await hooks.before_prompt_build(
      { prompt: "what wings should i order?", messages: [] },
      {
        agentId: "main",
        trigger: "user",
        sessionKey: "agent:main:main",
        messageProvider: "telegram",
        channelId: "telegram",
      },
    );

    expect(runEmbeddedPiAgent).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      prependSystemContext: expect.stringContaining("plugin-provided supplemental context"),
      appendSystemContext: expect.stringContaining("<active_memory_plugin>"),
    });
  });

  it("treats non-default main session keys as direct chats", async () => {
    api.config = {
      agents: {
        defaults: {
          model: {
            primary: "github-copilot/gpt-5.4-mini",
          },
        },
      },
      session: { mainKey: "home" },
    };

    const result = await hooks.before_prompt_build(
      { prompt: "what wings should i order?", messages: [] },
      {
        agentId: "main",
        trigger: "user",
        sessionKey: "agent:main:home",
        messageProvider: "telegram",
        channelId: "telegram",
      },
    );

    expect(runEmbeddedPiAgent).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      prependSystemContext: expect.stringContaining("plugin-provided supplemental context"),
      appendSystemContext: expect.stringContaining("<active_memory_plugin>"),
    });
  });

  it("runs for group sessions when group chat types are explicitly allowed", async () => {
    api.pluginConfig = {
      agents: ["main"],
      allowedChatTypes: ["direct", "group"],
    };
    await plugin.register(api as unknown as OpenClawPluginApi);

    const result = await hooks.before_prompt_build(
      { prompt: "what wings should we order?", messages: [] },
      {
        agentId: "main",
        trigger: "user",
        sessionKey: "agent:main:telegram:group:-100123",
        messageProvider: "telegram",
        channelId: "telegram",
      },
    );

    expect(runEmbeddedPiAgent).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      prependSystemContext: expect.stringContaining("plugin-provided supplemental context"),
      appendSystemContext: expect.stringContaining("<active_memory_plugin>"),
    });
  });

  it("injects system context on a successful recall hit", async () => {
    const result = await hooks.before_prompt_build(
      {
        prompt: "what wings should i order?",
        messages: [
          { role: "user", content: "i want something greasy tonight" },
          { role: "assistant", content: "let's narrow it down" },
        ],
      },
      {
        agentId: "main",
        trigger: "user",
        sessionKey: "agent:main:main",
        messageProvider: "webchat",
      },
    );

    expect(runEmbeddedPiAgent).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      prependSystemContext: expect.stringContaining("plugin-provided supplemental context"),
      appendSystemContext: expect.stringContaining("<active_memory_plugin>"),
    });
    expect((result as { appendSystemContext: string }).appendSystemContext).toContain(
      "lemon pepper wings",
    );
    expect(runEmbeddedPiAgent.mock.calls.at(-1)?.[0]).toMatchObject({
      provider: "github-copilot",
      model: "gpt-5.4-mini",
      messageProvider: "webchat",
      sessionKey: expect.stringMatching(/^agent:main:main:active-memory:[a-f0-9]{12}$/),
      config: {
        plugins: {
          entries: {
            "active-memory": {
              config: {
                qmd: {
                  searchMode: "search",
                },
              },
            },
          },
        },
      },
    });
  });

  it("lets active memory inherit the main QMD search mode when configured", async () => {
    api.config = {
      agents: {
        defaults: {
          model: {
            primary: "github-copilot/gpt-5.4-mini",
          },
        },
      },
      memory: {
        backend: "qmd",
        qmd: {
          searchMode: "query",
        },
      },
    };
    api.pluginConfig = {
      agents: ["main"],
      qmd: {
        searchMode: "inherit",
      },
    };
    await plugin.register(api as unknown as OpenClawPluginApi);

    await hooks.before_prompt_build(
      {
        prompt: "what wings should i order? inherit-qmd-mode-check",
        messages: [],
      },
      {
        agentId: "main",
        trigger: "user",
        sessionKey: "agent:main:main",
        messageProvider: "webchat",
      },
    );

    expect(runEmbeddedPiAgent.mock.calls.at(-1)?.[0]).toMatchObject({
      config: {
        memory: {
          backend: "qmd",
          qmd: {
            searchMode: "query",
          },
        },
        plugins: {
          entries: {
            "active-memory": {
              config: {
                qmd: {
                  searchMode: "inherit",
                },
              },
            },
          },
        },
      },
    });
  });

  it("frames the blocking memory subagent as a memory search agent for another model", async () => {
    await hooks.before_prompt_build(
      {
        prompt: "What is my favorite food? strict-style-check",
        messages: [],
      },
      {
        agentId: "main",
        trigger: "user",
        sessionKey: "agent:main:main",
        messageProvider: "webchat",
      },
    );

    const runParams = runEmbeddedPiAgent.mock.calls.at(-1)?.[0];
    expect(runParams?.prompt).toContain("You are a memory search agent.");
    expect(runParams?.prompt).toContain("Another model is preparing the final user-facing answer.");
    expect(runParams?.prompt).toContain(
      "Your job is to search memory and return only the most relevant memory context for that model.",
    );
    expect(runParams?.prompt).toContain(
      "You receive conversation context, including the user's latest message.",
    );
    expect(runParams?.prompt).toContain("Use only memory_search and memory_get.");
    expect(runParams?.prompt).toContain(
      "If the user is directly asking about favorites, preferences, habits, routines, or personal facts, treat that as a strong recall signal.",
    );
    expect(runParams?.prompt).toContain(
      "Questions like 'what is my favorite food', 'do you remember my flight preferences', or 'what do i usually get' should normally return memory when relevant results exist.",
    );
    expect(runParams?.prompt).toContain("Return exactly one of these two forms:");
    expect(runParams?.prompt).toContain("1. NONE");
    expect(runParams?.prompt).toContain("2. one compact plain-text summary");
    expect(runParams?.prompt).toContain(
      "Write the summary as a memory note about the user, not as a reply to the user.",
    );
    expect(runParams?.prompt).toContain(
      "Do not return bullets, numbering, labels, XML, JSON, or markdown list formatting.",
    );
    expect(runParams?.prompt).toContain("Good examples:");
    expect(runParams?.prompt).toContain("Bad examples:");
    expect(runParams?.prompt).toContain(
      "Return: User's favorite food is ramen; tacos also come up often.",
    );
  });

  it("defaults prompt style by query mode when no promptStyle is configured", async () => {
    api.pluginConfig = {
      agents: ["main"],
      queryMode: "message",
    };
    await plugin.register(api as unknown as OpenClawPluginApi);

    await hooks.before_prompt_build(
      {
        prompt: "What is my favorite food? preference-style-check",
        messages: [],
      },
      {
        agentId: "main",
        trigger: "user",
        sessionKey: "agent:main:main",
        messageProvider: "webchat",
      },
    );

    const runParams = runEmbeddedPiAgent.mock.calls.at(-1)?.[0];
    expect(runParams?.prompt).toContain("Prompt style: strict.");
    expect(runParams?.prompt).toContain(
      "If the latest user message does not strongly call for memory, reply with NONE.",
    );
  });

  it("honors an explicit promptStyle override", async () => {
    api.pluginConfig = {
      agents: ["main"],
      queryMode: "message",
      promptStyle: "preference-only",
    };
    await plugin.register(api as unknown as OpenClawPluginApi);

    await hooks.before_prompt_build(
      {
        prompt: "What is my favorite food?",
        messages: [],
      },
      {
        agentId: "main",
        trigger: "user",
        sessionKey: "agent:main:main",
        messageProvider: "webchat",
      },
    );

    const runParams = runEmbeddedPiAgent.mock.calls.at(-1)?.[0];
    expect(runParams?.prompt).toContain("Prompt style: preference-only.");
    expect(runParams?.prompt).toContain(
      "Optimize for favorites, preferences, habits, routines, taste, and recurring personal facts.",
    );
  });

  it("keeps thinking off by default but allows an explicit thinking override", async () => {
    await hooks.before_prompt_build(
      {
        prompt: "What is my favorite food? default-thinking-check",
        messages: [],
      },
      {
        agentId: "main",
        trigger: "user",
        sessionKey: "agent:main:main",
        messageProvider: "webchat",
      },
    );

    expect(runEmbeddedPiAgent.mock.calls.at(-1)?.[0]).toMatchObject({
      thinkLevel: "off",
      reasoningLevel: "off",
    });

    api.pluginConfig = {
      agents: ["main"],
      thinking: "medium",
    };
    await plugin.register(api as unknown as OpenClawPluginApi);

    await hooks.before_prompt_build(
      {
        prompt: "What is my favorite food? thinking-override-check",
        messages: [],
      },
      {
        agentId: "main",
        trigger: "user",
        sessionKey: "agent:main:main",
        messageProvider: "webchat",
      },
    );

    expect(runEmbeddedPiAgent.mock.calls.at(-1)?.[0]).toMatchObject({
      thinkLevel: "medium",
      reasoningLevel: "off",
    });
  });

  it("allows appending extra prompt instructions without replacing the base prompt", async () => {
    api.pluginConfig = {
      agents: ["main"],
      promptAppend: "Prefer stable long-term preferences over one-off events.",
    };
    await plugin.register(api as unknown as OpenClawPluginApi);

    await hooks.before_prompt_build(
      {
        prompt: "What is my favorite food? prompt-append-check",
        messages: [],
      },
      {
        agentId: "main",
        trigger: "user",
        sessionKey: "agent:main:main",
        messageProvider: "webchat",
      },
    );

    const prompt = runEmbeddedPiAgent.mock.calls.at(-1)?.[0]?.prompt ?? "";
    expect(prompt).toContain("You are a memory search agent.");
    expect(prompt).toContain("Additional operator instructions:");
    expect(prompt).toContain("Prefer stable long-term preferences over one-off events.");
    expect(prompt).toContain("Conversation context:");
    expect(prompt).toContain("What is my favorite food? prompt-append-check");
  });

  it("allows replacing the base prompt while still appending conversation context", async () => {
    api.pluginConfig = {
      agents: ["main"],
      promptOverride: "Custom memory prompt. Return NONE or one user fact.",
      promptAppend: "Extra custom instruction.",
    };
    await plugin.register(api as unknown as OpenClawPluginApi);

    await hooks.before_prompt_build(
      {
        prompt: "What is my favorite food? prompt-override-check",
        messages: [],
      },
      {
        agentId: "main",
        trigger: "user",
        sessionKey: "agent:main:main",
        messageProvider: "webchat",
      },
    );

    const prompt = runEmbeddedPiAgent.mock.calls.at(-1)?.[0]?.prompt ?? "";
    expect(prompt).toContain("Custom memory prompt. Return NONE or one user fact.");
    expect(prompt).not.toContain("You are a memory search agent.");
    expect(prompt).toContain("Additional operator instructions:");
    expect(prompt).toContain("Extra custom instruction.");
    expect(prompt).toContain("Conversation context:");
    expect(prompt).toContain("What is my favorite food? prompt-override-check");
  });

  it("preserves leading digits in a plain-text summary", async () => {
    runEmbeddedPiAgent.mockResolvedValueOnce({
      payloads: [{ text: "2024 trip to tokyo and 2% milk both matter here." }],
    });

    const result = await hooks.before_prompt_build(
      {
        prompt: "what should i remember from my 2024 trip and should i buy 2% milk?",
        messages: [],
      },
      {
        agentId: "main",
        trigger: "user",
        sessionKey: "agent:main:main",
        messageProvider: "webchat",
      },
    );

    expect(result).toEqual({
      prependSystemContext: expect.stringContaining("plugin-provided supplemental context"),
      appendSystemContext: expect.stringContaining("<active_memory_plugin>"),
    });
    expect((result as { appendSystemContext: string }).appendSystemContext).toContain(
      "2024 trip to tokyo",
    );
    expect((result as { appendSystemContext: string }).appendSystemContext).toContain("2% milk");
  });

  it("preserves canonical parent session scope in the blocking memory subagent session key", async () => {
    await hooks.before_prompt_build(
      { prompt: "what should i grab on the way?", messages: [] },
      {
        agentId: "main",
        trigger: "user",
        sessionKey: "agent:main:telegram:direct:12345:thread:99",
        messageProvider: "telegram",
        channelId: "telegram",
      },
    );

    expect(runEmbeddedPiAgent.mock.calls.at(-1)?.[0]?.sessionKey).toMatch(
      /^agent:main:telegram:direct:12345:thread:99:active-memory:[a-f0-9]{12}$/,
    );
  });

  it("falls back to the current session model when no plugin model is configured", async () => {
    api.pluginConfig = {
      agents: ["main"],
    };
    await plugin.register(api as unknown as OpenClawPluginApi);

    await hooks.before_prompt_build(
      { prompt: "what wings should i order? temp transcript", messages: [] },
      {
        agentId: "main",
        trigger: "user",
        sessionKey: "agent:main:main",
        messageProvider: "webchat",
        modelProviderId: "qwen",
        modelId: "glm-5",
      },
    );

    expect(runEmbeddedPiAgent.mock.calls.at(-1)?.[0]).toMatchObject({
      provider: "qwen",
      model: "glm-5",
    });
  });

  it("skips recall when no model or explicit fallback resolves", async () => {
    api.config = {};
    api.pluginConfig = {
      agents: ["main"],
      modelFallbackPolicy: "resolved-only",
    };
    await plugin.register(api as unknown as OpenClawPluginApi);

    const result = await hooks.before_prompt_build(
      { prompt: "what wings should i order? no fallback", messages: [] },
      {
        agentId: "main",
        trigger: "user",
        sessionKey: "agent:main:resolved-only",
        messageProvider: "webchat",
      },
    );

    expect(result).toBeUndefined();
    expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
  });

  it("uses config.modelFallback when no session or agent model resolves", async () => {
    api.config = {};
    api.pluginConfig = {
      agents: ["main"],
      modelFallback: "google/gemini-3-flash",
      modelFallbackPolicy: "default-remote",
    };
    await plugin.register(api as unknown as OpenClawPluginApi);

    await hooks.before_prompt_build(
      { prompt: "what wings should i order? custom fallback", messages: [] },
      {
        agentId: "main",
        trigger: "user",
        sessionKey: "agent:main:custom-fallback",
        messageProvider: "webchat",
      },
    );

    expect(runEmbeddedPiAgent.mock.calls.at(-1)?.[0]).toMatchObject({
      provider: "google",
      model: "gemini-3-flash-preview",
    });
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("config.modelFallbackPolicy is deprecated"),
    );
  });

  it("does not use a built-in fallback model even when default-remote is configured", async () => {
    api.config = {};
    api.pluginConfig = {
      agents: ["main"],
      modelFallbackPolicy: "default-remote",
    };
    await plugin.register(api as unknown as OpenClawPluginApi);

    const result = await hooks.before_prompt_build(
      { prompt: "what wings should i order? built-in fallback", messages: [] },
      {
        agentId: "main",
        trigger: "user",
        sessionKey: "agent:main:built-in-fallback",
        messageProvider: "webchat",
      },
    );

    expect(result).toBeUndefined();
    expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
  });

  it("persists a readable debug summary alongside the status line", async () => {
    const sessionKey = "agent:main:debug";
    hoisted.sessionStore[sessionKey] = {
      sessionId: "s-main",
      updatedAt: 0,
    };
    runEmbeddedPiAgent.mockImplementationOnce(async () => {
      return {
        meta: {
          activeMemorySearchDebug: {
            backend: "qmd",
            configuredMode: "search",
            effectiveMode: "query",
            fallback: "unsupported-search-flags",
            searchMs: 2590,
            hits: 3,
          },
        },
        payloads: [{ text: "User prefers lemon pepper wings, and blue cheese still wins." }],
      };
    });

    await hooks.before_prompt_build(
      {
        prompt: "what wings should i order? debug telemetry",
        messages: [],
      },
      { agentId: "main", trigger: "user", sessionKey, messageProvider: "webchat" },
    );

    expect(hoisted.updateSessionStore).toHaveBeenCalled();
    const updater = hoisted.updateSessionStore.mock.calls.at(-1)?.[1] as
      | ((store: Record<string, Record<string, unknown>>) => void)
      | undefined;
    const store = {
      [sessionKey]: {
        sessionId: "s-main",
        updatedAt: 0,
      },
    } as Record<string, Record<string, unknown>>;
    updater?.(store);
    expect(store[sessionKey]?.pluginDebugEntries).toEqual([
      {
        pluginId: "active-memory",
        lines: expect.arrayContaining([
          expect.stringContaining("🧩 Active Memory: ok"),
          expect.stringContaining(
            "🔎 Active Memory Debug: backend=qmd configuredMode=search effectiveMode=query fallback=unsupported-search-flags searchMs=2590 hits=3 | User prefers lemon pepper wings, and blue cheese still wins.",
          ),
        ]),
      },
    ]);
  });

  it("replaces stale structured active-memory lines on a later empty run", async () => {
    const sessionKey = "agent:main:stale-active-memory-lines";
    hoisted.sessionStore[sessionKey] = {
      sessionId: "s-main",
      updatedAt: 0,
      pluginDebugEntries: [
        {
          pluginId: "active-memory",
          lines: [
            "🧩 Active Memory: ok 13.4s recent 34 chars",
            "🔎 Active Memory Debug: Favorite desk snack: roasted almonds or cashews.",
          ],
        },
        { pluginId: "other-plugin", lines: ["Other Plugin: keep me"] },
      ],
    };
    runEmbeddedPiAgent.mockResolvedValueOnce({
      payloads: [{ text: "NONE" }],
    });

    await hooks.before_prompt_build(
      { prompt: "what's up with you?", messages: [] },
      { agentId: "main", trigger: "user", sessionKey, messageProvider: "webchat" },
    );

    const updater = hoisted.updateSessionStore.mock.calls.at(-1)?.[1] as
      | ((store: Record<string, Record<string, unknown>>) => void)
      | undefined;
    const store = {
      [sessionKey]: {
        sessionId: "s-main",
        updatedAt: 0,
        pluginDebugEntries: [
          {
            pluginId: "active-memory",
            lines: [
              "🧩 Active Memory: ok 13.4s recent 34 chars",
              "🔎 Active Memory Debug: Favorite desk snack: roasted almonds or cashews.",
            ],
          },
          { pluginId: "other-plugin", lines: ["Other Plugin: keep me"] },
        ],
      },
    } as Record<string, Record<string, unknown>>;
    updater?.(store);

    expect(store[sessionKey]?.pluginDebugEntries).toEqual([
      { pluginId: "other-plugin", lines: ["Other Plugin: keep me"] },
      {
        pluginId: "active-memory",
        lines: [expect.stringContaining("🧩 Active Memory: empty")],
      },
    ]);
  });

  it("returns nothing when the subagent says none", async () => {
    runEmbeddedPiAgent.mockResolvedValueOnce({
      payloads: [{ text: "NONE" }],
    });

    const result = await hooks.before_prompt_build(
      { prompt: "fair, okay gonna do them by throwing them in the garbage", messages: [] },
      {
        agentId: "main",
        trigger: "user",
        sessionKey: "agent:main:main",
        messageProvider: "webchat",
      },
    );

    expect(result).toBeUndefined();
  });

  it("does not cache timeout results", async () => {
    api.pluginConfig = {
      agents: ["main"],
      timeoutMs: 250,
      logging: true,
    };
    await plugin.register(api as unknown as OpenClawPluginApi);
    let lastAbortSignal: AbortSignal | undefined;
    runEmbeddedPiAgent.mockImplementation(async (params: { abortSignal?: AbortSignal }) => {
      lastAbortSignal = params.abortSignal;
      return await new Promise((resolve, reject) => {
        const abortHandler = () => reject(new Error("aborted"));
        params.abortSignal?.addEventListener("abort", abortHandler, { once: true });
        setTimeout(() => {
          params.abortSignal?.removeEventListener("abort", abortHandler);
          resolve({ payloads: [] });
        }, 2_000);
      });
    });

    await hooks.before_prompt_build(
      { prompt: "what wings should i order? timeout test", messages: [] },
      {
        agentId: "main",
        trigger: "user",
        sessionKey: "agent:main:timeout-test",
        messageProvider: "webchat",
      },
    );
    await hooks.before_prompt_build(
      { prompt: "what wings should i order? timeout test", messages: [] },
      {
        agentId: "main",
        trigger: "user",
        sessionKey: "agent:main:timeout-test",
        messageProvider: "webchat",
      },
    );

    expect(hoisted.updateSessionStore).toHaveBeenCalledTimes(2);
    expect(lastAbortSignal?.aborted).toBe(true);
    const infoLines = vi
      .mocked(api.logger.info)
      .mock.calls.map((call: unknown[]) => String(call[0]));
    expect(infoLines.some((line: string) => line.includes(" cached "))).toBe(false);
  });

  it("does not share cached recall results across session-id-only contexts", async () => {
    api.pluginConfig = {
      agents: ["main"],
      logging: true,
    };
    await plugin.register(api as unknown as OpenClawPluginApi);

    await hooks.before_prompt_build(
      { prompt: "what wings should i order? session id cache", messages: [] },
      {
        agentId: "main",
        trigger: "user",
        sessionId: "session-a",
        messageProvider: "webchat",
      },
    );
    await hooks.before_prompt_build(
      { prompt: "what wings should i order? session id cache", messages: [] },
      {
        agentId: "main",
        trigger: "user",
        sessionId: "session-b",
        messageProvider: "webchat",
      },
    );

    expect(runEmbeddedPiAgent).toHaveBeenCalledTimes(2);
    const infoLines = vi
      .mocked(api.logger.info)
      .mock.calls.map((call: unknown[]) => String(call[0]));
    expect(infoLines.some((line: string) => line.includes(" cached "))).toBe(false);
  });

  it("ignores late subagent payloads once the active-memory timeout signal has fired", async () => {
    api.pluginConfig = {
      agents: ["main"],
      timeoutMs: 250,
      logging: true,
    };
    await plugin.register(api as unknown as OpenClawPluginApi);
    runEmbeddedPiAgent.mockImplementationOnce(async (params: { timeoutMs?: number }) => {
      await new Promise((resolve) => setTimeout(resolve, (params.timeoutMs ?? 0) + 25));
      return {
        payloads: [{ text: "late timeout payload that should never become memory context" }],
        meta: { aborted: true },
      };
    });

    const result = await hooks.before_prompt_build(
      { prompt: "what wings should i order? late payload timeout", messages: [] },
      {
        agentId: "main",
        trigger: "user",
        sessionKey: "agent:main:late-timeout-payload",
        messageProvider: "webchat",
      },
    );

    expect(result).toBeUndefined();
    const infoLines = vi
      .mocked(api.logger.info)
      .mock.calls.map((call: unknown[]) => String(call[0]));
    expect(infoLines.some((line: string) => line.includes("status=timeout"))).toBe(true);
  });

  it("uses a canonical agent session key when only sessionId is available", async () => {
    hoisted.sessionStore["agent:main:telegram:direct:12345"] = {
      sessionId: "session-a",
      updatedAt: 25,
      channel: "telegram",
    };

    await hooks.before_prompt_build(
      { prompt: "what wings should i order? session id only", messages: [] },
      {
        agentId: "main",
        trigger: "user",
        sessionId: "session-a",
        messageProvider: "webchat",
      },
    );

    expect(runEmbeddedPiAgent.mock.calls.at(-1)?.[0]?.sessionKey).toMatch(
      /^agent:main:telegram:direct:12345:active-memory:[a-f0-9]{12}$/,
    );
    expect(runEmbeddedPiAgent.mock.calls.at(-1)?.[0]).toMatchObject({
      messageChannel: "telegram",
      messageProvider: "telegram",
    });
    expect(hoisted.sessionStore["agent:main:telegram:direct:12345"]?.pluginDebugEntries).toEqual([
      {
        pluginId: "active-memory",
        lines: expect.arrayContaining([expect.stringContaining("🧩 Active Memory: ok")]),
      },
    ]);
  });

  it("uses the resolved canonical session key for non-webchat chat-type checks", async () => {
    hoisted.sessionStore["agent:main:telegram:direct:12345"] = {
      sessionId: "session-a",
      updatedAt: 25,
    };

    const result = await hooks.before_prompt_build(
      { prompt: "what wings should i order? session id only telegram", messages: [] },
      {
        agentId: "main",
        trigger: "user",
        sessionId: "session-a",
        messageProvider: "telegram",
        channelId: "telegram",
      },
    );

    expect(runEmbeddedPiAgent).toHaveBeenCalledTimes(1);
    expect(runEmbeddedPiAgent.mock.calls.at(-1)?.[0]?.sessionKey).toMatch(
      /^agent:main:telegram:direct:12345:active-memory:[a-f0-9]{12}$/,
    );
    expect(result).toEqual({
      prependSystemContext: expect.stringContaining("plugin-provided supplemental context"),
      appendSystemContext: expect.stringContaining("<active_memory_plugin>"),
    });
  });

  it("prefers the resolved session channel over a wrapper channel hint", async () => {
    hoisted.sessionStore["agent:main:telegram:direct:12345"] = {
      sessionId: "session-a",
      updatedAt: 25,
      channel: "telegram",
    };

    await hooks.before_prompt_build(
      { prompt: "what wings should i order? wrapper channel hint", messages: [] },
      {
        agentId: "main",
        trigger: "user",
        sessionKey: "agent:main:telegram:direct:12345",
        messageProvider: "webchat",
        channelId: "webchat",
      },
    );

    expect(runEmbeddedPiAgent.mock.calls.at(-1)?.[0]).toMatchObject({
      messageChannel: "telegram",
      messageProvider: "telegram",
    });
  });

  it("preserves an explicit real channel hint over a stale stored wrapper channel", async () => {
    hoisted.sessionStore["agent:main:telegram:direct:12345"] = {
      sessionId: "session-a",
      updatedAt: 25,
      origin: {
        provider: "webchat",
      },
    };

    await hooks.before_prompt_build(
      { prompt: "what wings should i order? explicit channel hint", messages: [] },
      {
        agentId: "main",
        trigger: "user",
        sessionKey: "agent:main:telegram:direct:12345",
        messageProvider: "webchat",
        channelId: "telegram",
      },
    );

    expect(runEmbeddedPiAgent.mock.calls.at(-1)?.[0]).toMatchObject({
      messageChannel: "telegram",
      messageProvider: "telegram",
    });
  });

  it("preserves a direct explicit channel when weak legacy fallback disagrees", async () => {
    hoisted.sessionStore["agent:main:telegram:direct:12345"] = {
      sessionId: "session-a",
      updatedAt: 25,
      origin: {
        provider: "webchat",
      },
    };

    await hooks.before_prompt_build(
      { prompt: "what wings should i order? direct explicit channel", messages: [] },
      {
        agentId: "main",
        trigger: "user",
        sessionKey: "agent:main:telegram:direct:12345",
        messageProvider: "telegram",
        channelId: "telegram",
      },
    );

    expect(runEmbeddedPiAgent.mock.calls.at(-1)?.[0]).toMatchObject({
      messageChannel: "telegram",
      messageProvider: "telegram",
    });
  });

  it("clears stale status on skipped non-interactive turns even when agentId is missing", async () => {
    const sessionKey = "noncanonical-session";
    hoisted.sessionStore[sessionKey] = {
      sessionId: "s-main",
      updatedAt: 0,
      pluginDebugEntries: [
        { pluginId: "active-memory", lines: ["🧩 Active Memory: timeout 15s recent"] },
      ],
    };

    const result = await hooks.before_prompt_build(
      { prompt: "what wings should i order?", messages: [] },
      { trigger: "heartbeat", sessionKey, messageProvider: "webchat" },
    );

    expect(result).toBeUndefined();
    const updater = hoisted.updateSessionStore.mock.calls.at(-1)?.[1] as
      | ((store: Record<string, Record<string, unknown>>) => void)
      | undefined;
    const store = {
      [sessionKey]: {
        sessionId: "s-main",
        updatedAt: 0,
        pluginDebugEntries: [
          { pluginId: "active-memory", lines: ["🧩 Active Memory: timeout 15s recent"] },
        ],
      },
    } as Record<string, Record<string, unknown>>;
    updater?.(store);
    expect(store[sessionKey]?.pluginDebugEntries).toBeUndefined();
  });

  it("supports message mode by sending only the latest user message", async () => {
    api.pluginConfig = {
      agents: ["main"],
      queryMode: "message",
    };
    await plugin.register(api as unknown as OpenClawPluginApi);

    await hooks.before_prompt_build(
      {
        prompt: "what should i grab on the way?",
        messages: [
          { role: "user", content: "i have a flight tomorrow" },
          { role: "assistant", content: "got it" },
        ],
      },
      {
        agentId: "main",
        trigger: "user",
        sessionKey: "agent:main:main",
        messageProvider: "webchat",
      },
    );

    const prompt = runEmbeddedPiAgent.mock.calls.at(-1)?.[0]?.prompt;
    expect(prompt).toContain("Conversation context:\nwhat should i grab on the way?");
    expect(prompt).not.toContain("Recent conversation tail:");
  });

  it("supports full mode by sending the whole conversation", async () => {
    api.pluginConfig = {
      agents: ["main"],
      queryMode: "full",
    };
    await plugin.register(api as unknown as OpenClawPluginApi);

    await hooks.before_prompt_build(
      {
        prompt: "what should i grab on the way?",
        messages: [
          { role: "user", content: "i have a flight tomorrow" },
          { role: "assistant", content: "got it" },
          { role: "user", content: "packing is annoying" },
        ],
      },
      {
        agentId: "main",
        trigger: "user",
        sessionKey: "agent:main:main",
        messageProvider: "webchat",
      },
    );

    const prompt = runEmbeddedPiAgent.mock.calls.at(-1)?.[0]?.prompt;
    expect(prompt).toContain("Full conversation context:");
    expect(prompt).toContain("user: i have a flight tomorrow");
    expect(prompt).toContain("assistant: got it");
    expect(prompt).toContain("user: packing is annoying");
  });

  it("strips prior memory/debug traces from assistant context before retrieval", async () => {
    api.pluginConfig = {
      agents: ["main"],
      queryMode: "recent",
    };
    await plugin.register(api as unknown as OpenClawPluginApi);

    await hooks.before_prompt_build(
      {
        prompt: "what should i grab on the way?",
        messages: [
          { role: "user", content: "i have a flight tomorrow" },
          {
            role: "assistant",
            content:
              "🧠 Memory Search: favorite food comfort food tacos sushi ramen\n🧩 Active Memory: ok 842ms recent 2 mem\n🔎 Active Memory Debug: spicy ramen; tacos\nSounds like you want something easy before the airport.",
          },
        ],
      },
      {
        agentId: "main",
        trigger: "user",
        sessionKey: "agent:main:main",
        messageProvider: "webchat",
      },
    );

    const prompt = runEmbeddedPiAgent.mock.calls.at(-1)?.[0]?.prompt;
    expect(prompt).toContain("Treat the latest user message as the primary query.");
    expect(prompt).toContain(
      "Use recent conversation only to disambiguate what the latest user message means.",
    );
    expect(prompt).toContain(
      "Do not return memory just because it matched the broader recent topic; return memory only if it clearly helps with the latest user message itself.",
    );
    expect(prompt).toContain(
      "If recent context and the latest user message point to different memory domains, prefer the domain that best matches the latest user message.",
    );
    expect(prompt).toContain(
      "ignore that surfaced text unless the latest user message clearly requires re-checking it.",
    );
    expect(prompt).toContain(
      "Latest user message: I might see a movie while I wait for the flight.",
    );
    expect(prompt).toContain(
      "Return: User's favorite movie snack is buttery popcorn with extra salt.",
    );
    expect(prompt).toContain("assistant: Sounds like you want something easy before the airport.");
    expect(prompt).not.toContain("Memory Search:");
    expect(prompt).not.toContain("Active Memory:");
    expect(prompt).not.toContain("Active Memory Debug:");
    expect(prompt).not.toContain("spicy ramen; tacos");
  });

  it("trusts the subagent's relevance decision for explicit preference recall prompts", async () => {
    runEmbeddedPiAgent.mockResolvedValueOnce({
      payloads: [{ text: "User prefers aisle seats and extra buffer on connections." }],
    });

    const result = await hooks.before_prompt_build(
      { prompt: "u remember my flight preferences", messages: [] },
      {
        agentId: "main",
        trigger: "user",
        sessionKey: "agent:main:main",
        messageProvider: "webchat",
      },
    );

    expect(result).toEqual({
      prependSystemContext: expect.stringContaining("plugin-provided supplemental context"),
      appendSystemContext: expect.stringContaining("aisle seat"),
    });
    expect((result as { appendSystemContext: string }).appendSystemContext).toContain(
      "extra buffer on connections",
    );
  });

  it("applies total summary truncation after normalizing the subagent reply", async () => {
    api.pluginConfig = {
      agents: ["main"],
      maxSummaryChars: 40,
    };
    await plugin.register(api as unknown as OpenClawPluginApi);
    runEmbeddedPiAgent.mockResolvedValueOnce({
      payloads: [
        {
          text: "alpha beta gamma delta epsilon zetalongword",
        },
      ],
    });

    const result = await hooks.before_prompt_build(
      { prompt: "what wings should i order? word-boundary-truncation-40", messages: [] },
      {
        agentId: "main",
        trigger: "user",
        sessionKey: "agent:main:main",
        messageProvider: "webchat",
      },
    );

    expect(result).toEqual({
      prependSystemContext: expect.stringContaining("plugin-provided supplemental context"),
      appendSystemContext: expect.stringContaining("alpha beta gamma"),
    });
    expect((result as { appendSystemContext: string }).appendSystemContext).toContain(
      "alpha beta gamma delta epsilon",
    );
    expect((result as { appendSystemContext: string }).appendSystemContext).not.toContain("zetalo");
    expect((result as { appendSystemContext: string }).appendSystemContext).not.toContain(
      "zetalongword",
    );
  });

  it("uses the configured maxSummaryChars value in the subagent prompt", async () => {
    api.pluginConfig = {
      agents: ["main"],
      maxSummaryChars: 90,
    };
    await plugin.register(api as unknown as OpenClawPluginApi);

    await hooks.before_prompt_build(
      { prompt: "what wings should i order? prompt-count-check", messages: [] },
      {
        agentId: "main",
        trigger: "user",
        sessionKey: "agent:main:prompt-count-check",
        messageProvider: "webchat",
      },
    );

    expect(runEmbeddedPiAgent.mock.calls.at(-1)?.[0]?.prompt).toContain(
      "If something is useful, reply with one compact plain-text summary under 90 characters total.",
    );
  });

  it("keeps subagent transcripts off disk by default by using a temp session file", async () => {
    const mkdtempSpy = vi
      .spyOn(fs, "mkdtemp")
      .mockResolvedValue("/tmp/openclaw-active-memory-temp");
    const rmSpy = vi.spyOn(fs, "rm").mockResolvedValue(undefined);

    await hooks.before_prompt_build(
      { prompt: "what wings should i order? temp transcript path", messages: [] },
      {
        agentId: "main",
        trigger: "user",
        sessionKey: "agent:main:main",
        messageProvider: "webchat",
      },
    );

    expect(mkdtempSpy).toHaveBeenCalled();
    expect(runEmbeddedPiAgent.mock.calls.at(-1)?.[0]?.sessionFile).toBe(
      "/tmp/openclaw-active-memory-temp/session.jsonl",
    );
    expect(rmSpy).toHaveBeenCalledWith("/tmp/openclaw-active-memory-temp", {
      recursive: true,
      force: true,
    });
  });

  it("persists subagent transcripts in a separate directory when enabled", async () => {
    api.pluginConfig = {
      agents: ["main"],
      persistTranscripts: true,
      transcriptDir: "active-memory-subagents",
      logging: true,
    };
    await plugin.register(api as unknown as OpenClawPluginApi);
    const mkdirSpy = vi.spyOn(fs, "mkdir").mockResolvedValue(undefined);
    const mkdtempSpy = vi.spyOn(fs, "mkdtemp");
    const rmSpy = vi.spyOn(fs, "rm").mockResolvedValue(undefined);

    const sessionKey = "agent:main:persist-transcript";
    await hooks.before_prompt_build(
      { prompt: "what wings should i order? persist transcript", messages: [] },
      { agentId: "main", trigger: "user", sessionKey, messageProvider: "webchat" },
    );

    const expectedDir = path.join(
      stateDir,
      "plugins",
      "active-memory",
      "transcripts",
      "agents",
      "main",
      "active-memory-subagents",
    );
    expect(mkdirSpy).toHaveBeenCalledWith(expectedDir, { recursive: true, mode: 0o700 });
    expect(mkdtempSpy).not.toHaveBeenCalled();
    expect(runEmbeddedPiAgent.mock.calls.at(-1)?.[0]?.sessionFile).toMatch(
      new RegExp(
        `^${escapeRegExp(expectedDir)}${escapeRegExp(path.sep)}active-memory-[a-z0-9]+-[a-f0-9]{8}\\.jsonl$`,
      ),
    );
    expect(rmSpy).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(api.logger.info)
        .mock.calls.some((call: unknown[]) =>
          String(call[0]).includes(`transcript=${expectedDir}${path.sep}`),
        ),
    ).toBe(true);
  });

  it("falls back to the default transcript directory when transcriptDir is unsafe", async () => {
    api.pluginConfig = {
      agents: ["main"],
      persistTranscripts: true,
      transcriptDir: "C:/temp/escape",
      logging: true,
    };
    await plugin.register(api as unknown as OpenClawPluginApi);
    const mkdirSpy = vi.spyOn(fs, "mkdir").mockResolvedValue(undefined);

    await hooks.before_prompt_build(
      { prompt: "what wings should i order? unsafe transcript dir", messages: [] },
      {
        agentId: "main",
        trigger: "user",
        sessionKey: "agent:main:unsafe-transcript",
        messageProvider: "webchat",
      },
    );

    const expectedDir = path.join(
      stateDir,
      "plugins",
      "active-memory",
      "transcripts",
      "agents",
      "main",
      "active-memory",
    );
    expect(mkdirSpy).toHaveBeenCalledWith(expectedDir, { recursive: true, mode: 0o700 });
    expect(runEmbeddedPiAgent.mock.calls.at(-1)?.[0]?.sessionFile).toMatch(
      new RegExp(
        `^${escapeRegExp(expectedDir)}${escapeRegExp(path.sep)}active-memory-[a-z0-9]+-[a-f0-9]{8}\\.jsonl$`,
      ),
    );
  });

  it("scopes persisted subagent transcripts by agent", async () => {
    api.pluginConfig = {
      agents: ["main", "support/agent"],
      persistTranscripts: true,
      transcriptDir: "active-memory-subagents",
      logging: true,
    };
    await plugin.register(api as unknown as OpenClawPluginApi);
    const mkdirSpy = vi.spyOn(fs, "mkdir").mockResolvedValue(undefined);

    await hooks.before_prompt_build(
      { prompt: "what wings should i order? support agent transcript", messages: [] },
      {
        agentId: "support/agent",
        trigger: "user",
        sessionKey: "agent:support/agent:persist-transcript",
        messageProvider: "webchat",
      },
    );

    const expectedDir = path.join(
      stateDir,
      "plugins",
      "active-memory",
      "transcripts",
      "agents",
      "support%2Fagent",
      "active-memory-subagents",
    );
    expect(mkdirSpy).toHaveBeenCalledWith(expectedDir, { recursive: true, mode: 0o700 });
    expect(runEmbeddedPiAgent.mock.calls.at(-1)?.[0]?.sessionFile).toMatch(
      new RegExp(
        `^${escapeRegExp(expectedDir)}${escapeRegExp(path.sep)}active-memory-[a-z0-9]+-[a-f0-9]{8}\\.jsonl$`,
      ),
    );
  });

  it("sanitizes control characters out of debug lines", async () => {
    const sessionKey = "agent:main:debug-sanitize";
    hoisted.sessionStore[sessionKey] = {
      sessionId: "s-main",
      updatedAt: 0,
    };
    runEmbeddedPiAgent.mockResolvedValueOnce({
      payloads: [{ text: "- spicy ramen\u001b[31m\n- fries\r\n- blue cheese\t" }],
    });

    await hooks.before_prompt_build(
      { prompt: "what should i order?", messages: [] },
      { agentId: "main", trigger: "user", sessionKey, messageProvider: "webchat" },
    );

    const updater = hoisted.updateSessionStore.mock.calls.at(-1)?.[1] as
      | ((store: Record<string, Record<string, unknown>>) => void)
      | undefined;
    const store = {
      [sessionKey]: {
        sessionId: "s-main",
        updatedAt: 0,
      },
    } as Record<string, Record<string, unknown>>;
    updater?.(store);
    const lines =
      (store[sessionKey]?.pluginDebugEntries as Array<{ lines?: string[] }> | undefined)?.[0]
        ?.lines ?? [];
    expect(lines.some((line) => line.includes("\u001b"))).toBe(false);
    expect(lines.some((line) => line.includes("\r"))).toBe(false);
  });

  it("caps the active-memory cache size and evicts the oldest entries", async () => {
    api.pluginConfig = {
      agents: ["main"],
      logging: true,
    };
    await plugin.register(api as unknown as OpenClawPluginApi);

    for (let index = 0; index <= 1000; index += 1) {
      await hooks.before_prompt_build(
        { prompt: `cache pressure prompt ${index}`, messages: [] },
        {
          agentId: "main",
          trigger: "user",
          sessionKey: "agent:main:cache-cap",
          messageProvider: "webchat",
        },
      );
    }

    const callsBeforeReplay = runEmbeddedPiAgent.mock.calls.length;

    await hooks.before_prompt_build(
      { prompt: "cache pressure prompt 0", messages: [] },
      {
        agentId: "main",
        trigger: "user",
        sessionKey: "agent:main:cache-cap",
        messageProvider: "webchat",
      },
    );

    expect(runEmbeddedPiAgent.mock.calls.length).toBe(callsBeforeReplay + 1);
    const infoLines = vi
      .mocked(api.logger.info)
      .mock.calls.map((call: unknown[]) => String(call[0]));
    expect(
      infoLines.some(
        (line: string) => line.includes("cached status=ok") && line.includes("prompt 0"),
      ),
    ).toBe(false);
  });
});

// Embedded system prompt tests cover prompt assembly for provider guidance,
// delegation mode, workspace-only safety, memory sections, and active processes.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearMemoryPluginState,
  registerTestMemoryPromptBuilder,
} from "../../plugins/memory-state.test-fixtures.js";
import type { AgentSession } from "../sessions/index.js";
import { createStubTool } from "../test-helpers/agent-tool-stubs.js";
import { applySystemPromptToSession, buildEmbeddedSystemPrompt } from "./system-prompt.js";

vi.mock("../../tts/tts-settings.js", () => ({
  buildTtsSystemPromptHint: vi.fn(() => undefined),
  resolveModelOverridePolicy: vi.fn(),
  setTtsMachinePrefsPathResolver: vi.fn(),
}));

function fixedEmbeddedPromptInputs(): Parameters<typeof buildEmbeddedSystemPrompt>[0] {
  return {
    workspaceDir: "/tmp/openclaw-prompt-agent",
    runtimeCwd: "/tmp/openclaw-prompt-project",
    reasoningTagHint: true,
    runtimeInfo: {
      host: "fixture-host",
      os: "linux",
      arch: "arm64",
      node: "v24.14.0",
      model: "fixture-model",
      provider: "fixture-provider",
      channel: "discord",
      chatType: "direct",
    },
    tools: ["read", "exec", "process", "message", "sessions_spawn"].map(createStubTool),
    capabilityToolNames: ["tool_search", "web_search"],
    userTimezone: "UTC",
    userDate: "2026-01-05",
    ownerNumbers: ["fixture-owner"],
    modelAliasLines: ["- direct-alias: fixture/direct"],
    ttsHint: "Fixture direct TTS hint.",
    skillsPrompt: "<available_skills>Fixture skill guidance.</available_skills>",
    contextFiles: [{ path: "AGENTS.md", content: "Fixture project guidance." }],
    extraSystemPrompt: "Fixture turn context.",
    promptContribution: {
      stablePrefix: "Fixture stable provider guidance.",
      dynamicSuffix: "Fixture dynamic provider guidance.",
    },
  };
}

describe("applySystemPromptToSession", () => {
  it("applies the trimmed prompt through the session base prompt setter", () => {
    const setBaseSystemPrompt = vi.fn();

    applySystemPromptToSession(
      { setBaseSystemPrompt } as unknown as AgentSession,
      "  embedded prompt  ",
    );

    expect(setBaseSystemPrompt).toHaveBeenCalledWith("embedded prompt");
  });
});
describe("buildEmbeddedSystemPrompt", () => {
  afterEach(() => {
    // Memory prompt sections are shared plugin state, so each prompt-rendering
    // test leaves the global registry clean.
    clearMemoryPluginState();
  });

  it("forwards provider prompt contributions into the embedded prompt", () => {
    const prompt = buildEmbeddedSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      runtimeCwd: "/tmp/task-repo",
      reasoningTagHint: false,
      runtimeInfo: {
        host: "local",
        os: "darwin",
        arch: "arm64",
        node: process.version,
        model: "gpt-5.4",
        provider: "openai",
      },
      tools: [],
      modelAliasLines: [],
      userTimezone: "UTC",
      userDate: "2026-01-05",
      promptContribution: {
        stablePrefix: "## Embedded Stable\n\nStable provider guidance.",
      },
    });

    expect(prompt).toContain("## Embedded Stable\n\nStable provider guidance.");
    expect(prompt).toContain("Working directory: /tmp/task-repo (tools and deliverables).");
    expect(prompt).toContain("Agent workspace: /tmp/openclaw");
  });

  it("keeps post-compaction curated context scoped to the prepared project", () => {
    const prompt = buildEmbeddedSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      reasoningTagHint: false,
      runtimeInfo: {
        host: "local",
        os: "darwin",
        arch: "arm64",
        node: process.version,
        model: "gpt-5.4",
        provider: "openai",
      },
      tools: [],
      modelAliasLines: [],
      userTimezone: "UTC",
      userDate: "2026-01-05",
      activeProjectKeys: ["github.com/acme/Alpha"],
      contextFiles: [
        {
          path: "/tmp/openclaw/MEMORY.md",
          content: [
            "- Alpha compaction fact. <!-- project: github.com/acme/Alpha -->",
            "- Beta compaction fact. <!-- project: github.com/acme/Beta -->",
            "- Global compaction fact.",
          ].join("\n"),
        },
      ],
    });

    expect(prompt).toContain("Alpha compaction fact");
    expect(prompt).toContain("Global compaction fact");
    expect(prompt).not.toContain("Beta compaction fact");
  });

  it("uses config-backed sub-agent delegation mode", () => {
    const prompt = buildEmbeddedSystemPrompt({
      config: {
        agents: {
          defaults: {
            subagents: {
              delegationMode: "prefer",
            },
          },
        },
      },
      agentId: "main",
      workspaceDir: "/tmp/openclaw",
      reasoningTagHint: false,
      runtimeInfo: {
        agentId: "main",
        host: "local",
        os: "darwin",
        arch: "arm64",
        node: process.version,
        model: "gpt-5.4",
        provider: "openai",
      },
      tools: [{ name: "sessions_spawn" } as never],
      userTimezone: "UTC",
      userDate: "2026-01-05",
    });

    expect(prompt).toContain("## Delegation");
  });

  it("uses deferred capability names without listing them as visible tools", () => {
    const prompt = buildEmbeddedSystemPrompt({
      config: {
        agents: {
          defaults: {
            subagents: {
              delegationMode: "prefer",
            },
          },
        },
      },
      agentId: "main",
      workspaceDir: "/tmp/openclaw",
      reasoningTagHint: false,
      runtimeInfo: {
        agentId: "main",
        host: "local",
        os: "darwin",
        arch: "arm64",
        node: process.version,
        model: "gpt-5.4",
        provider: "openai",
      },
      tools: [{ name: "tool_search" } as never],
      capabilityToolNames: ["sessions_spawn"],
      userTimezone: "UTC",
      userDate: "2026-01-05",
    });

    expect(prompt).toContain("## Delegation");
    expect(prompt).not.toContain("- sessions_spawn: spawn an isolated sub-agent session");
  });

  it("forwards run-scoped proactive orchestration independently of config preference", () => {
    const prompt = buildEmbeddedSystemPrompt({
      config: {
        agents: {
          defaults: {
            subagents: {
              delegationMode: "suggest",
            },
          },
        },
      },
      agentId: "main",
      workspaceDir: "/tmp/openclaw",
      reasoningTagHint: false,
      proactiveSubagentOrchestration: true,
      runtimeInfo: {
        agentId: "main",
        host: "local",
        os: "darwin",
        arch: "arm64",
        node: process.version,
        model: "openai/gpt-5.6-sol",
        provider: "openai",
      },
      tools: [{ name: "sessions_spawn" } as never],
      userTimezone: "UTC",
      userDate: "2026-01-05",
    });

    expect(prompt).toContain("## Proactive Sub-Agent Orchestration");
    expect(prompt).not.toContain("Mode: prefer");
  });

  it("adds workspace-only scratch path guidance when fs workspaceOnly is enabled", () => {
    // The prompt must steer writes toward workspace-local scratch paths when
    // filesystem tools are constrained to the workspace.
    const prompt = buildEmbeddedSystemPrompt({
      config: {
        tools: {
          fs: {
            workspaceOnly: true,
          },
        },
      },
      workspaceDir: "/tmp/openclaw",
      reasoningTagHint: false,
      runtimeInfo: {
        host: "local",
        os: "darwin",
        arch: "arm64",
        node: process.version,
        model: "gpt-5.4",
        provider: "openai",
      },
      tools: [],
      modelAliasLines: [],
      userTimezone: "UTC",
      userDate: "2026-01-05",
    });

    expect(prompt).toContain("tools.fs.workspaceOnly ON");
    expect(prompt).toContain("`.openclaw/tmp/`");
    expect(prompt).toContain("never exec-write `/tmp`");
  });

  it("omits workspace-only scratch path guidance when fs workspaceOnly is disabled", () => {
    const prompt = buildEmbeddedSystemPrompt({
      config: {
        tools: {
          fs: {
            workspaceOnly: false,
          },
        },
      },
      workspaceDir: "/tmp/openclaw",
      reasoningTagHint: false,
      runtimeInfo: {
        host: "local",
        os: "darwin",
        arch: "arm64",
        node: process.version,
        model: "gpt-5.4",
        provider: "openai",
      },
      tools: [],
      modelAliasLines: [],
      userTimezone: "UTC",
      userDate: "2026-01-05",
    });

    expect(prompt).not.toContain("tools.fs.workspaceOnly ON");
    expect(prompt).not.toContain("never exec-write `/tmp`");
  });

  it("forwards the subagent prompt surface to embedded prompt rendering", () => {
    const prompt = buildEmbeddedSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      reasoningTagHint: false,
      promptSurface: "subagent",
      runtimeInfo: {
        host: "local",
        os: "darwin",
        arch: "arm64",
        node: process.version,
        model: "gpt-5.4",
        provider: "openai",
      },
      tools: [{ name: "sessions_spawn" } as never],
      nativeCommandGuidanceLines: ["Subagent-only command guidance."],
      modelAliasLines: [],
      userTimezone: "UTC",
      userDate: "2026-01-05",
      promptMode: "minimal",
    });

    expect(prompt).toContain("- sessions_spawn");
    expect(prompt).not.toContain("OpenClaw lists the standard tools above");
    expect(prompt).not.toContain("For long waits, avoid rapid poll loops");
    expect(prompt).not.toContain("Larger work: use `sessions_spawn`");
    expect(prompt).not.toContain("Do not poll `subagents list` / `sessions_list` in a loop");
    expect(prompt).toContain("Subagent-only command guidance.");
    expect(prompt).toContain("## Promised Work");
    expect(prompt).toContain("Progress such as `running` is not completion.");
    expect(prompt.match(/## Promised Work/g)).toHaveLength(1);
  });

  it("can omit base memory guidance for non-legacy context engines", () => {
    registerTestMemoryPromptBuilder(() => ["## Memory Recall", "Use memory carefully.", ""]);

    const prompt = buildEmbeddedSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      reasoningTagHint: false,
      runtimeInfo: {
        host: "local",
        os: "darwin",
        arch: "arm64",
        node: process.version,
        model: "gpt-5.4",
        provider: "openai",
      },
      tools: [],
      modelAliasLines: [],
      userTimezone: "UTC",
      userDate: "2026-01-05",
      includeMemorySection: false,
    });

    expect(prompt).not.toContain("## Memory Recall");
  });

  it("includes background process guidance whenever process is callable", () => {
    const params = {
      workspaceDir: "/tmp/openclaw",
      reasoningTagHint: false,
      runtimeInfo: {
        host: "local",
        os: "darwin",
        arch: "arm64",
        node: process.version,
        model: "gpt-5.4",
        provider: "openai",
      },
      tools: [{ name: "process" } as never],
      modelAliasLines: [],
      userTimezone: "UTC",
      userDate: "2026-01-05",
    } satisfies Parameters<typeof buildEmbeddedSystemPrompt>[0];
    const prompt = buildEmbeddedSystemPrompt(params);

    expect(prompt).not.toContain("Active exec sessions:");
    expect(prompt).toContain("Before input: process log");
    expect(prompt).toContain("waitingForInput/stdinWritable");
    expect(prompt).toContain("process list");

    const restrictedPrompt = buildEmbeddedSystemPrompt({ ...params, tools: [] });
    expect(restrictedPrompt).not.toContain("Active exec sessions:");
    expect(restrictedPrompt).not.toContain("process log");
    expect(restrictedPrompt).not.toContain("process list");
  });

  it.each([
    {
      name: "runtime agent fallback",
      selector: {},
      runtime: { agentId: "strict" },
      restricted: true,
    },
    {
      name: "undefined agent fallback",
      selector: { agentId: undefined },
      runtime: { agentId: "strict" },
      restricted: true,
    },
    {
      name: "explicit loose agent",
      selector: { agentId: "loose" },
      runtime: { agentId: "strict" },
      restricted: false,
    },
    {
      name: "explicit strict agent",
      selector: { agentId: "strict" },
      runtime: { agentId: "loose" },
      restricted: true,
    },
    {
      name: "loose runtime agent",
      selector: {},
      runtime: { agentId: "loose" },
      restricted: false,
    },
    { name: "no agent identity", selector: {}, runtime: {}, restricted: false },
  ])("resolves embedded prompt policy for $name", ({ name, selector, runtime, restricted }) => {
    const inputs = fixedEmbeddedPromptInputs();
    const prompt = buildEmbeddedSystemPrompt({
      ...inputs,
      ...selector,
      runtimeInfo: { ...inputs.runtimeInfo, ...runtime },
      config: {
        tools: { fs: { workspaceOnly: false } },
        agents: {
          entries: {
            strict: { tools: { fs: { workspaceOnly: true } } },
            loose: { tools: { fs: { workspaceOnly: false } } },
          },
        },
      },
    });
    expect(prompt.includes("tools.fs.workspaceOnly ON"), name).toBe(restricted);
    expect(prompt).toContain("Fixture stable provider guidance.");
    expect(prompt).toContain("Fixture dynamic provider guidance.");
  });

  it.each(["full", "minimal", "none"] as const)(
    "preserves the fixed embedded prompt in %s mode",
    (promptMode) => {
      const prompt = buildEmbeddedSystemPrompt({ ...fixedEmbeddedPromptInputs(), promptMode });
      expect(prompt).toContain("You are a personal assistant running inside OpenClaw.");
      if (promptMode === "none") {
        expect(prompt).not.toContain("Fixture");
        expect(prompt).not.toContain("## Tooling");
      } else {
        expect(prompt).toContain("Fixture stable provider guidance.");
        expect(prompt).toContain("Fixture project guidance.");
        expect(prompt).toContain("Working directory: /tmp/openclaw-prompt-project");
      }
      expect(prompt.includes("- direct-alias: fixture/direct")).toBe(promptMode === "full");
    },
  );

  it.each([
    { name: "absent config", configInput: {}, directHint: true },
    { name: "empty config", configInput: { config: {} }, directHint: false },
    {
      name: "populated config",
      configInput: {
        config: {
          agents: { defaults: { models: { "fixture/configured": { alias: "configured-alias" } } } },
        },
      },
      directHint: false,
    },
  ])("preserves absent optional fields with $name", ({ name, configInput, directHint }) => {
    const inputs = { ...fixedEmbeddedPromptInputs(), ...configInput };
    const prompt = buildEmbeddedSystemPrompt(inputs);
    const explicitUndefined = buildEmbeddedSystemPrompt({
      ...inputs,
      reactionGuidance: undefined,
      workspaceNotes: undefined,
      silentReplyPromptMode: undefined,
      sourceReplyDeliveryMode: undefined,
      nativeCommandNames: undefined,
      nativeCommandGuidanceLines: undefined,
      messageToolHints: undefined,
      toolSchemaDirectoryPrompt: undefined,
      sandboxInfo: undefined,
      bootstrapMode: undefined,
      bootstrapTruncationNotice: undefined,
      includeMemorySection: undefined,
      preparedMemoryPrompt: undefined,
      preparedWatchedSessions: undefined,
      projectMemoryBootstrap: undefined,
      activeProjectKeys: undefined,
    });
    expect(explicitUndefined).toBe(prompt);
    expect(prompt.includes("- direct-alias: fixture/direct")).toBe(directHint);
    expect(prompt.includes("Fixture direct TTS hint.")).toBe(directHint);
    expect(prompt.includes("- configured-alias: fixture/configured")).toBe(
      name === "populated config",
    );
  });
});

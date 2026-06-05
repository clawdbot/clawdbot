// Embedded system prompt tests cover prompt assembly for provider guidance,
// delegation mode, workspace-only safety, memory sections, and active processes.
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearMemoryPluginState, registerMemoryPromptSection } from "../../plugins/memory-state.js";
import type { AgentSession } from "../sessions/index.js";
import { applySystemPromptToSession, buildEmbeddedSystemPrompt } from "./system-prompt.js";

vi.mock("../../tts/tts.js", () => ({
  buildTtsSystemPromptHint: vi.fn(() => undefined),
}));

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
      promptContribution: {
        stablePrefix: "## Embedded Stable\n\nStable provider guidance.",
      },
    });

    expect(prompt).toContain("## Embedded Stable\n\nStable provider guidance.");
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
    });

    expect(prompt).toContain("## Sub-Agent Delegation");
    expect(prompt).toContain("Mode: prefer");
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
    });

    expect(prompt).toContain("tools.fs.workspaceOnly is enabled");
    expect(prompt).toContain("`.openclaw/tmp/`");
    expect(prompt).toContain("Do not write files to `/tmp/...`");
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
    });

    expect(prompt).not.toContain("tools.fs.workspaceOnly is enabled");
    expect(prompt).not.toContain("Do not write files to `/tmp/...`");
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
    });

    expect(prompt).toContain("- sessions_spawn");
    expect(prompt).not.toContain("OpenClaw lists the standard tools above");
    expect(prompt).not.toContain("For long waits, avoid rapid poll loops");
    expect(prompt).not.toContain("Larger work: use `sessions_spawn`");
    expect(prompt).not.toContain("Do not poll `subagents list` / `sessions_list` in a loop");
    expect(prompt).toContain("Subagent-only command guidance.");
  });

  it("can omit base memory guidance for non-legacy context engines", () => {
    registerMemoryPromptSection(() => ["## Memory Recall", "Use memory carefully.", ""]);

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
      includeMemorySection: false,
    });

    expect(prompt).not.toContain("## Memory Recall");
  });

  it("includes active background process references in the embedded prompt", () => {
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
        activeProcessSessions: [
          {
            sessionId: "sess-active",
            status: "running",
            startedAt: 0,
            runtimeMs: 5_000,
            command: "sleep 600",
            name: "sleep 600",
            cwd: "/tmp/work",
            pid: 1234,
            truncated: false,
          },
        ],
      },
      tools: [],
      modelAliasLines: [],
      userTimezone: "UTC",
    });

    expect(prompt).toContain("Active background exec sessions in this scope:");
    expect(prompt).toContain("sess-active running pid=1234 cwd=/tmp/work :: sleep 600");
    expect(prompt).toContain("Use process log before interactive input");
    expect(prompt).toContain("waitingForInput/stdinWritable");
    expect(prompt).toContain("process list");
  });
});

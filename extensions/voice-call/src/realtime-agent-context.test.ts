import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VoiceCallConfig } from "./config.js";
import type { CoreAgentDeps, CoreConfig } from "./core-bridge.js";
import { buildRealtimeVoiceInstructions } from "./realtime-agent-context.js";
import { createVoiceCallBaseConfig } from "./test-fixtures.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createWorkspace(): Promise<string> {
  const workspaceDir = await mkdtemp(path.join(tmpdir(), "openclaw-voice-context-"));
  tempDirs.push(workspaceDir);
  return workspaceDir;
}

function createConfig(overrides?: Partial<VoiceCallConfig["realtime"]>): VoiceCallConfig {
  const config = createVoiceCallBaseConfig();
  config.agentId = "voice";
  config.realtime.enabled = true;
  config.realtime.instructions = "Base voice instructions.";
  config.realtime = {
    ...config.realtime,
    ...overrides,
    fastContext: {
      ...config.realtime.fastContext,
      ...overrides?.fastContext,
      sources: overrides?.fastContext?.sources ?? config.realtime.fastContext.sources,
    },
    agentContext: {
      ...config.realtime.agentContext,
      ...overrides?.agentContext,
      files: overrides?.agentContext?.files ?? config.realtime.agentContext.files,
    },
    tools: overrides?.tools ?? config.realtime.tools,
    providers: overrides?.providers ?? config.realtime.providers,
  };
  return config;
}

function createAgentRuntime(workspaceDir: string): CoreAgentDeps {
  return {
    resolveAgentIdentity: vi.fn(() => ({
      name: "Claw Voice",
      emoji: ":claw:",
      theme: "bright",
      vibe: "snappy",
      creature: "operator",
    })),
    resolveAgentWorkspaceDir: vi.fn(() => workspaceDir),
  } as unknown as CoreAgentDeps;
}

describe("buildRealtimeVoiceInstructions", () => {
  it("injects bounded identity, system prompt, and workspace context", async () => {
    const workspaceDir = await createWorkspace();
    await writeFile(path.join(workspaceDir, "SOUL.md"), "Stay quick, direct, and warm.\n");
    await writeFile(path.join(workspaceDir, "IDENTITY.md"), "Name: Claw Voice\nVibe: snappy\n");
    await writeFile(path.join(workspaceDir, "SECRET.md"), "do not include\n");

    const coreConfig = {
      agents: {
        list: [{ id: "voice", systemPromptOverride: "Keep spoken answers short." }],
      },
    } as CoreConfig;

    const instructions = await buildRealtimeVoiceInstructions({
      baseInstructions: "Base voice instructions.",
      config: createConfig({
        consultPolicy: "substantive",
        agentContext: {
          enabled: true,
          maxChars: 2000,
          includeIdentity: true,
          includeSystemPrompt: true,
          includeWorkspaceFiles: true,
          files: ["SOUL.md", "IDENTITY.md", "../SECRET.md"],
        },
      }),
      coreConfig,
      agentRuntime: createAgentRuntime(workspaceDir),
    });

    expect(instructions).toContain("OpenClaw agent voice context:");
    expect(instructions).toContain("Consult behavior:");
    expect(instructions).toContain("Call openclaw_agent_consult before answering requests");
    expect(instructions).toContain("- Agent id: voice");
    expect(instructions).toContain("- Name: Claw Voice");
    expect(instructions).toContain("- Vibe: snappy");
    expect(instructions).toContain("Keep spoken answers short.");
    expect(instructions).toContain("### SOUL.md");
    expect(instructions).toContain("Stay quick, direct, and warm.");
    expect(instructions).toContain("### IDENTITY.md");
    expect(instructions).not.toContain("do not include");
  });
});
